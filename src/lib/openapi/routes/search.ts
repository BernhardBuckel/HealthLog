/**
 * OpenAPI route table for the in-app record search (`/api/search`, v1.42.2,
 * Discussion #1117).
 *
 * Part of the OpenAPI route table; aggregated in `./index.ts`. The query and
 * response schemas are the runtime ones from `@/lib/search/wire-schemas`, so
 * the published contract is the parser's own.
 */
import type { ZodOpenApiObject } from "zod-openapi";

import {
  searchQuerySchema,
  searchResponseSchema,
} from "@/lib/search/wire-schemas";

import { dataEnvelope, recordRefusal, stdResponses } from "./shared";

export const searchPaths: NonNullable<ZodOpenApiObject["paths"]> = {
  "/api/search": {
    post: {
      tags: ["Records"],
      summary: "Search the record",
      description:
        "One search over the record: visits and procedures, conditions, documents (title, file name and indexed text), vaccinations, lab results (analyte names and notes), medications, symptoms, workouts by sport, and the notes on mood entries, readings and illness days. Hits are grouped by kind, the best group first, and each carries the in-app path that opens the record. Matching ignores case and accents and reads German umlauts typed as ae, oe, ue or ss. A source whose module the record has switched off is not read. The search reads each source newest first under a per-source row cap and a time budget; `truncated` says when that cut it short. The query travels in the JSON body, never in the URL, and is never logged. Rate limited per acting account (20 a minute), and one search at a time: a newer search by the same account stops the one before it, which then answers 409 `search.superseded`. A grant scoped to some sections of the record does not open it, like the timeline.",
      requestBody: {
        required: true,
        content: { "application/json": { schema: searchQuerySchema } },
      },
      responses: {
        "200": {
          description: "The hits, grouped by kind.",
          content: {
            "application/json": {
              schema: dataEnvelope(searchResponseSchema, "SearchEnvelope"),
            },
          },
        },
        ...stdResponses,
        ...recordRefusal(),
      },
    },
  },
};
