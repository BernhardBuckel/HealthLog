import { describe, expect, it } from "vitest";

import { canonicalMeasurementsCte } from "@/lib/analytics/source-rank-sql";

import { seriesRowsFrom } from "../series-canonical";

describe("seriesRowsFrom", () => {
  it("collapses a type that has a ladder to the ladder's source per day", () => {
    const sql = seriesRowsFrom(null, "PULSE", 30);
    expect(sql).toContain("DISTINCT ON");
    // Scoped to the one metric, in both halves of the helper.
    expect(sql).toContain(`"type" = 'PULSE'::"measurement_type"`);
    expect(sql).toContain(`mm."type" = 'PULSE'::"measurement_type"`);
    expect(sql.trimEnd().endsWith(") m")).toBe(true);
  });

  it("reads one day wider than the request, so the edge day is picked from all its readings", () => {
    expect(seriesRowsFrom(null, "WEIGHT", 30)).toContain("INTERVAL '31 days'");
    expect(seriesRowsFrom(null, "WEIGHT", 3650)).toContain(
      "INTERVAL '3651 days'",
    );
  });

  it("applies the person's ladder, not only the default one", () => {
    const first = seriesRowsFrom(
      { pulse: ["FITBIT", "APPLE_HEALTH"] },
      "PULSE",
      7,
    );
    const second = seriesRowsFrom(
      { pulse: ["APPLE_HEALTH", "FITBIT"] },
      "PULSE",
      7,
    );
    expect(first).not.toEqual(second);
    expect(first).toMatch(/WHEN 'FITBIT' THEN 0 WHEN 'APPLE_HEALTH' THEN 1/);
    expect(second).toMatch(/WHEN 'APPLE_HEALTH' THEN 0 WHEN 'FITBIT' THEN 1/);
  });

  it.each(["BLOOD_GLUCOSE", "TOTAL_BODY_WATER", "BONE_MASS"] as const)(
    "keeps every source for %s, which has no ladder",
    (type) => {
      const sql = seriesRowsFrom(null, type, 30);
      expect(sql).not.toContain("DISTINCT ON");
      expect(sql).toContain(`mm."type" = '${type}'::"measurement_type"`);
      expect(sql).toContain(`mm."user_id" = $1`);
      expect(sql).toContain(`mm."deleted_at" IS NULL`);
    },
  );

  it.each([0, -1, 1.5, 3651, Number.NaN])("refuses days = %s", (days) => {
    expect(() => seriesRowsFrom(null, "PULSE", days)).toThrow(/days/);
  });
});

describe("canonicalMeasurementsCte, one-metric scope", () => {
  const rank = `CASE "source" WHEN 'A' THEN 0 ELSE 90 END`;

  it("is unchanged when no type is given", () => {
    const sql = canonicalMeasurementsCte(rank, "90 days");
    expect(sql).not.toContain("measurement_type");
  });

  it("scopes the pick and the join to the type when one is given", () => {
    const sql = canonicalMeasurementsCte(rank, "90 days", "PULSE");
    expect(sql.match(/'PULSE'::"measurement_type"/g)).toHaveLength(2);
  });

  it("refuses anything that is not a closed-enum literal", () => {
    expect(() =>
      canonicalMeasurementsCte(rank, undefined, "PULSE'; DROP" as never),
    ).toThrow(/unsafe enum literal/);
  });
});
