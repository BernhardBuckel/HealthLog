/**
 * v1.21.0 (FDREXTEND) — daily-series builders for the two cross-metric channels
 * the FDR correlation matrix could not previously see: medication compliance
 * and symptom severity.
 *
 * These are the SPARSEST, noisiest inputs in the system, so the builders are
 * deliberately conservative:
 *
 *  - **Compliance** is the per-day adherence rate (0–100) from the compliance
 *    engine's unified dose-history ledger. Only days the cadence ACTUALLY
 *    expected a dose produce a point (off-cadence / off-week days emit nothing),
 *    so a sparse schedule never fabricates a 0%-or-100% point on a day it did
 *    not dose. The ledger's `at` instant is re-keyed to the user's display tz
 *    here (the engine's `dailyComplianceRatesFromLedger` keys in fixed Berlin),
 *    so the day-key basis aligns with every other discovery series.
 *
 *  - **Symptom severity** is the illness day-log functional-impact / symptom
 *    burden (0–3). The logged days are SPARSE and, on their own, often
 *    constant (a short flare logged at impact 2 for three days is a flat line
 *    with no variance — Pearson cannot use it). To make the actionable
 *    "adherence dip → symptom flare" link discoverable we zero-fill HEALTHY
 *    days, but ONLY across the span of the user's real episodes (onset →
 *    resolved/window-end) intersected with the window. A user who never logs an
 *    illness episode yields an EMPTY series, so the channel DEGRADES TO ABSENT
 *    rather than to a spurious all-zero constant. Within an episode span, days
 *    the user didn't log are treated as 0 (healthy) — the same constant-0
 *    healthy baseline the recovery-gap symptom track already uses.
 *
 * Both series then flow UNCHANGED through `discoverCorrelations` — the n ≥ 20
 * paired-day floor, the BH-FDR control, the effect-size floor, and the
 * James-Stein shrinkage all apply exactly as they do to every vital channel.
 * Nothing here computes a statistic; these are pure series shapers.
 *
 * Pure over already-fetched rows — the DB reads live in the caller (the route),
 * mirroring how the engine itself is pure over `NamedSeries[]`.
 */
import { dayKeyForUserTz } from "@/lib/measurements/consolidation-tz";
import { shiftDateKey } from "@/lib/tz/format";
import type { DoseHistoryRow } from "@/lib/medications/scheduling/dose-history";
import {
  MEDICATION_COMPLIANCE_CHANNEL_KEY,
  SYMPTOM_SEVERITY_CHANNEL_KEY,
  type DailySeriesPoint,
  type NamedSeries,
} from "@/lib/insights/correlation-discovery";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Build the daily MEDICATION_COMPLIANCE behaviour series from the user's pooled
 * dose-history ledger rows (every medication's `slot` rows over the window).
 *
 * One point per calendar day (user tz) that had at least one scheduled,
 * resolved slot (`taken_on_time` / `taken_late` / `missed`). The rate is the
 * day's pooled `taken / (taken + missed)`, 0–100 — the SAME numerator /
 * denominator the window tally uses. `skipped` (deliberate), `upcoming` (window
 * not open), and `ad_hoc` (off-schedule top-up) rows never enter the day's
 * counts, exactly as the engine excludes them, so a day whose only rows are
 * skips emits no point (no fabricated 0%).
 *
 * Returns a behaviour `NamedSeries`. When no day clears the slot test the
 * `points` array is empty — the discovery loop then drops the channel (it
 * cannot clear the n ≥ 20 floor), so the channel degrades to absent.
 */
export function buildComplianceDailySeries(
  ledgerRows: DoseHistoryRow[],
  tz: string,
): NamedSeries {
  const byDay = new Map<string, { taken: number; missed: number }>();
  for (const row of ledgerRows) {
    // Only scheduled slots have a defensible denominator (ad-hoc top-ups are
    // excluded from the rate exactly as the ledger tally excludes them).
    if (row.kind !== "slot") continue;
    const isTaken =
      row.status === "taken_on_time" || row.status === "taken_late";
    const isMissed = row.status === "missed";
    if (!isTaken && !isMissed) continue;

    const day = dayKeyForUserTz(row.at, tz);
    const bucket = byDay.get(day) ?? { taken: 0, missed: 0 };
    if (isTaken) bucket.taken += 1;
    else bucket.missed += 1;
    byDay.set(day, bucket);
  }

  const points: DailySeriesPoint[] = [];
  for (const [day, { taken, missed }] of byDay) {
    const denom = taken + missed;
    if (denom === 0) continue;
    points.push({ day, value: Math.min(100, (taken / denom) * 100) });
  }
  points.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  return {
    key: MEDICATION_COMPLIANCE_CHANNEL_KEY,
    role: "behaviour",
    points,
  };
}

/** A logged symptom-burden day (already keyed in the user's local tz). */
export interface SymptomDayLogRow {
  /** Stored `date` string — already a user-tz `YYYY-MM-DD` day key. */
  day: string;
  /** The day's burden (0–3): functionalImpact, else max linked severity. */
  impact: number;
}

/** An episode's active span (instants), used to bound the healthy-day fill. */
export interface SymptomEpisodeSpan {
  onsetAt: Date;
  /** NULL = ongoing → bounded by the window end at build time. */
  resolvedAt: Date | null;
}

/** Inclusive `YYYY-MM-DD` day key for an instant in the user's tz. */
function dayKey(at: Date, tz: string): string {
  return dayKeyForUserTz(at, tz);
}

/**
 * Build the daily SYMPTOM_SEVERITY series (rides both roles; this returns it in
 * the requested `role`). Healthy days are zero-filled — but ONLY across the
 * span of the user's real episodes intersected with `[windowStart, windowEnd]`,
 * so a user with no episodes yields an EMPTY series (the channel degrades to
 * absent, never a spurious all-zero constant).
 *
 * Algorithm:
 *  1. Compute the set of in-window calendar days covered by ANY episode span
 *     (onset → resolved, an ongoing episode clamped to `windowEnd`). This is
 *     the only span where a "healthy = 0" claim is defensible: the user was in
 *     a logging-relevant period.
 *  2. Initialise every such day to 0 (healthy baseline).
 *  3. Overlay the logged impacts (a day logged at impact k → k; multiple logs
 *     on a day → the MAX, the most-symptomatic reading).
 *
 * The result is a dense-within-episode-spans series with genuine 0↔>0 variance
 * when the user had symptomatic days, and NOTHING at all when they had no
 * episodes. Pure.
 */
export function buildSymptomSeverityDailySeries(args: {
  dayLogs: SymptomDayLogRow[];
  episodes: SymptomEpisodeSpan[];
  tz: string;
  windowStart: Date;
  windowEnd: Date;
  role: "behaviour" | "outcome";
}): NamedSeries {
  const { dayLogs, episodes, tz, windowStart, windowEnd, role } = args;

  const startKey = dayKey(windowStart, tz);
  const endKey = dayKey(windowEnd, tz);

  // Step 1+2 — zero-fill the healthy baseline across episode spans (clamped to
  // the window). An episode with no in-window days contributes nothing.
  const byDay = new Map<string, number>();
  for (const ep of episodes) {
    const epStart = ep.onsetAt.getTime();
    const epEnd = (ep.resolvedAt ?? windowEnd).getTime();
    // Clamp the iteration to the window so we never fabricate days outside it.
    const from = Math.max(epStart, windowStart.getTime());
    const to = Math.min(epEnd, windowEnd.getTime());
    if (from > to) continue;
    // Walk calendar days from `from` to `to`, keying each in the user's tz.
    // Step by a day in ms; the tz-key collapses any DST hour drift to the
    // right local day (we never index by the raw ms, only by the day key).
    for (let t = from; t <= to + MS_PER_DAY; t += MS_PER_DAY) {
      const key = dayKey(new Date(t), tz);
      if (key < startKey || key > endKey) continue;
      if (!byDay.has(key)) byDay.set(key, 0);
      if (key === endKey) break;
    }
  }

  // If no episode put a single day on the board, the channel is absent.
  if (byDay.size === 0) {
    return { key: SYMPTOM_SEVERITY_CHANNEL_KEY, role, points: [] };
  }

  // Step 3 — overlay logged impacts (MAX per day). A logged day outside every
  // episode span is still honoured (it is, by definition, a symptomatic day the
  // user recorded), so it joins the series even if the span walk missed it.
  for (const log of dayLogs) {
    if (log.day < startKey || log.day > endKey) continue;
    if (!Number.isFinite(log.impact)) continue;
    const prev = byDay.get(log.day);
    byDay.set(log.day, prev == null ? log.impact : Math.max(prev, log.impact));
  }

  const points: DailySeriesPoint[] = [...byDay.entries()]
    .map(([day, value]) => ({ day, value }))
    .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));

  return { key: SYMPTOM_SEVERITY_CHANNEL_KEY, role, points };
}

/** One occurrence of a person-defined symptom, as the builder reads it. */
export interface SymptomEventRow {
  at: Date;
  intensity: number;
}

/**
 * Build one `SYMPTOM:<definitionId>` outcome series from that symptom's
 * occurrences (v1.40).
 *
 * The daily value is the day's HIGHEST intensity (0-10) in the person's zone:
 * two attacks in a day are as bad as the worse one. Days with no occurrence
 * are 0, but only between the first and the last logged day: inside that span
 * the person was tracking the symptom and its absence is a real zero, outside
 * it nothing says whether they were tracking at all. One logged day yields a
 * one-point series, which the n >= 20 floor then drops. Pure.
 */
export function buildSymptomEventDailySeries(args: {
  key: string;
  label: string | undefined;
  events: SymptomEventRow[];
  tz: string;
}): NamedSeries {
  const { key, label, events, tz } = args;
  const byDay = new Map<string, number>();
  for (const event of events) {
    if (!Number.isFinite(event.intensity)) continue;
    const day = dayKey(event.at, tz);
    const prev = byDay.get(day);
    byDay.set(
      day,
      prev == null ? event.intensity : Math.max(prev, event.intensity),
    );
  }
  const keys = [...byDay.keys()].sort();
  const points: DailySeriesPoint[] = [];
  if (keys.length > 0) {
    const last = keys[keys.length - 1];
    for (let day = keys[0]; day <= last; day = shiftDateKey(day, 1)) {
      points.push({ day, value: byDay.get(day) ?? 0 });
    }
  }
  return {
    key,
    ...(label !== undefined ? { label } : {}),
    role: "outcome",
    points,
  };
}
