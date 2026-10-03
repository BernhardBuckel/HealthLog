/**
 * v1.25 (W-DOCS-IN) — commit an APPROVED staged fact into a structured store.
 *
 * The only write path out of the staging area. Each approved fact is routed to
 * its existing structured store through the same field-by-field create the
 * manual / OCR paths use — no mass assignment, owner-scoped:
 *   - OBSERVATION          → `LabResult` (resolve-or-mint the biomarker)
 *   - CONDITION            → `IllnessEpisode` (condition journal)
 *   - MEDICATION_STATEMENT → `Medication` (as-needed record, no reminders)
 *
 * The app reproduces what the document stated; it never interprets. A Condition
 * is stored with `type = OTHER` (mapping a free-text diagnosis to a clinical
 * category would BE interpretation) and the stated status/code is transcribed
 * verbatim into the encrypted note. A MedicationStatement is recorded as an
 * as-needed medication with notifications off — a record of what the patient
 * takes, never a prescription action. An Observation never carries a
 * range-flag; the reference bounds ride along only as the document stated them.
 *
 * The window the report printed beside a value is carried onto the reading, not
 * dropped. Until now it only seeded a freshly minted catalog marker, which meant
 * that for every analyte the user already had, the range printed on the report
 * was read and then thrown away. It now lands on the row's `sourceReference*`
 * columns and governs that reading's verdict.
 */
import { encryptToBytes } from "@/lib/ai/coach/bytes-codec";
import { prisma } from "@/lib/db";
import { invalidateUserHealthScore } from "@/lib/cache/invalidate";
import { emitDataArrival } from "@/lib/arrivals/emit-shared";
import { decryptFactData } from "@/lib/documents/store";
import { resolveOrMintBiomarker } from "@/lib/labs/biomarker-store";
import { sameLabUnit } from "@/lib/labs/unit-normalise";
import {
  isUnreadableRange,
  parseReferenceRange,
} from "@/lib/labs/parse-reference-range";
import { annotate } from "@/lib/logging/context";
import type { ExtractedFact } from "@/generated/prisma/client";
import type {
  ConditionFactData,
  MedicationStatementFactData,
  ObservationFactData,
} from "@/lib/validations/inbound-documents";
import { dateOnlyAtNoonUtc, isDateOnlyKey } from "@/lib/tz/date-only";

/** A per-fact commit failure the caller maps to a per-fact 422 entry. */
export class FactCommitError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "FactCommitError";
    this.code = code;
  }
}

export interface CommittedRecordRef {
  recordType: "labResult" | "illnessEpisode" | "medication";
  recordId: string;
}

/**
 * A stated YYYY-MM-DD as the instant a date-only value is stored at (noon
 * UTC), or now when the document states none. UTC midnight read back as the
 * previous day anywhere west of UTC.
 */
function statedDateOrNow(date: string | null): Date {
  if (date && isDateOnlyKey(date)) return dateOnlyAtNoonUtc(date);
  return new Date();
}

async function commitObservation(
  userId: string,
  data: ObservationFactData,
): Promise<CommittedRecordRef> {
  const isQualitative = typeof data.value !== "number";
  // A numeric reading needs a unit so the catalog has something to mint with —
  // we never coerce or assume one (fail closed; the user adds it on the review
  // screen).
  if (!isQualitative && (!data.unit || !data.unit.trim())) {
    throw new FactCommitError(
      "observation.unitRequired",
      "A numeric value needs a unit before it can be saved",
    );
  }
  // The printed window, read once. `referenceText` is what the report wrote;
  // the parser derives bounds from it where it can, and where it cannot the
  // string still survives onto the row. A document staged before the field
  // existed has no text, and the numeric bounds the model reported are then
  // the whole of what it stated.
  const printed = parseReferenceRange(data.referenceText, data.unit);
  const rawLow = printed?.low ?? data.referenceLow;
  const rawHigh = printed?.high ?? data.referenceHigh;
  // Last gate on an impossible window, and the one that matters for facts
  // already sitting in the table: a document staged before the extraction
  // schema learned this rule still carries whatever the model reported, and it
  // arrives here on confirmation. Dropping beats swapping — the pair says the
  // transcription is wrong, not which of the two numbers is.
  const transposed = rawLow !== null && rawHigh !== null && rawLow > rawHigh;
  const sourceLow = transposed ? null : rawLow;
  const sourceHigh = transposed ? null : rawHigh;
  const sourceText = printed?.text ?? null;
  // A window the report printed and the parser could not read is the case that
  // used to pass without a trace: the reading is then judged against the
  // catalog band, or against nothing, and no surface says the lab had stated
  // something else. Count it here so an unreadable notation — a language the
  // prose table does not carry, a layout nobody anticipated — shows up as a
  // number on a dashboard instead of as silence. The string itself is the
  // user's document and stays out of the event.
  if (isUnreadableRange(printed)) {
    annotate({
      action: { name: "labs.referenceRange.unreadable" },
      meta: { surface: "document.commit", length: printed?.text.length ?? 0 },
    });
  }
  // The same reasoning one step further along: a window that WAS readable and
  // cannot be true. Counted rather than merely dropped, because a rising count
  // says something about the extraction that no individual row does.
  if (transposed) {
    annotate({
      action: { name: "labs.referenceRange.transposed" },
      meta: { surface: "document.commit" },
    });
  }

  const biomarker = await resolveOrMintBiomarker(userId, {
    analyte: data.label,
    unit: isQualitative ? (data.unit ?? "") : (data.unit as string),
    referenceLow: isQualitative ? null : sourceLow,
    referenceHigh: isQualitative ? null : sourceHigh,
    panel: null,
  });
  // Fail closed on a unit mismatch against an EXISTING marker. A freshly
  // minted marker adopts the document's unit, so this only bites when the
  // stated unit disagrees with the catalog's authoritative one (e.g. a
  // document states "6.1 mmol/L" against a marker stored in mg/dL). Writing
  // the stated number under the catalog's unit would corrupt the reading AND
  // break the "transcribe verbatim" contract — so reject the fact and let the
  // user reconcile on the review screen, exactly like the `unitRequired` gate.
  // Spelling is compared through the shared normaliser, the same one the
  // manual and scan paths use: `ug/L` is `µg/L`, but `MIU/L` is not `mIU/L`.
  if (!isQualitative) {
    if (!sameLabUnit(data.unit as string, biomarker.unit)) {
      throw new FactCommitError(
        "observation.unitMismatch",
        `The stated unit (${(data.unit as string).trim()}) does not match the saved unit for ${biomarker.name} (${biomarker.unit || "none"}). Reconcile the unit before saving.`,
      );
    }
  }
  const created = await prisma.labResult.create({
    data: {
      userId,
      biomarkerId: biomarker.id,
      panel: biomarker.panel,
      analyte: biomarker.name,
      value: isQualitative ? null : (data.value as number),
      valueText: isQualitative ? data.valueText : null,
      unit: biomarker.unit,
      referenceLow: biomarker.lowerBound,
      referenceHigh: biomarker.upperBound,
      // The report's own window for THIS reading. A qualitative result has no
      // window to record.
      sourceReferenceLow: isQualitative ? null : sourceLow,
      sourceReferenceHigh: isQualitative ? null : sourceHigh,
      sourceReferenceText: isQualitative ? null : sourceText,
      takenAt: statedDateOrNow(data.effectiveDate),
      source: "DOCUMENT",
      noteEncrypted: null,
    },
  });
  invalidateUserHealthScore(userId);

  // v1.31.0 — the labs arm of the data-arrival spine. A "panel" has no
  // first-class entity in the schema (it is a nullable label plus a `takenAt`),
  // so the day-scoped singleton key IS the panel grouping: pasting twelve
  // markers from one draw fires twelve emits that collapse into one arrival.
  // Hooked HERE rather than in the confirm route because the route's
  // `CommittedRecordRef` carries only the id — the draw date and panel label
  // are lost by the time it returns.
  void emitDataArrival({
    userId,
    kind: "labs_panel",
    newestSampleAt: created.takenAt,
    insertedCount: 1,
    refId: created.panel ?? undefined,
    source: "document",
  }).catch(() => {});

  return { recordType: "labResult", recordId: created.id };
}

async function commitCondition(
  userId: string,
  data: ConditionFactData,
): Promise<CommittedRecordRef> {
  // Reproduce the stated status + code verbatim in the note — never interpret
  // it into the `type` / `lifecycle` enums (that would assign meaning). The
  // type stays OTHER so the diagnosis is recorded, not categorised.
  const noteParts: string[] = [];
  if (data.clinicalStatus) noteParts.push(`Status: ${data.clinicalStatus}`);
  if (data.verificationStatus) {
    noteParts.push(`Verification: ${data.verificationStatus}`);
  }
  if (data.code && data.codeSystem) {
    noteParts.push(`Code: ${data.codeSystem} ${data.code}`);
  }
  const note = noteParts.length > 0 ? noteParts.join(" · ") : null;

  const created = await prisma.illnessEpisode.create({
    data: {
      userId,
      label: data.label,
      type: "OTHER",
      lifecycle: "ACUTE",
      onsetAt: statedDateOrNow(data.onsetDate),
      resolvedAt: null,
      parentConditionId: null,
      noteEncrypted: note ? encryptToBytes(note) : null,
    },
  });
  return { recordType: "illnessEpisode", recordId: created.id };
}

async function commitMedication(
  userId: string,
  data: MedicationStatementFactData,
): Promise<CommittedRecordRef> {
  const created = await prisma.medication.create({
    data: {
      userId,
      name: data.name,
      // The document may not state a dose; record it as unspecified rather
      // than invent a number. A blank dose is not allowed by the column.
      dose: data.dose && data.dose.trim() ? data.dose.trim() : "unspecified",
      // A MedicationStatement is a RECORD of what the patient takes, not a
      // prescription action: as-needed (no schedule) with reminders off.
      asNeeded: true,
      notificationsEnabled: false,
      ...(data.atcCode ? { atcCode: data.atcCode } : {}),
      ...(data.rxNormCode ? { rxNormCode: data.rxNormCode } : {}),
    },
  });
  return { recordType: "medication", recordId: created.id };
}

/**
 * Commit one approved fact into its structured store. Throws `FactCommitError`
 * on a per-fact validation miss (e.g. a numeric observation with no unit) so
 * the confirm route can report it without failing the whole batch.
 */
export async function commitApprovedFact(
  userId: string,
  fact: ExtractedFact,
): Promise<CommittedRecordRef> {
  // Decrypt the staged payload at confirm time to write it into the normal
  // structured store. Fail-closed: a bad key id throws and aborts the commit.
  const data = decryptFactData(fact.dataEncrypted);
  if (fact.factType === "OBSERVATION") {
    return commitObservation(userId, data as ObservationFactData);
  }
  if (fact.factType === "CONDITION") {
    return commitCondition(userId, data as ConditionFactData);
  }
  return commitMedication(userId, data as MedicationStatementFactData);
}
