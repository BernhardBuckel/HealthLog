/**
 * v1.18.4 — PWA-only dose lifecycle over Web Push.
 *
 * Verifies the three pieces a self-hoster without an Apple Developer account
 * relies on:
 *  1. The dose-due reminder push carries a STABLE per-slot tag + badge count.
 *  2. The clear-on-taken push reuses the SAME tag (so the SW closes the
 *     pending reminder — the equivalent of ending a Live Activity) and
 *     refreshes the badge.
 *  3. A Web Push channel still delivers when APNs is absent.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// safeFetch's requirePublicHost path drives undici's OWN fetch (version-locked
// with its dispatcher). Delegate it to the global fetch these tests stub so the
// existing interception still applies.
vi.mock("undici", async (importOriginal) => {
  const actual = await importOriginal<typeof import("undici")>();
  return {
    ...actual,
    fetch: (input: unknown, init?: unknown) =>
      (globalThis.fetch as unknown as (i: unknown, n?: unknown) => unknown)(
        input,
        init,
      ),
  };
});

const { generateRequestDetailsMock, findManyMock, deleteManyMock } = vi.hoisted(
  () => ({
    generateRequestDetailsMock: vi.fn(),
    findManyMock: vi.fn(),
    deleteManyMock: vi.fn(),
  }),
);

vi.mock("@/lib/logging/context", () => ({
  getEvent: () => ({
    addWarning: vi.fn(),
    addExternalCall: vi.fn(),
    setError: vi.fn(),
    addMeta: vi.fn(),
  }),
}));

vi.mock("@/lib/notifications/senders/push-attempt-record", () => ({
  recordPushAttempt: vi.fn(),
  recordPushAttemptForPayload: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    pushSubscription: {
      findMany: findManyMock,
      deleteMany: deleteManyMock,
    },
  },
}));

vi.mock("@/lib/crypto", () => ({
  decrypt: (v: string) => v,
  encrypt: (v: string) => v,
}));

vi.mock("@/lib/notifications/vapid-config", () => ({
  getVapidConfig: () =>
    Promise.resolve({
      subject: "mailto:a@b.c",
      publicKey: "pub",
      privateKey: "priv",
    }),
}));

vi.mock("@/lib/validations/notifications", () => ({
  isPublicUrl: () => true,
}));

vi.mock("web-push", () => ({
  setVapidDetails: vi.fn(),
  // The sender signs + encrypts here and dials through `safeFetch`; the
  // payload assertions below read the same second argument as before.
  generateRequestDetails: (...args: unknown[]) => {
    generateRequestDetailsMock(...args);
    return {
      endpoint: "https://push.example.com/x",
      method: "POST",
      headers: {},
      body: null,
    };
  },
}));

import { sendViaWebPush } from "../senders/web-push";
import { dispatchMedicationIntakeWebClear } from "../web-push-clear";
import { medicationDoseTag } from "../dose-tag";

const SUB = {
  id: "s1",
  endpoint: "https://push.example.com/x",
  p256dh: "a",
  auth: "b",
};

beforeEach(() => {
  generateRequestDetailsMock.mockReset();
  findManyMock.mockReset();
  deleteManyMock.mockReset();
  deleteManyMock.mockResolvedValue({ count: 0 });
});

afterEach(() => vi.clearAllMocks());

describe("medicationDoseTag", () => {
  it("is stable across ISO instants that differ only in milliseconds", () => {
    const a = medicationDoseTag("med-1", "2026-06-18T07:00:00.000Z");
    const b = medicationDoseTag("med-1", "2026-06-18T07:00:00Z");
    expect(a).toBe(b);
    expect(a).toBe("med:med-1:2026-06-18T07:00:00.000Z");
  });
});

describe("web-push reminder push — stable tag + badge", () => {
  it("uses metadata.webPushTag as the notification tag and carries the badge", async () => {
    findManyMock.mockResolvedValue([SUB]);
    vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(null, { status: 201 }),
    );

    const tag = medicationDoseTag("med-1", "2026-06-18T07:00:00.000Z");
    const res = await sendViaWebPush("user-1", {
      eventType: "MEDICATION_REMINDER",
      userId: "user-1",
      title: "Time for your dose",
      message: "Ramipril 5mg",
      metadata: { webPushTag: tag, badgeCount: 2, url: "/medications/med-1" },
    });

    expect(res.ok).toBe(true);
    const body = JSON.parse(
      generateRequestDetailsMock.mock.calls[0][1] as string,
    );
    expect(body.tag).toBe(tag);
    expect(body.badge).toBe(2);
    expect(body.url).toBe("/medications/med-1");
  });

  it("discreet mode still wins over a stable tag (no event name leak)", async () => {
    findManyMock.mockResolvedValue([SUB]);
    vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(null, { status: 201 }),
    );

    await sendViaWebPush("user-1", {
      eventType: "CYCLE_PERIOD_SOON",
      userId: "user-1",
      title: "HealthLog reminder",
      message: "HealthLog reminder",
      discreet: true,
      metadata: { webPushTag: "med:should-not-leak" },
    });

    const body = JSON.parse(
      generateRequestDetailsMock.mock.calls[0][1] as string,
    );
    expect(body.tag).toBe("REMINDER");
  });

  it("uses an ordinary landing route without actions for a managed Guardian", async () => {
    findManyMock.mockResolvedValue([SUB]);
    vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(null, { status: 201 }),
    );

    await sendViaWebPush("guardian-1", {
      eventType: "MEDICATION_REMINDER",
      userId: "record-1",
      recordUserId: "record-1",
      recipientUserId: "guardian-1",
      title: "Time for your dose",
      message: "Ramipril 5mg",
      urgent: true,
      metadata: { url: "/medications/med-1" },
    });

    const body = JSON.parse(
      generateRequestDetailsMock.mock.calls[0][1] as string,
    );
    expect(body.url).toBe("/");
    expect(body.actions).toBeUndefined();
  });
});

describe("web-push tap target", () => {
  async function sentBody(payload: Parameters<typeof sendViaWebPush>[1]) {
    findManyMock.mockResolvedValue([SUB]);
    vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(null, { status: 201 }),
    );
    await sendViaWebPush("user-1", payload);
    return JSON.parse(generateRequestDetailsMock.mock.calls[0][1] as string);
  }

  it("carries the dispatcher's resolved tap path as data url", async () => {
    const body = await sentBody({
      eventType: "MOOD_REMINDER",
      userId: "user-1",
      title: "Log your mood",
      message: "How are you feeling today?",
      tap: { path: "/mood?add=1", url: null, label: "Open" },
    });
    expect(body.url).toBe("/mood?add=1");
  });

  it("refuses a protocol-relative metadata url when no tap was resolved", async () => {
    const body = await sentBody({
      eventType: "SYSTEM_ALERT",
      userId: "user-1",
      title: "t",
      message: "m",
      metadata: { url: "//evil.example/x" },
    });
    expect(body.url).toBe("/");
  });
});

describe("clear-on-taken push", () => {
  it("emits type:clear with the SAME slot tag as the reminder + badge", async () => {
    findManyMock.mockResolvedValue([SUB]);
    vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(null, { status: 201 }),
    );

    await dispatchMedicationIntakeWebClear({
      userId: "user-1",
      medicationId: "med-1",
      scheduledFor: "2026-06-18T07:00:00.000Z",
      badgeCount: 1,
    });

    expect(generateRequestDetailsMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(
      generateRequestDetailsMock.mock.calls[0][1] as string,
    );
    expect(body.type).toBe("clear");
    expect(body.tag).toBe(
      medicationDoseTag("med-1", "2026-06-18T07:00:00.000Z"),
    );
    expect(body.badge).toBe(1);
  });

  it("a count of 0 clears the badge (badge:0 on the wire)", async () => {
    findManyMock.mockResolvedValue([SUB]);
    vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(null, { status: 201 }),
    );

    await dispatchMedicationIntakeWebClear({
      userId: "user-1",
      medicationId: "med-1",
      scheduledFor: "2026-06-18T07:00:00.000Z",
      badgeCount: 0,
    });

    const body = JSON.parse(
      generateRequestDetailsMock.mock.calls[0][1] as string,
    );
    expect(body.badge).toBe(0);
  });

  it("no subscriptions → no-op, no throw", async () => {
    findManyMock.mockResolvedValue([]);
    await expect(
      dispatchMedicationIntakeWebClear({
        userId: "user-1",
        medicationId: "med-1",
        scheduledFor: "2026-06-18T07:00:00.000Z",
      }),
    ).resolves.toBeUndefined();
    expect(generateRequestDetailsMock).not.toHaveBeenCalled();
  });

  it("reaps expired (410) subscriptions", async () => {
    findManyMock.mockResolvedValue([SUB]);
    vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(null, { status: 410 }),
    );

    await dispatchMedicationIntakeWebClear({
      userId: "user-1",
      medicationId: "med-1",
      scheduledFor: "2026-06-18T07:00:00.000Z",
    });

    expect(deleteManyMock).toHaveBeenCalledWith({
      where: { id: { in: ["s1"] } },
    });
  });
});
