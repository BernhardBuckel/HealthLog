/**
 * Zod schemas for `GET /api/search`. The route parses its query with these
 * and the OpenAPI table publishes them. Server and OpenAPI side only: the
 * palette imports its types from `./contract.ts`.
 */
import { z } from "zod/v4";

import {
  SEARCH_HIT_KINDS,
  SEARCH_LIMIT_DEFAULT,
  SEARCH_LIMIT_MAX,
  SEARCH_NOTE_SOURCES,
  SEARCH_QUERY_MAX,
  SEARCH_QUERY_MIN,
} from "./contract";

export const searchQuerySchema = z.object({
  q: z
    .string()
    .trim()
    .min(SEARCH_QUERY_MIN)
    .max(SEARCH_QUERY_MAX)
    .describe(
      "What to look for. Matched without regard to case or accents, and German umlauts may be typed as ae, oe, ue or ss.",
    ),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(SEARCH_LIMIT_MAX)
    .default(SEARCH_LIMIT_DEFAULT)
    .describe("Most hits per group."),
});

const markedTextSchema = z
  .object({
    text: z.string(),
    marks: z
      .array(z.tuple([z.number().int(), z.number().int()]))
      .describe(
        "Half-open [start, end) character ranges of `text` a query word matched.",
      ),
  })
  .meta({ id: "SearchMarkedText" });

export const searchHitSchema = z
  .object({
    id: z.string(),
    kind: z.enum(SEARCH_HIT_KINDS),
    title: markedTextSchema.nullable(),
    context: z.array(markedTextSchema),
    snippet: markedTextSchema.nullable(),
    day: z.string().nullable(),
    path: z
      .string()
      .describe("In-app path that opens the record, never an API path."),
    source: z.enum(SEARCH_NOTE_SOURCES).nullable(),
  })
  .meta({ id: "SearchHit" });

export const searchResponseSchema = z
  .object({
    groups: z.array(
      z.object({
        kind: z.enum(SEARCH_HIT_KINDS),
        hits: z.array(searchHitSchema),
        more: z.boolean(),
      }),
    ),
    truncated: z
      .boolean()
      .describe(
        "The search stopped before it had read every entry (a per-kind row cap or the time budget), so older entries may match and are not listed.",
      ),
  })
  .meta({ id: "SearchResponse" });
