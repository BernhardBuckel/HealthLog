"use client";

/**
 * v1.18.9 — a single proposed Lab-OCR row on the review screen.
 *
 * Mandatory human review: each row is shown for per-row confirm/edit/discard.
 * The checkbox confirms; the inline fields edit analyte / value-or-valueText /
 * unit / reference range / date. Server-computed hints surface as calm badges:
 * a new-vs-existing-biomarker hint, a duplicate warning (the row defaults to
 * unchecked when flagged), and a low-confidence flag per the model's self-score.
 *
 * The no-alarming-colour ethos holds: an out-of-range or duplicate row is not
 * painted red — these are informative `secondary`/`outline` badges, same weight
 * as the in-range state.
 */
import { useId } from "react";

import {
  AlertCircle,
  FilePlus2,
  Link2,
  Ruler,
  TriangleAlert,
} from "lucide-react";

import { FieldError } from "@/components/forms/field-error";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { DateField } from "@/components/ui/date-field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useTranslations } from "@/lib/i18n/context";

import type { OcrReviewRow } from "./ocr-review-types";
import type { OcrRowErrors } from "./ocr-review-validation";

/** Below this per-field confidence the field is flagged for a second look. */
const CONFIDENCE_THRESHOLD = 0.6;

/** The visible marker that a field must be filled before the row can save. */
function RequiredMark() {
  return (
    <span aria-hidden className="text-destructive">
      {" *"}
    </span>
  );
}

export function OcrRowEditor({
  row,
  onChange,
  errors,
}: {
  row: OcrReviewRow;
  onChange: (next: OcrReviewRow) => void;
  /** The blocking fields of this row, once a save has been attempted. */
  errors?: OcrRowErrors;
}) {
  const { t } = useTranslations();
  const fieldId = useId();
  const invalidProps = (field: keyof OcrRowErrors) =>
    errors?.[field]
      ? {
          "aria-invalid": true as const,
          "aria-describedby": `${fieldId}-${field}-error`,
        }
      : {};
  const fieldError = (field: keyof OcrRowErrors, messageKey: string) =>
    errors?.[field] ? (
      <FieldError id={`${fieldId}-${field}-error`} message={t(messageKey)} />
    ) : null;

  const isQualitative = row.valueText !== null && row.valueText !== undefined;
  const lowValueConfidence =
    !isQualitative && row.confidence.value < CONFIDENCE_THRESHOLD;
  const valueUnreadable = !isQualitative && row.value === null;

  // The model self-scores each field it transcribed. Surface a single calm
  // per-row flag when ANY tracked field came back below the threshold so a
  // shaky read is visible at a glance — including on qualitative rows, which
  // have no value-confidence footnote of their own. Informative, not alarming.
  const lowRowConfidence =
    row.confidence.analyte < CONFIDENCE_THRESHOLD ||
    row.confidence.unit < CONFIDENCE_THRESHOLD ||
    (isQualitative
      ? row.confidence.value < CONFIDENCE_THRESHOLD
      : lowValueConfidence);

  // v1.18.10 (#5) — a NEW numeric biomarker mints its catalog reference range
  // from THIS extracted row. The range is therefore load-bearing and worth a
  // second look. Surface the range confidence prominently for new numeric
  // markers, and call it out explicitly when the model was unsure (or set no
  // bounds at all) so the user verifies the range it will be judged against.
  const isNewNumericMarker = !isQualitative && row.biomarkerMatch === "new";
  const lowRangeConfidence = row.confidence.range < CONFIDENCE_THRESHOLD;
  const hasBounds = row.referenceLow !== null || row.referenceHigh !== null;
  const flagRange = isNewNumericMarker && (lowRangeConfidence || !hasBounds);

  return (
    <div className="space-y-3 rounded-lg border p-3">
      <div className="flex items-start gap-3">
        {/* The checkbox is the PRIMARY per-row confirm on a touch-first OCR
            review screen, so it needs a ≥44px hit area on coarse pointers. The
            wrapping label supplies the touch target (and forwards the click to
            the control) without enlarging the 20px glyph or bloating the row on
            desktop, where the negative margins collapse the padding back. */}
        <label
          htmlFor={`${fieldId}-confirm`}
          className="-m-3 flex min-h-11 min-w-11 cursor-pointer items-start justify-center p-3 sm:m-0 sm:min-h-0 sm:min-w-0 sm:p-0"
        >
          <Checkbox
            id={`${fieldId}-confirm`}
            checked={row.confirmed}
            onCheckedChange={(checked) =>
              onChange({ ...row, confirmed: checked === true })
            }
            className="mt-0.5 min-h-5 min-w-5 sm:mt-1"
            aria-label={t("labs.ocr.confirmRow")}
          />
        </label>
        <div className="min-w-0 flex-1 space-y-1">
          <Input
            value={row.analyte}
            onChange={(e) => onChange({ ...row, analyte: e.target.value })}
            aria-label={t("labs.ocr.analyteLabel")}
            {...invalidProps("analyte")}
            className="font-medium"
          />
          {fieldError("analyte", "labs.ocr.errorAnalyte")}
          <div className="flex flex-wrap items-center gap-1.5">
            {row.biomarkerMatch === "existing" ? (
              // The chip repeats the analyte, so a long panel name ran past
              // the row on a phone; it truncates inside the row instead.
              <Badge
                variant="outline"
                className="text-muted-foreground max-w-full"
                title={t("labs.ocr.linksExisting", { name: row.analyte })}
              >
                <Link2 aria-hidden />
                <span className="truncate">
                  {t("labs.ocr.linksExisting", { name: row.analyte })}
                </span>
              </Badge>
            ) : (
              <Badge variant="outline" className="text-muted-foreground">
                <FilePlus2 aria-hidden />
                {t("labs.ocr.newBiomarker")}
              </Badge>
            )}
            {row.duplicateOf ? (
              <Badge variant="secondary">
                <TriangleAlert aria-hidden />
                {t("labs.ocr.duplicateWarning")}
              </Badge>
            ) : null}
            {lowRowConfidence ? (
              <Badge variant="secondary" className="text-muted-foreground">
                <AlertCircle aria-hidden />
                {t("labs.ocr.lowConfidenceBadge")}
              </Badge>
            ) : null}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {isQualitative ? (
          <div className="col-span-2 space-y-1 sm:col-span-3">
            <Label htmlFor={`${fieldId}-vt`} className="text-xs">
              {t("labs.ocr.resultLabel")}
              <RequiredMark />
            </Label>
            <Input
              id={`${fieldId}-vt`}
              value={row.valueText ?? ""}
              onChange={(e) => onChange({ ...row, valueText: e.target.value })}
              {...invalidProps("valueText")}
            />
            {fieldError("valueText", "labs.ocr.errorResult")}
          </div>
        ) : (
          <>
            <div className="space-y-1">
              <Label htmlFor={`${fieldId}-val`} className="text-xs">
                {t("labs.ocr.valueLabel")}
                <RequiredMark />
              </Label>
              <Input
                id={`${fieldId}-val`}
                inputMode="decimal"
                value={row.value === null ? "" : String(row.value)}
                onChange={(e) => {
                  const raw = e.target.value.trim();
                  const parsed = raw === "" ? null : Number(raw);
                  onChange({
                    ...row,
                    value:
                      parsed !== null && Number.isFinite(parsed)
                        ? parsed
                        : null,
                  });
                }}
                {...invalidProps("value")}
              />
              {fieldError("value", "labs.ocr.errorValue")}
            </div>
            <div className="space-y-1">
              <Label htmlFor={`${fieldId}-unit`} className="text-xs">
                {t("labs.ocr.unitLabel")}
                <RequiredMark />
              </Label>
              <Input
                id={`${fieldId}-unit`}
                value={row.unit ?? ""}
                onChange={(e) => onChange({ ...row, unit: e.target.value })}
                {...invalidProps("unit")}
              />
              {fieldError("unit", "labs.ocr.errorUnit")}
            </div>
          </>
        )}
        <div className="space-y-1">
          <Label htmlFor={`${fieldId}-date`} className="text-xs">
            {t("labs.ocr.dateLabel")}
            <RequiredMark />
          </Label>
          <DateField
            id={`${fieldId}-date`}
            value={row.takenAt ?? ""}
            onChange={(value) => onChange({ ...row, takenAt: value || null })}
            {...invalidProps("date")}
            // The bordered wrapper is the visible control; the input inside
            // it only carries the aria state.
            className={errors?.date ? "border-destructive" : undefined}
          />
          {fieldError("date", "labs.ocr.errorDate")}
        </div>
      </div>

      {/* v1.18.10 (#5) — for a NEW numeric biomarker the reference range below
          becomes the marker's catalog range. Make that consequence visible, and
          flag low range-confidence / a missing range so the user verifies it
          before saving. A calm `secondary` badge, not an alarm. */}
      {isNewNumericMarker ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant={flagRange ? "secondary" : "outline"}>
            <Ruler aria-hidden />
            {flagRange
              ? t("labs.ocr.rangeVerify")
              : t("labs.ocr.rangeFromScan")}
          </Badge>
        </div>
      ) : null}

      {!isQualitative ? (
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1">
            <Label htmlFor={`${fieldId}-lo`} className="text-xs">
              {t("labs.ocr.refLowLabel")}
            </Label>
            <Input
              id={`${fieldId}-lo`}
              inputMode="decimal"
              value={row.referenceLow === null ? "" : String(row.referenceLow)}
              onChange={(e) => {
                const raw = e.target.value.trim();
                const parsed = raw === "" ? null : Number(raw);
                onChange({
                  ...row,
                  referenceLow:
                    parsed !== null && Number.isFinite(parsed) ? parsed : null,
                });
              }}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`${fieldId}-hi`} className="text-xs">
              {t("labs.ocr.refHighLabel")}
            </Label>
            <Input
              id={`${fieldId}-hi`}
              inputMode="decimal"
              value={
                row.referenceHigh === null ? "" : String(row.referenceHigh)
              }
              onChange={(e) => {
                const raw = e.target.value.trim();
                const parsed = raw === "" ? null : Number(raw);
                onChange({
                  ...row,
                  referenceHigh:
                    parsed !== null && Number.isFinite(parsed) ? parsed : null,
                });
              }}
            />
          </div>
        </div>
      ) : null}

      {/* The window as the report printed it. Editable, because the human is
          reviewing a transcription: the two bounds above are the derived
          reading of this string, and correcting the string is how a range the
          parser could not read ("bis 5,0", "negativ") still reaches the row
          instead of being dropped. */}
      {!isQualitative ? (
        <div className="space-y-1">
          <Label htmlFor={`${fieldId}-refText`} className="text-xs">
            {t("labs.ocr.refTextLabel")}
          </Label>
          <Input
            id={`${fieldId}-refText`}
            value={row.referenceText ?? ""}
            placeholder={t("labs.ocr.refTextPlaceholder")}
            maxLength={120}
            onChange={(e) => {
              const raw = e.target.value;
              onChange({
                ...row,
                referenceText: raw.trim() === "" ? null : raw,
              });
            }}
          />
        </div>
      ) : null}

      {valueUnreadable ? (
        <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
          <AlertCircle aria-hidden className="h-3.5 w-3.5" />
          {t("labs.ocr.valueUnreadable")}
        </p>
      ) : lowValueConfidence ? (
        <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
          <AlertCircle aria-hidden className="h-3.5 w-3.5" />
          {t("labs.ocr.lowConfidence")}
        </p>
      ) : null}
    </div>
  );
}
