/**
 * Pure time / series helpers for the Coach snapshot builder.
 *
 * Everything here is deterministic over its inputs — window arithmetic,
 * user-timezone day/week bucketing, daily/weekly fold-downs, the coarse
 * rollup tail, and the scope resolver. Split out of `snapshot.ts` so the
 * builder file carries only the assembly logic; the dependency direction
 * is one-way (snapshot → series), never back.
 */
import { userDayKey } from "@/lib/tz/format";
import { buildTieredSeries } from "@/lib/rollups/tiered-context";
import type { MeasurementType } from "@/generated/prisma/client";
import { buildBaselineBand } from "@/lib/insights/derived/baseline";
import { DEFAULT_WINDOW } from "./snapshot-cache";
import type { CoachScope, CoachScopeSource, CoachScopeWindow } from "./types";

const WEEKDAY_KEYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

export function windowToDays(window: CoachScopeWindow): number {
  switch (window) {
    case "last7days":
      return 7;
    case "last30days":
      return 30;
    case "last90days":
      return 90;
    case "lastYear":
      // v1.4.27 B7 / BL-P6-4 — year-in-review window. Same 365-day
      // ceiling as the historical `allTime` cap so the prompt budget
      // stays bounded, but with explicit semantics — the Coach knows
      // the user is asking about a long-horizon view rather than the
      // unbounded "all time" backfill.
      return 365;
    case "allTime":
      // Cap "allTime" at one year for the timeline. The aggregate
      // section already cites multi-year ranges via the features
      // pipeline; the timeline stays tight to keep token budget sane.
      return 365;
  }
}

/**
 * YYYY-MM-DD day key anchored to the user's display timezone. The
 * prompt asks the Coach "did you read at 23:50 last night?" — that
 * "last night" answer has to use the user's clock, not UTC. Up to
 * v1.4.24 the day-key was UTC, so a 23:50 Pacific/Auckland reading
 * landed in the next UTC day's bucket and the Coach couldn't pair it
 * with the user's mental model. Delegates to the canonical
 * `userDayKey` so every day-bucket surface stays byte-aligned.
 */
export function tzDayKey(date: Date, tz: string): string {
  return userDayKey(date, tz);
}

/**
 * 0..6 → "Sun".."Sat" using the user's tz so "last Monday" in the
 * prompt agrees with the calendar the user is looking at.
 */
export function tzWeekday(date: Date, tz: string): string {
  const wk = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "short",
  }).format(date);
  // Normalise "Mon" / "Mon," — modern engines drop the comma but
  // older ones may include it.
  const canon = wk.slice(0, 3) as (typeof WEEKDAY_KEYS)[number];
  return WEEKDAY_KEYS.includes(canon) ? canon : WEEKDAY_KEYS[date.getUTCDay()];
}

/**
 * ISO week key like 2026-W19. We derive the week from the user-tz
 * day-key so a Sunday-evening reading in Auckland (which is already
 * Monday UTC) labels under the Auckland week.
 */
export function isoWeekKey(date: Date, tz: string): string {
  // Resolve the wall-clock date in the user's tz, then compute the ISO
  // week from that calendar date. The Thursday-alignment math is the
  // standard ISO 8601 algorithm.
  const dayKey = tzDayKey(date, tz);
  const [y, m, d] = dayKey.split("-").map(Number);
  const localMidnight = new Date(Date.UTC(y, m - 1, d));
  const dayNum = localMidnight.getUTCDay() || 7;
  localMidnight.setUTCDate(localMidnight.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(localMidnight.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(
    ((localMidnight.getTime() - yearStart.getTime()) / 86400000 + 1) / 7,
  );
  return `${localMidnight.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

export interface DailyValueRow {
  date: string;
  weekday: string;
  value: number;
}

interface DailyBpRow {
  date: string;
  weekday: string;
  sys: number;
  dia: number;
}

interface WeeklyBucket {
  weekISO: string;
  mean: number;
  count: number;
}

/**
 * Group raw measurements (one per row, possibly several per day) into
 * one entry per user-tz day. Multiple readings on the same day are
 * folded into the daily mean — clinically the morning reading is what
 * the Coach is usually asked about, but the snapshot stays pre-clinical
 * and takes the straight mean to avoid presenting a fabricated number.
 */
function dailyMeans<T extends { measuredAt: Date; value: number }>(
  rows: T[],
  tz: string,
): Map<string, { date: Date; values: number[] }> {
  const grouped = new Map<string, { date: Date; values: number[] }>();
  for (const r of rows) {
    const key = tzDayKey(r.measuredAt, tz);
    const existing = grouped.get(key);
    if (existing) {
      existing.values.push(r.value);
    } else {
      grouped.set(key, { date: r.measuredAt, values: [r.value] });
    }
  }
  return grouped;
}

export function bucketWeekly(
  rows: Array<{ measuredAt: Date; value: number }>,
  tz: string,
): WeeklyBucket[] {
  const grouped = new Map<string, number[]>();
  for (const r of rows) {
    const key = isoWeekKey(r.measuredAt, tz);
    const list = grouped.get(key);
    if (list) {
      list.push(r.value);
    } else {
      grouped.set(key, [r.value]);
    }
  }
  return Array.from(grouped.entries())
    .map(([weekISO, values]) => ({
      weekISO,
      mean:
        Math.round((values.reduce((s, v) => s + v, 0) / values.length) * 10) /
        10,
      count: values.length,
    }))
    .sort((a, b) => a.weekISO.localeCompare(b.weekISO));
}

export function buildDailyValueRows(
  rows: Array<{ measuredAt: Date; value: number }>,
  recentCutoff: Date,
  tz: string,
): DailyValueRow[] {
  const recent = rows.filter((r) => r.measuredAt >= recentCutoff);
  const grouped = dailyMeans(recent, tz);
  return Array.from(grouped.entries())
    .map(([date, info]) => {
      const mean = info.values.reduce((s, v) => s + v, 0) / info.values.length;
      return {
        date,
        weekday: tzWeekday(info.date, tz),
        value: Math.round(mean * 10) / 10,
      };
    })
    .sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * v1.18.7 — coarse tail + anomaly envelope for one metric, from the shared
 * tiered-context builder. The Coach already ships the 0–14d raw + 30–90d
 * weekly band (above); this adds only the bands the weekly-fold CANNOT
 * produce — 90d–1y MONTH, >1y YEAR, and the preserved peak/trough envelope —
 * so a glucose spike or a BP outlier from months ago survives a coarse
 * bucket. Token-bounded by the helper's per-band row caps (~10 month + ≤5
 * year + ≤5 anomalies ≈ 240 tokens), and the degrader sheds it first (it is
 * the lowest-value, oldest detail). Returns `undefined` when the metric has
 * no coarse history at all, so the block is omitted rather than shipped empty.
 */
export interface CoarseTimelineTail {
  /** 90d–1y monthly buckets: `[bucketStart, mean, min, max]`. */
  monthly: Array<[string, number, number, number]>;
  /** >1y yearly buckets: `[bucketStart, mean, min, max]`. */
  yearly: Array<[string, number, number, number]>;
  /** Preserved peaks/troughs, ≤5, ranked by |deltaSd|. */
  anomalies: Array<{
    band: string;
    date: string;
    kind: string;
    value: number;
    deltaSd: number;
  }>;
}

export async function buildCoarseTimelineTail(
  userId: string,
  type: MeasurementType,
  now: Date,
  tz: string,
  /** The user's source-priority blob, already loaded by the caller. */
  userPriorityJson: unknown,
): Promise<CoarseTimelineTail | undefined> {
  // `buildTieredSeries` reads fall back on miss — a coverage miss yields empty
  // bands, which collapse to `undefined` here. The try/catch keeps the coarse
  // tail a strictly additive enrichment: any unexpected reader failure simply
  // drops the tail rather than failing the whole snapshot (matching the
  // "fall back on miss" contract the rest of the snapshot honours).
  let series: Awaited<ReturnType<typeof buildTieredSeries>>;
  try {
    // `coarseOnly` — the snapshot already holds the raw 0–14d rows from its
    // own window read and this tail consumes only the MONTH/YEAR bands +
    // anomaly envelope, so the builder skips the raw read AND the DAY/WEEK
    // band reads it would otherwise discard.
    series = await buildTieredSeries(userId, type, {
      now: now.getTime(),
      tz,
      coarseOnly: true,
      userPriorityJson,
    });
  } catch {
    return undefined;
  }
  const monthly = series.monthBand.map(
    (b) =>
      [b.bucketStart, b.mean, b.min, b.max] as [string, number, number, number],
  );
  const yearly = series.yearBand.map(
    (b) =>
      [b.bucketStart, b.mean, b.min, b.max] as [string, number, number, number],
  );
  if (
    monthly.length === 0 &&
    yearly.length === 0 &&
    series.anomalies.length === 0
  ) {
    return undefined;
  }
  return {
    monthly,
    yearly,
    anomalies: series.anomalies.map((a) => ({
      band: a.band,
      date: a.date,
      kind: a.kind,
      value: a.value,
      deltaSd: a.deltaSd,
    })),
  };
}

/**
 * Pair systolic + diastolic into one row per day. Days with only one
 * side measured are dropped — the Coach is asked about "BP" as a pair,
 * and a half-measured day would invite a fabricated complement.
 */
export function buildDailyBpRows(
  sysRows: Array<{ measuredAt: Date; value: number }>,
  diaRows: Array<{ measuredAt: Date; value: number }>,
  recentCutoff: Date,
  tz: string,
): DailyBpRow[] {
  const sysRecent = sysRows.filter((r) => r.measuredAt >= recentCutoff);
  const diaRecent = diaRows.filter((r) => r.measuredAt >= recentCutoff);
  const sysByDay = dailyMeans(sysRecent, tz);
  const diaByDay = dailyMeans(diaRecent, tz);
  const out: DailyBpRow[] = [];
  for (const [day, info] of sysByDay) {
    const dia = diaByDay.get(day);
    if (!dia) continue;
    const sysMean = info.values.reduce((s, v) => s + v, 0) / info.values.length;
    const diaMean = dia.values.reduce((s, v) => s + v, 0) / dia.values.length;
    out.push({
      date: day,
      weekday: tzWeekday(info.date, tz),
      sys: Math.round(sysMean),
      dia: Math.round(diaMean),
    });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * v1.22 (W6) — the user's own usual range for one BP component, computed from
 * the rows already fetched for the snapshot (no extra DB read) using the SAME
 * median ± k·MAD statistic as the baseline engine. Returns null below the
 * engine's 7-day history floor so the Coach never quotes a fabricated band.
 */
export function bpBandFromRows(
  rows: ReadonlyArray<{ measuredAt: Date; value: number }>,
  type: "BLOOD_PRESSURE_SYS" | "BLOOD_PRESSURE_DIA",
  tz: string,
): { low: number; high: number } | null {
  const byDay = new Map<string, { sum: number; count: number }>();
  for (const r of rows) {
    // The user's day, like every other day mean in the snapshot.
    const day = tzDayKey(r.measuredAt, tz);
    const acc = byDay.get(day) ?? { sum: 0, count: 0 };
    acc.sum += r.value;
    acc.count += 1;
    byDay.set(day, acc);
  }
  const dayMeans = [...byDay.values()].map((a) => a.sum / a.count);
  if (dayMeans.length < 7) return null;
  const band = buildBaselineBand(dayMeans, type);
  if (!band) return null;
  return { low: Math.round(band.low), high: Math.round(band.high) };
}

/**
 * Resolve the working scope. The explicit request `scope.sources`
 * always wins as the maximum set (an iOS client can pin an exact
 * list). When it is absent the builder expands the user's saved
 * `dataClusters` instead — `clusterDefault` carries that expansion.
 * When neither is present (no prefs row at all, legacy native client)
 * the cluster resolver still returns `DEFAULT_COACH_CLUSTERS`, so the
 * legacy five domains stay the floor.
 *
 * v1.7.0 — replaces the constant `DEFAULT_SOURCES` fallback with the
 * cluster expansion threaded in by `buildCoachSnapshotImpl`.
 */
export function resolveScope(
  scope: CoachScope | undefined,
  clusterDefault: ReadonlySet<CoachScopeSource>,
): {
  sources: ReadonlySet<CoachScopeSource>;
  window: CoachScopeWindow;
} {
  const sources =
    scope?.sources && scope.sources.length > 0
      ? new Set(scope.sources)
      : clusterDefault;
  return {
    sources,
    window: scope?.window ?? DEFAULT_WINDOW,
  };
}
