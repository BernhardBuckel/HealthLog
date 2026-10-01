"use client";

/**
 * v1.32.26 — the single client choke point for metric/imperial display.
 *
 * Reads the user's `unitPreference` from the cached `/api/auth/me` payload
 * (`useAuth`, keyed under `queryKeys.authMe()`, invalidated by the settings
 * select on change — no extra fetch) and hands back preference-bound sugar
 * over `getDisplayTransform`. Every render surface that shows a measurement
 * value or unit for a type in `TRANSFORMS` resolves through this hook, so the
 * preference is honoured in exactly one place and no surface hardcodes a unit
 * string or scale.
 *
 * The underlying `display-transform.ts` module stays pure and server-safe (it
 * is imported by an API route); only this thin wrapper is a client hook.
 */
import { useMemo } from "react";

import { useAccountOnceMounted, useAuth } from "@/hooks/use-auth";
import {
  applyDisplayTransform,
  applyDisplayTransformDelta,
  getDisplayTransform,
  invertDisplayTransform,
  hasDisplayTransform,
  resolveUnitPreference,
  type DisplayTransform,
  type UnitPreference,
} from "@/lib/measurements/display-transform";
import { resolveGlucoseUnit, type GlucoseUnit } from "@/lib/glucose";

export interface UnitDisplay {
  /** Resolved preference ("metric" by default / on a stale payload). */
  preference: UnitPreference;
  /**
   * Resolved glucose unit ("mg/dL" by default). Carried beside the
   * metric/imperial branch so a surface that edits or renders glucose reads
   * both preferences from the one hook.
   */
  glucoseUnit: GlucoseUnit;
  /** The full transform for a type under the current preference. */
  transformFor: (type: string) => DisplayTransform;
  /** Convert a raw canonical ABSOLUTE value to the display value. */
  toDisplay: (type: string, rawValue: number) => number;
  /** Convert a display ABSOLUTE value back to canonical (entry boundary). */
  fromDisplay: (type: string, displayValue: number) => number;
  /** Convert a DELTA / slope / SD — factor only, never the affine offset. */
  toDisplayDelta: (type: string, deltaValue: number) => number;
  /** The display unit symbol for a type under the current preference. */
  unitFor: (type: string) => string;
  /** Display decimal places for a type under the current preference. */
  decimalsFor: (type: string) => number;
  /** True when a type actually rescales under preference (vs identity). */
  isTransformed: (type: string) => boolean;
}

export function useUnitDisplay(): UnitDisplay {
  const { user } = useAuth();
  return useDisplayForPreference(user?.unitPreference, user?.glucoseUnit);
}

/**
 * The same sugar, with the preference withheld from the SSR pass and the
 * hydration render.
 *
 * A surface that paints inside a streamed page boundary hydrates after the app
 * shell has already answered `/api/auth/me`, so an imperial account renders
 * "lb" on the hydration render where the server — which has no account payload
 * at all — rendered "kg". React calls that a mismatch and discards the streamed
 * tree; on `/` that is the whole RSC prefetch. Reading the preference one
 * render later costs nothing the server had anyway. See
 * `useAccountOnceMounted`.
 *
 * Kept separate from `useUnitDisplay` rather than folded into it: most callers
 * render only after their own data lands, well past mount, and would pay a
 * needless indirection for a hazard they do not have.
 */
export function useUnitDisplayOnceMounted(): UnitDisplay {
  const user = useAccountOnceMounted();
  return useDisplayForPreference(user?.unitPreference, user?.glucoseUnit);
}

function useDisplayForPreference(
  rawPreference: string | null | undefined,
  rawGlucoseUnit: string | null | undefined,
): UnitDisplay {
  const preference = resolveUnitPreference(rawPreference);
  const glucoseUnit = resolveGlucoseUnit(rawGlucoseUnit);

  return useMemo<UnitDisplay>(() => {
    const transformFor = (type: string) =>
      getDisplayTransform(type, preference);
    return {
      preference,
      glucoseUnit,
      transformFor,
      toDisplay: (type, rawValue) =>
        applyDisplayTransform(rawValue, transformFor(type)),
      fromDisplay: (type, displayValue) =>
        invertDisplayTransform(displayValue, transformFor(type)),
      toDisplayDelta: (type, deltaValue) =>
        applyDisplayTransformDelta(deltaValue, transformFor(type)),
      unitFor: (type) => transformFor(type).displayUnit,
      decimalsFor: (type) => transformFor(type).decimals,
      isTransformed: (type) => hasDisplayTransform(type),
    };
  }, [preference, glucoseUnit]);
}
