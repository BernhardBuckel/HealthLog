import { prisma } from "@/lib/db";
import {
  getWeightSystemPrompt,
  getWeightUserPrompt,
} from "@/lib/ai/prompts/weight";
import { openerArchetypeHint } from "@/lib/ai/prompts/opener-archetype";
import type { Locale } from "@/lib/i18n/config";
import {
  significantPearsonCorrelation,
  type PairedPoint,
} from "@/lib/analytics/correlations";
import { getNoKeyWeightStatusText } from "@/lib/insights/no-key-fallbacks";
import { resolveWeightTargetOverride } from "@/lib/analytics/effective-range";
import { buildWeightTargetFeature } from "@/lib/targets/weight-trend";
import {
  formatPreviousContextForPrompt,
  getPreviousInsightContext,
} from "@/lib/insights/memory";
import {
  buildAssessmentContextBlock,
  computeSteadyRun,
  pickVarietyLead,
} from "@/lib/insights/assessment-context";
import { getRelevantCorrelationsForMetric } from "@/lib/insights/metric-correlation-context";
import {
  applyPayloadBudget,
  dayOffsetToDayKey,
  type DailyBucket,
} from "@/lib/insights/bucket-series";
import {
  buildGradedSeriesFromPoints,
  buildGradedSeriesWithRollups,
  convertGradedSeries,
  degradeStatusSnapshotToBudget,
} from "@/lib/insights/graded-series";
import {
  applyDisplayTransform,
  applyDisplayTransformDelta,
  getReadingTransform,
  resolveUnitPreferences,
  transformRescales,
} from "@/lib/measurements/display-transform";
import { buildMetricSignal } from "@/lib/insights/metric-signal";
import {
  type SupportedLocale,
  normalizeLocale,
  finalizeStatusSummary,
  persistStatusInsight,
  round,
  summarizeSeries,
} from "@/lib/insights/status-shared";
import {
  computeStatusInputFingerprint,
  gateUnchangedStatusInput,
  readFreshStatusText,
  refreshUnchangedStatusInsight,
  resolveReadOnlyStatusMiss,
  statusCacheAction,
} from "@/lib/insights/status-cache";
import { hashInsightSnapshot } from "@/lib/insights/snapshot-hash";
import { returnTimeoutFallback } from "@/lib/insights/timeout-fallback";
import {
  runPreparedStatusCard,
  type PreparedStatusCard,
  type StatusCardResult,
} from "@/lib/insights/status-card-generation";
import { annotate } from "@/lib/logging/context";
import { resolveUserTimezone, userDayKey } from "@/lib/tz/resolver";
import { DEFAULT_TIMEZONE } from "@/lib/tz/format";
import { canonicalDailyTimestamp } from "@/lib/measurements/consolidation-tz";

/**
 * Cap on the embedded correlation pair arrays. The Pearson coefficient
 * is still computed over the full overlap; only the row-by-row pair
 * list the prompt carries is trimmed to its most recent entries.
 */
const CORRELATION_PAIR_CAP = 30;

/**
 * Pair two daily-bucket series on `dayOffset`. The synthesised `date`
 * field is anchored at the UTC midnight of the Berlin calendar day —
 * `dayOffsetToDayKey()` is the source of truth so DST boundaries
 * don't slip the day-key by one. Each pair also carries `dayKey`
 * directly so callers can label points without re-formatting.
 */
function pairDailyBuckets(
  seriesA: DailyBucket[],
  seriesB: DailyBucket[],
  now: Date,
  tz: string = DEFAULT_TIMEZONE,
): Array<PairedPoint & { dayKey: string }> {
  const mapB = new Map(seriesB.map((entry) => [entry.dayOffset, entry.value]));

  return seriesA
    .map((entry) => {
      const b = mapB.get(entry.dayOffset);
      if (b == null) return null;
      const dayKey = dayOffsetToDayKey(now, entry.dayOffset, tz);
      const [y, m, d] = dayKey.split("-").map(Number);
      return {
        a: entry.value,
        b,
        date: new Date(Date.UTC(y, m - 1, d)),
        dayKey,
      };
    })
    .filter(
      (entry): entry is PairedPoint & { dayKey: string } => entry !== null,
    );
}

/**
 * Public entry — unchanged signature. Prepares the card (cache-read,
 * read-only miss, snapshot build, hash gate) then, when the LLM is still
 * needed, runs ONE completion through the shared single-card path. The
 * one-call-per-metric behaviour and the timeout / no-provider fallbacks are
 * byte-for-byte the same as before the prepare split (v1.18.7 HIGH-1).
 */
export async function generateWeightStatusForUser(
  userId: string,
  options?: {
    locale?: string | null;
    force?: boolean;
    readOnly?: boolean;
  },
): Promise<{
  hasProvider: boolean;
  text: string | null;
  cached: boolean;
  updatedAt: string | null;
  preparing?: boolean;
  revalidating?: boolean;
}> {
  const prepared = await prepareWeightStatusForUser(userId, options);
  const result = await runPreparedStatusCard(prepared);
  return result as {
    hasProvider: boolean;
    text: string | null;
    cached: boolean;
    updatedAt: string | null;
    preparing?: boolean;
    revalidating?: boolean;
  };
}

/**
 * v1.18.7 (HIGH-1) — everything up to (not including) the provider call.
 * Returns a finished `served` result for every path that never needed the
 * LLM, or a `pending` descriptor the single-card path and the batch path
 * both drive. See `status-card-generation.ts` for the contract.
 */
export async function prepareWeightStatusForUser(
  userId: string,
  options?: {
    locale?: string | null;
    force?: boolean;
    /**
     * v1.8.3 — read-only mode for the navigation path. On a cache miss the
     * generator does NOT run the SQL gather + blocking LLM inline; it
     * enqueues an out-of-band generation and returns a `preparing` shape so
     * the request never awaits the provider. The worker (and the nightly
     * pre-generate cron) call with `readOnly: false` to actually generate.
     */
    readOnly?: boolean;
  },
): Promise<PreparedStatusCard> {
  const locale = normalizeLocale(options?.locale);
  const force = options?.force === true;
  const readOnly = options?.readOnly === true;
  const cacheAction = statusCacheAction("weight", locale);
  // v1.30.3 (QA F5) — resolve the user's own tz BEFORE the day-key so the
  // cache rolls over at the user's local midnight, not Berlin's. Has to
  // happen ahead of the cache read below (the earliest possible return
  // path), not just the later day-bucketing reads.
  const userTz = await resolveUserTimezone(userId);
  const todayKey = userDayKey(new Date(), userTz);

  // Serve today's real assessment when present. The shared reader
  // rejects timeout stubs, so a single stall no longer pins the
  // fallback for the day.
  const cached = await readFreshStatusText({
    userId,
    cacheAction,
    todayKey,
    force,
  });
  if (cached) {
    return {
      phase: "served",
      result: {
        hasProvider: true,
        text: cached.text,
        cached: true,
        updatedAt: cached.updatedAt,
      },
    };
  }

  // v1.8.3 — read-only navigation path: never block on the provider.
  // Enqueue generation out of band and return preparing / no-provider.
  if (readOnly) {
    const outcome = await resolveReadOnlyStatusMiss({
      userId,
      metric: "weight",
      locale,
    });
    // Unavailable for any reason serves the deterministic line and enqueues
    // nothing. `hasProvider` is provider presence only.
    if (outcome.kind === "unavailable") {
      return {
        phase: "served",
        result: {
          hasProvider: outcome.hasProvider,
          text: getNoKeyWeightStatusText(locale),
          cached: true,
          updatedAt: null,
        },
      };
    }
    // v1.8.7 — stale-while-revalidate: serve the last good assessment
    // (if any) instantly while the worker re-warms; only fall to the empty
    // preparing skeleton when none was ever produced.
    return {
      phase: "served",
      result: {
        hasProvider: true,
        text: outcome.lastGood?.text ?? null,
        cached: outcome.lastGood !== null,
        updatedAt: outcome.lastGood?.updatedAt ?? null,
        preparing: outcome.lastGood === null,
        revalidating: outcome.revalidating,
      },
    };
  }

  // v1.18.11 (P6) — input gate for this slow-moving metric. A cheap grouped
  // probe over the salient inputs (weight + BP channels + mood) fingerprints
  // what the snapshot would read. On a non-forced run with an unchanged
  // fingerprint the cached assessment is re-stamped under today's key and the
  // whole heavy build below (bounded findMany + per-series rollup reads +
  // correlation math + the provider call) is skipped. A forced run never
  // gates — but still computes the fingerprint so the persisted row carries a
  // current one for the next day's gate.
  // v1.39 (#1006) — the person's own weight target decides which way is
  // progress. Folded into the input fingerprint so editing the target flips
  // the gate even when no weight row moved.
  const userRow = await prisma.user.findUnique({
    where: { id: userId },
    select: { thresholdsJson: true, unitPreference: true },
  });
  const weightTarget = resolveWeightTargetOverride(userRow?.thresholdsJson);
  // The note is written in the reader's mass unit. Every weight figure the
  // snapshot carries is converted once, after the canonical arithmetic; the
  // correlations are scale-free and stay as computed.
  const units = resolveUnitPreferences({
    unitPreference: userRow?.unitPreference,
  });
  const mass = getReadingTransform("WEIGHT", units);
  const toMass = (kg: number) => applyDisplayTransform(kg, mass);
  const inputHash = await computeStatusInputFingerprint({
    userId,
    types: ["WEIGHT", "BLOOD_PRESSURE_SYS", "BLOOD_PRESSURE_DIA"],
    extra: {
      weightTargetMin: weightTarget?.min ?? null,
      weightTargetMax: weightTarget?.max ?? null,
      // A unit switch changes every figure the note quotes.
      unitPreference: units.system,
    },
    includeMood: true,
    // v1.18.11 (P6-tighten) — WEIGHT is an FDR discovery OUTCOME channel and
    // the prompt folds `getRelevantCorrelationsForMetric(userId, "WEIGHT")`, so
    // a relation surfacing off a behaviour channel (e.g. more daylight →
    // next-day weight) must flip the gate even when no weight row moved. Fold
    // the discovery channels + the prior-analysis anchor into the fingerprint.
    includeCorrelationChannels: true,
  });
  if (!force) {
    const unchangedInput = await gateUnchangedStatusInput({
      userId,
      cacheAction,
      todayKey,
      inputHash,
      force,
    });
    if (unchangedInput) {
      return {
        phase: "served",
        result: {
          hasProvider: true,
          text: unchangedInput.text,
          cached: true,
          updatedAt: unchangedInput.updatedAt,
        },
      };
    }
  }

  // v1.4.28 FB-D2 — cap the snapshot input. BP captures three types
  // per day so 1095 = 365 d × 3 channels. Order desc + reverse so we
  // keep the most recent year of rows.
  const measurements = await prisma.measurement
    .findMany({
      where: {
        userId,
        type: {
          in: ["WEIGHT", "BLOOD_PRESSURE_SYS", "BLOOD_PRESSURE_DIA"],
        },
        // Soft-deleted rows must never reach the prompt snapshot.
        deletedAt: null,
      },
      take: 1095,
      orderBy: { measuredAt: "desc" },
      select: {
        type: true,
        value: true,
        measuredAt: true,
      },
    })
    .then((rows) => rows.reverse());

  const now = new Date();

  // v1.2.5 (M-TZ3) — every day-bucketing pass below keys on the user's own
  // calendar day. `userTz` was already resolved above for the cache day-key.

  const weightSeries = applyPayloadBudget(
    measurements
      .filter((measurement) => measurement.type === "WEIGHT")
      .map((measurement) => ({
        measuredAt: measurement.measuredAt,
        value: measurement.value,
      })),
    { now, tz: userTz },
  );

  const sysSeries = applyPayloadBudget(
    measurements
      .filter((measurement) => measurement.type === "BLOOD_PRESSURE_SYS")
      .map((measurement) => ({
        measuredAt: measurement.measuredAt,
        value: measurement.value,
      })),
    { now, tz: userTz },
  );

  const diaSeries = applyPayloadBudget(
    measurements
      .filter((measurement) => measurement.type === "BLOOD_PRESSURE_DIA")
      .map((measurement) => ({
        measuredAt: measurement.measuredAt,
        value: measurement.value,
      })),
    { now, tz: userTz },
  );

  // Fetch mood context (optional — for enrichment only). v1.4.28
  // FB-D2 — cap at 90 entries.
  const moodEntries = await prisma.moodEntry
    .findMany({
      where: { userId },
      orderBy: { moodLoggedAt: "desc" },
      take: 90,
      select: { date: true, score: true, moodLoggedAt: true },
    })
    .then((rows) => rows.reverse());

  const moodSeries = applyPayloadBudget(
    moodEntries.map((entry) => ({
      measuredAt: entry.moodLoggedAt,
      value: entry.score,
    })),
    { now, tz: userTz },
  );
  const moodSummary = summarizeSeries(
    moodSeries.daily.map((bucket) => ({ value: bucket.value })),
  );
  const moodMean = moodSummary?.mean ?? null;

  // Compact graded series for the prompt. The `*Series.daily` buckets
  // above stay for the correlation pairing + latest-day focus; only the
  // graded shape is embedded so the full daily arrays never ship.
  //
  // Weight + the two BP context channels source their recent / weekly
  // slices from a bounded raw read and their monthly / yearly tail from
  // the MONTH / YEAR rollup tier (with a full-history in-memory fallback
  // on a cold-tier coverage miss). Mood has no rollup tier, so it stays
  // an in-memory fold.
  const [canonicalWeightGraded, sysGraded, diaGraded] = await Promise.all([
    buildGradedSeriesWithRollups(userId, "WEIGHT", now, userTz),
    buildGradedSeriesWithRollups(userId, "BLOOD_PRESSURE_SYS", now, userTz),
    buildGradedSeriesWithRollups(userId, "BLOOD_PRESSURE_DIA", now, userTz),
  ]);
  const weightGraded = transformRescales(mass)
    ? convertGradedSeries(canonicalWeightGraded, mass, mass.decimals)
    : canonicalWeightGraded;
  const moodGraded = buildGradedSeriesFromPoints(
    moodSeries.daily.map((b) => ({
      measuredAt: canonicalDailyTimestamp(
        dayOffsetToDayKey(now, b.dayOffset, userTz),
        userTz,
      ),
      value: b.value,
    })),
    now,
    userTz,
  );

  const weightVsSystolicPairs = pairDailyBuckets(
    weightSeries.daily,
    sysSeries.daily,
    now,
    userTz,
  );
  const weightVsSystolicCorrelation = significantPearsonCorrelation(
    weightVsSystolicPairs,
  );

  const pairedSystolicDiastolic = pairDailyBuckets(
    sysSeries.daily,
    diaSeries.daily,
    now,
    userTz,
  ).map((entry) => ({
    day: entry.dayKey,
    sys: entry.a,
    dia: entry.b,
    mean: round((entry.a + entry.b) / 2, 2),
  }));

  // Synthesise a daily-bucket-shaped BP-mean series so we can reuse
  // pairDailyBuckets — derive dayOffset from the offsets in sysSeries.
  const sysOffsetByDay = new Map(
    sysSeries.daily.map((bucket) => {
      const dayKey = dayOffsetToDayKey(now, bucket.dayOffset, userTz);
      return [dayKey, bucket.dayOffset];
    }),
  );
  const bpMeanDaily: DailyBucket[] = pairedSystolicDiastolic
    .map((entry) => {
      const dayOffset = sysOffsetByDay.get(entry.day);
      if (dayOffset == null) return null;
      return { dayOffset, value: entry.mean, n: 1 };
    })
    .filter((entry): entry is DailyBucket => entry !== null);

  const weightVsMeanBpPairs = pairDailyBuckets(
    weightSeries.daily,
    bpMeanDaily,
    now,
    userTz,
  );
  const weightVsMeanBpCorrelation =
    significantPearsonCorrelation(weightVsMeanBpPairs);

  // daily[0] = newest bucket (lowest dayOffset).
  const latestWeight = weightSeries.daily[0] ?? null;
  const previousWeight = weightSeries.daily[1] ?? null;
  const latestWeightDay = latestWeight
    ? dayOffsetToDayKey(now, latestWeight.dayOffset, userTz)
    : null;
  const sameDayBp = latestWeightDay
    ? (pairedSystolicDiastolic.find((entry) => entry.day === latestWeightDay) ??
      null)
    : null;

  const oldestMeasurement =
    measurements.length > 0 ? measurements[0].measuredAt : null;
  const newestMeasurement =
    measurements.length > 0
      ? measurements[measurements.length - 1].measuredAt
      : null;
  const totalSpanDays =
    oldestMeasurement && newestMeasurement
      ? Math.round(
          (newestMeasurement.getTime() - oldestMeasurement.getTime()) /
            (24 * 60 * 60 * 1000),
        )
      : 0;
  const newestMeasurementDaysAgo = newestMeasurement
    ? Math.round(
        (Date.now() - newestMeasurement.getTime()) / (24 * 60 * 60 * 1000),
      )
    : null;

  // v1.18.10 (HIGH-4) — hand the model the finished recent-vs-baseline
  // comparison + normal-swing verdict instead of asking it to derive them.
  // Weight has no universal favourable direction or population band, so
  // without a stored target the signal carries the neutral "target-band"
  // framing and no normalRange. v1.39 (#1006) — with one, the direction is
  // the person's own: below the band a rise is favourable, above it a fall.
  const recentWeights = weightSeries.daily
    .filter((bucket) => bucket.dayOffset < 7)
    .map((bucket) => bucket.value);
  const weightTargetFeature = buildWeightTargetFeature(
    weightTarget,
    {
      avg7:
        recentWeights.length > 0
          ? recentWeights.reduce((sum, value) => sum + value, 0) /
            recentWeights.length
          : null,
      latest: latestWeight?.value ?? null,
    },
    units.system,
  );
  const weightSignal = buildMetricSignal({
    metric: locale === "en" ? "your weight" : "dein Gewicht",
    unit: mass.displayUnit,
    direction:
      weightTargetFeature?.position === "below"
        ? "higher-better"
        : weightTargetFeature?.position === "above"
          ? "lower-better"
          : "target-band",
    graded: weightGraded,
    newestDaysAgo: newestMeasurementDaysAgo,
  });

  const snapshot = {
    locale,
    generatedForDay: todayKey,
    focus: "weight",
    dataCoverage: {
      totalMeasurements: measurements.length,
      totalSpanDays,
      newestMeasurementDaysAgo,
    },
    weight: {
      unit: mass.displayUnit,
      ...(weightSignal ? { signal: weightSignal } : {}),
      ...(weightTargetFeature ? { target: weightTargetFeature } : {}),
      summary: summarizeSeries(
        weightSeries.daily.map((bucket) => ({ value: toMass(bucket.value) })),
      ),
      series: weightGraded,
      latestDayFocus: latestWeight
        ? {
            day: latestWeightDay,
            dayOffset: latestWeight.dayOffset,
            value: toMass(latestWeight.value),
            deltaToPreviousDailyPoint:
              previousWeight == null
                ? null
                : applyDisplayTransformDelta(
                    round(latestWeight.value - previousWeight.value, 2),
                    mass,
                  ),
            sameDayBloodPressure: sameDayBp,
          }
        : null,
    },
    bloodPressureContext: {
      systolic: {
        summary: summarizeSeries(
          sysSeries.daily.map((bucket) => ({ value: bucket.value })),
        ),
        series: sysGraded,
      },
      diastolic: {
        summary: summarizeSeries(
          diaSeries.daily.map((bucket) => ({ value: bucket.value })),
        ),
        series: diaGraded,
      },
      // Keep the correlation coefficients (computed over the full
      // overlap) but cap the embedded pair arrays to the most recent
      // paired days — the raw pair lists were a major payload driver.
      pairedDaily: pairedSystolicDiastolic.slice(-CORRELATION_PAIR_CAP),
    },
    weightVsSystolic: {
      correlation: weightVsSystolicCorrelation,
      pairs: weightVsSystolicPairs
        .slice(-CORRELATION_PAIR_CAP)
        .map((entry) => ({
          day: entry.dayKey,
          weight: toMass(round(entry.a, 2)),
          systolic: round(entry.b, 2),
        })),
    },
    weightVsMeanBloodPressure: {
      correlation: weightVsMeanBpCorrelation,
      pairs: weightVsMeanBpPairs.slice(-CORRELATION_PAIR_CAP).map((entry) => ({
        day: entry.dayKey,
        weight: toMass(round(entry.a, 2)),
        meanBloodPressure: round(entry.b, 2),
      })),
    },
    moodContext:
      moodSeries.daily.length >= 3
        ? {
            points: moodSeries.daily.length,
            mean: moodMean,
            latest: moodSeries.daily[0]?.value ?? null,
            series: moodGraded,
            moodVsWeightCorrelation: (() => {
              const moodVsWeightPairs = pairDailyBuckets(
                moodSeries.daily,
                weightSeries.daily,
                now,
                userTz,
              );
              return significantPearsonCorrelation(moodVsWeightPairs);
            })(),
          }
        : null,
  };

  const shed = degradeStatusSnapshotToBudget(
    snapshot as unknown as Record<string, unknown>,
  );
  const snapshotJson = JSON.stringify(snapshot, null, 2);

  annotate({
    action: { name: cacheAction },
    meta: {
      payload_size_bytes: snapshotJson.length,
      ...(shed.length > 0 ? { snapshot_shed: shed } : {}),
    },
  });

  // Content-hash gate (v1.16.8): when the snapshot is unchanged since the
  // last real assessment, refresh the cache timestamp and skip the LLM.
  const snapshotHash = hashInsightSnapshot(snapshot);
  const unchanged = await refreshUnchangedStatusInsight({
    userId,
    cacheAction,
    todayKey,
    snapshotHash,
  });
  if (unchanged) {
    return {
      phase: "served",
      result: {
        hasProvider: true,
        text: unchanged.text,
        cached: true,
        updatedAt: unchanged.updatedAt,
      },
    };
  }

  const previousContext = await getPreviousInsightContext(
    userId,
    "weight-status",
    locale,
    12,
  );
  const previousContextBlock = formatPreviousContextForPrompt(
    previousContext,
    locale,
  );

  // v1.12.7 — diversity / anti-repetition block (see blood-pressure-status).
  const varietyLead = pickVarietyLead(userId, "weight", todayKey);
  const steadyRun = computeSteadyRun(
    canonicalWeightGraded.weekly,
    canonicalWeightGraded.monthly,
  );
  const relations = await getRelevantCorrelationsForMetric(
    userId,
    "WEIGHT",
    locale,
  );
  const assessmentContextBlock = buildAssessmentContextBlock(
    {
      varietyLead,
      dataStrength: {
        points: weightSeries.daily.length,
        newestDaysAgo: newestMeasurementDaysAgo,
      },
      repeatCount: steadyRun,
      relations,
    },
    locale,
  );

  // The provider call is deferred to the caller — the single-card path runs
  // ONE completion, the batch path folds this prompt into one shared call.
  // A timeout / error is a transient miss (fallback served, no assessment
  // persisted); `none` (no provider / no consent) serves the no-key text.
  return {
    phase: "pending",
    metric: "weight",
    userId,
    cacheAction,
    systemPrompt: getWeightSystemPrompt(locale, units.system),
    userPrompt: getWeightUserPrompt(
      snapshotJson,
      todayKey,
      locale,
      previousContextBlock,
      assessmentContextBlock,
      // v1.28.40 — rotating opener hint, per (user, metric, day).
      openerArchetypeHint(`${userId}:weight:${todayKey}`, locale as Locale),
    ),
    snapshotHash,
    // v1.12.7 — match the archetype cards' 0.45.
    temperature: 0.45,
    noProvider: {
      hasProvider: false,
      text: getNoKeyWeightStatusText(locale, weightSignal),
      cached: true,
      updatedAt: null,
    },
    timeout: (reason): StatusCardResult =>
      returnTimeoutFallback({
        cacheAction,
        reason,
        userId,
        todayKey,
        stubText: getNoKeyWeightStatusText(locale, weightSignal),
      }),
    finalize: async (outcome): Promise<StatusCardResult> => {
      // Outbound safety screen. The only transform here used to be
      // whitespace-normalisation, so a dose-change imperative or a fabricated
      // clinical risk score persisted as the day's cached assessment. Policy
      // for a background-generated card is WITHHOLD: serve the deterministic
      // stub and persist no model text (see `finalizeStatusSummary`).
      const screened = finalizeStatusSummary(outcome.content, locale);
      if (!screened.ok) {
        annotate({
          action: { name: "insights.status.outbound_blocked" },
          meta: { cacheAction, reason: screened.reason },
        });
        return returnTimeoutFallback({
          cacheAction,
          reason: "screened",
          userId: userId,
          todayKey: todayKey,
          stubText: getNoKeyWeightStatusText(locale, weightSignal),
        });
      }
      const summary = screened.text;
      if (!summary) {
        throw new Error("Weight-status summary was empty after normalization");
      }
      const updatedAt = await persistStatusInsight({
        userId,
        cacheAction,
        todayKey,
        text: summary,
        snapshotHash,
        // v1.18.11 (P6) — persist the input fingerprint so tomorrow's input
        // gate can skip the rebuild when nothing salient changed.
        inputHash,
      });
      return {
        hasProvider: true,
        text: summary,
        cached: false,
        updatedAt,
      };
    },
  };
}

export function resolveWeightStatusLocale(
  locale: string | null | undefined,
): SupportedLocale {
  return normalizeLocale(locale);
}
