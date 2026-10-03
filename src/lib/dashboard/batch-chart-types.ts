/**
 * v1.30.9 — client-safe pure helpers shared by the dashboard's batched
 * chart-series read on BOTH sides of the render boundary.
 *
 * The dashboard fetches every visible non-sleep chart series in ONE batched
 * request keyed by `queryKeys.chartSeriesBatch(typesCsv, fromIso, toIso)`.
 * The RSC (`src/app/page.tsx`) prefetches that same batch into the dehydrated
 * TanStack cache; the client (`src/app/page-client.tsx`) reads it back on
 * mount. For the prefetch to land (not silently no-op into a client refetch)
 * the server-built key must be byte-identical to the client-built key.
 *
 * The key has two moving parts — the CSV type list and the ISO window — and
 * this module is the SINGLE source of truth for both, so server and client
 * cannot drift:
 *
 *  - `deriveBatchChartTypes(layout, summaries)` — both sides call this over the
 *    SAME snapshot payload (the server dehydrates the very snapshot the client
 *    reads), so the ordered type list, and therefore the CSV, is identical by
 *    construction.
 *  - `computeBatchWindow(now, timezone)` — the server computes the window ONCE
 *    from the profile timezone and threads it to the client as an RSC prop
 *    (`batchWindow`). The client adopts the prop verbatim, so no independent
 *    browser-vs-container computation can disagree by a millisecond or a zone.
 *    `computeLocalBatchWindow()` is the browser-local fallback for the
 *    prefetch-off / legacy / fail-soft paths where no prop arrives.
 *
 * Import-safe from the server RSC and the client component alike: pure, no
 * Prisma / db / `node:*` imports (only the client-safe `@/lib/tz` Intl
 * helpers and the layout type).
 */
import type { DashboardLayout } from "@/lib/dashboard-layout";
import { endOfLocalDayUtc } from "@/lib/charts/fetch-window";

/**
 * Day-span the batched dashboard series (`series-batch`) fetches. Threaded to
 * every chart as `preloadedCoverageDays` so a chart reads the batched slice
 * ONLY for a range tab whose window fits within it (7 / 30); the 90 / All tabs
 * exceed it and self-fetch the wider window. Hoisted here so page.tsx and
 * page-client share ONE constant and the window they build stays in lockstep.
 */
export const BATCH_COVERAGE_DAYS = 31;

/** Minimal structural view of a tile summary — only the data-floor count. */
type SummaryCount = { count?: number | null } | null | undefined;

/**
 * Derive the ordered set of measurement types the dashboard batches into one
 * series request, from widget CHART visibility (`layout`) AND the per-type
 * data floors (`summaries[TYPE].count > 0`).
 *
 * This is the single implementation of the block that used to live inline in
 * `page-client.tsx` — preserving insertion order (weight → BP sys → BP dia →
 * pulse-or-resting → bodyFat → steps), the `RESTING_HEART_RATE`-vs-`PULSE`
 * pick, and the visibility + count-floor gates. Note the chart gate does NOT
 * carry the workouts-module flag the steps *tile* has: this mirrors the
 * chart-row logic exactly, not the strip-tile logic.
 */
export function deriveBatchChartTypes(
  layout: DashboardLayout,
  summaries: Record<string, SummaryCount> | undefined,
): string[] {
  const isChartVisible = (id: string): boolean =>
    layout.widgets.find((widget) => widget.id === id)?.visible ?? false;
  const count = (type: string): number => summaries?.[type]?.count ?? 0;

  const hasWeight = count("WEIGHT") > 0;
  const hasBp =
    count("BLOOD_PRESSURE_SYS") > 0 || count("BLOOD_PRESSURE_DIA") > 0;
  const hasRestingHr = count("RESTING_HEART_RATE") > 0;
  const hasPulse = count("PULSE") > 0 || hasRestingHr;
  const hasBodyFat = count("BODY_FAT") > 0;
  const hasSteps = count("ACTIVITY_STEPS") > 0;

  const types: string[] = [];
  if (isChartVisible("weight") && hasWeight) types.push("WEIGHT");
  if (isChartVisible("bp") && hasBp) {
    types.push("BLOOD_PRESSURE_SYS");
    types.push("BLOOD_PRESSURE_DIA");
  }
  if (isChartVisible("pulse") && hasPulse) {
    types.push(hasRestingHr ? "RESTING_HEART_RATE" : "PULSE");
  }
  if (isChartVisible("bodyFat") && hasBodyFat) types.push("BODY_FAT");
  if (isChartVisible("steps") && hasSteps) types.push("ACTIVITY_STEPS");
  return types;
}

/** ISO window (`from`/`to` instants) bounding the batched series slice. */
export interface BatchWindow {
  from: string;
  to: string;
}

/**
 * The batched-series window computed from the PROFILE timezone. End-of-current-
 * day in any zone (derived from `now`) is always ≥ `now`, so today's rows are
 * always included regardless of the container's UTC clock. Used server-side and
 * threaded to the client as the `batchWindow` prop so the key matches exactly.
 */
export function computeBatchWindow(now: Date, timezone: string): BatchWindow {
  const to = endOfLocalDayUtc(now, timezone);
  const from = new Date(to.getTime() - BATCH_COVERAGE_DAYS * 86_400_000);
  return { from: from.toISOString(), to: to.toISOString() };
}

/**
 * Browser-local fallback window — the pre-prefetch client computation, kept
 * verbatim for the prefetch-off / legacy / fail-soft paths where no server
 * `batchWindow` prop arrives. Local end-of-day, minus `BATCH_COVERAGE_DAYS`.
 */
export function computeLocalBatchWindow(now: Date = new Date()): BatchWindow {
  const to = new Date(now);
  to.setHours(23, 59, 59, 999);
  const from = new Date(to.getTime() - BATCH_COVERAGE_DAYS * 86_400_000);
  return { from: from.toISOString(), to: to.toISOString() };
}
