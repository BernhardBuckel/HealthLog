/**
 * HealthLog works on a database whose default time zone is not UTC.
 *
 * Stored times are UTC in `timestamp` columns without a zone; Postgres reads
 * `now()` through the session time zone. On a shared instance set to
 * Europe/Berlin a fresh passkey challenge used to be expired before the
 * prompt closed. This file sets the test database's default to Europe/Berlin
 * (every connection opened afterwards starts in it) and drives the expiry
 * paths through the application's own client, which pins UTC per
 * connection. A second block takes the pin away and shows that the raw-SQL
 * expiry checks hold on their own.
 */
import { Client } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { PrismaClient } from "@/generated/prisma/client";
import { getPrismaClient, truncateAllTables } from "./setup";

const ZONE = "Europe/Berlin";
const USER_ID = "user-session-time-zone";

let databaseName = "";

async function rawClient(): Promise<Client> {
  // No startup options: the connection takes the database default.
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  return client;
}

async function setDatabaseZone(zone: string | null): Promise<void> {
  const client = await rawClient();
  try {
    if (!databaseName) {
      const { rows } = await client.query<{ name: string }>(
        "SELECT current_database() AS name",
      );
      databaseName = rows[0].name;
    }
    await client.query(
      zone
        ? `ALTER DATABASE "${databaseName}" SET timezone TO '${zone}'`
        : `ALTER DATABASE "${databaseName}" RESET timezone`,
    );
  } finally {
    await client.end();
  }
}

/** A Prisma client WITHOUT the pin: its sessions run in Europe/Berlin. */
function unpinnedClient(): PrismaClient {
  return new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
  });
}

async function challenge(
  db: PrismaClient,
  type: string,
  expiresInMs = 60_000,
): Promise<string> {
  const row = await db.authChallenge.create({
    data: {
      userId: USER_ID,
      challenge: `material-${type}`,
      type,
      expiresAt: new Date(Date.now() + expiresInMs),
    },
  });
  return row.id;
}

beforeAll(async () => {
  // Before any pooled connection of this file opens.
  await setDatabaseZone(ZONE);
});

afterAll(async () => {
  // The container is shared with every other file of the run.
  await setDatabaseZone(null);
});

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  await getPrismaClient().user.create({
    data: { id: USER_ID, username: "tz-user", email: "tz@example.test" },
  });
});

describe("on a database whose default zone is Europe/Berlin", () => {
  it("a connection without the pin really runs in Europe/Berlin", async () => {
    const client = await rawClient();
    try {
      const { rows } = await client.query<{ TimeZone: string }>(
        "SHOW TimeZone",
      );
      expect(rows[0].TimeZone).toBe(ZONE);
    } finally {
      await client.end();
    }
  });

  it("the application's pool runs in UTC and the boot check says so", async () => {
    const { runBootTimeZoneCheck } = await import("@/lib/boot/time-zone-check");
    await expect(runBootTimeZoneCheck(getPrismaClient())).resolves.toEqual({
      state: "utc",
      timeZone: "UTC",
    });
    const unpinned = unpinnedClient();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(runBootTimeZoneCheck(unpinned)).resolves.toEqual({
        state: "mismatch",
        timeZone: ZONE,
      });
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
      await unpinned.$disconnect();
    }
  });

  it("a fresh passkey registration challenge is accepted", async () => {
    const { consumeRegistrationChallenge } = await import("@/lib/auth/passkey");
    const { hashToken } = await import("@/lib/auth/hmac");
    const sessionId = "session-tz";
    const id = await challenge(
      getPrismaClient(),
      `passkey-registration:v1:${hashToken(sessionId)}`,
    );
    const claim = await consumeRegistrationChallenge({
      challengeId: id,
      userId: USER_ID,
      sessionId,
    });
    expect(claim.ok).toBe(true);
    if (claim.ok) {
      // Stamped by the column default: UTC, not Berlin wall time.
      expect(Math.abs(claim.createdAt.getTime() - Date.now())).toBeLessThan(
        60_000,
      );
    }
  });

  it("a fresh login challenge is claimed, an expired one is not", async () => {
    const { claimAuthChallenge } = await import("@/lib/auth/passkey");
    const fresh = await challenge(getPrismaClient(), "authentication");
    await expect(
      claimAuthChallenge({ challengeId: fresh, type: "authentication" }),
    ).resolves.not.toBeNull();
    const stale = await challenge(getPrismaClient(), "authentication", -1_000);
    await expect(
      claimAuthChallenge({ challengeId: stale, type: "authentication" }),
    ).resolves.toBeNull();
  });

  it("a session is valid until it expires and is stamped in UTC", async () => {
    const { validateSessionFromCookieValue } =
      await import("@/lib/auth/session");
    const { hashToken } = await import("@/lib/auth/hmac");
    const live = await getPrismaClient().session.create({
      data: {
        userId: USER_ID,
        tokenHash: hashToken("hls_live-secret"),
        expiresAt: new Date(Date.now() + 60 * 60_000),
      },
    });
    await getPrismaClient().session.create({
      data: {
        userId: USER_ID,
        tokenHash: hashToken("hls_expired-secret"),
        expiresAt: new Date(Date.now() - 60_000),
      },
    });
    expect(Math.abs(live.createdAt.getTime() - Date.now())).toBeLessThan(
      60_000,
    );
    await expect(
      validateSessionFromCookieValue("hls_live-secret"),
    ).resolves.not.toBeNull();
    await expect(
      validateSessionFromCookieValue("hls_expired-secret"),
    ).resolves.toBeNull();
  });

  it("the native sign-in handoff sees a session begun inside it as fresh", async () => {
    // The handoff link is good only for a session created after it began:
    // `session.createdAt >= startedAt`, with `startedAt` read from the
    // database clock and `createdAt` stamped by the column default.
    const { nativeHandoffDbNow } =
      await import("@/lib/auth/native-web-handoff");
    const startedAt = await nativeHandoffDbNow();
    // The driver adapter reads a `timestamptz` as if its offset were +00:00,
    // so on a Berlin session this instant came back two hours late.
    expect(Math.abs(startedAt.getTime() - Date.now())).toBeLessThan(60_000);
    const created = await getPrismaClient().$queryRaw<{ created_at: Date }[]>`
      INSERT INTO sessions (id, user_id, token_hash, expires_at)
      VALUES ('session-handoff', ${USER_ID}, 'handoff-hash',
              (NOW() AT TIME ZONE 'UTC') + INTERVAL '1 hour')
      RETURNING created_at
    `;
    const createdAt = created[0].created_at;
    expect(createdAt.getTime()).toBeGreaterThanOrEqual(startedAt.getTime());
    expect(createdAt.getTime() - startedAt.getTime()).toBeLessThan(60_000);
  });

  it("a rate-limit window resets one window from now", async () => {
    const { checkRateLimit } = await import("@/lib/rate-limit");
    const before = Date.now();
    const result = await checkRateLimit("tz:window", 5, 60_000);
    expect(result.allowed).toBe(true);
    expect(result.resetAt - before).toBeGreaterThan(55_000);
    expect(result.resetAt - before).toBeLessThan(65_000);
  });
});

describe("without the per-connection pin", () => {
  it("the raw-SQL challenge expiry still holds on a Berlin session", async () => {
    const unpinned = unpinnedClient();
    try {
      const [{ TimeZone }] =
        await unpinned.$queryRawUnsafe<{ TimeZone: string }[]>("SHOW TimeZone");
      expect(TimeZone).toBe(ZONE);
      vi.resetModules();
      vi.doMock("@/lib/db", async (importOriginal) => ({
        ...(await importOriginal<typeof import("@/lib/db")>()),
        prisma: unpinned,
      }));
      const { claimAuthChallenge } = await import("@/lib/auth/passkey");
      const fresh = await challenge(unpinned, "authentication");
      await expect(
        claimAuthChallenge({ challengeId: fresh, type: "authentication" }),
      ).resolves.not.toBeNull();
      const stale = await challenge(unpinned, "authentication", -1_000);
      await expect(
        claimAuthChallenge({ challengeId: stale, type: "authentication" }),
      ).resolves.toBeNull();
    } finally {
      vi.doUnmock("@/lib/db");
      await unpinned.$disconnect();
    }
  });
});
