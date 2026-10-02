/**
 * Unit suite for `DELETE /api/workouts/{id}`.
 *
 * Pins:
 *   - a workout entered by hand is removed, with the personal records keyed
 *     on it, and a silent detection pass re-derives the previous best;
 *   - a synced workout answers 409 and nothing is touched, because the next
 *     sync would write it back;
 *   - another user's row and a missing row answer 404;
 *   - no session answers 401.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const tx = {
  personalRecord: { deleteMany: vi.fn() },
  workout: { delete: vi.fn() },
};

vi.mock("@/lib/db", () => ({
  prisma: {
    workout: { findUnique: vi.fn() },
    $transaction: vi.fn(async (fn: (client: typeof tx) => unknown) => fn(tx)),
  },
}));
vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));
vi.mock("@/lib/cache/invalidate", () => ({
  invalidateUserMeasurements: vi.fn(),
}));
vi.mock("@/lib/jobs/pr-detection", () => ({
  enqueuePrDetection: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: () => null })),
  cookies: vi.fn(async () => ({
    get: () => undefined,
    set: () => {},
    delete: () => {},
  })),
}));

import { DELETE } from "../[id]/route";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { auditLog } from "@/lib/auth/audit";
import { enqueuePrDetection } from "@/lib/jobs/pr-detection";
import { invalidateUserMeasurements } from "@/lib/cache/invalidate";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "testuser", role: "USER" as const },
};

const MANUAL_ROW = {
  id: "w-1",
  userId: "user-1",
  source: "MANUAL" as const,
  externalId: "manual:5b0f3c1e-1111-4222-8333-444455556666",
  startedAt: new Date("2026-09-01T07:00:00Z"),
  sportType: "running",
};

function del(id = "w-1") {
  return DELETE(
    new NextRequest(`http://localhost/api/workouts/${id}`, {
      method: "DELETE",
    }),
    { params: Promise.resolve({ id }) },
  );
}

describe("DELETE /api/workouts/{id}", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    tx.personalRecord.deleteMany.mockResolvedValue({ count: 0 });
    tx.workout.delete.mockResolvedValue({ id: "w-1" });
  });

  it("removes a workout entered by hand", async () => {
    vi.mocked(prisma.workout.findUnique).mockResolvedValue(MANUAL_ROW as never);

    const res = await del();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { deleted: true }, error: null });
    expect(tx.workout.delete).toHaveBeenCalledWith({ where: { id: "w-1" } });
    expect(auditLog).toHaveBeenCalledWith(
      "workout.delete",
      expect.objectContaining({ userId: "user-1" }),
    );
    expect(invalidateUserMeasurements).toHaveBeenCalledWith("user-1", {
      evict: true,
    });
  });

  it("takes the personal records the workout set with it and re-derives the best", async () => {
    vi.mocked(prisma.workout.findUnique).mockResolvedValue(MANUAL_ROW as never);
    tx.personalRecord.deleteMany.mockResolvedValue({ count: 2 });

    const res = await del();

    expect(res.status).toBe(200);
    expect(tx.personalRecord.deleteMany).toHaveBeenCalledWith({
      where: {
        userId: "user-1",
        metricSlot: { not: null },
        source: "MANUAL",
        externalId: MANUAL_ROW.externalId,
      },
    });
    expect(enqueuePrDetection).toHaveBeenCalledWith("user-1", {
      silent: true,
    });
  });

  it("keys a record without an external id on the session's start", async () => {
    vi.mocked(prisma.workout.findUnique).mockResolvedValue({
      ...MANUAL_ROW,
      externalId: null,
    } as never);

    await del();

    expect(tx.personalRecord.deleteMany).toHaveBeenCalledWith({
      where: {
        userId: "user-1",
        metricSlot: { not: null },
        source: "MANUAL",
        externalId: null,
        achievedAt: MANUAL_ROW.startedAt,
      },
    });
    // Nothing was removed, so nothing needs re-deriving.
    expect(enqueuePrDetection).not.toHaveBeenCalled();
  });

  it.each(["APPLE_HEALTH", "WITHINGS", "WHOOP", "EXTERNAL"])(
    "refuses a %s workout with 409 and touches nothing",
    async (source) => {
      vi.mocked(prisma.workout.findUnique).mockResolvedValue({
        ...MANUAL_ROW,
        source,
      } as never);

      const res = await del();

      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.data).toBeNull();
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(tx.workout.delete).not.toHaveBeenCalled();
      expect(auditLog).not.toHaveBeenCalled();
    },
  );

  it("answers 404 for another user's workout", async () => {
    vi.mocked(prisma.workout.findUnique).mockResolvedValue({
      ...MANUAL_ROW,
      userId: "someone-else",
    } as never);

    const res = await del();

    expect(res.status).toBe(404);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("answers 404 when there is no such workout", async () => {
    vi.mocked(prisma.workout.findUnique).mockResolvedValue(null);

    const res = await del("missing");

    expect(res.status).toBe(404);
  });

  it("answers 401 without a session", async () => {
    vi.mocked(getSession).mockResolvedValue(null);

    const res = await del();

    expect(res.status).toBe(401);
    expect(prisma.workout.findUnique).not.toHaveBeenCalled();
  });
});
