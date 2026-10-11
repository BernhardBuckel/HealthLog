/**
 * v1.18.1 — server-authoritative lab-result DTO resolution.
 *
 * A lab row resolves its display name + unit + reference bounds in ONE place:
 *
 *  - If the row links a `Biomarker` (`biomarkerId` set), the canonical name,
 *    unit, and reference bounds come FROM THE BIOMARKER. The per-row legacy
 *    `analyte` / `unit` / `reference*` columns are ignored — they are stale
 *    historical truth at that point.
 *  - If the row is unlinked (legacy / pre-backfill), it falls back to its own
 *    free-text `analyte` / `unit` / `reference*` columns.
 *
 * On top of that the reading's OWN printed window wins. A lab report states
 * the range its method and device produce right beside the value, and that is
 * the window a physician evaluates against; the catalog band is the net for
 * readings that carry none. `resolveEffectiveReferenceRange` owns that
 * precedence and this file is one of its callers, not a second copy of it.
 *
 * The DTO therefore carries three windows and says which one is in force:
 *
 *  - `referenceLow` / `referenceHigh` — the EFFECTIVE bounds, the ones
 *    `rangeStatus` was computed from. A client that reads only these fields
 *    (including an iOS build that predates the source window) renders the
 *    right numbers and the right verdict with no change of its own.
 *  - `catalogReferenceLow` / `catalogReferenceHigh` — the catalog band, so a
 *    surface can paint both and show where they part.
 *  - `sourceReferenceLow` / `sourceReferenceHigh` / `sourceReferenceText` —
 *    what the report printed, the last verbatim.
 *
 * `referenceOrigin` names which window is in force and
 * `referenceDivergesFromCatalog` flags the case a reader must be told about.
 * Every value is resolved server-side; neither client recomputes a range,
 * guesses a unit, or re-derives the verdict.
 *
 * The two serialisers below spell every field out rather than spreading a
 * shared helper: `written-outcome-response-consumer-guard` walks these object
 * literals to enumerate the response leaves and pair each with a client
 * reader, and a spread of a function call hides them from it. A field added
 * here must be visible there.
 */
import {
  classifyAgainstEffectiveRange,
  resolveEffectiveReferenceRange,
  type EffectiveReferenceRange,
  type ReferenceRangeOrigin,
} from "@/lib/labs/reference-range";

/** The minimal biomarker shape the resolver needs (no encrypted context). */
export interface ResolvedBiomarker {
  id: string;
  name: string;
  unit: string;
  lowerBound: number | null;
  upperBound: number | null;
  panel: string | null;
  /** Which analyte the marker is (unit-conversion registry key), if known. */
  analyteKey?: string | null;
}

/** The lab-result row shape the resolver reads (Prisma row subset). */
export interface LabRow {
  id: string;
  panel: string | null;
  analyte: string;
  /** Numeric reading; null for a qualitative row (see `valueText`). */
  value: number | null;
  /** v1.18.9 — qualitative result text; null for a numeric row. */
  valueText: string | null;
  unit: string;
  referenceLow: number | null;
  referenceHigh: number | null;
  /** The window the source report printed for THIS reading. */
  sourceReferenceLow: number | null;
  sourceReferenceHigh: number | null;
  sourceReferenceText: string | null;
  takenAt: Date;
  source: string;
  biomarkerId: string | null;
  /**
   * When the reading was converted into the marker's unit: the value and unit
   * as the report printed them. Both null for a reading stored as stated.
   */
  sourceValue?: number | null;
  sourceUnit?: string | null;
  noteEncrypted: Uint8Array | null;
  createdAt: Date;
  updatedAt: Date;
}

/** The columns `resolveLabFields` needs off a lab row. */
export type LabFieldRow = Pick<
  LabRow,
  | "analyte"
  | "unit"
  | "referenceLow"
  | "referenceHigh"
  | "sourceReferenceLow"
  | "sourceReferenceHigh"
  | "sourceReferenceText"
  | "panel"
  | "biomarkerId"
>;

/** What every lab surface reads off a row: identity, unit, and one window. */
export interface ResolvedLabFields {
  analyte: string;
  unit: string;
  panel: string | null;
  /** The bounds in force for this reading — source window first, catalog next. */
  referenceLow: number | null;
  referenceHigh: number | null;
  /** The catalog band, so a surface can show both windows. */
  catalogReferenceLow: number | null;
  catalogReferenceHigh: number | null;
  /** What the source report printed for this reading. */
  sourceReferenceLow: number | null;
  sourceReferenceHigh: number | null;
  sourceReferenceText: string | null;
  referenceOrigin: ReferenceRangeOrigin;
  referenceDivergesFromCatalog: boolean;
  /** The resolved window as one value, for callers that pass it on. */
  effectiveRange: EffectiveReferenceRange;
}

/**
 * Resolve the canonical name / unit / window / panel for a lab row.
 *
 * Two resolutions happen here, in this order:
 *
 *  1. Identity + catalog band: the linked biomarker wins over the row's legacy
 *     free-text columns (an unlinked pre-backfill row falls back to its own).
 *  2. The window in force: the reading's printed source range wins over the
 *     catalog band, through `resolveEffectiveReferenceRange`.
 *
 * Every lab surface calls this, so the window a reading is judged against is
 * the same on the API, the doctor report, insights, the coach, MCP and FHIR.
 */
export function resolveLabFields(
  row: LabFieldRow,
  biomarker: ResolvedBiomarker | null | undefined,
): ResolvedLabFields {
  const identity = biomarker
    ? {
        analyte: biomarker.name,
        unit: biomarker.unit,
        panel: biomarker.panel,
        catalogLow: biomarker.lowerBound,
        catalogHigh: biomarker.upperBound,
      }
    : {
        analyte: row.analyte,
        unit: row.unit,
        panel: row.panel,
        catalogLow: row.referenceLow,
        catalogHigh: row.referenceHigh,
      };

  const effectiveRange = resolveEffectiveReferenceRange(
    identity.catalogLow,
    identity.catalogHigh,
    row,
  );

  return {
    analyte: identity.analyte,
    unit: identity.unit,
    panel: identity.panel,
    referenceLow: effectiveRange.low,
    referenceHigh: effectiveRange.high,
    catalogReferenceLow: effectiveRange.catalogLow,
    catalogReferenceHigh: effectiveRange.catalogHigh,
    sourceReferenceLow: row.sourceReferenceLow,
    sourceReferenceHigh: row.sourceReferenceHigh,
    sourceReferenceText: effectiveRange.sourceText,
    referenceOrigin: effectiveRange.origin,
    referenceDivergesFromCatalog: effectiveRange.divergesFromCatalog,
    effectiveRange,
  };
}

/**
 * Serialise a lab row to the list DTO — never echoes the encrypted note bytes
 * (only the `hasNote` flag) and resolves name/unit/range server-side.
 */
export function serialiseLabResult(
  row: LabRow,
  biomarker?: ResolvedBiomarker | null,
) {
  const resolved = resolveLabFields(row, biomarker);
  const conversion = conversionFields(row);
  return {
    id: row.id,
    biomarkerId: row.biomarkerId,
    panel: resolved.panel,
    analyte: resolved.analyte,
    value: row.value,
    valueText: row.valueText,
    unit: resolved.unit,
    converted: conversion.converted,
    sourceValue: conversion.sourceValue,
    sourceUnit: conversion.sourceUnit,
    referenceLow: resolved.referenceLow,
    referenceHigh: resolved.referenceHigh,
    catalogReferenceLow: resolved.catalogReferenceLow,
    catalogReferenceHigh: resolved.catalogReferenceHigh,
    sourceReferenceLow: resolved.sourceReferenceLow,
    sourceReferenceHigh: resolved.sourceReferenceHigh,
    sourceReferenceText: resolved.sourceReferenceText,
    referenceOrigin: resolved.referenceOrigin,
    referenceDivergesFromCatalog: resolved.referenceDivergesFromCatalog,
    takenAt: row.takenAt.toISOString(),
    source: row.source,
    hasNote: row.noteEncrypted !== null,
    // A qualitative row has no number to place against bounds, so it reports
    // the neutral "unknown" rather than a fabricated in/out verdict.
    rangeStatus: classifyAgainstEffectiveRange(
      row.value,
      resolved.effectiveRange,
    ),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Whether the stored number is a conversion, and what the report printed. A
 * reading stored as stated reports `converted: false` and two nulls.
 */
function conversionFields(row: Pick<LabRow, "sourceValue" | "sourceUnit">) {
  const sourceValue = row.sourceValue ?? null;
  const sourceUnit = row.sourceUnit ?? null;
  return {
    converted: sourceValue !== null && sourceUnit !== null,
    sourceValue,
    sourceUnit,
  };
}

/**
 * Serialise a lab row to the detail DTO — same as the list DTO but carries the
 * decrypted `note` instead of the `hasNote` flag.
 */
export function serialiseLabResultDetail(
  row: LabRow,
  biomarker: ResolvedBiomarker | null | undefined,
  note: string | null,
) {
  const resolved = resolveLabFields(row, biomarker);
  const conversion = conversionFields(row);
  return {
    id: row.id,
    biomarkerId: row.biomarkerId,
    panel: resolved.panel,
    analyte: resolved.analyte,
    value: row.value,
    valueText: row.valueText,
    unit: resolved.unit,
    converted: conversion.converted,
    sourceValue: conversion.sourceValue,
    sourceUnit: conversion.sourceUnit,
    referenceLow: resolved.referenceLow,
    referenceHigh: resolved.referenceHigh,
    catalogReferenceLow: resolved.catalogReferenceLow,
    catalogReferenceHigh: resolved.catalogReferenceHigh,
    sourceReferenceLow: resolved.sourceReferenceLow,
    sourceReferenceHigh: resolved.sourceReferenceHigh,
    sourceReferenceText: resolved.sourceReferenceText,
    referenceOrigin: resolved.referenceOrigin,
    referenceDivergesFromCatalog: resolved.referenceDivergesFromCatalog,
    takenAt: row.takenAt.toISOString(),
    source: row.source,
    note,
    rangeStatus: classifyAgainstEffectiveRange(
      row.value,
      resolved.effectiveRange,
    ),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
