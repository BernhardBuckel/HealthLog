/**
 * v1.26.0 — pg-boss queue + boot-time self-converging backfill for newly
 * connected Google Health accounts. Modelled on the Fitbit / WHOOP backfill
 * (`src/lib/jobs/fitbit-backfill.ts`): a discovery query enqueues one job per
 * connection that has NOT yet been backfilled, and the pass is idempotent
 * across reboots (the predicate `backfill_completed_at IS NULL` drops a
 * connection once its backfill finishes).
 *
 * The queue name MUST be registered in `allQueues` in
 * `src/lib/jobs/reminder/register-integration-sync.ts` or pg-boss never
 * provisions it and the boot enqueue silently never drains (the v1.4.37
 * dead-queue class).
 */
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { annotate } from "@/lib/logging/context";
import { getGlobalBoss } from "@/lib/jobs/boss-instance";
import {
  enqueueIntegrationBackfillAdmission,
  INTEGRATION_BACKFILL_CONTINUATION_DELAY_SECONDS,
  integrationBackfillSourceOptions,
} from "@/lib/jobs/integration-backfill-admission";
import {
  readGoogleHealthBackfillDone,
  runWithGoogleHealthBackfillResume,
} from "@/lib/google-health/sync-core";
import {
  isGoogleHealthParked,
  syncUserGoogleHealth,
} from "@/lib/google-health/sync";
import { GOOGLE_HEALTH_SYNC_LOCK_WAIT_MS } from "@/lib/google-health/sync-lock";
import { runWithGoogleHealthStop } from "@/lib/google-health/client";

export const GOOGLE_HEALTH_BACKFILL_QUEUE = "google-health-backfill";

/**
 * Serial concurrency — a backfill walks years of history for one account and is
 * rate-bounded by Google's per-app quota; concurrency-1 keeps it from crowding
 * the request pool, matching `FITBIT_BACKFILL_CONCURRENCY`.
 */
export const GOOGLE_HEALTH_BACKFILL_CONCURRENCY = 1;

export interface GoogleHealthBackfillPayload {
  userId: string;
  enqueuedAt: string;
}

/**
 * Per-user backfill handler. Runs a full-history sync for one account and
 * stamps `backfillCompletedAt` ONLY on a clean run, so the discovery query
 * drops it. Idempotent: the per-resource upserts are key-stable, so a re-run
 * (e.g. a reboot mid-walk) overwrites rather than duplicating. Mirrors
 * `runFitbitBackfillForUser`.
 *
 * Verdict-gated: a partial hard failure (one collection 400ing, a write
 * failing) THROWS so pg-boss retries the job — stamping the marker over a
 * partial walk would freeze the gap in forever. A connection parked at
 * `error_reauth` is NOT clean either, but throwing against a dead grant would
 * just burn the retry budget on the same no-op: return WITHOUT stamping — the
 * boot discovery re-enqueues the account on the next boot, and the stamp lands
 * once the user reconnects and a clean walk completes.
 *
 * `shouldStop` is the admission job's budget (`jobBudget`). A per-minute
 * heart-rate history runs to thousands of pages, and the walk asks it before
 * every page: once it says stop, the walk ends where it is, the cycle reports
 * itself truncated, and this throws like any other incomplete run, without
 * the stamp. The rows already written stay.
 *
 * Resumable: every collection the walk finishes cleanly is noted in
 * `backfillProgress`, and the next attempt (the pg-boss retry, or the next
 * boot's discovery) skips those and walks only what is left
 * (`runWithGoogleHealthBackfillResume`). The note is cleared once the stamp
 * lands, and on every reconnect.
 *
 * Runs in slices: an attempt that ends before the whole history is in but
 * finished at least one more collection than it started with made progress.
 * It is not a failure: it sends the next slice (`slice + 1`) and returns
 * `continued`, without the error line or the queue's failure count. Only an
 * attempt that finished nothing new throws, because that one is stuck: the
 * pg-boss retry and, after it, the next boot take it from there. Progress is
 * bounded by the number of collections, so the chain of slices is too.
 *
 * Never beside another run of the same account: the sync takes the account's
 * lock, waiting a bounded time for an hourly or manual run to finish. If the
 * lock does not come free the attempt throws without doing anything, and the
 * retry tries again.
 */
export async function runGoogleHealthBackfillForUser(
  userId: string,
  shouldStop: () => boolean = () => false,
  slice: number = 0,
): Promise<{ imported: number; continued?: boolean }> {
  if (await isGoogleHealthParked(userId)) {
    annotate({
      action: {
        name: "google_health.backfill.skipped_reauth",
        details: { imported: 0 },
      },
    });
    return { imported: 0 };
  }

  const connection = await prisma.googleHealthConnection.findUnique({
    where: { userId },
    select: { backfillProgress: true, backfillCompletedAt: true },
  });
  if (connection?.backfillCompletedAt) {
    // A slice queued behind the one that finished the import, or a boot
    // delivery that raced it: the history is in, nothing to walk again.
    annotate({
      action: {
        name: "google_health.backfill.already_complete",
        details: { slice },
      },
    });
    return { imported: 0 };
  }
  const done = readGoogleHealthBackfillDone(connection?.backfillProgress);
  const doneBefore = done.size;

  const {
    result: { imported, failed, busy },
    skipped,
  } = await runWithGoogleHealthBackfillResume(userId, done, () =>
    runWithGoogleHealthStop(shouldStop, () =>
      syncUserGoogleHealth(userId, {
        fullSync: true,
        waitForLockMs: GOOGLE_HEALTH_SYNC_LOCK_WAIT_MS,
      }),
    ),
  );
  if (skipped.length > 0) {
    annotate({ meta: { "googleHealth.backfill.resumedPast": skipped } });
  }

  if (busy) {
    throw new Error(
      `google-health backfill for user ${userId} deferred: another sync of the account is running`,
    );
  }

  if (failed) {
    // `done` is the resume set this attempt added to as it finished
    // collections; a larger set than it started with is progress.
    const finished = done.size - doneBefore;
    if (finished > 0) {
      const boss = getGlobalBoss();
      const sent = boss
        ? await enqueueIntegrationBackfillAdmission(
            boss,
            {
              kind: "google-health-backfill",
              data: {
                userId,
                enqueuedAt: new Date().toISOString(),
                slice: slice + 1,
              },
            },
            INTEGRATION_BACKFILL_CONTINUATION_DELAY_SECONDS,
          )
        : null;
      if (sent) {
        annotate({
          action: {
            name: "google_health.backfill.continued",
            details: {
              imported,
              slice,
              collectionsFinished: finished,
              collectionsDone: done.size,
            },
          },
        });
        return { imported, continued: true };
      }
      // No follow-up could be queued; fall through to the retry path so the
      // work is not dropped.
    }
    // No collection finished in this attempt: the backfill is stuck, not
    // slow. Surface through the pg-boss retry path (retryLimit 3, backoff).
    // If the failure parked the connection at error_reauth meanwhile, the
    // next attempt takes the reauth return above instead of failing again.
    throw new Error(
      `google-health backfill incomplete for user ${userId} — marker not stamped`,
    );
  }

  await prisma.googleHealthConnection.update({
    where: { userId },
    data: { backfillCompletedAt: new Date(), backfillProgress: Prisma.DbNull },
  });

  annotate({
    action: {
      name: "google_health.backfill.complete",
      details: { imported },
    },
  });
  return { imported };
}

/**
 * Boot-time discovery. Finds every Google Health connection not yet backfilled
 * (`backfill_completed_at IS NULL`) and enqueues one backfill job per account.
 *
 * Idempotent across reboots: once a connection's backfill completes,
 * `backfillCompletedAt` is set and the predicate drops it from the discovery
 * set. pg-boss `singletonKey` coalesces duplicate sends so a fast restart while
 * a job is queued doesn't double up.
 *
 * Best-effort: errors are returned through the result value so the worker boot
 * never fails because of a backfill miss.
 */
export async function enqueueBootTimeGoogleHealthBackfill(
  startAfterSeconds: number = 0,
): Promise<{
  enqueued: number;
  skipped: number;
  error: string | null;
}> {
  const boss = getGlobalBoss();
  if (!boss) {
    return { enqueued: 0, skipped: 0, error: null };
  }

  try {
    const connections = await prisma.googleHealthConnection.findMany({
      where: { backfillCompletedAt: null },
      select: { userId: true },
    });

    if (connections.length === 0) {
      return { enqueued: 0, skipped: 0, error: null };
    }

    let enqueued = 0;
    let skipped = 0;
    for (const { userId } of connections) {
      const payload: GoogleHealthBackfillPayload = {
        userId,
        enqueuedAt: new Date().toISOString(),
      };
      const jobId = await boss.send(
        GOOGLE_HEALTH_BACKFILL_QUEUE,
        payload,
        integrationBackfillSourceOptions(
          `google-health-backfill|${userId}`,
          startAfterSeconds,
        ),
      );
      if (jobId) {
        enqueued += 1;
      } else {
        skipped += 1;
      }
    }
    return { enqueued, skipped, error: null };
  } catch (err) {
    return {
      enqueued: 0,
      skipped: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
