import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/api-handler", () => ({
  apiHandler: <T extends (...args: unknown[]) => unknown>(fn: T) => fn,
}));

vi.mock("@/lib/db", () => ({
  prisma: { user: { update: vi.fn() } },
}));

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn(async () => null) }));

vi.mock("@/lib/logging/context", () => ({
  annotate: vi.fn(),
  getEvent: () => ({
    setError: vi.fn(),
    setAuth: vi.fn(),
    addWarning: vi.fn(),
  }),
}));

vi.mock("@/lib/auth/audit", () => ({ auditLog: vi.fn() }));
vi.mock("@/lib/crypto", () => ({ encrypt: (s: string) => `enc:${s}` }));
vi.mock("@/lib/integrations/status", () => ({ markReconnected: vi.fn() }));

const {
  exchangeMock,
  getCredsMock,
  matchMock,
  verifyMock,
  bossSend,
  bossMock,
} = vi.hoisted(() => ({
  exchangeMock: vi.fn(),
  getCredsMock: vi.fn(),
  matchMock: vi.fn(),
  verifyMock: vi.fn(),
  bossSend: vi.fn(),
  bossMock: vi.fn(),
}));

vi.mock("@/lib/jobs/boss-instance", () => ({ getGlobalBoss: bossMock }));

vi.mock("@/lib/oura/client", async (importOriginal) => ({
  isAcceptedOuraIssuer: (
    await importOriginal<typeof import("@/lib/oura/client")>()
  ).isAcceptedOuraIssuer,
  exchangeCode: exchangeMock,
}));
vi.mock("@/lib/oura/credentials", () => ({
  getOuraClientCredentials: getCredsMock,
}));
vi.mock("@/lib/oauth/signed-state", () => ({
  oauthStateCookieName: (p: string) => `${p}_state`,
  stateMatchesCookie: matchMock,
  verifySignedState: verifyMock,
}));

import { GET } from "../route";
import { prisma } from "@/lib/db";
import { auditLog } from "@/lib/auth/audit";
import { getSession } from "@/lib/auth/session";
import type { NextRequest } from "next/server";

const userUpdate = prisma.user.update as ReturnType<typeof vi.fn>;

process.env.NEXT_PUBLIC_APP_URL = "https://app.example";

function makeReq(opts: {
  code?: string;
  state?: string;
  cookie?: string;
  iss?: string;
}): NextRequest {
  const params = new URLSearchParams();
  if (opts.code) params.set("code", opts.code);
  if (opts.state) params.set("state", opts.state);
  if (opts.iss) params.set("iss", opts.iss);
  return {
    url: `https://app.example/api/oura/callback?${params}`,
    cookies: {
      get: (name: string) =>
        name === "oura_state" && opts.cookie
          ? { value: opts.cookie }
          : undefined,
    },
  } as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  matchMock.mockReturnValue(true);
  verifyMock.mockReturnValue({ userId: "u1" });
  getCredsMock.mockResolvedValue({ clientId: "c", clientSecret: "s" });
  exchangeMock.mockResolvedValue({ access_token: "at", refresh_token: "rt" });
  userUpdate.mockResolvedValue({});
  (getSession as ReturnType<typeof vi.fn>).mockResolvedValue(null);
  bossSend.mockResolvedValue("job-1");
  bossMock.mockReturnValue({ send: bossSend });
});

describe("GET /api/oura/callback", () => {
  it("rejects a cookie/state mismatch as csrf1 before any exchange", async () => {
    matchMock.mockReturnValue(false);
    const res = await GET(makeReq({ code: "c", state: "S", cookie: "X" }));
    expect(res.headers.get("location")).toContain("reason=csrf1");
    expect(exchangeMock).not.toHaveBeenCalled();
  });

  it("rejects an unverifiable signed state", async () => {
    verifyMock.mockReturnValue(null);
    const res = await GET(makeReq({ code: "c", state: "S", cookie: "S" }));
    expect(res.headers.get("location")).toContain("reason=state");
    expect(exchangeMock).not.toHaveBeenCalled();
  });

  it("rejects when the verified userId mismatches a live session (cross_user)", async () => {
    (getSession as ReturnType<typeof vi.fn>).mockResolvedValue({
      user: { id: "attacker" },
    });
    const res = await GET(makeReq({ code: "c", state: "S", cookie: "S" }));
    expect(res.headers.get("location")).toContain("reason=cross_user");
    expect(exchangeMock).not.toHaveBeenCalled();
  });

  it("falls back to nocreds when no BYO/env credentials resolve", async () => {
    getCredsMock.mockResolvedValue(null);
    const res = await GET(makeReq({ code: "c", state: "S", cookie: "S" }));
    expect(res.headers.get("location")).toContain("reason=nocreds");
    expect(exchangeMock).not.toHaveBeenCalled();
  });

  it("exchanges the code, persists encrypted tokens, and audits on success", async () => {
    const res = await GET(
      makeReq({ code: "auth-code", state: "S", cookie: "S" }),
    );
    expect(exchangeMock).toHaveBeenCalledWith(
      "auth-code",
      { clientId: "c", clientSecret: "s" },
      null,
    );
    const data = userUpdate.mock.calls[0]![0].data;
    expect(data.ouraAccessTokenEncrypted).toBe("enc:at");
    expect(data.ouraRefreshTokenEncrypted).toBe("enc:rt");
    expect(auditLog).toHaveBeenCalledWith("oura.connect", { userId: "u1" });
    expect(res.headers.get("location")).toContain("oura=connected");
  });
});

// Oura's current authorization server names itself on the callback
// (RFC 9207); the issuer travels on to pick the token endpoint.
describe("GET /api/oura/callback — issuer", () => {
  it("passes Oura's issuer on to the code exchange", async () => {
    const iss = "https://moi.ouraring.com/oauth/v2/ext/oauth-anonymous";
    const res = await GET(makeReq({ code: "c", state: "S", cookie: "S", iss }));
    expect(exchangeMock).toHaveBeenCalledWith(
      "c",
      { clientId: "c", clientSecret: "s" },
      iss,
    );
    expect(res.headers.get("location")).toContain("oura=connected");
  });

  it("refuses a callback that names a foreign authorization server", async () => {
    const res = await GET(
      makeReq({
        code: "c",
        state: "S",
        cookie: "S",
        iss: "https://evil.example/oauth",
      }),
    );
    expect(res.headers.get("location")).toContain("reason=issuer");
    expect(exchangeMock).not.toHaveBeenCalled();
  });
});

/**
 * v1.32.28 — connecting starts a sync straight away. The poll handler has
 * accepted a single-user payload since it was written; this callback is the
 * producer that was missing, and without it a fresh connection showed an empty
 * card for up to an hour.
 */
describe("GET /api/oura/callback — connect-time first sync", () => {
  it("enqueues exactly one targeted oura-sync job for the connecting user", async () => {
    const res = await GET(makeReq({ code: "c", state: "S", cookie: "S" }));

    expect(res.headers.get("location")).toContain("oura=connected");
    expect(bossSend).toHaveBeenCalledTimes(1);
    expect(bossSend).toHaveBeenCalledWith("oura-sync", { userId: "u1" });
  });

  it("still connects when no boss instance is available", async () => {
    bossMock.mockReturnValue(null);

    const res = await GET(makeReq({ code: "c", state: "S", cookie: "S" }));

    expect(res.headers.get("location")).toContain("oura=connected");
    expect(bossSend).not.toHaveBeenCalled();
  });

  it("still connects when the enqueue itself rejects", async () => {
    bossSend.mockRejectedValue(new Error("queue unreachable"));

    const res = await GET(makeReq({ code: "c", state: "S", cookie: "S" }));

    expect(res.headers.get("location")).toContain("oura=connected");
  });
});
