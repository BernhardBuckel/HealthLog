import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  },
}));

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));

vi.mock("@/lib/insights/unit-change-refresh", () => ({
  refreshTextsAfterUnitChange: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({
    allowed: true,
    remaining: 59,
    resetAt: Date.now() + 60_000,
  }),
  rateLimitHeaders: () => ({}),
}));

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: () => null })),
  cookies: vi.fn(async () => ({
    get: () => undefined,
    set: () => {},
    delete: () => {},
  })),
}));

import { GET, PATCH } from "../route";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { auditLog } from "@/lib/auth/audit";
import { refreshTextsAfterUnitChange } from "@/lib/insights/unit-change-refresh";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "testuser", role: "USER" as const },
};

function mkPatch(body: unknown): Request {
  return new Request("http://localhost/api/auth/me/unit-preference", {
    method: "PATCH",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/auth/me/unit-preference", () => {
  it("rejects an unauthenticated request with 401", async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    const res = await (GET as (r: Request) => Promise<Response>)(
      new Request("http://localhost/api/auth/me/unit-preference"),
    );
    expect(res.status).toBe(401);
  });

  it("defaults to metric for a fresh user (null column)", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      unitPreference: null,
    } as never);
    const res = await (GET as (r: Request) => Promise<Response>)(
      new Request("http://localhost/api/auth/me/unit-preference"),
    );
    expect(res.status).toBe(200);
    const env = (await res.json()) as {
      data: { unitPreference: string };
    };
    expect(env.data.unitPreference).toBe("metric");
  });

  it("defaults to metric when the column is missing (partial rollback)", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({} as never);
    const res = await (GET as (r: Request) => Promise<Response>)(
      new Request("http://localhost/api/auth/me/unit-preference"),
    );
    const env = (await res.json()) as { data: { unitPreference: string } };
    expect(env.data.unitPreference).toBe("metric");
  });

  it("returns imperial when set", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      unitPreference: "imperial",
    } as never);
    const res = await (GET as (r: Request) => Promise<Response>)(
      new Request("http://localhost/api/auth/me/unit-preference"),
    );
    const env = (await res.json()) as { data: { unitPreference: string } };
    expect(env.data.unitPreference).toBe("imperial");
  });
});

describe("PATCH /api/auth/me/unit-preference", () => {
  it("sets imperial and writes the audit row", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      unitPreference: null,
    } as never);
    vi.mocked(prisma.user.update).mockResolvedValue({} as never);

    const res = await (PATCH as (r: Request) => Promise<Response>)(
      mkPatch({ unitPreference: "imperial" }),
    );
    expect(res.status).toBe(200);
    const env = (await res.json()) as { data: { unitPreference: string } };
    expect(env.data.unitPreference).toBe("imperial");

    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: { unitPreference: "imperial" },
    });
    expect(auditLog).toHaveBeenCalledWith(
      "user.unit-preference.update",
      expect.objectContaining({
        userId: "user-1",
        details: expect.objectContaining({
          previous: "metric",
          next: "imperial",
        }),
      }),
    );
  });

  it("rejects an unknown preference value with 422", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const res = await (PATCH as (r: Request) => Promise<Response>)(
      mkPatch({ unitPreference: "furlongs" }),
    );
    expect(res.status).toBe(422);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  // The three cases below pin the capped `safeJson` read. Before it, the
  // handler called `request.json()` bare: malformed JSON came back 422 rather
  // than the 400 every sibling scalar answers, a wrong content type was parsed
  // rather than refused, and there was NO body-size limit — this was the one
  // endpoint in the family that would materialise whatever it was handed. The
  // malformed-JSON assertion used to say 422 and was changed deliberately: it
  // pinned the inconsistency rather than a contract, and the only caller
  // branches on `res.ok` alone.
  it("rejects malformed JSON with 400, like its sibling scalars", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const req = new Request("http://localhost/api/auth/me/unit-preference", {
      method: "PATCH",
      body: "{ not valid json",
      headers: { "Content-Type": "application/json" },
    });
    const res = await (PATCH as (r: Request) => Promise<Response>)(req);
    expect(res.status).toBe(400);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("refuses a body over the 1 KB cap with 413", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    // Valid JSON, valid enum value, and far too big: the cap has to be what
    // rejects it, not the schema.
    const req = new Request("http://localhost/api/auth/me/unit-preference", {
      method: "PATCH",
      body: JSON.stringify({
        unitPreference: "imperial",
        padding: "x".repeat(2048),
      }),
      headers: { "Content-Type": "application/json" },
    });
    const res = await (PATCH as (r: Request) => Promise<Response>)(req);
    expect(res.status).toBe(413);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("refuses a non-JSON content type with 415", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const req = new Request("http://localhost/api/auth/me/unit-preference", {
      method: "PATCH",
      body: "unitPreference=imperial",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
    const res = await (PATCH as (r: Request) => Promise<Response>)(req);
    expect(res.status).toBe(415);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });
});

describe("PATCH re-warms the texts that quote the unit", () => {
  it("re-warms the stored notes when the unit actually changes", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      unitPreference: null,
    } as never);
    vi.mocked(prisma.user.update).mockResolvedValue({} as never);

    const res = await (PATCH as (r: Request) => Promise<Response>)(
      mkPatch({ unitPreference: "imperial" }),
    );
    expect(res.status).toBe(200);
    expect(refreshTextsAfterUnitChange).toHaveBeenCalledWith("user-1");
  });

  it("leaves them alone when the same unit is saved again", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      unitPreference: "imperial",
    } as never);
    vi.mocked(prisma.user.update).mockResolvedValue({} as never);

    const res = await (PATCH as (r: Request) => Promise<Response>)(
      mkPatch({ unitPreference: "imperial" }),
    );
    expect(res.status).toBe(200);
    expect(refreshTextsAfterUnitChange).not.toHaveBeenCalled();
  });
});
