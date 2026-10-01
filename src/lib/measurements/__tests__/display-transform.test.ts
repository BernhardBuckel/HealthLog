import { describe, it, expect } from "vitest";

import {
  applyDisplayTransform,
  applyDisplayTransformDelta,
  applyDisplayTransformUnrounded,
  invertDisplayTransform,
  getDisplayTransform,
  hasDisplayTransform,
  transformRescales,
  TRANSFORMED_TYPES,
  DEFAULT_UNIT_PREFERENCE,
  DEFAULT_UNIT_PREFERENCES,
  getQuantityTransform,
  getReadingTransform,
  isUnitSensitiveType,
  paceSecondsPerDistanceUnit,
  resolveUnitPreferences,
} from "../display-transform";
import { convertGlucose } from "@/lib/glucose";

describe("display-transform", () => {
  it("converts WALKING_SPEED m/s → km/h (factor 3.6)", () => {
    const t = getDisplayTransform("WALKING_SPEED", "metric");
    expect(t.factor).toBe(3.6);
    expect(t.displayUnit).toBe("km/h");
    expect(t.decimals).toBe(1);
    // 1.3 m/s → 4.68 km/h, rendered at the declared single decimal.
    expect(applyDisplayTransform(1.3, t)).toBe(4.7);
    expect(applyDisplayTransformUnrounded(1.3, t)).toBeCloseTo(4.68, 5);
  });

  it("converts WALKING_RUNNING_DISTANCE m → km (factor 0.001)", () => {
    const t = getDisplayTransform("WALKING_RUNNING_DISTANCE", "metric");
    expect(t.factor).toBe(0.001);
    expect(t.displayUnit).toBe("km");
    expect(t.decimals).toBe(2);
    // 5000 m → 5.00 km.
    expect(applyDisplayTransform(5000, t)).toBeCloseTo(5, 5);
  });

  it("exposes imperial branches for speed + distance", () => {
    const speed = getDisplayTransform("WALKING_SPEED", "imperial");
    expect(speed.displayUnit).toBe("mph");
    // 1.34 m/s ≈ 2.9975 mph → 3 mph at the declared single decimal.
    expect(applyDisplayTransform(1.34, speed)).toBe(3);
    expect(applyDisplayTransformUnrounded(1.34, speed)).toBeCloseTo(2.9975, 3);

    const dist = getDisplayTransform("WALKING_RUNNING_DISTANCE", "imperial");
    expect(dist.displayUnit).toBe("mi");
    // 1609.34 m ≈ 1 mile, at the two decimals a distance is read at.
    expect(applyDisplayTransform(1609.344, dist)).toBe(1);
  });

  it("returns identity (factor 1) for untransformed types", () => {
    for (const type of [
      "PULSE",
      "WEIGHT",
      "RESPIRATORY_RATE",
      "AUDIO_EXPOSURE_ENV",
    ]) {
      const t = getDisplayTransform(type);
      expect(t.factor).toBe(1);
      // identity scale leaves the raw value untouched
      expect(applyDisplayTransform(42, t)).toBe(42);
    }
  });

  it("identity transform surfaces the canonical unit", () => {
    expect(getDisplayTransform("WEIGHT").displayUnit).toBe("kg");
    expect(getDisplayTransform("PULSE").displayUnit).toBe("bpm");
    expect(getDisplayTransform("WALKING_STEP_LENGTH").displayUnit).toBe("m");
  });

  it("defaults to the metric preference", () => {
    expect(DEFAULT_UNIT_PREFERENCE).toBe("metric");
    expect(getDisplayTransform("WALKING_SPEED")).toEqual(
      getDisplayTransform("WALKING_SPEED", "metric"),
    );
  });

  // ── v1.32.26 — weight-class / length / temperature registry ──

  it("converts WEIGHT kg → lb on the imperial branch", () => {
    const metric = getDisplayTransform("WEIGHT", "metric");
    expect(metric.factor).toBe(1);
    expect(metric.displayUnit).toBe("kg");
    // Metric is the identity on the number — byte-identical to storage.
    expect(applyDisplayTransform(95.25, metric)).toBe(95.25);

    const imperial = getDisplayTransform("WEIGHT", "imperial");
    expect(imperial.displayUnit).toBe("lb");
    // 95.25 kg → 210.0 lb.
    expect(applyDisplayTransform(95.25, imperial)).toBeCloseTo(210.0, 1);
  });

  it("shares the mass branch across every body-mass metric", () => {
    for (const type of [
      "TOTAL_BODY_WATER",
      "BONE_MASS",
      "FAT_MASS",
      "FAT_FREE_MASS",
      "MUSCLE_MASS",
      "LEAN_BODY_MASS",
      "GRIP_STRENGTH",
    ]) {
      expect(getDisplayTransform(type, "imperial").displayUnit).toBe("lb");
      expect(getDisplayTransform(type, "metric").displayUnit).toBe("kg");
      // 10 kg → 22.0462… lb → 22 lb at the pound's single decimal.
      expect(
        applyDisplayTransform(10, getDisplayTransform(type, "imperial")),
      ).toBe(22);
    }
  });

  it("converts WAIST_CIRCUMFERENCE cm → in", () => {
    const imperial = getDisplayTransform("WAIST_CIRCUMFERENCE", "imperial");
    expect(imperial.displayUnit).toBe("in");
    // 84 cm → 33.0708… in → 33.1 in at the inch's single decimal.
    expect(applyDisplayTransform(84, imperial)).toBe(33.1);
  });

  it("converts an ABSOLUTE temperature °C → °F affinely (factor + offset)", () => {
    const metric = getDisplayTransform("BODY_TEMPERATURE", "metric");
    expect(metric.displayUnit).toBe("°C");
    expect(metric.offset ?? 0).toBe(0);

    const imperial = getDisplayTransform("BODY_TEMPERATURE", "imperial");
    expect(imperial.displayUnit).toBe("°F");
    expect(imperial.factor).toBe(1.8);
    expect(imperial.offset).toBe(32);
    // 36.6 °C → 97.88 °F (the +32 shift MUST apply to an absolute reading),
    // rendered at the declared single decimal.
    expect(applyDisplayTransform(36.6, imperial)).toBe(97.9);
    expect(applyDisplayTransformUnrounded(36.6, imperial)).toBeCloseTo(
      97.88,
      2,
    );
    // 0 °C → 32 °F (not 0).
    expect(applyDisplayTransform(0, imperial)).toBe(32);
  });

  it("skin + wrist temperature share the affine temperature branch", () => {
    for (const type of ["SKIN_TEMPERATURE", "WRIST_TEMPERATURE"]) {
      const imperial = getDisplayTransform(type, "imperial");
      expect(imperial.displayUnit).toBe("°F");
      expect(imperial.offset).toBe(32);
    }
  });

  it("BODY_TEMPERATURE_DEVIATION scales °C→°F WITHOUT the offset (it is a Δ)", () => {
    const imperial = getDisplayTransform(
      "BODY_TEMPERATURE_DEVIATION",
      "imperial",
    );
    expect(imperial.displayUnit).toBe("°F");
    expect(imperial.factor).toBe(1.8);
    // A signed deviation is a delta: 1 Δ°C is a 1.8 Δ°F, NEVER 33.8 °F.
    expect(imperial.offset ?? 0).toBe(0);
    expect(applyDisplayTransform(1, imperial)).toBeCloseTo(1.8, 5);
  });

  it("the delta helper NEVER applies the affine offset", () => {
    const imperial = getDisplayTransform("BODY_TEMPERATURE", "imperial");
    // Same absolute transform (offset 32), but a delta must be factor-only.
    expect(applyDisplayTransform(1, imperial)).toBe(33.8);
    expect(applyDisplayTransformDelta(1, imperial)).toBeCloseTo(1.8, 5);
    // A 2 °C rise reads as a 3.6 °F rise, not a 35.6 °F reading.
    expect(applyDisplayTransformDelta(2, imperial)).toBeCloseTo(3.6, 5);
  });

  it("inverse round-trips every registered branch (entry ⇄ display)", () => {
    // The entry boundary works on the UNROUNDED conversion: a display
    // value the surface produced must invert back to the exact canonical
    // number it came from. `applyDisplayTransform` rounds for the screen,
    // so the round-trip property is stated against the raw arithmetic.
    for (const type of TRANSFORMED_TYPES) {
      for (const pref of ["metric", "imperial"] as const) {
        const transform = getDisplayTransform(type, pref);
        for (const raw of [0, 1, 36.6, 84, 95.25, 210]) {
          const shown = applyDisplayTransformUnrounded(raw, transform);
          expect(invertDisplayTransform(shown, transform)).toBeCloseTo(raw, 6);
        }
      }
    }
  });

  it("hasDisplayTransform + TRANSFORMED_TYPES agree, and exclude BMI/glucose", () => {
    expect(hasDisplayTransform("WEIGHT")).toBe(true);
    expect(hasDisplayTransform("BODY_TEMPERATURE")).toBe(true);
    expect(hasDisplayTransform("PULSE")).toBe(false);
    // Deliberately excluded (own preference / universal unit).
    expect(TRANSFORMED_TYPES.has("BLOOD_GLUCOSE")).toBe(false);
    expect(TRANSFORMED_TYPES.has("BODY_MASS_INDEX")).toBe(false);
    // Every registered type resolves a non-identity or symbol-only metric
    // branch, and both branches exist.
    for (const type of TRANSFORMED_TYPES) {
      expect(getDisplayTransform(type, "metric").displayUnit).toBeTruthy();
      expect(getDisplayTransform(type, "imperial").displayUnit).toBeTruthy();
    }
  });
});

/**
 * v1.32.39 — issue #627 follow-up. A conversion declares the decimals its
 * unit is read at; before this the number was carried to the display layer
 * and read by one screen out of all the ones that render a converted value,
 * so everywhere else the raw product of a kilogram and 2.20462262185 went
 * straight to the surface.
 */
describe("display-transform — converted values carry the declared precision", () => {
  it("renders the reported kilogram reading at one decimal, not seventeen", () => {
    // The reporter's case: a stored weight whose pound conversion is a long
    // float. 83.99981845627636 kg * 2.20462262185 is 185.1879000… lb.
    const imperial = getDisplayTransform("WEIGHT", "imperial");
    const raw = 83.99981845627636;
    expect(String(applyDisplayTransformUnrounded(raw, imperial))).toMatch(
      /^185\.1879/,
    );
    expect(applyDisplayTransform(raw, imperial)).toBe(185.2);
    expect(String(applyDisplayTransform(raw, imperial))).toBe("185.2");
  });

  it("rounds every converted unit family to its own declared decimals", () => {
    const cases: Array<[string, number, number]> = [
      // mass: kg → lb, one decimal
      ["WEIGHT", 83.99981845627636, 185.2],
      // length: cm → in, one decimal
      ["WAIST_CIRCUMFERENCE", 84, 33.1],
      // temperature: °C → °F, affine (the offset must survive rounding)
      ["BODY_TEMPERATURE", 36.66666, 98],
      // speed: m/s → mph, one decimal
      ["WALKING_SPEED", 1.3333333, 2.98],
      // distance: m → mi, two decimals
      ["WALKING_RUNNING_DISTANCE", 8046.72, 5],
    ];
    for (const [type, raw, expected] of cases) {
      const transform = getDisplayTransform(type, "imperial");
      const shown = applyDisplayTransform(raw, transform);
      // Re-rounding at the declared grain is a no-op: the value carries no
      // more precision than the transform says it should.
      const scale = 10 ** transform.decimals;
      expect(Math.round(shown * scale) / scale).toBe(shown);
      expect(shown).toBeCloseTo(expected, transform.decimals);
    }
  });

  it("keeps the affine offset exact through the rounding", () => {
    const imperial = getDisplayTransform("BODY_TEMPERATURE", "imperial");
    // 0 °C is 32 °F on the nose; rounding must not shift a clean value.
    expect(applyDisplayTransform(0, imperial)).toBe(32);
    expect(applyDisplayTransform(37, imperial)).toBe(98.6);
    // 36.66666 °C = 97.999988 °F → 98.0, not 97.999988.
    expect(applyDisplayTransform(36.66666, imperial)).toBe(98);
  });

  it("rounds a converted DELTA to the same grain, offset-free", () => {
    const imperial = getDisplayTransform("BODY_TEMPERATURE", "imperial");
    // A 0.37 °C rise is a 0.666 °F rise → 0.7, and never picks up the +32.
    expect(applyDisplayTransformDelta(0.37, imperial)).toBe(0.7);
    const mass = getDisplayTransform("WEIGHT", "imperial");
    expect(applyDisplayTransformDelta(-0.5, mass)).toBe(-1.1);
  });

  it("leaves a metric-preference value completely untouched", () => {
    // The metric branch of every registered type is the identity on the
    // number — it only relabels the symbol. A stored 78.45 kg is not
    // conversion noise and must not be rounded away to 78.5.
    for (const type of TRANSFORMED_TYPES) {
      const metric = getDisplayTransform(type, "metric");
      if (transformRescales(metric)) continue;
      for (const raw of [78.45, 0.123456789, 95.25, 36.66666]) {
        expect(applyDisplayTransform(raw, metric)).toBe(raw);
        expect(applyDisplayTransformDelta(raw, metric)).toBe(raw);
      }
    }
    // Same for a type with no transform at all.
    const identity = getDisplayTransform("PULSE");
    expect(applyDisplayTransform(58.123456789, identity)).toBe(58.123456789);
    expect(applyDisplayTransformDelta(58.123456789, identity)).toBe(
      58.123456789,
    );
  });

  it("keeps the entry path free of drift on a typed imperial value", () => {
    // What the entry surfaces actually do: invert the typed display number
    // (full precision, no rounding), then quantise to the two-decimal
    // canonical dialect. Reopening must show the number that was typed.
    const imperial = getDisplayTransform("WEIGHT", "imperial");
    for (let typed = 70; typed <= 660; typed += 0.1) {
      const shown = Math.round(typed * 10) / 10;
      const inverted = invertDisplayTransform(shown, imperial);
      const canonical = Math.round(inverted * 100) / 100;
      expect(applyDisplayTransform(canonical, imperial)).toBe(shown);
    }
  });

  it("keeps the entry path free of drift on a typed Fahrenheit value", () => {
    const imperial = getDisplayTransform("BODY_TEMPERATURE", "imperial");
    for (let typed = 95; typed <= 106; typed += 0.1) {
      const shown = Math.round(typed * 10) / 10;
      const canonical =
        Math.round(invertDisplayTransform(shown, imperial) * 100) / 100;
      expect(applyDisplayTransform(canonical, imperial)).toBe(shown);
    }
  });

  it("never rounds the inverse — the write path keeps full precision", () => {
    const imperial = getDisplayTransform("WEIGHT", "imperial");
    // 185.2 lb is 84.00825… kg. Quantising here instead of at the entry
    // surface would push the stored value a little further on every save.
    expect(invertDisplayTransform(185.2, imperial)).toBe(
      185.2 / imperial.factor,
    );
    expect(invertDisplayTransform(185.2, imperial)).not.toBe(84);
  });
});

describe("display-transform — both unit preferences, one resolver", () => {
  it("reads glucose in the preferred clinical unit, matching convertGlucose", () => {
    const mmol = getReadingTransform("BLOOD_GLUCOSE", {
      system: "metric",
      glucoseUnit: "mmol/L",
    });
    expect(mmol.displayUnit).toBe("mmol/L");
    for (const mgdl of [54, 70, 99, 126, 140, 250]) {
      expect(applyDisplayTransform(mgdl, mmol)).toBe(
        convertGlucose(mgdl, "mmol/L"),
      );
    }
    const mgdl = getReadingTransform("BLOOD_GLUCOSE", DEFAULT_UNIT_PREFERENCES);
    expect(mgdl.displayUnit).toBe("mg/dL");
    expect(applyDisplayTransform(99, mgdl)).toBe(99);
  });

  it("leaves glucose alone under the imperial preference", () => {
    const t = getReadingTransform("BLOOD_GLUCOSE", {
      system: "imperial",
      glucoseUnit: "mg/dL",
    });
    expect(t.displayUnit).toBe("mg/dL");
  });

  it("delegates every other type to the metric/imperial registry", () => {
    expect(
      getReadingTransform("WEIGHT", {
        system: "imperial",
        glucoseUnit: "mmol/L",
      }).displayUnit,
    ).toBe("lb");
    expect(
      getReadingTransform("PULSE", {
        system: "imperial",
        glucoseUnit: "mmol/L",
      }).displayUnit,
    ).toBe("bpm");
  });

  it("marks glucose and the transformed set as unit-sensitive", () => {
    expect(isUnitSensitiveType("BLOOD_GLUCOSE")).toBe(true);
    expect(isUnitSensitiveType("WEIGHT")).toBe(true);
    expect(isUnitSensitiveType("HEART_RATE_VARIABILITY")).toBe(false);
  });

  it("resolves the stored columns with their defaults", () => {
    expect(resolveUnitPreferences({})).toEqual(DEFAULT_UNIT_PREFERENCES);
    expect(
      resolveUnitPreferences({
        unitPreference: "imperial",
        glucoseUnit: "mmol/L",
      }),
    ).toEqual({ system: "imperial", glucoseUnit: "mmol/L" });
    expect(resolveUnitPreferences({ unitPreference: "bogus" }).system).toBe(
      "metric",
    );
  });

  it("converts workout distance, elevation and pace per preference", () => {
    const km = getQuantityTransform("distance", "metric");
    const mi = getQuantityTransform("distance", "imperial");
    expect(applyDisplayTransform(5000, km)).toBe(5);
    expect(km.displayUnit).toBe("km");
    expect(applyDisplayTransform(5000, mi)).toBe(3.11);
    expect(mi.displayUnit).toBe("mi");
    expect(
      applyDisplayTransform(100, getQuantityTransform("elevation", "imperial")),
    ).toBe(328.1);
    expect(getQuantityTransform("elevation", "metric").displayUnit).toBe("m");
    // 30 min over 5 km: 360 s/km, 579.4 s/mi.
    expect(paceSecondsPerDistanceUnit(1800, 5000, "metric")).toBeCloseTo(
      360,
      6,
    );
    expect(paceSecondsPerDistanceUnit(1800, 5000, "imperial")).toBeCloseTo(
      579.36,
      2,
    );
  });
});
