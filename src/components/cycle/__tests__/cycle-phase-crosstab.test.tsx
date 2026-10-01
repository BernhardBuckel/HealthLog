import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// The crosstab reads the unit preference through `useUnitDisplay`, which hangs
// off `useAuth` (a react-query hook). These are static SSR renders with no
// QueryClient, so mock the hook to a real metric-preference implementation —
// metric is the identity on values and yields the canonical display symbols,
// so the assertions below (kg, °C, unchanged numbers) hold.
const reader = vi.hoisted(() => ({
  glucoseUnit: "mg/dL" as "mg/dL" | "mmol/L",
}));

vi.mock("@/hooks/use-unit-display", async () => {
  const dt = await import("@/lib/measurements/display-transform");
  const forType = (t: string) => dt.getDisplayTransform(t, "metric");
  return {
    useUnitDisplay: () => ({
      preference: "metric" as const,
      glucoseUnit: reader.glucoseUnit,
      transformFor: forType,
      toDisplay: (t: string, v: number) =>
        dt.applyDisplayTransform(v, forType(t)),
      fromDisplay: (t: string, v: number) =>
        dt.invertDisplayTransform(v, forType(t)),
      toDisplayDelta: (t: string, v: number) =>
        dt.applyDisplayTransformDelta(v, forType(t)),
      unitFor: (t: string) => forType(t).displayUnit,
      decimalsFor: (t: string) => forType(t).decimals,
      isTransformed: (t: string) => dt.hasDisplayTransform(t),
    }),
  };
});

import {
  CyclePhaseCrosstab,
  CyclePhaseHeadline,
  type CyclePhaseCrosstabRow,
  type CyclePhaseCrosstabDisplay,
} from "../cycle-phase-crosstab";
import { I18nProvider } from "@/lib/i18n/context";

function render(node: React.ReactNode) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">{node}</I18nProvider>,
  );
}

function row(
  metricKey: string,
  display: CyclePhaseCrosstabDisplay,
): CyclePhaseCrosstabRow {
  return {
    metricKey,
    display,
    lutealDays: 12,
    follicularDays: 11,
    lutealAvg: 5,
    follicularAvg: 4,
    delta: 1,
    pValue: 0.01,
    qValue: 0.02,
    confidence: "high",
  };
}

describe("<CyclePhaseCrosstab>", () => {
  // Regression: the server emits `display: "mood"` and `display: "glucose"`,
  // which the client UNIT_KEY map did not cover. The map miss handed `undefined`
  // to `t()`, whose resolver runs `key.split(".")` → "Cannot read properties of
  // undefined (reading 'split')", crashing the whole insights tab.
  it("renders mood and glucose rows without throwing", () => {
    expect(() =>
      render(
        <CyclePhaseCrosstab
          rows={[row("mood", "mood"), row("bloodGlucose", "glucose")]}
        />,
      ),
    ).not.toThrow();
  });

  it("resolves the mood + glucose metric labels and units", () => {
    const html = render(
      <CyclePhaseCrosstab
        rows={[row("mood", "mood"), row("bloodGlucose", "glucose")]}
      />,
    );
    expect(html).toContain("Mood");
    expect(html).toContain("Blood glucose");
    expect(html).toContain("pts");
    expect(html).toContain("mg/dL");
    // Never leaks the raw metric key or the raw i18n key on a covered row.
    expect(html).not.toContain("cycle.insights.crosstab");
  });

  it("renders the headline for a mood row without throwing", () => {
    expect(() =>
      render(<CyclePhaseHeadline headline={row("mood", "mood")} />),
    ).not.toThrow();
  });

  it("degrades an unknown display to an empty unit instead of crashing", () => {
    const unknown = row(
      "somethingNew",
      "unmappedDisplay" as unknown as CyclePhaseCrosstabDisplay,
    );
    expect(() => render(<CyclePhaseCrosstab rows={[unknown]} />)).not.toThrow();
    expect(() =>
      render(<CyclePhaseHeadline headline={unknown} />),
    ).not.toThrow();
    // The delta still renders; the unit segment is simply blank (trailing space
    // trimmed away in markup), never the literal "undefined".
    const html = render(<CyclePhaseCrosstab rows={[unknown]} />);
    expect(html).not.toContain("undefined");
  });

  it("states a glucose row in mmol/L for an mmol/L reader", () => {
    reader.glucoseUnit = "mmol/L";
    try {
      const glucose: CyclePhaseCrosstabRow = {
        ...row("bloodGlucose", "glucose"),
        lutealAvg: 108,
        follicularAvg: 90,
        delta: 18,
      };
      const html = render(<CyclePhaseCrosstab rows={[glucose]} />);
      // 18 mg/dL is 1.0 mmol/L; 108 / 90 mg/dL are 6.0 / 5.0 mmol/L.
      expect(html).toContain("+1.0 mmol/L");
      expect(html).toContain("6.0");
      expect(html).not.toContain("mg/dL");
      expect(render(<CyclePhaseHeadline headline={glucose} />)).toContain(
        "mmol/L",
      );
    } finally {
      reader.glucoseUnit = "mg/dL";
    }
  });
});
