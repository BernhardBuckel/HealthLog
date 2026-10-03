/**
 * `POST /api/workouts/batch` — typed workout ingest with nested route.
 *
 * Consumers:
 *   1. The native iOS app draining its HealthKit observer queue —
 *      maps `HKWorkout` + `HKWorkoutRoute` samples into the request
 *      shape locked by `createBatchWorkoutSchema` in
 *      `src/lib/validations/workout.ts`.
 *   2. The Withings activity sync (W17b, deferred) — server-to-server
 *      ingest with `externalId` formatted as
 *      `"${withings.id}:${withings.model_id ?? "0"}:${withings.startdate}"`.
 *      Withings ships no route geometry, so the nested `route` is
 *      always absent for WITHINGS-sourced entries. NOTE: the request
 *      schema's `source` is narrowed to the client-writable set
 *      (MANUAL / APPLE_HEALTH), so this server path must write its
 *      `WITHINGS`-sourced rows directly via `prisma.workout.upsert`
 *      (as the WHOOP / Fitbit syncs already do), not through this route.
 *   3. A third-party bridge holding a narrow `workouts:write` token
 *      (#1054) — a watch vendor's sync relayed by a small service. Its
 *      rows are attributed `EXTERNAL`, resolved from the credential; see
 *      the source guard in the handler.
 *
 * Cross-cutting concerns mirror `/api/measurements/batch` so the iOS
 * sync engine can re-use the same retry / cursor plumbing:
 *   - `requireAuth` naming `WORKOUTS_WRITE_SCOPE` — a cookie session, a
 *     wildcard (`["*"]`) token, or a narrow `workouts:write` token. Every
 *     other narrow token is refused 403: under the fail-closed default a
 *     route admits exactly the scope it names, so a `measurements:write`
 *     credential does not reach this route.
 *   - `withIdempotency` — `Idempotency-Key` header replays the cached
 *     response on retry (24h window).
 *   - `checkRateLimit("workouts:batch:${user.id}", 60, 60s)` — same
 *     window as the measurements batch. 60 batches/min × 100
 *     workouts/batch = 6 000 workouts/min headroom (orders of
 *     magnitude past any healthy iOS sync).
 *   - `Content-Length` ceiling at 5 MB before parsing — anything
 *     larger returns 413 so the iOS client falls back to one workout
 *     per call.
 *   - Per-entry status (`inserted | duplicate | enriched | skipped`) so
 *     the iOS sync cursor can checkpoint accurately.
 *
 * Idempotency contract:
 *   - HTTP-level via `Idempotency-Key` (replays cached envelope).
 *   - Per-entry via the `@@unique([userId, source, externalId])`
 *     composite index. Re-posting the same batch surfaces duplicates
 *     rather than failing the call.
 *
 * Heart-rate series enrichment: a re-post that matches a stored
 * workout and carries a `samples` array attaches that series when the
 * workout has none. The workout row itself stays first-write-wins —
 * nothing on it is written, not one column — and a workout that already
 * holds a series is a no-op, so the client's history sweep is repeatable
 * as often as it likes. See the enrichment block below.
 *
 * Race reconciliation uses PostgreSQL's `INSERT ... RETURNING` through
 * Prisma's `createManyAndReturn`. The returned composite keys identify the
 * exact rows this request inserted, so per-entry statuses, child rows, and
 * arrival references cannot drift to a racing or same-external-id workout.
 *
 * Prompt-injection surface: `Workout.metadata` is opaque — the Coach
 * pipeline reads typed columns only (`sportType`, `durationSec`,
 * distance, HR). A future change that pulls metadata into the Coach
 * prompt must add deliberate escaping; the ingest path stores it raw.
 */
import { NextRequest } from "next/server";

import { prisma } from "@/lib/db";
import { apiHandler, isScopedCredential, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import {
  apiError,
  apiSuccess,
  getClientIp,
  safeJson,
} from "@/lib/api-response";
import { withIdempotency } from "@/lib/idempotency";
import { checkRateLimit } from "@/lib/rate-limit";
import { enqueuePrDetection } from "@/lib/jobs/pr-detection";
import { lockPersonalRecordsForUser } from "@/lib/personal-records/pr-detection-worker";
import { invalidateUserMeasurements } from "@/lib/cache/invalidate";
import { emitDataArrival } from "@/lib/arrivals/emit-shared";
import { MAX_WORKOUTS_PER_BATCH } from "@/lib/validations/workout";
import {
  INVALID_SAMPLES_REASON,
  parseWorkoutBatch,
} from "@/lib/workouts/batch-ingest-parse";
import {
  classifyExternalId,
  unstableExternalIdMeta,
  UNSTABLE_EXTERNAL_ID_REASON,
  type UnstableExternalIdShape,
} from "@/lib/validations/external-id";
import { dedupeWorkoutBatch } from "@/lib/workouts/canonical-rows";
import { WORKOUTS_WRITE_SCOPE } from "@/lib/workouts/scopes";
import { EXTERNAL_SOURCE } from "@/lib/measurements/external-source";
import { encryptRouteGeometry } from "@/lib/workouts/route-geometry-cipher";
import { Prisma, type MeasurementSource } from "@/generated/prisma/client";

// v1.4.25 W16c — push-suppression threshold for workout PRs. A batch
// larger than this fires the detection job with `silent: true` so a
// multi-year HKWorkout backfill doesn't spam the user with hundreds of
// pushes. Matches the measurements-batch threshold so behaviour stays
// uniform across both ingest paths.
const PR_DETECTION_SILENT_THRESHOLD = 50;

// v1.4.25 W10 reconcile (security H-2 parity): cap batch ingest at 60
// batches per user per minute. Healthy iOS sync drains its HealthKit
// observer queue in well under one batch per minute (the observer
// pattern coalesces); 60/min × 100 workouts/batch = 6 000 workouts/
// min headroom — generous for legitimate use, and a hard stop for a
// leaked wildcard token trying to saturate the write pipeline.
const BATCH_RATE_LIMIT_MAX = 60;
const BATCH_RATE_LIMIT_WINDOW_MS = 60 * 1000;

// 5 MB request-body ceiling (pre-existing). The route geometry is the
// largest tail in a workout payload; a typical batch sits comfortably
// under this, but the 20 000-point LineString cap combined with the
// 100-workout batch cap allows a theoretical tens-of-MB body for an
// extreme GPS-heavy backlog. Such a body returns 413 so the iOS client
// falls back to smaller / one-workout-per-call batches — which is also
// the correct response to a misbehaving client or an attempted DoS.
const MAX_BODY_BYTES = 5 * 1024 * 1024;

/**
 * Per-entry outcome the iOS client uses to advance its sync cursor.
 * `inserted`, `duplicate` and `enriched` all indicate the row landed (or
 * was already present); the client can checkpoint past them identically.
 * `enriched` additionally says the entry's heart-rate series was attached
 * to a workout that had none, which is what lets a history sweep count
 * its own progress. `skipped` covers entries the server refused: an
 * unusable external id, or a `samples` array that failed validation.
 * `updated` says a hand-entered workout (`manual:` id, source MANUAL) was
 * sent again with different values and the stored row now carries them.
 */
type EntryStatus =
  "inserted" | "duplicate" | "enriched" | "updated" | "skipped";

/** The workout columns a hand-entered workout's resubmit may overwrite. */
const MANUAL_OVERWRITE_FIELDS = [
  "sportType",
  "startedAt",
  "endedAt",
  "durationSec",
  "totalEnergyKcal",
  "totalDistanceM",
  "avgHeartRate",
  "maxHeartRate",
  "minHeartRate",
  "stepCount",
  "elevationM",
  "pauseDurationSec",
] as const;
type ManualOverwriteField = (typeof MANUAL_OVERWRITE_FIELDS)[number];
type ManualOverwriteValues = {
  [K in ManualOverwriteField]: string | number | Date | null;
};

/**
 * A workout entered by hand carries one id per form opening, and the form
 * resends it with the edited values when the person corrects a submit. Such a
 * resubmit is an edit of the stored row, the way a `stats:` measurement
 * re-post is. Every other id stays first-write-wins.
 */
function isManualOverwrite(source: unknown, externalId: string | null) {
  return (
    source === "MANUAL" &&
    externalId !== null &&
    externalId.startsWith("manual:")
  );
}

/** The changed columns of a manual resubmit, or null when nothing differs. */
function manualOverwriteChanges(
  stored: ManualOverwriteValues,
  sent: Prisma.WorkoutCreateManyInput,
): Partial<ManualOverwriteValues> | null {
  const changes: Partial<ManualOverwriteValues> = {};
  for (const field of MANUAL_OVERWRITE_FIELDS) {
    const next = (sent[field] ?? null) as string | number | Date | null;
    const prev = stored[field];
    const same =
      next instanceof Date && prev instanceof Date
        ? next.getTime() === prev.getTime()
        : next === prev;
    if (!same) changes[field] = next;
  }
  return Object.keys(changes).length > 0 ? changes : null;
}
interface EntryResult {
  index: number;
  status: EntryStatus;
  reason?: string;
}

/**
 * v1.31.1 — emit one data arrival per workout this batch actually inserted.
 *
 * `createManyAndReturn` gives the transaction the exact inserted ids. The
 * index-keyed map avoids a second lookup and keeps equal external ids from
 * different sources attached to their own workout.
 *
 * Fully best-effort — every failure path returns quietly. A reaction is never
 * worth failing an ingest that already succeeded.
 */
async function emitWorkoutArrivals(
  userId: string,
  prepared: ReadonlyArray<{
    index: number;
    row: Prisma.WorkoutCreateManyInput;
  }>,
  insertedIdByIndex: ReadonlyMap<number, string>,
): Promise<void> {
  for (const p of prepared) {
    const refId = insertedIdByIndex.get(p.index);
    if (!refId) continue;
    const startedAt =
      p.row.startedAt instanceof Date
        ? p.row.startedAt
        : new Date(p.row.startedAt as string);
    if (Number.isNaN(startedAt.getTime())) continue;
    await emitDataArrival({
      userId,
      kind: "workout",
      newestSampleAt: startedAt,
      insertedCount: 1,
      refId,
      source: "batch",
    });
  }
}

export const POST = apiHandler(withIdempotency<[NextRequest]>(postBatch));

async function postBatch(request: NextRequest): Promise<Response> {
  // Declares the workout-ingest scope, so a narrow `workouts:write` token
  // reaches this route alongside cookie sessions and the wildcard tokens a
  // native login mints. The only route that names it. `requireAuth` refuses
  // any acting-account carrier for every credential shape, so the scoped token
  // is confined to its owner's own record without an arm of its own here.
  const auth = await requireAuth(WORKOUTS_WRITE_SCOPE);
  const { user } = auth;

  // A scoped credential is a bridge, not the native client: the source of
  // its rows is resolved from the credential below rather than from the body.
  const scoped = isScopedCredential(auth);

  // v1.4.43 W9 — resolve the per-user source-priority blob once at
  // the start of the handler so the write-time canonical-row picker
  // walks the SAME ladder the read-time picker walks. Without this
  // lookup a user who customised Settings → Sources (e.g. MANUAL >
  // APPLE_HEALTH) would see their preferred row dropped at write-
  // time before the read-time picker ever ran. One indexed
  // findUnique per batch — well under the cost of letting the
  // duplicate persist and carrying it forward on every read.
  const userPriority = await prisma.user.findUnique({
    where: { id: user.id },
    select: { sourcePriorityJson: true },
  });

  // Content-Length pre-flight. The body cap exists to bound the
  // request-pipeline cost BEFORE Node has to read the full payload —
  // a misbehaving client shipping a 50 MB body shouldn't tie up the
  // worker for a parse it'd reject anyway. We trust the header here
  // because Next.js / undici populates it for any client that sets a
  // body length; for chunked uploads (no Content-Length) we fall
  // through and rely on the schema-level point / workout caps to keep
  // memory bounded.
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    const parsedLength = Number.parseInt(contentLength, 10);
    if (Number.isFinite(parsedLength) && parsedLength > MAX_BODY_BYTES) {
      annotate({
        action: { name: "workout.batch.ingest" },
        meta: { outcome: "payload_too_large", bytes: parsedLength },
      });
      return apiError(
        `Request body exceeds the ${MAX_BODY_BYTES}-byte limit`,
        413,
        { errorCode: "workout.batch.payload_too_large" },
      );
    }
  }

  // v1.4.25 W10 reconcile (security H-2 parity): per-user rate limit.
  // Without it, a leaked wildcard iOS token can sustain unbounded
  // writes (100 workouts/batch × N batches/sec) and degrade the
  // database for every other user on the host. 60 batches/min/user is
  // generous for healthy iOS sync and tight enough that a misbehaving
  // client bottoms out within a minute.
  //
  // A scoped `workouts:write` token is a bridge, not the phone, so it counts
  // in a bucket of its own: a bridge stuck in a retry loop must not use up
  // the allowance the iPhone app needs to sync the same account's workouts.
  // All bridge tokens of one account share that bucket, so minting more
  // tokens does not multiply the allowance.
  const rl = await checkRateLimit(
    scoped ? `workouts:batch:bridge:${user.id}` : `workouts:batch:${user.id}`,
    BATCH_RATE_LIMIT_MAX,
    BATCH_RATE_LIMIT_WINDOW_MS,
  );
  if (!rl.allowed) {
    annotate({
      action: { name: "workout.batch.ingest" },
      meta: { outcome: "rate_limited" },
    });
    return apiError("Too many batch submissions, try again later", 429);
  }

  // The Content-Length pre-flight above bounds the common case, but a
  // chunked upload carries no Content-Length. The `safeJson` body cap
  // backstops that gap: the raw text is measured before `JSON.parse`,
  // so an over-limit chunked body returns a clean 413 before the parse
  // cost. Reuses the same 5 MB ceiling — a typical iOS batch sits under
  // it; an extreme GPS-heavy backlog that exceeds it falls back to
  // smaller batches client-side.
  const { data: rawBody, error: jsonError } = await safeJson<unknown>(request, {
    maxBytes: MAX_BODY_BYTES,
  });
  if (jsonError) return jsonError;

  // Distinguish "too many entries" from "validation failed" so the
  // client surfaces a useful diagnostic. The cap stops a buggy client
  // from saturating the request pipeline; the iOS app paginates above
  // this threshold.
  if (
    typeof rawBody === "object" &&
    rawBody !== null &&
    "workouts" in rawBody &&
    Array.isArray((rawBody as { workouts: unknown }).workouts) &&
    (rawBody as { workouts: unknown[] }).workouts.length >
      MAX_WORKOUTS_PER_BATCH
  ) {
    return apiError(
      `Batch exceeds the ${MAX_WORKOUTS_PER_BATCH}-workout limit`,
      400,
      { errorCode: "workout.batch.too_large" },
    );
  }

  // Strict on every field, per-entry on `samples` alone — see
  // `parseWorkoutBatch` for why the series is the one field whose
  // failure must not take the rest of a history sweep down with it.
  const parsed = parseWorkoutBatch(rawBody);
  if (!parsed.ok) {
    return apiError(parsed.message, 400, {
      errorCode: "workout.batch.invalid",
    });
  }

  // A scoped credential may attribute nothing: its rows are `EXTERNAL`,
  // resolved from the credential. Refused loudly rather than relabelled, the
  // measurement batch's rule and for its reasons. `APPLE_HEALTH` is half the
  // `(userId, source, externalId)` dedup key the phone writes into and ranks
  // first in the cross-source picker, so a bridge naming it would land in the
  // phone's namespace and could shadow the phone's own copy of a session;
  // `MANUAL` would make a bridged workout indistinguishable from one entered
  // by hand. Checked on the raw body because the schema defaults an absent
  // `source` to `MANUAL`, which would make "named" and "omitted" look alike.
  if (scoped && namesAnySource(rawBody)) {
    annotate({
      action: { name: "workout.batch.ingest" },
      meta: { outcome: "source_not_permitted" },
    });
    return apiError(
      "This credential resolves the source itself; omit the field",
      422,
      { errorCode: "workout.batch.source_not_permitted" },
    );
  }

  const { workouts } = parsed.data;
  const refusedSampleIndices = new Set(parsed.refusedSampleIndices);

  // Pre-flight duplicate detection so we can return per-entry status.
  // The composite unique index is `(userId, source, externalId)` —
  // entries without an `externalId` cannot collide on the key (NULL-
  // distinct semantics), so they always insert as new rows.
  type Prepared = {
    index: number;
    row: Prisma.WorkoutCreateManyInput;
    route: {
      geometry: unknown;
      sampleTimestamps: unknown;
    } | null;
    /** Route-independent per-workout HR series. NULL when the entry
     *  ships no `samples` array. Persisted to the `WorkoutSamples`
     *  child by FK after the workout row lands. */
    samples: {
      samples: unknown;
      sampleCount: number;
    } | null;
    /** Composite-key probe for the pre-flight findMany. NULL when
     *  the entry has no externalId — those rows always pass through
     *  as "inserted" because the NULL-distinct unique index can never
     *  collide them. */
    dedupKey: { source: string; externalId: string } | null;
  };

  const results: EntryResult[] = new Array(workouts.length);
  const unstableShapes: UnstableExternalIdShape[] = [];
  const prepared: Prepared[] = workouts.flatMap((w, index) => {
    // An entry whose series failed validation is refused whole. Storing
    // the workout without the curve the caller asked us to keep would be
    // a silent loss, and the row may well already exist anyway.
    if (refusedSampleIndices.has(index)) {
      results[index] = {
        index,
        status: "skipped",
        reason: INVALID_SAMPLES_REASON,
      };
      return [];
    }

    // The `(userId, source, externalId)` dedup key is only idempotent
    // while the id is STABLE across client launches. An id that rotates
    // per process (an object description carrying a memory address)
    // never matches its own earlier row, so every re-sync mints another
    // workout. Refused per entry — one bad row must not stop the rest of
    // the batch landing.
    const unstable =
      w.externalId === undefined ? null : classifyExternalId(w.externalId);
    if (unstable) {
      unstableShapes.push(unstable);
      results[index] = {
        index,
        status: "skipped",
        reason: UNSTABLE_EXTERNAL_ID_REASON,
      };
      return [];
    }

    const durationSec = Math.max(
      0,
      Math.round((w.endedAt.getTime() - w.startedAt.getTime()) / 1000),
    );
    const route = w.route
      ? {
          geometry: w.route.geometry as unknown,
          sampleTimestamps: (w.route.sampleTimestamps ?? null) as unknown,
        }
      : null;
    const samples = w.samples
      ? {
          samples: w.samples as unknown,
          sampleCount: w.samples.length,
        }
      : null;
    const row: Prisma.WorkoutCreateManyInput = {
      userId: user.id,
      sportType: w.sportType,
      startedAt: w.startedAt,
      endedAt: w.endedAt,
      durationSec,
      totalEnergyKcal: w.totalEnergyKcal ?? null,
      totalDistanceM: w.totalDistanceM ?? null,
      avgHeartRate: w.avgHeartRate ?? null,
      maxHeartRate: w.maxHeartRate ?? null,
      minHeartRate: w.minHeartRate ?? null,
      stepCount: w.stepCount ?? null,
      elevationM: w.elevationM ?? null,
      pauseDurationSec: w.pauseDurationSec ?? null,
      // `EXTERNAL` under a scoped credential, and nothing else: the guard
      // above refused any body that named a source, so nothing asserted is
      // discarded here. It also moves the dedup key into its own namespace,
      // so a bridge's ids can never collide with the phone's.
      source: scoped ? EXTERNAL_SOURCE : w.source,
      externalId: w.externalId ?? null,
      externalSourceVersion: w.externalSourceVersion ?? null,
      metadata: w.metadata
        ? (w.metadata as Prisma.InputJsonValue)
        : Prisma.JsonNull,
    };
    return [
      {
        index,
        row,
        route,
        samples,
        dedupKey: w.externalId
          ? {
              source: scoped ? EXTERNAL_SOURCE : w.source,
              externalId: w.externalId,
            }
          : null,
      },
    ];
  });

  if (unstableShapes.length > 0) {
    annotate({
      meta: unstableExternalIdMeta("workout.batch", unstableShapes),
    });
  }

  // v1.4.42 W5 — write-time cross-source dedup. The v1.5 iOS app
  // drains a HealthKit observer queue that frequently carries the
  // SAME logical workout from two paired sensors (Apple Watch +
  // Withings ScanWatch). Without this pass, both rows persist (their
  // `externalId`s differ → the `(userId, source, externalId)` unique
  // index never fires) and the read-time canonical-picker has to
  // carry the duplicate forward on every dashboard render.
  //
  // The helper is pure (no Prisma, no user lookups). It groups by
  // `(userId, activityType, startedAt ± 90 s)`, prefers the canonical
  // source ladder (APPLE_HEALTH > WITHINGS > MANUAL > IMPORT), and
  // breaks ties on calories > earliest createdAt > input order. Rows
  // dropped here surface to the iOS client as `duplicate` so the
  // sync cursor advances past them identically to the externalId
  // case below.
  const canonicalPrepared = dedupeWorkoutBatch(
    prepared.map((p) => ({
      userId: p.row.userId,
      activityType: p.row.sportType,
      startedAt: p.row.startedAt as Date,
      // Zod's `measurementSourceEnum.optional().default("MANUAL")`
      // guarantees `source` is set post-parse, but Prisma's
      // `WorkoutCreateManyInput` types it optional. Default through
      // the same fallback the validator uses so the picker's source
      // ladder still resolves on the rare row where TypeScript
      // can't prove the union.
      source: (p.row.source ?? "MANUAL") as MeasurementSource,
      caloriesKcal: p.row.totalEnergyKcal ?? null,
      // No createdAt yet — the row is pre-insert; the tie-breaker
      // falls through to input order via the `index` field below.
      index: p.index,
    })),
    userPriority?.sourcePriorityJson ?? null,
  );
  const survivingIndices = new Set(canonicalPrepared.map((r) => r.index ?? -1));
  const droppedByWriteDedup: number[] = [];
  for (const p of prepared) {
    if (!survivingIndices.has(p.index)) {
      results[p.index] = { index: p.index, status: "duplicate" };
      droppedByWriteDedup.push(p.index);
    }
  }
  const survivors = prepared.filter((p) => survivingIndices.has(p.index));
  let duplicateCount = droppedByWriteDedup.length;
  let insertedCount = 0;
  let enrichedCount = 0;
  let updatedCount = 0;
  const insertedIdByIndex = new Map<number, string>();

  if (survivors.length > 0) {
    // v1.4.42 W5 — only the write-time dedup survivors are probed
    // against existing rows; the dropped twins already carry a
    // `duplicate` status and never reach the DB.
    const dedupCandidates = survivors
      .map((p) => p.dedupKey)
      .filter((k): k is { source: string; externalId: string } => k !== null);

    // The same probe answers both questions: does the row exist, and
    // does it already carry a series. `id` comes along so an enrichment
    // can address the stored workout without a second round trip.
    const existing = dedupCandidates.length
      ? await prisma.workout.findMany({
          where: {
            userId: user.id,
            OR: dedupCandidates.map((k) => ({
              source: k.source as Prisma.WorkoutCreateManyInput["source"],
              externalId: k.externalId,
            })),
          },
          select: {
            id: true,
            source: true,
            externalId: true,
            samples: { select: { workoutId: true } },
            sportType: true,
            startedAt: true,
            endedAt: true,
            durationSec: true,
            totalEnergyKcal: true,
            totalDistanceM: true,
            avgHeartRate: true,
            maxHeartRate: true,
            minHeartRate: true,
            stepCount: true,
            elevationM: true,
            pauseDurationSec: true,
          },
        })
      : [];

    const existingByKey = new Map<
      string,
      { id: string; hasSeries: boolean; values: ManualOverwriteValues }
    >();
    for (const row of existing) {
      if (row.externalId === null) continue;
      existingByKey.set(`${row.source}::${row.externalId}`, {
        id: row.id,
        hasSeries: row.samples !== null,
        values: {
          sportType: row.sportType,
          startedAt: row.startedAt,
          endedAt: row.endedAt,
          durationSec: row.durationSec,
          totalEnergyKcal: row.totalEnergyKcal,
          totalDistanceM: row.totalDistanceM,
          avgHeartRate: row.avgHeartRate,
          maxHeartRate: row.maxHeartRate,
          minHeartRate: row.minHeartRate,
          stepCount: row.stepCount,
          elevationM: row.elevationM,
          pauseDurationSec: row.pauseDurationSec,
        },
      });
    }

    const toInsert: Prepared[] = [];
    /** Stored workouts this batch hands a heart-rate series to. */
    const toEnrich: Array<{
      index: number;
      workoutId: string;
      samples: NonNullable<Prepared["samples"]>;
    }> = [];
    /** Hand-entered workouts this batch edits in place. */
    const toOverwrite: Array<{
      index: number;
      workoutId: string;
      externalId: string;
      changes: Partial<ManualOverwriteValues>;
    }> = [];
    /** Workouts already claimed by an earlier entry of THIS batch. */
    const enrichClaimed = new Set<string>();
    for (const p of survivors) {
      const keyTuple = p.dedupKey
        ? `${p.dedupKey.source}::${p.dedupKey.externalId}`
        : null;
      const known = keyTuple !== null ? existingByKey.get(keyTuple) : undefined;
      if (
        known &&
        p.dedupKey &&
        isManualOverwrite(p.dedupKey.source, p.dedupKey.externalId)
      ) {
        const changes = enrichClaimed.has(known.id)
          ? null
          : manualOverwriteChanges(known.values, p.row);
        if (changes) {
          enrichClaimed.add(known.id);
          toOverwrite.push({
            index: p.index,
            workoutId: known.id,
            externalId: p.dedupKey.externalId,
            changes,
          });
        } else {
          results[p.index] = { index: p.index, status: "duplicate" };
          duplicateCount += 1;
        }
      } else if (known) {
        if (p.samples && !known.hasSeries && !enrichClaimed.has(known.id)) {
          enrichClaimed.add(known.id);
          // Enrichment. The status is assigned after the write, because
          // a concurrent writer may get the series in first — in which
          // case this entry is the plain duplicate it always was. A
          // second entry of this batch naming the same workout takes the
          // duplicate arm above: one workout, one series, one `enriched`.
          toEnrich.push({
            index: p.index,
            workoutId: known.id,
            samples: p.samples,
          });
        } else {
          results[p.index] = { index: p.index, status: "duplicate" };
          duplicateCount += 1;
        }
      } else {
        results[p.index] = { index: p.index, status: "inserted" };
        toInsert.push(p);
      }
    }

    if (toInsert.length > 0 || toEnrich.length > 0 || toOverwrite.length > 0) {
      const CHUNK = 100;
      /** Workout ids whose series row this request actually wrote. */
      const seriesLanded = new Set<string>();
      /** Batch indices whose manual edit this request actually wrote. */
      const overwritten = new Set<number>();

      await prisma.$transaction(async (tx) => {
        // A hand-entered workout sent again with other values. Columns are
        // copied one by one from the validated entry; the records the old
        // values set go with them and the detection pass below re-derives
        // the honest best, as the DELETE does.
        if (toOverwrite.length > 0) {
          await lockPersonalRecordsForUser(tx, user.id);
        }
        for (const o of toOverwrite) {
          const data: Prisma.WorkoutUpdateManyMutationInput = {};
          for (const field of MANUAL_OVERWRITE_FIELDS) {
            if (field in o.changes) {
              (data as Record<string, unknown>)[field] = o.changes[field];
            }
          }
          const written = await tx.workout.updateMany({
            where: { id: o.workoutId, userId: user.id, source: "MANUAL" },
            data,
          });
          if (written.count === 1) {
            overwritten.add(o.index);
            await tx.personalRecord.deleteMany({
              where: {
                userId: user.id,
                source: "MANUAL",
                metricSlot: { not: null },
                externalId: o.externalId,
              },
            });
          }
        }

        const withExternalId = toInsert.filter((p) => p.dedupKey !== null);
        const withoutExternalId = toInsert.filter((p) => p.dedupKey === null);

        // PostgreSQL RETURNING is the only reliable way to identify the exact
        // winner when another request races the same unique key.
        for (let i = 0; i < withExternalId.length; i += CHUNK) {
          const slice = withExternalId.slice(i, i + CHUNK);
          const pendingByKey = new Map<string, Prepared[]>();
          for (const p of slice) {
            const key = `${p.dedupKey!.source}::${p.dedupKey!.externalId}`;
            const pending = pendingByKey.get(key);
            if (pending) pending.push(p);
            else pendingByKey.set(key, [p]);
          }

          const inserted = await tx.workout.createManyAndReturn({
            data: slice.map((p) => p.row),
            skipDuplicates: true,
            select: { id: true, source: true, externalId: true },
          });
          for (const row of inserted) {
            if (row.externalId === null) continue;
            const key = `${row.source}::${row.externalId}`;
            const preparedRow = pendingByKey.get(key)?.shift();
            if (preparedRow) insertedIdByIndex.set(preparedRow.index, row.id);
          }
        }

        // NULL external ids are intentionally distinct in PostgreSQL. Insert
        // them one at a time so a route/HR series can never attach to a
        // different otherwise-identical manual workout.
        for (const p of withoutExternalId) {
          const inserted = await tx.workout.createManyAndReturn({
            data: p.row,
            select: { id: true },
          });
          const row = inserted[0];
          if (row) insertedIdByIndex.set(p.index, row.id);
        }

        const routesToInsert: Prisma.WorkoutRouteCreateManyInput[] = [];
        const samplesToInsert: Prisma.WorkoutSamplesCreateManyInput[] = [];
        for (const p of toInsert) {
          const id = insertedIdByIndex.get(p.index);
          if (!id) continue;
          if (p.route) {
            routesToInsert.push({
              workoutId: id,
              // v1.39.4 — the GPS track is stored sealed only; the readable
              // `geometry` column stays NULL.
              geometryEncrypted: encryptRouteGeometry(p.route.geometry),
              sampleTimestamps:
                p.route.sampleTimestamps === null
                  ? Prisma.JsonNull
                  : (p.route.sampleTimestamps as Prisma.InputJsonValue),
            });
          }
          if (p.samples) {
            samplesToInsert.push({
              workoutId: id,
              samples: p.samples.samples as Prisma.InputJsonValue,
              sampleCount: p.samples.sampleCount,
            });
          }
        }

        // Enrichment rides the SAME child write as a fresh workout's
        // series — one mechanism, one place where a series is stored.
        // The only difference is where the `workoutId` came from: the
        // pre-flight probe instead of this request's INSERT ... RETURNING.
        // Nothing here writes to the workout row.
        for (const e of toEnrich) {
          samplesToInsert.push({
            workoutId: e.workoutId,
            samples: e.samples.samples as Prisma.InputJsonValue,
            sampleCount: e.samples.sampleCount,
          });
        }

        for (let i = 0; i < routesToInsert.length; i += CHUNK) {
          await tx.workoutRoute.createMany({
            data: routesToInsert.slice(i, i + CHUNK),
            skipDuplicates: true,
          });
        }
        for (let i = 0; i < samplesToInsert.length; i += CHUNK) {
          // RETURNING names the rows that actually landed. `workoutId` is
          // unique, so a workout that gained a series between the probe
          // and this write is skipped here and reports as a duplicate —
          // the re-post stays a no-op and never overwrites a stored curve.
          const landed = await tx.workoutSamples.createManyAndReturn({
            data: samplesToInsert.slice(i, i + CHUNK),
            skipDuplicates: true,
            select: { workoutId: true },
          });
          for (const row of landed) seriesLanded.add(row.workoutId);
        }
      });

      insertedCount = insertedIdByIndex.size;
      for (const p of toInsert) {
        if (insertedIdByIndex.has(p.index)) {
          results[p.index] = { index: p.index, status: "inserted" };
        } else {
          results[p.index] = { index: p.index, status: "duplicate" };
          duplicateCount += 1;
        }
      }

      // An enriched entry is still a duplicate of the workout row: the
      // top-level counters count rows, and no row was inserted for it.
      // The per-entry status carries what happened to the series.
      for (const e of toEnrich) {
        results[e.index] = {
          index: e.index,
          status: seriesLanded.has(e.workoutId) ? "enriched" : "duplicate",
        };
        if (seriesLanded.has(e.workoutId)) enrichedCount += 1;
        duplicateCount += 1;
      }

      // Like an enrichment, an edit inserts no row, so it counts towards
      // `duplicates`; the per-entry status says the stored row changed.
      for (const o of toOverwrite) {
        const landed = overwritten.has(o.index);
        results[o.index] = {
          index: o.index,
          status: landed ? "updated" : "duplicate",
        };
        if (landed) updatedCount += 1;
        duplicateCount += 1;
      }
    }
  }

  const skipped = results
    .filter((r) => r.status === "skipped")
    .map((r) => ({ index: r.index, reason: r.reason ?? "unknown" }));

  await auditLog("workout.batch.ingest", {
    userId: user.id,
    ipAddress: getClientIp(request),
    details: {
      processed: workouts.length,
      inserted: insertedCount,
      duplicates: duplicateCount,
      enriched: enrichedCount,
      updated: updatedCount,
      skipped: skipped.length,
    },
  });

  // v1.4.25 W16c — kick off PR detection for this user. Suppress push
  // notifications for historical-backfill batches so a multi-year
  // HKWorkout import doesn't fire hundreds of pushes during initial
  // sync. The detector also scans Measurement history on the same
  // pass, so a workout-only batch still surfaces measurement-side PRs
  // the user may have racked up since the last detection.
  if (insertedCount > 0 || duplicateCount > 0) {
    const silent = workouts.length > PR_DETECTION_SILENT_THRESHOLD;
    try {
      await enqueuePrDetection(user.id, { silent });
      await auditLog("personal_records.detection_enqueued", {
        userId: user.id,
        details: {
          source: "workout.batch",
          batchSize: workouts.length,
          silent,
        },
      });
    } catch (err) {
      annotate({
        action: { name: "personal_records.detection_enqueue_failed" },
        meta: { error: err instanceof Error ? err.message : String(err) },
      });
    }
  }

  // Counts only. The series itself never reaches a wide event.
  annotate({
    action: { name: "workout.batch.ingest" },
    meta: {
      processed: workouts.length,
      inserted: insertedCount,
      duplicates: duplicateCount,
      enriched: enrichedCount,
      updated: updatedCount,
      skipped: skipped.length,
    },
  });

  // v1.4.34 IW-G — bust per-user analytics + achievements + workouts
  // caches when at least one row landed. Workouts ride on the
  // measurements bucket because achievements / analytics also touch
  // workout-derived metrics.
  // An enrichment changes what the workout reads as — the detail seam
  // gains its curve, the list gains its glyph — so it busts the cache
  // too, even though no workout row was written.
  if (insertedCount > 0 || enrichedCount > 0 || updatedCount > 0) {
    invalidateUserMeasurements(user.id);
  }

  if (insertedCount > 0) {
    // One arrival per exact INSERT ... RETURNING winner. Historical rows still
    // stop at the shared salience classifier before any queue work.
    // An enrichment raises none: the workout arrived when it was stored.
    void emitWorkoutArrivals(user.id, prepared, insertedIdByIndex).catch(
      () => {},
    );
  }

  return apiSuccess({
    processed: workouts.length,
    inserted: insertedCount,
    duplicates: duplicateCount,
    skipped,
    entries: results,
  });
}

/** Whether any entry of a raw batch body names a `source` at all. */
function namesAnySource(rawBody: unknown): boolean {
  if (typeof rawBody !== "object" || rawBody === null) return false;
  const workouts = (rawBody as { workouts?: unknown }).workouts;
  if (!Array.isArray(workouts)) return false;
  return workouts.some(
    (w) =>
      typeof w === "object" &&
      w !== null &&
      (w as { source?: unknown }).source !== undefined,
  );
}
