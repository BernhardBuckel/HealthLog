import { describe, expect, it } from "vitest";

import { parseDurationEntry, splitDurationMinutes } from "../parse-duration";

describe("parseDurationEntry — an hours field", () => {
  it.each([
    ["7.5", 7.5, 450],
    ["7,5", 7.5, 450],
    ["  8 ", 8, 480],
    ["7:30", 7.5, 450],
    ["7:05", 7 + 5 / 60, 425],
    ["0:45", 0.75, 45],
    ["7h", 7, 420],
    ["7h30", 7.5, 450],
    ["7h30m", 7.5, 450],
    ["7h 30m", 7.5, 450],
    ["7 h 30 min", 7.5, 450],
    ["7 hrs. 30 mins.", 7.5, 450],
    ["7H30M", 7.5, 450],
    ["8h52m", 8 + 52 / 60, 532],
    ["7,5h", 7.5, 450],
    ["45m", 0.75, 45],
    ["45 min", 0.75, 45],
    ["7 Std 30 Min", 7.5, 450],
    ["7 Stunden 30 Minuten", 7.5, 450],
    ["7u30", 7.5, 450],
    ["7시간 30분", 7.5, 450],
    ["24", 24, 1440],
  ])("reads %j as %d h", (raw, hours, minutes) => {
    const result = parseDurationEntry(raw, "h");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBeCloseTo(hours, 10);
    expect(result.minutes).toBe(minutes);
  });

  it.each([
    ["", "empty"],
    ["   ", "empty"],
    ["-7", "invalid"],
    ["-7h", "invalid"],
    ["abc", "invalid"],
    ["7 30", "invalid"],
    ["7:60", "invalid"],
    ["7h 90m", "invalid"],
    ["7.5.1", "invalid"],
    ["7x", "invalid"],
    ["30m 7h", "invalid"],
    ["25", "tooLong"],
    ["24h 1m", "tooLong"],
    ["1e3", "invalid"],
  ])("refuses %j (%s)", (raw, reason) => {
    expect(parseDurationEntry(raw, "h")).toEqual({ ok: false, reason });
  });
});

describe("parseDurationEntry — a minutes field", () => {
  it.each([
    ["45", 45],
    ["45,5", 45.5],
    ["1h15", 75],
    ["1h 15m", 75],
    ["1:15", 75],
    ["90 min", 90],
    ["2h", 120],
  ])("reads %j as %d min", (raw, minutes) => {
    const result = parseDurationEntry(raw, "min");
    expect(result).toMatchObject({ ok: true, value: minutes });
  });

  it("refuses more than a day", () => {
    expect(parseDurationEntry("1441", "min")).toEqual({
      ok: false,
      reason: "tooLong",
    });
  });

  it("honours a caller's own ceiling", () => {
    expect(parseDurationEntry("3h", "min", 120)).toEqual({
      ok: false,
      reason: "tooLong",
    });
  });
});

describe("splitDurationMinutes", () => {
  it("splits into whole hours and the minutes left over", () => {
    expect(splitDurationMinutes(450)).toEqual({ hours: 7, minutes: 30 });
    expect(splitDurationMinutes(45)).toEqual({ hours: 0, minutes: 45 });
    expect(splitDurationMinutes(479.6)).toEqual({ hours: 8, minutes: 0 });
  });
});
