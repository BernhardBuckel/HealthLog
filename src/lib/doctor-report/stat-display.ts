/**
 * How a measurement statistic reads in the clinician-facing artefacts: the
 * PDF report and the shared clinician view.
 *
 * Both describe the same record to the same reader, so they take the unit and
 * the displayed number from here and nowhere else. Before this module the PDF
 * carried its own unit map and the clinician view printed bare numbers, so a
 * doctor opening a share link read "latest 5.8 (avg 6.1, range 4.9–7.4)" with
 * no unit at all, and for an account on mmol/L the glucose rows of the PDF's
 * measurement table still printed raw mg/dL beside a mmol/L glucose panel.
 *
 * The policy, which `display-transform.ts` states for the metric/imperial
 * preference: a document handed to a clinician stays SI for mass, length and
 * temperature regardless of the owner's imperial preference. Glucose is the
 * exception, because mmol/L versus mg/dL is not an imperial question — it is
 * the clinical convention of the country the record lives in — so glucose
 * follows the owner's `glucoseUnit` here as it does everywhere a person reads
 * it.
 */
import { convertGlucose, type GlucoseUnit } from "@/lib/glucose";
import { getUnitForType } from "@/lib/validations/measurement";

/**
 * Report-specific unit symbols, where the report's own reading differs from
 * the validation layer's canonical unit. `null` marks a unit that has to be
 * translated (steps). Everything absent falls back to `getUnitForType`.
 */
export const DOCTOR_REPORT_TYPE_UNIT_KEYS: Record<string, string | null> = {
  WEIGHT: "kg",
  BLOOD_PRESSURE_SYS: "mmHg",
  BLOOD_PRESSURE_DIA: "mmHg",
  PULSE: "bpm",
  BODY_FAT: "%",
  SLEEP_DURATION: "h",
  ACTIVITY_STEPS: null, // translated unit
  TOTAL_BODY_WATER: "kg",
  BONE_MASS: "kg",
  OXYGEN_SATURATION: "%",
};

/**
 * The unit symbol a report statistic of `type` is printed with.
 *
 * `translate` resolves the one translated unit (steps). A type with no
 * recorded unit prints none — an absent unit is absent, not a guessed symbol.
 */
export function reportStatUnit(
  type: string,
  glucoseUnit: GlucoseUnit,
  translate: (key: string) => string,
): string {
  if (type === "BLOOD_GLUCOSE") return glucoseUnit;
  const staticUnit = DOCTOR_REPORT_TYPE_UNIT_KEYS[type];
  if (staticUnit === null && type === "ACTIVITY_STEPS") {
    return translate("doctorReport.unitSteps");
  }
  if (staticUnit !== undefined && staticUnit !== null) return staticUnit;
  const canonical = getUnitForType(type);
  return canonical === "unknown" ? "" : canonical;
}

/**
 * The number a report statistic of `type` is printed as, in the unit
 * {@link reportStatUnit} names.
 *
 * SLEEP_DURATION statistics are per-night asleep totals in minutes (the data
 * layer reconstructs them for exactly this row) while the unit is hours, so
 * they are divided — the same hours value the FHIR sleep Observation emits.
 * Glucose is stored in mg/dL and converted to the owner's unit.
 */
export function reportStatValue(
  type: string,
  value: number,
  glucoseUnit: GlucoseUnit,
): number {
  if (type === "SLEEP_DURATION") return value / 60;
  if (type === "BLOOD_GLUCOSE") return convertGlucose(value, glucoseUnit);
  return value;
}
