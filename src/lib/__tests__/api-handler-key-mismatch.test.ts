import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: {} }));
vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/auth/hmac", () => ({ hashToken: vi.fn() }));
vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: () => null })),
  cookies: vi.fn(async () => ({
    get: () => undefined,
    set: () => {},
    delete: () => {},
  })),
}));

import { NextRequest } from "next/server";
import { apiHandler } from "@/lib/api-handler";
import { setKeyMismatchState } from "@/lib/boot/key-mismatch-state";

const handler = vi.fn(async (_request: NextRequest) =>
  Response.json({ data: "ran", error: null }),
);
const route = apiHandler(handler);

function call(path: string) {
  return route(new NextRequest(`http://localhost${path}`));
}

afterEach(() => {
  setKeyMismatchState(null);
  handler.mockClear();
});

describe("apiHandler while the encryption key does not match", () => {
  it("refuses every route with 503 encryption.key_mismatch before the handler runs", async () => {
    setKeyMismatchState({ keyIds: ["v1"], detectedAt: "2026-10-03T00:00:00Z" });
    const response = await call("/api/measurements");
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.data).toBeNull();
    expect(body.meta).toEqual({ errorCode: "encryption.key_mismatch" });
    expect(response.headers.get("Retry-After")).toBe("300");
    expect(handler).not.toHaveBeenCalled();
  });

  it("still serves /api/health and /api/version", async () => {
    setKeyMismatchState({ keyIds: ["v1"], detectedAt: "2026-10-03T00:00:00Z" });
    for (const path of ["/api/health", "/api/version"]) {
      const response = await call(path);
      expect(response.status).toBe(200);
    }
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("runs the handler when the key check passed", async () => {
    const response = await call("/api/measurements");
    expect(response.status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
