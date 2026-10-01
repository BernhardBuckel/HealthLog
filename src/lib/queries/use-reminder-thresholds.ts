"use client";

import { useQuery } from "@tanstack/react-query";

import { apiGet } from "@/lib/api/api-fetch";
import { queryKeys } from "@/lib/query-keys";
import { useAuth } from "@/hooks/use-auth";
import type { MedicationDueThresholds } from "@/lib/medications/default-medication";

/**
 * The account's own late / missed thresholds for the intake pickers.
 *
 * The cards, the table and the medications page each read
 * `/api/settings/reminder-thresholds` under this key with the same fetcher
 * shape (failure resolves to `null`), so the pickers share their cache entry.
 * `undefined` until it lands or when it failed — the default picker then
 * falls back to the 120 / 240-minute defaults every reader shares.
 */
export function useMedicationDueThresholds():
  MedicationDueThresholds | undefined {
  const { isAuthenticated } = useAuth();
  const { data } = useQuery({
    queryKey: queryKeys.settingsReminderThresholds(),
    queryFn: async () => {
      try {
        return await apiGet<{
          lateMinutes: number;
          missedMinutes: number;
          lowStockRunwayDays: number | null;
        }>("/api/settings/reminder-thresholds");
      } catch {
        return null;
      }
    },
    enabled: isAuthenticated,
    staleTime: 5 * 60 * 1000,
  });
  if (!data) return undefined;
  return { lateMinutes: data.lateMinutes, missedMinutes: data.missedMinutes };
}
