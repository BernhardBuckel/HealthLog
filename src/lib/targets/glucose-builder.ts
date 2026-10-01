import {
  groupByGlucoseContext,
  resolveGlucoseUnit,
  type GlucoseContextBucket,
} from "@/lib/glucose";
import { resolveGlucoseTarget } from "./glucose-targets";
import { makeRangeClassifier, rollupConsistencyFromDays } from "./consistency";
import type { TargetGlucoseContextSummary } from "./glucose-read";
import type { TargetItem, TargetProfile } from "./types";

const LABEL_BY_CONTEXT: Record<GlucoseContextBucket, string> = {
  FASTING: "targets.glucoseFasting",
  POSTPRANDIAL: "targets.glucosePostprandial",
  RANDOM: "targets.glucoseRandom",
  BEDTIME: "targets.glucoseBedtime",
  UNSPECIFIED: "targets.glucoseUnspecified",
};

interface GlucoseTargetsInput {
  /**
   * One summary per stored meal context: the newest reading of the year and
   * the last thirty days per local day (`readGlucoseTargetSummaries`).
   */
  summaries: TargetGlucoseContextSummary[];
  profile: TargetProfile;
  timezone: string;
  now: Date;
}

export function buildGlucoseTargets({
  summaries,
  profile,
  timezone,
  now,
}: GlucoseTargetsInput): TargetItem[] {
  const targets: TargetItem[] = [];
  const unit = resolveGlucoseUnit(profile.glucoseUnit);

  // #943 — the untagged bucket rides the same loop. Iterating the four named
  // contexts alone left an account whose source writes no meal-time tag with
  // no glucose target at all, the same gap the dashboard tile had.
  for (const [context, contextSummaries] of groupByGlucoseContext(
    summaries,
    (summary) => summary.glucoseContext,
  )) {
    // A bucket is one stored context today; folding several keeps the newest
    // reading and adds the days up, should two ever share a bucket.
    const newest = contextSummaries.reduce((a, b) =>
      b.latestAt > a.latestAt ? b : a,
    );
    const latest = newest.latest;
    const recentByDay = new Map<string, { sum: number; count: number }>();
    let recentCount = 0;
    let recentSum = 0;
    for (const summary of contextSummaries) {
      recentCount += summary.recentCount;
      for (const [day, bucket] of summary.recentByDay) {
        const current = recentByDay.get(day) ?? { sum: 0, count: 0 };
        current.sum += bucket.sum;
        current.count += bucket.count;
        recentByDay.set(day, current);
        recentSum += bucket.sum;
      }
    }
    const average30 =
      recentCount > 0 ? Math.round((recentSum / recentCount) * 10) / 10 : null;
    const resolved = resolveGlucoseTarget({
      context,
      hasDiabetes: profile.hasDiabetes,
      profile: {
        heightCm: profile.heightCm,
        dateOfBirth: profile.dateOfBirth,
        gender: profile.gender,
      },
      overrides: profile.thresholdsJson,
    });
    const effectiveRange = resolved.range;
    const range = effectiveRange
      ? {
          min: effectiveRange.greenMin,
          max: effectiveRange.greenMax,
        }
      : null;
    let classification: TargetItem["classification"] = null;
    if (range && effectiveRange) {
      if (latest >= range.min && latest <= range.max) {
        classification = { category: "Optimal", color: "var(--success)" };
      } else if (
        latest >= effectiveRange.orangeMin &&
        latest <= effectiveRange.orangeMax
      ) {
        classification = {
          category: "Elevated",
          color: "var(--dracula-yellow)",
        };
      } else {
        classification = { category: "High", color: "var(--destructive)" };
      }
    }

    targets.push({
      type: `BLOOD_GLUCOSE_${context}`,
      label: LABEL_BY_CONTEXT[context],
      current: latest,
      average30,
      trend: null,
      unit,
      range,
      classification,
      source:
        resolved.source === "custom"
          ? "Custom"
          : resolved.source === "ADA goal (diabetes)"
            ? "ADA goal (diabetes)"
            : "ADA 2024 / DDG",
      ...rollupConsistencyFromDays({
        byDay: recentByDay,
        readingCount: recentCount,
        classify: makeRangeClassifier(
          range,
          effectiveRange
            ? {
                orangeMin: effectiveRange.orangeMin,
                orangeMax: effectiveRange.orangeMax,
              }
            : undefined,
        ),
        timezone,
        now,
      }),
    });
  }

  return targets;
}
