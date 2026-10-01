/**
 * A real `UnitDisplay` for one fixed preference, for component tests that
 * render without a QueryClient (`useUnitDisplay` reads the account through
 * react-query). Built on the production transforms, so a test asserts the
 * same numbers and symbols the hook would give.
 *
 *   vi.mock("@/hooks/use-unit-display", async () => {
 *     const { unitDisplayFor } = await import("@/__tests__/helpers/unit-display-mock");
 *     return { useUnitDisplay: () => unitDisplayFor("metric") };
 *   });
 */
import type { UnitDisplay } from "@/hooks/use-unit-display";
import type { GlucoseUnit } from "@/lib/glucose";
import {
  applyDisplayTransform,
  applyDisplayTransformDelta,
  getDisplayTransform,
  hasDisplayTransform,
  invertDisplayTransform,
  type UnitPreference,
} from "@/lib/measurements/display-transform";

export function unitDisplayFor(
  preference: UnitPreference,
  glucoseUnit: GlucoseUnit = "mg/dL",
): UnitDisplay {
  // The hook resolves mass, length and temperature through the
  // metric/imperial branch alone; glucose is converted where it renders.
  const forType = (type: string) => getDisplayTransform(type, preference);
  return {
    preference,
    glucoseUnit,
    transformFor: forType,
    toDisplay: (type, value) => applyDisplayTransform(value, forType(type)),
    fromDisplay: (type, value) => invertDisplayTransform(value, forType(type)),
    toDisplayDelta: (type, value) =>
      applyDisplayTransformDelta(value, forType(type)),
    unitFor: (type) => forType(type).displayUnit,
    decimalsFor: (type) => forType(type).decimals,
    isTransformed: (type) => hasDisplayTransform(type),
  };
}
