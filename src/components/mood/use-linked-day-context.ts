"use client";

/**
 * Read what the other modules already hold for one local day.
 *
 * A hook rather than a prop drilled from a page, because both mood surfaces
 * need it and both know only the wall-clock value in their timestamp field.
 *
 * **Which zone that day is read in depends on which surface is asking, and the
 * two are genuinely different questions.** The capture sheet is about to write
 * a new entry, and that entry will be anchored to the zone the browser is in,
 * so the browser's zone is the right one and the figures it shows are the
 * figures the saved row will sit beside. The edit dialog is looking at an
 * entry that already decided which day it belongs to and stored the zone it
 * decided in: reading that entry's day under the corrector's browser zone
 * would show a night from an entry logged in another country shifted by
 * several hours, and nothing on the screen would say so. So the caller passes
 * the entry's stored `tz` and the hook does not guess.
 *
 * The query key carries both the day and the zone. One key for both would let
 * whichever answer arrived first serve the other — the same-key /
 * different-shape cache poisoning the key factory exists to prevent, in its
 * quieter same-shape / different-window form. Two surfaces asking about the
 * same calendar date under two zones is exactly that case, and it is reachable
 * from one screen: the list can hold an entry logged abroad while the sheet
 * writes one logged here.
 */
import { useQuery } from "@tanstack/react-query";

import { apiGet } from "@/lib/api/api-fetch";
import { queryKeys } from "@/lib/query-keys";
import type { LinkedDayContext } from "@/lib/mood/linked-context";
import { userDayKey } from "@/lib/tz/format";

/**
 * The browser's own zone — the right answer for an entry that does not exist
 * yet, and the wrong one for an entry that already stored its own.
 */
export function browserTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** `YYYY-MM-DD` for a `datetime-local` value, or today when it is empty. */
export function dayOfLocalInput(value: string): string {
  if (value.length >= 10) return value.slice(0, 10);
  return userDayKey(new Date(), browserTimezone());
}

/**
 * @param day the local day to read, `YYYY-MM-DD`
 * @param enabled whether to fetch at all
 * @param timezone the zone `day` is anchored to. Omit ONLY where the day has
 *   no zone of its own yet — a new entry the capture sheet is composing. An
 *   entry being edited passes its stored `tz`.
 */
/**
 * The zone a linked-day read should use, and the URL that follows from it.
 *
 * Pure and exported so the decision can be tested without a renderer: the
 * whole finding this answers was a doc comment claiming the edit dialog passed
 * the entry's zone while the code always sent the browser's, and a claim like
 * that is only worth as much as the assertion under it.
 *
 * A stored zone wins. Absent — a legacy row with `tz IS NULL`, or an entry
 * that does not exist yet — falls back to the browser's, which is honest about
 * being an assumption and is what the capture sheet means anyway. It does NOT
 * fall back to Europe/Berlin: the server owns that legacy rule, and sending a
 * guess would override the one place it is written down.
 */
export function linkedDayRequest(
  day: string,
  storedTimezone: string | null | undefined,
  browserTz: string,
): { tz: string; url: string } {
  const tz =
    storedTimezone && storedTimezone.length > 0 ? storedTimezone : browserTz;
  return {
    tz,
    url: `/api/mood/linked-context?date=${encodeURIComponent(day)}&tz=${encodeURIComponent(tz)}`,
  };
}

export function useLinkedDayContext(
  day: string,
  enabled = true,
  timezone?: string | null,
) {
  const { tz, url } = linkedDayRequest(day, timezone, browserTimezone());
  const query = useQuery({
    queryKey: queryKeys.moodLinkedContext(day, tz),
    queryFn: () => apiGet<LinkedDayContext>(url),
    enabled,
    // The figures come from other modules and change on their own schedule; a
    // minute of staleness is cheaper than refetching four modules every time
    // the sheet re-renders.
    staleTime: 60_000,
  });
  return query.data ?? null;
}
