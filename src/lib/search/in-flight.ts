/**
 * One search in flight per actor and record.
 *
 * The palette searches once per pause in typing, and the client cancels the
 * previous request when the text changes. A cancelled fetch does not stop the
 * server, though: without this, every keystroke-pause left a search reading
 * and decrypting on the server until its own budget ran out, so a fast typist
 * held several at once. A new search by the same actor in the same record
 * aborts the one before it, which stops at its next budget check. Searches
 * of two different records (a tab on one's own record, another on a record
 * shared with them) are two separate palettes and never cancel each other.
 *
 * Per process: on a multi-instance deploy two searches by one actor on two
 * instances both run, each still bounded by its own time budget and by the
 * per-actor rate limit, which lives in Postgres.
 */
const inFlight = new Map<string, AbortController>();

/** The reason a search was stopped for a newer one. */
export const SUPERSEDED = "search.superseded";

export interface SearchSlot {
  /** Aborted when the same actor starts a newer search of the same record. */
  signal: AbortSignal;
  /** Release the slot once the search answered (or failed). */
  end: () => void;
}

export function beginSearch(actorId: string, recordId: string): SearchSlot {
  // Ids are cuids, so the separator cannot occur inside either part.
  const key = `${actorId}:${recordId}`;
  inFlight.get(key)?.abort(SUPERSEDED);
  const controller = new AbortController();
  inFlight.set(key, controller);
  return {
    signal: controller.signal,
    end: () => {
      if (inFlight.get(key) === controller) inFlight.delete(key);
    },
  };
}

/** Searches currently held, for tests. */
export function searchesInFlight(): number {
  return inFlight.size;
}
