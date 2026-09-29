import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { I18nProvider } from "@/lib/i18n/context";

import type { OcrReviewRow } from "../ocr-review-types";
import { OcrRowEditor } from "../ocr-row-editor";

const baseRow: OcrReviewRow = {
  key: "LDL-0",
  analyte: "LDL",
  value: 2.4,
  valueText: null,
  unit: "mmol/L",
  referenceLow: 0,
  referenceHigh: 3,
  referenceText: null,
  takenAt: null,
  confidence: { analyte: 1, value: 1, unit: 1, range: 1 },
  biomarkerMatch: "existing",
  duplicateOf: null,
  confirmed: true,
};

function render(
  errors: Parameters<typeof OcrRowEditor>[0]["errors"],
  locale: "en" | "de" = "en",
  row: OcrReviewRow = baseRow,
): string {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>
      <OcrRowEditor row={row} onChange={() => {}} errors={errors} />
    </I18nProvider>,
  );
}

describe("<OcrRowEditor> required-field marking", () => {
  it("shows no error state before a save was attempted", () => {
    const html = render(undefined);
    expect(html).not.toContain('aria-invalid="true"');
    expect(html).not.toContain('role="alert"');
  });

  it("marks the missing date, states why, and links the message to the field", () => {
    const html = render({ date: true });
    const invalid = html.match(/<input[^>]*aria-invalid="true"[^>]*>/g) ?? [];
    expect(invalid).toHaveLength(1);
    const describedBy = invalid[0]?.match(/aria-describedby="([^"]+)"/)?.[1];
    expect(describedBy).toBeTruthy();
    expect(html).toContain(`id="${describedBy}"`);
    expect(html).toContain("Add the sample date.");
    expect(html).toContain('role="alert"');
    // The bordered wrapper is what the eye sees.
    expect(html).toContain("border-destructive");
  });

  it("marks only the fields that are wrong", () => {
    const html = render({ unit: true });
    expect(html.match(/aria-invalid="true"/g)).toHaveLength(1);
    expect(html).toContain("Add a unit.");
    expect(html).not.toContain("Add the sample date.");
  });

  it("marks a blank qualitative result", () => {
    const html = render({ valueText: true }, "en", {
      ...baseRow,
      value: null,
      valueText: "",
      unit: null,
    });
    expect(html).toContain("Add a result.");
    expect(html.match(/aria-invalid="true"/g)).toHaveLength(1);
  });

  it("carries a visible required marker on the fields a row needs", () => {
    const html = render(undefined);
    // Value, unit and date on a numeric row.
    expect(html.match(/text-destructive"[^>]*> \*</g)).toHaveLength(3);
  });

  it("speaks German too", () => {
    expect(render({ date: true }, "de")).toContain("Bitte ein Datum angeben.");
  });
});

describe("<OcrRowEditor> layout", () => {
  it("lays out from the width of its container, not the window", () => {
    const html = render(undefined);
    expect(html).toContain('class="@container"');
    // Two columns only once the container is wide; stacked below that.
    expect(html).toContain("@3xl:grid-cols-");
  });

  it("sizes the field grid from its own container, never from the window", () => {
    const numeric = render(undefined);
    expect(numeric).toContain("@md:grid-cols-3");
    expect(numeric).not.toMatch(/(?<![@\w-])sm:grid-cols/);

    // A qualitative result spans the grid's columns; the span has to follow
    // the same query as the columns, or it would open a column of its own.
    const qualitative = render(undefined, "en", {
      ...baseRow,
      value: null,
      valueText: "negative",
      unit: null,
    });
    expect(qualitative).toContain("@md:col-span-3");
    expect(qualitative).not.toMatch(/(?<![@\w-])sm:col-span/);
  });

  it("keeps every field of the row, however the columns fall", () => {
    const html = render(undefined);
    for (const id of ["-val", "-unit", "-date", "-lo", "-hi", "-refText"]) {
      expect(html, `field ${id}`).toContain(`${id}"`);
    }
  });
});
