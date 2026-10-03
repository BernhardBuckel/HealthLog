"use client";

/**
 * v1.40 — person-defined symptoms: read and write hooks.
 *
 * Reads unwrap the envelope through `apiGet`; every key comes from the
 * factory (`queryKeys.symptom*`, under the `["illness"]` root). Every write
 * evicts the whole illness tree, because the episode detail lists the
 * occurrences filed against it and the definition summaries count them.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiDelete, apiGet, apiPatch, apiPost } from "@/lib/api/api-fetch";
import { invalidateKeys, queryKeys } from "@/lib/query-keys";
import type {
  SymptomDefinitionDTO,
  SymptomEventDTO,
} from "@/lib/symptoms/shared";

export interface SymptomDefinitionList {
  definitions: SymptomDefinitionDTO[];
  limit: number;
}

export interface SymptomEventList {
  events: SymptomEventDTO[];
  limit: number;
  hasMore: boolean;
}

export interface SymptomEventCreateInput {
  definitionId: string;
  intensity: number;
  occurredAt?: string;
  note?: string | null;
  episodeId?: string | null;
}

export interface SymptomEventUpdateInput {
  occurredAt?: string;
  intensity?: number;
  note?: string | null;
  episodeId?: string | null;
}

/** The record's symptom list; `includeHidden` adds the hidden ones. */
export function useSymptomDefinitions(includeHidden = false, enabled = true) {
  return useQuery({
    queryKey: queryKeys.symptomDefinitions(includeHidden),
    enabled,
    queryFn: () =>
      apiGet<SymptomDefinitionList>(
        `/api/symptoms/definitions?includeHidden=${includeHidden}`,
      ),
  });
}

/**
 * Occurrences inside `[from, to]` (ISO instants), optionally only those filed
 * against one episode. At most 500, newest first.
 */
export function useSymptomEvents(
  from: string,
  to: string,
  options: { episodeId?: string | null; enabled?: boolean } = {},
) {
  const episodeId = options.episodeId ?? null;
  return useQuery({
    queryKey: queryKeys.symptomEvents(from, to, episodeId),
    enabled: options.enabled ?? true,
    queryFn: () => {
      const params = new URLSearchParams({ from, to, limit: "500" });
      if (episodeId) params.set("episodeId", episodeId);
      return apiGet<SymptomEventList>(`/api/symptoms/events?${params}`);
    },
  });
}

function useInvalidateSymptoms() {
  const qc = useQueryClient();
  return () => invalidateKeys(qc, [queryKeys.illness()]);
}

export function useCreateSymptomDefinition() {
  const invalidate = useInvalidateSymptoms();
  return useMutation({
    mutationFn: (input: { label: string; icon?: string | null }) =>
      apiPost<SymptomDefinitionDTO>("/api/symptoms/definitions", input),
    onSuccess: invalidate,
  });
}

export function useUpdateSymptomDefinition() {
  const invalidate = useInvalidateSymptoms();
  return useMutation({
    mutationFn: ({
      id,
      input,
    }: {
      id: string;
      input: {
        label?: string;
        icon?: string | null;
        isActive?: boolean;
        sortOrder?: number;
      };
    }) =>
      apiPatch<SymptomDefinitionDTO>(`/api/symptoms/definitions/${id}`, input),
    onSuccess: invalidate,
  });
}

export function useDeleteSymptomDefinition() {
  const invalidate = useInvalidateSymptoms();
  return useMutation({
    mutationFn: ({ id, purge }: { id: string; purge: boolean }) =>
      apiDelete<{ deleted: true; purged: boolean; eventsDeleted: number }>(
        `/api/symptoms/definitions/${id}${purge ? "?purge=true" : ""}`,
      ),
    onSuccess: invalidate,
  });
}

export function useLogSymptomEvent() {
  const invalidate = useInvalidateSymptoms();
  return useMutation({
    mutationFn: (input: SymptomEventCreateInput) =>
      apiPost<SymptomEventDTO>("/api/symptoms/events", input),
    onSuccess: invalidate,
  });
}

export function useUpdateSymptomEvent() {
  const invalidate = useInvalidateSymptoms();
  return useMutation({
    mutationFn: ({
      id,
      input,
    }: {
      id: string;
      input: SymptomEventUpdateInput;
    }) => apiPatch<SymptomEventDTO>(`/api/symptoms/events/${id}`, input),
    onSuccess: invalidate,
  });
}

export function useDeleteSymptomEvent() {
  const invalidate = useInvalidateSymptoms();
  return useMutation({
    mutationFn: (id: string) =>
      apiDelete<{ deleted: true }>(`/api/symptoms/events/${id}`),
    onSuccess: invalidate,
  });
}
