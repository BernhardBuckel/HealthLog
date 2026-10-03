/**
 * GET /api/dashboard/summary
 *
 * Aggregator endpoint for the iOS DashboardSummary view. Combines
 * greeting, intake-day streaks, today's medication compliance, the
 * highlighted insight, and per-metric latest+sparkline+trend.
 *
 * The shape is fixed for the iOS client and intentionally normalised —
 * `kind` is iOS-friendly (camelCase), unlike the canonical Prisma enum
 * (BLOOD_PRESSURE_SYS etc.).
 *
 * Cold-mount performance (v1.4.38 W-F)
 * ------------------------------------
 * The legacy shape ran an unbounded `prisma.measurement.findMany` over
 * the trailing 7 days plus a second unbounded `findMany` over the
 * trailing 365 days for the streak-day set. On a power-user account
 * (Apple Health step samples ≈ thousands per day) those two queries
 * dominated the wall-clock at ~4.6 s cold even though the DOWNSTREAM
 * JS code only ever needed:
 *   - the latest value per type within the 7-day window
 *   - a small sparkline (≤7 daily aggregates) per type
 *   - the set of YYYY-MM-DD day-keys with any activity in 365 days
 *
 * v1.4.38 swaps the two unbounded reads for SQL aggregates:
 *   - one row per type carrying the latest value + measuredAt
 *     (≤ N_metrics rows). REG-11 (v1.4.44) dropped the trailing-7-day
 *     window from the WHERE clause; the tile now surfaces the all-time-
 *     latest reading per type so a 60-day-old BP measurement still feeds
 *     the tile (paired with the stale-caption hint built off
 *     `lastSeenAt`). v1.38.5 replaced the `DISTINCT ON (type)` that
 *     produced those rows with a LATERAL join over the type list; both
 *     per-type reads now live in `@/lib/dashboard/summary-reads`.
 *   - `measurement_rollups` DAY buckets keyed `(user_id, type,
 *     granularity, bucketStart)` → at most 7 buckets per metric × N_metrics rows.
 *     Sparkline points become the bucket means rather than individual
 *     raw samples, which is a *smoother* trend signal for high-volume
 *     metrics like ACTIVITY_STEPS and bounded for every other metric.
 *     REG-11 (v1.4.44) switched the calendar-window filter for a
 *     `ROW_NUMBER() OVER (PARTITION BY type ORDER BY bucket_start
 *     DESC)` window so the sparkline takes the last `SPARK_DAYS`
 *     buckets per type regardless of age.
 *   - `SELECT DISTINCT date_trunc('day', measured_at)::date` over the
 *     365-day window → at most 365 dates (vs. up to 100k raw rows).
 *
 * The whole response is wrapped in the 60 s analytics LRU cache so
 * subsequent iOS polls inside the window hit memory. Invalidation runs
 * via the existing `invalidateUserMeasurements` + the v1.4.38-extended
 * `invalidateUserMedications` hooks.
 *
 * Module gate: the emitted `metrics` array is filtered against the account's
 * module map before it leaves the handler, so a card whose measurement type
 * belongs to a disabled module never ships. The decision comes from the same
 * map the shared snapshot builder uses (`disabledSummaryTypes`); the filter
 * runs OUTSIDE the cache because a module toggle does not evict it.
 */
import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { apiSuccess } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { prisma } from "@/lib/db";
import type { MeasurementType } from "@/generated/prisma/client";
import { measurementTypeEnum } from "@/lib/validations/measurement";
import { CUMULATIVE_HK_TYPES } from "@/lib/measurements/apple-health-mapping";
import { getServerTranslator } from "@/lib/i18n/server-translator";
import { type Locale } from "@/lib/i18n/config";
import { resolveJobLocale } from "@/lib/i18n/job-locale";
import { userDayKey, DEFAULT_TIMEZONE } from "@/lib/tz/resolver";
import { validTimezoneOr } from "@/lib/tz/format";
import { startOfLocalDayKey } from "@/lib/tz/local-day";
import { cachedSwr, caches, type ServerCache } from "@/lib/cache/server-cache";
import { buildMedsTodayBlock } from "@/lib/dashboard/meds-today";
import { computeStreak } from "@/lib/dashboard/streak";
import {
  readLatestEver,
  readSparkBuckets,
} from "@/lib/dashboard/summary-reads";
import { resolveModuleMap } from "@/lib/modules/gate";
import { gateMetricCardsByModules } from "@/lib/dashboard/widget-modules";
import {
  summarizeSleepNights,
  reconstructSleepNights,
  type SleepSourceDiscrepancy,
  type SleepStageRow,
} from "@/lib/analytics/sleep-night";
import { loadUserSourcePriority } from "@/lib/rollups/measurement-read";
import type { SleepStage } from "@/generated/prisma/client";
import { loadBaselineProfile } from "@/lib/insights/derived/baseline";
import { computeBmi } from "@/lib/insights/derived/bmi";
import { isDerivedOk } from "@/lib/insights/derived/types";
import { buildMoodDailySeries } from "@/lib/analytics/mood-series";
import {
  reconstructNights,
  sleepNeedMinutes,
} from "@/lib/insights/derived/sleep-score";
import {
  computeSleepRhythmFromNights,
  type SleepRhythmDto,
} from "@/lib/insights/derived/sleep-rhythm";

const SPARK_DAYS = 7;
const STREAK_WINDOW_DAYS = 365;

type MetricKind =
  | "weight"
  | "bloodPressure"
  | "pulse"
  | "bodyFat"
  | "glucose"
  | "sleep"
  | "steps"
  | "totalBodyWater"
  | "boneMass"
  | "oxygenSaturation"
  | "mood"
  | "bmi";

interface MetricCard {
  id: string;
  kind: MetricKind;
  /**
   * v1.5.x — i18n key for the metric's display title (e.g.
   * `dashboard.metric.title.weight`). Clients resolve the key against
   * their own locale bundle: the PWA via `useTranslations()`, the iOS
   * client via its bundled `Localizable.xcstrings`. The previous wire
   * shape carried a German string literal which injected DE into an
   * English-locale iOS UI.
   */
  titleKey: string;
  latestValue: number | null;
  secondaryValue: number | null;
  /**
   * v1.5.x — i18n key for the metric's display unit (e.g.
   * `dashboard.metric.unit.weight`). Same resolution contract as
   * `titleKey`. SI tokens like `kg`, `mmHg`, `bpm`, `mg/dL` are
   * identical across every shipped locale; per-kind keys keep the
   * door open for locale-specific overrides (e.g. Imperial units)
   * without another wire-shape change.
   */
  unitKey: string;
  /**
   * v1.11.4 — explicit unit token for clients that need to know the
   * value's unit without inferring it from the metric kind. Most tiles
   * leave this `null` (the `unitKey` i18n key already carries the
   * display unit). The `sleep` tile sets it to `"h"` because its
   * `latestValue` is a per-NIGHT total expressed in HOURS (a float),
   * not the canonical `SLEEP_DURATION` minutes — see the sleep block
   * below for why the night total replaced the single-stage value.
   */
  unit: string | null;
  /**
   * v1.11.4 — per-stage minutes for the headline night, sleep tile only.
   * `null` for every other kind and for a sleep night with no
   * stage-tagged rows (a legacy bare-duration night). Additive: a future
   * sleep detail view can render the breakdown without changing the
   * headline `latestValue`.
   */
  sleepStages: Partial<Record<SleepStage, number>> | null;
  /**
   * v1.28.x — source-discrepancy annotation for the headline night's MAIN
   * session, sleep tile only; `null` for every other kind and for a night
   * whose writers agree. Additive (the established wire pattern for the
   * iOS-locked shape): observational only — `latestValue` stays the
   * winning writer's total; clients render a discreet "sources disagree"
   * hint next to the number. Minutes are whole (rounded), matching the
   * `/api/sleep/night` serialisation.
   */
  sleepSourceDiscrepancy: SleepSourceDiscrepancy | null;
  trend: "up" | "down" | "flat" | "unknown";
  sparkline: number[];
  updatedAt: string | null;
  /**
   * v1.4.33 maintainer-item-1 — total readings the user has ever
   * logged for this metric, irrespective of the 7-day sparkline
   * window. The dashboard tile keeps showing whenever `allTimeCount > 0`
   * so a user with valid historical data isn't surprised by a tile
   * disappearing during a logging gap. Distinct from `sparkline.length`
   * which only carries the trailing-7-day points.
   */
  allTimeCount: number;
  /**
   * v1.4.33 maintainer-item-1 — ISO timestamp of the metric's single
   * most recent reading. When `allTimeCount > 0` but the latest
   * reading is older than 7 days, the iOS tile renders a muted
   * "last reading N days ago" caption so the user understands the
   * value isn't stale silently. `null` when the metric has no readings
   * at all.
   */
  lastSeenAt: string | null;
}

/**
 * v1.5.x — wire i18n keys, not translated strings.
 *
 * The legacy maps emitted German literals like "Gewicht" / "Schritte"
 * which injected into an English iOS UI once the iOS app flipped its
 * source language. Clients now resolve these keys against their own
 * locale bundle (the PWA via `useTranslations()`, iOS via
 * `Localizable.xcstrings`). The server payload becomes language-neutral
 * and the response shrinks slightly.
 *
 * One key per `MetricKind` — symmetric maps so a new kind has to add
 * both a title and a unit key (Type-checked: `Record<MetricKind, string>`).
 */
const METRIC_TITLE_KEYS: Record<MetricKind, string> = {
  weight: "dashboard.metric.title.weight",
  bloodPressure: "dashboard.metric.title.bloodPressure",
  pulse: "dashboard.metric.title.pulse",
  bodyFat: "dashboard.metric.title.bodyFat",
  glucose: "dashboard.metric.title.glucose",
  sleep: "dashboard.metric.title.sleep",
  steps: "dashboard.metric.title.steps",
  totalBodyWater: "dashboard.metric.title.totalBodyWater",
  boneMass: "dashboard.metric.title.boneMass",
  oxygenSaturation: "dashboard.metric.title.oxygenSaturation",
  mood: "dashboard.metric.title.mood",
  bmi: "dashboard.metric.title.bmi",
};

const METRIC_UNIT_KEYS: Record<MetricKind, string> = {
  weight: "dashboard.metric.unit.weight",
  bloodPressure: "dashboard.metric.unit.bloodPressure",
  pulse: "dashboard.metric.unit.pulse",
  bodyFat: "dashboard.metric.unit.bodyFat",
  glucose: "dashboard.metric.unit.glucose",
  sleep: "dashboard.metric.unit.sleep",
  steps: "dashboard.metric.unit.steps",
  totalBodyWater: "dashboard.metric.unit.totalBodyWater",
  boneMass: "dashboard.metric.unit.boneMass",
  oxygenSaturation: "dashboard.metric.unit.oxygenSaturation",
  mood: "dashboard.metric.unit.mood",
  bmi: "dashboard.metric.unit.bmi",
};

/**
 * v1.11.4 — sleep sparkline = the trailing-7 nights' TIME-ASLEEP in
 * hours, reconstructed per night from the raw stage rows. The generic
 * DAY-bucket rollup sparkline can't be used for sleep because it means
 * across the per-stage rows (e.g. a 60-min DEEP row and a 240-min CORE
 * row average to 150) rather than summing them into a night total.
 */
function buildSleepSparkline(
  rows: SleepStageRow[],
  tz: string,
  priorityJson: unknown,
): number[] {
  return reconstructSleepNights(rows, tz, priorityJson)
    .filter((n) => n.asleepMinutes > 0)
    .map((n) => Math.round((n.asleepMinutes / 60) * 100) / 100)
    .slice(-SPARK_DAYS);
}

function trendOf(values: number[]): MetricCard["trend"] {
  if (values.length < 2) return "unknown";
  const first = values[0];
  const last = values[values.length - 1];
  const delta = last - first;
  const epsilon = Math.max(1, Math.abs(first) * 0.01);
  if (Math.abs(delta) < epsilon) return "flat";
  return delta > 0 ? "up" : "down";
}

/** v1.4.38 W-F — distinct activity day-keys from the streak window.
 *  The route only needs YYYY-MM-DD strings, so the aggregate runs
 *  `date_trunc('day', m.measured_at AT TIME ZONE $userTz)` and returns
 *  the day-keys directly. At most 365 rows; vs. the legacy `findMany`
 *  which could return tens of thousands. */
interface ActivityDayRow {
  day_key: string;
}

export const GET = apiHandler(async () => {
  // v1.37.0 — MANAGE-level read: computed over the whole record, with no
  // provider anywhere on the path.
  const { user } = await requireRecordAuth("manage", "record");
  annotate({ action: { name: "dashboard.summary" } });

  // v1.4.25 W7b — anchor every day-bucket call to the user's display
  // timezone. Falls back to Europe/Berlin when the column is somehow
  // missing (defensive — the schema's NOT NULL default normally pins
  // it).
  const userTz = validTimezoneOr(user.timezone, DEFAULT_TIMEZONE);

  // v1.4.38 W-F — wrap the whole response in the analytics LRU.
  // Subsequent iOS polls inside the TTL hit memory; measurement /
  // mood / medication writes invalidate the user-bucket via the
  // existing `invalidateUserMeasurements` + the v1.4.38-extended
  // `invalidateUserMedications` hooks.
  //
  // v1.18.11 (W5 perf) — read via `cachedSwr`. The `analytics` bucket
  // already provisions a 1 h `staleTtlMs` window, but this endpoint read
  // through plain `cached` and so ignored it: the iOS client polls every
  // 60 s, and a plain read past the 60 s fresh TTL re-paid the full cold
  // rebuild on every poll. `cachedSwr` serves the prior body instantly
  // inside the stale window and warms one background recompute instead.
  // Writes still mark/evict the bucket, so a user's own action is
  // reflected on the very next read — the window only bounds wall-clock
  // drift (the same self-correcting `nextDueOverdue`/tally drift the
  // snapshot read already tolerates).
  const body = await cachedSwr(
    caches.analytics as ServerCache<
      Awaited<ReturnType<typeof buildDashboardSummary>>
    >,
    `${user.id}|dashboard-summary`,
    async () =>
      buildDashboardSummary(user.id, userTz, await buildContext(user)),
    annotate,
  );

  // ── module gate ───────────────────────────────────────────────────
  // This route builds its own payload instead of going through
  // `readDashboardSnapshotCached`, so it never picked up the module gate
  // the shared snapshot builder applies — it emitted glucose and sleep
  // tiles on data presence alone, while `/api/dashboard/snapshot` correctly
  // withheld them for the same account.
  //
  // OMIT, NOT 403 — matching the snapshot sibling and the sync feed. This is
  // an aggregate of ten metric cards across several domains; refusing the
  // whole request would blank the iOS dashboard because one module is off.
  // The card simply does not appear, which is exactly what a disabled module
  // means on every other dashboard surface.
  //
  // Applied AFTER the cache read, deliberately. The analytics LRU is keyed
  // `<userId>|dashboard-summary` with a 60 s fresh / 1 h stale window, and
  // toggling a module does not evict it — gating inside the builder would
  // leave the disabled tile served for up to an hour after the user turned
  // it off. Filtering the cached body makes the toggle effective on the very
  // next request.
  const modules = await resolveModuleMap(user.id);
  const metrics = gateMetricCardsByModules(body.metrics, modules);
  annotate({
    meta: {
      metrics_emitted: metrics.length,
      metrics_gated: body.metrics.length - metrics.length,
    },
  });

  return apiSuccess({ ...body, metrics });
});

interface SummaryBuilderContext {
  greetingName: string;
  locale: Locale;
}

async function buildContext(user: {
  displayName: string | null;
  username: string;
  locale: string | null;
}): Promise<SummaryBuilderContext> {
  const greetingName = user.displayName ?? user.username;
  // The greeting salutation and the streak label are the two strings this
  // route still translates server-side, and the native client is its only
  // caller — a Bearer request carries no locale cookie and no meaningful
  // Accept-Language, so the stored column is the only per-user signal.
  // That is exactly the shape `resolveJobLocale` exists for: stored user
  // locale, then the operator's configured default, then English. The
  // hand-rolled coercion this replaces stopped at English, so a German
  // instance whose user never touched the language picker greeted them in
  // English while every other string on the same screen was German.
  const locale: Locale = await resolveJobLocale(user.locale);
  return { greetingName, locale };
}

async function buildDashboardSummary(
  userId: string,
  userTz: string,
  ctx: SummaryBuilderContext,
) {
  const now = new Date();
  // REG-11 (v1.4.44): the trailing-7-day pivot used to anchor the
  // latest-reading + sparkline filters is gone — both sub-queries now
  // take the most recent N rows per type regardless of age. Only the
  // streak window still anchors on a calendar slice.
  const streakWindowStart = new Date(
    now.getTime() - STREAK_WINDOW_DAYS * 86_400_000,
  );

  // Derived from canonical enum so a new measurement type is auto-included
  // (V3 audit: enum drift cousins). Per-kind display blocks below decide
  // which types render as MetricCards.
  const measurementTypes = [
    ...measurementTypeEnum.options,
  ] as MeasurementType[];

  // v1.4.38 W-F — per-sub-query wall-clock timing for prod observability.
  // Captured on the cache-miss path; the cache-hit path skips this whole
  // builder. Reported under `meta.dashboard.sub_*_ms` so the next
  // perf-verify can attribute a regression to a specific sub-query
  // without re-instrumenting the route.
  const timings: Record<string, number> = {};
  const time = async <T>(
    label: string,
    builder: () => Promise<T>,
  ): Promise<T> => {
    const t0 = Date.now();
    const result = await builder();
    timings[`dashboard.sub_${label}_ms`] = Date.now() - t0;
    return result;
  };

  // v1.4.38 W-F — six bounded sub-queries replace the legacy 4
  // unbounded ones. Row counts are now:
  //   - latestEver: ≤ N metric types (one indexed lookup per type via
  //                 LATERAL, REG-11: dropped the 7-day window so a
  //                 stale-but-valid historical reading still feeds the tile)
  //   - sparkBuckets: ≤ SPARK_DAYS × N metric types (typically <80,
  //                  REG-11: taken via ROW_NUMBER window, no calendar
  //                  filter, so a 60-day-old metric still paints a chart)
  //   - allTimeAggregate: ≤ N metric types (unchanged)
  //   - medsToday: today-window tally via the shared projector
  //                (≤ daily intake schedule count, unchanged semantics)
  //   - streakActivity: ≤ daily intake count × 365 (unchanged)
  //   - measurementStreakDays: ≤ 365 (was: every raw row in 365d)
  const [
    latestEver,
    sparkBuckets,
    allTimeAggregate,
    medsToday,
    streakActivity,
    measurementStreakDays,
    sleepStageRows,
  ] = await Promise.all([
    // Both reads live in `@/lib/dashboard/summary-reads` — the SQL is a
    // contract the integration suite exercises directly against Postgres,
    // and each carries the reason it names the type list at its
    // definition. Short version: PostgreSQL 16 has no index skip scan, so
    // "one row per type" has to be driven FROM the type list or it
    // degrades to a full pass over the account.
    time("latestEver", () => readLatestEver(prisma, userId, measurementTypes)),
    time("sparkline", () =>
      readSparkBuckets(prisma, userId, measurementTypes, SPARK_DAYS),
    ),
    time("allTime", () =>
      prisma.measurement.groupBy({
        by: ["type"],
        where: { userId, type: { in: measurementTypes }, deletedAt: null },
        _count: { _all: true },
        _max: { measuredAt: true },
      }),
    ),
    // v1.4.39 W-SERVER-FIX-2 — the dashboard compliance tile pulled
    // `MedicationIntakeEvent` rows for the today-window only. Daily
    // schedules (`daysOfWeek: null`) had no row to read until the
    // reminder worker entered the RED phase at the end of the dose
    // window, so the iOS Dashboard tile fell to "Heute nichts geplant"
    // even when the intake route (post-`expandTodayIntakes` fix) was
    // already projecting + backfilling correctly. The shared
    // `buildMedsTodayBlock` runs the same idempotent projection
    // (`skipDuplicates: true` so a concurrent intake-route hit can't
    // race a duplicate row in) before its today-window tally, so this
    // route and the dashboard snapshot count the identical row set.
    time("medsToday", () => buildMedsTodayBlock(prisma, userId, userTz, now)),
    time("streakIntakes", () =>
      prisma.medicationIntakeEvent.findMany({
        where: {
          userId,
          // v1.7.0 sync — exclude tombstoned rows from streak counting.
          deletedAt: null,
          scheduledFor: { gte: streakWindowStart },
          OR: [{ takenAt: { not: null } }, { skipped: true }],
        },
        select: { takenAt: true, scheduledFor: true },
      }),
    ),
    // v1.4.38 W-F — replaces the legacy 365-day `measurement.findMany`
    // that pulled every raw row in the window only to collapse them to
    // day-keys in JS. The SQL `date_trunc` returns at most 365 rows
    // even on accounts with millions of step samples. The `userTz`
    // conversion is folded server-side so the day boundary matches
    // `userDayKey`'s output (it formats the timestamp in the user's
    // tz before slicing YYYY-MM-DD).
    time(
      "streakDays",
      () =>
        prisma.$queryRaw<ActivityDayRow[]>`
        SELECT DISTINCT
          to_char(
            (m."measured_at" AT TIME ZONE ${userTz}),
            'YYYY-MM-DD'
          ) AS day_key
        FROM measurements m
        WHERE m."user_id" = ${userId}
          AND m."measured_at" >= ${streakWindowStart}
          AND m."deleted_at" IS NULL
      `,
    ),
    // v1.11.4 — raw per-stage SLEEP_DURATION rows for the night-total
    // tile. `SLEEP_DURATION` is stored one row per STAGE per night
    // (minutes), so the single-most-recent row (the `latestEver` path
    // above) is just ONE stage, not the night. The sleep tile instead
    // sums the asleep stages of the latest night via
    // `summarizeSleepNights`. Bounded to the streak window (≈ a year of
    // ~5 rows/night) so the read stays small; the headline only needs
    // the most-recent night but the window also feeds the iOS sparkline
    // night totals.
    time("sleepNights", () =>
      prisma.measurement.findMany({
        where: {
          userId,
          type: "SLEEP_DURATION",
          deletedAt: null,
          measuredAt: { gte: streakWindowStart },
        },
        orderBy: { measuredAt: "asc" },
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
    ),
  ]);

  // v1.11.4 — the user's sleep source-priority ladder, used to collapse a
  // dual-source night (e.g. WHOOP + Apple Health) to one canonical source
  // before the per-night reconstruction sums it. v1.17.0 — the baseline
  // profile rides along (one read) so the sleep-rhythm block resolves the
  // age-based sleep need the cumulative-debt deficit uses.
  const [sleepPriorityJson, sleepProfile, moodSeries] = await Promise.all([
    loadUserSourcePriority(userId),
    loadBaselineProfile(prisma, userId),
    // The mood card reads the SAME canonical daily series the web mood
    // analytics and the dashboard snapshot read (`buildMoodDailySeries`),
    // rollup fast-path included — never a second aggregation.
    time("moodSeries", () => buildMoodDailySeries(userId, prisma)),
  ]);

  // BMI is derived, not measured: it needs the profile height loaded above,
  // so it cannot join the round before it. `computeBmi` is the one canonical
  // implementation (the same one the web vitals dashboard renders through
  // the derived-metric dispatch) — the route resolves the figure and the
  // client consumes it, rather than every client re-deriving weight / m².
  const bmiDerived = await time("bmi", () =>
    computeBmi(userId, sleepProfile, { now }),
  );

  // Per-type metadata lookup — typed Map so a metric with no readings
  // at all falls through `metaForType` to the `{ allTimeCount: 0,
  // lastSeenAt: null }` default. The aggregate row's `_count._all` is
  // always `number` per Prisma's runtime contract; defending against
  // undefined keeps the helper's narrow signature stable.
  const allTimeByType = new Map<
    MeasurementType,
    { allTimeCount: number; lastSeenAt: Date | null }
  >();
  for (const row of allTimeAggregate) {
    allTimeByType.set(row.type, {
      allTimeCount: row._count?._all ?? 0,
      lastSeenAt: row._max?.measuredAt ?? null,
    });
  }
  function metaForType(type: MeasurementType): {
    allTimeCount: number;
    lastSeenAt: string | null;
  } {
    const slot = allTimeByType.get(type);
    return {
      allTimeCount: slot?.allTimeCount ?? 0,
      lastSeenAt: slot?.lastSeenAt?.toISOString() ?? null,
    };
  }

  // v1.4.38 W-F — activity-day set assembled from the bounded streak
  // queries. The measurement side already arrives as YYYY-MM-DD keys
  // from the SQL `date_trunc + AT TIME ZONE` aggregate, byte-identical
  // to what `userDayKey(measuredAt, userTz)` would produce in JS.
  const activityDays = new Set<string>();
  for (const row of measurementStreakDays) {
    if (row.day_key) activityDays.add(row.day_key);
  }
  for (const e of streakActivity) {
    activityDays.add(userDayKey(e.takenAt ?? e.scheduledFor, userTz));
  }

  const streak = computeStreak(activityDays, userTz);

  // v1.4.38 W-F — per-type latest (one row per type) + sparkline
  // (bucket means per day) assembled from the two new SQL aggregates.
  // REG-11 (v1.4.44): `latestEver` carries the most recent reading
  // regardless of age — the iOS tile shows the historical value plus a
  // muted "Letzter Wert vor Xd" caption rather than nothing at all.
  const latestByType = new Map<MeasurementType, { value: number; at: Date }>();
  for (const row of latestEver) {
    latestByType.set(row.type, {
      value: Number(row.value),
      at: new Date(row.measured_at),
    });
  }
  // v1.4.39 W-SUM — cumulative tiles paint the daily SUM; spot tiles
  // keep the daily MEAN. Reading `sum_value` directly off the rollup
  // row eliminates the legacy `mean * count` reconstruction; the
  // fallback covers pre-v1.4.39 NULL rows during the boot-backfill
  // convergence window.
  const sparkByType = new Map<MeasurementType, number[]>();
  for (const row of sparkBuckets) {
    const list = sparkByType.get(row.type) ?? [];
    // QA Simplifier (v1.4.39): flatten the cumulative-vs-spot ternary
    // into a named branch per the CLAUDE.md "no nested ternaries"
    // rule. Cumulative tiles paint the daily SUM; spot tiles keep the
    // daily MEAN. The legacy NULL fallback covers pre-v1.4.39 rollup
    // rows the boot-backfill hasn't refreshed yet.
    const cumulativePoint =
      row.sum_value !== null
        ? Number(row.sum_value)
        : Number(row.mean) * Number(row.count);
    const point = CUMULATIVE_HK_TYPES.has(row.type)
      ? cumulativePoint
      : Number(row.mean);
    list.push(point);
    sparkByType.set(row.type, list);
  }

  function latestOf(type: MeasurementType): { value: number; at: Date } | null {
    return latestByType.get(type) ?? null;
  }

  function sparkOf(type: MeasurementType): number[] {
    return sparkByType.get(type) ?? [];
  }

  // v1.11.4 — collapse the per-stage SLEEP_DURATION rows into per-night
  // asleep totals. The sleep tile's headline is last night's TIME ASLEEP
  // (CORE/light + DEEP + REM, excluding IN_BED + AWAKE), emitted in HOURS
  // with an explicit `unit: "h"`, replacing the single-stage minutes the
  // `latestEver` read used to surface.
  const sleepSummary = summarizeSleepNights(
    sleepStageRows as SleepStageRow[],
    userTz,
    sleepPriorityJson,
  );

  // v1.17.0 — server-authoritative sleep-rhythm DTO (sleep-debt + chronotype)
  // off the SAME canonical reconstruction the Sleep page + Sleep Score read,
  // so iOS renders identical values. Reuses the rows already loaded above —
  // `reconstructNights` adapts them into the asleep + wall-clock-midpoint
  // shape the foundation modules consume, then `computeSleepRhythmFromNights`
  // forwards them to `computeSleepDebt` / `computeChronotype` (the one place
  // the math lives). Both signals carry a calm partial / learning state below
  // their night thresholds — never an assertion off thin data.
  const sleepRhythm: SleepRhythmDto = computeSleepRhythmFromNights(
    reconstructNights(
      sleepStageRows as SleepStageRow[],
      userTz,
      sleepPriorityJson,
    ),
    sleepNeedMinutes(sleepProfile.ageYears),
  );

  const metrics: MetricCard[] = [];

  // v1.4.33 maintainer-item-1 — every emitted card now carries
  // `allTimeCount` + `lastSeenAt` so the iOS tile renderer can keep
  // a metric visible during a logging gap (gate on `allTimeCount > 0`)
  // and paint a muted "Letzter Wert vor Xd" caption when the most
  // recent reading is older than the 7-day sparkline window.

  // Weight
  {
    const latest = latestOf("WEIGHT");
    const spark = sparkOf("WEIGHT");
    const meta = metaForType("WEIGHT");
    metrics.push({
      id: "weight",
      kind: "weight",
      titleKey: METRIC_TITLE_KEYS.weight,
      latestValue: latest?.value ?? null,
      secondaryValue: null,
      unitKey: METRIC_UNIT_KEYS.weight,
      unit: null,
      sleepStages: null,
      sleepSourceDiscrepancy: null,
      trend: trendOf(spark),
      sparkline: spark,
      updatedAt: latest?.at?.toISOString() ?? meta.lastSeenAt,
      allTimeCount: meta.allTimeCount,
      lastSeenAt: meta.lastSeenAt,
    });
  }

  // Blood pressure (paired sys/dia) — REG-11 (v1.4.44): gate the emit
  // on `latestSys || latestDia || bpAllTimeCount > 0` so an account
  // that has never logged BP doesn't get an empty placeholder tile.
  // Mirrors the body-fat gate below.
  {
    const latestSys = latestOf("BLOOD_PRESSURE_SYS");
    const latestDia = latestOf("BLOOD_PRESSURE_DIA");
    const sysSpark = sparkOf("BLOOD_PRESSURE_SYS");
    const sysMeta = metaForType("BLOOD_PRESSURE_SYS");
    const diaMeta = metaForType("BLOOD_PRESSURE_DIA");
    // BP is a paired metric — the tile is "alive" whenever either side
    // of the pair has history. Sum the count to reflect total readings
    // and pick the most recent `_max` so the staleness hint follows
    // whichever side is freshest.
    const bpAllTimeCount = sysMeta.allTimeCount + diaMeta.allTimeCount;
    const bpLastSeenAt = ((): string | null => {
      const sysAt = sysMeta.lastSeenAt;
      const diaAt = diaMeta.lastSeenAt;
      if (!sysAt) return diaAt;
      if (!diaAt) return sysAt;
      return sysAt >= diaAt ? sysAt : diaAt;
    })();
    if (latestSys || latestDia || bpAllTimeCount > 0) {
      metrics.push({
        id: "bp",
        kind: "bloodPressure",
        titleKey: METRIC_TITLE_KEYS.bloodPressure,
        latestValue: latestSys?.value ?? null,
        secondaryValue: latestDia?.value ?? null,
        unitKey: METRIC_UNIT_KEYS.bloodPressure,
        unit: null,
        sleepStages: null,
        sleepSourceDiscrepancy: null,
        trend: trendOf(sysSpark),
        sparkline: sysSpark,
        updatedAt:
          latestSys?.at?.toISOString() ??
          latestDia?.at?.toISOString() ??
          bpLastSeenAt,
        allTimeCount: bpAllTimeCount,
        lastSeenAt: bpLastSeenAt,
      });
    }
  }

  // Pulse — REG-11 (v1.4.44): gate the emit on `latest || allTimeCount
  // > 0` so an account that has never logged pulse doesn't get an empty
  // placeholder tile. Mirrors the body-fat gate below.
  {
    const latest = latestOf("PULSE");
    const spark = sparkOf("PULSE");
    const meta = metaForType("PULSE");
    if (latest || meta.allTimeCount > 0) {
      metrics.push({
        id: "pulse",
        kind: "pulse",
        titleKey: METRIC_TITLE_KEYS.pulse,
        latestValue: latest?.value ?? null,
        secondaryValue: null,
        unitKey: METRIC_UNIT_KEYS.pulse,
        unit: null,
        sleepStages: null,
        sleepSourceDiscrepancy: null,
        trend: trendOf(spark),
        sparkline: spark,
        updatedAt: latest?.at?.toISOString() ?? meta.lastSeenAt,
        allTimeCount: meta.allTimeCount,
        lastSeenAt: meta.lastSeenAt,
      });
    }
  }

  // Body fat — v1.4.33 widens the emit gate from `latestOf` (only
  // fires when the 7-day window has a reading) to `allTimeCount > 0`
  // so a tile doesn't disappear during a fortnight without a fresh
  // reading.
  {
    const latest = latestOf("BODY_FAT");
    const spark = sparkOf("BODY_FAT");
    const meta = metaForType("BODY_FAT");
    if (latest || meta.allTimeCount > 0) {
      metrics.push({
        id: "bodyFat",
        kind: "bodyFat",
        titleKey: METRIC_TITLE_KEYS.bodyFat,
        latestValue: latest?.value ?? null,
        secondaryValue: null,
        unitKey: METRIC_UNIT_KEYS.bodyFat,
        unit: null,
        sleepStages: null,
        sleepSourceDiscrepancy: null,
        trend: trendOf(spark),
        sparkline: spark,
        updatedAt: latest?.at.toISOString() ?? meta.lastSeenAt,
        allTimeCount: meta.allTimeCount,
        lastSeenAt: meta.lastSeenAt,
      });
    }
  }

  // Optional cards — emitted whenever the user has *ever* logged the
  // metric. Up to v1.4.32 the gate was `latestOf(type)` (only fires
  // when the trailing 7-day window has a reading); v1.4.33 widens to
  // the all-time count so a glucose tile that hasn't been touched in
  // 10 days still renders with the historical value visible to the
  // iOS client (paired with the lastSeenAt caption).
  for (const [type, kind] of [
    ["BLOOD_GLUCOSE", "glucose"],
    ["SLEEP_DURATION", "sleep"],
    ["ACTIVITY_STEPS", "steps"],
    ["TOTAL_BODY_WATER", "totalBodyWater"],
    ["BONE_MASS", "boneMass"],
    ["OXYGEN_SATURATION", "oxygenSaturation"],
  ] as const) {
    const latest = latestOf(type);
    const meta = metaForType(type);
    if (!latest && meta.allTimeCount === 0) continue;

    // v1.11.4 — sleep is night-aggregated, not single-stage. Emit the
    // latest night's TIME ASLEEP in HOURS (float) with an explicit
    // `unit: "h"`, the per-stage breakdown, and a sparkline of the
    // trailing nights' asleep hours. Every other kind keeps the
    // single-row latest value + canonical-unit i18n key.
    if (kind === "sleep") {
      const night = sleepSummary.latestNight;
      const toHours = (minutes: number): number =>
        Math.round((minutes / 60) * 100) / 100;
      // Sparkline = trailing nights' asleep hours from the night
      // reconstruction (the DAY-bucket rollup sparkline blends stages
      // and would be misleading for sleep).
      const nightSpark = buildSleepSparkline(
        sleepStageRows as SleepStageRow[],
        userTz,
        sleepPriorityJson,
      );
      const stageHours: Partial<Record<SleepStage, number>> | null = night
        ? Object.fromEntries(
            Object.entries(night.stages).map(([s, m]) => [s, toHours(m)]),
          )
        : null;
      metrics.push({
        id: kind,
        kind,
        titleKey: METRIC_TITLE_KEYS[kind],
        latestValue: night ? toHours(night.asleepMinutes) : null,
        secondaryValue: null,
        unitKey: METRIC_UNIT_KEYS[kind],
        unit: "h",
        sleepStages:
          stageHours && Object.keys(stageHours).length > 0 ? stageHours : null,
        // Additive, observational: the headline night's MAIN session saw
        // two writer buckets with clearly different asleep totals. Round
        // to whole minutes, matching the `/api/sleep/night` serialisation.
        sleepSourceDiscrepancy: night?.sourceDiscrepancy
          ? {
              deltaMinutes: Math.round(night.sourceDiscrepancy.deltaMinutes),
              sources: night.sourceDiscrepancy.sources.map((b) => ({
                source: b.source,
                deviceType: b.deviceType,
                asleepMinutes: Math.round(b.asleepMinutes),
              })),
            }
          : null,
        trend: trendOf(nightSpark),
        sparkline: nightSpark,
        updatedAt: night?.measuredAt.toISOString() ?? meta.lastSeenAt,
        allTimeCount: meta.allTimeCount,
        lastSeenAt: night?.measuredAt.toISOString() ?? meta.lastSeenAt,
      });
      continue;
    }

    const spark = sparkOf(type);
    metrics.push({
      id: kind,
      kind,
      titleKey: METRIC_TITLE_KEYS[kind],
      latestValue: latest?.value ?? null,
      secondaryValue: null,
      unitKey: METRIC_UNIT_KEYS[kind],
      unit: null,
      sleepStages: null,
      sleepSourceDiscrepancy: null,
      trend: trendOf(spark),
      sparkline: spark,
      updatedAt: latest?.at.toISOString() ?? meta.lastSeenAt,
      allTimeCount: meta.allTimeCount,
      lastSeenAt: meta.lastSeenAt,
    });
  }

  // Mood — the one metric on this payload that is not a `Measurement`. The
  // daily series is the canonical `buildMoodDailySeries` output (rollup
  // fast-path, 1..5 scale, one entry per day with an average score), the
  // same series the web mood analytics and the dashboard snapshot render.
  // Emitted only when the account has ever logged a mood, matching the
  // `allTimeCount === 0` gate every optional card above uses.
  if (moodSeries.entryCount > 0) {
    const spark = moodSeries.entries.slice(-SPARK_DAYS).map((e) => e.score);
    const latestEntry = moodSeries.entries[moodSeries.entries.length - 1];
    // The series carries the user's LOCAL day keys (`MoodEntry.date`), not
    // timestamps, so the only honest instant is the first instant of that
    // day in the user's zone. Writing the key as `T00:00Z` instead put the
    // instant on the previous calendar day for anyone west of UTC, and a
    // client formatting it in its own zone showed today's entry as
    // yesterday's.
    const latestAt = latestEntry
      ? startOfLocalDayKey(latestEntry.date, userTz).toISOString()
      : null;
    metrics.push({
      id: "mood",
      kind: "mood",
      titleKey: METRIC_TITLE_KEYS.mood,
      latestValue: latestEntry?.score ?? null,
      secondaryValue: null,
      unitKey: METRIC_UNIT_KEYS.mood,
      unit: null,
      sleepStages: null,
      sleepSourceDiscrepancy: null,
      trend: trendOf(spark),
      sparkline: spark,
      updatedAt: latestAt,
      allTimeCount: moodSeries.entryCount,
      lastSeenAt: latestAt,
    });
  }

  // BMI — derived from the latest weight at the profile height by
  // `computeBmi`, the single implementation the web vitals dashboard also
  // renders. The card is omitted when the derivation is insufficient
  // (no height on the profile, or no weight inside its window): the card
  // shape has no "unknown" state to express honestly, and a card with a
  // null value would read as a logging gap rather than a missing profile
  // field. Clients that want to prompt for a height should do so from the
  // profile surface, not from an empty dashboard tile.
  if (isDerivedOk(bmiDerived)) {
    const spark = bmiDerived.value.series.slice(-SPARK_DAYS);
    metrics.push({
      id: "bmi",
      kind: "bmi",
      titleKey: METRIC_TITLE_KEYS.bmi,
      latestValue: bmiDerived.value.bmi,
      secondaryValue: null,
      unitKey: METRIC_UNIT_KEYS.bmi,
      unit: null,
      sleepStages: null,
      sleepSourceDiscrepancy: null,
      trend: trendOf(spark),
      sparkline: spark,
      // BMI moves exactly when weight does, so the weight metadata is the
      // honest recency signal — there is no separate BMI reading.
      updatedAt: metaForType("WEIGHT").lastSeenAt,
      allTimeCount: metaForType("WEIGHT").allTimeCount,
      lastSeenAt: metaForType("WEIGHT").lastSeenAt,
    });
  }

  // Shared builder carries the exact tally semantics this tile always
  // had (scheduled = every today-window row; taken = `takenAt` set and
  // not skipped). The wire shape of `compliance` is locked for iOS.
  const scheduledToday = medsToday.scheduledToday;
  const takenToday = medsToday.takenToday;

  const t = getServerTranslator(ctx.locale).t;

  annotate({ meta: timings });

  return {
    greeting: {
      salutation: t("dashboard.greetingSalutation", { name: ctx.greetingName }),
      date: now.toISOString(),
    },
    streak: {
      currentDays: streak.currentDays,
      longest: streak.longest,
      label: t("dashboard.streakLabel"),
    },
    compliance: {
      scheduledToday,
      takenToday,
    },
    highlightInsight: null,
    metrics,
    // v1.17.0 — sleep-debt + chronotype, server-authoritative. Same values
    // the Sleep page's `/api/sleep/rhythm` read returns.
    sleepRhythm,
    lastUpdated: now.toISOString(),
  };
}
