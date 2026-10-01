/**
 * The glucose block states its time-in-range band in the block's own unit,
 * so the prompt never has to name the band in mg/dL beside mmol/L numbers.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logging/context", () => ({ annotate: vi.fn() }));

import { buildGlucoseBlock } from "../glucose-block";
import type { GlucoseUnit } from "@/lib/glucose";

const NOW = new Date("2026-06-14T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const VALUES = [
  60, 90, 120, 150, 180, 200, 100, 110, 95, 130, 170, 220, 80, 140, 160, 105,
  115, 125, 135, 145,
];

function build(glucoseUnit: GlucoseUnit) {
  const rows = VALUES.map((value, i) => ({
    type: "BLOOD_GLUCOSE",
    value,
    measuredAt: new Date(NOW.getTime() - (VALUES.length - 1 - i) * DAY),
    glucoseContext: null,
  }));
  const snapshot: Record<string, unknown> = {};
  buildGlucoseBlock({
    measurementRows: rows,
    glucoseCutoff: new Date(NOW.getTime() - 60 * DAY),
    glucoseClinicalRows: rows.map(({ value, measuredAt }) => ({
      value,
      measuredAt,
    })),
    glucoseUnit,
    recentCutoff: new Date(NOW.getTime() - 7 * DAY),
    userTz: "UTC",
    now: NOW,
    snapshot,
    metrics: new Set(),
    counts: {},
    registerBlock: () => {},
    groundingValues: new Map(),
  });
  return snapshot.glucose as {
    unit: string;
    clinical: { stillLearning: boolean; tirRange?: unknown };
  };
}

describe("buildGlucoseBlock — time-in-range band", () => {
  it("carries the band in mmol/L for a mmol/L reader", () => {
    const block = build("mmol/L");
    expect(block.unit).toBe("mmol/L");
    expect(block.clinical.stillLearning).toBe(false);
    expect(block.clinical.tirRange).toEqual({ low: 3.9, high: 10 });
  });

  it("carries the band in mg/dL for a mg/dL reader", () => {
    const block = build("mg/dL");
    expect(block.clinical.tirRange).toEqual({ low: 70, high: 180 });
  });
});
