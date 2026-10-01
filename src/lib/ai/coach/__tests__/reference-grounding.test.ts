import { describe, expect, it } from "vitest";

import { buildReferenceGroundingBlock } from "../reference-grounding";
import { CITATIONS } from "@/lib/medical-citations";

/**
 * W7 — the Coach reference-grounding block. These tests pin the
 * deterministic shape the hallucination-QA pass audits: the right band per
 * metric, the right four-state placement, the general-guidance caveat, the
 * ESH-2023 blood-pressure label, the diabetes opt-in gating, and the hard
 * no-commercial-brand rule.
 */

/**
 * Every commercial brand the Coach prompt already names elsewhere (the
 * GLP-1 block / dose-deferral rule). The grounding block must contain NONE
 * of them — it is brand-free by construction, and this list is the guard.
 */
const BRAND_TOKENS = [
  "Mounjaro",
  "Ozempic",
  "Wegovy",
  "Zepbound",
  "Trulicity",
  "Saxenda",
  "Rybelsus",
  "Eli Lilly",
  "Novo Nordisk",
  "Withings",
  "WHOOP",
  "Oura",
  "Fitbit",
  "Garmin",
  "Apple",
  "Polar",
  "Nightscout",
  "Dexcom",
  "Libre",
];

describe("buildReferenceGroundingBlock", () => {
  it("returns null when no metric is covered by the backbone", () => {
    expect(
      buildReferenceGroundingBlock({ metrics: [], hasDiabetes: false }),
    ).toBeNull();
  });

  it("cites the ESH 2023 source for blood pressure and never the US/ESC line", () => {
    const block = buildReferenceGroundingBlock({
      metrics: [{ metric: "BLOOD_PRESSURE", value: 118 }],
      hasDiabetes: false,
    });
    expect(block).not.toBeNull();
    expect(block).toContain("ESH 2023");
    // The headline normal band edge (≤120 mmHg) is surfaced.
    expect(block).toContain("120 mmHg");
    // The conflicting US/ESC framings stay out of the per-line copy; only
    // the preamble's neutral "(ACC/AHA)" context mentions them.
    expect(block).not.toContain("Stage 1");
    // 118 sits inside the optimal band → "within" placement phrasing.
    expect(block).toContain("sits inside the general reference band");
  });

  it("places an out-of-band value as outside", () => {
    const block = buildReferenceGroundingBlock({
      metrics: [{ metric: "BLOOD_PRESSURE", value: 165 }],
      hasDiabetes: false,
    });
    expect(block).toContain("sits outside the general reference band");
  });

  it("opens and closes with a general-guidance, not-a-diagnosis caveat", () => {
    const block = buildReferenceGroundingBlock({
      metrics: [{ metric: "BMI", value: 22 }],
      hasDiabetes: false,
    })!;
    expect(block).toContain("general guidance");
    expect(block).toContain("not a diagnosis");
    expect(block.toLowerCase()).toContain("not personal medical advice");
    // The closing reminder line is present.
    expect(block).toMatch(/general guidance, not personal medical advice\.$/);
  });

  it("grounds glucose against the general non-diabetic band when the opt-in is off", () => {
    const block = buildReferenceGroundingBlock({
      metrics: [{ metric: "BLOOD_GLUCOSE", value: 92 }],
      hasDiabetes: false,
    })!;
    expect(block).toContain("general non-diabetic normal");
    // The non-diabetic fasting normal ceiling is 100 mg/dL.
    expect(block).toContain("100 mg/dL");
    expect(block).not.toContain("80–130");
    expect(block).toContain("sits inside the general reference band");
  });

  it("grounds glucose against the tighter ADA goal band when diabetes is opted in", () => {
    const inGoal = buildReferenceGroundingBlock({
      metrics: [{ metric: "BLOOD_GLUCOSE", value: 110 }],
      hasDiabetes: true,
    })!;
    // The ADA diabetic fasting goal band, framed as a clinician-set goal.
    expect(inGoal).toContain("80–130 mg/dL");
    expect(inGoal).toContain("management goal");
    expect(inGoal).toContain("clinician-set goal");
    // The line explicitly frames the band as a goal, NOT a screening line.
    expect(inGoal).toContain("not a screening line");
    expect(inGoal).toContain("inside the typical diabetes management goal");

    const outOfGoal = buildReferenceGroundingBlock({
      metrics: [{ metric: "BLOOD_GLUCOSE", value: 200 }],
      hasDiabetes: true,
    })!;
    expect(outOfGoal).toContain("outside the typical diabetes management goal");
  });

  it("states the glucose bands in the reader's glucose unit and still places on mg/dL", () => {
    const units = { system: "metric", glucoseUnit: "mmol/L" } as const;
    const general = buildReferenceGroundingBlock({
      metrics: [{ metric: "BLOOD_GLUCOSE", value: 92 }],
      hasDiabetes: false,
      units,
    })!;
    expect(general).toContain("≤5.5 mmol/L");
    expect(general).not.toContain("mg/dL");
    // 92 mg/dL is inside the fasting band: the placement is canonical.
    expect(general).toContain("sits inside the general reference band");

    const goal = buildReferenceGroundingBlock({
      metrics: [{ metric: "BLOOD_GLUCOSE", value: 200 }],
      hasDiabetes: true,
      units,
    })!;
    expect(goal).toContain("4.4–7.2 mmol/L");
    expect(goal).not.toContain("mg/dL");
    expect(goal).toContain("outside the typical diabetes management goal");
  });

  it("states the body-temperature band in °F for an imperial reader", () => {
    const block = buildReferenceGroundingBlock({
      metrics: [{ metric: "BODY_TEMPERATURE", value: 36.8 }],
      hasDiabetes: false,
      units: { system: "imperial", glucoseUnit: "mg/dL" },
    })!;
    expect(block).toContain("96.3–99.3 °F");
    expect(block).not.toContain("°C");
    expect(block).toContain("sits inside the general reference band");
  });

  it("grounds BMI against the WHO normal band, not the first (Underweight) band", () => {
    // The headline band rendered must be the 18.5–24.9 normal range — the
    // index-0 bug surfaced the Underweight "≤18.5" ceiling instead.
    const normal = buildReferenceGroundingBlock({
      metrics: [{ metric: "BMI", value: 22 }],
      hasDiabetes: false,
    })!;
    const bmiLine = normal.split("\n").find((l) => l.startsWith("- BMI:"))!;
    expect(bmiLine).toContain("18.5–24.9 kg/m²");
    expect(bmiLine).not.toContain("≤18.5");
    // A healthy 22 sits INSIDE the band (was wrongly "just outside").
    expect(bmiLine).toContain("sits inside the general reference band");

    // Underweight 17 sits just outside (was wrongly "inside").
    const under = buildReferenceGroundingBlock({
      metrics: [{ metric: "BMI", value: 17 }],
      hasDiabetes: false,
    })!;
    expect(under.split("\n").find((l) => l.startsWith("- BMI:"))).toContain(
      "sits just outside the general reference band",
    );

    // Overweight 27 sits just outside.
    const over = buildReferenceGroundingBlock({
      metrics: [{ metric: "BMI", value: 27 }],
      hasDiabetes: false,
    })!;
    expect(over.split("\n").find((l) => l.startsWith("- BMI:"))).toContain(
      "sits just outside the general reference band",
    );
  });

  it("grounds pulse pressure against its interior normal band", () => {
    const block = buildReferenceGroundingBlock({
      metrics: [{ metric: "PULSE_PRESSURE", value: 40 }],
      hasDiabetes: false,
    })!;
    const line = block
      .split("\n")
      .find((l) => l.startsWith("- pulse pressure:"))!;
    // The normal "Typical at rest" band (25–60), not the first "Narrow" band.
    expect(line).toContain("25–60 mmHg");
    expect(line).toContain("sits inside the general reference band");
  });

  it("does not ground steps (mean-aggregation misplacement; follow-up)", () => {
    const block = buildReferenceGroundingBlock({
      metrics: [
        { metric: "STEPS", value: 9000 },
        { metric: "BMI", value: 22 },
      ],
      hasDiabetes: false,
    })!;
    // STEPS is dropped; the BMI line still renders.
    expect(block).not.toContain("daily steps");
    expect(block.split("\n").some((l) => l.startsWith("- BMI:"))).toBe(true);
  });

  it("returns null when steps is the only metric (it is not grounded)", () => {
    expect(
      buildReferenceGroundingBlock({
        metrics: [{ metric: "STEPS", value: 9000 }],
        hasDiabetes: false,
      }),
    ).toBeNull();
  });

  it("treats a band-less metric (HRV) as baseline-led, never out-of-band", () => {
    const block = buildReferenceGroundingBlock({
      metrics: [{ metric: "HEART_RATE_VARIABILITY", value: 45 }],
      hasDiabetes: false,
    })!;
    expect(block).toContain("no fixed population band");
    expect(block).not.toContain("sits outside");
  });

  it("is deterministic — identical inputs produce byte-identical output", () => {
    const input = {
      metrics: [
        { metric: "BLOOD_PRESSURE" as const, value: 134 },
        { metric: "BLOOD_GLUCOSE" as const, value: 105 },
        { metric: "SLEEP_DURATION" as const, value: 7.5 },
      ],
      hasDiabetes: false,
    };
    expect(buildReferenceGroundingBlock(input)).toEqual(
      buildReferenceGroundingBlock(input),
    );
  });

  it("caps the number of grounded lines and de-dupes metrics", () => {
    const block = buildReferenceGroundingBlock({
      metrics: [
        { metric: "BMI", value: 22 },
        { metric: "BMI", value: 23 },
      ],
      hasDiabetes: false,
    })!;
    // De-duped: only one BMI line.
    const bmiLines = block.split("\n").filter((l) => l.startsWith("- BMI:"));
    expect(bmiLines).toHaveLength(1);
  });

  it("contains NO commercial brand token in any branch", () => {
    // Exercise both the non-diabetic and diabetic glucose branches plus a
    // broad metric spread so every code path's text is scanned.
    const blocks = [
      buildReferenceGroundingBlock({
        metrics: [
          { metric: "BLOOD_PRESSURE", value: 130 },
          { metric: "BLOOD_GLUCOSE", value: 95 },
          { metric: "RESTING_HEART_RATE", value: 58 },
          { metric: "OXYGEN_SATURATION", value: 97 },
          { metric: "RESPIRATORY_RATE", value: 16 },
          { metric: "BODY_TEMPERATURE", value: 36.8 },
          { metric: "BMI", value: 27 },
          { metric: "STEPS", value: 9000 },
          { metric: "VISCERAL_FAT", value: 8 },
          { metric: "SLEEP_DURATION", value: 8 },
          { metric: "HEART_RATE_VARIABILITY", value: 40 },
        ],
        hasDiabetes: false,
      }),
      buildReferenceGroundingBlock({
        metrics: [{ metric: "BLOOD_GLUCOSE", value: 140 }],
        hasDiabetes: true,
      }),
    ];
    for (const block of blocks) {
      expect(block).not.toBeNull();
      for (const brand of BRAND_TOKENS) {
        expect(block!.toLowerCase()).not.toContain(brand.toLowerCase());
      }
    }
  });

  it("only cites real entries from the medical-citations registry", () => {
    const block = buildReferenceGroundingBlock({
      metrics: [
        { metric: "BLOOD_PRESSURE", value: 120 },
        { metric: "STEPS", value: 9000 },
        { metric: "SLEEP_DURATION", value: 8 },
      ],
      hasDiabetes: false,
    })!;
    // Each cited source label ("NAME (YEAR)") corresponds to a real
    // registry entry — no fabricated guideline names.
    const citationNames = Object.values(CITATIONS).map((c) => c.name);
    // The BP / steps / sleep headline sources must all appear by name.
    expect(citationNames.some((n) => block.includes(n))).toBe(true);
    expect(block).toContain("ESH 2023");
    expect(block).toContain("AASM");
  });
});
