/**
 * v1.18.6 — Coach reference-range grounding (W7).
 *
 * Turns the population reference bands W5 landed in
 * `src/lib/reference-ranges.ts` into a compact, citation-aware text block
 * the Coach prompt can read so a reply is GROUNDED in published guidance
 * rather than the model's parametric memory of "what's normal". For each
 * metric the snapshot actually carries, the block states:
 *   - the metric's headline reference band(s), cited to the publishing
 *     body + year (via `referenceLabel` → `medical-citations`), and
 *   - where the user's current value sits against those bands, using the
 *     SAME deterministic `classifyReference()` four-state contract the UI
 *     tiles use — never a recomputed placement.
 *
 * GUARDRAILS (firm — a hallucination-QA pass audits this exact text):
 *   - GENERAL guidance only. The block opens AND closes with a caveat that
 *     these are population anchors, not personal medical advice or a
 *     diagnosis. The Coach safety discipline (refusal rules, dose-deferral)
 *     is unchanged — this is read-only context, never an instruction.
 *   - NO commercial brand names. Every string is sourced from
 *     `reference-ranges.ts` (brand-free by construction) + the metric's
 *     natural-language label here. The unit test asserts the rendered
 *     block contains no brand token.
 *   - Blood pressure is labelled to ESH 2023 (the SHIPPED European
 *     default); the ACC/AHA + ESC framings ride only as `conflicts`
 *     CONTEXT, exactly as the band data authored them — never as the
 *     placement.
 *   - GLUCOSE respects the W6 `hasDiabetes` opt-in. When the user has NOT
 *     opted in, glucose is grounded against the GENERAL non-diabetic
 *     fasting bands. When they HAVE, the block states the tighter ADA
 *     glycemic GOAL band (fasting 80–130 mg/dL) as a clinician-set target,
 *     never a screening threshold and never a diagnosis.
 *
 * Deterministic + pure: same inputs → byte-identical block, no DB, no LLM,
 * no per-call randomness. The block is surfaced verbatim in the Coach
 * user-prompt after the SNAPSHOT so it is fully inspectable.
 *
 * Token budget: the block is bounded by the number of metrics present
 * (one short line each) and a hard `MAX_GROUNDING_METRICS` cap, so even a
 * 15-metric snapshot stays a few hundred tokens.
 */
import {
  classifyReference,
  getReferenceRange,
  normalBandIndex,
  referenceLabel,
  type ReferenceMetric,
  type ReferencePlacement,
} from "@/lib/reference-ranges";
import {
  applyDisplayTransform,
  DEFAULT_UNIT_PREFERENCES,
  getReadingTransform,
  type UnitPreferences,
} from "@/lib/measurements/display-transform";

/**
 * One metric the snapshot carries, paired with the user's current
 * representative value in the metric's reference unit. The caller
 * (`snapshot.ts`) resolves the value from the same aggregates it already
 * built, so the grounding reads the SAME number the rest of the snapshot
 * does.
 */
export interface GroundingMetricInput {
  readonly metric: ReferenceMetric;
  /**
   * Current representative value in the metric's reference unit (e.g. the
   * 30-day mean systolic in mmHg, the fasting-glucose mean in mg/dL). Null
   * when the snapshot has the metric block but no usable scalar — the line
   * still cites the band, with an `insufficient` placement.
   */
  readonly value: number | null;
}

export interface ReferenceGroundingInput {
  readonly metrics: readonly GroundingMetricInput[];
  /**
   * The user's explicit, declared diabetes opt-in (`User.hasDiabetes`,
   * resolved by the W6 path). Selects the tighter ADA glucose GOAL band
   * for the glucose line ONLY. Never inferred from a reading.
   */
  readonly hasDiabetes: boolean;
  /**
   * The reader's two unit choices. The band text is printed in them, so the
   * line sits beside the glucose block (already in the reader's glucose unit)
   * without handing the model a second unit for the same quantity. The
   * placement is still classified on the canonical value. Defaults to metric
   * and mg/dL.
   */
  readonly units?: UnitPreferences;
}

/**
 * The reference metrics whose band is a stored measurement read in a
 * preference-dependent unit, keyed to that measurement type. Every other
 * band (mmHg, bpm, %, h, kg/m²) reads the same for everyone.
 */
const UNIT_SENSITIVE_REFERENCE_TYPE: Partial<Record<ReferenceMetric, string>> =
  {
    BLOOD_GLUCOSE: "BLOOD_GLUCOSE",
    BODY_TEMPERATURE: "BODY_TEMPERATURE",
  };

/** A canonical band edge and the unit symbol, in the reader's units. */
function bandEdges(
  metric: ReferenceMetric,
  units: UnitPreferences,
): { edge: (value: number) => number; unit: string } {
  const type = UNIT_SENSITIVE_REFERENCE_TYPE[metric];
  if (!type) {
    return {
      edge: (value) => value,
      unit: getReferenceRange(metric)?.unit ?? "",
    };
  }
  const transform = getReadingTransform(type, units);
  return {
    edge: (value) => applyDisplayTransform(value, transform),
    unit: transform.displayUnit,
  };
}

/**
 * Hard cap on grounding lines so a maxed-out cluster set cannot balloon
 * the block. Metrics beyond the cap are dropped silently (the snapshot
 * still carries their data; only the extra grounding line is shed). The
 * cap sits above the universal-metric count so a normal account is never
 * trimmed.
 */
const MAX_GROUNDING_METRICS = 14;

/**
 * Natural-language label for each grounded metric. Deliberately the
 * user-facing phrasing the Coach prompt already mandates (GROUND RULE 8 —
 * never the DB enum). No brand names by construction.
 */
const METRIC_LABEL: Record<ReferenceMetric, string> = {
  BLOOD_PRESSURE: "blood pressure (systolic)",
  PULSE_PRESSURE: "pulse pressure",
  MEAN_ARTERIAL_PRESSURE: "mean arterial pressure",
  PULSE_WAVE_VELOCITY: "pulse-wave velocity",
  RESTING_HEART_RATE: "resting heart rate",
  HEART_RATE_VARIABILITY: "heart-rate variability",
  OXYGEN_SATURATION: "oxygen saturation",
  RESPIRATORY_RATE: "respiratory rate",
  BODY_TEMPERATURE: "body temperature",
  BLOOD_GLUCOSE: "fasting glucose",
  HBA1C: "HbA1c",
  BMI: "BMI",
  STEPS: "daily steps",
  VISCERAL_FAT: "visceral-fat rating",
  SLEEP_DURATION: "sleep duration",
};

/**
 * The ADA diabetic glycemic GOAL fasting band (mg/dL), kept in lock-step
 * with `src/lib/targets/glucose-targets.ts` `DIABETIC_GOAL_BANDS.FASTING`.
 * Only used to phrase the glucose grounding line when `hasDiabetes` is set;
 * the placement still defers to the user's clinician, never to a band edge.
 */
const ADA_DIABETIC_FASTING_GOAL = { low: 80, high: 130 } as const;

/** Map a four-state placement to a short, general-guidance phrase. */
function placementPhrase(placement: ReferencePlacement): string {
  switch (placement) {
    case "within":
      return "sits inside the general reference band";
    case "slightly-outside":
      return "sits just outside the general reference band";
    case "outside":
      return "sits outside the general reference band";
    case "insufficient":
      // No scalar, or a metric with no fixed population band (e.g. HRV) —
      // the band is cited for education, the placement is left to the
      // user's own baseline.
      return "has no fixed population band — your own trend leads";
  }
}

/**
 * Render the half-open band as a compact "low–high unit" descriptor for the
 * metric's NORMAL band — resolved by the `normal` marker, NOT by index 0
 * (some metrics author an abnormal band first, e.g. BMI Underweight or
 * pulse-pressure Narrow). Open-ended bounds render with a leading/trailing
 * ≤ / ≥.
 */
function headlineBandText(
  metric: ReferenceMetric,
  units: UnitPreferences,
): string | null {
  const range = getReferenceRange(metric);
  if (!range || range.bands.length === 0) return null;
  const idx = normalBandIndex(metric);
  const band = range.bands[idx];
  const { edge, unit } = bandEdges(metric, units);
  if (band.low != null && band.high != null) {
    return `${edge(band.low)}–${edge(band.high)} ${unit}`;
  }
  if (band.high != null) return `≤${edge(band.high)} ${unit}`;
  if (band.low != null) return `≥${edge(band.low)} ${unit}`;
  return null;
}

/**
 * Build the glucose grounding line. Branches on the W6 diabetes opt-in:
 * general non-diabetic fasting band by default, the tighter ADA glycemic
 * GOAL band when the user declared diabetes. The diabetic branch frames the
 * band as a clinician-set GOAL, never a screening threshold.
 */
function glucoseLine(
  value: number | null,
  hasDiabetes: boolean,
  units: UnitPreferences,
): string {
  const label = METRIC_LABEL.BLOOD_GLUCOSE;
  if (hasDiabetes) {
    const { edge, unit } = bandEdges("BLOOD_GLUCOSE", units);
    const { low, high } = ADA_DIABETIC_FASTING_GOAL;
    // Placement against the diabetic GOAL band, framed as a target the
    // user's clinician individualises — never a diagnostic call.
    let where: string;
    if (value == null || !Number.isFinite(value)) {
      where = "no usable value this window";
    } else if (value >= low && value <= high) {
      where = "is inside the typical diabetes management goal";
    } else {
      where = "is outside the typical diabetes management goal";
    }
    return `- ${label}: a common diabetes management goal is ${edge(low)}–${edge(high)} ${unit} fasting (${referenceLabel(
      "BLOOD_GLUCOSE",
    )} — clinician-set goal, individualised, not a screening line). Yours ${where}.`;
  }
  const band = headlineBandText("BLOOD_GLUCOSE", units);
  const placement = classifyReference("BLOOD_GLUCOSE", value);
  return `- ${label}: general non-diabetic normal is ${band} (${referenceLabel(
    "BLOOD_GLUCOSE",
  )}). Yours ${placementPhrase(placement)}.`;
}

/** Build one standard (non-glucose) grounding line for a metric. */
function standardLine(
  metric: ReferenceMetric,
  value: number | null,
  units: UnitPreferences,
): string {
  const label = METRIC_LABEL[metric];
  const band = headlineBandText(metric, units);
  const placement = classifyReference(metric, value);
  const cite = referenceLabel(metric);
  // Blood pressure cites ESH 2023 by construction (the reference-range
  // headline band is sourced to ESH_2023_HYPERTENSION); the conflicts
  // (ACC/AHA, ESC) stay out of the per-line copy and live in the block
  // preamble's "guidelines disagree" note so the Coach never mislabels the
  // shipped European line.
  if (band) {
    return `- ${label}: general reference ${band} (${cite}). Yours ${placementPhrase(
      placement,
    )}.`;
  }
  // No fixed band (HRV) — cite the source, defer wholly to the baseline.
  return `- ${label}: ${placementPhrase(placement)} (${cite}).`;
}

/**
 * Build the Coach reference-grounding block, or null when no metric in the
 * input is covered by the reference backbone (so the prompt carries no
 * empty section). The returned string is plain text with a stable shape:
 * a header, a general-guidance preamble, one line per metric, and a
 * closing caveat. The route appends it verbatim after the SNAPSHOT.
 */
export function buildReferenceGroundingBlock(
  input: ReferenceGroundingInput,
): string | null {
  // De-dupe + keep input order; only metrics the backbone covers.
  const seen = new Set<ReferenceMetric>();
  const ordered: GroundingMetricInput[] = [];
  for (const m of input.metrics) {
    if (seen.has(m.metric)) continue;
    if (!getReferenceRange(m.metric)) continue;
    // STEPS is excluded from grounding for now: the caller feeds the
    // intra-day MEAN of the ACTIVITY_STEPS rows, so a day logged across
    // several rows is averaged DOWN and can be misclassified below the
    // 8,000-step floor. Grounding it on a sum-per-day aggregate is the
    // correct fix and is tracked as a follow-up; until then we drop the
    // line rather than ship a wrong placement.
    if (m.metric === "STEPS") continue;
    seen.add(m.metric);
    ordered.push(m);
    if (ordered.length >= MAX_GROUNDING_METRICS) break;
  }
  if (ordered.length === 0) return null;

  const units = input.units ?? DEFAULT_UNIT_PREFERENCES;
  const lines = ordered.map((m) =>
    m.metric === "BLOOD_GLUCOSE"
      ? glucoseLine(m.value, input.hasDiabetes, units)
      : standardLine(m.metric, m.value, units),
  );

  // The preamble + closing caveat carry the firm general-guidance framing.
  // Blood-pressure guideline disagreement is surfaced once here (context),
  // never as a per-line placement, so the Coach reads ESH 2023 as the
  // shipped line.
  const header = "REFERENCE GROUNDING (general guidance — not a diagnosis)";
  const preamble = [
    "These are published POPULATION reference bands for context only — they",
    "are not personal medical advice, not a diagnosis, and not a target set",
    "for this user. The user's own baseline always leads the read. Cite a",
    'band only to orient a reply ("the general reference range is …"); never',
    'tell the user they "have" or "don\'t have" a condition from a band.',
    "Blood pressure follows the European ESH 2023 line; US (ACC/AHA) and",
    "ESC framings differ and are context, not the call. This block does not",
    "change any safety rule above — keep deferring dose / diagnosis / drug-",
    "level questions to the user's clinician exactly as instructed.",
  ].join("\n");
  const closing =
    "Reminder: ranges are general guidance, not personal medical advice.";

  return `${header}\n${preamble}\n\n${lines.join("\n")}\n\n${closing}`;
}
