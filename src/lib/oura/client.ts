/**
 * v1.17.0 (F4) — Oura Cloud API v2 client for OAuth + data fetching.
 * Docs: https://cloud.ouraring.com/v2/docs (re-verify at build).
 *
 * Mirrors the WHOOP / Polar client structure: hand-rolled fetch over
 * `safeFetch` (no SDK), an OAuth handshake (`getAuthorizationUrl` /
 * `exchangeCode` / `refreshAccessToken`), typed v2 collection fetchers with
 * `next_token` pagination, and a single source-of-truth field→Measurement
 * mapping.
 *
 * Oura specifics: standard authorization-code OAuth WITH refresh tokens (the
 * sync layer refreshes on 401, persisting BOTH rotated tokens). The token
 * endpoint takes client_id/secret in the body (client_secret_post) and lives
 * on moi.ouraring.com, with the documented api.ouraring.com endpoint as a
 * fallback for older apps. Collections are read by
 * `start_date` / `end_date` (YYYY-MM-DD) and page via `next_token`.
 */
import { getEvent } from "@/lib/logging/context";
import { canonicalDailyTimestamp } from "@/lib/measurements/consolidation-tz";
import { dayDiff } from "@/lib/cycle/day-math";
import { safeFetch } from "@/lib/safe-fetch";
import { OuraApiError, classifyOuraResponse } from "./response-classifier";
import { envOr, envValue } from "@/lib/env";

const OURA_API_BASE = "https://api.ouraring.com";
const OURA_OAUTH_AUTH_URL = "https://cloud.ouraring.com/oauth/authorize";

/**
 * Oura's live token endpoint. Apps created in the current developer portal
 * get their codes from this authorization server (the callback carries
 * `iss=https://moi.ouraring.com/oauth/v2/ext/oauth-anonymous`), and the
 * documented `api.ouraring.com/oauth/token` answers those codes with
 * `400 invalid_request`. Older apps are served here too.
 */
export const OURA_OAUTH_TOKEN_URL =
  "https://moi.ouraring.com/oauth/v2/ext/oauth-token";

/**
 * The documented endpoint, kept only as a fallback for the older apps the
 * live endpoint turns away. Never tried first for a code: an authorization
 * code works once (RFC 6749 4.1.2), so a rejected first attempt would burn
 * it before the right endpoint saw it.
 */
export const OURA_OAUTH_LEGACY_TOKEN_URL =
  "https://api.ouraring.com/oauth/token";

/** The origin of Oura's current authorization server. */
const OURA_MOI_ORIGIN = "https://moi.ouraring.com";

/**
 * Authorization-server origins an `iss` callback parameter may name
 * (RFC 9207). Anything else is a mix-up and refused.
 */
const OURA_ISSUER_ORIGINS = new Set([
  OURA_MOI_ORIGIN,
  "https://cloud.ouraring.com",
  "https://api.ouraring.com",
]);

/**
 * Check the `iss` the authorization server sent with the callback. Absent is
 * fine (older apps never send one); present, it must name one of Oura's own
 * authorization servers.
 */
export function isAcceptedOuraIssuer(iss: string | null): boolean {
  if (iss === null) return true;
  try {
    const url = new URL(iss);
    return url.protocol === "https:" && OURA_ISSUER_ORIGINS.has(url.origin);
  } catch {
    return false;
  }
}

/** True when the code was issued by the current authorization server. */
function issuedByMoi(iss: string | null | undefined): boolean {
  if (!iss) return false;
  try {
    return new URL(iss).origin === OURA_MOI_ORIGIN;
  } catch {
    return false;
  }
}

export interface OuraCredentials {
  clientId: string;
  clientSecret: string;
}

/**
 * Env-configured shared OAuth credentials — the FALLBACK app used when a user
 * has not registered their own BYO Oura client id/secret. As of v1.17.1 the
 * per-user resolver `getOuraClientCredentials` (DB-first) is the primary path
 * and calls this only when no per-user pair is stored.
 */
export function getOuraCredentials(): OuraCredentials | null {
  const clientId = process.env.OURA_CLIENT_ID;
  const clientSecret = process.env.OURA_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

export function getOuraRedirectUri(): string {
  // An empty or blank value counts as unset (the compose whitelist
  // materialises an unset var as an empty string).
  return envOr(
    "OURA_REDIRECT_URI",
    `${envValue("NEXT_PUBLIC_APP_URL")}/api/oura/callback`,
  );
}

/** `daily` covers sleep / readiness / activity; `personal` is profile info. */
export const OURA_OAUTH_SCOPE = "daily personal" as const;

export function getAuthorizationUrl(
  state: string,
  creds: OuraCredentials,
): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: creds.clientId,
    redirect_uri: getOuraRedirectUri(),
    scope: OURA_OAUTH_SCOPE,
    state,
  });
  return `${OURA_OAUTH_AUTH_URL}?${params}`;
}

export interface OuraTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type?: string;
  scope?: string;
}

interface TokenAttempt {
  status: number;
  json: unknown;
}

async function requestToken(
  url: string,
  params: URLSearchParams,
  verb: string,
): Promise<TokenAttempt> {
  const start = performance.now();
  const res = await safeFetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: params.toString(),
  });
  const json: unknown = await res.json().catch(() => null);
  const verdict = classifyOuraResponse(res.status);
  getEvent()?.addExternalCall({
    service: "oura",
    method: verb,
    duration_ms: Math.round(performance.now() - start),
    status: res.status,
    error: verdict.classification === "success" ? undefined : verdict.reason,
  });
  return { status: res.status, json };
}

function upstreamError(json: unknown): string | undefined {
  if (json === null || typeof json !== "object") return undefined;
  const error = (json as { error?: unknown }).error;
  return typeof error === "string" ? error : undefined;
}

/**
 * Whether the legacy endpoint is worth asking after the live one refused:
 * a 400, 401 or 404. The live endpoint may not know an older app's client,
 * code or refresh token at all, and its refusal does not tell "unknown here"
 * apart from "bad grant" reliably, so every such refusal gets the one retry.
 * Server errors and rate limits do not: they say nothing about the grant.
 */
const FALLBACK_STATUSES = new Set([400, 401, 404]);

function belongsElsewhere(attempt: TokenAttempt): boolean {
  return FALLBACK_STATUSES.has(attempt.status);
}

function tokenResult(attempt: TokenAttempt, verb: string): OuraTokenResponse {
  const verdict = classifyOuraResponse(attempt.status);
  if (verdict.classification !== "success") {
    throw new OuraApiError({
      verb,
      classification: verdict.classification,
      httpStatus: verdict.httpStatus,
      reason: verdict.reason,
      upstreamError: upstreamError(attempt.json),
    });
  }
  // A 2xx with an empty or non-JSON body (captive portal, gateway 200, 204)
  // leaves `json` null. Casting it straight to the token type handed callers a
  // null they then dereferenced, surfacing an unclassified TypeError instead of
  // a handled integration error. Narrow explicitly and classify as transient.
  if (attempt.json === null || typeof attempt.json !== "object") {
    throw new OuraApiError({
      verb,
      classification: "transient",
      httpStatus: attempt.status,
      reason: "empty_token_body",
    });
  }
  return attempt.json as OuraTokenResponse;
}

/**
 * Ask the live endpoint, then the legacy one when `mayFallBack` allows it and
 * the live endpoint refused with 400, 401 or 404. The legacy endpoint is
 * never asked first.
 */
async function postToken(
  params: URLSearchParams,
  verb: string,
  mayFallBack: boolean,
): Promise<OuraTokenResponse> {
  const live = await requestToken(OURA_OAUTH_TOKEN_URL, params, verb);
  if (mayFallBack && belongsElsewhere(live)) {
    const legacy = await requestToken(
      OURA_OAUTH_LEGACY_TOKEN_URL,
      params,
      `${verb}.legacy`,
    );
    if (legacy.status >= 200 && legacy.status < 300) {
      return tokenResult(legacy, verb);
    }
    // Neither endpoint took it. The live endpoint's answer is the one that
    // describes the grant for every current app, so report that one.
  }
  return tokenResult(live, verb);
}

/**
 * Exchange an authorization code. `iss` is the callback's issuer parameter:
 * a code from the current authorization server goes to the live endpoint
 * only, since a second attempt elsewhere could never succeed. Without an
 * issuer (an older app) the legacy endpoint is the fallback after the live
 * one has refused the code; the live endpoint is always asked first.
 */
export async function exchangeCode(
  code: string,
  creds: OuraCredentials,
  iss?: string | null,
): Promise<OuraTokenResponse> {
  return postToken(
    new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: getOuraRedirectUri(),
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
    }),
    "exchangeCode",
    !issuedByMoi(iss),
  );
}

/**
 * Refresh an access token: live endpoint first, the legacy endpoint when the
 * live one refuses it (a refresh token of an older app).
 * A refused refresh does not consume the token, so the retry is safe.
 */
export async function refreshAccessToken(
  refreshToken: string,
  creds: OuraCredentials,
): Promise<OuraTokenResponse> {
  return postToken(
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
    }),
    "refreshAccessToken",
    true,
  );
}

// ─── Collection reads (v2) ─────────────────────────────────────

/** v2 paginated envelope: `{ data, next_token }`. */
export interface OuraCollection<T> {
  data: T[];
  next_token?: string | null;
}

export interface OuraSleep {
  id: string;
  day: string;
  /** `long` | `short` | `nap` | `rest` — disambiguates a nap from the main sleep. */
  type?: string | null;
  bedtime_start?: string;
  bedtime_end?: string;
  total_sleep_duration?: number | null;
  time_in_bed?: number | null;
  efficiency?: number | null;
  rem_sleep_duration?: number | null;
  deep_sleep_duration?: number | null;
  light_sleep_duration?: number | null;
  awake_time?: number | null;
  average_heart_rate?: number | null;
  lowest_heart_rate?: number | null;
  average_hrv?: number | null;
  average_breath?: number | null;
  /**
   * 5-minute hypnogram: one digit per 5-min interval from `bedtime_start`.
   * Oura's measured per-stage timeline — `1`=deep, `2`=light, `3`=rem,
   * `4`=awake. Re-verify the digit→stage mapping against
   * `cloud.ouraring.com/v2/docs` at build time (the encoding is published in
   * the `Sleep` model; cross-checked against the `oura-api`/`@pinta365/oura-api`
   * client libraries). Unlike WHOOP — which exposes only stage totals and must
   * synthesise an order — Oura gives the real onsets, so we emit timed
   * per-segment rows (`reconstructed: false`).
   */
  sleep_phase_5_min?: string | null;
}

/**
 * Oura `daily_readiness` contributors — each a 1–100 sub-score that explains
 * the headline readiness number. All optional (a record may predate a
 * contributor or carry a null for a missing input).
 */
export interface OuraReadinessContributors {
  activity_balance?: number | null;
  body_temperature?: number | null;
  hrv_balance?: number | null;
  previous_day_activity?: number | null;
  previous_night?: number | null;
  recovery_index?: number | null;
  resting_heart_rate?: number | null;
  sleep_balance?: number | null;
}

export interface OuraReadiness {
  id: string;
  day: string;
  timestamp?: string;
  score?: number | null;
  contributors?: OuraReadinessContributors | null;
  /** Nightly body-temperature deviation from the personal baseline, °C (signed). */
  temperature_deviation?: number | null;
  /** Long-term body-temperature trend deviation, °C (signed). */
  temperature_trend_deviation?: number | null;
}

/** Oura `daily_sleep` — the headline Sleep Score (distinct from `sleep` detail). */
export interface OuraDailySleep {
  id: string;
  day: string;
  timestamp?: string;
  score?: number | null;
}

/** Oura `daily_spo2` — average overnight blood-oxygen saturation. */
export interface OuraDailySpo2 {
  id: string;
  day: string;
  spo2_percentage?: { average?: number | null } | null;
}

/** Oura `vO2_max` — the dedicated cardio-fitness collection, mL/(kg·min). */
export interface OuraVo2Max {
  id: string;
  day: string;
  timestamp?: string;
  vo2_max?: number | null;
}

/**
 * Oura `daily_cardiovascular_age` — Oura's estimate of how the user's
 * cardiovascular system is ageing relative to chronological age, in years.
 * Maps cleanly onto the existing `VASCULAR_AGE` enum (the same years-unit
 * arterial-age concept Withings' Body Scan reports under meastype 155).
 */
export interface OuraCardiovascularAge {
  id?: string;
  day: string;
  /** Estimated vascular age in years. */
  vascular_age?: number | null;
}

/**
 * Oura `daily_resilience` — the daily resilience LEVEL, a categorical band
 * describing how well the body copes with cumulative load. The headline is the
 * `level` string (limited / adequate / solid / strong / exceptional); the
 * collection also carries `contributors` (sleep_recovery / daytime_recovery /
 * stress) which we do NOT ingest — we capture only the headline level.
 * Re-verify the `level` field name + value set against
 * `cloud.ouraring.com/v2/docs` at build time.
 */
export interface OuraResilience {
  id?: string;
  day: string;
  /** limited | adequate | solid | strong | exceptional */
  level?: string | null;
}

/**
 * Oura `daily_cycle_phases` — the per-day Cycle Insights phase estimate
 * (temperature-deviation-derived). UNDOCUMENTED in the published OpenAPI
 * spec at `cloud.ouraring.com/v2/docs` as of this writing — the route was
 * confirmed live against the production API (`GET
 * /v2/usercollection/daily_cycle_phases` 400s "Token is missing" identically
 * to every documented `daily_*` collection when called unauthenticated, vs a
 * genuine 404 for an unknown path) but sits outside the spec dump alongside
 * every other Oura reproductive-health resource (`period_start`,
 * `pregnancy`, `fertile_window`, `ovulation_confirmed`, `blood_glucose` — all
 * listed as valid webhook subscription data types, none with a documented
 * read schema). These look gated behind an approval Oura does not extend to
 * a self-registered OAuth app by default, so a 403/404 here is the EXPECTED
 * outcome for most connections, not an anomaly — see `syncUserOuraCyclePhases`
 * in `./cycle-sync` for how that is swallowed without touching the rest of
 * the Oura connection's health status. Re-verify the `phase` field name +
 * value set against `cloud.ouraring.com/v2/docs` once Oura documents it.
 */
export interface OuraCyclePhase {
  id?: string;
  day: string;
  /**
   * Oura's public Cycle Insights copy describes exactly two ring-observable
   * phases (`follicular` / `luteal`, temperature-derived); some algorithm
   * versions may additionally emit `menstrual` directly. Kept as a loose
   * string — an unrecognised / missing value is skipped, never guessed (see
   * `derivePeriodDaysFromCyclePhases`).
   */
  phase?: string | null;
}

export interface OuraDailyActivity {
  id: string;
  day: string;
  timestamp?: string;
  steps?: number | null;
  active_calories?: number | null;
  total_calories?: number | null;
  /** Equivalent walking distance for the day, metres. */
  equivalent_walking_distance?: number | null;
}

interface DateRangeQuery {
  startDate: string; // YYYY-MM-DD
  endDate: string; // YYYY-MM-DD
  maxPages?: number;
}

async function fetchCollection<T>(
  path: string,
  accessToken: string,
  verb: string,
  query: DateRangeQuery,
): Promise<T[]> {
  const records: T[] = [];
  let nextToken: string | null | undefined;
  let pageCount = 0;
  const maxPages = query.maxPages ?? 100;

  do {
    const params = new URLSearchParams({
      start_date: query.startDate,
      end_date: query.endDate,
    });
    if (nextToken) params.set("next_token", nextToken);

    const pageStart = performance.now();
    const res = await safeFetch(`${OURA_API_BASE}${path}?${params}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    });
    const json = (await res
      .json()
      .catch(() => null)) as OuraCollection<T> | null;
    const verdict = classifyOuraResponse(res.status);
    getEvent()?.addExternalCall({
      service: "oura",
      method: `${verb}(page=${pageCount})`,
      duration_ms: Math.round(performance.now() - pageStart),
      status: res.status,
      error: verdict.classification === "success" ? undefined : verdict.reason,
    });
    if (verdict.classification !== "success") {
      throw new OuraApiError({
        verb,
        classification: verdict.classification,
        httpStatus: verdict.httpStatus,
        reason: verdict.reason,
      });
    }
    for (const r of json?.data ?? []) records.push(r);
    nextToken = json?.next_token ?? null;
    pageCount += 1;
  } while (nextToken && pageCount < maxPages);

  return records;
}

export function fetchSleep(
  accessToken: string,
  query: DateRangeQuery,
): Promise<OuraSleep[]> {
  return fetchCollection<OuraSleep>(
    "/v2/usercollection/sleep",
    accessToken,
    "fetchSleep",
    query,
  );
}

export function fetchReadiness(
  accessToken: string,
  query: DateRangeQuery,
): Promise<OuraReadiness[]> {
  return fetchCollection<OuraReadiness>(
    "/v2/usercollection/daily_readiness",
    accessToken,
    "fetchReadiness",
    query,
  );
}

export function fetchDailyActivity(
  accessToken: string,
  query: DateRangeQuery,
): Promise<OuraDailyActivity[]> {
  return fetchCollection<OuraDailyActivity>(
    "/v2/usercollection/daily_activity",
    accessToken,
    "fetchDailyActivity",
    query,
  );
}

export function fetchDailySleep(
  accessToken: string,
  query: DateRangeQuery,
): Promise<OuraDailySleep[]> {
  return fetchCollection<OuraDailySleep>(
    "/v2/usercollection/daily_sleep",
    accessToken,
    "fetchDailySleep",
    query,
  );
}

export function fetchDailySpo2(
  accessToken: string,
  query: DateRangeQuery,
): Promise<OuraDailySpo2[]> {
  return fetchCollection<OuraDailySpo2>(
    "/v2/usercollection/daily_spo2",
    accessToken,
    "fetchDailySpo2",
    query,
  );
}

// Oura `daily_stress` → STRESS_SCORE is deferred pending STRESS_SCORE
// source-priority + graded-series wiring (an HRV-derived COMPUTED producer
// already exists; a second producer here would double-count). The mapping is
// withdrawn until the ladder is in place.

export function fetchVo2Max(
  accessToken: string,
  query: DateRangeQuery,
): Promise<OuraVo2Max[]> {
  // Oura camel-cases this path segment (`vO2_max`); every other collection is
  // snake_case. Matched verbatim against cloud.ouraring.com/v2/docs.
  return fetchCollection<OuraVo2Max>(
    "/v2/usercollection/vO2_max",
    accessToken,
    "fetchVo2Max",
    query,
  );
}

export function fetchCardiovascularAge(
  accessToken: string,
  query: DateRangeQuery,
): Promise<OuraCardiovascularAge[]> {
  return fetchCollection<OuraCardiovascularAge>(
    "/v2/usercollection/daily_cardiovascular_age",
    accessToken,
    "fetchCardiovascularAge",
    query,
  );
}

export function fetchResilience(
  accessToken: string,
  query: DateRangeQuery,
): Promise<OuraResilience[]> {
  return fetchCollection<OuraResilience>(
    "/v2/usercollection/daily_resilience",
    accessToken,
    "fetchResilience",
    query,
  );
}

/** See the `OuraCyclePhase` docstring for the endpoint's documentation gap. */
export function fetchDailyCyclePhases(
  accessToken: string,
  query: DateRangeQuery,
): Promise<OuraCyclePhase[]> {
  return fetchCollection<OuraCyclePhase>(
    "/v2/usercollection/daily_cycle_phases",
    accessToken,
    "fetchDailyCyclePhases",
    query,
  );
}

// ─── Field → Measurement mapping ───────────────────────────────

const SEC_TO_MIN = 1 / 60;

function round2(n: number): number {
  return parseFloat(n.toFixed(2));
}

export interface MappedMeasurement {
  type: string;
  value: number;
  unit: string;
  measuredAt: Date;
  fieldTag: string;
  sleepStage?: "CORE" | "DEEP" | "REM" | "AWAKE";
  /**
   * Per-row externalId override. Most rows derive their externalId from the
   * resource prefix + day + fieldTag in the sync layer, but the per-segment
   * sleep-timeline rows (and any other row that needs a record-scoped key)
   * carry their own here so several rows of one night stay distinct under
   * `userId_type_source_externalId`. The sync layer uses `m.externalId ??`
   * the default key.
   */
  externalId?: string;
}

function dayAnchor(
  day: string,
  tz: string | undefined,
  bedtimeEnd?: string,
): Date | null {
  // Prefer the precise wake instant when present; else anchor the date-only
  // day at local noon in the user's zone (canonicalDailyTimestamp), which
  // reads the same calendar day there. Noon UTC, the previous anchor, is
  // already the next day from UTC+13 on.
  if (bedtimeEnd) {
    const d = new Date(bedtimeEnd);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const d = canonicalDailyTimestamp(day, tz);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Map one Oura readiness record:
 *   - `score` → `RECOVERY_SCORE` (source OURA, feeding the recovery ladder
 *     below WHOOP).
 *   - `temperature_deviation` → `BODY_TEMPERATURE_DEVIATION` (signed °C offset
 *     from the personal baseline — illness / luteal-phase / stress signal).
 *
 * The eight readiness `contributors` are the *why* behind the score; they are
 * carried back to the caller separately (not minted as Measurement rows here
 * since each is a sub-score, not a stored metric) — see the dropped-field note.
 * `temperature_trend_deviation` is the long-term trend twin; we keep only the
 * nightly deviation as the actionable signal.
 */
export function mapReadiness(
  r: OuraReadiness,
  tz?: string,
): MappedMeasurement[] {
  const measuredAt = dayAnchor(r.day, tz, r.timestamp);
  if (!measuredAt) return [];
  const out: MappedMeasurement[] = [];
  if (typeof r.score === "number") {
    out.push({
      type: "RECOVERY_SCORE",
      value: round2(r.score),
      unit: "score",
      measuredAt,
      fieldTag: "recovery",
    });
  }
  if (typeof r.temperature_deviation === "number") {
    out.push({
      type: "BODY_TEMPERATURE_DEVIATION",
      value: round2(r.temperature_deviation),
      unit: "celsius",
      measuredAt,
      fieldTag: "temp_deviation",
    });
  }
  return out;
}

/**
 * Oura 5-minute hypnogram digit → our `SleepStage`. Oura encodes one digit per
 * 5-min interval from `bedtime_start`: `1`=deep, `2`=light, `3`=rem, `4`=awake.
 * Light maps to our CORE stage (the granular-asleep stage the sleep-night
 * reader scores), matching the `light_sleep_duration → CORE` convention the
 * stage-totals path already uses. Re-verify against `cloud.ouraring.com/v2/docs`.
 */
const HYPNOGRAM_STAGE: Record<
  string,
  NonNullable<MappedMeasurement["sleepStage"]>
> = {
  "1": "DEEP",
  "2": "CORE",
  "3": "REM",
  "4": "AWAKE",
};

/** Each hypnogram digit covers 5 minutes. */
const HYPNOGRAM_INTERVAL_MIN = 5;
const HYPNOGRAM_INTERVAL_MS = HYPNOGRAM_INTERVAL_MIN * 60_000;

/**
 * Build timed per-segment `SLEEP_DURATION` rows from Oura's real measured
 * `sleep_phase_5_min` hypnogram. Consecutive identical digits collapse into one
 * segment; each segment is stamped at its own END instant (start + duration)
 * relative to `bedtime_start`, so the sleep-night reader (which derives
 * `start = end − value·60_000`) reconstructs the actual clock-time timeline —
 * NOT the degraded all-on-`bedtime_end` shape. The rows are `reconstructed:
 * false` by virtue of OURA being absent from the reader's
 * `RECONSTRUCTED_TIMELINE_SOURCES` set (WHOOP only). Returns `null` when the
 * hypnogram is absent / unusable so the caller falls back to stage totals.
 */
function mapSleepTimeline(s: OuraSleep): MappedMeasurement[] | null {
  const hyp = s.sleep_phase_5_min;
  if (typeof hyp !== "string" || hyp.length === 0 || !s.bedtime_start) {
    return null;
  }
  const onset = new Date(s.bedtime_start);
  if (Number.isNaN(onset.getTime())) return null;

  const out: MappedMeasurement[] = [];
  let i = 0;
  while (i < hyp.length) {
    const digit = hyp[i];
    const stage = HYPNOGRAM_STAGE[digit];
    // Walk the run of identical digits.
    let run = 1;
    while (i + run < hyp.length && hyp[i + run] === digit) run += 1;
    if (stage) {
      const segStartMs = onset.getTime() + i * HYPNOGRAM_INTERVAL_MS;
      const segEndMs = segStartMs + run * HYPNOGRAM_INTERVAL_MS;
      // Keyed by the run's own START instant, NOT a positional run index. A
      // revised hypnogram re-segments the night (runs merge/split), so an
      // index shifted every following run onto the wrong row — wrong
      // boundaries updated in place plus phantom tail rows the night-total
      // double-counted. A run's start instant is a stable coordinate: an
      // unchanged run keeps its id (re-classification overwrites in place),
      // and whatever the revision orphaned is swept by the record-scoped
      // cleanup in the sync (which also clears legacy `seg:<i>` rows).
      const fieldTag = `seg:${new Date(segStartMs).toISOString()}`;
      out.push({
        type: "SLEEP_DURATION",
        value: round2(run * HYPNOGRAM_INTERVAL_MIN),
        unit: "minutes",
        measuredAt: new Date(segEndMs),
        fieldTag,
        sleepStage: stage,
        // Record-scoped so a nap's segments never collide with the main
        // sleep's and a re-fetch overwrites in place.
        externalId: `sleep:${s.id}:${fieldTag}`,
      });
    }
    i += run;
  }
  return out.length > 0 ? out : null;
}

/**
 * Map one Oura sleep record. When the real `sleep_phase_5_min` hypnogram is
 * present we emit timed per-segment `SLEEP_DURATION` rows (Oura's measured
 * timeline); otherwise we fall back to the four per-stage totals stamped on the
 * sleep END. Either way we add efficiency, HRV, RHR (`lowest_heart_rate`), and
 * respiratory rate.
 */
export function mapSleep(s: OuraSleep, tz?: string): MappedMeasurement[] {
  const measuredAt = dayAnchor(s.day, tz, s.bedtime_end);
  if (!measuredAt) return [];
  const out: MappedMeasurement[] = [];

  const timeline = mapSleepTimeline(s);
  if (timeline) {
    out.push(...timeline);
  } else {
    // Fallback: no hypnogram — stamp the four stage totals on the sleep END.
    const stages: Array<
      [number | null | undefined, MappedMeasurement["sleepStage"], string]
    > = [
      [s.light_sleep_duration, "CORE", "sleep_core"],
      [s.deep_sleep_duration, "DEEP", "sleep_deep"],
      [s.rem_sleep_duration, "REM", "sleep_rem"],
      [s.awake_time, "AWAKE", "sleep_awake"],
    ];
    for (const [sec, stage, fieldTag] of stages) {
      if (typeof sec === "number" && sec >= 0) {
        out.push({
          type: "SLEEP_DURATION",
          value: round2(sec * SEC_TO_MIN),
          unit: "minutes",
          measuredAt,
          fieldTag,
          sleepStage: stage,
          // Record-scoped so a nap and the main sleep on the same day don't
          // collapse onto one key (B2) — the legacy day-keyed key did.
          externalId: `sleep:${s.id}:${fieldTag}`,
        });
      }
    }
  }
  // The nightly scalars are record-scoped too (B2): a nap and the main sleep on
  // the same day would otherwise overwrite each other's efficiency / HRV / RHR /
  // respiratory rate on a shared day key.
  if (typeof s.efficiency === "number") {
    out.push({
      type: "SLEEP_EFFICIENCY",
      value: round2(s.efficiency),
      unit: "%",
      measuredAt,
      fieldTag: "sleep_eff",
      externalId: `sleep:${s.id}:sleep_eff`,
    });
  }
  if (typeof s.average_hrv === "number" && s.average_hrv > 0) {
    out.push({
      type: "HRV_RMSSD",
      value: round2(s.average_hrv),
      unit: "ms",
      measuredAt,
      fieldTag: "hrv_rmssd",
      externalId: `sleep:${s.id}:hrv_rmssd`,
    });
  }
  if (typeof s.lowest_heart_rate === "number" && s.lowest_heart_rate > 0) {
    out.push({
      type: "RESTING_HEART_RATE",
      value: Math.round(s.lowest_heart_rate),
      unit: "bpm",
      measuredAt,
      fieldTag: "rhr",
      externalId: `sleep:${s.id}:rhr`,
    });
  }
  if (typeof s.average_breath === "number" && s.average_breath > 0) {
    out.push({
      type: "RESPIRATORY_RATE",
      value: round2(s.average_breath),
      unit: "breaths/min",
      measuredAt,
      fieldTag: "resp_rate",
      externalId: `sleep:${s.id}:resp_rate`,
    });
  }
  return out;
}

/** Map one Oura daily-sleep record: the headline Sleep Score → `SLEEP_SCORE`. */
export function mapDailySleep(
  d: OuraDailySleep,
  tz?: string,
): MappedMeasurement[] {
  if (typeof d.score !== "number") return [];
  const measuredAt = dayAnchor(d.day, tz, d.timestamp);
  if (!measuredAt) return [];
  return [
    {
      type: "SLEEP_SCORE",
      value: round2(d.score),
      unit: "score",
      measuredAt,
      fieldTag: "sleep_score",
    },
  ];
}

/** Map one Oura daily-spo2 record: average overnight SpO2 → `OXYGEN_SATURATION`. */
export function mapDailySpo2(
  s: OuraDailySpo2,
  tz?: string,
): MappedMeasurement[] {
  const avg = s.spo2_percentage?.average;
  if (typeof avg !== "number" || avg <= 0) return [];
  // Anchor SpO2 at the day's local noon (no per-record instant in the
  // daily_spo2 collection); the recovery / rollup readers key off the local day.
  const measuredAt = dayAnchor(s.day, tz);
  if (!measuredAt) return [];
  return [
    {
      type: "OXYGEN_SATURATION",
      value: round2(avg),
      unit: "%",
      measuredAt,
      fieldTag: "spo2",
    },
  ];
}

/** Map one Oura daily-activity record: steps, active energy, and the
 * equivalent walking distance (B5 — the OURA distance ladder slot was dead). */
export function mapDailyActivity(
  a: OuraDailyActivity,
  tz?: string,
): MappedMeasurement[] {
  const measuredAt = dayAnchor(a.day, tz, a.timestamp);
  if (!measuredAt) return [];
  const out: MappedMeasurement[] = [];
  if (typeof a.steps === "number" && a.steps >= 0) {
    out.push({
      type: "ACTIVITY_STEPS",
      value: Math.round(a.steps),
      unit: "steps",
      measuredAt,
      fieldTag: "steps",
    });
  }
  if (typeof a.active_calories === "number" && a.active_calories >= 0) {
    out.push({
      type: "ACTIVE_ENERGY_BURNED",
      value: round2(a.active_calories),
      unit: "kcal",
      measuredAt,
      fieldTag: "active_energy",
    });
  }
  if (
    typeof a.equivalent_walking_distance === "number" &&
    a.equivalent_walking_distance >= 0
  ) {
    out.push({
      type: "WALKING_RUNNING_DISTANCE",
      // Oura reports the equivalent walking distance in metres — the canonical
      // WALKING_RUNNING_DISTANCE unit (no conversion).
      value: round2(a.equivalent_walking_distance),
      unit: "m",
      measuredAt,
      fieldTag: "distance",
    });
  }
  return out;
}

/**
 * Map one Oura `vO2_max` record: the dedicated cardio-fitness collection →
 * `VO2_MAX` (mL/(kg·min), the canonical DB unit — no conversion). Skips a
 * record with no positive value.
 */
export function mapVo2Max(v: OuraVo2Max, tz?: string): MappedMeasurement[] {
  if (typeof v.vo2_max !== "number" || v.vo2_max <= 0) return [];
  const measuredAt = dayAnchor(v.day, tz, v.timestamp);
  if (!measuredAt) return [];
  return [
    {
      type: "VO2_MAX",
      value: round2(v.vo2_max),
      unit: "mL/(kg·min)",
      measuredAt,
      fieldTag: "vo2_max",
    },
  ];
}

/**
 * Map one Oura `daily_cardiovascular_age` record → `VASCULAR_AGE` (years, the
 * canonical DB unit — no conversion). Skips a record with no positive value.
 * Shares the `VASCULAR_AGE` bucket with Withings' Body Scan arterial-age, kept
 * distinct from the two vendors only by `source`.
 */
export function mapCardiovascularAge(
  c: OuraCardiovascularAge,
  tz?: string,
): MappedMeasurement[] {
  if (typeof c.vascular_age !== "number" || c.vascular_age <= 0) return [];
  const measuredAt = dayAnchor(c.day, tz);
  if (!measuredAt) return [];
  return [
    {
      type: "VASCULAR_AGE",
      value: round2(c.vascular_age),
      unit: "years",
      measuredAt,
      fieldTag: "vascular_age",
    },
  ];
}

/**
 * Single source of truth for the Oura resilience level → ordinal encoding.
 * Oura's `daily_resilience.level` is a categorical band; we store it ORDINAL-
 * ENCODED in the numeric Measurement `value` so it fits the existing model with
 * no new categorical column. Keep in lock-step with the schema comment on the
 * `RESILIENCE` enum value and migration 0186.
 */
export const RESILIENCE_LEVELS: Record<string, number> = {
  limited: 1,
  adequate: 2,
  solid: 3,
  strong: 4,
  exceptional: 5,
};

/** The unit recorded for a RESILIENCE row — the ordinal level scale (1–5). */
export const RESILIENCE_UNIT = "level" as const;

/**
 * Map one Oura `daily_resilience` record → `RESILIENCE`, ordinal-encoded
 * (limited=1 … exceptional=5) into the numeric `value`. An unknown / missing
 * level string mints NO row (skipped, never coerced to 0) so a future Oura band
 * we do not recognise never lands as a misleading reading. Anchored at the
 * day's local noon (the collection carries no per-record instant).
 */
export function mapResilience(
  r: OuraResilience,
  tz?: string,
): MappedMeasurement[] {
  const level = typeof r.level === "string" ? r.level.toLowerCase() : null;
  if (!level) return [];
  const ordinal = RESILIENCE_LEVELS[level];
  if (typeof ordinal !== "number") return [];
  const measuredAt = dayAnchor(r.day, tz);
  if (!measuredAt) return [];
  return [
    {
      type: "RESILIENCE",
      value: ordinal,
      unit: RESILIENCE_UNIT,
      measuredAt,
      fieldTag: "resilience",
    },
  ];
}

// ─── Cycle-phase → CycleDayLog mapping (v1.29.x) ───────────────────
//
// `daily_cycle_phases` does NOT feed `Measurement` like every collection
// above — it feeds the cycle tracker's `CycleDayLog` via
// `syncUserOuraCyclePhases` in `./cycle-sync`, which owns the write-side
// "manual always wins" guard. This module only derives WHICH days look like
// a period day; it never touches the database.

const OURA_MENSTRUAL_PHASE = "menstrual";
const OURA_FOLLICULAR_PHASE = "follicular";
const OURA_LUTEAL_PHASE = "luteal";

/**
 * Derive the (sparse) set of `YYYY-MM-DD` days that look like a period day
 * from a `daily_cycle_phases` series. The endpoint reports only the PHASE,
 * not menstrual flow directly, so a period day is inferred two ways:
 *
 *   1. A record whose `phase` is literally `"menstrual"` — some algorithm
 *      versions / accounts may emit this directly.
 *   2. The single day a `"luteal"` phase is immediately (calendar-adjacent)
 *      followed by a `"follicular"` phase. Oura's own definition of the
 *      follicular phase is "from the first day of menstruation to
 *      ovulation", so this transition day is the best period-start signal
 *      the two-phase (follicular/luteal) shape carries.
 *
 * Records are sorted by `day` internally (the collection's page order is not
 * guaranteed to be chronological). Returns bare day strings — the caller
 * writes each as a single-day conservative `flow: LIGHT` marker (the same
 * "logged but unspecified intensity" boundary the HealthKit `unspecified`
 * flow mapping uses), never a multi-day bleed span this endpoint gives no
 * evidence for.
 */
export function derivePeriodDaysFromCyclePhases(
  records: readonly OuraCyclePhase[],
): string[] {
  const sorted = [...records]
    .filter((r) => typeof r.day === "string" && r.day.length > 0)
    .sort((a, b) => dayDiff(a.day, b.day));

  const days = new Set<string>();
  let prevPhase: string | null = null;
  let prevDay: string | null = null;

  for (const r of sorted) {
    const phase = typeof r.phase === "string" ? r.phase.toLowerCase() : null;

    if (phase === OURA_MENSTRUAL_PHASE) {
      days.add(r.day);
    } else if (
      phase === OURA_FOLLICULAR_PHASE &&
      prevPhase === OURA_LUTEAL_PHASE &&
      prevDay !== null &&
      dayDiff(r.day, prevDay) === 1
    ) {
      days.add(r.day);
    }

    if (phase) {
      prevPhase = phase;
      prevDay = r.day;
    }
  }

  return Array.from(days);
}
