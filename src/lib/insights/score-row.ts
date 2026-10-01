/**
 * v1.10.0 — computed scores (WX-C/E). Shared score-row helpers.
 *
 * The three nightly score engines (Recovery / Stress / Strain) all file one
 * `COMPUTED` Measurement row per user per scored day, keyed by the same
 * day-stamp triplet (a `prefix:YYYY-MM-DD` externalId, a noon-UTC
 * `measuredAt`, the UTC day key) and written through the same idempotent
 * `(userId, type, source, externalId)` upsert. Before this module each engine
 * carried a byte-identical copy of that triplet + upsert, differing only by
 * the `prefix` / `type` literal.
 *
 * SCORED DAY = THE PREVIOUS UTC DAY. The crons fire ~03:xx UTC (04:45–04:55
 * Europe/Berlin). At that moment the CURRENT UTC day is only a few hours old:
 * the Strain engine would miss the just-completed day's workouts and the
 * Stress engine would see a near-empty intra-day SDNN set and gate as
 * `insufficient`. Every engine therefore scores the day that just ENDED —
 * `now − 1 day` — resolved once, here, so the externalId / measuredAt / day
 * key can never drift between the three.
 *
 * `scoreDayKey` / `scoreMeasuredAt` / `scoreExternalId` are pure (no Prisma)
 * so the engines' day-stamp tests can drive them directly; `upsertScoreRow`
 * takes the (worker) client.
 */
import type { MeasurementType, PrismaClient } from "@/generated/prisma/client";
import { annotate } from "@/lib/logging/context";
import { afterMeasurementMutation } from "@/lib/rollups/after-measurement-mutation";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * The UTC calendar day a score run scores — the PREVIOUS day relative to
 * `now`. The cron runs in the small hours; the just-completed day is the one
 * with a full set of signals, so we resolve `now − 1 day` and take its UTC
 * `YYYY-MM-DD`. Resolved in ONE place so all three engines agree.
 */
export function scoreDayKey(now: Date): string {
  // eslint-disable-next-line healthlog/no-utc-day-key -- UTC by design: the derived-score engines score UTC days, resolved here in one place (see the doc comment)
  return new Date(now.getTime() - MS_PER_DAY).toISOString().slice(0, 10);
}

/**
 * The canonical timestamp a stored score row carries: noon UTC on the scored
 * (previous) day. Noon (not midnight) keeps the row inside its own UTC day
 * under any reasonable display-timezone offset, mirroring the daily-stats
 * convention so a chart never mis-buckets the point at a day boundary.
 */
export function scoreMeasuredAt(now: Date): Date {
  return new Date(`${scoreDayKey(now)}T12:00:00.000Z`);
}

/**
 * The full per-day idempotency-key `externalId` for a score row:
 * `prefix:YYYY-MM-DD` over the scored (previous) day. `prefix` carries its
 * own trailing colon (`recovery:` / `stress:` / `strain:`).
 */
export function scoreExternalId(prefix: string, now: Date): string {
  return `${prefix}${scoreDayKey(now)}`;
}

/**
 * Upsert one user's score row for the scored day. Idempotent on the
 * `(userId, type, source = COMPUTED, externalId)` key so a re-fired cron tick
 * (or a manual re-run) overwrites the day's row in place rather than minting a
 * duplicate. The three engines differ only by `type` + `externalId` prefix;
 * everything else (source, unit, the noon-UTC `measuredAt`) is shared.
 */
export async function upsertScoreRow(
  prisma: PrismaClient,
  args: {
    userId: string;
    type: MeasurementType;
    externalIdPrefix: string;
    score: number;
    now: Date;
  },
): Promise<void> {
  const externalId = scoreExternalId(args.externalIdPrefix, args.now);
  const measuredAt = scoreMeasuredAt(args.now);

  await prisma.measurement.upsert({
    where: {
      userId_type_source_externalId: {
        userId: args.userId,
        type: args.type,
        source: "COMPUTED",
        externalId,
      },
    },
    create: {
      userId: args.userId,
      type: args.type,
      source: "COMPUTED",
      value: args.score,
      unit: "score",
      measuredAt,
      externalId,
    },
    update: {
      value: args.score,
      measuredAt,
    },
  });

  // v1.37.19 (A6-13) — a score row is a Measurement like any other: route
  // it through the shared post-mutation tail so the (type, day) rollup
  // bucket and the cached status assessment converge on the same tick that
  // wrote the score, instead of waiting for a discovery pass.
  await afterMeasurementMutation(args.userId, [
    { type: args.type, measuredAt },
  ]);
}

/** The tally every score pass returns. */
export interface ScoreBatchResult {
  considered: number;
  stored: number;
  insufficient: number;
  errored: number;
}

/**
 * Run one score pass over a candidate cohort. Each user is scored
 * independently through `persistFn`; a single user's error is recorded and
 * the pass continues (one bad account never blocks the cohort). Emits the
 * pass tally under `actionName`. This is the identical loop the three nightly
 * jobs each carried — only the persist function + the annotate action name
 * differed.
 */
export async function runScoreBatch(
  userIds: string[],
  now: Date,
  persistFn: (
    userId: string,
    now: Date,
  ) => Promise<{ outcome: "stored" | "insufficient" }>,
  actionName: string,
): Promise<ScoreBatchResult> {
  let stored = 0;
  let insufficient = 0;
  let errored = 0;
  for (const userId of userIds) {
    try {
      const result = await persistFn(userId, now);
      if (result.outcome === "stored") stored += 1;
      else insufficient += 1;
    } catch {
      errored += 1;
    }
  }

  annotate({
    action: {
      name: actionName,
      details: { considered: userIds.length, stored, insufficient, errored },
    },
  });

  return { considered: userIds.length, stored, insufficient, errored };
}
