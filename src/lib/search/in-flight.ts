/**
 * One search in flight per actor.
 *
 * The palette searches once per pause in typing, and the client cancels the
 * previous request when the text changes. A cancelled fetch does not stop the
 * server, though: without this, every keystroke-pause left a search reading
 * and decrypting on the server until its own budget ran out, so a fast typist
 * held several at once. A new search by the same actor aborts the one before
 * it, which stops at its next budget check.
 *
 * Per process: on a multi-instance deploy two searches by one actor on two
 * instances both run, each still bounded by its own time budget and by the
 * per-actor rate limit, which lives in Postgres.
 */
const inFlight = new Map<string, AbortController>();

/** The reason a search was stopped for a newer one. */
export const SUPERSEDED = "search.superseded";

export interface SearchSlot {
  /** Aborted when the same actor starts a newer search. */
  signal: AbortSignal;
  /** Release the slot once the search answered (or failed). */
  end: () => void;
}

export function beginSearch(actorId: string): SearchSlot {
  inFlight.get(actorId)?.abort(SUPERSEDED);
  const controller = new AbortController();
  inFlight.set(actorId, controller);
  return {
    signal: controller.signal,
    end: () => {
      if (inFlight.get(actorId) === controller) inFlight.delete(actorId);
    },
  };
}

/** Searches currently held, for tests. */
export function searchesInFlight(): number {
  return inFlight.size;
}
