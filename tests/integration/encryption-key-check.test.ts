/**
 * The boot encryption key check and the "Back up your encryption key" step,
 * against real Postgres.
 *
 *   - a first boot writes a canary; a second boot with the same key opens it;
 *   - a boot with another key under the same id refuses: the state is set,
 *     every API route answers 503 `encryption.key_mismatch`, `/api/health`
 *     names the reason, and nothing is written;
 *   - a database written before the canary existed is probed: data that does
 *     not open under the configured key refuses rather than sealing the wrong
 *     key as the right one;
 *   - the confirmation binds to the active key id and fingerprint, refuses a
 *     stale one with 409, and is due again after a re-keyed install;
 *   - "Check my copy" answers a boolean, stores nothing, and is rate limited.
 */
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";

vi.mock("next/headers", async () => {
  const { cookieJar, headerJar } = await import("./mock-next-headers");
  return {
    headers: vi.fn(async () => ({
      get: (name: string) => headerJar.get(name.toLowerCase()) ?? null,
    })),
    cookies: vi.fn(async () => ({
      get: (name: string) => {
        const value = cookieJar.get(name);
        return value ? { name, value } : undefined;
      },
      set: (name: string, value: string) => {
        cookieJar.set(name, value);
      },
      delete: (name: string) => {
        cookieJar.delete(name);
      },
    })),
  };
});

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

import {
  _resetCryptoCacheForTests,
  encrypt,
  getKeyFingerprint,
} from "@/lib/crypto";
import { runBootKeyCheck } from "@/lib/boot/key-check";
import {
  isKeyMismatch,
  setKeyMismatchState,
} from "@/lib/boot/key-mismatch-state";

const KEY_A =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const KEY_B =
  "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";

function useKey(hex: string) {
  vi.stubEnv("ENCRYPTION_KEYS", "");
  vi.stubEnv("ENCRYPTION_ACTIVE_KEY_ID", "");
  vi.stubEnv("ENCRYPTION_KEY", hex);
  _resetCryptoCacheForTests();
}

async function seedAdmin(): Promise<string> {
  const prisma = getPrismaClient();
  const admin = await prisma.user.create({
    data: {
      username: "key-admin",
      email: "key-admin@example.test",
      role: "ADMIN",
    },
  });
  const session = await prisma.session.create({
    data: { userId: admin.id, expiresAt: new Date(Date.now() + 3_600_000) },
  });
  cookieJar.set("healthlog_session", session.id);
  return admin.id;
}

/** The GET handlers take no parameter; `apiHandler` still reads the request. */
type RouteFn = (request: NextRequest) => Promise<Response>;
const asRoute = (fn: unknown) => fn as RouteFn;

function post(path: string, body: unknown): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  const prisma = getPrismaClient();
  await truncateAllTables(prisma);
  await prisma.$executeRaw`DELETE FROM encryption_key_canaries`;
  await prisma.$executeRaw`DELETE FROM rate_limits WHERE key LIKE 'key-backup-verify:%'`;
  cookieJar.clear();
  headerJar.clear();
  useKey(KEY_A);
  setKeyMismatchState(null);
});

afterEach(() => {
  setKeyMismatchState(null);
  vi.unstubAllEnvs();
  _resetCryptoCacheForTests();
});

describe("boot encryption key check (real Postgres)", () => {
  it("writes a canary on first boot and opens it on the next", async () => {
    const prisma = getPrismaClient();
    expect(await runBootKeyCheck(prisma)).toBe(false);
    const rows = await prisma.encryptionKeyCanary.findMany();
    expect(rows.map((r) => r.keyId)).toEqual(["v1"]);
    expect(rows[0].ciphertext.startsWith("v1.")).toBe(true);

    expect(await runBootKeyCheck(prisma)).toBe(false);
    expect(isKeyMismatch()).toBe(false);
  });

  it("refuses to serve when the key changed under the same id", async () => {
    const prisma = getPrismaClient();
    await runBootKeyCheck(prisma);
    const before = await prisma.encryptionKeyCanary.findMany();

    useKey(KEY_B);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await runBootKeyCheck(prisma)).toBe(true);
    expect(errors.mock.calls[0]?.[0]).toContain("encryption.key_mismatch");
    errors.mockRestore();
    expect(isKeyMismatch()).toBe(true);
    // Nothing re-sealed under the wrong key.
    expect(await prisma.encryptionKeyCanary.findMany()).toEqual(before);

    await seedAdmin();
    const { GET: keyBackupGet } =
      await import("@/app/api/admin/encryption/key-backup/route");
    const refused = await asRoute(keyBackupGet)(
      new NextRequest("http://localhost/api/admin/encryption/key-backup"),
    );
    expect(refused.status).toBe(503);
    const body = await refused.json();
    expect(body.meta).toEqual({ errorCode: "encryption.key_mismatch" });

    const { GET: healthGet } = await import("@/app/api/health/route");
    const health = await asRoute(healthGet)(
      new NextRequest("http://localhost/api/health"),
    );
    expect(health.status).toBe(503);
    const healthBody = await health.json();
    expect(healthBody.status).toBe("degraded");
    expect(healthBody.reason).toBe("encryption_key_mismatch");

    // Restoring the original key clears it on the next boot.
    useKey(KEY_A);
    expect(await runBootKeyCheck(prisma)).toBe(false);
    expect(isKeyMismatch()).toBe(false);
  });

  it("refuses rather than sealing the wrong key over data that predates the canary", async () => {
    const prisma = getPrismaClient();
    await prisma.user.create({
      data: {
        username: "existing",
        email: "existing@example.test",
        codexAccessTokenEncrypted: encrypt("a stored token"),
      },
    });

    useKey(KEY_B);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await runBootKeyCheck(prisma)).toBe(true);
    errors.mockRestore();
    expect(await prisma.encryptionKeyCanary.count()).toBe(0);

    // With the right key the same data lets the canary be written.
    useKey(KEY_A);
    expect(await runBootKeyCheck(prisma)).toBe(false);
    expect(await prisma.encryptionKeyCanary.count()).toBe(1);
  });
});

describe("encryption key backup step (real Postgres)", () => {
  it("is due, refuses a stale confirmation, records the right one, and is due again after a re-key", async () => {
    const prisma = getPrismaClient();
    const adminId = await seedAdmin();
    const { GET } = await import("@/app/api/admin/encryption/key-backup/route");
    const { POST: confirm } =
      await import("@/app/api/admin/encryption/key-backup/confirm/route");
    const status = async () =>
      (
        await (
          await asRoute(GET)(
            new NextRequest("http://localhost/api/admin/encryption/key-backup"),
          )
        ).json()
      ).data;

    const first = await status();
    expect(first.due).toBe(true);
    expect(first.activeKeyId).toBe("v1");
    expect(first.fingerprint).toBe(getKeyFingerprint("v1"));
    expect(first.platformHint).toBe("compose");
    expect(JSON.stringify(first)).not.toContain(KEY_A);

    const stale = await confirm(
      post("/api/admin/encryption/key-backup/confirm", {
        keyId: "v1",
        fingerprint: "000000000000",
      }),
    );
    expect(stale.status).toBe(409);
    expect((await stale.json()).meta.errorCode).toBe(
      "encryption.keyBackup.stale",
    );
    expect(
      (await prisma.appSettings.findUnique({ where: { id: "singleton" } }))
        ?.encryptionKeyBackupConfirmedAt ?? null,
    ).toBeNull();

    const ok = await confirm(
      post("/api/admin/encryption/key-backup/confirm", {
        keyId: "v1",
        fingerprint: first.fingerprint,
      }),
    );
    expect(ok.status).toBe(200);
    const confirmed = (await ok.json()).data;
    expect(confirmed.due).toBe(false);
    expect(confirmed.confirmedBy).toEqual({
      id: adminId,
      email: "key-admin@example.test",
    });
    const audit = await prisma.auditLog.findFirst({
      where: { action: "encryption.keyBackup.confirmed" },
    });
    expect(audit).not.toBeNull();

    vi.stubEnv("HEALTHLOG_PLATFORM", "truenas");
    useKey(KEY_B);
    const after = await status();
    expect(after.due).toBe(true);
    expect(after.confirmedKeyId).toBe("v1");
    expect(after.platformHint).toBe("truenas");
  });

  it("checks a copy without storing it, and limits the checks", async () => {
    const prisma = getPrismaClient();
    await seedAdmin();
    const { POST: verify } =
      await import("@/app/api/admin/encryption/key-backup/verify/route");
    const check = (encryptionKey: string) =>
      verify(
        post("/api/admin/encryption/key-backup/verify", { encryptionKey }),
      );

    const good = await check(`${KEY_A}\n`);
    expect(good.status).toBe(200);
    expect((await good.json()).data).toEqual({ matches: true, keyId: "v1" });

    const bad = await check(KEY_B);
    expect((await bad.json()).data.matches).toBe(false);

    const invalid = await verify(
      post("/api/admin/encryption/key-backup/verify", { encryptionKey: "" }),
    );
    expect(invalid.status).toBe(422);
    expect(JSON.stringify(await invalid.json())).not.toContain("issues");

    // Nothing of the candidate is stored anywhere a row could hold it.
    const audits = await prisma.auditLog.findMany();
    expect(JSON.stringify(audits)).not.toContain(KEY_A);
    expect(JSON.stringify(audits)).not.toContain(KEY_B);
    expect(
      (await prisma.appSettings.findUnique({ where: { id: "singleton" } }))
        ?.encryptionKeyBackupConfirmedAt ?? null,
    ).toBeNull();

    await check(KEY_B);
    await check(KEY_B);
    const limited = await check(KEY_A);
    expect(limited.status).toBe(429);
  });
});
