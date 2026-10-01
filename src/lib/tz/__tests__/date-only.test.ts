import { describe, expect, it } from "vitest";
import {
  dateOnlyAtNoonUtc,
  dateOnlyKey,
  dayKeyAsUtcMidnight,
  isCalendarDateKey,
  isDateOnlyKey,
  statedDateKey,
} from "../date-only";
import { daysBetweenDateKeys, weekdayOfDateKey } from "../format";

describe("date-only values", () => {
  it("stores a date at noon UTC and reads it back", () => {
    const stored = dateOnlyAtNoonUtc("2026-06-10");
    expect(stored.toISOString()).toBe("2026-06-10T12:00:00.000Z");
    expect(dateOnlyKey(stored)).toBe("2026-06-10");
  });

  it("reads a row stored at UTC midnight as the same date", () => {
    expect(dateOnlyKey(dayKeyAsUtcMidnight("2026-06-10"))).toBe("2026-06-10");
  });

  it("tells a shape from a real calendar date", () => {
    expect(isDateOnlyKey("2026-02-30")).toBe(true);
    expect(isCalendarDateKey("2026-02-30")).toBe(false);
    expect(isCalendarDateKey("2028-02-29")).toBe(true);
    expect(isCalendarDateKey("2026-6-1")).toBe(false);
  });

  it("reads the date a string states", () => {
    expect(statedDateKey("2026-06-10")).toBe("2026-06-10");
    expect(statedDateKey("2026-06-10T23:30:00-07:00")).toBe("2026-06-10");
    expect(statedDateKey(" 2026-06-10 ")).toBe("2026-06-10");
    expect(statedDateKey("June 10, 2026")).toBe("2026-06-10");
    expect(statedDateKey("2026-02-30")).toBeNull();
    expect(statedDateKey("not a date")).toBeNull();
  });
});

describe("calendar key arithmetic", () => {
  it("counts whole days between keys across a DST change", () => {
    expect(daysBetweenDateKeys("2026-03-28", "2026-03-30")).toBe(2);
    expect(daysBetweenDateKeys("2026-03-30", "2026-03-28")).toBe(-2);
    expect(daysBetweenDateKeys("2025-12-31", "2026-01-01")).toBe(1);
    expect(daysBetweenDateKeys("bad", "2026-01-01")).toBeNaN();
  });

  it("names the weekday of a key", () => {
    expect(weekdayOfDateKey("2026-10-01")).toBe(4); // Thursday
    expect(weekdayOfDateKey("2026-10-04")).toBe(0); // Sunday
  });
});
