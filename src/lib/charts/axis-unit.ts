/**
 * The unit suffix a chart axis appends to each tick value ("62 bpm").
 *
 * Joined with a no-break space, never a plain one. Recharts word-wraps a
 * tick label that is wider than the axis, and it measures the label in the
 * page's body font rather than the tick's own 11 px, so "62 bpm" and
 * "106 mg/dL" measured wider than their axis and broke onto two lines on
 * every screen. The second line dropped onto the first x tick. A label with
 * no breaking space is one word and stays on one line.
 */
export function axisUnitSuffix(
  unit: string | null | undefined,
): string | undefined {
  return unit ? ` ${unit}` : undefined;
}
