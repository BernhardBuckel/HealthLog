/**
 * The event → tap-target map and its resolver.
 *
 * Walks `EVENT_TYPES` rather than the map's own keys, so an event type added
 * to the union without a decision about where it leads fails here (the
 * `Record<EventType, …>` type already refuses to compile without one; this
 * pins that every entry is also a usable path).
 */
import { afterEach, describe, expect, it } from "vitest";

import { EVENT_TYPES, type EventType } from "@/lib/notifications/types";
import {
  NOTIFICATION_TAP_PATHS,
  absoluteAppUrl,
  configuredAppOrigin,
  isSafeAppPath,
  resolveTapPath,
  telegramLinkMode,
} from "@/lib/notifications/tap-target";

/** Events never shown to the user, so they carry no target. */
const SILENT: ReadonlySet<EventType> = new Set(["MEDICATION_INTAKE_SYNC"]);

const ORIGINAL = {
  APP_URL: process.env.APP_URL,
  NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
};

afterEach(() => {
  for (const [key, value] of Object.entries(ORIGINAL)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("NOTIFICATION_TAP_PATHS", () => {
  it("names a target for every event type", () => {
    expect(EVENT_TYPES.length).toBeGreaterThan(0);
    for (const eventType of EVENT_TYPES) {
      expect(
        Object.prototype.hasOwnProperty.call(NOTIFICATION_TAP_PATHS, eventType),
        `${eventType} has no tap target`,
      ).toBe(true);
      const path = NOTIFICATION_TAP_PATHS[eventType];
      if (SILENT.has(eventType)) {
        expect(path, `${eventType} is silent`).toBeNull();
      } else {
        expect(isSafeAppPath(path), `${eventType} → ${path}`).toBe(true);
        expect(resolveTapPath({ eventType }), eventType).toBe(path);
      }
    }
  });

  it("keeps the targets the issue names", () => {
    expect(NOTIFICATION_TAP_PATHS.MOOD_REMINDER).toBe("/mood?add=1");
    expect(NOTIFICATION_TAP_PATHS.DAILY_BRIEFING).toBe("/");
    expect(NOTIFICATION_TAP_PATHS.WITHINGS_SYNC_FAILED).toBe(
      "/settings/integrations",
    );
    expect(NOTIFICATION_TAP_PATHS.MEDICATION_REMINDER).toBe("/medications");
  });

  it("has no entry for an event type outside the union", () => {
    expect(Object.keys(NOTIFICATION_TAP_PATHS).sort()).toEqual(
      [...EVENT_TYPES].sort(),
    );
  });
});

describe("resolveTapPath", () => {
  it("takes a producer's same-origin path over the default", () => {
    expect(
      resolveTapPath({
        eventType: "MEDICATION_LOW_STOCK",
        metadata: { url: "/medications/m1?tab=bestand" },
      }),
    ).toBe("/medications/m1?tab=bestand");
  });

  it.each([
    "https://evil.example/",
    "//evil.example/x",
    "/\\evil.example",
    "javascript:alert(1)",
    "/a b",
    "",
    42,
  ])("ignores an unsafe override %j", (url) => {
    expect(
      resolveTapPath({ eventType: "COACH_NUDGE", metadata: { url } }),
    ).toBe("/coach");
  });

  it("gives a managed Guardian delivery no path", () => {
    expect(
      resolveTapPath({
        eventType: "MEDICATION_REMINDER",
        recordUserId: "record-1",
        recipientUserId: "guardian-1",
      }),
    ).toBeNull();
  });

  it("keeps a self delivery's path when both ids are the same", () => {
    expect(
      resolveTapPath({
        eventType: "MEDICATION_REMINDER",
        recordUserId: "u1",
        recipientUserId: "u1",
      }),
    ).toBe("/medications");
  });

  it("gives a discreet delivery no path, so nothing names the cycle surface", () => {
    expect(
      resolveTapPath({ eventType: "CYCLE_PERIOD_SOON", discreet: true }),
    ).toBeNull();
  });

  it("gives the silent sync push no path even with an override", () => {
    expect(
      resolveTapPath({
        eventType: "MEDICATION_INTAKE_SYNC",
        metadata: { url: "/medications" },
      }),
    ).toBeNull();
  });
});

describe("configuredAppOrigin / absoluteAppUrl", () => {
  it("prefers APP_URL, then NEXT_PUBLIC_APP_URL, and keeps only the origin", () => {
    process.env.APP_URL = "https://health.example/some/path";
    process.env.NEXT_PUBLIC_APP_URL = "https://other.example";
    expect(configuredAppOrigin()).toBe("https://health.example");
    delete process.env.APP_URL;
    expect(configuredAppOrigin()).toBe("https://other.example");
  });

  it("returns null without a usable origin, and so no absolute URL", () => {
    delete process.env.APP_URL;
    process.env.NEXT_PUBLIC_APP_URL = "not a url";
    expect(configuredAppOrigin()).toBeNull();
    expect(absoluteAppUrl("/mood?add=1")).toBeNull();
  });

  it("joins origin and path", () => {
    expect(absoluteAppUrl("/mood?add=1", "https://h.example")).toBe(
      "https://h.example/mood?add=1",
    );
    expect(absoluteAppUrl(null, "https://h.example")).toBeNull();
  });
});

describe("telegramLinkMode", () => {
  it.each([
    ["https://health.example/", "button"],
    ["http://nas.lan:3000/", "text"],
    ["https://localhost:3000/", "none"],
    ["http://127.0.0.1/", "none"],
    ["https://app.localhost/", "none"],
    ["ftp://health.example/", "none"],
    ["nonsense", "none"],
  ])("%s → %s", (url, mode) => {
    expect(telegramLinkMode(url)).toBe(mode);
  });
});
