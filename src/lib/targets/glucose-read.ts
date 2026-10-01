/**
 * The glucose rows the targets page needs, folded in Postgres.
 *
 * The glucose targets used to read every glucose reading of the last year and
 * keep three things from them per meal context: the newest value, and for the
 * last thirty days each local day's mean and the number of readings. A sensor
 * that reports every five minutes puts 105 000 readings in that year, and the
 * targets page is read on every visit, on the web and in the app. So the year
 * is reduced to one row per context (`DISTINCT ON`) and the thirty days to one
 * row per context and local day, and only those rows cross the wire.
 *
 * Output matches {@link foldGlucoseTargetRows} over the raw readings: the same
 * newest value per context (ties broken by id, newest first), and the same
 * per-day sums and counts, with days cut in the zone the caller passes by the
 * expression every other day fold uses.
 */
import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import type { GlucoseContext } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { isValidTimezone, userDayKey } from "@/lib/tz/format";
import type { TargetGlucoseRow } from "./types";

/** One meal context's newest reading and its last thirty days, per day. */
export interface TargetGlucoseContextSummary {
  glucoseContext: GlucoseContext | null;
  latest: number;
  latestAt: Date;
  /** Local day → the day's readings as sum and count, since `recentSince`. */
  recentByDay: Map<string, { sum: number; count: number }>;
  /** Readings behind `recentByDay`. */
  recentCount: number;
}

/**
 * The in-memory fold over raw readings, newest first. Pure; the reference the
 * SQL reader is tested against.
 */
export function foldGlucoseTargetRows(
  rows: readonly TargetGlucoseRow[],
  recentSince: Date,
  timeZone: string,
): TargetGlucoseContextSummary[] {
  const byContext = new Map<string, TargetGlucoseContextSummary>();
  for (const row of rows) {
    const key = row.glucoseContext ?? "";
    let summary = byContext.get(key);
    if (!summary) {
      summary = {
        glucoseContext: row.glucoseContext,
        latest: row.value,
        latestAt: row.measuredAt,
        recentByDay: new Map(),
        recentCount: 0,
      };
      byContext.set(key, summary);
    }
    if (row.measuredAt < recentSince) continue;
    const day = userDayKey(row.measuredAt, timeZone);
    const bucket = summary.recentByDay.get(day) ?? { sum: 0, count: 0 };
    bucket.sum += row.value;
    bucket.count += 1;
    summary.recentByDay.set(day, bucket);
    summary.recentCount += 1;
  }
  return [...byContext.values()];
}

export async function readGlucoseTargetSummaries(opts: {
  userId: string;
  /** Inclusive lower bound for the newest reading per context. */
  since: Date;
  /** Inclusive lower bound for the per-day fold. */
  recentSince: Date;
  /** IANA zone the day boundary is cut in. */
  timeZone: string;
  db?: Pick<PrismaClient, "$queryRaw">;
}): Promise<TargetGlucoseContextSummary[]> {
  const db = opts.db ?? prisma;
  const timeZone = isValidTimezone(opts.timeZone) ? opts.timeZone : "UTC";
  const [latestRows, dayRows] = await Promise.all([
    db.$queryRaw<
      Array<{
        glucose_context: GlucoseContext | null;
        value: number;
        measured_at: Date;
      }>
    >(Prisma.sql`
      SELECT DISTINCT ON (m."glucose_context")
        m."glucose_context" AS glucose_context,
        m."value"           AS value,
        m."measured_at"     AS measured_at
      FROM measurements m
      WHERE m."user_id" = ${opts.userId}
        AND m."type" = 'BLOOD_GLUCOSE'::measurement_type
        AND m."deleted_at" IS NULL
        AND m."measured_at" >= ${opts.since}
      ORDER BY m."glucose_context", m."measured_at" DESC, m."id" DESC
    `),
    db.$queryRaw<
      Array<{
        glucose_context: GlucoseContext | null;
        day: string;
        n: number;
        sum: number;
      }>
    >(Prisma.sql`
      WITH src AS (
        SELECT
          m."glucose_context" AS glucose_context,
          to_char((m."measured_at" AT TIME ZONE 'UTC') AT TIME ZONE ${timeZone}, 'YYYY-MM-DD') AS day,
          m."value" AS value
        FROM measurements m
        WHERE m."user_id" = ${opts.userId}
          AND m."type" = 'BLOOD_GLUCOSE'::measurement_type
          AND m."deleted_at" IS NULL
          AND m."measured_at" >= ${opts.recentSince}
      )
      SELECT
        glucose_context,
        day,
        COUNT(*)::int                AS n,
        SUM(value)::double precision AS sum
      FROM src
      GROUP BY glucose_context, day
    `),
  ]);

  const byContext = new Map<string, TargetGlucoseContextSummary>();
  for (const row of latestRows) {
    byContext.set(row.glucose_context ?? "", {
      glucoseContext: row.glucose_context,
      latest: Number(row.value),
      latestAt: row.measured_at,
      recentByDay: new Map(),
      recentCount: 0,
    });
  }
  for (const row of dayRows) {
    // Every recent reading is also inside the year, so its context has a
    // newest row unless `recentSince` predates `since`, which no caller does.
    const summary = byContext.get(row.glucose_context ?? "");
    if (!summary) continue;
    const n = Number(row.n);
    summary.recentByDay.set(row.day, { sum: Number(row.sum), count: n });
    summary.recentCount += n;
  }
  return [...byContext.values()];
}
