/**
 * `GET /api/search?q=&limit=` — one search over the record (Discussion #1117):
 * visits and procedures, conditions, documents (title and indexed text),
 * vaccinations, lab results, medications, symptoms, workouts and the notes on
 * mood entries, readings and illness days. Each hit carries the in-app path
 * that opens it. The work is `searchRecords` in `src/lib/search/`.
 *
 * Admission declares the whole record, like the timeline: the search lays
 * every section side by side, so a grant scoped to some of them does not open
 * it. The sources are narrowed to the grant's sections all the same
 * (`actingDomainVisibility`), and to the record's module switches, so a
 * switched-off module is not read at all.
 *
 * The query is health data ("Schulter", a drug, a diagnosis). It never
 * reaches a log: the annotation carries its length and the counts only, and a
 * refused query is answered without echoing it.
 *
 * Rate limited per actor: the palette asks once per pause in typing, and a
 * manager searching someone's record spends their own allowance.
 */
import { NextRequest } from "next/server";

import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { apiError, apiSuccess, returnAllZodIssues } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { defaultLocale, locales, type Locale } from "@/lib/i18n/config";
import { annotate } from "@/lib/logging/context";
import { resolveModuleMap } from "@/lib/modules/gate";
import { checkRateLimit } from "@/lib/rate-limit";
import { searchRecords } from "@/lib/search/search-records";
import { searchQuerySchema } from "@/lib/search/wire-schemas";
import { actingDomainVisibility } from "@/lib/sharing/acting-domains";
import { resolveUserTimezone } from "@/lib/tz/resolver";

/** Searches per actor per minute: a few per typed word, with room to spare. */
const SEARCH_RATE_LIMIT = 60;
const SEARCH_RATE_WINDOW_MS = 60_000;

function displayLocale(value: string | null | undefined): Locale {
  return locales.includes(value as Locale) ? (value as Locale) : defaultLocale;
}

export const GET = apiHandler(async (request: NextRequest) => {
  const { user, actor, grantId } = await requireRecordAuth("read", "record");

  const rl = await checkRateLimit(
    `search:${actor.id}`,
    SEARCH_RATE_LIMIT,
    SEARCH_RATE_WINDOW_MS,
  );
  if (!rl.allowed) {
    return apiError("Too many searches. Please retry shortly.", 429);
  }

  const params = new URL(request.url).searchParams;
  const parsed = searchQuerySchema.safeParse({
    q: params.get("q") ?? undefined,
    limit: params.get("limit") ?? undefined,
  });
  if (!parsed.success) {
    annotate({
      action: { name: "search.query.invalid" },
      meta: { issue_count: parsed.error.issues.length },
    });
    return returnAllZodIssues(parsed.error, 422, {
      errorCode: "search.invalid",
    });
  }

  const [modules, domainVisible, timezone] = await Promise.all([
    resolveModuleMap(user.id),
    actingDomainVisibility(prisma, grantId),
    resolveUserTimezone(user.id),
  ]);
  const result = await searchRecords({
    recordId: user.id,
    query: parsed.data.q,
    limit: parsed.data.limit,
    modules,
    domainVisible,
    displayLocale: displayLocale(actor.locale),
    timezone,
  });

  annotate({
    action: { name: "search.query.run" },
    meta: {
      query_length: parsed.data.q.length,
      limit: parsed.data.limit,
      sources: result.stats.sources,
      rows_scanned: result.stats.rows,
      matches: result.stats.candidates,
      groups: result.groups.length,
      hits: result.groups.reduce((n, g) => n + g.hits.length, 0),
      truncated: result.truncated,
      elapsed_ms: result.stats.elapsedMs,
      delegated: grantId !== null,
    },
  });
  return apiSuccess({ groups: result.groups, truncated: result.truncated });
});
