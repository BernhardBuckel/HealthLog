"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";

import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useRecordCapabilities } from "@/hooks/use-record-capabilities";
import { apiPost } from "@/lib/api/api-fetch";
import { queryKeys } from "@/lib/query-keys";
import {
  SEARCH_QUERY_MAX,
  SEARCH_QUERY_MIN,
  type SearchResponse,
} from "@/lib/search/contract";

/** Hits per group the palette asks for. */
export const PALETTE_RECORD_LIMIT = 4;
/** Pause in typing before the record search runs. */
const DEBOUNCE_MS = 200;

export interface RecordSearchState {
  /** The query the shown answer belongs to, or null while none applies. */
  query: string | null;
  data: SearchResponse | undefined;
  /**
   * The answer for the typed text is not in yet (still typing, or the
   * request in flight). `data` may hold the previous query's answer.
   */
  loading: boolean;
  error: boolean;
}

/**
 * The palette's search over the record, after the local results.
 *
 * Runs once the typing pauses, for a query of at least two characters, and
 * only where the server answers it: on the person's own record, or on a
 * record shared whole. A grant over some sections never opens the search, so
 * it is not asked. The request carries the query's abort signal: when the
 * next keystroke changes the key, the previous query loses its observer and
 * its request is cancelled rather than left to land late, and the server
 * stops reading for it as well.
 */
export function useRecordSearch(rawQuery: string): RecordSearchState {
  const { inSharedRecord, sections } = useRecordCapabilities();
  const available = !inSharedRecord || sections === null;
  const typed = rawQuery.trim().slice(0, SEARCH_QUERY_MAX);
  const query = useDebouncedValue(typed, DEBOUNCE_MS);
  const wanted = available && typed.length >= SEARCH_QUERY_MIN;
  const enabled = wanted && query.length >= SEARCH_QUERY_MIN;

  const result = useQuery({
    queryKey: queryKeys.recordSearch(query, PALETTE_RECORD_LIMIT),
    // A POST with the query in the body, so it never stands in a URL that a
    // proxy's access log or the browser history could keep.
    queryFn: ({ signal }) =>
      apiPost<SearchResponse>(
        "/api/search",
        { q: query, limit: PALETTE_RECORD_LIMIT },
        { signal },
      ),
    enabled,
    // The previous answer stays while the next one loads, so typing does not
    // flash the section empty between keystrokes.
    placeholderData: keepPreviousData,
    staleTime: 30_000,
    gcTime: 60_000,
    retry: false,
  });

  // Still typing, or the answer for the typed text not in yet.
  const current = typed === query && !result.isPlaceholderData;
  return {
    query: wanted ? typed : null,
    data: wanted && enabled ? result.data : undefined,
    loading: wanted && (!current || result.isFetching),
    error: wanted && current && result.isError,
  };
}
