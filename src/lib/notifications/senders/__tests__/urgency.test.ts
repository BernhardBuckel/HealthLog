/**
 * v1.18.4 — per-channel urgency mapping.
 *
 * An urgent payload must reach EACH configured channel at its highest level,
 * with NO dependency on APNs (most self-hosters have no Apple Developer
 * account). These tests pin the mapping per sender and confirm an APNs-less
 * instance degrades gracefully (ntfy / Web Push / webhook still escalate).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  safeFetchMock,
  recordPushAttemptMock,
  generateRequestDetailsMock,
  findManyMock,
} = vi.hoisted(() => ({
  safeFetchMock: vi.fn(),
  recordPushAttemptMock: vi.fn(),
  generateRequestDetailsMock: vi.fn(),
  findManyMock: vi.fn(),
}));

vi.mock("@/lib/safe-fetch", () => ({
  safeFetch: (...args: unknown[]) => safeFetchMock(...args),
  SafeFetchError: class SafeFetchError extends Error {},
}));

vi.mock("@/lib/logging/context", () => ({
  getEvent: () => ({
    addWarning: vi.fn(),
    addExternalCall: vi.fn(),
    setError: vi.fn(),
  }),
}));

vi.mock("@/lib/notifications/senders/push-attempt-record", () => ({
  recordPushAttempt: (...args: unknown[]) => recordPushAttemptMock(...args),
  recordPushAttemptForPayload: (
    _payload: unknown,
    _recipientUserId: string,
    attempt: unknown,
  ) => recordPushAttemptMock(attempt),
}));

vi.mock("@/lib/db", () => ({
  prisma: { pushSubscription: { findMany: findManyMock, deleteMany: vi.fn() } },
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
  // The sender now signs + encrypts via `generateRequestDetails` and dials
  // through `safeFetch` (pinned dispatcher) instead of letting web-push run
  // its own `https.request`. Same three arguments, so the urgency assertions
  // below are unchanged.
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

import { sendViaNtfy } from "../ntfy";
import { sendViaWebhook } from "../webhook";
import { sendViaWebPush } from "../web-push";

function payload(over?: Record<string, unknown>) {
  return {
    eventType: "SYSTEM_ALERT" as const,
    userId: "user-1",
    title: "Seek care",
    message: "Sustained fever",
    ...over,
  };
}

beforeEach(() => {
  safeFetchMock.mockReset();
  recordPushAttemptMock.mockReset();
  generateRequestDetailsMock.mockReset();
  findManyMock.mockReset();
});

afterEach(() => vi.clearAllMocks());

/** The JSON message the ntfy sender published on call `i`. */
function ntfyMessage(i: number): {
  priority: number;
  tags: string[];
  actions?: unknown;
} {
  return JSON.parse((safeFetchMock.mock.calls[i][1] as { body: string }).body);
}

describe("ntfy urgent mapping", () => {
  it("urgent → Priority 5 (max) + warning tag", async () => {
    safeFetchMock.mockResolvedValue({ ok: true, status: 200 });
    await sendViaNtfy(
      { serverUrl: "https://ntfy.example.com", topic: "t" },
      payload({ urgent: true }),
    );
    expect(ntfyMessage(0).priority).toBe(5);
    expect(ntfyMessage(0).tags).toContain("warning");
  });

  it("non-urgent SYSTEM_ALERT → default priority, no warning tag", async () => {
    safeFetchMock.mockResolvedValue({ ok: true, status: 200 });
    await sendViaNtfy(
      { serverUrl: "https://ntfy.example.com", topic: "t" },
      payload(),
    );
    expect(ntfyMessage(0).priority).toBe(3);
    expect(ntfyMessage(0).tags).not.toContain("warning");
  });

  it("discreet urgent keeps the generic tag (no warning leak)", async () => {
    safeFetchMock.mockResolvedValue({ ok: true, status: 200 });
    await sendViaNtfy(
      { serverUrl: "https://ntfy.example.com", topic: "t" },
      payload({ urgent: true, discreet: true }),
    );
    expect(ntfyMessage(0).priority).toBe(5);
    expect(ntfyMessage(0).tags).toEqual(["reminder"]);
  });

  it("does not send ntfy actions to a managed Guardian", async () => {
    safeFetchMock.mockResolvedValue({ ok: true, status: 200 });
    await sendViaNtfy(
      { serverUrl: "https://ntfy.example.com", topic: "t" },
      payload({
        userId: "record-1",
        recordUserId: "record-1",
        recipientUserId: "guardian-1",
      }),
    );
    expect(ntfyMessage(0).actions).toBeUndefined();
  });
});

describe("webhook urgent mapping", () => {
  it("urgent → priority 'urgent' in the JSON body", async () => {
    safeFetchMock.mockResolvedValue({ ok: true, status: 200 });
    await sendViaWebhook(
      { url: "https://relay.example.com" },
      payload({ urgent: true }),
    );
    const body = JSON.parse(
      (safeFetchMock.mock.calls[0][1] as { body: string }).body,
    );
    expect(body.priority).toBe("urgent");
  });

  it("non-urgent → priority 'default'", async () => {
    safeFetchMock.mockResolvedValue({ ok: true, status: 200 });
    await sendViaWebhook({ url: "https://relay.example.com" }, payload());
    const body = JSON.parse(
      (safeFetchMock.mock.calls[0][1] as { body: string }).body,
    );
    expect(body.priority).toBe("default");
  });
});

describe("web-push urgent mapping", () => {
  it("urgent → Urgency:high option + requireInteraction in payload", async () => {
    findManyMock.mockResolvedValue([
      {
        id: "s1",
        endpoint: "https://push.example.com/x",
        p256dh: "a",
        auth: "b",
      },
    ]);
    safeFetchMock.mockResolvedValue({ ok: true, status: 201 });
    await sendViaWebPush("user-1", payload({ urgent: true }));
    const [, body, options] = generateRequestDetailsMock.mock.calls[0];
    expect((options as { urgency?: string }).urgency).toBe("high");
    expect(JSON.parse(body as string).requireInteraction).toBe(true);
  });

  it("non-urgent → no urgency option, requireInteraction false", async () => {
    findManyMock.mockResolvedValue([
      {
        id: "s1",
        endpoint: "https://push.example.com/x",
        p256dh: "a",
        auth: "b",
      },
    ]);
    safeFetchMock.mockResolvedValue({ ok: true, status: 201 });
    await sendViaWebPush("user-1", payload());
    const [, body, options] = generateRequestDetailsMock.mock.calls[0];
    expect(options).toBeUndefined();
    expect(JSON.parse(body as string).requireInteraction).toBe(false);
  });
});

describe("APNs-less instance degrades gracefully", () => {
  it("an urgent event still escalates ntfy + Web Push with no APNs configured", async () => {
    // No APNs env, no APNs channel — the urgent event reaches the channels
    // that ARE present at their top tier.
    safeFetchMock.mockResolvedValue({ ok: true, status: 200 });
    findManyMock.mockResolvedValue([
      {
        id: "s1",
        endpoint: "https://push.example.com/x",
        p256dh: "a",
        auth: "b",
      },
    ]);

    const ntfy = await sendViaNtfy(
      { serverUrl: "https://ntfy.example.com", topic: "t" },
      payload({ urgent: true }),
    );
    const web = await sendViaWebPush("user-1", payload({ urgent: true }));

    expect(ntfy.ok).toBe(true);
    expect(web.ok).toBe(true);
    expect(ntfyMessage(0).priority).toBe(5);
    expect(
      (generateRequestDetailsMock.mock.calls[0][2] as { urgency?: string })
        .urgency,
    ).toBe("high");
  });
});
