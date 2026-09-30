/**
 * The full-history admission lane against a real pg-boss on a real Postgres:
 * what happens to an import that runs past its job's expiry.
 *
 * pg-boss 12.34, measured with the lane's worker shape (localConcurrency 1,
 * groupConcurrency 1, exclusive policy, retries with backoff), a two-second
 * expiry, a one-second retry delay and a handler that ignores the abort
 * signal and runs for eight seconds:
 *
 *   +5ms     start #1 (job 1709c8a6…)   running=1
 *   +2008ms  abort signal #1
 *   +4051ms  start #2 (same job id)     running=2
 *   +6054ms  abort signal #2
 *   +8007ms  end #1                     running=1
 *   +9593ms  start #3 (same job id)     running=2
 *   +12053ms end #2
 *   +17595ms end #3
 *   +19166ms start #4 (same job id)     running=1
 *
 * At the expiry pg-boss fails the job, fires the signal, frees the worker and
 * group slots, and retries the job after its delay; the handler keeps going.
 * The retry then starts in the same worker beside the run it replaced, and
 * the lane's one-at-a-time holds for everything except the import too long
 * for its expiry. The first test keeps that as an executable statement about
 * pg-boss; the second runs the lane's own handler under the same conditions.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PgBoss, type Job } from "pg-boss";

const runner = vi.hoisted(() => ({
  running: 0,
  maxRunning: 0,
  calls: 0,
  holdMs: 8_000,
}));

vi.mock("@/lib/jobs/google-health-backfill", () => ({
  // Ignores the budget and the signal on purpose: the case the lock covers
  // is a run that does not stop when pg-boss gives up on it.
  runGoogleHealthBackfillForUser: async () => {
    runner.calls += 1;
    runner.running += 1;
    runner.maxRunning = Math.max(runner.maxRunning, runner.running);
    await new Promise((resolve) => setTimeout(resolve, runner.holdMs));
    runner.running -= 1;
    return { imported: 1 };
  },
}));

import {
  integrationBackfillAdmissionSendOptions,
  type IntegrationBackfillAdmissionPayload,
} from "@/lib/jobs/integration-backfill-admission";
import { drainIntegrationBackfillAdmission } from "@/lib/jobs/integration-backfill-drain";
import { withIntegrationBackfillLock } from "@/lib/jobs/integration-backfill-lock";
import { runJob } from "@/lib/jobs/run-job";

let boss: PgBoss;
const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

/** Short enough to cross in a test, the lane's shape otherwise. */
const EXPIRY_OVERRIDE = { expireInSeconds: 2, retryDelay: 1 } as const;

const WORK_OPTIONS = {
  localConcurrency: 1,
  groupConcurrency: 1,
  pollingIntervalSeconds: 0.5,
} as const;

const payload: IntegrationBackfillAdmissionPayload = {
  kind: "google-health-backfill",
  data: { userId: `lane-user-${suffix}`, enqueuedAt: new Date().toISOString() },
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  boss = new PgBoss({ connectionString: process.env.DATABASE_URL });
  await boss.start();
}, 120_000);

afterAll(async () => {
  await boss?.stop({ graceful: false });
});

describe("an import that outlives its expiry", () => {
  it("pg-boss starts the retry of the same job beside the run it expired", async () => {
    const queue = `lane-expiry-raw-${suffix}`;
    await boss.createQueue(queue, { policy: "exclusive" });
    const ids: string[] = [];
    let running = 0;
    let maxRunning = 0;
    await boss.work(queue, WORK_OPTIONS, async ([job]: Job<object>[]) => {
      ids.push(job!.id);
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      await sleep(8_000);
      running -= 1;
    });
    await boss.send(queue, payload, {
      ...integrationBackfillAdmissionSendOptions(payload),
      ...EXPIRY_OVERRIDE,
    });

    await sleep(12_000);
    await boss.offWork(queue);

    expect(ids.length).toBeGreaterThanOrEqual(2);
    expect(new Set(ids).size).toBe(1);
    expect(maxRunning).toBeGreaterThanOrEqual(2);
  }, 60_000);

  it("the lane's handler runs the import once while its retries find it running", async () => {
    const queue = `lane-expiry-drain-${suffix}`;
    await boss.createQueue(queue, { policy: "exclusive" });
    const handler = runJob(queue, drainIntegrationBackfillAdmission);
    const deliveries: string[] = [];
    await boss.work(
      queue,
      WORK_OPTIONS,
      async (jobs: Job<IntegrationBackfillAdmissionPayload>[]) => {
        deliveries.push(jobs[0]!.id);
        return handler(jobs);
      },
    );
    await boss.send(queue, payload, {
      ...integrationBackfillAdmissionSendOptions(payload),
      ...EXPIRY_OVERRIDE,
    });

    // The run holds for eight seconds; its retries arrive while it does.
    await sleep(7_000);
    await boss.offWork(queue);
    await sleep(2_000);

    expect(deliveries.length).toBeGreaterThanOrEqual(2);
    expect(runner.calls).toBe(1);
    expect(runner.maxRunning).toBe(1);
  }, 60_000);
});

describe("withIntegrationBackfillLock", () => {
  it("admits one run per identity, others alongside, and the next once it ends", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const first = withIntegrationBackfillLock("kind|a", () => held);
    await sleep(300);

    const same = await withIntegrationBackfillLock("kind|a", async () => 1);
    const other = await withIntegrationBackfillLock("kind|b", async () => 2);
    expect(same).toEqual({ ran: false });
    expect(other).toEqual({ ran: true, result: 2 });

    release();
    await first;
    const after = await withIntegrationBackfillLock("kind|a", async () => 3);
    expect(after).toEqual({ ran: true, result: 3 });
  });

  it("releases the lock when the run throws", async () => {
    await expect(
      withIntegrationBackfillLock("kind|c", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const after = await withIntegrationBackfillLock("kind|c", async () => 4);
    expect(after).toEqual({ ran: true, result: 4 });
  });
});
