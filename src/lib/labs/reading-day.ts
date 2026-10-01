/**
 * The calendar day a lab reading belongs to.
 *
 * Two kinds of reading share `LabResult.takenAt`. A scanned or document
 * reading states a date only, stored at noon UTC (rows from before the noon
 * anchor sit at UTC midnight); its day is that date. A reading entered by
 * hand carries the real instant of the draw; its day is the user's day of
 * that instant. Cutting both on the UTC day, as the duplicate checks did,
 * put a morning draw east of UTC on the previous day, so a scan of the same
 * report wrote the reading a second time.
 */
import { dateOnlyKey, dayKeyAsUtcMidnight } from "@/lib/tz/date-only";
import { shiftDateKey, userDayKey } from "@/lib/tz/format";

const DAY_MS = 86_400_000;
const NOON_MS = 43_200_000;

export function labReadingDay(takenAt: Date, tz: string): string {
  const msOfDay = ((takenAt.getTime() % DAY_MS) + DAY_MS) % DAY_MS;
  if (msOfDay === 0 || msOfDay === NOON_MS) return dateOnlyKey(takenAt);
  return userDayKey(takenAt, tz);
}

/**
 * A `takenAt` range wide enough to hold every reading whose
 * {@link labReadingDay} is `day`, in any zone from UTC-12 to UTC+14. It
 * over-selects by design; filter the rows with `labReadingDay` afterwards.
 */
export function labReadingDaySearchRange(day: string): {
  gte: Date;
  lt: Date;
} {
  return {
    gte: dayKeyAsUtcMidnight(shiftDateKey(day, -1)),
    lt: dayKeyAsUtcMidnight(shiftDateKey(day, 2)),
  };
}
