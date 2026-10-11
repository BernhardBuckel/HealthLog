"use client";

/**
 * v1.42.2 — the per-medication "record doses automatically" switch.
 *
 * The same switch row as the intake-tracking and reminder rows beside it:
 * the whole row is the hit target, the helper line says what the option
 * does. Flipping writes `PUT /api/medications/[id]` with `{ autoMarkTaken }`;
 * the server stamps the moment it was switched on, and only slots from then
 * on are ever recorded for the person.
 */

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Switch } from "@/components/ui/switch";
import { useTranslations } from "@/lib/i18n/context";
import {
  invalidateKeys,
  medicationDependentKeys,
  refetchInactiveDailyReads,
} from "@/lib/query-keys";
import { apiPut } from "@/lib/api/api-fetch";

const SWITCH_ID = "medication-detail-auto-mark-taken-switch";
const ROW_TITLE_ID = "medication-detail-auto-mark-taken-label";
const HELPER_ID = "medication-detail-auto-mark-taken-helper";

export function AutoMarkTakenBody({
  medicationId,
  autoMarkTaken,
}: {
  medicationId: string;
  autoMarkTaken: boolean;
}) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  const [localOn, setLocalOn] = useState(autoMarkTaken);
  const [submitting, setSubmitting] = useState(false);

  async function flip(next: boolean) {
    if (submitting) return;
    setSubmitting(true);
    const previous = localOn;
    setLocalOn(next);
    try {
      await apiPut(`/api/medications/${medicationId}`, {
        autoMarkTaken: next,
      });
      await invalidateKeys(queryClient, medicationDependentKeys);
      await refetchInactiveDailyReads(queryClient);
      toast.success(
        next
          ? t("medications.autoMarkTaken.enabledToast")
          : t("medications.autoMarkTaken.disabledToast"),
      );
    } catch {
      setLocalOn(previous);
      toast.error(t("medications.autoMarkTaken.toggleFailed"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <label
      htmlFor={SWITCH_ID}
      className="flex items-center justify-between gap-3"
      data-slot="medication-auto-mark-taken-row"
    >
      <span className="space-y-1">
        <span
          id={ROW_TITLE_ID}
          className="text-foreground block text-sm font-medium"
        >
          {t("medications.autoMarkTaken.label")}
        </span>
        <span id={HELPER_ID} className="text-muted-foreground block text-xs">
          {t("medications.autoMarkTaken.helper")}
        </span>
      </span>
      <Switch
        id={SWITCH_ID}
        checked={localOn}
        disabled={submitting}
        onCheckedChange={(checked) => void flip(checked)}
        aria-labelledby={ROW_TITLE_ID}
        aria-describedby={HELPER_ID}
        data-slot="medication-auto-mark-taken-switch"
      />
    </label>
  );
}
