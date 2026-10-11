/**
 * v1.42.2 — a mood quick answer from a notification writes exactly once.
 *
 * The three answers on one reminder share a nonce, and the write is keyed on
 * it through `MoodEntry`'s unique `(userId, source, externalId)`. Against
 * real Postgres and the real route: the first answer logs, a repeat of the
 * same answer, a different answer on the same reminder, and two answers
 * racing each other all leave exactly one row behind.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { getPrismaClient, truncateAllTables } from "./setup";

const USER = "user-notification-action";

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

function call(token: string) {
  return import("@/app/api/notifications/action/[token]/route").then(
    ({ POST }) =>
      POST(
        new NextRequest(`http://localhost/api/notifications/action/${token}`, {
          method: "POST",
        }),
        { params: Promise.resolve({ token }) },
      ),
  );
}

async function tokens(nonce: string) {
  const { mintActionToken } = await import("@/lib/notifications/action-token");
  return {
    good: mintActionToken({ userId: USER, action: "mood-good", nonce }),
    bad: mintActionToken({ userId: USER, action: "mood-bad", nonce }),
  };
}

beforeEach(async () => {
  vi.stubEnv(
    "API_TOKEN_HMAC_KEY",
    "integration-hmac-key-at-least-32-characters",
  );
  await truncateAllTables(getPrismaClient());
  await getPrismaClient().user.create({
    data: {
      id: USER,
      username: "notification-action",
      email: "notification-action@example.test",
      timezone: "Europe/Berlin",
    },
  });
});

describe("POST /api/notifications/action/{token}", () => {
  it("logs the first answer once and refuses every later answer on the reminder", async () => {
    const { good, bad } = await tokens("reminder-1");

    const first = await call(good);
    expect(first.status).toBe(200);
    const repeat = await call(good);
    expect(repeat.status).toBe(409);
    const other = await call(bad);
    expect(other.status).toBe(409);

    const rows = await getPrismaClient().moodEntry.findMany({
      where: { userId: USER },
      select: { source: true, externalId: true, score: true, mood: true },
    });
    expect(rows).toEqual([
      {
        source: "NOTIFICATION",
        externalId: "notification-action:reminder-1",
        score: 4,
        mood: "GUT",
      },
    ]);
  });

  it("lets only one of two racing answers write", async () => {
    const { good, bad } = await tokens("reminder-2");

    const statuses = (await Promise.all([call(good), call(bad)]))
      .map((res) => res.status)
      .sort();
    expect(statuses).toEqual([200, 409]);
    expect(
      await getPrismaClient().moodEntry.count({ where: { userId: USER } }),
    ).toBe(1);
  });

  it("answers a separate reminder with its own entry", async () => {
    const one = await tokens("reminder-3");
    const two = await tokens("reminder-4");
    expect((await call(one.good)).status).toBe(200);
    expect((await call(two.bad)).status).toBe(200);
    expect(
      await getPrismaClient().moodEntry.count({ where: { userId: USER } }),
    ).toBe(2);
  });
});
