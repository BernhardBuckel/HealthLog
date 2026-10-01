/**
 * v1.27.13 (Welle J) — the interpretation block renders the guideline band
 * table + server-computed position into the assessment prompt. These guards
 * assert it renders for a covered metric (with the value's band named) and is
 * ABSENT for an uncovered one or a sex-required metric with no known sex —
 * i.e. the surface fails soft to personal-relative exactly as before.
 */
import { describe, expect, it } from "vitest";
import { buildInterpretationBlock } from "../interpretation-block";

describe("buildInterpretationBlock", () => {
  it("classifies on the canonical value but prints in the reader's unit", () => {
    const toF = (c: number) => Math.round((c * 1.8 + 32) * 10) / 10;
    const block = buildInterpretationBlock({
      metricKey: "BODY_TEMPERATURE",
      value: 36.8,
      sex: null,
      locale: "en",
      display: { unit: "°F", convert: toF },
    });
    expect(block).toBeDefined();
    expect(block).toContain("Current value 98.2 °F");
    expect(block).not.toContain("°C");
    // Same band as the canonical block names.
    const canonical = buildInterpretationBlock({
      metricKey: "BODY_TEMPERATURE",
      value: 36.8,
      sex: null,
      locale: "en",
    })!;
    const band = (text: string) => text.match(/is in the "([^"]+)" band/)![1];
    expect(band(block!)).toBe(band(canonical));
  });

  it("renders the band position for visceral fat 2.7 (the headline case)", () => {
    const en = buildInterpretationBlock({
      metricKey: "VISCERAL_FAT",
      value: 2.7,
      sex: null,
      locale: "en",
    });
    expect(en).toBeDefined();
    expect(en).toContain("INTERPRETATION CONTEXT");
    expect(en).toContain('"healthy" band');
    expect(en).toContain("2.7 rating");
    // The band table + source tag are present.
    expect(en).toContain("below 13 rating: healthy");
    expect(en).toContain("consumer rating convention");
    // No-diagnosis framing rule is present.
    expect(en).toContain("never");
  });

  it("renders a German block with the localised heading", () => {
    const de = buildInterpretationBlock({
      metricKey: "OXYGEN_SATURATION",
      value: 97,
      sex: null,
      locale: "de",
    });
    expect(de).toBeDefined();
    expect(de).toContain("EINORDNUNGS-KONTEXT");
    expect(de).toContain("StatPearls/NIH 2023");
  });

  it("names the boundary when a value hugs a band edge", () => {
    const en = buildInterpretationBlock({
      metricKey: "BODY_TEMPERATURE",
      value: 37.95,
      sex: null,
      locale: "en",
    });
    // 37.95 is in the borderline band (37.5–38) hugging the fever edge at 38.
    expect(en).toContain("borderline");
    expect(en).toContain("UPPER boundary");
  });

  it("is undefined for an uncovered metric (personal-relative fallback)", () => {
    expect(
      buildInterpretationBlock({
        metricKey: "HEART_RATE_VARIABILITY",
        value: 42,
        sex: null,
        locale: "en",
      }),
    ).toBeUndefined();
  });

  it("is undefined for a sex-split metric when the sex is unknown", () => {
    expect(
      buildInterpretationBlock({
        metricKey: "WAIST_CIRCUMFERENCE",
        value: 96,
        sex: null,
        locale: "en",
      }),
    ).toBeUndefined();
    // With a sex, it renders and names the increased-risk band.
    const male = buildInterpretationBlock({
      metricKey: "WAIST_CIRCUMFERENCE",
      value: 96,
      sex: "MALE",
      locale: "en",
    });
    expect(male).toContain("increased risk");
  });
});
