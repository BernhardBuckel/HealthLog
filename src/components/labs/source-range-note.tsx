"use client";

import { formatReferenceRange } from "@/lib/labs/reference-range";
import { useTranslations } from "@/lib/i18n/context";

import type { LabResultDto } from "./types";
import { useLabNumber } from "./use-lab-format";

/**
 * The reference window a reading's own report printed, shown wherever that
 * reading is shown.
 *
 * Renders nothing for a reading with no printed window — most of them — so it
 * costs no space on the common row. When the report DID state a window it
 * names it, verbatim where the report gave words; and when that window and the
 * catalog band disagree it names the catalog band too. A reader told only
 * "3,9–5,4" and a reader told only "3,5–5,0" draw different conclusions from
 * the same number, so a surface that shows one silently is showing a partial
 * answer.
 *
 * Neutral by construction: no tint, no icon, muted text. The in/out verdict is
 * the badge's job — this element states where the window came from, nothing
 * about whether the value is good news.
 */
export function SourceRangeNote({
  reading,
  className,
}: {
  reading: Pick<
    LabResultDto,
    | "unit"
    | "referenceLow"
    | "referenceHigh"
    | "catalogReferenceLow"
    | "catalogReferenceHigh"
    | "sourceReferenceText"
    | "referenceOrigin"
    | "referenceDivergesFromCatalog"
  >;
  className?: string;
}) {
  const { t } = useTranslations();
  const labNumber = useLabNumber();
  if (reading.referenceOrigin !== "source") return null;

  const printed =
    reading.sourceReferenceText ??
    `${formatReferenceRange(
      reading.referenceLow,
      reading.referenceHigh,
      labNumber,
    )} ${reading.unit}`.trim();

  const catalog = formatReferenceRange(
    reading.catalogReferenceLow,
    reading.catalogReferenceHigh,
    labNumber,
  );

  return (
    <span className={className}>
      {t("labs.sourceRange.fromReport", { range: printed })}
      {reading.referenceDivergesFromCatalog && catalog
        ? ` · ${t("labs.sourceRange.catalogDiffers", {
            range: `${catalog} ${reading.unit}`.trim(),
          })}`
        : null}
    </span>
  );
}
