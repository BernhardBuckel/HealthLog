/**
 * v1.27.13 (Welle J) — the per-metric INTERPRETATION CONTEXT block.
 *
 * Renders the guideline band table + the server-computed band position for one
 * value into the assessment user prompt, so the model can say what the value
 * MEANS on the clinical scale (not just recite counts and a trend adjective).
 * The band membership + edge proximity are computed in
 * `insight-interpretation.ts` — the model states them, it does not recompute
 * them. Facts here; the "how to phrase it" rule lives in the shared
 * `interpretationDepth` contract on the system prompt.
 *
 * Returns undefined when the metric has no guideline band (fail-soft: the
 * assessment then stays personal-relative, exactly as before this landed).
 */
import type { Locale } from "@/lib/i18n/config";
import { instructionLocale } from "./output-language";
import {
  classifyBandPosition,
  resolveInterpretation,
  type BandValence,
  type DirectionOfGood,
  type InterpretationBand,
} from "@/lib/ai/insight-interpretation";

function valencePhrase(valence: BandValence, locale: "en" | "de"): string {
  if (locale === "en") {
    switch (valence) {
      case "favourable":
        return "a healthy / low-risk range";
      case "neutral":
        return "a broadly typical range";
      case "caution":
        return "a range worth keeping an eye on";
      case "unfavourable":
        return "an elevated range guidelines flag";
    }
  }
  switch (valence) {
    case "favourable":
      return "ein gesunder / risikoarmer Bereich";
    case "neutral":
      return "ein weitgehend typischer Bereich";
    case "caution":
      return "ein Bereich, den man im Blick behalten sollte";
    case "unfavourable":
      return "ein erhöhter Bereich, den Leitlinien markieren";
  }
}

function directionPhrase(dir: DirectionOfGood, locale: "en" | "de"): string {
  if (locale === "en") {
    switch (dir) {
      case "lower":
        return "lower values are more favourable";
      case "higher":
        return "higher values are more favourable";
      case "target":
        return "the middle band is the target — both extremes are less favourable";
    }
  }
  switch (dir) {
    case "lower":
      return "niedrigere Werte sind günstiger";
    case "higher":
      return "höhere Werte sind günstiger";
    case "target":
      return "das mittlere Band ist das Ziel — beide Extreme sind ungünstiger";
  }
}

/** One band rendered as a plain range row against its edges. */
function bandRow(
  band: InterpretationBand,
  lower: number | null,
  unit: string,
  locale: "en" | "de",
): string {
  const u = unit;
  if (lower === null && band.upTo !== null) {
    return locale === "en"
      ? `below ${band.upTo} ${u}: ${band.label}`
      : `unter ${band.upTo} ${u}: ${band.label}`;
  }
  if (lower !== null && band.upTo === null) {
    return locale === "en"
      ? `${lower} ${u} and above: ${band.label}`
      : `ab ${lower} ${u}: ${band.label}`;
  }
  if (lower !== null && band.upTo !== null) {
    return `${lower}–${band.upTo} ${u}: ${band.label}`;
  }
  return band.label;
}

function proximityPhrase(
  proximity: "central" | "near-lower-edge" | "near-upper-edge",
  nearestEdge: number | null,
  unit: string,
  locale: "en" | "de",
): string {
  const at =
    nearestEdge !== null
      ? locale === "en"
        ? ` (nearest boundary at ${nearestEdge} ${unit})`
        : ` (nächste Grenze bei ${nearestEdge} ${unit})`
      : "";
  if (locale === "en") {
    switch (proximity) {
      case "central":
        return `sits comfortably inside this band${at}`;
      case "near-lower-edge":
        return `sits near the LOWER boundary of this band${at}`;
      case "near-upper-edge":
        return `sits near the UPPER boundary of this band${at}`;
    }
  }
  switch (proximity) {
    case "central":
      return `liegt komfortabel in diesem Band${at}`;
    case "near-lower-edge":
      return `liegt nahe der UNTEREN Grenze dieses Bands${at}`;
    case "near-upper-edge":
      return `liegt nahe der OBEREN Grenze dieses Bands${at}`;
  }
}

/**
 * Build the interpretation block for a metric + current value, or undefined
 * when the metric carries no guideline band (or needs a sex the profile lacks).
 */
export function buildInterpretationBlock(args: {
  metricKey: string;
  /** The value in the guideline's own (canonical) unit — what is classified. */
  value: number;
  sex: "MALE" | "FEMALE" | null | undefined;
  locale: Locale;
  /**
   * Print the block in the reader's unit. Classification always runs on the
   * canonical value against the canonical bands; only the printed numbers and
   * the unit symbol are converted, so a prompt whose snapshot reads °F does
   * not carry a band table in °C beside it.
   */
  display?: { unit: string; convert: (canonical: number) => number };
}): string | undefined {
  const resolved = resolveInterpretation(args.metricKey, args.sex ?? null);
  if (!resolved) return undefined;

  const loc: "en" | "de" = instructionLocale(args.locale);
  const pos = classifyBandPosition(args.value, resolved.bands);

  const show = (n: number) => (args.display ? args.display.convert(n) : n);
  const unit = args.display ? args.display.unit : resolved.unit;
  const shownBands = resolved.bands.map((band) => ({
    ...band,
    upTo: band.upTo === null ? null : show(band.upTo),
  }));

  const rows = shownBands
    .map((band, i) =>
      bandRow(band, i > 0 ? shownBands[i - 1].upTo : null, unit, loc),
    )
    .map((r) => `  - ${r}`)
    .join("\n");

  const proximity = proximityPhrase(
    pos.proximity,
    pos.nearestEdge === null ? null : show(pos.nearestEdge),
    unit,
    loc,
  );
  const valence = valencePhrase(pos.band.valence, loc);
  const direction = directionPhrase(resolved.directionOfGood, loc);
  const caveat = resolved.caveat ? `\n- ${resolved.caveat}` : "";

  if (loc === "en") {
    return `INTERPRETATION CONTEXT (guideline bands — computed server-side; state, do NOT recompute):
- Current value ${show(args.value)} ${unit} is in the "${pos.band.label}" band, and ${proximity}.
- Guideline bands (${resolved.source}; ${direction}):
${rows}
- Values in the "${pos.band.label}" band are considered ${valence} per these guidelines.${caveat}
- Name where the value sits and what that band means in plain words. Judge any trend BY this position: a shift deep inside a favourable band is a footnote; the same shift approaching or crossing a boundary is the headline. Frame consequence without diagnosis ("values in this range are considered …", never "you have / are at risk of …").`;
  }
  return `EINORDNUNGS-KONTEXT (Leitlinien-Bänder — serverseitig berechnet; nennen, NICHT neu rechnen):
- Der aktuelle Wert ${show(args.value)} ${unit} liegt im Band "${pos.band.label}" und ${proximity}.
- Leitlinien-Bänder (${resolved.source}; ${direction}):
${rows}
- Werte im Band "${pos.band.label}" gelten laut diesen Leitlinien als ${valence}.${caveat}
- Benenne, wo der Wert liegt und was dieses Band praktisch bedeutet. Beurteile jeden Trend GEMÄSS dieser Position: eine Verschiebung tief in einem günstigen Band ist eine Randnotiz; dieselbe Verschiebung nahe an oder über einer Grenze ist die Schlagzeile. Rahme die Konsequenz ohne Diagnose ("Werte in diesem Bereich gelten als …", nie "du hast / bist gefährdet für …").`;
}
