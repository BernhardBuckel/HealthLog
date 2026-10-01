/**
 * v1.11.4 item J — deterministic, rule-based trend descriptor for the
 * Insights "Trends" row captions.
 *
 * Background. Each Trends-row card carries a one-line caption below its
 * mini-chart. The first choice is the AI advisor's `trendAnnotations`
 * sentence; but on a cold briefing (web-only account, pre-briefing
 * cached payload, or the advisor still generating) that annotation is
 * null and every card fell back to "Awaiting more data" — static and
 * meaningless even when the user has a full 30-day series painted right
 * above the caption.
 *
 * This module computes a FACTUAL descriptor from the same series the
 * mini-chart already renders: direction (rising / falling / stable) plus
 * the first-vs-last magnitude over the window. It is the second tier in
 * the caption precedence the renderer applies:
 *
 *   1. advisor annotation present  → show the AI sentence.
 *   2. else, descriptor computable → show this deterministic descriptor.
 *   3. else (truly too few points) → show the "not enough data yet" hint.
 *
 * Tone is hard-constrained: OBSERVATIONAL and NEUTRAL — direction +
 * magnitude only. No causal, diagnostic, or medical claim; no value
 * judgement (a rising weight and a rising step count read identically
 * here — the row is descriptive, the colour-sentiment lives elsewhere on
 * the dedicated metric pages). Mirrors the disclaimer ethos.
 *
 * Pure + deterministic so the logic is unit-testable in isolation and
 * the client component stays a thin consumer.
 */

/**
 * A single chronological observation feeding the descriptor. `value` is
 * the metric's display-scaled numeric value (the same value the chart
 * plots); ordering is by `timestamp` ascending.
 */
export interface TrendDescriptorPoint {
  timestamp: number;
  value: number;
}

export type TrendDescriptorDirection = "rising" | "falling" | "stable";

export interface TrendDescriptor {
  direction: TrendDescriptorDirection;
  /**
   * Signed first-vs-last delta over the window, in the metric's display
   * unit. Always finite. `stable` carries the (small) delta too so the
   * caller can still surface a magnitude when it wants to.
   */
  delta: number;
  /** Absolute delta, convenience for template interpolation. */
  magnitude: number;
  /** Number of points the descriptor was computed from (>= 2). */
  pointCount: number;
}

/**
 * How a metric decides "stable" vs a real move, and how its delta is
 * rounded for display. The stability floor is the larger of an absolute
 * floor and a fraction of the starting value, so a metric reads "stable"
 * when the window move is within its day-to-day noise band rather than
 * flagging every wobble as a trend.
 */
export interface TrendDescriptorConfig {
  /** Absolute noise floor in the metric's unit (e.g. 2 mmHg for BP). */
  absoluteFloor: number;
  /** Relative noise floor as a fraction of |first value| (e.g. 0.02 = 2 %). */
  relativeFloor: number;
  /** Decimal places to round the displayed delta to. */
  decimals: number;
}

const DEFAULT_CONFIG: TrendDescriptorConfig = {
  absoluteFloor: 0,
  relativeFloor: 0.03,
  decimals: 1,
};

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/**
 * Compute a deterministic trend descriptor from a chronological series.
 *
 * Returns `null` when the series carries fewer than two finite points —
 * the genuine "not enough data yet" case the renderer surfaces as a
 * real empty hint. Otherwise resolves the first-vs-last delta and
 * classifies direction against the metric's stability floor.
 */
export function computeTrendDescriptor(
  points: ReadonlyArray<TrendDescriptorPoint>,
  config: Partial<TrendDescriptorConfig> = {},
): TrendDescriptor | null {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  const finite = points
    .filter((p) => Number.isFinite(p.value) && Number.isFinite(p.timestamp))
    .slice()
    .sort((a, b) => a.timestamp - b.timestamp);

  if (finite.length < 2) return null;

  const first = finite[0].value;
  const last = finite[finite.length - 1].value;
  const delta = roundTo(last - first, cfg.decimals);

  // Stability floor: the larger of the absolute floor and a fraction of
  // the starting magnitude. A move inside the floor reads as "stable".
  const floor = Math.max(
    cfg.absoluteFloor,
    Math.abs(first) * cfg.relativeFloor,
  );

  let direction: TrendDescriptorDirection;
  if (Math.abs(last - first) <= floor) {
    direction = "stable";
  } else {
    direction = last > first ? "rising" : "falling";
  }

  return {
    direction,
    delta,
    magnitude: Math.abs(delta),
    pointCount: finite.length,
  };
}

/**
 * Per-Trends-row-slot descriptor configuration + the display unit the
 * caption interpolates. Keyed by `TrendChartConfig.metric` (the stable
 * slot id), so a slot the row can chart always resolves a config here.
 *
 * `mood` is intentionally ABSENT: mood rides a categorical 1–5 scale, so
 * its descriptor is phrased in plain "improved / declined / stable"
 * terms (no raw unit), handled by {@link MOOD_DESCRIPTOR_CONFIG} +
 * dedicated copy rather than the numeric `{delta} {unit}` template.
 */
export interface TrendSlotDescriptorMeta {
  /**
   * Display unit interpolated into the numeric descriptor template, for a
   * metric no preference changes.
   */
  unit?: string;
  /**
   * For a metric whose unit follows the reader's preference: the
   * measurement type the caller resolves the unit of (and converts the
   * series and the noise floor through) before describing it. Such a slot
   * declares its `absoluteFloor` in the CANONICAL unit (kg, m, °C).
   */
  unitType?: string;
  config: TrendDescriptorConfig;
}

export const TREND_SLOT_DESCRIPTOR_META: Record<
  string,
  TrendSlotDescriptorMeta
> = {
  bp: {
    unit: "mmHg",
    config: { absoluteFloor: 2, relativeFloor: 0.02, decimals: 0 },
  },
  weight: {
    unitType: "WEIGHT",
    config: { absoluteFloor: 0.3, relativeFloor: 0.01, decimals: 1 },
  },
  pulse: {
    unit: "bpm",
    config: { absoluteFloor: 2, relativeFloor: 0.03, decimals: 0 },
  },
  sleep: {
    unit: "h",
    config: { absoluteFloor: 0.3, relativeFloor: 0.05, decimals: 1 },
  },
  steps: {
    unit: "",
    config: { absoluteFloor: 300, relativeFloor: 0.05, decimals: 0 },
  },
  hrv: {
    unit: "ms",
    config: { absoluteFloor: 3, relativeFloor: 0.05, decimals: 0 },
  },
  resting_hr: {
    unit: "bpm",
    config: { absoluteFloor: 2, relativeFloor: 0.03, decimals: 0 },
  },
  active_energy: {
    unit: "kcal",
    config: { absoluteFloor: 50, relativeFloor: 0.05, decimals: 0 },
  },
  flights: {
    unit: "",
    config: { absoluteFloor: 1, relativeFloor: 0.1, decimals: 0 },
  },
  distance: {
    unitType: "WALKING_RUNNING_DISTANCE",
    // 300 m — canonical metres, converted to the reader's km or mi.
    config: { absoluteFloor: 300, relativeFloor: 0.05, decimals: 1 },
  },
  vo2_max: {
    unit: "",
    config: { absoluteFloor: 0.5, relativeFloor: 0.02, decimals: 1 },
  },
  body_temp: {
    unitType: "BODY_TEMPERATURE",
    config: { absoluteFloor: 0.2, relativeFloor: 0.005, decimals: 1 },
  },
};

/**
 * Mood descriptor config. Mood is a 1–5 categorical score; a window move
 * of ≥ 0.3 points reads as a real shift in plain terms.
 */
export const MOOD_DESCRIPTOR_CONFIG: TrendDescriptorConfig = {
  absoluteFloor: 0.3,
  relativeFloor: 0,
  decimals: 1,
};

/**
 * The i18n template key + interpolation params for a resolved numeric
 * descriptor. The renderer calls `t(key, params)` to produce the
 * caption sentence. The metric name itself is NOT interpolated — the
 * chart title above the caption already names the metric, so the
 * sentence stays "Rising over 30 days (+8 mmHg)" rather than repeating
 * the label.
 */
export interface TrendDescriptorCopy {
  key: string;
  params: Record<string, string | number>;
}

/**
 * Resolve the copy for a NUMERIC metric slot. Returns `null` when the
 * slot has no numeric descriptor meta (e.g. `mood`, which uses
 * {@link moodDescriptorCopy} instead) — the caller then falls through to
 * its own path.
 */
export function numericDescriptorCopy(
  metric: string,
  descriptor: TrendDescriptor,
  /** Resolves a `unitType` slot's unit under the reader's preference. */
  unitFor: (type: string) => string,
): TrendDescriptorCopy | null {
  const meta = TREND_SLOT_DESCRIPTOR_META[metric];
  if (!meta) return null;
  const unit = meta.unitType ? unitFor(meta.unitType) : (meta.unit ?? "");

  // Signed, formatted magnitude (e.g. "+8", "-1.4"). `stable` still
  // carries its small delta so the caption can read "stable (±0 …)" if a
  // future copy wants it; today the stable template omits the magnitude.
  const sign = descriptor.delta > 0 ? "+" : descriptor.delta < 0 ? "−" : "";
  const formatted = `${sign}${descriptor.magnitude}`;

  const directionKey: Record<TrendDescriptorDirection, string> = {
    rising: "insights.trendDescriptor.rising",
    falling: "insights.trendDescriptor.falling",
    stable: "insights.trendDescriptor.stable",
  };

  return {
    key: directionKey[descriptor.direction],
    params: {
      delta: formatted,
      // Unit carries its OWN leading space when present so the template
      // reads "({delta}{unit})" → "(+8 mmHg)" with a unit, "(+1200)"
      // without one — no dangling space inside the parens for unit-less
      // metrics (steps, flights).
      unit: unit ? ` ${unit}` : "",
    },
  };
}

/**
 * Resolve the copy for the MOOD slot. Mood reads on a 1–5 categorical
 * scale, so the descriptor is phrased as "slightly improved / declined /
 * stable" rather than a raw point delta — observational and neutral, no
 * value judgement beyond the plain direction word.
 */
export function moodDescriptorCopy(
  descriptor: TrendDescriptor,
): TrendDescriptorCopy {
  const directionKey: Record<TrendDescriptorDirection, string> = {
    rising: "insights.trendDescriptor.moodImproved",
    falling: "insights.trendDescriptor.moodDeclined",
    stable: "insights.trendDescriptor.moodStable",
  };
  return { key: directionKey[descriptor.direction], params: {} };
}
