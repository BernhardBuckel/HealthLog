/**
 * `POST /api/mood-entries/bulk` — iOS SyncMode bulk backfill.
 *
 * When iOS pairs a fresh device with the server, it drains its local
 * SwiftData mood log via this endpoint in one shot. Per-entry UPSERT
 * semantics keyed by `externalId` so re-runs are idempotent.
 *
 * Body:
 *   { entries: BulkMoodEntry[] }     — capped at 500 per call.
 *
 * Response (always 200):
 *   {
 *     processed,
 *     inserted,
 *     duplicates,
 *     skipped: [{ index, reason }, ...],
 *     entries: [{ index, status, id? }, ...]
 *   }
 *
 * Locked contract — see `.planning/v15-ios-handoff/06-ios-responsibilities.md`
 * §"Cumulative metrics" sibling section for the SyncMode rationale,
 * and `08-locked-contracts.md` §2 for the batch envelope shape.
 */
import { NextRequest } from "next/server";
import { z } from "zod/v4";

import { prisma } from "@/lib/db";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import {
  apiError,
  apiSuccess,
  getClientIp,
  returnAllZodIssues,
  safeJson,
  sanitiseZodIssues,
} from "@/lib/api-response";
import { withIdempotency } from "@/lib/idempotency";
import { checkRateLimit } from "@/lib/rate-limit";
import { markSyncCheckpoint } from "@/lib/sync/checkpoint";
import {
  getScoreForMood,
  moodContextSchema,
  moodLevelEnum,
  moodSourceEnum,
} from "@/lib/validations/mood";
import {
  classifyExternalId,
  unstableExternalIdMeta,
  UNSTABLE_EXTERNAL_ID_REASON,
  type UnstableExternalIdShape,
} from "@/lib/validations/external-id";
import { moodDateKey } from "@/lib/mood/date-key";
import { DEFAULT_TIMEZONE } from "@/lib/tz/format";
import { levelAForWrite } from "@/lib/mood/level-a";
import { persistMoodContext } from "@/lib/mood/context";
import { encryptNote } from "@/lib/crypto/note-cipher";
import { invalidateUserMood } from "@/lib/cache/invalidate";
import { recomputeMoodBucketsForEntry } from "@/lib/rollups/mood-rollups";
import {
  createTagLinks,
  droppedLinkKeysForWire,
  NO_DROPPED_LINK_KEYS,
} from "@/lib/mood/tag-links";

const MAX_ENTRIES_PER_BATCH = 500;
const BATCH_RATE_LIMIT_MAX = 60;
const BATCH_RATE_LIMIT_WINDOW_MS = 60 * 1000;

const bulkEntrySchema = z.object({
  mood: moodLevelEnum,
  tags: z.array(z.string().max(50)).max(20).optional(),
  /**
   * v1.12.0 — structured-tag keys from the catalog (`mood_tags.key`),
   * mirroring the single-entry `POST /api/mood-entries` contract.
   * Without this the bulk path Zod-stripped the field, so iOS-sent
   * taxonomy links were silently dropped on the adopt-on-pair backfill.
   * The server resolves each key to a `MoodTag` row and writes the
   * `MoodEntryTagLink` join; an unknown or archived key is not stored (the
   * catalog is the source of truth) and is listed on that entry's result
   * as `droppedTagKeys`. Bounds match the single-entry
   * `structuredTagKeys` schema so one entry can't fan out an unbounded
   * link set.
   */
  tagKeys: z.array(z.string().max(60)).max(30).optional(),
  /**
   * v1.12.0 — rated mood factors (`kind = 'RATED'` catalog tags carrying
   * a per-entry score). Parallel to the binary `tagKeys`; persisted on
   * `MoodEntryTagLink.rating`. The outer 1..5 here is the envelope; the
   * server rejects a rating outside the resolved factor's own
   * `scaleMin..scaleMax` (e.g. 1..2 for `factor_conflict`) — on the bulk
   * path that marks the single entry `skipped`, never the whole batch.
   */
  ratedFactors: z
    .array(
      z.object({
        key: z.string().max(60),
        rating: z.number().int().min(1).max(5),
      }),
    )
    .max(30)
    .optional(),
  note: z.string().max(500).optional(),
  /**
   * v1.38 — the five level-A self-state values, each 0-10, each optional.
   * A batch that carries none still writes complete rows: the server derives
   * `a1` from the five-point label, so an older client build needs no change
   * to stay correct.
   *
   * `unknown` here and parsed with {@link bulkDimensionsSchema} PER ENTRY in
   * the loop below, for the same reason `context` is: the doc comment beside
   * this field used to promise that an out-of-range value marks THIS entry
   * skipped while the field itself sat in the batch schema and 422'd all five
   * hundred. The words were right and the code was not. A phone draining a
   * year of local history must not lose the year to one row.
   * @per-entry-parse: bulkDimensionsSchema, in the loop below
   */
  a1: z.unknown().optional(),
  a2: z.unknown().optional(),
  a3: z.unknown().optional(),
  a4: z.unknown().optional(),
  a5: z.unknown().optional(),
  /**
   * v1.38 — the day's context. Optional, and absent leaves a stored context
   * alone on a re-post, matching the single-entry path: a build with no
   * context surface must not blank one filled in on the web.
   *
   * Declared as `unknown` here and parsed with `moodContextSchema` PER ENTRY
   * in the loop below, deliberately. Validating it in the batch schema would
   * make one entry carrying a retired key fail all five hundred, and this
   * endpoint's whole contract — stated in its own OpenAPI description — is
   * that a bad row is `skipped` and the rest of the batch lands. A phone
   * draining a year of local history must not lose the year to one row.
   * @per-entry-parse: moodContextSchema, in the loop below
   */
  context: z.unknown().optional(),
  moodLoggedAt: z.iso.datetime({ offset: true }).transform((s) => new Date(s)),
  source: moodSourceEnum.optional().default("MANUAL"),
  /**
   * Optional iOS-side identifier (e.g. SwiftData row UUID) that lets
   * the bulk endpoint dedup idempotently when iOS retries the same
   * batch after a network hiccup. Mirrors the `externalId` posture on
   * the measurements batch endpoint. NULL = no dedup hint; the
   * existing `(userId, date, moodLoggedAt)` unique index still
   * protects against straight-up duplicates.
   *
   * Stability is enforced per entry in the loop below, not at the field:
   * a schema-level refusal would fail the whole batch on one bad row.
   * @external-id-checked-per-entry: src/app/api/mood-entries/bulk/route.ts
   */
  externalId: z.string().min(1).max(120).optional(),
});

/**
 * The five dimensions, validated for one entry.
 *
 * The bound is the scale itself, matching the single-entry schema exactly —
 * one definition of "0 to 10" would be better still, but the single-entry
 * schema states it as a shared const and this one has to answer per entry, so
 * the two are pinned to each other by
 * `src/app/api/mood-entries/__tests__/bulk-dimension-bounds.test.ts` instead.
 */
const bulkDimensionsSchema = z.object({
  a1: z.number().int().min(0).max(10).nullable().optional(),
  a2: z.number().int().min(0).max(10).nullable().optional(),
  a3: z.number().int().min(0).max(10).nullable().optional(),
  a4: z.number().int().min(0).max(10).nullable().optional(),
  a5: z.number().int().min(0).max(10).nullable().optional(),
});

const bulkPayloadSchema = z.object({
  entries: z.array(bulkEntrySchema).min(1).max(MAX_ENTRIES_PER_BATCH),
});

type EntryStatus = "inserted" | "duplicate" | "skipped";
interface EntryResult {
  index: number;
  status: EntryStatus;
  reason?: string;
  id?: string;
  // v1.12.1 — echo the client-supplied source-stable id back on each
  // result so iOS can map a server row id onto its local SwiftData row
  // without re-deriving it. Omitted when the entry sent no externalId.
  externalId?: string;
  // Submitted keys the catalog did not resolve (unknown, archived, another
  // account's custom tag, or the wrong kind). Present only when non-empty,
  // on an "inserted" or "duplicate" result: the entry landed, these did not.
  droppedTagKeys?: string[];
  droppedFactorKeys?: string[];
}

export const POST = apiHandler(withIdempotency<[NextRequest]>(postBulk));

async function postBulk(request: NextRequest): Promise<Response> {
  const { user } = await requireAuth();

  const rl = await checkRateLimit(
    `mood-entries:bulk:${user.id}`,
    BATCH_RATE_LIMIT_MAX,
    BATCH_RATE_LIMIT_WINDOW_MS,
  );
  if (!rl.allowed) {
    return apiError("Too many bulk submissions, try again later", 429);
  }

  const { data: rawBody, error: jsonError } = await safeJson(request, {
    maxBytes: 2 * 1024 * 1024,
  });
  if (jsonError) return jsonError;

  if (
    typeof rawBody === "object" &&
    rawBody !== null &&
    "entries" in rawBody &&
    Array.isArray((rawBody as { entries: unknown }).entries) &&
    (rawBody as { entries: unknown[] }).entries.length > MAX_ENTRIES_PER_BATCH
  ) {
    return apiError(
      `Batch exceeds the ${MAX_ENTRIES_PER_BATCH}-entry limit`,
      422,
      { errorCode: "mood.bulk.too_large" },
    );
  }

  const parsed = bulkPayloadSchema.safeParse(rawBody);
  if (!parsed.success) {
    // v1.4.43 W6 — bulk mood ingest; keep the `mood.bulk.invalid`
    // errorCode meta intact so the iOS Sync engine's retry classifier
    // still branches on it. Adds the audit-ledger breadcrumb keyed
    // `mood.bulk.validation-failed`.
    const issues = sanitiseZodIssues(parsed.error.issues);
    annotate({
      action: { name: "mood.bulk.validation-failed" },
      meta: { issue_count: issues.length },
    });
    // v1.4.49 — strip `message` from the audit-ledger row; bulk mood
    // entries carry free-text `note` + `tags` per row.
    const auditIssues = sanitiseZodIssues(parsed.error.issues, {
      stripValuesFromMessage: true,
    });
    prisma.auditLog
      .create({
        data: {
          userId: user.id,
          action: "mood.bulk.validation-failed",
          details: JSON.stringify({ issues: auditIssues }),
        },
      })
      .catch(() => {
        /* swallow — 422 response is the contract */
      });
    return returnAllZodIssues(parsed.error, 422, {
      errorCode: "mood.bulk.invalid",
    });
  }

  const { entries } = parsed.data;
  const tz = user.timezone ?? DEFAULT_TIMEZONE;

  const results: EntryResult[] = [];
  let inserted = 0;
  let duplicates = 0;
  let droppedTagKeyCount = 0;
  let droppedFactorKeyCount = 0;
  const skipped: Array<{ index: number; reason: string }> = [];
  const unstableShapes: UnstableExternalIdShape[] = [];

  // Perf — a single indexed existence read replaces the per-entry
  // `findUnique` probe (up to 500 sequential round trips pre-fix). Every
  // entry still resolves through exactly the key its own dedup contract
  // uses (externalId when carried, else the legacy date+moodLoggedAt key),
  // so lookups below are byte-identical to the per-entry probe — only the
  // read is now batched. The per-entry `upsert` + tombstone check + tag
  // links + reverse push all stay unchanged; batching those further would
  // risk the correctness-sensitive per-row side effects for a write path
  // that is usually small (a normal sync posts the current + previous
  // local day, not a full historical backfill).
  interface ExistingMoodRow {
    id: string;
    deletedAt: Date | null;
  }
  const orClauses: Array<
    | { source: string; externalId: string }
    | { date: string; moodLoggedAt: Date }
  > = entries.map((entry) =>
    entry.externalId
      ? { source: entry.source, externalId: entry.externalId }
      : {
          date: moodDateKey(entry.moodLoggedAt, tz),
          moodLoggedAt: entry.moodLoggedAt,
        },
  );
  const existingRows =
    orClauses.length > 0
      ? await prisma.moodEntry.findMany({
          where: { userId: user.id, OR: orClauses },
          select: {
            id: true,
            deletedAt: true,
            source: true,
            externalId: true,
            date: true,
            moodLoggedAt: true,
          },
        })
      : [];
  const existingByExternalKey = new Map<string, ExistingMoodRow>();
  const existingByDateKey = new Map<string, ExistingMoodRow>();
  for (const row of existingRows) {
    if (row.externalId !== null) {
      existingByExternalKey.set(`${row.source}::${row.externalId}`, row);
    }
    existingByDateKey.set(
      `${row.date}::${row.moodLoggedAt.toISOString()}`,
      row,
    );
  }

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];

    // The `(userId, source, externalId)` dedup key only holds while the
    // id is STABLE across client launches; a per-process value (an object
    // description carrying a memory address) mints a fresh entry on every
    // re-post. Per-entry refusal, never a whole-batch 422.
    const unstable =
      entry.externalId === undefined
        ? null
        : classifyExternalId(entry.externalId);
    if (unstable) {
      unstableShapes.push(unstable);
      skipped.push({ index: i, reason: UNSTABLE_EXTERNAL_ID_REASON });
      results.push({
        index: i,
        status: "skipped",
        reason: UNSTABLE_EXTERNAL_ID_REASON,
        externalId: entry.externalId,
      });
      continue;
    }

    // The context, parsed for THIS entry. A value outside the vocabulary
    // skips this row and nothing else.
    const parsedContext =
      entry.context === undefined
        ? { success: true as const, data: undefined }
        : moodContextSchema.nullable().safeParse(entry.context);
    if (!parsedContext.success) {
      const reason = "invalid_context";
      skipped.push({ index: i, reason });
      results.push({
        index: i,
        status: "skipped",
        reason,
        ...(entry.externalId ? { externalId: entry.externalId } : {}),
      });
      continue;
    }

    // The five dimensions, parsed for THIS entry. Out of range skips this row
    // and nothing else.
    const parsedDimensions = bulkDimensionsSchema.safeParse({
      a1: entry.a1,
      a2: entry.a2,
      a3: entry.a3,
      a4: entry.a4,
      a5: entry.a5,
    });
    if (!parsedDimensions.success) {
      const reason = "invalid_dimensions";
      skipped.push({ index: i, reason });
      results.push({
        index: i,
        status: "skipped",
        reason,
        ...(entry.externalId ? { externalId: entry.externalId } : {}),
      });
      continue;
    }

    const date = moodDateKey(entry.moodLoggedAt, tz);
    const score = getScoreForMood(entry.mood);
    // v1.37 / v1.38 — the same resolution the single-entry path uses:
    // pleasantness derived from the label unless the entry states its own, and
    // the other four present only when this entry carried them. An omitted
    // dimension is left alone rather than written as null, so a row that
    // already carries hand-set values keeps them across a re-import.
    const levelA = levelAForWrite(entry.mood, parsedDimensions.data);

    try {
      // v1.12.1 — when the entry carries a source-stable `externalId`,
      // dedup on the NULL-distinct `(userId, source, externalId)` key so a
      // re-post with the same id (an iOS retry after a network hiccup, or a
      // second adopt-on-pair backfill) updates the existing row in place
      // instead of minting a duplicate when `moodLoggedAt` re-rounds /
      // re-zones. Absent → the legacy `(userId, date, moodLoggedAt)` key.
      // `source` carries a schema default of "MANUAL"; resolve it once so
      // the probe, upsert key, and create write all agree on the value.
      const resolvedSource = entry.source;
      const probeWhere = entry.externalId
        ? {
            userId_source_externalId: {
              userId: user.id,
              source: resolvedSource,
              externalId: entry.externalId,
            },
          }
        : {
            userId_date_moodLoggedAt: {
              userId: user.id,
              date,
              moodLoggedAt: entry.moodLoggedAt,
            },
          };

      // The response reliably distinguishes "inserted" from "duplicate"
      // via the batched pre-read above (keyed exactly like `probeWhere`),
      // so the per-entry probe here is now a Map lookup, not a round trip.
      const existing =
        (entry.externalId
          ? existingByExternalKey.get(`${resolvedSource}::${entry.externalId}`)
          : existingByDateKey.get(
              `${date}::${entry.moodLoggedAt.toISOString()}`,
            )) ?? null;

      // Tombstone suppression: a soft-deleted match stays deleted. The
      // user-facing DELETE route flips `deletedAt` so the `/api/sync/changes`
      // feed surfaces the deletion to paired clients offline at delete time
      // (see the MoodEntry schema note) — an offline client's later re-post
      // of the same entry is stale state, not a recreation, and must not
      // resurrect the row. True no-op: no value churn, no `updatedAt` bump,
      // no tag-link writes on the hidden row; report `duplicate` so the
      // client checkpoints past it exactly like a live-row match.
      if (existing?.deletedAt) {
        duplicates += 1;
        results.push({
          index: i,
          status: "duplicate",
          id: existing.id,
          ...(entry.externalId ? { externalId: entry.externalId } : {}),
        });
        continue;
      }

      // The upsert and the tag/factor links run in ONE transaction, matching
      // the single-entry POST path. Split apart, an out-of-scale
      // `ratedFactors` value (validated inside `createTagLinks`, i.e. AFTER
      // the row committed) left a persisted mood entry with no links while the
      // per-entry catch reported the entry as "skipped" — the client believes
      // nothing saved and a half-written row is on disk.
      const written = await prisma.$transaction(async (tx) => {
        const upserted = await tx.moodEntry.upsert({
          where: probeWhere,
          create: {
            userId: user.id,
            date,
            tz,
            mood: entry.mood,
            score,
            ...levelA,
            tags: entry.tags ? JSON.stringify(entry.tags) : null,
            note: null,
            noteEncrypted: encryptNote(entry.note ?? null),
            source: resolvedSource,
            externalId: entry.externalId ?? null,
            moodLoggedAt: entry.moodLoggedAt,
          },
          update: {
            // Last-writer-wins on the mood + tags + note triple. The
            // iOS client only re-posts an existing entry when it has
            // new data; the server trusts that decision. When the dedup
            // key is `externalId`, also refresh `date` / `moodLoggedAt`
            // so a re-zoned re-import lands the corrected wall-clock on
            // the same row.
            mood: entry.mood,
            score,
            ...levelA,
            tags: entry.tags ? JSON.stringify(entry.tags) : null,
            note: null,
            noteEncrypted: encryptNote(entry.note ?? null),
            ...(entry.externalId
              ? { date, moodLoggedAt: entry.moodLoggedAt }
              : {}),
          },
        });

        // v1.12.0 — persist structured-tag links, mirroring the
        // single-entry `createTagLinks` path. Additive + idempotent:
        // `createTagLinks` resolves keys against the catalog (dropping
        // unknown keys) and `skipDuplicates` on the join insert keeps a
        // re-posted entry from minting duplicate links. Runs for both
        // fresh and re-posted (upserted) rows so a backfill that adds tag
        // keys on a second pass still lands them.
        // v1.12.0 — rated factors ride the same path; an out-of-scale
        // rating throws `RatedFactorOutOfRangeError`. Inside the
        // transaction that throw now rolls the mood row back with it, so a
        // "skipped" result means nothing was written — which is what the
        // client was already being told.
        // v1.38 — the day context, inside the same transaction as the row, so
        // an entry reported as skipped really did write nothing.
        await persistMoodContext(tx, upserted.id, user.id, parsedContext.data);

        // The keys the catalog did not resolve are reported on this entry's
        // result: "inserted" alone told a client its tags had landed.
        let droppedKeys = NO_DROPPED_LINK_KEYS;
        if (
          (entry.tagKeys && entry.tagKeys.length > 0) ||
          (entry.ratedFactors && entry.ratedFactors.length > 0)
        ) {
          droppedKeys = await createTagLinks(
            upserted.id,
            user.id,
            entry.tagKeys ?? [],
            tx,
            entry.ratedFactors ?? [],
          );
        }

        return { upserted, droppedKeys };
      });
      const result = written.upserted;
      const droppedKeys = written.droppedKeys;
      droppedTagKeyCount += droppedKeys.droppedTagKeys.length;
      droppedFactorKeyCount += droppedKeys.droppedFactorKeys.length;

      if (existing) {
        duplicates += 1;
        results.push({
          index: i,
          status: "duplicate",
          id: result.id,
          ...(entry.externalId ? { externalId: entry.externalId } : {}),
          ...droppedLinkKeysForWire(droppedKeys),
        });
      } else {
        inserted += 1;
        results.push({
          index: i,
          status: "inserted",
          id: result.id,
          ...(entry.externalId ? { externalId: entry.externalId } : {}),
          ...droppedLinkKeysForWire(droppedKeys),
        });
      }
    } catch (err: unknown) {
      // v1.37.19 (A6-18) — P2002 = a concurrent batch raced the same
      // NULL-distinct `(userId, source, externalId)` key and won. That is
      // the plain duplicate the sequential probe would have classified;
      // reporting it as "skipped" with a raw Prisma message told the
      // client its row was dropped when it is in fact stored. Resolve the
      // winning row's id so the caller's cursor advances, exactly like
      // the intake bulk route.
      if (
        typeof err === "object" &&
        err !== null &&
        "code" in err &&
        (err as { code: string }).code === "P2002" &&
        entry.externalId
      ) {
        const winner = await prisma.moodEntry.findFirst({
          where: {
            userId: user.id,
            // Same resolution as the upsert key: the schema defaults
            // `source` to "MANUAL" at parse time.
            source: entry.source,
            externalId: entry.externalId,
          },
          select: { id: true },
        });
        duplicates += 1;
        results.push({
          index: i,
          status: "duplicate",
          ...(winner ? { id: winner.id } : {}),
          externalId: entry.externalId,
        });
        continue;
      }
      const reason =
        err instanceof Error ? err.message.slice(0, 120) : "upsert_failed";
      skipped.push({ index: i, reason });
      results.push({
        index: i,
        status: "skipped",
        reason,
        ...(entry.externalId ? { externalId: entry.externalId } : {}),
      });
    }
  }

  await auditLog("mood.bulk.ingest", {
    userId: user.id,
    ipAddress: getClientIp(request),
    details: {
      processed: entries.length,
      inserted,
      duplicates,
      skipped: skipped.length,
    },
  });

  annotate({
    action: { name: "mood.bulk.ingest" },
    meta: {
      processed: entries.length,
      inserted,
      duplicates,
      skipped: skipped.length,
      dropped_tag_keys: droppedTagKeyCount,
      dropped_factor_keys: droppedFactorKeyCount,
      ...(unstableShapes.length > 0
        ? unstableExternalIdMeta("mood.bulk", unstableShapes)
        : {}),
    },
  });

  // v1.4.34 IW-G — bust per-user mood + achievements + analytics caches
  // when at least one row landed so the next read picks up the ingested
  // batch. Skipped / duplicate-only ingests are no-ops.
  if (inserted > 0) {
    invalidateUserMood(user.id);
  }

  // v1.4.39 W-MOOD — refresh the rollup tier for every distinct day
  // touched by this batch. The bulk endpoint is an iOS one-shot
  // backfill so the batch can span many days; we collapse to the
  // unique `(user, dayStart)` set first to bound the recompute count.
  // Best-effort: rollup failures must not surface as 5xx.
  if (inserted > 0 || duplicates > 0) {
    // v1.32.12 — collapse to the unique set of `date` labels touched by
    // this batch (the same per-row `moodDateKey` the insert used), so
    // the rollup keys byte-identically to the stored `MoodEntry.date`.
    const touchedLabels = new Set<string>();
    for (let i = 0; i < entries.length; i++) {
      const status = results[i]?.status;
      if (status === "inserted" || status === "duplicate") {
        touchedLabels.add(moodDateKey(entries[i].moodLoggedAt, tz));
      }
    }
    try {
      await Promise.all(
        Array.from(touchedLabels).map((label) =>
          recomputeMoodBucketsForEntry(user.id, label),
        ),
      );
    } catch (rollupErr) {
      annotate({
        meta: {
          mood_rollup_write_failed: true,
          mood_rollup_write_error:
            rollupErr instanceof Error ? rollupErr.message : String(rollupErr),
        },
      });
    }
  }

  // The SyncMode checkpoint belongs to the push that moved the data, not to
  // the `/api/sync/state` handshake that reports it. This endpoint is one of
  // the three domains that handshake summarises, so a mood drain advances it.
  await markSyncCheckpoint(user.id);

  return apiSuccess({
    processed: entries.length,
    inserted,
    duplicates,
    skipped,
    entries: results,
  });
}
