/**
 * v1.15.12 A2 — resting-pulse estimation.
 *
 * Apple Health maps two distinct signals onto two distinct measurement
 * types:
 *   - `HKQuantityTypeIdentifierHeartRate`        → `PULSE`   (every HR
 *     sample, including workout / activity HR — intentionally high)
 *   - `HKQuantityTypeIdentifierRestingHeartRate` → `RESTING_HEART_RATE`
 *     (one clean daily resting figure)
 *
 * Up to v1.15.11 every surface that applied a RESTING pulse target (the
 * "Resting pulse" tile + its consistency strip, the pulse in-target %,
 * the dashboard resting classification) scored the raw `PULSE` series
 * against a resting band. For an Apple-Health user a single workout
 * emits ~500 high samples, so the resting-target evaluation read ~32 %
 * "over target" even though the user's clean `RESTING_HEART_RATE`
 * averages a healthy ~72 bpm. That is wrong: workout HR is expected-high,
 * not a resting excursion.
 *
 * The fix: judge a RESTING band against a RESTING series.
 *
 *   1. **Prefer `RESTING_HEART_RATE`** on every day that has one (Apple
 *      already separated the clean signal for us).
 *   2. **Fallback proxy from `PULSE`** on the days that have no
 *      `RESTING_HEART_RATE` (manual-only users, older imports, and the
 *      recent days of an account whose derived rows only reach as far
 *      as the retention fold has run): take a robust
 *      low-percentile of each calendar day's PULSE samples — the resting
 *      heart rate is the floor of the day, not its average, so the daily
 *      20th percentile estimates resting while excluding the workout
 *      burst that sits in the upper tail. A single high-density workout
 *      cannot drag the estimate up because it lives above the 20th
 *      percentile of the day.
 *
 * The raw `PULSE` series, where it is merely charted as "heart rate",
 * must NOT be judged against the resting band — callers chart it with a
 * contextual band or no resting overlay.
 *
 * Pure & deterministic — unit-tested in `__tests__/resting-pulse.test.ts`.
 */
import { percentile } from "@/lib/insights/strain-score";

/** A timestamped heart-rate sample. */
export interface PulseSample {
  measuredAt: Date;
  value: number;
}

/**
 * The percentile of each day's PULSE samples used as that day's resting
 * estimate. The 20th percentile sits comfortably in the day's low band
 * (above the rare sleeping-bradycardia outlier, below the bulk of waking
 * + workout HR), so it tracks resting HR without being pulled up by a
 * dense workout burst.
 */
export const RESTING_PROXY_DAILY_PERCENTILE = 20;

/**
 * Minimum PULSE samples a day needs before it can contribute a resting
 * proxy. A workout-only or single-sample day (n = 1) would otherwise emit
 * that one sample verbatim — a workout-level value masquerading as
 * "resting". Below this floor the day is skipped rather than poisoning the
 * proxy series with a high reading; a real resting day has many ambient
 * samples and clears it easily.
 */
export const RESTING_PROXY_MIN_DAILY_SAMPLES = 3;

/**
 * Collapse raw `PULSE` samples into a per-Berlin-day resting-proxy
 * series: one `{ measuredAt, value }` per day where `value` is the day's
 * low-percentile PULSE. The `measuredAt` anchors on the day's first
 * sample so downstream day-bucketing keys it back to the same day.
 *
 * Exported for direct testing; production callers use
 * `resolveRestingPulseSeries`.
 */
export function deriveRestingProxyFromPulse(
  pulseSamples: ReadonlyArray<PulseSample>,
  /**
   * Day-key function used to bucket samples: the user's own day
   * (`userDayKey(d, userTz)`), so the proxy buckets line up with every other
   * day bucket the user sees.
   */
  dayKeyOf: (d: Date) => string,
): PulseSample[] {
  if (pulseSamples.length === 0) return [];
  const byDay = new Map<string, { firstAt: Date; values: number[] }>();
  for (const s of pulseSamples) {
    const key = dayKeyOf(s.measuredAt);
    const bucket = byDay.get(key);
    if (bucket) {
      bucket.values.push(s.value);
      if (s.measuredAt < bucket.firstAt) bucket.firstAt = s.measuredAt;
    } else {
      byDay.set(key, { firstAt: s.measuredAt, values: [s.value] });
    }
  }
  const out: PulseSample[] = [];
  for (const { firstAt, values } of byDay.values()) {
    // Skip degenerate days: too few samples to distinguish a resting floor
    // from a lone workout reading. Emitting the verbatim value would leak a
    // workout-level number into the "resting" series.
    if (values.length < RESTING_PROXY_MIN_DAILY_SAMPLES) continue;
    out.push({
      measuredAt: firstAt,
      value: Math.round(percentile(values, RESTING_PROXY_DAILY_PERCENTILE)),
    });
  }
  out.sort((a, b) => a.measuredAt.getTime() - b.measuredAt.getTime());
  return out;
}

/**
 * Resolve the resting-pulse series a resting-target surface should
 * score. Merges PER DAY: a day that has a `RESTING_HEART_RATE` row is
 * represented by that row; a day that has none falls back to the
 * low-percentile PULSE proxy.
 *
 * v1.30.16 made the dense-intraday retention fold mint derived
 * `RESTING_HEART_RATE` rows (source `COMPUTED`) for the days it folds.
 * A proxy account therefore now carries derived rows for OLD folded
 * days and nothing but raw `PULSE` for RECENT not-yet-folded days. The
 * previous all-or-nothing shape returned the resting branch the moment
 * a single resting row existed and never consulted the proxy again, so
 * the visible series stopped dead at the fold horizon. Merging per day
 * keeps the clean signal where it exists and carries the series
 * forward across the days that only have the proxy.
 *
 * `which` reports how to LABEL the series, and it is deliberately
 * conservative: `"resting"` only when EVERY point came from a real
 * resting row, `"proxy"` as soon as one point is proxy-derived. The two
 * error directions are not symmetric — calling a partly-estimated
 * series "resting heart rate" is a false statement about the estimated
 * days, whereas calling a partly-native series "estimated from heart
 * rate" merely hedges. A labelling signal should hedge, never lie.
 */
export function resolveRestingPulseSeries(input: {
  restingSamples: ReadonlyArray<PulseSample>;
  pulseSamples: ReadonlyArray<PulseSample>;
  /** Day key for the proxy buckets: the user's own day. */
  dayKeyOf: (d: Date) => string;
}): { series: PulseSample[]; which: "resting" | "proxy" | "none" } {
  return mergeRestingWithProxy({
    restingSamples: input.restingSamples,
    proxySamples: deriveRestingProxyFromPulse(
      input.pulseSamples,
      input.dayKeyOf,
    ),
    dayKeyOf: input.dayKeyOf,
  });
}

/**
 * {@link resolveRestingPulseSeries} for a caller that already holds the
 * proxy, one point per day, as `readRestingPulseProxy` folds it in Postgres.
 * The per-day merge and the label are the same.
 */
export function mergeRestingWithProxy(input: {
  restingSamples: ReadonlyArray<PulseSample>;
  proxySamples: ReadonlyArray<PulseSample>;
  dayKeyOf: (d: Date) => string;
}): { series: PulseSample[]; which: "resting" | "proxy" | "none" } {
  const dayKeyOf = input.dayKeyOf;
  const byTime = (a: PulseSample, b: PulseSample) =>
    a.measuredAt.getTime() - b.measuredAt.getTime();

  const resting = [...input.restingSamples].sort(byTime);
  // Days already covered by a real resting row — the proxy must not
  // second-guess them.
  const restingDays = new Set(resting.map((s) => dayKeyOf(s.measuredAt)));
  const proxy = input.proxySamples.filter(
    (p) => !restingDays.has(dayKeyOf(p.measuredAt)),
  );

  if (resting.length === 0) {
    return proxy.length > 0
      ? { series: [...proxy], which: "proxy" }
      : { series: [], which: "none" };
  }
  if (proxy.length === 0) return { series: resting, which: "resting" };
  return { series: [...resting, ...proxy].sort(byTime), which: "proxy" };
}
