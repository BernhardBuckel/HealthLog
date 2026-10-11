"use client";

import { useTranslations } from "@/lib/i18n/context";
import { formatLabValue } from "@/lib/labs/format-value";

import { useLabNumber } from "./use-lab-format";

/**
 * A quiet "converted from 5.6 mmol/L" beside a reading whose stored number is a
 * conversion of what the report printed, so a number nobody typed can always be
 * traced back. Renders nothing for a reading stored as stated.
 */
export function LabConvertedNote({
  reading,
  className,
}: {
  reading: {
    converted: boolean;
    sourceValue: number | null;
    sourceUnit: string | null;
  };
  className?: string;
}) {
  const { t } = useTranslations();
  const labNumber = useLabNumber();
  if (
    !reading.converted ||
    reading.sourceValue === null ||
    reading.sourceUnit === null
  ) {
    return null;
  }
  return (
    <span
      data-slot="lab-converted-note"
      className={className ?? "text-muted-foreground text-xs"}
    >
      {t("labs.convertedFrom", {
        value: formatLabValue(reading.sourceValue, labNumber),
        unit: reading.sourceUnit,
      })}
    </span>
  );
}
