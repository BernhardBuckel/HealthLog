import { describe, expect, it } from "vitest";

import { makeFormatters } from "@/lib/format-locale";
import { formatLabReading, formatLabValue } from "../format-value";

const de = (n: number) => makeFormatters("de", "UTC", "AUTO", "AUTO").number(n);
const en = (n: number) => makeFormatters("en", "UTC", "AUTO", "AUTO").number(n);

describe("lab value formatting", () => {
  it("trims to two decimals and prints the locale's separator", () => {
    expect(formatLabValue(1.8, de)).toBe("1,8");
    expect(formatLabValue(1.8, en)).toBe("1.8");
    expect(formatLabValue(0.123456, de)).toBe("0,12");
    expect(formatLabValue(5, de)).toBe("5");
  });

  it("formats a numeric reading with its unit and leaves a qualitative one verbatim", () => {
    expect(
      formatLabReading({ value: 61.3, valueText: null, unit: "kg" }, de),
    ).toBe("61,3 kg");
    expect(
      formatLabReading({ value: null, valueText: "negativ", unit: "" }, de),
    ).toBe("negativ");
  });
});
