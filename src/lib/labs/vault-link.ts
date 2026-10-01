/**
 * S9 — link labs committed from an OCR scan back to the vault document filed
 * for that scan.
 *
 * When a user scans a lab report in the labs area with the `inboundDocuments`
 * module on, the client files the uploaded bytes into the Documents vault
 * (through the existing `POST /api/documents/inbound` upload — encrypted at
 * rest, EXIF-stripped, thumbnailed, sha256-deduped) and threads the resulting
 * document id to the OCR commit. This function makes the cross-reference: each
 * committed `LabResult` gets an APPROVED `ExtractedFact` whose
 * `committedRecordId` / `committedRecordType` point at it — the SAME provenance
 * artefact the manual vault → labs path produces, so the two directions
 * converge on one representation (a document with confirmed observation facts).
 *
 * Owner-scoped and module-gated: a document that is not the caller's, or a
 * caller with the module off, links nothing. Idempotent by construction — the
 * OCR commit only passes the rows it actually inserted (re-committing the same
 * scan inserts zero rows, so zero facts are created). Any PENDING facts the
 * auto-index cross-fire (S8) may have staged on the same row are superseded:
 * the user just committed these labs, so the document's facts become exactly
 * the committed set and the document is marked CONFIRMED.
 *
 * Best-effort: the OCR commit is the authoritative write; a failure to file the
 * cross-link never fails the commit (the caller swallows it).
 */
import { prisma } from "@/lib/db";
import { encryptFactData, encryptFactProvenance } from "@/lib/documents/store";
import { annotate } from "@/lib/logging/context";
import { isModuleEnabled } from "@/lib/modules/gate";
import type { ObservationFactData } from "@/lib/validations/inbound-documents";
import { dateOnlyKey } from "@/lib/tz/date-only";

/** One inserted lab row to cross-link back to its source vault document. */
export interface InsertedLabForLink {
  labResultId: string;
  analyte: string;
  value: number | null;
  valueText: string | null;
  unit: string | null;
  referenceLow: number | null;
  referenceHigh: number | null;
  takenAt: Date;
}

/** Build the FHIR-staged Observation payload for a committed lab row. */
function observationFromLab(lab: InsertedLabForLink): ObservationFactData {
  return {
    label: lab.analyte,
    // An OCR-scanned reading carries no coded system; the vault fact records the
    // stated value only, never an inferred LOINC.
    code: null,
    codeSystem: null,
    value: lab.value,
    valueText: lab.valueText,
    unit: lab.unit,
    referenceLow: lab.referenceLow,
    referenceHigh: lab.referenceHigh,
    effectiveDate: dateOnlyKey(lab.takenAt),
  };
}

/**
 * Cross-link the inserted OCR labs to their source vault document. Returns the
 * number of facts written (0 when the module is off, the document is not owned,
 * or there is nothing to link).
 */
export async function linkOcrLabsToVaultDocument(
  userId: string,
  documentId: string,
  labs: InsertedLabForLink[],
): Promise<{ linked: number }> {
  if (labs.length === 0) return { linked: 0 };

  // The cross-link fires only when the documents module is on for the user.
  if (!(await isModuleEnabled(userId, "inboundDocuments"))) {
    return { linked: 0 };
  }

  // Ownership fail-closed — the document must be a live row of the caller.
  const doc = await prisma.inboundDocument.findFirst({
    where: { id: documentId, userId, deletedAt: null },
    select: { id: true },
  });
  if (!doc) return { linked: 0 };

  await prisma.$transaction(async (tx) => {
    // Supersede any PENDING facts the auto-index cross-fire staged on this row:
    // the user just confirmed these exact labs, so they are the document's facts.
    await tx.extractedFact.deleteMany({
      where: { documentId, userId, status: "PENDING" },
    });
    await tx.extractedFact.createMany({
      data: labs.map((lab) => ({
        documentId,
        userId,
        factType: "OBSERVATION" as const,
        status: "APPROVED" as const,
        confidence: 1,
        needsReview: false,
        dataEncrypted: encryptFactData(observationFromLab(lab)),
        // No document span to point at: this fact is minted from an already
        // committed lab row, not transcribed from the document text.
        provenanceEncrypted: encryptFactProvenance({
          sourceText: "",
          anchored: false,
          sourceOffset: null,
          page: null,
          confidence: 1,
        }),
        committedRecordId: lab.labResultId,
        committedRecordType: "labResult",
      })),
    });
    await tx.inboundDocument.update({
      where: { id: documentId },
      data: { status: "CONFIRMED" },
    });
  });

  annotate({
    action: { name: "labs.ocr.vaultLinked" },
    meta: { documentId, linked: labs.length },
  });
  return { linked: labs.length };
}
