/**
 * What the in-app record search reads: one source per table and field it
 * matches, the group each lists its hits under, and the record section each
 * belongs to. Pure data, so the surface registry test reads it too.
 *
 * Two masks, as everywhere else. A source is read only when the record's
 * module for it is on (the `search:<source>` entries of
 * `src/lib/modules/surface.ts`; a source with no entry is core) and when the
 * caller's grant covers its section (`SEARCH_SOURCE_DOMAIN`). The route
 * admits the whole record only, so for today's callers the second mask is
 * always open; it is applied all the same, so narrowing that admission later
 * cannot widen what the search reads.
 */
import type { ShareDomain } from "@/lib/sharing/scope";

import type { SearchHitKind } from "./contract";

export const SEARCH_SOURCE_KEYS = [
  "visit",
  "condition",
  "document",
  "vaccination",
  "labAnalyte",
  "labNote",
  "medication",
  "symptom",
  "symptomNote",
  "workout",
  "moodNote",
  "illnessNote",
  "measurementNote",
] as const;

export type SearchSourceKey = (typeof SEARCH_SOURCE_KEYS)[number];

/** The group each source lists its hits under. */
export const SEARCH_SOURCE_KIND: Record<SearchSourceKey, SearchHitKind> = {
  visit: "visit",
  condition: "condition",
  document: "document",
  vaccination: "vaccination",
  labAnalyte: "lab",
  labNote: "lab",
  medication: "medication",
  symptom: "symptom",
  symptomNote: "symptom",
  workout: "workout",
  moodNote: "note",
  illnessNote: "note",
  measurementNote: "note",
};

/**
 * The record section each source reads, as the routes that serve those rows
 * declare it: visits and the immunization log sit in `profile`, workouts and
 * reading notes in `measurements`, mood in `mind`.
 */
export const SEARCH_SOURCE_DOMAIN: Record<SearchSourceKey, ShareDomain> = {
  visit: "profile",
  condition: "illness",
  document: "documents",
  vaccination: "profile",
  labAnalyte: "labs",
  labNote: "labs",
  medication: "medications",
  symptom: "illness",
  symptomNote: "illness",
  workout: "measurements",
  moodNote: "mind",
  illnessNote: "illness",
  measurementNote: "measurements",
};
