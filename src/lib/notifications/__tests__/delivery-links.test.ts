/**
 * The dispatcher's one place for tap targets and quick actions.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { userFindUnique } = vi.hoisted(() => ({ userFindUnique: vi.fn() }));

vi.mock("@/lib/db", () => ({
  prisma: { user: { findUnique: userFindUnique } },
}));

vi.mock("@/lib/logging/context", () => ({
  getEvent: () => ({ addWarning: vi.fn() }),
}));

import { withDeliveryLinks } from "@/lib/notifications/delivery-links";
import { verifyActionToken } from "@/lib/notifications/action-token";
import type { NotificationPayload } from "@/lib/notifications/types";

const ORIGINAL = {
  APP_URL: process.env.APP_URL,
  NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
  API_TOKEN_HMAC_KEY: process.env.API_TOKEN_HMAC_KEY,
};

beforeEach(() => {
  process.env.APP_URL = "https://health.example";
  delete process.env.NEXT_PUBLIC_APP_URL;
  process.env.API_TOKEN_HMAC_KEY = "k".repeat(64);
  userFindUnique.mockResolvedValue({ locale: "de" });
});

afterEach(() => {
  vi.clearAllMocks();
  for (const [key, value] of Object.entries(ORIGINAL)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function payload(over: Partial<NotificationPayload> = {}): NotificationPayload {
  return {
    eventType: "MOOD_REMINDER",
    userId: "u1",
    recordUserId: "u1",
    recipientUserId: "u1",
    title: "t",
    message: "m",
    ...over,
  };
}

describe("withDeliveryLinks", () => {
  it("attaches the tap target in the recipient's language", async () => {
    const out = await withDeliveryLinks(
      payload({ eventType: "DAILY_BRIEFING" }),
      "u1",
    );
    expect(out.tap).toEqual({
      path: "/",
      url: "https://health.example/",
      label: "In HealthLog öffnen",
    });
    expect(out.quickActions).toBeUndefined();
  });

  it("gives a self-delivered mood reminder three signed answers for its recipient", async () => {
    const now = Date.UTC(2026, 9, 11, 20);
    const out = await withDeliveryLinks(payload(), "u1", now);
    expect(out.tap?.url).toBe("https://health.example/mood?add=1");
    expect(out.quickActions?.map((a) => [a.id, a.label])).toEqual([
      ["mood-good", "Gut"],
      ["mood-okay", "Okay"],
      ["mood-bad", "Schlecht"],
    ]);
    for (const action of out.quickActions ?? []) {
      const verdict = verifyActionToken(action.url.split("/").at(-1), now);
      expect(verdict.ok && verdict.userId).toBe("u1");
    }
  });

  it("offers no answers to a Guardian", async () => {
    const out = await withDeliveryLinks(
      payload({ recordUserId: "record-1", recipientUserId: "guardian-1" }),
      "guardian-1",
    );
    expect(out.quickActions).toBeUndefined();
    expect(out.tap).toBeUndefined();
  });

  it("keeps the path but drops absolute URLs and answers without a public origin", async () => {
    delete process.env.APP_URL;
    const out = await withDeliveryLinks(payload(), "u1");
    expect(out.tap).toEqual({
      path: "/mood?add=1",
      url: null,
      label: "In HealthLog öffnen",
    });
    expect(out.quickActions).toBeUndefined();
  });

  it("still delivers, without answers, when no signing key is configured", async () => {
    delete process.env.API_TOKEN_HMAC_KEY;
    const out = await withDeliveryLinks(payload(), "u1");
    expect(out.quickActions).toBeUndefined();
    expect(out.tap?.path).toBe("/mood?add=1");
  });

  it("returns the silent sync push untouched, without a locale read", async () => {
    const input = payload({ eventType: "MEDICATION_INTAKE_SYNC" });
    const out = await withDeliveryLinks(input, "u1");
    expect(out).toBe(input);
    expect(userFindUnique).not.toHaveBeenCalled();
  });
});
