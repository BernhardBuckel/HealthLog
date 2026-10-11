/**
 * A collection counts toward a backfill's progress only once its resume note
 * is written. The job reads the size of `done` as progress and queues another
 * slice on it, so a key added before a write that failed would let a chain of
 * slices "progress" over the same collection without end.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock, warnings } = vi.hoisted(() => ({
  prismaMock: {
    googleHealthConnection: { update: vi.fn() },
  },
  warnings: [] as string[],
}));

vi.mock("@/lib/db", () => ({ prisma: prismaMock }));
vi.mock("@/lib/logging/context", () => ({
  annotate: () => {},
  getEvent: () => ({ addWarning: (w: string) => warnings.push(w) }),
}));

import {
  runGoogleHealthCollection,
  runWithGoogleHealthBackfillResume,
} from "../sync-core";

beforeEach(() => {
  vi.clearAllMocks();
  warnings.length = 0;
});

describe("runGoogleHealthCollection under a backfill", () => {
  it("adds a clean collection to done once its note is written", async () => {
    prismaMock.googleHealthConnection.update.mockResolvedValue({});
    const done = new Set<string>(["fetchSteps"]);

    await runWithGoogleHealthBackfillResume("u1", done, () =>
      runGoogleHealthCollection("sleep", async () => 3),
    );

    expect([...done]).toEqual(["fetchSteps", "sleep"]);
    expect(prismaMock.googleHealthConnection.update).toHaveBeenCalledWith({
      where: { userId: "u1" },
      data: { backfillProgress: { done: ["fetchSteps", "sleep"] } },
    });
  });

  it("counts no progress when the note cannot be written", async () => {
    prismaMock.googleHealthConnection.update.mockRejectedValue(
      new Error("connection reset"),
    );
    const done = new Set<string>(["fetchSteps"]);

    const { result } = await runWithGoogleHealthBackfillResume("u1", done, () =>
      runGoogleHealthCollection("sleep", async () => 3),
    );

    // The rows are in, the collection did not fail, but it is not finished.
    expect(result).toBe(3);
    expect([...done]).toEqual(["fetchSteps"]);
    expect(warnings.some((w) => w.includes("progress write failed"))).toBe(
      true,
    );
  });
});
