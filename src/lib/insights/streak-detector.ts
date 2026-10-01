/**
 * v1.21.2 (A6) — per-metric in/out-of-band streak + return-to-baseline event.
 *
 * A PURE detector over a DAY-bucket per-day-mean series. It answers two
 * questions the "ambient Coach presence" surface needs to close a worry:
 *
 *   1. How many consecutive days has this metric sat INSIDE (or OUTSIDE) its
 *      personal range, counting back from the most recent day? A streak is
 *      strictly consecutive: a calendar GAP day (a day with no reading)
 *      BREAKS it — we never paper over a missing day as "still inside".
 *   2. Did the metric just RETURN to its personal range after a run outside
 *      it? "Back inside your usual range after last week's dip — whatever that
 *      was, it's passed." A return only fires when a prior OUT-of-band run of
 *      at least `MIN_OUT_RUN` days is followed by an IN-band run of at least
 *      `MIN_IN_RUN` days ending on the latest day. Without a genuine prior
 *      out-of-band run there is nothing to "return" from.
 *
 * The band is the user's OWN personal range: median ± k·MAD (Hampel/Leys),
 * built by `buildBaselineBand` from the SAME series — never an invented
 * clinical threshold. The band is established over the WHOLE series so a
 * single recent dip doesn't move the goalposts; callers that want a stricter
 * "prior period establishes the band" split can pass a pre-built band.
 *
 * Inherent-low conservatism: when the series is too short to establish a band
 * (or the caller passes none and `buildBaselineBand` returns null), the
 * detector returns a quiet `null`-streak result and fires NO return event —
 * it omits rather than guesses.
 *
 * Pure: no DB, no clock, no network. Fully unit-testable over injected series.
 */
import type { MeasurementType } from "@/generated/prisma/client";
import { buildBaselineBand } from "@/lib/insights/derived/baseline";
import { daysBetweenDateKeys } from "@/lib/tz/format";

/** One DAY-bucket point: a calendar day key (YYYY-MM-DD) + that day's mean. */
export interface StreakPoint {
  /** Calendar day key in the user's timezone (YYYY-MM-DD). */
  day: string;
  /** The day's mean value. */
  value: number;
}

/** A personal range: the median ± k·MAD band a value sits inside or outside. */
export interface StreakBand {
  low: number;
  high: number;
}

/** Where a single day's value sits relative to the personal band. */
export type BandPlacement = "in" | "above" | "below";

/**
 * Minimum consecutive out-of-band days that count as a genuine "run" the user
 * could have worried about — a one-day blip is not a run to return from.
 */
export const MIN_OUT_RUN = 2;
/** Minimum consecutive in-band days that count as a settled "return". */
export const MIN_IN_RUN = 2;

/** The detector's result: the current streak + an optional return event. */
export interface StreakResult {
  /**
   * The most-recent day's placement relative to the band, or null when no
   * band could be established (too little history).
   */
  latestPlacement: BandPlacement | null;
  /**
   * Consecutive days (counting back from the latest day) the metric held the
   * SAME in/out state. A calendar gap breaks the count. 0 when no band.
   */
  streakDays: number;
  /** True when the current streak is an INSIDE-the-band run. */
  inBand: boolean;
  /**
   * The return-to-baseline event, present only when a prior out-of-band run of
   * ≥ MIN_OUT_RUN days is followed by an in-band run of ≥ MIN_IN_RUN days
   * ending on the latest day. Absent (undefined) otherwise — silence is the
   * default.
   */
  returnEvent?: {
    /** Days the metric has now sat back inside its range (the in-band run). */
    daysInside: number;
    /** Days the prior out-of-band run lasted (the dip it returned from). */
    priorDaysOutside: number;
    /** Which side the prior run sat on. */
    priorDirection: Exclude<BandPlacement, "in">;
  };
}

/** Classify one value against the personal band. */
function placeValue(value: number, band: StreakBand): BandPlacement {
  if (value > band.high) return "above";
  if (value < band.low) return "below";
  return "in";
}

/**
 * Detect the current in/out-of-band streak and any return-to-baseline event
 * from a DAY-bucket series.
 *
 * `series` need not be sorted; it is sorted ascending by day internally.
 * Duplicate day keys are not expected (the caller passes per-day means) but a
 * later entry for the same day wins, defensively.
 *
 * `band` may be supplied (e.g. a prior-period band) — when omitted it is built
 * from the whole series via `buildBaselineBand`. A gap day (a calendar day with
 * no point between two present days) BREAKS any streak that would span it.
 *
 * `metricType` names the metric the series belongs to so a self-built band
 * floors at zero on a metric that cannot go negative. Omit it only when the
 * series genuinely has no metric identity, or when the caller supplies `band`.
 */
export function detectStreak(
  series: StreakPoint[],
  band?: StreakBand | null,
  metricType?: string | null,
): StreakResult {
  const empty: StreakResult = {
    latestPlacement: null,
    streakDays: 0,
    inBand: false,
  };

  // De-dupe by day (last wins) and sort ascending so "consecutive" is by date.
  const byDay = new Map<string, number>();
  for (const p of series) {
    if (!Number.isFinite(p.value)) continue;
    byDay.set(p.day, p.value);
  }
  const points = [...byDay.entries()]
    .map(([day, value]) => ({ day, value }))
    .sort((a, b) => (a.day < b.day ? -1 : 1));
  if (points.length === 0) return empty;

  // Resolve the personal band: caller-supplied, else median ± k·MAD over the
  // whole series. Null (too little history) → omit rather than guess.
  const resolvedBand =
    band ??
    buildBandFromSeries(
      points.map((p) => p.value),
      metricType,
    );
  if (!resolvedBand) return empty;

  // Per-day placement, ascending. A gap day inserts an explicit break marker so
  // the streak walk below cannot bridge a missing calendar day.
  const placements: BandPlacement[] = points.map((p) =>
    placeValue(p.value, resolvedBand),
  );
  const days = points.map((p) => p.day);

  // ── current streak: walk back from the latest day, same state, no gap ──
  const latestPlacement = placements[placements.length - 1];
  const latestInBand = latestPlacement === "in";
  let streakDays = 1;
  for (let i = placements.length - 2; i >= 0; i--) {
    if (dayGap(days[i], days[i + 1]) !== 1) break; // calendar gap breaks it
    const sameState =
      (placements[i] === "in") === latestInBand &&
      // For an out-of-band streak, require the SAME side (above vs below); a
      // flip from above to below is a different run, not one streak.
      (latestInBand || placements[i] === latestPlacement);
    if (!sameState) break;
    streakDays += 1;
  }

  const result: StreakResult = {
    latestPlacement,
    streakDays,
    inBand: latestInBand,
  };

  // ── return-to-baseline event ──
  // Only when the metric is currently IN-band with a settled in-band run, and
  // the days IMMEDIATELY before that run (no gap) were a genuine out-of-band
  // run of ≥ MIN_OUT_RUN days on one side.
  if (latestInBand && streakDays >= MIN_IN_RUN) {
    const inRunStart = placements.length - streakDays; // index of the in-run's first day
    // The out-of-band run must be calendar-adjacent to the in-band run.
    if (
      inRunStart > 0 &&
      dayGap(days[inRunStart - 1], days[inRunStart]) === 1 &&
      placements[inRunStart - 1] !== "in"
    ) {
      const priorDirection = placements[inRunStart - 1] as Exclude<
        BandPlacement,
        "in"
      >;
      let priorDaysOutside = 1;
      for (let i = inRunStart - 2; i >= 0; i--) {
        if (dayGap(days[i], days[i + 1]) !== 1) break;
        if (placements[i] !== priorDirection) break;
        priorDaysOutside += 1;
      }
      if (priorDaysOutside >= MIN_OUT_RUN) {
        result.returnEvent = {
          daysInside: streakDays,
          priorDaysOutside,
          priorDirection,
        };
      }
    }
  }

  return result;
}

/** Build the personal band from a value series; null when too little data. */
function buildBandFromSeries(
  values: number[],
  metricType: string | null | undefined,
): StreakBand | null {
  const band = buildBaselineBand(
    values,
    (metricType ?? null) as MeasurementType | null,
  );
  if (!band) return null;
  if (!Number.isFinite(band.low) || !Number.isFinite(band.high)) return null;
  return { low: band.low, high: band.high };
}

/** Whole-day gap between two YYYY-MM-DD keys (>=1; 1 = adjacent). */
function dayGap(earlier: string, later: string): number {
  const gap = daysBetweenDateKeys(earlier, later);
  return Number.isNaN(gap) ? Number.POSITIVE_INFINITY : gap;
}
