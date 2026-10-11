import { describe, expect, it } from "vitest";

import { foldForMatch } from "@/lib/i18n/fold-for-match";

import { matchAnalyteKey, analyteNameIndex } from "../analyte-match";
import { ANALYTE_ALIASES, BIOMARKER_CATALOG } from "../biomarker-catalog";
import { analyteAcceptsUnit } from "../unit-conversion/convert";
import {
  allAnalyteConversions,
  analyteConversionFor,
} from "../unit-conversion/registry";

const match = (name: string, unit: string) => matchAnalyteKey({ name, unit });

describe("the catalog's own names, in every language", () => {
  it.each([
    ["Fasting glucose", "mg/dL", "fasting-glucose"],
    ["Nüchternglukose", "mg/dL", "fasting-glucose"],
    ["Glucosa en ayunas", "mg/dL", "fasting-glucose"],
    ["Glycémie à jeun", "mmol/L", "fasting-glucose"],
    ["Glicemia a digiuno", "mg/dL", "fasting-glucose"],
    ["공복혈당", "mg/dL", "fasting-glucose"],
    ["Glukoza na czczo", "mg/dL", "fasting-glucose"],
    ["HbA1c", "%", "hba1c"],
    ["Total cholesterol", "mg/dL", "total-cholesterol"],
    ["Gesamtcholesterin", "mg/dL", "total-cholesterol"],
    ["Cholestérol total", "mmol/L", "total-cholesterol"],
    ["LDL cholesterol", "mg/dL", "ldl"],
    ["LDL-Cholesterin", "mg/dL", "total-cholesterol"],
    ["Colesterolo HDL", "mg/dL", "total-cholesterol"],
    ["Vitamin D (25-OH)", "ng/mL", "vitamin-d"],
    ["Créatinine", "mg/dL", "creatinine"],
    ["Kreatynina", "µmol/L", "creatinine"],
  ])("%s (%s) is %s", (name, unit, key) => {
    // LDL and HDL are aliases of cholesterol: the registry reports one key.
    const expected = analyteConversionFor(key)!.key;
    expect(match(name, unit)).toBe(expected);
  });

  it("recognises a seed typed without the app's gloss", () => {
    expect(match("Vitamin D", "ng/mL")).toBe("vitamin-d");
  });
});

describe("typed names", () => {
  it.each([
    ["Glucose", "mg/dL", "fasting-glucose"],
    ["Blutzucker", "mg/dL", "fasting-glucose"],
    ["blood sugar", "mmol/L", "fasting-glucose"],
    ["Cholesterin", "mg/dL", "total-cholesterol"],
    ["Serum Creatinine", "mg/dL", "creatinine"],
    ["Urea", "mmol/L", "urea"],
    ["Harnstoff", "mg/dL", "urea"],
    ["BUN", "mg/dL", "blood-urea-nitrogen"],
    ["Blood Urea Nitrogen", "mg/dL", "blood-urea-nitrogen"],
    ["Harnsäure", "µmol/L", "uric-acid"],
    ["Uric acid", "mg/dL", "uric-acid"],
    ["Kalzium", "mmol/L", "calcium-total"],
    ["Calcium", "mg/dL", "calcium-total"],
    ["Gesamtbilirubin", "µmol/L", "bilirubin-total"],
    ["Bilirubin total", "mg/dL", "bilirubin-total"],
  ])("%s (%s) is %s", (name, unit, key) => {
    expect(match(name, unit)).toBe(key);
  });

  it("folds case, accents, hyphens and spacing the same on both sides", () => {
    expect(match("  HARNSÄURE ", "mg/dL")).toBe("uric-acid");
    expect(match("ldl-c", "mg/dL")).toBe(analyteConversionFor("ldl")!.key);
    expect(match("blood  urea-nitrogen", "mg/dL")).toBe("blood-urea-nitrogen");
  });
});

describe("a name that is not the whole analyte name stays unlinked", () => {
  it.each([
    ["Calcium (ionisiert)", "mmol/L"],
    ["Ionised calcium", "mmol/L"],
    ["Calcium ionisiert", "mmol/L"],
    ["Urea nitrogen ratio", "mg/dL"],
    ["Glucose (urine)", "mg/dL"],
    ["Glucose tolerance", "mg/dL"],
    ["Non-HDL cholesterol", "mg/dL"],
    ["Cholesterol ratio", "mg/dL"],
    ["Direct bilirubin", "mg/dL"],
    ["Free thyroxine", "pmol/L"],
    ["", "mg/dL"],
  ])("%s", (name, unit) => {
    expect(match(name, unit)).toBeNull();
  });

  it("keeps urea and blood urea nitrogen apart", () => {
    expect(match("Urea", "mmol/L")).toBe("urea");
    expect(match("Urea nitrogen", "mg/dL")).toBe("blood-urea-nitrogen");
  });
});

describe("the marker's unit must be one the analyte reaches", () => {
  it("links a unit the entry lists and one that differs by a power of ten", () => {
    expect(match("Glucose", "mg/dL")).toBe("fasting-glucose");
    expect(match("Glucose", "mmol/L")).toBe("fasting-glucose");
    expect(match("Glucose", "g/L")).toBe("fasting-glucose");
    expect(match("Creatinine", "mmol/L")).toBe("creatinine");
  });

  it("leaves a unit the registry cannot reach unlinked", () => {
    expect(match("Glucose", "mEq/L")).toBeNull();
    expect(match("Glucose", "%")).toBeNull();
    expect(match("HbA1c", "mg/dL")).toBeNull();
    expect(match("Calcium", "furlongs")).toBeNull();
  });

  it("reads a spelling of the unit through the normaliser", () => {
    expect(match("Glucose", "MG/DL")).toBe("fasting-glucose");
    expect(match("Creatinine", "umol/l")).toBe("creatinine");
  });
});

describe("the alias list, as a guard", () => {
  it("names only analytes the registry knows", () => {
    for (const { key } of ANALYTE_ALIASES) {
      expect(analyteConversionFor(key), key).not.toBeNull();
    }
  });

  it("writes every name already folded, so what is read is what is matched", () => {
    for (const { key, names } of ANALYTE_ALIASES) {
      for (const name of names) {
        expect(foldForMatch(name), `${key}: ${name}`).toBe(name);
      }
    }
  });

  it("has no name that two analytes claim", () => {
    expect(analyteNameIndex().ambiguous).toEqual([]);
  });

  it("gives every registry entry at least one name to be found by", () => {
    const { index } = analyteNameIndex();
    const reached = new Set(index.values());
    for (const entry of allAnalyteConversions()) {
      expect(reached.has(entry.key), entry.key).toBe(true);
    }
  });

  it("covers every catalog seed the registry knows, in all seven languages", () => {
    const { index } = analyteNameIndex();
    const seeds = BIOMARKER_CATALOG.filter((seed) =>
      analyteConversionFor(seed.slug),
    );
    expect(seeds.length).toBeGreaterThanOrEqual(6);
    for (const seed of seeds) {
      const key = analyteConversionFor(seed.slug)!.key;
      const names = [...index.entries()].filter(([, k]) => k === key);
      expect(names.length, seed.slug).toBeGreaterThan(0);
    }
  });

  it("links each seed at its own catalog unit", () => {
    for (const seed of BIOMARKER_CATALOG) {
      const entry = analyteConversionFor(seed.slug);
      if (!entry) continue;
      expect(analyteAcceptsUnit(entry.key, seed.unit), seed.slug).toBe(true);
    }
  });
});
