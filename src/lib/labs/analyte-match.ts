/**
 * Which analyte a marker is, for the unit conversion.
 *
 * `matchAnalyteKey` answers from two places: the localised names of the
 * catalog seeds the registry knows (so a marker created from the "pick a common
 * marker" list is recognised in every language the app ships) and the alias
 * list in the catalog. The name must equal one of them as a WHOLE, folded the
 * same way on both sides; a part of a name never matches.
 *
 * Two safeguards keep a link from being wrong:
 *   - a folded name that two analytes claim matches neither;
 *   - the marker's own unit must be one the analyte reaches, so a marker called
 *     "Glucose" in a unit the registry cannot convert is left unlinked.
 *
 * Returns the registry key, or null. Pure apart from reading the message
 * bundles once.
 */
import { foldForMatch } from "@/lib/i18n/fold-for-match";
import { localisedValues } from "@/lib/i18n/shared-resolve";

import { ANALYTE_ALIASES, BIOMARKER_CATALOG } from "./biomarker-catalog";
import { analyteAcceptsUnit } from "./unit-conversion/convert";
import { analyteConversionFor } from "./unit-conversion/registry";

/** The folded name without a trailing parenthetical gloss: "Vitamin D (25-OH)" -> "vitamin d". */
function withoutGloss(folded: string): string {
  return folded.replace(/\s*\([^)]*\)/gu, "").trim();
}

let cache: ReadonlyMap<string, string> | null = null;

/**
 * folded name -> registry key, with every name two analytes claim removed.
 * Exported for the guard test, which asserts nothing was dropped silently.
 */
export function analyteNameIndex(): {
  index: ReadonlyMap<string, string>;
  ambiguous: readonly string[];
} {
  const claims = new Map<string, Set<string>>();
  const claim = (name: string, key: string) => {
    const folded = foldForMatch(name);
    if (!folded) return;
    const keys = claims.get(folded) ?? new Set<string>();
    keys.add(key);
    claims.set(folded, keys);
  };

  for (const seed of BIOMARKER_CATALOG) {
    const entry = analyteConversionFor(seed.slug);
    if (!entry) continue;
    for (const name of localisedValues(`labs.catalog.${seed.slug}`)) {
      claim(name, entry.key);
      // The bare name too, for a marker typed without the app's gloss.
      claim(withoutGloss(foldForMatch(name)), entry.key);
    }
  }
  for (const { key, names } of ANALYTE_ALIASES) {
    const entry = analyteConversionFor(key);
    if (!entry) continue;
    for (const name of names) claim(name, entry.key);
  }

  const index = new Map<string, string>();
  const ambiguous: string[] = [];
  for (const [folded, keys] of claims) {
    if (keys.size === 1) index.set(folded, [...keys][0]);
    else ambiguous.push(folded);
  }
  return { index, ambiguous };
}

export function matchAnalyteKey(input: {
  name: string;
  unit: string;
}): string | null {
  cache ??= analyteNameIndex().index;
  const key = cache.get(foldForMatch(input.name));
  if (!key) return null;
  return analyteAcceptsUnit(key, input.unit) ? key : null;
}
