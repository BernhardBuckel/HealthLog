/**
 * Who may call `POST /api/workouts/batch` (#1054).
 *
 * The route names `workouts:write`, so the set of credentials it admits is:
 * a cookie session, a wildcard (`["*"]`) token, and a narrow token carrying
 * exactly that scope. Every other narrow token — `measurements:write`
 * included, however adjacent it looks — is refused 403 by the fail-closed
 * default.
 *
 * The real `requireAuth` and the real `resolveBearerToken` run here; only the
 * token row lookup is stubbed, so the admission decision under test is the
 * production one rather than a re-implementation of it.
 *
 * The second half pins what a scoped caller writes: its rows are `EXTERNAL`,
 * resolved from the credential, and a body naming any source is refused 422
 * rather than relabelled. A session and a wildcard token keep the source they
 * send.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    apiToken: { findUnique: vi.fn(), update: vi.fn() },
    user: { findUnique: vi.fn() },
    workout: {
      findMany: vi.fn(),
      createManyAndReturn: vi.fn(),
    },
    workoutRoute: { createMany: vi.fn() },
    workoutSamples: { createManyAndReturn: vi.fn() },
    $transaction: vi.fn(async (fn: unknown) => {
      if (typeof fn === "function") {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (fn as any)(prisma as unknown as { workout: unknown });
      }
    }),
  },
}));

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));
vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: vi.fn() }));
vi.mock("@/lib/jobs/pr-detection", () => ({
  enqueuePrDetection: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/arrivals/emit-shared", () => ({
  emitDataArrival: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: () => null })),
  cookies: vi.fn(async () => ({
    get: () => undefined,
    set: () => {},
    delete: () => {},
  })),
}));

import { POST } from "../batch/route";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { headers } from "next/headers";
import { checkRateLimit } from "@/lib/rate-limit";
import { auditLog } from "@/lib/auth/audit";
import { MEASUREMENTS_WRITE_SCOPE } from "@/lib/measurements/scopes";
import { DOCUMENTS_WRITE_SCOPE } from "@/lib/documents/scopes";
import { WORKOUTS_WRITE_SCOPE } from "@/lib/workouts/scopes";

const USER = {
  id: "user-1",
  username: "tester",
  role: "USER" as const,
  sourcePriorityJson: null,
};
const TOKEN = "hlk_" + "c".repeat(64);

function makeRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/workouts/batch", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function workout(
  externalId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    sportType: "running",
    startedAt: "2026-09-20T06:30:00.000Z",
    endedAt: "2026-09-20T07:15:00.000Z",
    externalId,
    ...overrides,
  };
}

/** Present `TOKEN` as a Bearer whose row carries `permissions`. */
function armToken(permissions: string[]) {
  vi.mocked(getSession).mockResolvedValue(null as never);
  vi.mocked(headers).mockResolvedValue({
    get: (name: string) =>
      name.toLowerCase() === "authorization" ? `Bearer ${TOKEN}` : null,
  } as never);
  vi.mocked(prisma.apiToken.findUnique).mockResolvedValue({
    id: "tok-1",
    userId: USER.id,
    permissions,
    revoked: false,
    expiresAt: new Date(Date.now() + 86_400_000),
  } as never);
}

function armSession() {
  vi.mocked(getSession).mockResolvedValue({
    session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
    user: USER,
  } as never);
}

/** The rows the route handed to `INSERT ... RETURNING`. */
function insertedRows(): Array<Record<string, unknown>> {
  return vi
    .mocked(prisma.workout.createManyAndReturn)
    .mock.calls.flatMap(([args]) => {
      const data = (args as { data: unknown }).data;
      return (Array.isArray(data) ? data : [data]) as Array<
        Record<string, unknown>
      >;
    });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("API_TOKEN_HMAC_KEY", "k".repeat(64));
  vi.mocked(headers).mockResolvedValue({ get: () => null } as never);
  vi.mocked(getSession).mockResolvedValue(null as never);
  vi.mocked(checkRateLimit).mockResolvedValue({
    allowed: true,
    limit: 60,
    remaining: 60,
    resetAt: Date.now() + 60_000,
  });
  vi.mocked(prisma.apiToken.update).mockResolvedValue({} as never);
  // The refusal path chains `.catch` on the audit write, so the reset mock
  // has to hand back a promise again.
  vi.mocked(auditLog).mockResolvedValue(undefined as never);
  // One row serves both lookups: the resolver's user fetch and the route's
  // source-priority read.
  vi.mocked(prisma.user.findUnique).mockResolvedValue(USER as never);
  vi.mocked(prisma.workout.findMany).mockResolvedValue([]);
  vi.mocked(prisma.workout.createManyAndReturn).mockImplementation(
    (async (args: { data: Array<Record<string, unknown>> }) =>
      args.data.map((row, index) => ({
        id: `w-${index}`,
        source: row.source,
        externalId: row.externalId,
      }))) as never,
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("POST /api/workouts/batch — which credentials it admits", () => {
  it("admits a narrow workouts:write token", async () => {
    armToken([WORKOUTS_WRITE_SCOPE]);
    const res = await POST(makeRequest({ workouts: [workout("s-1")] }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.inserted).toBe(1);
  });

  it("still admits a cookie session", async () => {
    armSession();
    const res = await POST(
      makeRequest({ workouts: [workout("s-1", { source: "APPLE_HEALTH" })] }),
    );
    expect(res.status).toBe(200);
  });

  it("still admits a wildcard token", async () => {
    armToken(["*"]);
    const res = await POST(
      makeRequest({ workouts: [workout("s-1", { source: "APPLE_HEALTH" })] }),
    );
    expect(res.status).toBe(200);
  });

  it.each([
    ["measurements:write", [MEASUREMENTS_WRITE_SCOPE]],
    ["documents:write", [DOCUMENTS_WRITE_SCOPE]],
    ["medication:ingest", ["medication:ingest", "medication:m-1:ingest"]],
    ["health:read", ["health:read"]],
  ])("refuses a %s token with 403 and writes nothing", async (_, perms) => {
    armToken(perms);
    const res = await POST(makeRequest({ workouts: [workout("s-1")] }));
    expect(res.status).toBe(403);
    expect(prisma.workout.createManyAndReturn).not.toHaveBeenCalled();
  });
});

describe("POST /api/workouts/batch — rate limit buckets", () => {
  function lastBucket(): string {
    const calls = vi.mocked(checkRateLimit).mock.calls;
    return calls[calls.length - 1][0] as string;
  }

  it("counts a workouts:write token apart from the phone", async () => {
    armToken([WORKOUTS_WRITE_SCOPE]);
    await POST(makeRequest({ workouts: [workout("s-1")] }));
    const bridge = lastBucket();

    armToken(["*"]);
    await POST(
      makeRequest({ workouts: [workout("s-2", { source: "APPLE_HEALTH" })] }),
    );
    const phone = lastBucket();

    expect(bridge).not.toBe(phone);
    expect(bridge).toContain(USER.id);
    expect(phone).toContain(USER.id);
  });

  it("keeps a session and a wildcard token in the same bucket", async () => {
    armSession();
    await POST(
      makeRequest({ workouts: [workout("s-1", { source: "APPLE_HEALTH" })] }),
    );
    const session = lastBucket();
    armToken(["*"]);
    await POST(
      makeRequest({ workouts: [workout("s-2", { source: "APPLE_HEALTH" })] }),
    );
    expect(lastBucket()).toBe(session);
  });
});

describe("POST /api/workouts/batch — what a scoped caller writes", () => {
  it("attributes its rows to EXTERNAL", async () => {
    armToken([WORKOUTS_WRITE_SCOPE]);
    const res = await POST(
      makeRequest({ workouts: [workout("s-1"), workout("s-2")] }),
    );
    expect(res.status).toBe(200);
    const rows = insertedRows();
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.source)).toEqual(["EXTERNAL", "EXTERNAL"]);
  });

  it("probes for duplicates in the EXTERNAL namespace", async () => {
    armToken([WORKOUTS_WRITE_SCOPE]);
    await POST(makeRequest({ workouts: [workout("s-1")] }));
    const probe = vi
      .mocked(prisma.workout.findMany)
      .mock.calls.map(([args]) => args as { where?: { OR?: unknown } })
      .find((args) => args.where?.OR !== undefined);
    expect(probe?.where?.OR).toEqual([
      { source: "EXTERNAL", externalId: "s-1" },
    ]);
  });

  it.each(["APPLE_HEALTH", "MANUAL"])(
    "refuses a body naming %s with 422 and writes nothing",
    async (source) => {
      armToken([WORKOUTS_WRITE_SCOPE]);
      const res = await POST(
        makeRequest({
          workouts: [workout("s-1"), workout("s-2", { source })],
        }),
      );
      expect(res.status).toBe(422);
      const body = await res.json();
      expect(body.meta?.errorCode).toBe("workout.batch.source_not_permitted");
      expect(prisma.workout.createManyAndReturn).not.toHaveBeenCalled();
    },
  );

  it("leaves the source a wildcard caller sends alone", async () => {
    armToken(["*"]);
    await POST(
      makeRequest({ workouts: [workout("s-1", { source: "APPLE_HEALTH" })] }),
    );
    expect(insertedRows().map((r) => r.source)).toEqual(["APPLE_HEALTH"]);
  });

  it("leaves the source a session sends alone", async () => {
    armSession();
    await POST(
      makeRequest({ workouts: [workout("s-1", { source: "MANUAL" })] }),
    );
    expect(insertedRows().map((r) => r.source)).toEqual(["MANUAL"]);
  });
});
