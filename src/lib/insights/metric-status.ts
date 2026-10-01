/**
 * v1.8.7.1 — generic per-HealthKit-metric assessment generator.
 *
 * The seven specialised generators (`pulse-status.ts`, …) each hand-roll
 * a metric-specific snapshot + prompt. This one generator covers every
 * registered HealthKit metric (`metric-status-registry.ts`) through the
 * archetype prompt templates (`prompts/metric-archetypes.ts`), reusing
 * the exact same machinery the specialised cards use:
 *   - the graded-series snapshot builder (`buildGradedSeriesWithRollups`),
 *   - the shared provider runner (`runStatusCompletion`),
 *   - the stale-while-revalidate cache (`readFreshStatusText` /
 *     `resolveReadOnlyStatusMiss`),
 *   - the standard cache-row persist (`persistStatusInsight`),
 *   - the previous-context comparison block (`getPreviousInsightContext`).
 *
 * The return shape is byte-identical to the specialised generators so
 * `InsightStatusCard` consumes it unchanged.
 *
 * Empty-data guard (design §3): when the metric has no readings the
 * generator returns an `insufficient` marker WITHOUT touching the
 * provider chain — no LLM call, no cache write. The route maps that onto
 * the card's insufficient-data state.
 */
import { prisma } from "@/lib/db";
import {
  getMetricArchetypeSystemPrompt,
  getMetricArchetypeUserPrompt,
} from "@/lib/ai/prompts/metric-archetypes";
import { buildInterpretationBlock } from "@/lib/ai/prompts/interpretation-block";
import {
  getMetricStatusMeta,
  metricStatusScope,
  type MetricStatusMeta,
  type MetricStatusMetricId,
} from "@/lib/insights/metric-status-registry";
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
import { getAgeFromDateOfBirth } from "@/lib/analytics/pulse-targets";
import { lookupNormalRange } from "@/lib/insights/derived/norms";
import { buildMetricSignal } from "@/lib/insights/metric-signal";
import { PROMPT_VERSION } from "@/lib/ai/prompts/base-system";
import { AI_BUDGETS } from "@/lib/ai/ai-budgets";
import { openerArchetypeHint } from "@/lib/ai/prompts/opener-archetype";
import type { Locale } from "@/lib/i18n/config";
import {
  getNoKeyGeneralStatusText,
  getNoKeyMetricStatusText,
} from "@/lib/insights/no-key-fallbacks";
import { applyPayloadBudget } from "@/lib/insights/bucket-series";
import {
  buildGradedSeriesFromPoints,
  buildGradedSeriesWithRollups,
  convertGradedSeries,
  degradeStatusSnapshotToBudget,
  type GradedSeries,
} from "@/lib/insights/graded-series";
import {
  type SupportedLocale,
  normalizeLocale,
  finalizeStatusSummary,
  persistStatusInsight,
  summarizeSeries,
} from "@/lib/insights/status-shared";
import { runStatusCompletion } from "@/lib/insights/status-provider";
import {
  reconstructSleepNights,
  type SleepStageRow,
} from "@/lib/analytics/sleep-night";
import { loadUserSourcePriority } from "@/lib/rollups/measurement-read";
import { resolveUserTimezone, userDayKey } from "@/lib/tz/resolver";
import {
  readFreshStatusText,
  refreshUnchangedStatusInsight,
  resolveReadOnlyStatusMiss,
  statusCacheAction,
} from "@/lib/insights/status-cache";
import { hashInsightSnapshot } from "@/lib/insights/snapshot-hash";
import { returnTimeoutFallback } from "@/lib/insights/timeout-fallback";
import { annotate } from "@/lib/logging/context";
import { binaryReferenceSex } from "@/lib/profile/sex";
import {
  applyDisplayTransform,
  getReadingTransform,
  invertDisplayTransform,
  isUnitSensitiveType,
  resolveUnitPreferences,
  transformRescales,
  type DisplayTransform,
  type UnitPreferences,
} from "@/lib/measurements/display-transform";

export interface MetricStatusResult {
  hasProvider: boolean;
  text: string | null;
  cached: boolean;
  updatedAt: string | null;
  preparing?: boolean;
  /**
   * v1.9.0 — true when last-good text is served while a fresh generation is
   * in flight. The card keeps polling (bounded) so the open page upgrades to
   * the warmed assessment without a remount.
   */
  revalidating?: boolean;
  /**
   * v1.8.7.1 — true when the metric has no data at all. The route maps
   * this onto the card's insufficient-data state; no LLM was called.
   */
  insufficient?: boolean;
}

/** Count this metric's live (non-deleted) readings — the empty-data gate. */
async function countMetricReadings(
  userId: string,
  meta: MetricStatusMeta,
): Promise<number> {
  return prisma.measurement.count({
    where: { userId, type: meta.measurementType, deletedAt: null },
  });
}

/**
 * Generate (or read from cache) the generic assessment for one metric.
 * Mirrors the specialised generators' contract:
 *   - cache hit (today, non-stub) → serve it,
 *   - `readOnly` miss → enqueue out-of-band + serve last-good
 *     (stale-while-revalidate),
 *   - empty data → `insufficient`, no LLM call,
 *   - otherwise → build snapshot, run completion, persist.
 */
export async function generateMetricStatus(args: {
  metric: MetricStatusMetricId;
  userId: string;
  locale?: string | null;
  force?: boolean;
  /** Read-only navigation path — never blocks on the provider. */
  readOnly?: boolean;
}): Promise<MetricStatusResult> {
  const meta = getMetricStatusMeta(args.metric);
  if (!meta) {
    // Defensive — the route Zod-validates against the registry, so an
    // unknown id never reaches here. Treat as insufficient rather than
    // throwing so a stale caller degrades gracefully.
    return {
      hasProvider: false,
      text: null,
      cached: false,
      updatedAt: null,
      insufficient: true,
    };
  }

  const locale = normalizeLocale(args.locale);
  const force = args.force === true;
  const readOnly = args.readOnly === true;
  const scope = metricStatusScope(meta.id);
  const cacheAction = statusCacheAction(scope, locale);
  // v1.30.3 (QA F5) — resolve the user's own tz BEFORE the day-key so the
  // cache rolls over at the user's local midnight, not Berlin's. Has to
  // happen ahead of the cache read below (the earliest possible return
  // path), not just the later day-bucketing reads.
  const userTz = await resolveUserTimezone(args.userId);
  const todayKey = userDayKey(new Date(), userTz);

  const cached = await readFreshStatusText({
    userId: args.userId,
    cacheAction,
    todayKey,
    force,
  });
  if (cached) {
    return {
      hasProvider: true,
      text: cached.text,
      cached: true,
      updatedAt: cached.updatedAt,
    };
  }

  // Empty-data guard — no readings means no assessment to generate. Done
  // BEFORE the read-only enqueue so an empty metric never queues an LLM
  // job nor blocks on the provider. The nightly warm pass applies the same
  // gate so the cron never burns a call on an empty metric either.
  const readingCount = await countMetricReadings(args.userId, meta);
  if (readingCount === 0) {
    annotate({
      action: { name: "insights.metric-status.insufficient" },
      meta: { metric: meta.id },
    });
    return {
      hasProvider: true,
      text: null,
      cached: false,
      updatedAt: null,
      insufficient: true,
    };
  }

  if (readOnly) {
    const outcome = await resolveReadOnlyStatusMiss({
      userId: args.userId,
      metric: scope,
      locale,
    });
    // Unavailable for any reason serves the deterministic line and enqueues
    // nothing. `hasProvider` is provider presence only.
    if (outcome.kind === "unavailable") {
      return {
        hasProvider: outcome.hasProvider,
        text: getNoKeyGeneralStatusText(locale),
        cached: true,
        updatedAt: null,
      };
    }
    // Stale-while-revalidate: serve the last good assessment (if any)
    // instantly while the worker re-warms the cache; only fall to the
    // empty preparing skeleton when none was ever produced.
    return {
      hasProvider: true,
      text: outcome.lastGood?.text ?? null,
      cached: outcome.lastGood !== null,
      updatedAt: outcome.lastGood?.updatedAt ?? null,
      preparing: outcome.lastGood === null,
      revalidating: outcome.revalidating,
    };
  }

  const user = await prisma.user.findUnique({
    where: { id: args.userId },
    select: {
      dateOfBirth: true,
      gender: true,
      unitPreference: true,
      glucoseUnit: true,
    },
  });

  // The note is written in the reader's units. The series, the reference band
  // and the signal are converted once, here, before any of them reaches the
  // prompt or the deterministic floor; the registry entry, the rollups and
  // the guideline classification stay canonical. An untransformed metric (and
  // every metric on the default preferences that does not rescale) passes
  // through unchanged, so its snapshot hash does not move.
  const reading = readingDisplay(
    meta,
    resolveUnitPreferences({
      unitPreference: user?.unitPreference,
      glucoseUnit: user?.glucoseUnit,
    }),
  );
  const shownMeta: MetricStatusMeta = {
    ...meta,
    unit: reading.unit,
    ...(meta.normalRange
      ? {
          normalRange: {
            low: reading.toDisplay(meta.normalRange.low),
            high: reading.toDisplay(meta.normalRange.high),
          },
        }
      : {}),
  };

  const now = new Date();

  // Bounded raw read for the derived recent stats; the monthly/yearly
  // tail comes from the rollup tier (full-history fallback on a miss),
  // exactly as the specialised cards do.
  //
  // SLEEP_DURATION is the one type stored ONE ROW PER STAGE per night
  // (IN_BED / AWAKE / CORE / DEEP / REM, minutes each), so a raw per-row
  // read would feed the status prose a single ~16 min stage as the
  // "current sleep" instead of the night total. Route it through
  // `reconstructSleepNights` (the same helper the dashboard / series /
  // targets use) so every derived value here — `series`, `summary`,
  // `latest` — is a per-night TIME-ASLEEP total in minutes (the registry
  // unit + normalRange are already minutes). The night reconstruction
  // clusters stages into sessions, dedups multi-source nights via the
  // user's `sleep` priority ladder, and handles the midnight split. Gated
  // to SLEEP_DURATION only so no other metric's status path changes.
  const isSleep = meta.measurementType === "SLEEP_DURATION";

  // v1.2.5 (M-TZ3) — the day bucketing below keys on the user's own
  // calendar regardless of branch. `userTz` was already resolved above for
  // the cache day-key.

  const points: Array<{ measuredAt: Date; value: number }> = [];
  let measurements: Array<{ measuredAt: Date }> = [];
  if (isSleep) {
    const [priorityJson, sleepRows] = await Promise.all([
      loadUserSourcePriority(args.userId),
      prisma.measurement.findMany({
        where: {
          userId: args.userId,
          type: "SLEEP_DURATION",
          deletedAt: null,
        },
        orderBy: { measuredAt: "desc" },
        take: 365 * 6, // ≈ 5 stage rows/night × source-count for a year
        // Writer-level collapse: two HealthKit apps behind one source
        // (watch stages vs phone in-bed) must not blend into one night.
        select: {
          value: true,
          measuredAt: true,
          sleepStage: true,
          source: true,
          deviceType: true,
        },
      }),
    ]);
    const nights = reconstructSleepNights(
      sleepRows as SleepStageRow[],
      userTz,
      priorityJson,
    ).filter((n) => n.asleepMinutes > 0);
    for (const n of nights) {
      points.push({ measuredAt: n.measuredAt, value: n.asleepMinutes });
    }
    measurements = nights.map((n) => ({ measuredAt: n.measuredAt }));
  } else {
    const rows = await prisma.measurement
      .findMany({
        where: {
          userId: args.userId,
          type: meta.measurementType,
          deletedAt: null,
        },
        orderBy: { measuredAt: "desc" },
        take: 365,
        select: { value: true, measuredAt: true },
      })
      .then((r) => r.reverse());
    for (const m of rows) {
      points.push({
        measuredAt: m.measuredAt,
        value: reading.toDisplay(m.value),
      });
    }
    measurements = rows.map((m) => ({ measuredAt: m.measuredAt }));
  }
  const series = applyPayloadBudget(points, { now, tz: userTz });
  // SLEEP_DURATION must never go through `buildGradedSeriesWithRollups`: that
  // path reads RAW per-stage rows (and the stage-summed `measurement_rollups`
  // tier) and folds IN_BED + AWAKE + bare ASLEEP + CORE/DEEP/REM into one
  // bucket, double-counting the bare aggregate against its granular partition —
  // it produces an impossible ~20 h "average sleep". Build the graded series
  // straight from the deduped per-night TIME-ASLEEP `points` instead, so every
  // recent/weekly/monthly/yearly bucket is a night total, not a stage sum.
  const graded = isSleep
    ? buildGradedSeriesFromPoints(points, now, userTz)
    : reading.convertGraded(
        await buildGradedSeriesWithRollups(
          args.userId,
          meta.measurementType,
          now,
          userTz,
        ),
      );
  const summary = summarizeSeries(
    series.daily.map((bucket) => ({ value: bucket.value })),
  );

  const latest = series.daily[0] ?? null;

  const oldest = measurements.length > 0 ? measurements[0].measuredAt : null;
  const newest =
    measurements.length > 0
      ? measurements[measurements.length - 1].measuredAt
      : null;
  const totalSpanDays =
    oldest && newest
      ? Math.round(
          (newest.getTime() - oldest.getTime()) / (24 * 60 * 60 * 1000),
        )
      : 0;
  const newestDaysAgo = newest
    ? Math.round((Date.now() - newest.getTime()) / (24 * 60 * 60 * 1000))
    : null;

  const ageYears = getAgeFromDateOfBirth(user?.dateOfBirth ?? null);
  const sex = binaryReferenceSex(user?.gender);

  // v1.10.0 F1 — sharpen the coarse registry `normalRange` with the
  // age/sex reference-range enabler when one is available for this
  // metric + profile; otherwise keep the existing flat anchor (strictly
  // additive, never a regression). Age + sex only — no ancestry/region.
  const sharpenedRange = lookupNormalRange(meta.id, ageYears, sex);
  const canonicalRange = sharpenedRange ?? meta.normalRange;
  const normalRange = canonicalRange
    ? {
        ...canonicalRange,
        low: reading.toDisplay(canonicalRange.low),
        high: reading.toDisplay(canonicalRange.high),
      }
    : canonicalRange;

  // v1.13.x — the SIGNAL block: the recent-vs-baseline comparison + the
  // normal-swing verdict, computed server-side so the model states it rather
  // than re-deriving it from the raw buckets (research-ai-quality.md §4/§5C).
  // Built from the same graded series the snapshot already carries; null only
  // when the recent window is empty, in which case it is omitted.
  const signal = buildMetricSignal({
    metric: meta.displayName,
    unit: shownMeta.unit,
    direction: meta.direction,
    graded,
    normalRange: normalRange ?? null,
    normalRangeSource: sharpenedRange ? "age-sex-adjusted" : undefined,
    newestDaysAgo,
  });

  const snapshot = {
    locale,
    promptVersion: PROMPT_VERSION,
    generatedForDay: todayKey,
    focus: meta.id,
    metric: {
      id: meta.id,
      displayName: meta.displayName,
      unit: shownMeta.unit,
      direction: meta.direction,
      ...(normalRange ? { normalRange } : {}),
      ...(sharpenedRange ? { normalRangeSource: "age-sex-adjusted" } : {}),
    },
    // Profile context for placement only when stored — the medical note
    // limits population ranges to age + sex (NO ancestry/region). Omitted
    // when the profile leaves them blank, so the model leans on baseline.
    profile: {
      ageYears,
      sex,
    },
    dataCoverage: {
      totalMeasurements: measurements.length,
      totalSpanDays,
      newestMeasurementDaysAgo: newestDaysAgo,
    },
    [meta.id]: {
      ...(signal ? { signal } : {}),
      summary,
      series: graded,
      latestDayFocus: latest
        ? { dayOffset: latest.dayOffset, value: latest.value }
        : null,
    },
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
    userId: args.userId,
    cacheAction,
    todayKey,
    snapshotHash,
  });
  if (unchanged) {
    return {
      hasProvider: true,
      text: unchanged.text,
      cached: true,
      updatedAt: unchanged.updatedAt,
    };
  }

  const previousContext = await getPreviousInsightContext(
    args.userId,
    // memory.ts keys previous context by the `insights.<scope>.<locale>`
    // action; the generic scope (`metric:<ID>-status`) carries the same
    // `-status` suffix so the comparison row reads back correctly. The
    // `getPreviousInsightContext` param is typed to accept this scope form
    // (`PreviousContextScope`), so the argument type-checks honestly.
    `${scope}-status`,
    locale,
    12,
  );
  const previousContextBlock = formatPreviousContextForPrompt(
    previousContext,
    locale,
  );

  // v1.12.1 — diversity / anti-repetition context, all from already-computed
  // data (no new statistics, no new persistence). Grounding is untouched:
  // these blocks add a rotating opening angle, an explicit data-strength
  // line, a steady-run repetition signal, and the FDR-surviving cross-metric
  // correlations that involve THIS metric. The correlation fetch is
  // best-effort and decorative — a failure resolves to no block, never a
  // generation failure.
  const varietyLead = pickVarietyLead(args.userId, meta.id, todayKey);
  const steadyRun = computeSteadyRun(graded.weekly, graded.monthly);
  const relations = await getRelevantCorrelationsForMetric(
    args.userId,
    meta.measurementType,
    locale,
  );
  const contextBlock = buildAssessmentContextBlock(
    {
      varietyLead,
      dataStrength: {
        points: summary?.points ?? series.daily.length,
        newestDaysAgo,
      },
      repeatCount: steadyRun,
      relations,
    },
    locale,
  );

  // v1.27.13 (Welle J) — the guideline interpretation block for metrics the
  // knowledge base covers (visceral fat, resting HR, SpO₂, respiratory rate,
  // body temperature, sleep duration, waist, PWV). The band position is
  // computed from the signal's current value (or the latest day when no signal
  // window exists); absent for uncovered metrics (fail-soft to personal-
  // relative). Sex-split bands (waist) resolve only when the profile carries a
  // sex.
  // The guideline bands are canonical, so the band position is classified on
  // the canonical value; the block then prints in the reader's unit.
  const interpretationValue = signal?.current ?? latest?.value ?? null;
  const interpretationBlock =
    interpretationValue !== null
      ? buildInterpretationBlock({
          metricKey: meta.id,
          value: reading.toCanonical(interpretationValue),
          sex,
          locale,
          ...(reading.converts
            ? {
                display: {
                  unit: reading.unit,
                  convert: reading.toDisplay,
                },
              }
            : {}),
        })
      : undefined;

  // v1.28.40 — the rotating opener-archetype hint, keyed per (user, metric,
  // day) exactly as `derived-assessment-ai.ts` does for the score cards. This
  // activates the base prompt's dormant "Lead per the OPENER HINT … do NOT open
  // with the number" branch so the per-metric card opens verdict-first and
  // varies run-to-run. No new model call — one arg on the existing completion.
  const openerHint = openerArchetypeHint(
    `${args.userId}:${scope}:${todayKey}`,
    locale as Locale,
  );

  const outcome = await runStatusCompletion({
    userId: args.userId,
    cacheAction,
    capability: "statusText",
    systemPrompt: getMetricArchetypeSystemPrompt(shownMeta, locale),
    userPrompt: getMetricArchetypeUserPrompt(
      shownMeta,
      snapshotJson,
      todayKey,
      locale,
      previousContextBlock,
      contextBlock,
      interpretationBlock,
      openerHint,
    ),
    // v1.12.1 (D1) — the phrasing task benefits from a touch more sampling
    // entropy while the FACTS stay pinned by the snapshot + the
    // forbidden-phrase guards. 0.3 was conservative for a 2-4 sentence prose
    // task; 0.45 varies cadence without loosening grounding. The pair used to
    // sit inline here, bypassing the registry that documents every surface's
    // ceiling; it now reads from `AI_BUDGETS.statusArchetype`.
    temperature: AI_BUDGETS.statusArchetype.temperature,
    maxTokens: AI_BUDGETS.statusArchetype.maxTokens,
  });

  if (outcome.kind === "none") {
    return {
      hasProvider: false,
      text: getNoKeyMetricStatusText(locale, signal, reading.decimals),
      cached: true,
      updatedAt: null,
    };
  }
  if (outcome.kind === "timeout" || outcome.kind === "error") {
    return returnTimeoutFallback({
      cacheAction,
      reason: outcome.kind,
      userId: args.userId,
      todayKey,
      stubText: getNoKeyMetricStatusText(locale, signal, reading.decimals),
    });
  }

  // Outbound safety screen — WITHHOLD policy for a background-generated card.
  const screened = finalizeStatusSummary(outcome.content, locale);
  if (!screened.ok) {
    annotate({
      action: { name: "insights.status.outbound_blocked" },
      meta: { cacheAction, reason: screened.reason },
    });
    return returnTimeoutFallback({
      cacheAction,
      reason: "screened",
      userId: args.userId,
      todayKey,
      stubText: getNoKeyMetricStatusText(locale, signal, reading.decimals),
    });
  }
  const text = screened.text;
  if (!text) {
    throw new Error(`Metric-status summary was empty for ${meta.id}`);
  }

  const updatedAt = await persistStatusInsight({
    userId: args.userId,
    cacheAction,
    todayKey,
    text,
    snapshotHash,
  });

  return { hasProvider: true, text, cached: false, updatedAt };
}

export function resolveMetricStatusLocale(
  locale: string | null | undefined,
): SupportedLocale {
  return normalizeLocale(locale);
}

/**
 * How one metric's numbers are written for this reader: the unit symbol, the
 * conversions in both directions, and the decimals a value is read at.
 *
 * Only a unit-sensitive type (`isUnitSensitiveType`: glucose and the
 * metric/imperial set) converts; every other metric keeps its registry unit
 * and its stored numbers. A transform that does not rescale (`converts`
 * false) is the identity, so the default preferences leave a snapshot
 * byte-identical for the metrics whose registry unit already is the display
 * unit.
 */
function readingDisplay(
  meta: MetricStatusMeta,
  preferences: UnitPreferences,
): {
  unit: string;
  decimals: number | undefined;
  converts: boolean;
  toDisplay: (canonical: number) => number;
  toCanonical: (display: number) => number;
  convertGraded: (series: GradedSeries) => GradedSeries;
} {
  if (!isUnitSensitiveType(meta.measurementType)) {
    return {
      unit: meta.unit,
      decimals: undefined,
      converts: false,
      toDisplay: (v) => v,
      toCanonical: (v) => v,
      convertGraded: (series) => series,
    };
  }
  const transform: DisplayTransform = getReadingTransform(
    meta.measurementType,
    preferences,
  );
  const converts = transformRescales(transform);
  return {
    unit: transform.displayUnit,
    decimals: transform.decimals,
    converts,
    toDisplay: (v) => applyDisplayTransform(v, transform),
    toCanonical: (v) => invertDisplayTransform(v, transform),
    convertGraded: (series) =>
      converts ? convertGradedSeries(series, transform) : series,
  };
}
