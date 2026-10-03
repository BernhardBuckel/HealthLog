import { afterEach, describe, expect, it, vi } from "vitest";

import { makeFormatters } from "../format-locale";

/**
 * `dateShortSmartCalendar` prints a stated calendar date (a day key, or its
 * noon-UTC anchor) as that date for every reader, where the zone-aware
 * `dateShortSmart` moves a noon anchor to the next day in UTC+12..+14.
 */
const previousTz = process.env.TZ;
afterEach(() => {
  process.env.TZ = previousTz;
  vi.useRealTimers();
});

describe.each(["America/Los_Angeles", "Pacific/Kiritimati"])(
  "host zone %s",
  (hostTz) => {
    it.each(["Pacific/Kiritimati", "America/Los_Angeles", "Europe/Berlin"])(
      "keeps 4 October for a profile in %s",
      (profileTz) => {
        process.env.TZ = hostTz;
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-10-10T12:00:00.000Z"));
        const fmt = makeFormatters("en", profileTz, "AUTO", "AUTO");

        expect(fmt.dateShortSmartCalendar("2026-10-04")).toBe("10/04");
        expect(
          fmt.dateShortSmartCalendar(new Date("2026-10-04T12:00:00.000Z")),
        ).toBe("10/04");
        expect(fmt.dateShortSmartCalendar("2026-10-04T12:00:00Z")).toBe(
          "10/04",
        );
      },
    );

    it("adds the year outside the current one", () => {
      process.env.TZ = hostTz;
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-10-10T12:00:00.000Z"));
      const fmt = makeFormatters("de", "Europe/Berlin", "AUTO", "AUTO");
      expect(fmt.dateShortSmartCalendar("2025-12-31")).toBe("31.12.2025");
      expect(fmt.dateShortSmartCalendar("2026-01-02")).toBe("02.01.");
    });
  },
);

it("is the bug it replaces: the zone-aware formatter moves the date east of UTC+12", () => {
  const fmt = makeFormatters("en", "Pacific/Kiritimati", "AUTO", "AUTO");
  expect(fmt.dateShortSmart("2026-10-04T12:00:00Z")).toMatch(/^10\/05/);
});
