/**
 * v1.17.1 — server-authoritative next-due computation for Vorsorge
 * (measurement) reminders.
 *
 * Reuses the canonical medication recurrence engine
 * (`src/lib/medications/scheduling/recurrence.ts`) so a Vorsorge cadence
 * is driven by exactly the same code that powers the medication
 * "nextDueAt" line — web ↔ iOS read identical numbers (server-authoritative
 * per project memory: iOS consumes the resolved DTO, never recomputes).
 *
 * A `MeasurementReminder` maps onto the engine's `CanonicalSchedule` +
 * `RecurrenceContext` as follows:
 *
 *   - rolling `intervalDays`  → `rollingIntervalDays`, anchored on
 *     `lastSatisfiedAt ?? anchorDate ?? createdAt`. With no satisfy yet
 *     the first due is AT the anchor (not anchor + N); once satisfied the
 *     `+ N` cadence begins, exactly like a rolling medication's
 *     last-intake anchor.
 *   - `rrule`                 → passed straight through (RFC-5545).
 *   - the single `notifyHour` → the schedule's one `timesOfDay` entry, so
 *     the slot fires at the user's chosen local hour (DST-safe — the
 *     engine applies the time in the user's IANA timezone).
 *
 * Pure: no DB access. The caller fetches the reminder row + the user's
 * timezone and threads them in.
 */
import {
  type CanonicalSchedule,
  type RecurrenceContext,
  nextOccurrenceAfter,
} from "@/lib/medications/scheduling/recurrence";
import { wallClockInTz } from "@/lib/tz/wall-clock";
import { DEFAULT_TIMEZONE } from "@/lib/tz/format";
import { startOfLocalDayKey } from "@/lib/tz/local-day";

/**
 * The reminder fields this module reads. A subset of the Prisma row so
 * tests can construct it without the full model.
 */
export interface ReminderScheduleInput {
  intervalDays: number | null;
  rrule: string | null;
  anchorDate: Date | null;
  notifyHour: number;
  lastSatisfiedAt: Date | null;
  createdAt: Date;
  /**
   * v1.18.1 (Workstream C) — optional course-window end. NULL ⇒ open-ended
   * (the existing behaviour). Non-NULL bounds a finite cadence: the
   * recurrence engine stops producing occurrences past this instant, so a
   * Coach-suggested time-boxed protocol (ESH/AHA 7-day BP) self-expires.
   */
  endsOn?: Date | null;
}

/**
 * A first-due date from a request: a calendar date (`YYYY-MM-DD`) is that
 * day in the user's zone, stored as its local midnight; a date-time is the
 * instant it names. A date sent as UTC midnight would read as the evening
 * before west of UTC, which is why a bare date is accepted at all.
 */
export function parseReminderAnchor(value: string, timeZone: string): Date {
  return /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? startOfLocalDayKey(value, timeZone || DEFAULT_TIMEZONE)
    : new Date(value);
}

/** The calendar day `instant` falls on in `tz`, as UTC midnight of that date. */
function calendarDayInZone(instant: Date, tz: string): Date {
  const p = wallClockInTz(instant, tz);
  return new Date(Date.UTC(p.year, p.month - 1, p.day));
}

function hourToHhmm(hour: number): string {
  const safe = Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : 9;
  return `${safe.toString().padStart(2, "0")}:00`;
}

/**
 * v1.18.1 — pull the explicit clock hours out of an RRULE `BYHOUR` part so
 * a multi-time-of-day protocol (the ESH/AHA "BP morning + evening" cadence,
 * `FREQ=DAILY;BYHOUR=7,19`) fires once PER hour, not once a day.
 *
 * The recurrence engine expands `timesOfDay` on each occurrence day. The
 * RRULE day-anchor walk on its own lands one slot per day; without lifting
 * `BYHOUR` into `timesOfDay` the engine only ever fires at the single
 * `notifyHour`, silently collapsing a twice-daily protocol to once. This
 * keeps the label, the RRULE, and the engine output aligned.
 *
 * Returns the sorted, de-duplicated, in-range (0–23) `"HH:00"` strings, or
 * `null` when the rrule carries no usable `BYHOUR` (the caller then falls
 * back to the single `notifyHour`).
 */
export function byHourTimesOfDay(rrule: string | null): string[] | null {
  if (!rrule) return null;
  const match = /(?:^|;)BYHOUR=([0-9,]+)(?:;|$)/i.exec(rrule);
  if (!match) return null;
  const hours = match[1]
    .split(",")
    .map((part) => Number(part.trim()))
    .filter((h) => Number.isInteger(h) && h >= 0 && h <= 23);
  if (hours.length === 0) return null;
  const unique = Array.from(new Set(hours)).sort((a, b) => a - b);
  return unique.map((h) => `${h.toString().padStart(2, "0")}:00`);
}

/**
 * Build the `(CanonicalSchedule, RecurrenceContext)` pair the engine
 * consumes for one Vorsorge reminder.
 *
 * The rolling anchor is threaded through the engine's `lastIntakeAt`
 * (after a satisfy) and `medication.startsOn` (the first-due anchor when
 * never satisfied) so the rolling path's "first dose AT the anchor, then
 * + N after the first satisfy" semantics apply verbatim.
 */
export function buildReminderRecurrence(
  reminder: ReminderScheduleInput,
  timeZone: string,
): { schedule: CanonicalSchedule; ctx: RecurrenceContext } {
  const hhmm = hourToHhmm(reminder.notifyHour);
  // v1.18.1 — when the RRULE pins explicit BYHOUR clock hours (e.g. the
  // twice-daily BP protocol `FREQ=DAILY;BYHOUR=7,19`), expand them into the
  // engine's per-day timesOfDay so every hour fires; otherwise the cadence
  // rides the single notifyHour. Aligns label + RRULE + engine output.
  const timesOfDay = byHourTimesOfDay(reminder.rrule) ?? [hhmm];

  const schedule: CanonicalSchedule = {
    id: "measurement-reminder",
    rrule: reminder.rrule,
    rollingIntervalDays: reminder.intervalDays,
    timesOfDay,
    daysOfWeek: null,
    windowStart: hhmm,
    windowEnd: hhmm,
    reminderGraceMinutes: null,
    scheduleType: "SCHEDULED",
    cyclicOnWeeks: null,
    cyclicOffWeeks: null,
  };

  // First-due anchor when never satisfied: anchorDate ?? createdAt. After
  // a satisfy the rolling path re-anchors on `lastIntakeAt + N`, so we
  // feed `lastSatisfiedAt` through `lastIntakeAt`.
  //
  // The engine's `startsOn` / `endsOn` are calendar dates (the medication
  // columns are `@db.Date`, UTC midnight of the date). A reminder's
  // `anchorDate` / `endsOn` are instants instead (the form sends local
  // midnight, a Coach course sends `now + days`), so hand the engine the
  // calendar day each instant falls on in the user's zone.
  const tz = timeZone || DEFAULT_TIMEZONE;
  const startsOn = calendarDayInZone(
    reminder.anchorDate ?? reminder.createdAt,
    tz,
  );
  const endsOn = reminder.endsOn
    ? calendarDayInZone(reminder.endsOn, tz)
    : null;

  const ctx: RecurrenceContext = {
    medication: {
      id: "measurement-reminder",
      startsOn,
      endsOn,
      oneShot: false,
      createdAt: reminder.createdAt,
    },
    timeZone: tz,
    // No `rollingAnchor`: the anchor date is not a course start, so the last
    // satisfaction always anchors the next due, however long ago it was.
    lastIntakeAt: reminder.lastSatisfiedAt,
  };

  return { schedule, ctx };
}

/**
 * Compute the canonical next-due instant for a reminder, strictly after
 * `after`. Returns `null` when the cadence is uncomputable (no interval +
 * no rrule) or the engine finds no future occurrence.
 *
 * `after` defaults to `now` but the caller can floor it (e.g. to the last
 * satisfy instant) so a freshly-satisfied reminder advances past the
 * current due cycle.
 */
export function computeReminderNextDueAt(
  reminder: ReminderScheduleInput,
  timeZone: string,
  after: Date,
): Date | null {
  if (reminder.intervalDays === null && reminder.rrule === null) {
    return null;
  }
  const { schedule, ctx } = buildReminderRecurrence(reminder, timeZone);
  const occurrence = nextOccurrenceAfter(schedule, after, ctx);
  return occurrence?.at ?? null;
}
