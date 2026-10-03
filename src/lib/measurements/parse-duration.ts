/**
 * Read a duration the way a person writes one.
 *
 * A field that asks for hours used to take only a decimal, so a night of seven
 * and a half hours had to be typed as `7.5`. People write it as `7:30`,
 * `7h30m` or `7 h 30 min`, and a minutes field gets `1h15` just as often. This
 * reads all of those, with the decimal comma, and answers in the field's own
 * unit so the caller's existing conversion to the stored unit stays the one
 * place that knows about storage.
 *
 * Accepted shapes, `H` and `M` being whole or decimal numbers:
 *
 *   - `7.5`, `7,5`           a bare number in the field's unit
 *   - `7:30`                 hours and minutes (minutes below 60)
 *   - `7h`, `7h30`, `7h30m`, `7 h 30 min`, `45m`, `45 min`
 *                            hours and/or minutes with a unit word; a number
 *                            after an hours part without a unit is minutes
 *
 * Unit words: h, hr, hrs, hour, hours, std, stunde, stunden, u (Dutch), godz
 * (Polish), 시간 for hours; m, min, mins, minute, minutes, minuten, 분 for
 * minutes. Anything else is refused rather than guessed at.
 */

export type DurationFieldUnit = "h" | "min";

export type DurationParseResult =
  | {
      ok: true;
      /** The value in the field's unit (hours or minutes). */
      value: number;
      /** The same duration in whole minutes, for display. */
      minutes: number;
    }
  | { ok: false; reason: "empty" | "invalid" | "tooLong" };

/** A single manual entry never covers more than a day. */
export const MAX_DURATION_MINUTES = 24 * 60;

const NUMBER = String.raw`(\d+(?:[.,]\d+)?)`;
const HOUR_WORD = String.raw`(?:hours?|hrs?|h|stunden?|std|godz|u|시간)`;
const MINUTE_WORD = String.raw`(?:minutes?|minuten|mins?|m|분)`;

const BARE = new RegExp(String.raw`^${NUMBER}$`);
const CLOCK = /^(\d+):(\d{1,2})$/;
const WORDS = new RegExp(
  String.raw`^(?:${NUMBER}\s*${HOUR_WORD}\.?)?\s*(?:${NUMBER}\s*(${MINUTE_WORD})?\.?)?$`,
  "iu",
);
const MINUTES_ONLY = new RegExp(
  String.raw`^${NUMBER}\s*${MINUTE_WORD}\.?$`,
  "iu",
);

function toNumber(raw: string): number {
  return Number(raw.replace(",", "."));
}

function totalMinutes(
  raw: string,
  unit: DurationFieldUnit,
): number | null | "invalid" {
  const text = raw.trim().replace(/\s+/g, " ");
  if (text === "") return null;

  const bare = BARE.exec(text);
  if (bare) {
    const n = toNumber(bare[1]!);
    return unit === "h" ? n * 60 : n;
  }

  const clock = CLOCK.exec(text);
  if (clock) {
    const minutes = Number(clock[2]);
    if (minutes >= 60) return "invalid";
    return Number(clock[1]) * 60 + minutes;
  }

  const minutesOnly = MINUTES_ONLY.exec(text);
  if (minutesOnly) return toNumber(minutesOnly[1]!);

  const words = WORDS.exec(text);
  // An hours part is required here: a lone number was handled above, and
  // "30m" by the minutes-only shape.
  if (words && words[1] !== undefined) {
    const hours = toNumber(words[1]);
    if (words[2] === undefined) return hours * 60;
    const minutes = toNumber(words[2]);
    // "7h 90" is more likely a typo than an hour and a half.
    if (minutes >= 60) return "invalid";
    return hours * 60 + minutes;
  }
  return "invalid";
}

/**
 * Parse `raw` for a field that asks in `unit`. A negative sign, an unknown
 * word or a duration longer than `maxMinutes` is refused.
 */
export function parseDurationEntry(
  raw: string,
  unit: DurationFieldUnit,
  maxMinutes: number = MAX_DURATION_MINUTES,
): DurationParseResult {
  const minutes = totalMinutes(raw, unit);
  if (minutes === null) return { ok: false, reason: "empty" };
  if (minutes === "invalid" || !Number.isFinite(minutes)) {
    return { ok: false, reason: "invalid" };
  }
  if (minutes > maxMinutes) return { ok: false, reason: "tooLong" };
  return {
    ok: true,
    value: unit === "h" ? minutes / 60 : minutes,
    minutes: Math.round(minutes),
  };
}

/** Whole hours and the minutes left over, for the "read as" hint. */
export function splitDurationMinutes(minutes: number): {
  hours: number;
  minutes: number;
} {
  const whole = Math.max(0, Math.round(minutes));
  return { hours: Math.floor(whole / 60), minutes: whole % 60 };
}
