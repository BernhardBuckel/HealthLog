import { describe, expect, it } from "vitest";

import { buildSymptomEventDailySeries } from "@/lib/insights/correlation-series-builders";
import { maskSeriesByModules } from "@/lib/insights/discovery-matrix";

const at = (iso: string) => new Date(iso);

describe("buildSymptomEventDailySeries", () => {
  it("takes the day's highest intensity and zero-fills only between the first and last day", () => {
    const series = buildSymptomEventDailySeries({
      key: "SYMPTOM:def1",
      label: "Aura",
      tz: "Europe/Berlin",
      events: [
        { at: at("2026-07-01T07:00:00.000Z"), intensity: 3 },
        { at: at("2026-07-01T15:00:00.000Z"), intensity: 7 },
        { at: at("2026-07-04T10:00:00.000Z"), intensity: 2 },
      ],
    });
    expect(series).toEqual({
      key: "SYMPTOM:def1",
      label: "Aura",
      role: "outcome",
      points: [
        { day: "2026-07-01", value: 7 },
        { day: "2026-07-02", value: 0 },
        { day: "2026-07-03", value: 0 },
        { day: "2026-07-04", value: 2 },
      ],
    });
  });

  it("keys a late-evening occurrence to the person's own day", () => {
    const series = buildSymptomEventDailySeries({
      key: "SYMPTOM:def1",
      label: "Aura",
      tz: "Europe/Berlin",
      // 23:30 UTC on the 1st is 01:30 on the 2nd in Berlin (summer time).
      events: [{ at: at("2026-07-01T23:30:00.000Z"), intensity: 5 }],
    });
    expect(series.points).toEqual([{ day: "2026-07-02", value: 5 }]);
  });

  it("is empty with no occurrences, so the channel drops out", () => {
    const series = buildSymptomEventDailySeries({
      key: "SYMPTOM:def1",
      label: "Aura",
      tz: "UTC",
      events: [],
    });
    expect(series.points).toEqual([]);
  });
});

describe("the SYMPTOM: channel family follows the illness module", () => {
  const series = [
    { key: "SYMPTOM:def1", role: "outcome" as const, points: [] },
    { key: "SLEEP_DURATION", role: "behaviour" as const, points: [] },
  ];

  it("is masked out when the illness module is off", () => {
    expect(
      maskSeriesByModules(series, { illness: false }).map((s) => s.key),
    ).toEqual(["SLEEP_DURATION"]);
  });

  it("stays when the module is on", () => {
    expect(
      maskSeriesByModules(series, { illness: true }).map((s) => s.key),
    ).toEqual(["SYMPTOM:def1", "SLEEP_DURATION"]);
  });
});
