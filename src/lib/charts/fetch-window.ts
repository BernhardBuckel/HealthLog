/**
 * The date window a chart asks the server for when it shows "the last N days".
 *
 * Such a window means "up to now", and "now" keeps moving after the chart
 * mounts. A window that ended at the mount instant froze there: the query key
 * kept it, an invalidation after a new reading refetched the same old window,
 * and a reading saved a minute later fell outside it until the person switched
 * the range tab and back. The window now ends at the end of the current day in
 * the profile time zone. That bound includes every reading saved today, stays
 * the same for the whole day so the cache key does not churn on every render,
 * and moves on by itself once the day changes. The server's own rules about
 * readings in the future are untouched: this only says how far a read looks.
 */
import { DEFAULT_TIMEZONE, isValidTimezone, userDayKey } from "@/lib/tz/format";
import { localDayWindow } from "@/lib/tz/local-day";

const MS_PER_DAY = 86_400_000;

function safeZone(timezone: string): string {
  return isValidTimezone(timezone) ? timezone : DEFAULT_TIMEZONE;
}

/** The local day (`YYYY-MM-DD`) `now` falls on in `timezone`. */
export function localDayKeyFor(now: Date, timezone: string): string {
  return userDayKey(now, safeZone(timezone));
}

/** Last millisecond of the local day `dayKey` in `timezone`, as a UTC instant. */
function endOfDayKeyUtc(dayKey: string, timezone: string): Date {
  const { dayEnd } = localDayWindow(dayKey, safeZone(timezone));
  return new Date(dayEnd.getTime() - 1);
}

/** Last millisecond of the local day `now` falls on in `timezone`. */
export function endOfLocalDayUtc(now: Date, timezone: string): Date {
  return endOfDayKeyUtc(localDayKeyFor(now, timezone), timezone);
}

export interface ChartFetchWindow {
  from: string;
  to: string;
  windowDays: number;
}

/**
 * A window of `days` days that ends with the local day `todayKey` (from
 * `localDayKeyFor(now, timezone)`). Keyed on the day, not the instant, so
 * every call on the same local day returns the identical window.
 */
export function openEndedFetchWindow(
  days: number,
  todayKey: string,
  timezone: string,
): ChartFetchWindow {
  const to = endOfDayKeyUtc(todayKey, timezone);
  const from = new Date(to.getTime() - days * MS_PER_DAY);
  return { from: from.toISOString(), to: to.toISOString(), windowDays: days };
}
