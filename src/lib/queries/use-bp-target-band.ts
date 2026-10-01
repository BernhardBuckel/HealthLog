"use client";

import { useQuery } from "@tanstack/react-query";

import { apiGet } from "@/lib/api/api-fetch";
import { queryKeys } from "@/lib/query-keys";
import { useAuth } from "@/hooks/use-auth";

interface TargetRange {
  min: number;
  max: number;
}

/** The slice of `GET /api/insights/targets` the blood-pressure band needs. */
interface BpTargetsSlice {
  targets: ReadonlyArray<{ type: string; range: TargetRange | null }>;
  bpDiastolic: { range: TargetRange | null };
}

export interface BpTargetBand {
  systolic: TargetRange;
  diastolic: TargetRange;
}

/**
 * The blood-pressure target band for the record on screen, as the server
 * resolved it.
 *
 * The chart used to rebuild the band in the browser from the signed-in
 * account's date of birth. That lost a band the person had set themselves,
 * and inside a shared or managed record it used the viewer's age rather than
 * the record's. `/api/insights/targets` already resolves the band for the
 * record being viewed, with the user's own target winning over the age
 * default, and the reference panel under the chart reads the same payload —
 * so the zones and the panel name one band.
 *
 * Shares the `insightsTargets()` cache entry with the panel; the payload
 * shape is the route's, so both readers hold the same object.
 */
export function useBpTargetBand(): BpTargetBand | null {
  const { isAuthenticated } = useAuth();
  const { data } = useQuery({
    queryKey: queryKeys.insightsTargets(),
    queryFn: () => apiGet<BpTargetsSlice>("/api/insights/targets"),
    enabled: isAuthenticated,
  });
  return selectBpTargetBand(data ?? null);
}

/** Pure projection, exported for the unit test. */
export function selectBpTargetBand(
  data: BpTargetsSlice | null,
): BpTargetBand | null {
  if (!data) return null;
  const systolic =
    data.targets.find((entry) => entry.type === "BLOOD_PRESSURE")?.range ??
    null;
  const diastolic = data.bpDiastolic?.range ?? null;
  if (!systolic || !diastolic) return null;
  return { systolic, diastolic };
}
