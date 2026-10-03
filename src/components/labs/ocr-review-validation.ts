/**
 * Per-row validation for the Lab-OCR review screen.
 *
 * A confirmed row can only be written when it carries everything the commit
 * payload needs. `validateReviewRow` reports WHICH fields are missing so the
 * review screen can mark them, and `toCommitRow` is the same rule applied to
 * build the payload: it returns null exactly when `validateReviewRow` reports
 * at least one field.
 */
import { sameLabUnit } from "@/lib/labs/unit-normalise";

import type { OcrReviewRow } from "./ocr-review-types";
import type { OcrCommitRowInput } from "./use-ocr-extract";

export type OcrRowField =
  "analyte" | "value" | "valueText" | "unit" | "unitMismatch" | "date";

/** The fields of one row that block saving; empty when the row is writable. */
export type OcrRowErrors = Partial<Record<OcrRowField, true>>;

/** A calendar day → an ISO instant at noon UTC, avoiding a TZ day-shift. */
function dayAtNoonUtc(day: string | null): Date | null {
  if (!day) return null;
  const at = new Date(`${day}T12:00:00.000Z`);
  return Number.isNaN(at.getTime()) ? null : at;
}

function isQualitativeRow(row: OcrReviewRow): boolean {
  return row.valueText !== null && row.valueText !== undefined;
}

/**
 * Whether a numeric reading states a unit other than the one its marker is
 * tracked in. A qualitative reading has no unit, a new marker adopts the row's
 * own, and a row with no unit yet is a different problem (`unit`), so none of
 * those count. The same rule the commit applies when it skips such a row.
 */
export function readingUnitDiffers(row: {
  valueText: string | null | undefined;
  unit: string | null | undefined;
  markerUnit: string | null | undefined;
}): boolean {
  if (row.valueText !== null && row.valueText !== undefined) return false;
  const stated = (row.unit ?? "").trim();
  if (!row.markerUnit || !stated) return false;
  return !sameLabUnit(stated, row.markerUnit);
}

export function validateReviewRow(row: OcrReviewRow): OcrRowErrors {
  const errors: OcrRowErrors = {};
  if (!row.analyte.trim()) errors.analyte = true;
  if (!dayAtNoonUtc(row.takenAt)) errors.date = true;

  if (isQualitativeRow(row)) {
    if (!(row.valueText ?? "").trim()) errors.valueText = true;
  } else {
    if (row.value === null || !Number.isFinite(row.value)) errors.value = true;
    if (!(row.unit ?? "").trim()) errors.unit = true;
    if (readingUnitDiffers(row)) errors.unitMismatch = true;
  }
  return errors;
}

export function hasRowErrors(errors: OcrRowErrors): boolean {
  return Object.keys(errors).length > 0;
}

/** Map a confirmed review row to the commit payload, or null when invalid. */
export function toCommitRow(row: OcrReviewRow): OcrCommitRowInput | null {
  const analyte = row.analyte.trim();
  const takenAt = dayAtNoonUtc(row.takenAt);
  if (!analyte || !takenAt) return null;

  if (isQualitativeRow(row)) {
    const valueText = (row.valueText ?? "").trim();
    if (!valueText) return null;
    return { analyte, valueText, takenAt: takenAt.toISOString() };
  }

  if (row.value === null || !Number.isFinite(row.value)) return null;
  const unit = (row.unit ?? "").trim();
  if (!unit) return null;
  if (readingUnitDiffers(row)) return null;
  return {
    analyte,
    value: row.value,
    unit,
    takenAt: takenAt.toISOString(),
    ...(row.referenceLow !== null ? { referenceLow: row.referenceLow } : {}),
    ...(row.referenceHigh !== null ? { referenceHigh: row.referenceHigh } : {}),
    ...(row.referenceText ? { referenceText: row.referenceText } : {}),
  };
}

/** Blocking fields per CONFIRMED row, keyed by the row's key; writable rows are absent. */
export function collectRowErrors(
  rows: readonly OcrReviewRow[],
): Map<string, OcrRowErrors> {
  const byKey = new Map<string, OcrRowErrors>();
  for (const row of rows) {
    if (!row.confirmed) continue;
    const errors = validateReviewRow(row);
    if (hasRowErrors(errors)) byKey.set(row.key, errors);
  }
  return byKey;
}

/**
 * What pressing Save does. A save is all-or-nothing over the selected rows:
 * one unwritable row blocks the whole save instead of being dropped, because a
 * reading that is silently left out is a reading the person believes was kept.
 */
export type OcrSavePlan =
  | { kind: "nothing-selected" }
  | { kind: "blocked" }
  | { kind: "ready"; payload: OcrCommitRowInput[] };

export function planSave(rows: readonly OcrReviewRow[]): OcrSavePlan {
  const confirmed = rows.filter((row) => row.confirmed);
  if (confirmed.length === 0) return { kind: "nothing-selected" };
  if (collectRowErrors(confirmed).size > 0) return { kind: "blocked" };
  const payload = confirmed
    .map(toCommitRow)
    .filter((row): row is OcrCommitRowInput => row !== null);
  return { kind: "ready", payload };
}
