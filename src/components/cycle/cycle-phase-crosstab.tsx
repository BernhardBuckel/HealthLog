"use client";

import { useTranslations } from "@/lib/i18n/context";
import { useUnitDisplay, type UnitDisplay } from "@/hooks/use-unit-display";
import {
  applyDisplayTransform,
  applyDisplayTransformDelta,
  getReadingTransform,
} from "@/lib/measurements/display-transform";
import { cn } from "@/lib/utils";

/**
 * v1.15 — CYCLE_PHASE × vital crosstab card.
 *
 * Mirrors the mood-factor × vital crosstab (`mood-factor-metric-crosstab.tsx`):
 * for each outcome metric, the vital's mean on LUTEAL-phase days vs
 * FOLLICULAR-phase days, the signed delta, n per group, q, and a confidence
 * chip. The math is pre-computed in `src/lib/cycle/phase-crosstab.ts`
 * (`computePhaseMetricCrosstab`) — the same Welch t-test + day floors +
 * Benjamini-Hochberg FDR the rest of the relations surface uses; only
 * FDR-surviving rows reach here. Observational only — the page-level
 * "associations, not causes" footer carries the caveat once. This surface is
 * gender-gated by its `/api/cycle/insights` route; phase never renders on the
 * general correlations surface.
 */

export type CyclePhaseCrosstabDisplay =
  "hours" | "steps" | "bpm" | "ms" | "kg" | "celsius" | "glucose" | "mood";

export type CyclePhaseCrosstabConfidence = "low" | "medium" | "high";

export interface CyclePhaseCrosstabRow {
  metricKey: string;
  display: CyclePhaseCrosstabDisplay;
  lutealDays: number;
  follicularDays: number;
  lutealAvg: number;
  follicularAvg: number;
  delta: number;
  pValue: number;
  qValue: number;
  confidence: CyclePhaseCrosstabConfidence;
}

const METRIC_LABEL_KEY: Record<string, string> = {
  restingHeartRate: "cycle.insights.crosstab.metricRestingHeartRate",
  heartRateVariability: "cycle.insights.crosstab.metricHrv",
  sleepDuration: "cycle.insights.crosstab.metricSleepDuration",
  steps: "cycle.insights.crosstab.metricSteps",
  weight: "cycle.insights.crosstab.metricWeight",
  basalBodyTemp: "cycle.insights.crosstab.metricBasalBodyTemp",
  wristTemperature: "cycle.insights.crosstab.metricWristTemperature",
  skinTemperature: "cycle.insights.crosstab.metricSkinTemperature",
  bloodGlucose: "cycle.insights.crosstab.metricBloodGlucose",
  mood: "cycle.insights.crosstab.metricMood",
};

/**
 * Bundle labels for the displays no preference changes. Weight, the
 * temperatures and glucose take their symbol from the reader's transform
 * (`DISPLAY_TO_TYPE` below) and have no bundle label to fall back on.
 */
const UNIT_KEY: Partial<Record<CyclePhaseCrosstabDisplay, string>> = {
  hours: "cycle.insights.crosstab.unitHours",
  steps: "cycle.insights.crosstab.unitSteps",
  bpm: "cycle.insights.crosstab.unitBpm",
  ms: "cycle.insights.crosstab.unitMs",
  mood: "cycle.insights.crosstab.unitMood",
};

const CONFIDENCE_KEY: Record<CyclePhaseCrosstabConfidence, string> = {
  low: "cycle.insights.crosstab.confidenceLow",
  medium: "cycle.insights.crosstab.confidenceMedium",
  high: "cycle.insights.crosstab.confidenceHigh",
};

const CONFIDENCE_CLASS: Record<CyclePhaseCrosstabConfidence, string> = {
  low: "bg-secondary text-muted-foreground",
  medium: "bg-info/15 text-info",
  high: "bg-success/15 text-success",
};

/** Whole numbers for steps; one decimal otherwise. */
function fmt(value: number, display: CyclePhaseCrosstabDisplay): string {
  return display === "steps" ? Math.round(value).toString() : value.toFixed(1);
}

/**
 * v1.32.26 — the two displays whose values follow the metric/imperial
 * preference, mapped to the measurement type that carries the transform. Weight
 * is offset-free (kg→lb); temperature is affine (°C→°F), so an ABSOLUTE phase
 * average takes `toDisplay` while a phase DELTA takes `toDisplayDelta` (the
 * offset must never leak into a difference).
 */
const DISPLAY_TO_TYPE: Partial<Record<CyclePhaseCrosstabDisplay, string>> = {
  kg: "WEIGHT",
  celsius: "BODY_TEMPERATURE",
  glucose: "BLOOD_GLUCOSE",
};

/**
 * Unit symbol and conversions for one row, from the reader's preferences.
 * Glucose follows the glucose unit (it used to print the mg/dL label from
 * the bundle beside raw mg/dL values for every reader); weight and
 * temperature follow metric/imperial; every other display keeps its bundle
 * label and its raw value.
 */
function rowUnits(
  display: CyclePhaseCrosstabDisplay,
  unitDisplay: UnitDisplay,
  t: (key: string) => string,
): {
  unit: string;
  abs: (v: number) => number;
  delta: (v: number) => number;
} {
  const type = DISPLAY_TO_TYPE[display];
  if (!type) {
    // Defensive: an unmapped display must never pass undefined to `t`
    // (whose resolver does `key.split(".")`). Empty unit on a miss.
    const unitKey = UNIT_KEY[display];
    return {
      unit: unitKey ? t(unitKey) : "",
      abs: (v) => v,
      delta: (v) => v,
    };
  }
  const transform = getReadingTransform(type, {
    system: unitDisplay.preference,
    glucoseUnit: unitDisplay.glucoseUnit,
  });
  return {
    unit: transform.displayUnit,
    abs: (v) => applyDisplayTransform(v, transform),
    delta: (v) => applyDisplayTransformDelta(v, transform),
  };
}

const HEADLINE_KEY: Record<string, string> = {
  restingHeartRate: "cycle.insights.headline.restingHeartRate",
  heartRateVariability: "cycle.insights.headline.heartRateVariability",
};

/**
 * The single headline finding rendered prominently above the grid. Resting
 * heart rate / HRV get bespoke phrasing; every other metric uses the generic
 * line. Returns null when nothing cleared the FDR gate — an honest empty state.
 */
export function CyclePhaseHeadline({
  headline,
}: {
  headline: CyclePhaseCrosstabRow | null;
}) {
  const { t } = useTranslations();
  const unitDisplay = useUnitDisplay();
  if (!headline) {
    return (
      <p
        data-slot="cycle-phase-headline-empty"
        className="text-muted-foreground text-sm"
      >
        {t("cycle.insights.headline.empty")}
      </p>
    );
  }
  const metricLabel = t(
    METRIC_LABEL_KEY[headline.metricKey] ?? headline.metricKey,
  );
  const { unit, delta: deltaConv } = rowUnits(headline.display, unitDisplay, t);
  const up = headline.delta >= 0;
  const dir = t(
    up
      ? "cycle.insights.headline.dirHigher"
      : "cycle.insights.headline.dirLower",
  );
  const params = {
    metric: metricLabel,
    // A phase delta → factor-only conversion (no affine offset).
    delta: fmt(Math.abs(deltaConv(headline.delta)), headline.display),
    unit,
    dir,
  };
  const key =
    HEADLINE_KEY[headline.metricKey] ?? "cycle.insights.headline.generic";
  return (
    <p
      data-slot="cycle-phase-headline"
      data-metric={headline.metricKey}
      className="text-foreground text-sm font-medium"
    >
      {t(key, params)}
    </p>
  );
}

export function CyclePhaseCrosstab({
  rows,
}: {
  rows: CyclePhaseCrosstabRow[];
}) {
  const { t } = useTranslations();
  const unitDisplay = useUnitDisplay();
  if (rows.length === 0) return null;

  return (
    <div data-slot="cycle-phase-crosstab">
      <p className="text-muted-foreground mb-2 text-sm">
        {t("cycle.insights.crosstab.description")}
      </p>
      <ul className="divide-border divide-y">
        {rows.map((row) => {
          const metricLabel = t(
            METRIC_LABEL_KEY[row.metricKey] ?? row.metricKey,
          );
          const {
            unit,
            abs: absConv,
            delta: deltaConv,
          } = rowUnits(row.display, unitDisplay, t);
          // `delta` = lutealAvg − follicularAvg: positive = the vital runs
          // higher in the luteal phase. The number stays NEUTRAL — higher is
          // good for steps but bad for resting HR, and this board is
          // observational, so colouring it would imply a verdict the data
          // doesn't support. The sign prefix + `data-direction` carry it.
          const up = row.delta >= 0;
          const deltaText = `${up ? "+" : ""}${fmt(deltaConv(row.delta), row.display)} ${unit}`;
          return (
            <li
              key={row.metricKey}
              className="flex flex-col gap-1.5 py-2"
              data-slot="cycle-phase-crosstab-row"
              data-metric={row.metricKey}
              data-direction={up ? "up" : "down"}
              data-confidence={row.confidence}
            >
              <div className="flex items-center gap-2 text-sm">
                <span
                  className="text-foreground min-w-0 flex-1 truncate"
                  title={metricLabel}
                >
                  {t("cycle.insights.crosstab.pairLabel", {
                    metric: metricLabel,
                  })}
                </span>
                <span className="text-foreground shrink-0 text-sm font-semibold tabular-nums">
                  {deltaText}
                </span>
                <span
                  className={cn(
                    "shrink-0 rounded-full px-2 py-0.5 text-xs font-medium",
                    CONFIDENCE_CLASS[row.confidence],
                  )}
                >
                  {t(CONFIDENCE_KEY[row.confidence])}
                </span>
              </div>
              <p className="text-muted-foreground text-xs">
                {t("cycle.insights.crosstab.detail", {
                  metric: metricLabel,
                  lutealAvg: fmt(absConv(row.lutealAvg), row.display),
                  follicularAvg: fmt(absConv(row.follicularAvg), row.display),
                  unit,
                  lutealDays: row.lutealDays,
                  follicularDays: row.follicularDays,
                })}
              </p>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
