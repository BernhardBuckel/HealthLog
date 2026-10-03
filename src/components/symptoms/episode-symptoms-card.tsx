"use client";

/**
 * "Symptoms logged" on an episode's detail page (v1.40): the person's own
 * symptom occurrences that belong to this episode, either because they were
 * filed against it or because they happened while it ran (onset to recovery,
 * or to now while it is open). The filed ones say so. Renders nothing when
 * there are none, so an episode without them looks exactly as before.
 *
 * This is the reader of `SymptomEvent.episodeId`; the quick-entry sheet's
 * "during" selector is its writer.
 */
import { useMemo, useState } from "react";
import { Activity } from "lucide-react";

import { TileHeader } from "@/components/insights/tile-header";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { QueryErrorCard } from "@/components/ui/query-error-card";
import { useAuth } from "@/hooks/use-auth";
import { useRecordCapabilities } from "@/hooks/use-record-capabilities";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import type { SymptomEventDTO } from "@/lib/symptoms/shared";
import { DEFAULT_TIMEZONE } from "@/lib/tz/format";

import {
  groupEventsByDay,
  SymptomEventMenu,
  SymptomEventRow,
} from "./symptoms-section";
import { useSymptomDefinitions, useSymptomEvents } from "./use-symptoms";

export function EpisodeSymptomsCard({
  episode,
}: {
  episode: { id: string; onsetAt: string; resolvedAt: string | null };
}) {
  const { t } = useTranslations();
  const fmt = useFormatters();
  const { user } = useAuth();
  const { canManageDomain } = useRecordCapabilities();
  const canManage = canManageDomain("illness");
  const timezone = user?.timezone ?? DEFAULT_TIMEZONE;

  // The span is fixed per episode state, so the key stays stable while the
  // page is open; an open episode reads up to a few minutes past mount.
  const [openUntil] = useState(() =>
    new Date(Date.now() + 10 * 60 * 1000).toISOString(),
  );
  const range = {
    from: episode.onsetAt,
    to: episode.resolvedAt ?? openUntil,
  };
  const definitions = useSymptomDefinitions(true);
  const inSpan = useSymptomEvents(range.from, range.to);
  const filed = useSymptomEvents("1900-01-01T00:00:00.000Z", range.to, {
    episodeId: episode.id,
  });

  const merged = useMemo(() => {
    const byId = new Map<string, SymptomEventDTO>();
    for (const event of [
      ...(inSpan.data?.events ?? []),
      ...(filed.data?.events ?? []),
    ]) {
      byId.set(event.id, event);
    }
    return [...byId.values()].sort((a, b) =>
      a.occurredAt < b.occurredAt ? 1 : a.occurredAt > b.occurredAt ? -1 : 0,
    );
  }, [inSpan.data, filed.data]);

  if (definitions.isError || inSpan.isError || filed.isError) {
    return (
      <QueryErrorCard
        title={t("symptoms.section.loadError")}
        onRetry={() => {
          void definitions.refetch();
          void inSpan.refetch();
          void filed.refetch();
        }}
      />
    );
  }
  if (merged.length === 0) return null;

  const byId = new Map(
    (definitions.data?.definitions ?? []).map((d) => [d.id, d]),
  );
  const days = groupEventsByDay(merged, timezone);

  return (
    <Card data-testid="episode-symptoms-card">
      <CardHeader>
        <TileHeader
          icon={Activity}
          title={t("symptoms.episode.title")}
          titleAs="h2"
        />
      </CardHeader>
      <CardContent className="space-y-3">
        {days.map((group) => (
          <section key={group.day} className="space-y-0.5">
            <h3 className="text-sm font-medium">
              {fmt.dateWithWeekdaySmart(group.at)}
            </h3>
            <ul className="divide-border divide-y">
              {group.events.map((event) => {
                const definition = byId.get(event.definitionId);
                const label =
                  definition?.label ?? t("symptoms.unreadableLabel");
                return (
                  <SymptomEventRow
                    key={event.id}
                    event={event}
                    definition={definition}
                    annotation={
                      event.episodeId === episode.id
                        ? t("symptoms.episode.filed")
                        : undefined
                    }
                    actions={
                      canManage ? (
                        <SymptomEventMenu event={event} label={label} />
                      ) : undefined
                    }
                  />
                );
              })}
            </ul>
          </section>
        ))}
      </CardContent>
    </Card>
  );
}
