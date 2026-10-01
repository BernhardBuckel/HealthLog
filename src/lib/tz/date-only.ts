/**
 * Date-only values: a calendar date (`YYYY-MM-DD`) with no time of day — a
 * report's stated date, a document's filing date, a backup's label for a
 * `@db.Date` column.
 *
 * Such a value is stored in a timestamp column as noon UTC. Noon keeps the
 * date on the same calendar day whether it is read back as a UTC label
 * ({@link dateOnlyKey}) or formatted in any zone from UTC-11 to UTC+11. The
 * older anchor, UTC midnight, sits on the previous evening everywhere west
 * of UTC, which is how a stated report date came to show a day early.
 *
 * Rows written at UTC midnight before the switch still read back to the same
 * key through {@link dateOnlyKey}, so the two anchors coexist without a
 * migration.
 */

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/u;

/** True for a strict `YYYY-MM-DD` string. */
export function isDateOnlyKey(value: string): boolean {
  return DATE_ONLY_RE.test(value);
}

/** The instant a date-only value is stored as: 12:00 UTC on that date. */
export function dateOnlyAtNoonUtc(key: string): Date {
  return new Date(`${key}T12:00:00.000Z`);
}

/**
 * The calendar date of a stored date-only value (or of a `@db.Date` column,
 * which Prisma hands back as UTC midnight). Only for values that ARE dates:
 * the day an instant fell on for a person is `userDayKey(instant, tz)`.
 */
export function dateOnlyKey(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/**
 * The value a `@db.Date` column holds for calendar date `key` (Prisma reads
 * and writes those columns as UTC midnight). Use it to compare such a column
 * with a day: `endsOn >= dbDate(todayKey)` keeps a course through its last
 * day, where comparing against the instant `now` dropped that day.
 */
export function dbDate(key: string): Date {
  return new Date(`${key}T00:00:00.000Z`);
}
