import { describe, expect, it } from "vitest";

import { TIMELINE_RANGE_MAX_DAYS } from "@/lib/day/contract";

import { dayKey, dayNumber } from "../timeline-dates";
import {
  clampRange,
  hasDataBeforeWindow,
  parseTimelineUrl,
  resolveDefaultWindow,
  timelineSearch,
} from "../timeline-url";

const TODAY = "2026-10-07";
const parse = (search: string) =>
  parseTimelineUrl(new URLSearchParams(search), TODAY);

describe("timeline URL", () => {
  it("reads a fixed zoom and leaves the choice open without one", () => {
    expect(parse("")).toEqual({ zoom: null, range: null });
    expect(parse("zoom=year")).toEqual({ zoom: "year", range: null });
    expect(parse("zoom=quarter&day=2026-01-03")).toEqual({
      zoom: "quarter",
      range: null,
    });
  });

  it("reads a chosen range with both ends", () => {
    expect(parse("zoom=range&from=2026-03-01&to=2026-04-15")).toEqual({
      zoom: "range",
      range: { from: "2026-03-01", to: "2026-04-15" },
    });
  });

  it("reads anything it cannot read as no zoom, the same default as none", () => {
    for (const search of [
      "zoom=decade",
      "zoom=range",
      "zoom=range&from=2026-03-01",
      "zoom=range&from=2026-02-30&to=2026-04-15",
      "zoom=range&from=2026-05-01&to=2026-04-15",
      "zoom=range&from=2027-01-01&to=2027-02-01",
      "zoom=range&from=yesterday&to=today",
    ]) {
      expect(parse(search), search).toEqual(parse(""));
    }
  });

  it("knows when a window misses the record's older entries", () => {
    const quarter = { from: "2026-08-01" };
    expect(hasDataBeforeWindow("2025-02-11", quarter)).toBe(true);
    expect(hasDataBeforeWindow("2026-08-01", quarter)).toBe(false);
    expect(hasDataBeforeWindow("2026-09-15", quarter)).toBe(false);
    expect(hasDataBeforeWindow(null, quarter)).toBe(false);
    expect(hasDataBeforeWindow("2025-02-11", null)).toBe(false);
  });

  it("adapts the default window to the record", () => {
    // The default three months up to 2026-10-07.
    const window = { from: "2026-08-01", to: "2026-10-31" };
    const decide = (dataFrom: string | null, windowHasData: boolean) =>
      resolveDefaultWindow({ dataFrom, window, windowHasData, today: TODAY });

    // 1. A young record starts at its first entry...
    expect(decide("2026-09-01", true)).toEqual({
      zoom: "quarter",
      from: "2026-09-01",
    });
    // ...but spans at least four weeks up to today.
    expect(decide("2026-10-05", true)).toEqual({
      zoom: "quarter",
      from: "2026-09-10",
    });
    // A first entry on the window's first day is the plain three months.
    expect(decide("2026-08-01", true)).toEqual({ zoom: "quarter", from: null });
    // 2. An older record with entries in the three months: three months.
    expect(decide("2019-01-01", true)).toEqual({ zoom: "quarter", from: null });
    // 3. An older record with none there: everything.
    expect(decide("2019-01-01", false)).toEqual({ zoom: "all" });
    // 4. No data at all: the plain empty state.
    expect(decide(null, false)).toBeNull();
  });

  it("pulls a range's end back to today and its span under the cap", () => {
    expect(parse("zoom=range&from=2026-09-01&to=2027-01-01").range).toEqual({
      from: "2026-09-01",
      to: TODAY,
    });
    const long = clampRange({ from: "1990-01-01", to: TODAY }, TODAY, null);
    expect(dayNumber(long.to) - dayNumber(long.from) + 1).toBe(
      TIMELINE_RANGE_MAX_DAYS,
    );
    expect(long.from).toBe(
      dayKey(dayNumber(TODAY) - TIMELINE_RANGE_MAX_DAYS + 1),
    );
  });

  it("writes the zoom and range and keeps every other parameter", () => {
    expect(
      timelineSearch("?day=2026-01-03", "range", {
        from: "2026-01-01",
        to: "2026-01-31",
      }),
    ).toBe("?day=2026-01-03&zoom=range&from=2026-01-01&to=2026-01-31");
    expect(
      timelineSearch("?zoom=range&from=2026-01-01&to=2026-01-31", "year", null),
    ).toBe("?zoom=year");
  });
});
