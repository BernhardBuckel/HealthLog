/**
 * Workout distances reach the Coach in the reader's distance unit, named once
 * on the block, instead of raw metres under a metre-named key.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logging/context", () => ({ annotate: vi.fn() }));

import { buildWorkoutsBlock } from "../workouts-block";
import type { UnitPreference } from "@/lib/measurements/display-transform";

function build(unitPreference: UnitPreference) {
  const snapshot: Record<string, unknown> = {};
  buildWorkoutsBlock({
    workoutRows: [
      {
        sportType: "running",
        startedAt: new Date("2026-09-20T07:00:00Z"),
        durationSec: 1800,
        totalEnergyKcal: 300,
        totalDistanceM: 5000,
        avgHeartRate: 150,
        maxHeartRate: 170,
        source: "APPLE_HEALTH",
      },
    ],
    sourcePriorityJson: null,
    userTz: "UTC",
    snapshot,
    metrics: new Set(),
    counts: {},
    registerBlock: () => {},
    unitPreference,
  });
  return snapshot.workouts as {
    distanceUnit: string;
    recent: Array<Record<string, unknown>>;
  };
}

describe("buildWorkoutsBlock — distance unit", () => {
  it("states distance in miles for an imperial reader", () => {
    const block = build("imperial");
    expect(block.distanceUnit).toBe("mi");
    expect(block.recent[0]).toMatchObject({ distance: 3.11 });
    expect(block.recent[0]).not.toHaveProperty("distanceM");
  });

  it("states distance in kilometres for a metric reader", () => {
    const block = build("metric");
    expect(block.distanceUnit).toBe("km");
    expect(block.recent[0]).toMatchObject({ distance: 5 });
  });
});
