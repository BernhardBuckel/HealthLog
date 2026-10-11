/**
 * v1.18.1 — static seed catalog of common blood/lab biomarkers.
 *
 * This is NOT a DB table. It is a curated list offered at the add step
 * ("pick a common marker, or create your own") so a self-hoster does not
 * type a marker definition from scratch. Selecting a seed pre-fills the
 * inline definition form (canonical name, unit, suggested reference bounds)
 * which the user then accepts or overrides before it becomes a real,
 * user-scoped `Biomarker` row.
 *
 * The suggested ranges are EDITABLE DEFAULTS, never gospel — reference
 * windows vary by lab, sex, and age. The display name is localised via the
 * `labs.catalog.<slug>` i18n key; the EN slug is the stable identity (mirrors
 * the Insights slug/alias pattern). Units stay literal (mg/dL etc. are not
 * translated).
 *
 * Source ranges: common adult fasting reference windows (US conventional
 * units where the metric/SI split matters). Presented as starting points.
 */

export interface BiomarkerSeed {
  /** Stable EN identity; the `labs.catalog.<slug>` i18n key resolves the name. */
  slug: string;
  /** Panel grouping key; the `labs.catalog.panel.<panel>` i18n key labels it. */
  panel: string;
  /** Canonical unit for every reading against this marker. */
  unit: string;
  /** Suggested lower bound (editable default), or null when open-ended. */
  lowerBound: number | null;
  /** Suggested upper bound (editable default), or null when open-ended. */
  upperBound: number | null;
}

export const BIOMARKER_CATALOG: readonly BiomarkerSeed[] = [
  // Lipids
  {
    slug: "total-cholesterol",
    panel: "lipids",
    unit: "mg/dL",
    lowerBound: null,
    upperBound: 200,
  },
  {
    slug: "ldl",
    panel: "lipids",
    unit: "mg/dL",
    lowerBound: null,
    upperBound: 116,
  },
  {
    slug: "hdl",
    panel: "lipids",
    unit: "mg/dL",
    lowerBound: 40,
    upperBound: null,
  },
  {
    slug: "triglycerides",
    panel: "lipids",
    unit: "mg/dL",
    lowerBound: null,
    upperBound: 150,
  },
  // v1.25 — longevity panel: atherogenic-particle burden + genetic + RBC EPA/DHA.
  // ApoB is the primary atherogenic-burden number (ESC/EAS 2019); the upper
  // bound is the population-desirable line, lower goals are care-context-specific.
  {
    slug: "apob",
    panel: "lipids",
    unit: "mg/dL",
    lowerBound: null,
    upperBound: 90,
  },
  // Lp(a) is largely genetically fixed (measure once, flag elevated); molar
  // (nmol/L) reporting preferred — never interconvert mass↔molar by a factor.
  {
    slug: "lp-a",
    panel: "lipids",
    unit: "nmol/L",
    lowerBound: null,
    upperBound: 125,
  },
  // Omega-3 index (RBC EPA+DHA %): cardioprotective/optimal 8–12%.
  {
    slug: "omega-3-index",
    panel: "lipids",
    unit: "%",
    lowerBound: 8,
    upperBound: null,
  },
  // Glucose metabolism
  {
    slug: "fasting-glucose",
    panel: "glucose",
    unit: "mg/dL",
    lowerBound: 70,
    upperBound: 100,
  },
  {
    slug: "hba1c",
    panel: "glucose",
    unit: "%",
    lowerBound: null,
    upperBound: 5.7,
  },
  // v1.25 — longevity panel: fasting insulin (metabolically-optimal often
  // cited < 8 µIU/mL; typical reference ~2.5–13). HOMA-IR is derived from
  // fasting glucose × insulin (see `homa-ir.ts`), not a stored catalog marker.
  {
    slug: "fasting-insulin",
    panel: "glucose",
    unit: "µIU/mL",
    lowerBound: 2.5,
    upperBound: 13,
  },
  // Thyroid
  {
    slug: "tsh",
    panel: "thyroid",
    unit: "mIU/L",
    lowerBound: 0.4,
    upperBound: 4,
  },
  {
    slug: "ft3",
    panel: "thyroid",
    unit: "pg/mL",
    lowerBound: 2.3,
    upperBound: 4.2,
  },
  {
    slug: "ft4",
    panel: "thyroid",
    unit: "ng/dL",
    lowerBound: 0.8,
    upperBound: 1.8,
  },
  // Iron
  {
    slug: "ferritin",
    panel: "iron",
    unit: "ng/mL",
    lowerBound: 30,
    upperBound: 400,
  },
  {
    slug: "transferrin-saturation",
    panel: "iron",
    unit: "%",
    lowerBound: 20,
    upperBound: 50,
  },
  // Vitamins
  {
    slug: "vitamin-d",
    panel: "vitamins",
    unit: "ng/mL",
    lowerBound: 30,
    upperBound: 100,
  },
  {
    slug: "vitamin-b12",
    panel: "vitamins",
    unit: "pg/mL",
    lowerBound: 200,
    upperBound: 900,
  },
  {
    slug: "folate",
    panel: "vitamins",
    unit: "ng/mL",
    lowerBound: 3,
    upperBound: 20,
  },
  // Inflammation
  {
    slug: "hs-crp",
    panel: "inflammation",
    unit: "mg/L",
    lowerBound: null,
    upperBound: 3,
  },
  // Renal
  {
    slug: "creatinine",
    panel: "renal",
    unit: "mg/dL",
    lowerBound: 0.6,
    upperBound: 1.3,
  },
  {
    slug: "egfr",
    panel: "renal",
    unit: "mL/min/1.73m²",
    lowerBound: 90,
    upperBound: null,
  },
  // Liver
  {
    slug: "alt",
    panel: "liver",
    unit: "U/L",
    lowerBound: null,
    upperBound: 40,
  },
  {
    slug: "ast",
    panel: "liver",
    unit: "U/L",
    lowerBound: null,
    upperBound: 40,
  },
  {
    slug: "ggt",
    panel: "liver",
    unit: "U/L",
    lowerBound: null,
    upperBound: 55,
  },
  // Electrolytes
  {
    slug: "sodium",
    panel: "electrolytes",
    unit: "mmol/L",
    lowerBound: 135,
    upperBound: 145,
  },
  {
    slug: "potassium",
    panel: "electrolytes",
    unit: "mmol/L",
    lowerBound: 3.5,
    upperBound: 5.1,
  },
  // Blood count
  {
    slug: "hemoglobin",
    panel: "bloodCount",
    unit: "g/dL",
    lowerBound: 12,
    upperBound: 17.5,
  },
  {
    slug: "hematocrit",
    panel: "bloodCount",
    unit: "%",
    lowerBound: 36,
    upperBound: 50,
  },
  {
    slug: "wbc",
    panel: "bloodCount",
    unit: "10³/µL",
    lowerBound: 4,
    upperBound: 11,
  },
  {
    slug: "platelets",
    panel: "bloodCount",
    unit: "10³/µL",
    lowerBound: 150,
    upperBound: 400,
  },
] as const;

/** The set of panel keys present in the catalog, in display order. */
export const BIOMARKER_PANELS = [
  "lipids",
  "glucose",
  "thyroid",
  "iron",
  "vitamins",
  "inflammation",
  "renal",
  "liver",
  "electrolytes",
  "bloodCount",
] as const;

/**
 * Names a marker may carry for an analyte the unit-conversion registry knows
 * (`src/lib/labs/unit-conversion/registry.ts`), keyed by the registry's key.
 *
 * A `Biomarker` row keeps only its name, not the seed it came from, so this is
 * how a marker is told which analyte it is: its folded name equals one of these,
 * or one of the localised names of a seed the registry knows (`ldl`, `hba1c`,
 * `fasting-glucose`, ...). The match is the WHOLE name, never a part of it, so
 * "Calcium (ionisiert)" is not "Calcium" and "Urea nitrogen" is not "Urea". A
 * name that two analytes claim is left out of the match, and a marker named in
 * some other way stays unlinked, which is the safe default.
 *
 * Names are compared folded (lower case, no accents, hyphens and slashes as
 * spaces), so "Harnsäure" is written "harnsaure" here and "Nüchtern-Glukose"
 * needs no entry of its own. The registry-only keys (urea, blood urea
 * nitrogen, uric acid, total calcium, total bilirubin) have no seed, so their
 * names live only here.
 */
export interface AnalyteAliases {
  /** The registry key of the analyte. */
  key: string;
  names: readonly string[];
}

export const ANALYTE_ALIASES: readonly AnalyteAliases[] = [
  {
    key: "fasting-glucose",
    names: [
      "glucose",
      "blood glucose",
      "blood sugar",
      "plasma glucose",
      "fasting blood glucose",
      "fasting blood sugar",
      "fasting plasma glucose",
      "glukose",
      "blutglukose",
      "blutzucker",
      "nuchternblutzucker",
      "glucosa",
      "glicemia",
      "glycemie",
      "glucosio",
      "glukoza",
      "glikemia",
    ],
  },
  {
    key: "hba1c",
    names: [
      "hb a1c",
      "a1c",
      "hemoglobin a1c",
      "glycated hemoglobin",
      "glycosylated hemoglobin",
      "glykohamoglobin",
      "hamoglobin a1c",
    ],
  },
  {
    key: "total-cholesterol",
    names: [
      "cholesterol",
      "cholesterin",
      "cholesterol total",
      "cholesterin gesamt",
      "cholesterol gesamt",
      "colesterol",
      "colesterolo",
      "cholesterol calkowity",
    ],
  },
  { key: "ldl", names: ["ldl", "ldl c", "ldl chol", "ldl cholesterin"] },
  { key: "hdl", names: ["hdl", "hdl c", "hdl chol", "hdl cholesterin"] },
  {
    key: "creatinine",
    names: [
      "serum creatinine",
      "serumkreatinin",
      "kreatinin im serum",
      "creatinine serique",
    ],
  },
  {
    key: "vitamin-d",
    names: [
      "25 oh vitamin d",
      "25 hydroxy vitamin d",
      "25 hydroxyvitamin d",
      "25 oh d",
      "calcidiol",
      "vitamin d 25 oh",
    ],
  },
  { key: "urea", names: ["urea", "harnstoff", "uree", "urea serum"] },
  {
    key: "blood-urea-nitrogen",
    names: [
      "bun",
      "blood urea nitrogen",
      "urea nitrogen",
      "harnstoff stickstoff",
      "stickstoff harnstoff",
      "azote ureique",
    ],
  },
  {
    key: "uric-acid",
    names: [
      "uric acid",
      "urate",
      "harnsaure",
      "acide urique",
      "acido urico",
      "kwas moczowy",
    ],
  },
  {
    key: "calcium-total",
    names: [
      "calcium",
      "total calcium",
      "calcium total",
      "calcium gesamt",
      "gesamtcalcium",
      "kalzium",
      "kalzium gesamt",
      "gesamtkalzium",
      "calcio",
      "wapn",
    ],
  },
  {
    key: "bilirubin-total",
    names: [
      "bilirubin",
      "total bilirubin",
      "bilirubin total",
      "bilirubin gesamt",
      "gesamtbilirubin",
      "bilirrubina",
      "bilirubine",
      "bilirubina",
    ],
  },
];
