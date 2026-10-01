"use client";

import { useCallback } from "react";

import { useFormatters } from "@/lib/i18n/context";
import { formatLabValue, type LabNumberFormat } from "@/lib/labs/format-value";

/**
 * A lab value in the reader's number format, trimmed the way every lab
 * surface trims it (whole numbers bare, at most two decimals).
 */
export function useLabNumber(): LabNumberFormat {
  const fmt = useFormatters();
  return useCallback(
    (value: number) => formatLabValue(value, (n) => fmt.number(n)),
    [fmt],
  );
}
