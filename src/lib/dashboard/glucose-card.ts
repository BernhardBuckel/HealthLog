import { convertGlucose, type GlucoseUnit } from "@/lib/glucose";

/** The fields of a dashboard summary card the glucose unit touches. */
interface GlucoseConvertibleCard {
  kind: string;
  latestValue: number | null;
  secondaryValue: number | null;
  sparkline: number[];
  unit: string | null;
}

/**
 * Put the glucose card in the record owner's display unit.
 *
 * Glucose is stored in mg/dL. The summary card used to send that number with
 * `unit: null` and a `unitKey` that reads "mg/dL", so a reader who chose
 * mmol/L was shown 101 "mg/dL" on a client that honours the card. The card now
 * carries its value, its secondary value and its sparkline in the chosen unit
 * and names that unit in `unit`, the field that wins over `unitKey` (as the
 * sleep card's `"h"` already does). Every other card passes through untouched.
 *
 * Applied after the summary cache is read, so changing the unit takes effect
 * on the next request rather than after the cache window.
 */
export function glucoseCardInDisplayUnit<T extends GlucoseConvertibleCard>(
  card: T,
  unit: GlucoseUnit,
): T {
  if (card.kind !== "glucose") return card;
  const show = (value: number | null) =>
    value === null ? null : convertGlucose(value, unit);
  return {
    ...card,
    latestValue: show(card.latestValue),
    secondaryValue: show(card.secondaryValue),
    sparkline: card.sparkline.map((value) => convertGlucose(value, unit)),
    unit,
  };
}
