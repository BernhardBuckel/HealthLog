/**
 * The datum a reaction line reacts to is handed to the model in the reader's
 * units, so the line cannot quote kilograms to a reader on pounds.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const measurementFindMany = vi.fn();
const workoutFindFirst = vi.fn();

vi.mock("@/lib/db", () => ({
  prisma: {
    measurement: {
      findMany: (...a: unknown[]) => measurementFindMany(...a),
    },
    workout: { findFirst: (...a: unknown[]) => workoutFindFirst(...a) },
  },
}));

import { loadArrivalEvidence } from "../reaction-line";

const row = { occurredAt: new Date("2026-09-30T07:00:00Z"), refId: "w1" };
const imperial = {
  timezone: "UTC",
  sourcePriorityJson: null,
  unitPreference: "imperial",
  glucoseUnit: null,
};

beforeEach(() => {
  measurementFindMany.mockReset();
  workoutFindFirst.mockReset();
});

describe("loadArrivalEvidence — the reader's units", () => {
  it("states a new weight in pounds for an imperial reader", async () => {
    measurementFindMany.mockResolvedValue([{ type: "WEIGHT", value: 80 }]);
    const evidence = await loadArrivalEvidence(
      { userId: "u1", kind: "weight", localDate: "2026-09-30", revision: "r" },
      row,
      imperial,
    );
    expect(evidence).toBe("- Newly arrived reading: WEIGHT 176.4 lb.");
  });

  it("states blood pressure in mmHg for every reader", async () => {
    measurementFindMany.mockResolvedValue([
      { type: "BLOOD_PRESSURE_DIA", value: 80 },
      { type: "BLOOD_PRESSURE_SYS", value: 125 },
    ]);
    const evidence = await loadArrivalEvidence(
      {
        userId: "u1",
        kind: "blood_pressure",
        localDate: "2026-09-30",
        revision: "r",
      },
      row,
      imperial,
    );
    expect(evidence).toContain("BLOOD_PRESSURE_SYS 125 mmHg.");
  });

  it("states a workout distance in miles, not metres", async () => {
    measurementFindMany.mockResolvedValue([]);
    workoutFindFirst.mockResolvedValue({
      sportType: "running",
      durationSec: 1800,
      totalDistanceM: 5000,
      totalEnergyKcal: 300,
      avgHeartRate: 150,
    });
    const evidence = await loadArrivalEvidence(
      { userId: "u1", kind: "workout", localDate: "2026-09-30", revision: "r" },
      row,
      imperial,
    );
    expect(evidence).toContain("distance 3.11 mi;");
    expect(evidence).not.toContain("metres");
  });
});
