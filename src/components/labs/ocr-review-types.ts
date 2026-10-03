/**
 * v1.18.9 — the client-side review-row shape for the Lab-OCR screen.
 *
 * A proposed extraction row plus the user's per-row edit + confirm state. The
 * extract DTO seeds it; the review screen mutates it; only confirmed rows are
 * mapped back to the commit payload.
 */
import type { OcrExtractedRowDto } from "@/lib/validations/labs-ocr";

import { readingUnitDiffers } from "./ocr-review-validation";

export interface OcrReviewRow {
  /** Stable client key for the list (the analyte+index at seed time). */
  key: string;
  analyte: string;
  value: number | null;
  valueText: string | null;
  unit: string | null;
  referenceLow: number | null;
  referenceHigh: number | null;
  /** The reference range as printed on the scanned report, verbatim. */
  referenceText: string | null;
  /** ISO calendar day (YYYY-MM-DD) or null. */
  takenAt: string | null;
  confidence: OcrExtractedRowDto["confidence"];
  biomarkerMatch: "new" | "existing";
  /**
   * The unit the matched marker is tracked in; null for a marker that does not
   * exist yet. A numeric row whose `unit` differs from it cannot be saved.
   */
  markerUnit: string | null;
  /** Non-null when the server flagged a likely duplicate of a live reading. */
  duplicateOf: string | null;
  /** Whether the row is selected for saving. Defaults false for duplicates. */
  confirmed: boolean;
}

/** Seed the review rows from the extract response. */
export function seedReviewRows(
  rows: OcrExtractedRowDto[],
  fallbackDate: string | null,
): OcrReviewRow[] {
  return rows.map((row, index) => ({
    key: `${row.analyte}-${index}`,
    analyte: row.analyte,
    value: row.value,
    valueText: row.valueText,
    unit: row.unit,
    referenceLow: row.referenceLow,
    referenceHigh: row.referenceHigh,
    referenceText: row.referenceText,
    takenAt: row.takenAt ?? fallbackDate,
    confidence: row.confidence,
    biomarkerMatch: row.biomarkerMatch,
    markerUnit: row.markerUnit,
    duplicateOf: row.duplicateOf,
    // A flagged duplicate starts unchecked, and so does a reading in another
    // unit than its marker's (it carries a badge saying why, and ticking it
    // marks the unit field until it is fixed); everything else starts
    // confirmed.
    confirmed:
      row.duplicateOf === null &&
      !readingUnitDiffers({
        valueText: row.valueText,
        unit: row.unit,
        markerUnit: row.markerUnit,
      }),
  }));
}
