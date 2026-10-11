/**
 * Query keys — the in-app record search (`POST /api/search`, v1.42.2).
 * Part of the centralized factory; aggregated in `./index.ts`.
 *
 * The query text is part of the key, which keeps it in memory only: the
 * `["search"]` head is not on the persister's allowlist, so neither the
 * query nor its hits are written to disk.
 */
export const searchKeys = {
  /** Root prefix. */
  searchRoot: () => ["search"] as const,
  /** `POST /api/search` with `{ q, limit }`. */
  recordSearch: (query: string, limit: number) =>
    ["search", "records", query, limit] as const,
};
