"use client";

/**
 * v1.27.22 (Document vault P2) — content-search indexing hooks.
 *
 *  - `useIndexDocument()` populates / refreshes ONE document's blind content
 *    index (encrypted extracted text + opaque HMAC token array). Vision decrypts
 *    the stored original server-side; text OCR's the image on-device and posts
 *    only the text — the same transport split the assist hooks use.
 *  - `useReindexAll()` fires the per-user corpus backfill (its own rate bucket);
 *    the worker indexes every not-yet-indexed document off-request.
 *
 * Both invalidate the `["documents"]` prefix so the timeline's per-row
 * `hasContentIndex`, the open detail sheet, and the usage coverage gauge all
 * refresh in lockstep.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { useAiProviderState } from "@/hooks/use-ai-capability";
import { apiPost } from "@/lib/api/api-fetch";
import { invalidateKeys, queryKeys } from "@/lib/query-keys";

import {
  runDocumentIndex,
  type DocumentAiMode,
  type DocumentAiTarget,
  type DocumentIndexResult,
} from "./document-ai-transport";

/** Index / re-index one document for content search. */
export function useIndexDocument() {
  const queryClient = useQueryClient();
  const { responseTimeoutMs } = useAiProviderState();
  return useMutation<
    DocumentIndexResult,
    Error,
    { mode: DocumentAiMode; target: DocumentAiTarget }
  >({
    mutationFn: ({ mode, target }) =>
      runDocumentIndex({ mode, target, responseTimeoutMs }),
    onSuccess: () => {
      void invalidateKeys(queryClient, [queryKeys.documents()]);
    },
  });
}

/**
 * Fire the corpus backfill; resolves with how many docs were enqueued.
 *
 * Wire contract (#776): `enqueued` is the NUMBER of live documents the
 * backfill still has to index — the reindex route computes it from the same
 * live-scoped counts the usage gauge reads, and returns an honest 0 when no
 * job was created. The toast interpolates it as a count, so this type is
 * load-bearing: it must match the route's shape exactly (a boolean here once
 * rendered as "Indexing true document(s)").
 */
export function useReindexAll() {
  const queryClient = useQueryClient();
  return useMutation<{ enqueued: number }, Error, void>({
    mutationFn: () =>
      apiPost<{ enqueued: number }>(
        "/api/documents/inbound/reindex",
        undefined,
      ),
    onSuccess: () => {
      void invalidateKeys(queryClient, [queryKeys.documents()]);
    },
  });
}
