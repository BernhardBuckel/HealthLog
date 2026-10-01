"use client";

import { useCallback } from "react";

import { useCalendarDate } from "@/hooks/use-calendar-date";
import { useFormatters } from "@/lib/i18n/context";
import { formatLabValue, type LabNumberFormat } from "@/lib/labs/format-value";
import { isNoonUtcAnchor } from "@/lib/tz/date-only";

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

/**
 * The date a lab reading was taken. A reading entered by hand carries its
 * time of day and is dated in the reader's zone; one imported from a report
 * that states only the date is stored at noon UTC and is dated by that
 * calendar date, so it does not move to the next day east of UTC+12.
 */
export function useLabDate(): (takenAt: string) => string {
  const fmt = useFormatters();
  const calendarDate = useCalendarDate();
  return useCallback(
    (takenAt: string) => {
      const instant = new Date(takenAt);
      return isNoonUtcAnchor(instant)
        ? calendarDate(instant)
        : fmt.date(instant);
    },
    [fmt, calendarDate],
  );
}
