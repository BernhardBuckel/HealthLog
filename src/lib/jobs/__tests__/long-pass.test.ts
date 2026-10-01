/**
 * `lockedPass`: each job runs under the lock `job:<queue>:<identity>`, and a
 * delivery that finds the lock held does no work and succeeds.
 *
 * The lock itself (a session advisory lock on a connection of its own) is
 * exercised against Postgres in
 * `tests/integration/integration-backfill-lane-expiry.test.ts`; this pins the
 * wrapper around it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Job } from "pg-boss";

const held = vi.hoisted(() => new Set<string>());
const keys = vi.hoisted(() => [] as string[]);

vi.mock("@/lib/jobs/job-lock", () => ({
  withJobLock: async <T>(key: string, run: () => Promise<T>) => {
    keys.push(key);
    if (held.has(key)) return { ran: false };
    held.add(key);
    try {
      return { ran: true, result: await run() };
    } finally {
      held.delete(key);
    }
  },
}));

import { jobDone, jobFailed } from "@/lib/jobs/job-outcome";
import { lockedPass, WHOLE_PASS } from "@/lib/jobs/long-pass";

type Payload = { userId?: string };
const job = (data: Payload) => ({ id: "j", data }) as Job<Payload>;

beforeEach(() => {
  held.clear();
  keys.length = 0;
});

describe("lockedPass", () => {
  it("runs each job under its queue and identity", async () => {
    const handler = vi.fn(async () => jobDone({ generated: 1 }));
    const bound = lockedPass(
      "q",
      (j: Job<Payload>) =>
        j.data.userId ? `user:${j.data.userId}` : WHOLE_PASS,
      handler,
    );
    const outcome = await bound([job({ userId: "a" })]);
    expect(outcome).toEqual(jobDone({ generated: 1 }));
    await bound([job({})]);
    expect(keys).toEqual(["job:q:user:a", "job:q:pass"]);
  });

  it("does nothing beside a run that still holds the lock", async () => {
    held.add("job:q:pass");
    const handler = vi.fn(async () => jobDone());
    const outcome = await lockedPass("q", () => WHOLE_PASS, handler)([job({})]);
    expect(handler).not.toHaveBeenCalled();
    expect(outcome).toEqual(jobDone({ already_running: 1 }));
  });

  it("passes a failed outcome through", async () => {
    const failed = jobFailed("stopped early", undefined, {
      stopped_early: true,
    });
    const outcome = await lockedPass(
      "q",
      () => WHOLE_PASS,
      async () => failed,
    )([job({})]);
    expect(outcome).toBe(failed);
  });
});
