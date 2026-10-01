/**
 * v1.17.0 (F4) — Oura Cloud v2 sync.
 *
 * Pulls daily readiness (→ RECOVERY_SCORE + BODY_TEMPERATURE_DEVIATION), sleep
 * (real per-segment hypnogram timeline when present, else per-stage totals;
 * efficiency, HRV, RHR, respiratory rate), daily activity (steps, active
 * energy, equivalent walking distance), the daily Sleep Score (→ SLEEP_SCORE),
 * daily SpO2 (→ OXYGEN_SATURATION), the dedicated vO2_max collection (→
 * VO2_MAX), and the daily cardiovascular-age estimate (→ VASCULAR_AGE) for one
 * connected user, mapping each into `Measurement` rows tagged `source = OURA`.
 *
 * daily_stress → STRESS_SCORE is deferred: STRESS_SCORE already has an
 * HRV-derived COMPUTED producer that is not yet wired into the source-priority
 * ladder or the weekly graded-series collapse, so a second producer here would
 * double-count nondeterministically. Re-add once STRESS_SCORE is laddered.
 *
 * daily_resilience → RESILIENCE (v1.19.0): the daily resilience LEVEL (limited /
 * adequate / solid / strong / exceptional) is ordinal-encoded (limited=1 …
 * exceptional=5) into the numeric `value` — no new categorical column. An
 * unknown / missing level mints no row. See `RESILIENCE_LEVELS` in `./client`.
 *
 * Token model: Oura uses refresh tokens. The merged schema has no expiry
 * column, so the sync refreshes REACTIVELY — the first read that 401s triggers
 * one refresh (persisting BOTH rotated tokens) and a single retry. A failed
 * refresh (`invalid_grant`) records `reauth_required` on the `oura` ledger.
 *
 * Idempotency: `externalId = <resource>:<day>:<fieldTag>` for the day-keyed
 * collections; sleep rows carry a record-scoped `sleep:<record-id>:<fieldTag>`
 * key (per-segment timeline + nightly scalars) so a nap and the main sleep on
 * one day stay distinct instead of overwriting each other (B2). The shared
 * reconciler protects both external and natural identity. Oura finalises a
 * day's scores after the night, so an exact re-post overwrites in place.
 *
 * The measurement-write tail mirrors the shared WHOOP / Nightscout sync tail.
 */
import { prisma } from "@/lib/db";
import type { MeasurementType } from "@/generated/prisma/client";
import { getEvent } from "@/lib/logging/context";
import {
  markSyncFailureRecorded,
  recordSyncFailure,
  recordSyncSuccess,
  toFailureKind,
  type FailureKind,
} from "@/lib/integrations/status";
import {
  collapseToTypeDayKeys,
  recomputeBucketsForMeasurement,
} from "@/lib/rollups/measurement-rollups";
import {
  emitInsertedMeasurementArrivals,
  type InsertedMeasurementArrivalRow,
} from "@/lib/arrivals/measurement-emit";
import { invalidateUserMeasurements } from "@/lib/cache/invalidate";
import { invalidateStatusInsightsForTypes } from "@/lib/insights/comprehensive-generate";
import type { SyncWriteResult } from "@/lib/outcome/written-outcome";
import { maybeEnqueueMorningRefresh } from "@/lib/daily/morning-refresh-trigger";
import {
  sweepStaleSleepSegments,
  type SleepSegmentSweep,
} from "@/lib/sleep/sweep-stale-segments";
import {
  MeasurementReconciliationError,
  reconcileExternalMeasurement,
} from "@/lib/measurements/reconcile-external-measurement";
import {
  fetchCardiovascularAge,
  fetchDailyActivity,
  fetchDailySleep,
  fetchDailySpo2,
  fetchReadiness,
  fetchResilience,
  fetchSleep,
  fetchVo2Max,
  mapCardiovascularAge,
  mapDailyActivity,
  mapDailySleep,
  mapDailySpo2,
  mapReadiness,
  mapResilience,
  mapSleep,
  mapVo2Max,
  refreshAccessToken,
  type MappedMeasurement,
} from "./client";
import {
  getOuraClientCredentials,
  getOuraConnection,
  storeOuraTokens,
} from "./credentials";
import { OuraApiError, classifyOuraError } from "./response-classifier";
import { syncUserOuraCyclePhases } from "./cycle-sync";
import { shiftDateKey, userDayKey } from "@/lib/tz/format";
import { resolveUserTimezone } from "@/lib/tz/resolver";

/** Floor of the lookback window (days) for an incremental sync. Oura finalises
 * a night's scores hours after wake; 7 days re-fetches a handful of records
 * (the upserts are idempotent) and covers the re-score tail. */
export const OURA_SYNC_LOOKBACK_DAYS = 7;

/**
 * Ceiling of the lookback window (days). A catch-up tick may widen the window
 * up to this many days; beyond it the missing span is history, not an outage,
 * and belongs to a backfill rather than an hourly poll.
 *
 * 30 rather than the ~90 days Oura's own guidance would allow: the whole batch
 * still rides ONE `$transaction` with a 60 s timeout (see
 * `upsertOuraMeasurements` below), and a 30-day catch-up is roughly four times
 * the row count of a normal tick — comfortably inside what that transaction
 * handles. Raise it only after the batch write is chunked.
 */
export const OURA_SYNC_MAX_LOOKBACK_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Resolve how far back this tick should reach, anchored on the newest Oura
 * measurement we actually hold.
 *
 * The fixed 7-day window lost days in two ways. A sync that failed for longer
 * than a week resumed with a window too narrow to reach the gap, so the missing
 * days stayed missing. And a ring left unsynced (Oura's cloud has nothing until
 * the app is opened) produced a run of EMPTY successes — every signal green —
 * after which the late-arriving days fell outside the window and were never
 * imported.
 *
 * Anchoring on the newest imported row covers both: rows stop arriving whether
 * the sync fails or succeeds empty, so the same watermark goes stale in either
 * case. It is derived, never stored, so it cannot drift out of step with the
 * data the way a persisted cursor can — the watermark IS the data.
 *
 * `deletedAt: null` matters: the sleep sweep soft-deletes rows a revised
 * hypnogram orphaned, and a tombstone must not hold the watermark artificially
 * fresh. The `+ 1` day is the overlap buffer over the last seen day. With data
 * flowing normally the watermark is under two days old and the clamp floors at
 * `OURA_SYNC_LOOKBACK_DAYS`, so the steady-state window and request count are
 * exactly what they were before. No watermark at all is a fresh connection:
 * take the full ceiling.
 */
export async function resolveOuraLookbackDays(userId: string): Promise<number> {
  const newest = await prisma.measurement.findFirst({
    where: { userId, source: "OURA", deletedAt: null },
    orderBy: { measuredAt: "desc" },
    select: { measuredAt: true },
  });
  if (!newest) return OURA_SYNC_MAX_LOOKBACK_DAYS;

  const daysSince = Math.floor(
    (Date.now() - newest.measuredAt.getTime()) / DAY_MS,
  );
  return Math.min(
    OURA_SYNC_MAX_LOOKBACK_DAYS,
    Math.max(OURA_SYNC_LOOKBACK_DAYS, daysSince + 1),
  );
}

export function classifyOuraFailure(err: unknown): FailureKind {
  return toFailureKind(classifyOuraError(err));
}

/**
 * Record a whole-connection Oura sync failure on the shared `oura` ledger with
 * the correct classification + HTTP code. Extracted so the poll-cohort boundary
 * can record a future escape with the SAME provider-owned classification the
 * inline catch already applies.
 */
export async function recordOuraSyncFailure(
  userId: string,
  err: unknown,
): Promise<void> {
  await recordSyncFailure({
    userId,
    integration: "oura",
    kind: classifyOuraFailure(err),
    message: err instanceof Error ? err.message : String(err),
    errorCode:
      err instanceof OuraApiError && err.httpStatus != null
        ? String(err.httpStatus)
        : undefined,
  });
}

function ymd(d: Date): string {
  // eslint-disable-next-line healthlog/no-utc-day-key -- baseline: request window edge for the provider API, not a displayed day; rows carry their own dates
  return d.toISOString().slice(0, 10);
}

export interface OuraMeasurementUpsert {
  type: string;
  value: number;
  unit: string;
  measuredAt: Date;
  externalId: string;
  sleepStage?: "CORE" | "DEEP" | "REM" | "AWAKE" | null;
}

function toUpsert(
  mapped: MappedMeasurement[],
  resourcePrefix: string,
  dateOnlyDay?: string,
): OuraMeasurementUpsert[] {
  return mapped.map((m) => ({
    type: m.type,
    value: m.value,
    unit: m.unit,
    measuredAt: m.measuredAt,
    // A mapper that needs a record-scoped key (sleep rows — per-segment timeline
    // + nightly scalars) carries its own externalId; everything else falls back
    // to the day-keyed `<resource>:<day>:<fieldTag>` shape. A record with no
    // instant of its own (`dateOnlyDay`) keys on its date: its row sits at
    // local noon in the user's zone, which east of UTC+12 is the previous UTC
    // date. A timed record keys on its instant's UTC date, as it always has.
    externalId:
      m.externalId ??
      `${resourcePrefix}:${dateOnlyDay ?? ymd(m.measuredAt)}:${m.fieldTag}`,
    sleepStage: m.sleepStage ?? null,
  }));
}

/** One Oura collection: its ledger name and a self-contained fetch+map closure
 * that resolves to the collection's mapped upserts. Each closure owns its own
 * client call and mapper so a throw is contained to this one collection. */
interface OuraCollectionSpec {
  name: string;
  collect: (token: string) => Promise<OuraMeasurementUpsert[]>;
}

/** A single collection that failed to fetch/map, carried so the caller can
 * classify + record the failure without blanking the collections that did
 * succeed. */
export interface OuraCollectionFailure {
  name: string;
  err: unknown;
}

export interface OuraFetchResult {
  readings: OuraMeasurementUpsert[];
  failures: OuraCollectionFailure[];
  /**
   * One sweep entry per fetched sleep record (`sleep:<record-id>:` prefix +
   * that record's fresh SLEEP_DURATION externalIds). Drives the record-scoped
   * cleanup of rows a revised hypnogram orphaned — including every legacy
   * run-indexed `seg:<i>` row — before the fresh set upserts.
   */
  sleepSweeps: SleepSegmentSweep[];
}

/**
 * Fetch every Oura daily collection for a user with a single reactive
 * refresh-on-401 retry, ISOLATED per collection. Unlike a bare `Promise.all`,
 * one flaky endpoint or one throwing mapper no longer rejects the whole batch
 * (which used to blank readiness, sleep, activity, spo2 all at once). Each
 * collection is settled independently (`Promise.allSettled`); the ones that
 * succeed import, the ones that throw are returned as `failures` for the caller
 * to record — mirroring Google Health's / Fitbit's per-collection hard-fail
 * ledger.
 *
 * The reactive refresh is preserved: because every collection shares one access
 * token, an expired token 401s all of them together; a single refresh is done
 * once and ONLY the failed collections are retried with the rotated token. A
 * failed refresh (`invalid_grant`) still throws so the caller parks the whole
 * connection at `reauth_required`.
 */
async function fetchAll(
  userId: string,
  accessToken: string,
  refreshToken: string,
  refreshTokenCiphertext: string,
  lookbackDays: number,
): Promise<OuraFetchResult> {
  // Oura keys its daily collections by the user's calendar date, so the
  // window is cut on the user's own days, and date-only records are anchored
  // at local noon of their date in this zone.
  const tz = await resolveUserTimezone(userId);
  const today = userDayKey(new Date(), tz);
  const query = {
    startDate: shiftDateKey(today, -lookbackDays),
    endDate: today,
  };

  // Filled by the sleep collection's closure as it maps records; carried on
  // the result so the caller can run the record-scoped sweep before the
  // upsert. A collection that throws pushes nothing (the fetch is its first
  // await), so a 401-retry cannot double-enter a record.
  const sleepSweeps: SleepSegmentSweep[] = [];

  const collections: OuraCollectionSpec[] = [
    {
      name: "readiness",
      collect: async (t) =>
        (await fetchReadiness(t, query)).flatMap((r) =>
          toUpsert(
            mapReadiness(r, tz),
            "readiness",
            r.timestamp ? undefined : r.day,
          ),
        ),
    },
    {
      name: "sleep",
      collect: async (t) => {
        const records = await fetchSleep(t, query);
        const ups: OuraMeasurementUpsert[] = [];
        for (const s of records) {
          const rows = toUpsert(
            mapSleep(s, tz),
            "sleep",
            s.bedtime_end ? undefined : s.day,
          );
          ups.push(...rows);
          // Record-scoped sweep entry: every SLEEP_DURATION row of this
          // record keys under `sleep:<id>:` (hypnogram runs AND the
          // stage-total fallback), so the prefix bounds the cleanup to this
          // one record. Clears whatever a revised hypnogram orphaned —
          // shifted run boundaries, legacy run-indexed `seg:<i>` rows, and a
          // stale stage-total set once the hypnogram appears.
          sleepSweeps.push({
            prefix: `sleep:${s.id}:`,
            keepIds: rows
              .filter((r) => r.type === "SLEEP_DURATION")
              .map((r) => r.externalId),
          });
        }
        return ups;
      },
    },
    {
      name: "activity",
      collect: async (t) =>
        (await fetchDailyActivity(t, query)).flatMap((a) =>
          toUpsert(
            mapDailyActivity(a, tz),
            "activity",
            a.timestamp ? undefined : a.day,
          ),
        ),
    },
    {
      name: "daily_sleep",
      collect: async (t) =>
        (await fetchDailySleep(t, query)).flatMap((d) =>
          toUpsert(
            mapDailySleep(d, tz),
            "daily_sleep",
            d.timestamp ? undefined : d.day,
          ),
        ),
    },
    {
      name: "spo2",
      collect: async (t) =>
        (await fetchDailySpo2(t, query)).flatMap((s) =>
          toUpsert(mapDailySpo2(s, tz), "spo2", s.day),
        ),
    },
    {
      name: "vo2max",
      collect: async (t) =>
        (await fetchVo2Max(t, query)).flatMap((v) =>
          toUpsert(mapVo2Max(v, tz), "vo2max", v.timestamp ? undefined : v.day),
        ),
    },
    {
      name: "cardio_age",
      collect: async (t) =>
        (await fetchCardiovascularAge(t, query)).flatMap((c) =>
          toUpsert(mapCardiovascularAge(c, tz), "cardio_age", c.day),
        ),
    },
    {
      name: "resilience",
      collect: async (t) =>
        (await fetchResilience(t, query)).flatMap((r) =>
          toUpsert(mapResilience(r, tz), "resilience", r.day),
        ),
    },
  ];

  // Run a set of collections isolated from one another. A rejection is captured
  // per-collection, never propagated, so siblings still resolve.
  const attempt = async (
    token: string,
    specs: OuraCollectionSpec[],
  ): Promise<{
    readings: OuraMeasurementUpsert[];
    failed: OuraCollectionSpec[];
    failures: OuraCollectionFailure[];
    auth401: boolean;
  }> => {
    const settled = await Promise.allSettled(
      specs.map((spec) => spec.collect(token)),
    );
    const readings: OuraMeasurementUpsert[] = [];
    const failed: OuraCollectionSpec[] = [];
    const failures: OuraCollectionFailure[] = [];
    let auth401 = false;
    settled.forEach((res, i) => {
      const spec = specs[i]!;
      if (res.status === "fulfilled") {
        readings.push(...res.value);
      } else {
        const err = res.reason;
        if (err instanceof OuraApiError && err.httpStatus === 401)
          auth401 = true;
        failed.push(spec);
        failures.push({ name: spec.name, err });
      }
    });
    return { readings, failed, failures, auth401 };
  };

  const first = await attempt(accessToken, collections);
  if (!first.auth401) {
    return { readings: first.readings, failures: first.failures, sleepSweeps };
  }

  // Reactive refresh: the access token expired (a 401 on the shared token).
  // Refresh once (rotating both tokens) and retry ONLY the collections that
  // failed. A failed refresh throws so the caller parks reauth_required.
  const creds = await getOuraClientCredentials(userId);
  if (!creds)
    return { readings: first.readings, failures: first.failures, sleepSweeps };

  const rotated = await refreshAccessToken(refreshToken, creds);
  // Compare-and-swap persist: on a lost race against a concurrent sync this
  // returns the peer's freshly rotated access token rather than the (now
  // invalidated) one we just minted, so neither sync parks the connection.
  const usableToken = await storeOuraTokens(
    userId,
    rotated.access_token,
    rotated.refresh_token,
    refreshTokenCiphertext,
  );
  if (!usableToken)
    return { readings: first.readings, failures: first.failures, sleepSweeps };

  const retry = await attempt(usableToken, first.failed);
  return {
    readings: [...first.readings, ...retry.readings],
    failures: retry.failures,
    sleepSweeps,
  };
}

/**
 * Sync one user's Oura data.
 *
 * `imported` is the count of measurement rows written; `failed` is true when a
 * collection did not settle. The count used to be the whole return value,
 * which hid the partial: a run where every collection failed answered `0`, the
 * same as a run that found nothing new, and the settings card reported both as
 * a success. A user with no Oura connection is a clean no-op (nothing
 * imported, nothing failed, no status row touched).
 */
export async function syncUserOura(
  userId: string,
  opts: { lookbackDays?: number } = {},
): Promise<SyncWriteResult> {
  const conn = await getOuraConnection(userId);
  if (!conn) return { imported: 0, failed: false };

  // An explicit window from the caller wins; otherwise derive it from what we
  // already hold so a gap widens the window instead of being skipped over.
  const lookbackDays =
    opts.lookbackDays ?? (await resolveOuraLookbackDays(userId));

  let result: OuraFetchResult;
  try {
    result = await fetchAll(
      userId,
      conn.accessToken,
      conn.refreshToken,
      conn.refreshTokenCiphertext,
      lookbackDays,
    );
  } catch (err) {
    // Only a whole-connection failure (a failed token refresh → reauth) reaches
    // here now; per-collection failures are captured on `result.failures`.
    // Recorded here, then marked so the poll-cohort boundary does not
    // double-record it when it surfaces there.
    await recordOuraSyncFailure(userId, err);
    throw markSyncFailureRecorded(err);
  }

  // Clear whatever an earlier scoring left under the re-fetched sleep records
  // before the fresh set upserts (mirrors Google Health's replace-by-window
  // order). Best-effort inside the helper — a sweep failure never fails the
  // sync; the record stays inside the lookback window, so the next tick
  // retries it.
  await sweepStaleSleepSegments(userId, "OURA", result.sleepSweeps);

  // Import everything the healthy collections returned regardless of whether a
  // sibling collection failed — one bad collection must not blank the source.
  let insertedSleepMeasuredAts: Date[] = [];
  const imported = await upsertOuraMeasurements(userId, result.readings, {
    onInserted: (rows) => {
      insertedSleepMeasuredAts = rows
        .filter((row) => row.type === "SLEEP_DURATION")
        .map((row) => row.measuredAt);
    },
  });

  // v1.29.x — best-effort Cycle Insights import. Fully isolated from the
  // measurement sync's status ledger on purpose: `daily_cycle_phases` sits
  // outside the scope most self-registered Oura apps are granted (see the
  // `OuraCyclePhase` docstring in `./client`), so a 403/404 here is the
  // COMMON case for a typical connection. Re-reads the connection so a
  // reactive refresh `fetchAll` just performed is picked up rather than the
  // (now possibly stale) token captured before it ran.
  try {
    const freshConn = await getOuraConnection(userId);
    if (freshConn) {
      const cycleToday = userDayKey(
        new Date(),
        await resolveUserTimezone(userId),
      );
      await syncUserOuraCyclePhases(userId, freshConn.accessToken, {
        startDate: shiftDateKey(cycleToday, -lookbackDays),
        endDate: cycleToday,
      });
    }
  } catch (err) {
    getEvent()?.addWarning(
      `oura: cycle-phases import skipped for ${userId}: ${err}`,
    );
  }

  // S4 — trigger the debounced morning refresh on a last-night segment landing
  // (mirrors the Withings / WHOOP / Apple seams). Fires whether or not a
  // sibling collection failed, since the sleep readings were still imported.
  void maybeEnqueueMorningRefresh(userId, insertedSleepMeasuredAts).catch(
    () => {},
  );

  // Background-sync posture: mark the analytics cells stale (never hard-evict
  // from a poll) so the imported rows reach the cached readers. Fires on a
  // partial failure too — rows that DID land must not stay invisible for the
  // rest of the TTL window.
  if (imported > 0) {
    invalidateUserMeasurements(userId);
  }

  if (result.failures.length > 0) {
    // Partial failure: keep the cycle honest. Record the failure and do NOT
    // stamp success, so the freshness surface reflects that some collections
    // are behind and the next tick refetches them, rather than showing green.
    const firstErr = result.failures[0]!.err;
    getEvent()?.addWarning(
      `oura: ${result.failures.length} collection(s) failed for ${userId}: ${result.failures
        .map((f) => f.name)
        .join(", ")}`,
    );
    await recordSyncFailure({
      userId,
      integration: "oura",
      kind: classifyOuraFailure(firstErr),
      message: `partial sync failure (${result.failures
        .map((f) => f.name)
        .join(", ")}): ${
        firstErr instanceof Error ? firstErr.message : String(firstErr)
      }`,
      errorCode:
        firstErr instanceof OuraApiError && firstErr.httpStatus != null
          ? String(firstErr.httpStatus)
          : undefined,
    });
    return { imported, failed: true };
  }

  await recordSyncSuccess(userId, "oura");
  return { imported, failed: false };
}

export async function upsertOuraMeasurements(
  userId: string,
  readings: OuraMeasurementUpsert[],
  opts: {
    onInserted?: (rows: InsertedMeasurementArrivalRow[]) => void;
  } = {},
): Promise<number> {
  if (readings.length === 0) return 0;

  let imported = 0;
  const touched: Array<{ type: MeasurementType; measuredAt: Date }> = [];
  const insertedRows: Array<
    InsertedMeasurementArrivalRow & { externalId: string | null }
  > = [];

  const verdicts = await prisma.$transaction(
    async (tx) => {
      const outcomes = [];
      for (const r of readings) {
        const verdict = await reconcileExternalMeasurement(
          tx,
          {
            userId,
            type: r.type as MeasurementType,
            source: "OURA",
            value: r.value,
            unit: r.unit,
            measuredAt: r.measuredAt,
            externalId: r.externalId,
            sleepStage: r.sleepStage ?? null,
          },
          { exactExternalMatch: "update" },
        );
        if (verdict.status === "failed") {
          throw new MeasurementReconciliationError(verdict);
        }
        outcomes.push(verdict);
      }
      return outcomes;
    },
    { timeout: 60_000 },
  );

  for (let index = 0; index < readings.length; index++) {
    const reading = readings[index]!;
    const verdict = verdicts[index]!;
    // Refused by the plausibility gate: nothing was written and nothing was
    // touched, so the reading counts as neither imported nor a rollup dirt
    // mark. The drop is already on the wide event.
    if (verdict.status === "rejected_range") continue;
    for (const dirty of verdict.dirtyIdentities ?? []) {
      touched.push(dirty);
    }
    const type = reading.type as MeasurementType;
    imported++;
    touched.push({ type, measuredAt: reading.measuredAt });
    if (verdict.status === "inserted") {
      insertedRows.push(verdict.row);
    }
  }

  opts.onInserted?.(insertedRows);
  void emitInsertedMeasurementArrivals(userId, insertedRows, "oura").catch(
    () => {},
  );
  try {
    const keys = collapseToTypeDayKeys(touched);
    for (const k of keys) {
      await recomputeBucketsForMeasurement(userId, k.type, k.measuredAt);
    }
    invalidateStatusInsightsForTypes(
      userId,
      keys.map((k) => k.type),
    ).catch((err) => {
      getEvent()?.addWarning(
        `oura: status-insight invalidate failed for ${userId}: ${err}`,
      );
    });
  } catch (err) {
    getEvent()?.addWarning(
      `oura: rollup recompute failed for ${userId}: ${err}`,
    );
  }

  return imported;
}
