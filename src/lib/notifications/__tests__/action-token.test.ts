/**
 * Notification quick-action tokens: what a URL holding one can and cannot do.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ACTION_TOKEN_TTL_MS,
  MOOD_QUICK_ACTIONS,
  QUICK_ACTION_IDS,
  buildMoodQuickActions,
  mintActionToken,
  quickActionExternalId,
  verifyActionToken,
} from "@/lib/notifications/action-token";

const ORIGINAL_KEY = process.env.API_TOKEN_HMAC_KEY;
const NOW = Date.UTC(2026, 9, 11, 20, 0, 0);

beforeEach(() => {
  process.env.API_TOKEN_HMAC_KEY = "k".repeat(64);
});

afterEach(() => {
  if (ORIGINAL_KEY === undefined) delete process.env.API_TOKEN_HMAC_KEY;
  else process.env.API_TOKEN_HMAC_KEY = ORIGINAL_KEY;
});

function mint(over: Partial<Parameters<typeof mintActionToken>[0]> = {}) {
  return mintActionToken({
    userId: "user_a",
    action: "mood-good",
    nonce: "nonce1",
    now: NOW,
    ...over,
  });
}

/** Replace one dot-separated field, keeping the original signature. */
function withField(token: string, index: number, value: string): string {
  const parts = token.split(".");
  parts[index] = value;
  return parts.join(".");
}

describe("mood quick actions", () => {
  it("maps good / okay / bad onto the five-point scale (4 / 3 / 2)", () => {
    expect(MOOD_QUICK_ACTIONS).toEqual({
      "mood-good": 4,
      "mood-okay": 3,
      "mood-bad": 2,
    });
    expect(QUICK_ACTION_IDS).toHaveLength(3);
  });

  it("builds three path-safe URLs sharing one nonce", () => {
    const actions = buildMoodQuickActions({
      userId: "user_a",
      origin: "https://health.example",
      labels: { "mood-good": "Good", "mood-okay": "Okay", "mood-bad": "Bad" },
      now: NOW,
    });
    expect(actions.map((a) => a.id)).toEqual([
      "mood-good",
      "mood-okay",
      "mood-bad",
    ]);
    const nonces = new Set<string>();
    for (const action of actions) {
      expect(action.url).toMatch(
        /^https:\/\/health\.example\/api\/notifications\/action\/[A-Za-z0-9._-]+$/,
      );
      const token = action.url.split("/").at(-1) ?? "";
      const verdict = verifyActionToken(token, NOW);
      expect(verdict.ok).toBe(true);
      if (verdict.ok) {
        expect(verdict.action).toBe(action.id);
        nonces.add(verdict.nonce);
      }
    }
    // One nonce: whichever answer lands first uses up the other two.
    expect(nonces.size).toBe(1);
  });

  it("keys the single-use write on the nonce", () => {
    expect(quickActionExternalId("abc")).toBe("notification-action:abc");
  });
});

describe("verifyActionToken", () => {
  it("accepts a fresh token and returns what it is bound to", () => {
    const verdict = verifyActionToken(mint(), NOW + 1000);
    expect(verdict).toEqual({
      ok: true,
      userId: "user_a",
      action: "mood-good",
      nonce: "nonce1",
      expiry: NOW + ACTION_TOKEN_TTL_MS,
    });
  });

  it("refuses a token at and after its expiry", () => {
    const token = mint();
    expect(verifyActionToken(token, NOW + ACTION_TOKEN_TTL_MS - 1).ok).toBe(
      true,
    );
    expect(verifyActionToken(token, NOW + ACTION_TOKEN_TTL_MS)).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  it("refuses a token moved to another user", () => {
    expect(verifyActionToken(withField(mint(), 1, "user_b"), NOW)).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("refuses a token switched to another answer", () => {
    expect(verifyActionToken(withField(mint(), 2, "mood-bad"), NOW)).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("refuses an extended expiry as a forgery, not as fresh", () => {
    const later = String(NOW + 10 * ACTION_TOKEN_TTL_MS);
    expect(
      verifyActionToken(
        withField(mint(), 3, later),
        NOW + 2 * ACTION_TOKEN_TTL_MS,
      ),
    ).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("refuses a tampered signature and a token signed under another key", () => {
    const token = mint();
    const tag = token.split(".").at(-1) ?? "";
    const flipped = `${tag.slice(0, -1)}${tag.endsWith("A") ? "B" : "A"}`;
    expect(verifyActionToken(withField(token, 5, flipped), NOW).ok).toBe(false);

    process.env.API_TOKEN_HMAC_KEY = "z".repeat(64);
    expect(verifyActionToken(token, NOW)).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it.each([
    [""],
    ["na1.user.mood-good.1.n"],
    ["na2.user_a.mood-good.1.n.tag"],
    ["na1.user_a.mood-great.1.n.tag"],
    ["na1.user_a.mood-good.01.n.tag"],
    ["na1..mood-good.1.n.tag"],
    ["x".repeat(400)],
  ])("refuses the malformed token %j", (token) => {
    expect(verifyActionToken(token, NOW)).toEqual({
      ok: false,
      reason: "malformed",
    });
  });

  it("refuses to mint without a signing key", () => {
    delete process.env.API_TOKEN_HMAC_KEY;
    expect(() => mint()).toThrow(/API_TOKEN_HMAC_KEY/);
  });
});
