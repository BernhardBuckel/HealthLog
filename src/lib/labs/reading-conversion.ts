/**
 * A lab reading, written in its marker's unit.
 *
 * Every reading is stored under the unit of its marker. A reading that states
 * the same unit (spelling aside) goes in as it is. One that states another is
 * converted when the marker's analyte is known and the registry has the pair,
 * keeping what the report printed beside it (`sourceValue`, `sourceUnit`) so a
 * number nobody typed can always be traced back. Anything else is refused,
 * exactly as before: the number is never kept under a unit it is not in.
 *
 * The report's own reference window is in the unit the report printed, so it is
 * converted with the value; a verdict that compared a converted value with an
 * unconverted window would be wrong. Full precision is stored, rounding is for
 * display.
 */
import type { PrismaClient } from "@/generated/prisma/client";

import { ensureAnalyteKey } from "./analyte-key-store";
import {
  convertLabRange,
  convertLabValue,
  type ConversionRefusal,
} from "./unit-conversion/convert";
import { sameLabUnit } from "./unit-normalise";

export interface ReadingMarker {
  id: string;
  name: string;
  unit: string;
  analyteKey?: string | null;
}

export type ReadingInMarkerUnit =
  | {
      ok: true;
      converted: false;
      value: number;
      sourceReferenceLow: number | null;
      sourceReferenceHigh: number | null;
    }
  | {
      ok: true;
      converted: true;
      value: number;
      sourceReferenceLow: number | null;
      sourceReferenceHigh: number | null;
      /** The value as the report printed it. */
      sourceValue: number;
      /** The unit as the report printed it, trimmed. */
      sourceUnit: string;
    }
  | { ok: false; reason: ConversionRefusal };

export async function readingInMarkerUnit(
  client: Pick<PrismaClient, "biomarker">,
  input: {
    marker: ReadingMarker;
    value: number;
    /** The unit the reading states; undefined means the marker's own. */
    unit: string | undefined;
    sourceReferenceLow: number | null;
    sourceReferenceHigh: number | null;
  },
): Promise<ReadingInMarkerUnit> {
  const { marker, value, unit, sourceReferenceLow, sourceReferenceHigh } =
    input;
  if (unit === undefined || sameLabUnit(unit, marker.unit)) {
    return {
      ok: true,
      converted: false,
      value,
      sourceReferenceLow,
      sourceReferenceHigh,
    };
  }

  const analyteKey = await ensureAnalyteKey(client, marker);
  const converted = convertLabValue({
    analyteKey,
    value,
    from: unit,
    to: marker.unit,
  });
  if (!converted.ok) return { ok: false, reason: converted.reason };

  // The printed window is in the printed unit; move it with the value.
  const range = convertLabRange({
    analyteKey,
    low: sourceReferenceLow,
    high: sourceReferenceHigh,
    from: unit,
    to: marker.unit,
  });
  if (!range.ok) return { ok: false, reason: range.reason };

  return {
    ok: true,
    converted: true,
    value: converted.value,
    sourceReferenceLow: range.low,
    sourceReferenceHigh: range.high,
    sourceValue: value,
    sourceUnit: unit.trim(),
  };
}
