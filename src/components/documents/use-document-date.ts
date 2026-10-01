"use client";

import { useCallback } from "react";

import { useCalendarDate } from "@/hooks/use-calendar-date";
import { useFormatters } from "@/lib/i18n/context";
import type { InboundDocumentDto } from "@/lib/validations/inbound-documents";

/**
 * The date a document files under, as a reader sees it. A filing date is a
 * calendar date and reads the same in every zone; a document without one
 * shows the day it was uploaded, which is an instant and reads in the
 * reader's zone.
 */
export function useDocumentDate(): (
  doc: Pick<InboundDocumentDto, "documentDate" | "createdAt">,
) => string {
  const fmt = useFormatters();
  const calendarDate = useCalendarDate();
  return useCallback(
    (doc) =>
      doc.documentDate
        ? calendarDate(doc.documentDate)
        : fmt.date(doc.createdAt),
    [fmt, calendarDate],
  );
}
