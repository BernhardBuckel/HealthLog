"use client";

import { useTranslations } from "@/lib/i18n/context";
import { splitDurationMinutes } from "@/lib/measurements/parse-duration";

/**
 * How a duration entry was understood, under the field: "Read as 7 h 30 min".
 * Shown for every entry the parser accepts, so "7.5", "7:30" and "7h30" can
 * each be checked against what the person meant before saving.
 */
export function DurationReadAs({ minutes }: { minutes: number }) {
  const { t } = useTranslations();
  const parts = splitDurationMinutes(minutes);
  const duration =
    parts.hours === 0
      ? t("measurements.durationMinutesOnly", { minutes: parts.minutes })
      : parts.minutes === 0
        ? t("measurements.durationHoursOnly", { hours: parts.hours })
        : t("measurements.durationHoursMinutes", parts);
  return (
    <span aria-live="polite" data-duration-minutes={Math.round(minutes)}>
      {t("measurements.durationReadAs", { duration })}
    </span>
  );
}
