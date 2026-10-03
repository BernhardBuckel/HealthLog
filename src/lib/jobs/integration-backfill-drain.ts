/**
 * The handler of the shared full-history admission queue.
 *
 * Every provider's backfill and repair reaches this one queue, and the worker
 * runs it one job at a time across the whole instance
 * (`register-integration-sync.ts`). Each job runs under two guards:
 *
 *   - The import lock (`withIntegrationBackfillLock`), keyed on the job's
 *     identity. A retry that pg-boss starts after the job's expiry while the
 *     first run is still going finds the lock taken and does nothing, so one
 *     account's import of one kind never runs twice at once.
 *   - The job's budget (`jobBudget`), handed to the runners that can stop
 *     part-way. A run that stops on its budget throws without stamping its
 *     completion marker, so it is retried, and after that the next boot's
 *     discovery offers it again.
 */
import type { Job } from "pg-boss";

import { runWhoopBackfillForUser } from "@/lib/jobs/whoop-backfill";
import { runFitbitBackfillForUser } from "@/lib/jobs/fitbit-backfill";
import { runGoogleHealthBackfillForUser } from "@/lib/jobs/google-health-backfill";
import { runGoogleHealthSleepRepairForUser } from "@/lib/jobs/google-health-sleep-repair";
import { runFitbitSleepRepairForUser } from "@/lib/jobs/fitbit-sleep-repair";
import { runStravaBackfillForUser } from "@/lib/jobs/strava-backfill";
import { runSleepTimelineBackfillForUser } from "@/lib/jobs/sleep-timeline-backfill";
import { runLabBiomarkerBackfillForUser } from "@/lib/jobs/lab-biomarker-backfill";
import {
  integrationBackfillAdmissionSingletonKey,
  type IntegrationBackfillAdmissionPayload,
} from "@/lib/jobs/integration-backfill-admission";
import { withIntegrationBackfillLock } from "@/lib/jobs/integration-backfill-lock";
import { jobBudget } from "@/lib/jobs/job-budget";
import { jobDone, type JobOutcome } from "@/lib/jobs/job-outcome";
import { workerLog } from "@/lib/jobs/reminder/shared";
import { withBackgroundEvent } from "@/lib/logging/background";

interface RunCounts {
  imported: number;
  removed: number;
  deleted: number;
  markers: number;
  linked: number;
}

async function runAdmitted(
  payload: IntegrationBackfillAdmissionPayload,
  shouldStop: () => boolean,
  totals: RunCounts,
): Promise<void> {
  const { kind, data } = payload;
  const { userId } = data;
  switch (kind) {
    case "whoop-backfill": {
      const { imported } = await runWhoopBackfillForUser(userId);
      totals.imported += imported;
      workerLog("info", `[whoop-backfill] user=${userId} imported=${imported}`);
      return;
    }
    case "fitbit-backfill": {
      const { imported } = await runFitbitBackfillForUser(userId);
      totals.imported += imported;
      workerLog(
        "info",
        `[fitbit-backfill] user=${userId} imported=${imported}`,
      );
      return;
    }
    case "google-health-backfill": {
      const { imported } = await runGoogleHealthBackfillForUser(
        userId,
        shouldStop,
      );
      totals.imported += imported;
      workerLog(
        "info",
        `[google-health-backfill] user=${userId} imported=${imported}`,
      );
      return;
    }
    case "google-health-sleep-repair": {
      const { imported } = await runGoogleHealthSleepRepairForUser(userId);
      totals.imported += imported;
      workerLog(
        "info",
        `[google-health-sleep-repair] user=${userId} imported=${imported}`,
      );
      return;
    }
    case "fitbit-sleep-repair": {
      const { imported, removed } = await runFitbitSleepRepairForUser(userId);
      totals.imported += imported;
      totals.removed += removed;
      workerLog(
        "info",
        `[fitbit-sleep-repair] user=${userId} imported=${imported} removed=${removed}`,
      );
      return;
    }
    case "sleep-timeline-backfill": {
      if (!data.provider) {
        throw new Error(
          "sleep-timeline backfill admission requires a provider",
        );
      }
      const { deleted, imported } = await runSleepTimelineBackfillForUser(
        userId,
        data.provider,
      );
      totals.deleted += deleted;
      totals.imported += imported;
      workerLog(
        "info",
        `[sleep-timeline-backfill] user=${userId} provider=${data.provider} deleted=${deleted} imported=${imported}`,
      );
      return;
    }
    case "lab-biomarker-backfill": {
      const { markers, linked } = await runLabBiomarkerBackfillForUser(
        userId,
        shouldStop,
      );
      totals.markers += markers;
      totals.linked += linked;
      workerLog(
        "info",
        `[lab-biomarker-backfill] user=${userId} markers=${markers} linked=${linked}`,
      );
      return;
    }
    case "strava-backfill": {
      const { imported } = await runStravaBackfillForUser(userId);
      totals.imported += imported;
      workerLog(
        "info",
        `[strava-backfill] user=${userId} imported=${imported}`,
      );
      return;
    }
  }
}

/**
 * Drain a batch of admission jobs. There is no per-job error isolation: a
 * runner that throws fails the job and the admission retry policy applies. So
 * reaching the end means every admitted job either did its work or found its
 * import already running, and the counts each runner returns are what the
 * pass reports.
 */
export async function drainIntegrationBackfillAdmission(
  jobs: Job<IntegrationBackfillAdmissionPayload>[],
): Promise<JobOutcome> {
  const shouldStop = jobBudget(jobs);
  const totals: RunCounts = {
    imported: 0,
    removed: 0,
    deleted: 0,
    markers: 0,
    linked: 0,
  };
  let alreadyRunning = 0;
  for (const job of jobs) {
    const identity = integrationBackfillAdmissionSingletonKey(job.data);
    const run = await withIntegrationBackfillLock(identity, () =>
      runAdmitted(job.data, shouldStop, totals),
    );
    if (!run.ran) {
      alreadyRunning += 1;
      await withBackgroundEvent(
        "integration_backfill.already_running",
        async (event) => {
          event.addMeta("identity", identity);
          event.addMeta("job_id", job.id);
          event.addMeta(
            "reason",
            "an earlier delivery of this import still holds its lock; this delivery does nothing",
          );
          event.elevateLevel("warn");
        },
      );
    }
  }
  return jobDone({
    jobs: jobs.length,
    already_running: alreadyRunning,
    imported: totals.imported,
    removed: totals.removed,
    deleted: totals.deleted,
    markers: totals.markers,
    linked: totals.linked,
  });
}
