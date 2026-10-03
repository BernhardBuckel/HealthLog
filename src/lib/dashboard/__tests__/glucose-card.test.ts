import { describe, expect, it } from "vitest";

import { glucoseCardInDisplayUnit } from "../glucose-card";

const card = (over: Record<string, unknown> = {}) => ({
  kind: "glucose",
  latestValue: 101 as number | null,
  secondaryValue: null as number | null,
  sparkline: [90, 101, 126],
  unit: null as string | null,
  unitKey: "dashboard.metric.unit.glucose",
  ...over,
});

describe("glucoseCardInDisplayUnit", () => {
  it("converts the card to mmol/L and names the unit", () => {
    expect(glucoseCardInDisplayUnit(card(), "mmol/L")).toMatchObject({
      latestValue: 5.6,
      secondaryValue: null,
      sparkline: [5, 5.6, 7],
      unit: "mmol/L",
      unitKey: "dashboard.metric.unit.glucose",
    });
  });

  it("keeps mg/dL values and names that unit too", () => {
    expect(glucoseCardInDisplayUnit(card(), "mg/dL")).toMatchObject({
      latestValue: 101,
      sparkline: [90, 101, 126],
      unit: "mg/dL",
    });
  });

  it("leaves an empty card empty", () => {
    expect(
      glucoseCardInDisplayUnit(
        card({ latestValue: null, sparkline: [] }),
        "mmol/L",
      ),
    ).toMatchObject({ latestValue: null, sparkline: [], unit: "mmol/L" });
  });

  it("passes every other card through untouched", () => {
    const weight = card({ kind: "weight", latestValue: 80 });
    expect(glucoseCardInDisplayUnit(weight, "mmol/L")).toBe(weight);
  });
});
