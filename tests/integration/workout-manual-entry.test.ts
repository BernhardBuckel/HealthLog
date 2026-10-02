/**
 * A workout entered by hand, end to end against a real Postgres.
 *
 * The web form builds its entry with `buildManualWorkoutEntry` and posts it
 * to `POST /api/workouts/batch`; this suite drives that exact entry through
 * the real route and reads it back through `GET /api/workouts`, then deletes
 * it through `DELETE /api/workouts/{id}`. Pins:
 *
 *   - the entry lands as `MANUAL`, with the start, duration and metres the
 *     form computed, and the list serves it;
 *   - a second submit of the same form is a `duplicate`, not a second row;
 *   - delete removes a hand-entered workout and refuses a synced one.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";

process.env.ENCRYPTION_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const TEST_USER_ID = "user-workout-manual-entry";

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

const { POST: postBatch } = await import("@/app/api/workouts/batch/route");
const { GET: listWorkouts } = await import("@/app/api/workouts/route");
const { DELETE: deleteWorkout } = await import("@/app/api/workouts/[id]/route");
const { buildManualWorkoutEntry, newManualWorkoutExternalId } = await import(
  "@/lib/workouts/manual-entry"
);

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
  await getPrismaClient().user.create({
    data: {
      id: TEST_USER_ID,
      username: "workout-manual",
      email: "workout-manual@example.test",
    },
  });
  const session = await getPrismaClient().session.create({
    data: {
      userId: TEST_USER_ID,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    },
  });
  cookieJar.set("healthlog_session", session.id);
});

function post(body: unknown): Promise<Response> {
  return postBatch(
    new NextRequest("http://localhost/api/workouts/batch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

function list(): Promise<Response> {
  return listWorkouts(new NextRequest("http://localhost/api/workouts"));
}

function del(id: string): Promise<Response> {
  return deleteWorkout(
    new NextRequest(`http://localhost/api/workouts/${id}`, {
      method: "DELETE",
    }),
    { params: Promise.resolve({ id }) },
  );
}

/** The entry the form sends for a 45-minute imperial run, yesterday 07:30 Berlin. */
function formEntry(externalId: string) {
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const day = yesterday.toISOString().slice(0, 10);
  const built = buildManualWorkoutEntry(
    {
      sportType: "running",
      start: `${day}T07:30`,
      hours: "0",
      minutes: "45",
      distance: "5",
      energyKcal: "410",
    },
    {
      timezone: "Europe/Berlin",
      unitPreference: "imperial",
      externalId,
      now: new Date(),
    },
  );
  if (!built.ok) throw new Error(JSON.stringify(built.errors));
  return built.entry;
}

describe("a workout entered by hand", () => {
  it("lands through the batch route as MANUAL and is served by the list", async () => {
    const entry = formEntry(newManualWorkoutExternalId());

    const res = await post({ workouts: [entry] });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.entries).toEqual([{ index: 0, status: "inserted" }]);

    const listRes = await list();
    expect(listRes.status).toBe(200);
    const { data } = await listRes.json();
    expect(data.workouts).toHaveLength(1);
    const row = data.workouts[0];
    expect(row).toMatchObject({
      sportType: "running",
      startedAt: entry.startedAt,
      endedAt: entry.endedAt,
      durationSec: 45 * 60,
      // 5 mi, stored in metres to a tenth.
      distanceM: 8046.7,
      activeEnergyKcal: 410,
      source: "MANUAL",
      externalId: entry.externalId,
    });
  });

  it("stores a second submit of the same form once", async () => {
    const entry = formEntry(newManualWorkoutExternalId());

    await post({ workouts: [entry] });
    const again = await post({ workouts: [entry] });

    expect((await again.json()).data.entries).toEqual([
      { index: 0, status: "duplicate" },
    ]);
    expect(
      await getPrismaClient().workout.count({
        where: { userId: TEST_USER_ID },
      }),
    ).toBe(1);
  });

  it("can be deleted, and is gone from the list", async () => {
    await post({ workouts: [formEntry(newManualWorkoutExternalId())] });
    const stored = await getPrismaClient().workout.findFirstOrThrow({
      where: { userId: TEST_USER_ID },
    });

    const res = await del(stored.id);
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({ deleted: true });

    const { data } = await (await list()).json();
    expect(data.workouts).toHaveLength(0);
  });

  it("refuses to delete a synced workout and leaves it in place", async () => {
    const synced = await getPrismaClient().workout.create({
      data: {
        userId: TEST_USER_ID,
        sportType: "cycling",
        startedAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
        endedAt: new Date(Date.now() - 60 * 60 * 1000),
        durationSec: 3600,
        source: "APPLE_HEALTH",
        externalId: "hk-sync-1",
      },
    });

    const res = await del(synced.id);

    expect(res.status).toBe(409);
    expect(
      await getPrismaClient().workout.count({ where: { id: synced.id } }),
    ).toBe(1);
  });
});
