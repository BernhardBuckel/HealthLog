"use client";

import { useCallback } from "react";

import { formatDate } from "@/lib/date-format";
import { useDateFormatPreference, useTranslations } from "@/lib/i18n/context";

/**
 * Format a date-only value: a `YYYY-MM-DD` key, or a stored instant that
 * stands for a calendar date (noon UTC, or a `@db.Date` column's UTC
 * midnight). The calendar date is read in UTC, so it is the same day in
 * every zone.
 *
 * Formatting such a value in the reader's zone is how a noon-UTC date came
 * to show the next day from UTC+12 to UTC+14. Same field order and locale as
 * `useFormatters().date`, so it sits beside instant-formatted dates without
 * looking different.
 */
export function useCalendarDate(): (value: string | Date) => string {
  const { locale } = useTranslations();
  const dateFormat = useDateFormatPreference();
  return useCallback(
    (value: string | Date) =>
      formatDate(
        // `formatDate` reads a bare key as a calendar date already.
        typeof value === "string" ? value.slice(0, 10) : value,
        dateFormat,
        locale,
      ),
    [dateFormat, locale],
  );
}
