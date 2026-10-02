import { describe, it, expect } from "vitest";

import {
  TYPE_TO_SUB_PAGE_SLUG,
  subPageSlugForType,
} from "@/lib/insights/sub-page-metric";

/**
 * v1.22 — the measurements list lets a user click a metric type to drill
 * into its Insights sub-page. The reverse map underneath must resolve an
 * ambiguous type to its dedicated single-metric page, never a multi-metric
 * cluster page, and must stay silent for types with no card so the caller
 * falls back to the filtered list.
 */
describe("type → insights sub-page slug", () => {
  it("prefers the dedicated single-metric page over a multi-metric one", () => {
    // PULSE lives on both `pulse` (=[PULSE]) and `blood-pressure`
    // (=[SYS, DIA, PULSE]) — the single-metric page wins.
    expect(subPageSlugForType("PULSE")).toBe("pulse");
    // WEIGHT lives on both `weight` (=[WEIGHT]) and the derived `bmi`
    // (=[WEIGHT]) — the first single-metric page in slug order wins.
    expect(subPageSlugForType("WEIGHT")).toBe("weight");
  });

  it("falls back to the multi-metric page for its component types", () => {
    expect(subPageSlugForType("BLOOD_PRESSURE_SYS")).toBe("blood-pressure");
    expect(subPageSlugForType("BLOOD_PRESSURE_DIA")).toBe("blood-pressure");
    // Both HRV flavours only appear on the `hrv` page.
    expect(subPageSlugForType("HEART_RATE_VARIABILITY")).toBe("hrv");
    expect(subPageSlugForType("HRV_RMSSD")).toBe("hrv");
  });

  it("maps a plain single-metric type to its page", () => {
    expect(subPageSlugForType("ACTIVITY_STEPS")).toBe("steps");
    expect(subPageSlugForType("MOOD")).toBe("mood");
    expect(subPageSlugForType("BLOOD_GLUCOSE")).toBe("blood-glucose");
    // Body fat gained its own page so the dashboard tile has somewhere to go;
    // it used to fall back to the filtered measurements list.
    expect(subPageSlugForType("BODY_FAT")).toBe("body-fat");
  });

  it("returns undefined for a type with no sub-page", () => {
    expect(subPageSlugForType("RECOVERY_SCORE")).toBeUndefined();
    expect(subPageSlugForType("NOT_A_REAL_TYPE")).toBeUndefined();
  });

  it("never resolves a type to an empty-metric (event-driven) page", () => {
    // `workouts` and `medications` carry no measurement series, so no type
    // should ever resolve to them.
    for (const slug of Object.values(TYPE_TO_SUB_PAGE_SLUG)) {
      expect(slug).not.toBe("workouts");
      expect(slug).not.toBe("medications");
    }
  });
});
