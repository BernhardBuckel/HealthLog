import { describe, expect, it } from "vitest";

import { resolveBpTargetOverride } from "@/lib/analytics/effective-range";
import { selectBpTargetBand } from "@/lib/queries/use-bp-target-band";
import { buildVitalTargets } from "../vitals-builder";

const NOW = new Date("2026-07-21T12:00:00.000Z");

// `restingPulseProxy` is listed so the literal stays valid whichever shape of
// the input the builder carries; the assertion keeps the extra key legal.
const base = {
  recentMeasurements: [],
  restingPulseProxy: [],
  latestByType: {},
  average30ByType: {},
  heightCm: 178,
  age: 40,
  gender: null,
  timezone: "UTC",
  now: NOW,
  weightTargetOverride: null,
} as unknown as Parameters<typeof buildVitalTargets>[0];

const PROFILE_40 = {
  heightCm: 178,
  dateOfBirth: new Date("1986-03-01T12:00:00.000Z"),
  gender: null,
};

describe("blood-pressure target: the user's own band", () => {
  it("is null when no blood-pressure threshold is stored", () => {
    expect(resolveBpTargetOverride(PROFILE_40, null)).toBeNull();
    expect(
      resolveBpTargetOverride(PROFILE_40, { WEIGHT: { min: 70, max: 75 } }),
    ).toBeNull();
  });

  it("carries the stored band, filling the other half from the age default", () => {
    expect(
      resolveBpTargetOverride(PROFILE_40, {
        BLOOD_PRESSURE_SYS: { min: 110, max: 135 },
      }),
    ).toEqual({ sysLow: 110, sysHigh: 135, diaLow: 70, diaHigh: 79 });
  });

  it("replaces the age band on the card and labels it as the user's", () => {
    const card = buildVitalTargets({
      ...base,
      bpTargetOverride: { sysLow: 110, sysHigh: 135, diaLow: 65, diaHigh: 85 },
    });
    const bp = card.targets.find((t) => t.type === "BLOOD_PRESSURE");
    expect(bp?.range).toEqual({ min: 110, max: 135 });
    expect(bp?.source).toBe("Custom");
    expect(card.bpRange).toEqual({
      sysLow: 110,
      sysHigh: 135,
      diaLow: 65,
      diaHigh: 85,
    });
  });

  it("keeps the ESH age band when none is set", () => {
    const bp = buildVitalTargets(base).targets.find(
      (t) => t.type === "BLOOD_PRESSURE",
    );
    expect(bp?.range).toEqual({ min: 120, max: 129 });
    expect(bp?.source).toBe("ESH 2023");
  });
});

describe("selectBpTargetBand — the chart reads the server's band", () => {
  it("projects the systolic card range and the diastolic range", () => {
    expect(
      selectBpTargetBand({
        targets: [
          { type: "WEIGHT", range: { min: 70, max: 75 } },
          { type: "BLOOD_PRESSURE", range: { min: 110, max: 135 } },
        ],
        bpDiastolic: { range: { min: 65, max: 85 } },
      }),
    ).toEqual({
      systolic: { min: 110, max: 135 },
      diastolic: { min: 65, max: 85 },
    });
  });

  it("draws no band when the server resolved none", () => {
    expect(selectBpTargetBand(null)).toBeNull();
    expect(
      selectBpTargetBand({
        targets: [{ type: "BLOOD_PRESSURE", range: null }],
        bpDiastolic: { range: null },
      }),
    ).toBeNull();
  });
});
