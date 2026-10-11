/**
 * The in-app record search (`POST /api/search`): its vocabulary and wire
 * types. Pure constants and types, no validator, so the command palette
 * imports this file and nothing server-side. The Zod schemas the route parses
 * with and the OpenAPI table publishes live in `./wire-schemas.ts`.
 */

/**
 * The groups a hit is listed under, in the order the palette falls back to
 * when two groups' best hits tie.
 */
export const SEARCH_HIT_KINDS = [
  "visit",
  "condition",
  "document",
  "vaccination",
  "lab",
  "medication",
  "symptom",
  "workout",
  "note",
] as const;

export type SearchHitKind = (typeof SEARCH_HIT_KINDS)[number];

/** The entry a free-text note was written on. */
export const SEARCH_NOTE_SOURCES = ["mood", "measurement", "illness"] as const;

export type SearchNoteSource = (typeof SEARCH_NOTE_SOURCES)[number];

/** Shortest query the server searches for. */
export const SEARCH_QUERY_MIN = 2;
/** Longest query the server accepts. */
export const SEARCH_QUERY_MAX = 100;
/** Hits per group when the caller names no limit. */
export const SEARCH_LIMIT_DEFAULT = 5;
/** Most hits per group a caller can ask for. */
export const SEARCH_LIMIT_MAX = 20;

/** A half-open `[start, end)` character range of `text`. */
export type SearchMarkRange = [number, number];

/** Text with the ranges a query word matched. Plain text, never markup. */
export interface SearchMarkedText {
  text: string;
  marks: SearchMarkRange[];
}

export interface SearchHit {
  /** Unique within one answer: `<source>:<record id>`. */
  id: string;
  kind: SearchHitKind;
  /** The record's own name, or null when the kind's label names it. */
  title: SearchMarkedText | null;
  /** Short context values: a practitioner, a body site, a dose. */
  context: SearchMarkedText[];
  /** The part of the record's free text the query hit, or null. */
  snippet: SearchMarkedText | null;
  /** The record's calendar day, `YYYY-MM-DD`, or null. */
  day: string | null;
  /** In-app path that opens the record. */
  path: string;
  /** For a note: the entry it was written on. Null for every other kind. */
  source: SearchNoteSource | null;
}

export interface SearchGroup {
  kind: SearchHitKind;
  hits: SearchHit[];
  /** More hits of this kind matched than the limit lets through. */
  more: boolean;
}

export interface SearchResponse {
  /** Groups with at least one hit, the best group first. */
  groups: SearchGroup[];
  /**
   * The search stopped before it had read every entry (the per-kind row cap
   * or the time budget), so older entries may match and are not listed.
   */
  truncated: boolean;
}
