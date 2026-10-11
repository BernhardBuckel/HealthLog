/**
 * Pins the verdict gate of `runGoogleHealthBackfillForUser`: the
 * `backfillCompletedAt` marker may only be stamped after a CLEAN full-history
 * run. `syncUserGoogleHealth` swallows per-resource errors into its verdict —
 * before the gate, ANY run (partial hard failure, parked no-op) stamped the
 * marker and the pg-boss `retryLimit: 3` was dead code.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  prismaMock,
  syncUserGoogleHealthMock,
  isParkedMock,
  bossSend,
  resumeState,
} = vi.hoisted(() => ({
  prismaMock: {
    googleHealthConnection: {
      findMany: vi.fn(),
      findUnique: vi.fn(
        async (): Promise<{
          backfillProgress: unknown;
          backfillCompletedAt: Date | null;
        } | null> => null,
      ),
      update: vi.fn(),
    },
  },
  syncUserGoogleHealthMock: vi.fn(),
  isParkedMock: vi.fn(async () => false),
  bossSend: vi.fn(),
  // Collections the mocked walk "finishes" in this attempt, added to the
  // resume set the way `runGoogleHealthCollection` adds them.
  resumeState: { finishes: [] as string[], doneBefore: [] as string[] },
}));

vi.mock("@/lib/db", () => ({ prisma: prismaMock }));

vi.mock("@/lib/jobs/boss-instance", () => ({
  getGlobalBoss: () => ({ send: bossSend }),
}));

vi.mock("@/lib/logging/context", () => ({
  annotate: () => {},
  getEvent: () => null,
}));

const { safeFetchMock } = vi.hoisted(() => ({ safeFetchMock: vi.fn() }));
vi.mock("@/lib/safe-fetch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/safe-fetch")>();
  return { ...actual, safeFetch: safeFetchMock };
});

vi.mock("@/lib/google-health/sync-core", () => ({
  GOOGLE_HEALTH_INTEGRATION_KEY: "google-health",
  readGoogleHealthBackfillDone: () => new Set<string>(resumeState.doneBefore),
  runWithGoogleHealthBackfillResume: async (
    _userId: string,
    done: Set<string>,
    fn: () => Promise<unknown>,
  ) => {
    const result = await fn();
    for (const key of resumeState.finishes) done.add(key);
    return { result, skipped: [] };
  },
}));
vi.mock("@/lib/google-health/sync", () => ({
  isGoogleHealthParked: isParkedMock,
  syncUserGoogleHealth: (...a: unknown[]) => syncUserGoogleHealthMock(...a),
}));

import { runGoogleHealthBackfillForUser } from "../google-health-backfill";
import {
  GOOGLE_HEALTH_DATA_TYPES,
  forEachDataPointPage,
  runWithGoogleHealthClientOutcome,
} from "@/lib/google-health/client";

beforeEach(() => {
  vi.clearAllMocks();
  isParkedMock.mockResolvedValue(false);
  prismaMock.googleHealthConnection.update.mockResolvedValue({});
  prismaMock.googleHealthConnection.findUnique.mockResolvedValue(null);
  bossSend.mockResolvedValue("job-next");
  resumeState.finishes = [];
  resumeState.doneBefore = [];
});

describe("runGoogleHealthBackfillForUser — verdict-gated marker", () => {
  it("stamps backfillCompletedAt after a CLEAN full-history run", async () => {
    syncUserGoogleHealthMock.mockResolvedValue({ imported: 42, failed: false });

    const { imported } = await runGoogleHealthBackfillForUser("u1");

    expect(imported).toBe(42);
    expect(syncUserGoogleHealthMock).toHaveBeenCalledWith("u1", {
      fullSync: true,
      waitForLockMs: expect.any(Number),
    });
    const updateArg = prismaMock.googleHealthConnection.update.mock
      .calls[0]![0] as {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    };
    expect(updateArg.where).toEqual({ userId: "u1" });
    expect(updateArg.data.backfillCompletedAt).toBeInstanceOf(Date);
    // The resume note goes with the stamp: a later backfill starts over.
    expect(updateArg.data).toHaveProperty("backfillProgress");
  });

  it("throws without stamping when another sync of the account holds it", async () => {
    syncUserGoogleHealthMock.mockResolvedValue({
      imported: 0,
      failed: true,
      busy: true,
    });

    await expect(runGoogleHealthBackfillForUser("u1")).rejects.toThrow(
      /another sync of the account is running/,
    );
    expect(prismaMock.googleHealthConnection.update).not.toHaveBeenCalled();
  });

  it("a failed verdict THROWS without stamping — pg-boss retries become real", async () => {
    syncUserGoogleHealthMock.mockResolvedValue({ imported: 7, failed: true });

    await expect(runGoogleHealthBackfillForUser("u1")).rejects.toThrow(
      /incomplete/,
    );
    expect(prismaMock.googleHealthConnection.update).not.toHaveBeenCalled();
  });

  it("a connection parked at error_reauth returns WITHOUT running the sync or stamping", async () => {
    isParkedMock.mockResolvedValue(true);

    await expect(runGoogleHealthBackfillForUser("u1")).resolves.toEqual({
      imported: 0,
    });
    expect(syncUserGoogleHealthMock).not.toHaveBeenCalled();
    expect(prismaMock.googleHealthConnection.update).not.toHaveBeenCalled();
  });

  it("stops the walk when its budget runs out and throws without stamping", async () => {
    // An endless heart-rate stream: every page names a next one.
    safeFetchMock.mockImplementation(async () => ({
      status: 200,
      ok: true,
      json: async () => ({ dataPoints: [{}], nextPageToken: "more" }),
    }));
    // The real walk under the sync mock, reporting what the real sync reports
    // for a truncated resource.
    syncUserGoogleHealthMock.mockImplementation(async () => {
      const { outcome } = await runWithGoogleHealthClientOutcome(() =>
        forEachDataPointPage(
          GOOGLE_HEALTH_DATA_TYPES.heartRate,
          "token",
          "fetchHeartRate",
          { maxPages: 10_000 },
          () => {},
        ),
      );
      return { imported: outcome.fetched, failed: outcome.truncated };
    });
    let asked = 0;
    const shouldStop = () => ++asked > 3;

    await expect(
      runGoogleHealthBackfillForUser("u1", shouldStop),
    ).rejects.toThrow(/incomplete/);
    expect(safeFetchMock).toHaveBeenCalledTimes(3);
    expect(prismaMock.googleHealthConnection.update).not.toHaveBeenCalled();
  });
});

/**
 * A long history walks in slices. A slice that finished more collections than
 * it started with is progressing, not failing: it queues the next slice and
 * ends quietly, without the error line or the failure count. Only a slice that
 * finished nothing new is stuck and keeps throwing.
 */
describe("runGoogleHealthBackfillForUser — slices", () => {
  it("continues a progressing slice instead of failing it", async () => {
    resumeState.doneBefore = ["steps"];
    resumeState.finishes = ["sleep", "weight"];
    syncUserGoogleHealthMock.mockResolvedValue({ imported: 9, failed: true });

    await expect(
      runGoogleHealthBackfillForUser("u1", undefined, 2),
    ).resolves.toEqual({
      imported: 9,
      continued: true,
    });

    expect(bossSend).toHaveBeenCalledTimes(1);
    const [queue, payload, options] = bossSend.mock.calls[0]!;
    expect(queue).toBe("integration-backfill-admission");
    expect(payload).toMatchObject({
      kind: "google-health-backfill",
      data: { userId: "u1", slice: 3 },
    });
    // Its own key, so the exclusive policy does not swallow it while this
    // slice is still active.
    expect(options).toMatchObject({
      singletonKey: "google-health-backfill|u1|slice-3",
      startAfter: expect.any(Number),
    });
    // Not complete: no stamp.
    expect(prismaMock.googleHealthConnection.update).not.toHaveBeenCalled();
  });

  it("still throws for a slice that finished nothing new", async () => {
    resumeState.doneBefore = ["steps"];
    resumeState.finishes = [];
    syncUserGoogleHealthMock.mockResolvedValue({ imported: 3, failed: true });

    await expect(runGoogleHealthBackfillForUser("u1")).rejects.toThrow(
      /incomplete/,
    );
    expect(bossSend).not.toHaveBeenCalled();
  });

  it("throws rather than drop the work when the next slice cannot be queued", async () => {
    resumeState.finishes = ["sleep"];
    bossSend.mockResolvedValue(null);
    syncUserGoogleHealthMock.mockResolvedValue({ imported: 1, failed: true });

    await expect(runGoogleHealthBackfillForUser("u1")).rejects.toThrow(
      /incomplete/,
    );
  });

  it("stamps the marker on the slice that finishes the history", async () => {
    resumeState.doneBefore = ["steps", "sleep"];
    resumeState.finishes = ["weight"];
    syncUserGoogleHealthMock.mockResolvedValue({ imported: 4, failed: false });

    await expect(
      runGoogleHealthBackfillForUser("u1", undefined, 5),
    ).resolves.toEqual({
      imported: 4,
    });
    expect(bossSend).not.toHaveBeenCalled();
    expect(
      prismaMock.googleHealthConnection.update.mock.calls[0]![0].data
        .backfillCompletedAt,
    ).toBeInstanceOf(Date);
  });

  it("walks nothing again once an earlier slice completed the import", async () => {
    prismaMock.googleHealthConnection.findUnique.mockResolvedValue({
      backfillProgress: null,
      backfillCompletedAt: new Date(),
    });

    await expect(
      runGoogleHealthBackfillForUser("u1", undefined, 4),
    ).resolves.toEqual({
      imported: 0,
    });
    expect(syncUserGoogleHealthMock).not.toHaveBeenCalled();
  });
});
