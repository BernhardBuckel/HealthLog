/**
 * Re-warm the stored texts that quote numbers after a unit preference changes.
 *
 * A status note and a period narrative are written once and served all day
 * (the narrative for up to twenty hours). Both now state their figures in the
 * reader's units, so a note written before a switch from mg/dL to mmol/L — or
 * from metric to imperial — keeps saying the old unit until something
 * regenerates it. Nothing did: neither preference write touched the stored
 * text.
 *
 * The refill goes through the same hash-gated path as the manual regenerate:
 * every card the record has is enqueued, the worker forces a fresh snapshot,
 * and a card whose snapshot did not change (a metric that does not depend on
 * the preference) gets a timestamp refresh and no model call. Narratives are
 * re-warmed only where one already exists. Best-effort and fire-and-forget:
 * the preference write never waits on it and never fails because of it.
 */
import { prisma } from "@/lib/db";
import { enqueueNarrativeWarm } from "@/lib/jobs/period-narrative-shared";
import { enqueueStatusRefillForUser } from "@/lib/insights/status-invalidation";
import { normalizeLocale } from "@/lib/insights/status-shared";
import { locales, type Locale } from "@/lib/i18n/config";
import type { NarrativePeriod } from "@/lib/insights/narrative/period-narrative";
import { annotate } from "@/lib/logging/context";

export async function refreshTextsAfterUnitChange(
  userId: string,
): Promise<void> {
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { locale: true },
    });
    const statusScopes = await enqueueStatusRefillForUser(
      userId,
      normalizeLocale(user?.locale),
    );

    const narratives = await prisma.insightNarrative.findMany({
      where: { userId },
      select: { period: true, locale: true },
    });
    let narrativeCount = 0;
    for (const row of narratives) {
      if (row.period !== "week" && row.period !== "month") continue;
      if (!(locales as readonly string[]).includes(row.locale)) continue;
      void enqueueNarrativeWarm({
        userId,
        period: row.period as NarrativePeriod,
        locale: row.locale as Locale,
      });
      narrativeCount++;
    }

    annotate({
      action: { name: "insights.unit-change.refresh" },
      meta: { status_scopes: statusScopes, narratives: narrativeCount },
    });
  } catch {
    // Best-effort: the nightly warm and the next ingest still converge the
    // texts; a failed enqueue must not surface on the preference write.
  }
}
