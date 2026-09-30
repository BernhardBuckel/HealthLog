/**
 * Integration-sync queue registrar.
 *
 * Owns the third-party-provider sync queues — Withings (fallback / activity /
 * sleep), WHOOP (recovery / sleep / workout / cycle + backfill + OAuth-state
 * cleanup), Fitbit (sync + backfill + sleep repair + OAuth-state cleanup),
 * Nightscout, Polar, Oura, and the two one-shot backfills
 * (sleep-timeline, lab-biomarker) — plus their boot-time discovery enqueues.
 *
 * v1.4.37 dead-queue contract: every queue name appears in `allQueues`, its
 * cron (where it has one) appears as a `[QUEUE, CRON]` tuple in `schedules`,
 * and a `createAndWork(boss, QUEUE, …, handler)` binding drains it. The
 * queue-wiring guards (`withings-queues`, `whoop-queues`, `fitbit-queues`,
 * `nightscout-queues`, `sleep-timeline-queues`) read THIS module.
 */
import { PgBoss } from "pg-boss";
import {
  WHOOP_BACKFILL_QUEUE,
  WHOOP_BACKFILL_CONCURRENCY,
  enqueueBootTimeWhoopBackfill,
  type WhoopBackfillPayload,
} from "@/lib/jobs/whoop-backfill";
import {
  FITBIT_BACKFILL_QUEUE,
  FITBIT_BACKFILL_CONCURRENCY,
  enqueueBootTimeFitbitBackfill,
  type FitbitBackfillPayload,
} from "@/lib/jobs/fitbit-backfill";
import {
  GOOGLE_HEALTH_BACKFILL_QUEUE,
  GOOGLE_HEALTH_BACKFILL_CONCURRENCY,
  enqueueBootTimeGoogleHealthBackfill,
  type GoogleHealthBackfillPayload,
} from "@/lib/jobs/google-health-backfill";
import {
  GOOGLE_HEALTH_SLEEP_REPAIR_QUEUE,
  GOOGLE_HEALTH_SLEEP_REPAIR_CONCURRENCY,
  enqueueBootTimeGoogleHealthSleepRepair,
  type GoogleHealthSleepRepairPayload,
} from "@/lib/jobs/google-health-sleep-repair";
import {
  FITBIT_SLEEP_REPAIR_QUEUE,
  FITBIT_SLEEP_REPAIR_CONCURRENCY,
  enqueueBootTimeFitbitSleepRepair,
  type FitbitSleepRepairPayload,
} from "@/lib/jobs/fitbit-sleep-repair";
import {
  STRAVA_BACKFILL_QUEUE,
  STRAVA_BACKFILL_CONCURRENCY,
  enqueueBootTimeStravaBackfill,
  type StravaBackfillPayload,
} from "@/lib/jobs/strava-backfill";
import {
  SLEEP_TIMELINE_BACKFILL_QUEUE,
  SLEEP_TIMELINE_BACKFILL_CONCURRENCY,
  enqueueBootTimeSleepTimelineBackfill,
  type SleepTimelineBackfillPayload,
} from "@/lib/jobs/sleep-timeline-backfill";
import {
  LAB_BIOMARKER_BACKFILL_QUEUE,
  LAB_BIOMARKER_BACKFILL_CONCURRENCY,
  enqueueBootTimeLabBiomarkerBackfill,
  type LabBiomarkerBackfillPayload,
} from "@/lib/jobs/lab-biomarker-backfill";
import {
  INTEGRATION_BACKFILL_ADMISSION_QUEUE,
  INTEGRATION_BACKFILL_GLOBAL_CONCURRENCY,
  bootStaggerSecondsFor,
  enqueueIntegrationBackfillAdmission,
  type IntegrationBackfillAdmissionPayload,
} from "@/lib/jobs/integration-backfill-admission";
import { drainIntegrationBackfillAdmission } from "@/lib/jobs/integration-backfill-drain";
import { workerLog } from "./shared";
import { jobDone } from "@/lib/jobs/job-outcome";
import {
  createAndSchedule,
  createAndWork,
  cronIsTheRetry,
  type QueuePolicyTable,
  type ScheduleEntry,
} from "./registrar-shared";
import { WITHINGS_ECG_SYNC_QUEUE } from "@/lib/jobs/withings-ecg-queue";
import {
  NIGHTSCOUT_SYNC_QUEUE,
  OURA_SYNC_QUEUE,
  POLAR_SYNC_QUEUE,
  STRAVA_SYNC_QUEUE,
} from "@/lib/jobs/integration-poll-queues";
import {
  WithingsSyncPayload,
  WithingsActivitySyncPayload,
  WithingsSleepSyncPayload,
  WithingsEcgSyncPayload,
  handleWithingsFallbackSync,
  handleWithingsActivitySync,
  handleWithingsSleepSync,
  handleWithingsEcgSync,
} from "./withings-sync";
import {
  WhoopSyncPayload,
  handleWhoopRecoverySync,
  handleWhoopSleepSync,
  handleWhoopWorkoutSync,
  handleWhoopCycleSync,
} from "./whoop-sync";
import {
  WithingsOAuthStateCleanupPayload,
  handleWithingsOAuthStateCleanup,
  WhoopOAuthStateCleanupPayload,
  handleWhoopOAuthStateCleanup,
  OidcNativeHandoffCleanupPayload,
  handleOidcNativeHandoffCleanup,
} from "./cleanup-handlers";
import { NightscoutSyncPayload, handleNightscoutSync } from "./nightscout-sync";
import { PolarSyncPayload, handlePolarSync } from "./polar-sync";
import { OuraSyncPayload, handleOuraSync } from "./oura-sync";
import { StravaSyncPayload, handleStravaSync } from "./strava-sync";
import {
  FitbitSyncPayload,
  handleFitbitSync,
  FitbitOAuthStateCleanupPayload,
  handleFitbitOAuthStateCleanup,
} from "./fitbit-sync";
import {
  GoogleHealthSyncPayload,
  handleGoogleHealthSync,
  GoogleHealthOAuthStateCleanupPayload,
  handleGoogleHealthOAuthStateCleanup,
} from "./google-health-sync";

const WITHINGS_SYNC_QUEUE = "withings-fallback-sync";

const WITHINGS_SYNC_CRON = "0 * * * *"; // every 60 minutes
// v1.4.25 W17b/c — webhook-primary + cron-safety-net for activity and
// sleep v2. The webhook handler enqueues per-user jobs on appli=16 / 44
// notifications; the crons below are the catch-net for the 1 % of
// notifications Withings drops. Offset 15-minute cadence per the
// research recommendation so the two queues don't lockstep against the
// existing measure cron at :00.

const WITHINGS_ACTIVITY_QUEUE = "withings-activity-sync";

const WITHINGS_ACTIVITY_CRON = "0 * * * *"; // every hour at :00

const WITHINGS_SLEEP_QUEUE = "withings-sleep-sync";

const WITHINGS_SLEEP_CRON = "15 * * * *"; // every hour at :15
// v1.32.23 — Withings ECG cron catch-net. The queue is webhook-primary
// (appli=54 → `enqueueWithingsEcgSync`), but appli 54 is not in the
// subscription set and the manual sync route measures only, so a ScanWatch-only
// account (no scale) never had its ECG strips pulled. An hourly cohort walk
// (one `v2/heart list` call per connected user, empty + cheap for non-ECG
// devices) closes the gap. :41 is a free minute (used: 0,5,8,11,13,15,17,18,
// 20,30,35,50) staggered off every other hourly sync tick.
const WITHINGS_ECG_SYNC_CRON = "41 * * * *"; // every hour at :41

// v1.4.47 W6 — daily sweep for the Withings OAuth state ledger. Slots
// at :20 between the audit-log cleanup (:15) and the mood-reminder
// cleanup (:25), inside the existing 02:xx-03:xx maintenance window.
// Rows are normally consumed by the callback handler in single-use
// fashion; this sweep picks up the long tail where a user closed the
// Withings approval tab without bouncing back to the callback URL.

const WITHINGS_OAUTH_STATE_CLEANUP_QUEUE = "withings-oauth-state-cleanup";

const WITHINGS_OAUTH_STATE_CLEANUP_CRON = "20 3 * * *";
// v1.11.0 — WHOOP sync queues. Webhook-primary + cron-safety-net, mirroring
// the Withings activity/sleep crons. Recovery / sleep / workout each have a
// WHOOP webhook (`*.updated`) that enqueues the matching per-resource job; the
// crons below are the catch-net for dropped deliveries. Cycle has NO webhook,
// so its cron is the only driver. Minutes are staggered off the Withings crons
// (:00/:15) to spread DB load.

const WHOOP_RECOVERY_SYNC_QUEUE = "whoop-recovery-sync";

const WHOOP_RECOVERY_SYNC_CRON = "5 * * * *"; // every hour at :05

const WHOOP_SLEEP_SYNC_QUEUE = "whoop-sleep-sync";

const WHOOP_SLEEP_SYNC_CRON = "20 * * * *"; // every hour at :20

const WHOOP_WORKOUT_SYNC_QUEUE = "whoop-workout-sync";

const WHOOP_WORKOUT_SYNC_CRON = "35 * * * *"; // every hour at :35

const WHOOP_CYCLE_SYNC_QUEUE = "whoop-cycle-sync";

const WHOOP_CYCLE_SYNC_CRON = "50 * * * *"; // every hour at :50 (poll-only)
// v1.11.0 — daily sweep for the WHOOP OAuth state ledger. Slots at 03:22,
// next to the Withings sweep (03:20), inside the maintenance window.

const WHOOP_OAUTH_STATE_CLEANUP_QUEUE = "whoop-oauth-state-cleanup";

const WHOOP_OAUTH_STATE_CLEANUP_CRON = "22 3 * * *";
// v1.12.0 — Fitbit / Google Health poll-only sync. There is no Fitbit webhook
// at launch (Pub/Sub deferred), so a single hourly cron drives the per-user
// `syncUserFitbit` driver across every connection. Minute staggered off the
// WHOOP slots (:05/:20/:35/:50) and the Withings slots (:00/:15) so the hourly
// ticks don't pile up on one boss poll.

const FITBIT_SYNC_QUEUE = "fitbit-sync";

const FITBIT_SYNC_CRON = "8 * * * *"; // every hour at :08
// v1.12.0 — daily sweep for the Fitbit OAuth state ledger. Slots at 03:24, next
// to the WHOOP sweep (03:22), inside the maintenance window.

const FITBIT_OAUTH_STATE_CLEANUP_QUEUE = "fitbit-oauth-state-cleanup";

const FITBIT_OAUTH_STATE_CLEANUP_CRON = "24 3 * * *";
// v1.26.0 — Google Health / Fitbit-Pixel-Wear-OS poll-only sync. There is no
// Google Health webhook at launch (Pub/Sub deferred), so a single hourly cron
// drives the per-user `syncUserGoogleHealth` driver across every connection.
// Minute staggered off the WHOOP (:05/:20/:35/:50), Fitbit (:08), Nightscout
// (:11), Polar (:13), and Oura (:15) slots so the hourly ticks don't pile up on
// one boss poll.

const GOOGLE_HEALTH_SYNC_QUEUE = "google-health-sync";

const GOOGLE_HEALTH_SYNC_CRON = "18 * * * *"; // every hour at :18
// v1.26.0 — daily sweep for the Google Health OAuth state ledger. Slots at
// 03:26, next to the Fitbit sweep (03:24), inside the maintenance window.

const GOOGLE_HEALTH_OAUTH_STATE_CLEANUP_QUEUE =
  "google-health-oauth-state-cleanup";

const GOOGLE_HEALTH_OAUTH_STATE_CLEANUP_CRON = "26 3 * * *";
// v1.17.0 — Nightscout CGM poll sync. Poll-only (no webhook): one hourly tick
// pulls the recent SGV window per configured instance. :11 staggers off the
// WHOOP (:05), Fitbit (:08), and Withings sync ticks so the hourly polls don't
// pile up on one boss poll.
//
// The four poll-queue NAMES live in `@/lib/jobs/integration-poll-queues` (see
// the import above) so an OAuth callback can enqueue a connect-time first sync
// without importing this registrar and its whole handler graph. Creation,
// scheduling, and handler binding stay here.
const NIGHTSCOUT_SYNC_CRON = "11 * * * *"; // every hour at :11
// v1.17.0 (F4) — Polar + Oura OAuth poll sync. Poll-only (one hourly tick per
// provider re-walks every connected user). :13 / :15 stagger off the other
// hourly sync ticks (WHOOP :05, Fitbit :08, Nightscout :11) so the polls don't
// pile up on one boss poll. The queues MUST be registered in `allQueues` below
// or pg-boss never provisions them and the schedule silently no-ops (the
// v1.4.37 dead-queue class).
const POLAR_SYNC_CRON = "13 * * * *"; // every hour at :13
const OURA_SYNC_CRON = "15 * * * *"; // every hour at :15
// v1.28.x — Strava OAuth poll sync. Poll-only (webhook deferred): one hourly
// tick re-walks every connected user. :17 staggers off the Polar (:13) / Oura
// (:15) ticks so the polls don't pile up on one boss poll. The queue MUST be
// registered in `allQueues` below or pg-boss never provisions it and the
// schedule silently no-ops (the v1.4.37 dead-queue class).
const STRAVA_SYNC_CRON = "17 * * * *"; // every hour at :17
// v1.30.x — daily sweep for the native OIDC handoff ledger. Handoff codes are
// single-use + 90s-lived and expiry is enforced at read, so this is pure
// hygiene: it reaps rows the app never came back to exchange. Slots at 03:28,
// next to the Google Health OAuth-state sweep (03:26), inside the maintenance
// window. The queue MUST be registered in `allQueues` below or pg-boss never
// provisions it and the schedule silently no-ops (the v1.4.37 dead-queue class).
const OIDC_NATIVE_HANDOFF_CLEANUP_QUEUE = "oidc-native-handoff-cleanup";
const OIDC_NATIVE_HANDOFF_CLEANUP_CRON = "28 3 * * *";

// pg-boss v12 requires explicit queue creation before scheduling. Every queue
// MUST be registered here or pg-boss never provisions it and both the webhook
// enqueue AND the cron schedule below silently no-op (the v1.4.37 dead-queue
// class).
const allQueues = [
  WITHINGS_SYNC_QUEUE,
  WITHINGS_ACTIVITY_QUEUE,
  WITHINGS_SLEEP_QUEUE,
  WITHINGS_ECG_SYNC_QUEUE,
  WITHINGS_OAUTH_STATE_CLEANUP_QUEUE,
  // v1.11.0 — WHOOP sync queues. Webhook-primary + cron-safety-net for
  // recovery / sleep / workout; cycle is poll-only (no WHOOP webhook).
  WHOOP_RECOVERY_SYNC_QUEUE,
  WHOOP_SLEEP_SYNC_QUEUE,
  WHOOP_WORKOUT_SYNC_QUEUE,
  WHOOP_CYCLE_SYNC_QUEUE,
  // v1.11.0 — self-converging boot backfill for newly connected WHOOP
  // accounts. Discovery enqueues one full-history sync per un-backfilled
  // connection; idempotent across reboots.
  WHOOP_BACKFILL_QUEUE,
  // v1.11.0 — daily sweep for the WHOOP OAuth state ledger.
  WHOOP_OAUTH_STATE_CLEANUP_QUEUE,
  // v1.12.0 — Fitbit / Google Health poll-only sync (no webhook at launch),
  // self-converging boot backfill, and the daily OAuth-state ledger sweep.
  FITBIT_SYNC_QUEUE,
  FITBIT_BACKFILL_QUEUE,
  // One-shot Fitbit sleep duplicate repair. Discovery enqueues one bounded
  // sleep re-read per connection not yet repaired; the replace-by-window write
  // path collapses each night's leftovers. Idempotent across reboots.
  FITBIT_SLEEP_REPAIR_QUEUE,
  FITBIT_OAUTH_STATE_CLEANUP_QUEUE,
  // v1.26.0 — Google Health poll-only sync (no webhook at launch),
  // self-converging boot backfill, and the daily OAuth-state ledger sweep.
  GOOGLE_HEALTH_SYNC_QUEUE,
  GOOGLE_HEALTH_BACKFILL_QUEUE,
  // v1.28.x — one-shot sleep duplicate repair. Discovery enqueues one full
  // sleep re-read per connection not yet repaired; the replace-by-window write
  // path collapses each night's duplicate rows. Idempotent across reboots.
  GOOGLE_HEALTH_SLEEP_REPAIR_QUEUE,
  GOOGLE_HEALTH_OAUTH_STATE_CLEANUP_QUEUE,
  // v1.17.1 — one-shot sleep-timeline backfill for WHOOP + Withings.
  // Discovery enqueues one job per connection whose sleep rows predate the
  // stamp/shape fix; the pass deletes the affected SLEEP_DURATION rows and
  // re-syncs. Idempotent across reboots.
  SLEEP_TIMELINE_BACKFILL_QUEUE,
  // v1.18.1 — one-shot backfill that links legacy free-text lab readings to
  // a user-scoped Biomarker catalog entry (group by `lower(analyte)`).
  LAB_BIOMARKER_BACKFILL_QUEUE,
  // Shared durable drain for every full-history integration job. Source queues
  // retain their per-connection singleton keys; this queue supplies the one
  // cross-provider execution lane.
  INTEGRATION_BACKFILL_ADMISSION_QUEUE,
  // v1.17.0 — Nightscout CGM poll sync. Poll-only (no webhook, no OAuth, no
  // backfill queue — the hourly window walks the recent SGV set).
  NIGHTSCOUT_SYNC_QUEUE,
  // v1.17.0 (F4) — Polar + Oura OAuth poll sync.
  POLAR_SYNC_QUEUE,
  OURA_SYNC_QUEUE,
  // v1.28.x — Strava OAuth poll sync + self-converging boot backfill.
  STRAVA_SYNC_QUEUE,
  STRAVA_BACKFILL_QUEUE,
  // v1.30.x — daily sweep for the native OIDC handoff ledger.
  OIDC_NATIVE_HANDOFF_CLEANUP_QUEUE,
];

const schedules: ScheduleEntry[] = [
  [WITHINGS_SYNC_QUEUE, WITHINGS_SYNC_CRON],
  [WITHINGS_ACTIVITY_QUEUE, WITHINGS_ACTIVITY_CRON],
  [WITHINGS_SLEEP_QUEUE, WITHINGS_SLEEP_CRON],
  // v1.32.23 — hourly ECG catch-net (:41) so watch-only accounts pull their
  // strips without a webhook or a scale.
  [WITHINGS_ECG_SYNC_QUEUE, WITHINGS_ECG_SYNC_CRON],
  // The five OAuth-state / handoff prunes carry `cronIsTheRetry`: their
  // handlers used to warn and carry on, they now fail the job, and a DELETE
  // that could not run will not run any better a second later. The daily tick
  // is the retry. The sync crons above keep the default retries — a provider
  // outage is transient and worth retrying inside the hour.
  [
    WITHINGS_OAUTH_STATE_CLEANUP_QUEUE,
    WITHINGS_OAUTH_STATE_CLEANUP_CRON,
    cronIsTheRetry,
  ],
  // v1.11.0 — WHOOP poll-fallback crons. Recovery/sleep/workout catch
  // dropped webhooks; cycle is the sole driver (no webhook). Staggered off
  // the Withings crons so the hourly ticks don't pile up on one boss poll.
  [WHOOP_RECOVERY_SYNC_QUEUE, WHOOP_RECOVERY_SYNC_CRON],
  [WHOOP_SLEEP_SYNC_QUEUE, WHOOP_SLEEP_SYNC_CRON],
  [WHOOP_WORKOUT_SYNC_QUEUE, WHOOP_WORKOUT_SYNC_CRON],
  [WHOOP_CYCLE_SYNC_QUEUE, WHOOP_CYCLE_SYNC_CRON],
  // v1.11.0 — daily 03:22 Europe/Berlin prune for expired WHOOP OAuth states.
  [
    WHOOP_OAUTH_STATE_CLEANUP_QUEUE,
    WHOOP_OAUTH_STATE_CLEANUP_CRON,
    cronIsTheRetry,
  ],
  // v1.12.0 — hourly Fitbit poll (:08, staggered off WHOOP/Withings) + the
  // daily 03:24 Europe/Berlin prune for expired Fitbit OAuth states.
  [FITBIT_SYNC_QUEUE, FITBIT_SYNC_CRON],
  [
    FITBIT_OAUTH_STATE_CLEANUP_QUEUE,
    FITBIT_OAUTH_STATE_CLEANUP_CRON,
    cronIsTheRetry,
  ],
  // v1.26.0 — hourly Google Health poll (:18, staggered off WHOOP/Fitbit/
  // Nightscout/Polar/Oura) + the daily 03:26 Europe/Berlin prune for expired
  // Google Health OAuth states.
  [GOOGLE_HEALTH_SYNC_QUEUE, GOOGLE_HEALTH_SYNC_CRON],
  [
    GOOGLE_HEALTH_OAUTH_STATE_CLEANUP_QUEUE,
    GOOGLE_HEALTH_OAUTH_STATE_CLEANUP_CRON,
    cronIsTheRetry,
  ],
  // v1.17.0 — hourly Nightscout CGM poll (:11, staggered off the other sync
  // ticks).
  [NIGHTSCOUT_SYNC_QUEUE, NIGHTSCOUT_SYNC_CRON],
  // v1.17.0 (F4) — hourly Polar (:13) + Oura (:15) OAuth polls.
  [POLAR_SYNC_QUEUE, POLAR_SYNC_CRON],
  [OURA_SYNC_QUEUE, OURA_SYNC_CRON],
  // v1.28.x — hourly Strava (:17) OAuth poll.
  [STRAVA_SYNC_QUEUE, STRAVA_SYNC_CRON],
  // v1.30.x — daily 03:28 Europe/Berlin prune for expired native OIDC handoffs.
  [
    OIDC_NATIVE_HANDOFF_CLEANUP_QUEUE,
    OIDC_NATIVE_HANDOFF_CLEANUP_CRON,
    cronIsTheRetry,
  ],
];

/**
 * De-duplication policy per integration-sync queue.
 *
 * The recurring poll queues (Withings / WHOOP / Fitbit / Google Health /
 * Nightscout / Polar / Oura / Strava sync, and every OAuth-state cleanup) are
 * keyless cron ticks — no `singletonKey` on any send — so a policy would only
 * constrain the empty key. They are deliberately absent.
 *
 * The one-shot backfills and repairs below all share the same shape: one job
 * per connection, keyed per user (per provider where a provider can differ),
 * enqueued by a boot-discovery predicate that only stops offering the job once
 * it has COMPLETED. That last property is what made the bug bite — a worker
 * restarting during a heavy account's multi-hour full-history pass appended
 * another identical job per restart, sustaining the boot storm the stagger
 * deferrals exist to damp. `exclusive` covers queued, active, and retry-backoff,
 * so the restart case is closed; and because discovery re-offers the job while
 * the work is still outstanding, a suppressed send can never lose work.
 */
const queuePolicies: QueuePolicyTable = {
  [WITHINGS_ECG_SYNC_QUEUE]: {
    policy: "short",
    reason:
      "Webhook retries share one identity while queued; once work starts, a later replay remains admissible as a rescue if the original exhausts retries.",
  },
  [WHOOP_BACKFILL_QUEUE]: {
    policy: "exclusive",
    reason:
      "Per-connection full-history backfill; long-running, and boot discovery re-enqueues until the connection is marked backfilled.",
  },
  [FITBIT_BACKFILL_QUEUE]: {
    policy: "exclusive",
    reason:
      "Per-connection full-history backfill; boot-discovery driven and self-converging.",
  },
  [GOOGLE_HEALTH_BACKFILL_QUEUE]: {
    policy: "exclusive",
    reason:
      "Per-connection full-history backfill; boot-discovery driven and self-converging.",
  },
  [STRAVA_BACKFILL_QUEUE]: {
    policy: "exclusive",
    reason:
      "Per-connection full-history backfill; boot-discovery driven and self-converging.",
  },
  [GOOGLE_HEALTH_SLEEP_REPAIR_QUEUE]: {
    policy: "exclusive",
    reason:
      "Per-connection one-shot sleep re-read; discovery drops the connection once it is marked repaired.",
  },
  [FITBIT_SLEEP_REPAIR_QUEUE]: {
    policy: "exclusive",
    reason:
      "Per-connection one-shot sleep re-read; discovery drops the connection once it is marked repaired.",
  },
  [SLEEP_TIMELINE_BACKFILL_QUEUE]: {
    policy: "exclusive",
    reason:
      "Per-connection one-shot timeline backfill, keyed per provider+user; discovery drops the connection once its rows carry the new shape.",
  },
  [LAB_BIOMARKER_BACKFILL_QUEUE]: {
    policy: "exclusive",
    reason:
      "Per-user one-shot catalog link-up; discovery drops the user once no unlinked lab readings remain.",
  },
  [INTEGRATION_BACKFILL_ADMISSION_QUEUE]: {
    policy: "exclusive",
    reason:
      "Shared full-history drain; keyed per source job so boot rediscovery cannot duplicate queued, active, or retrying work.",
  },
};

/**
 * Register every integration-sync queue: create, schedule, and bind handlers.
 * Returns the queue names created (for the boot-level aggregate assertion).
 */
export async function registerIntegrationSyncQueues(
  boss: PgBoss,
): Promise<readonly string[]> {
  await createAndSchedule(boss, allQueues, schedules, queuePolicies);
  // pg-boss scopes groupConcurrency to one queue name, so every provider
  // reaches this shared durable queue before doing full-history work. The
  // common group is enforced in PostgreSQL across worker processes/nodes.

  await createAndWork<IntegrationBackfillAdmissionPayload>(
    boss,
    INTEGRATION_BACKFILL_ADMISSION_QUEUE,
    {
      localConcurrency: INTEGRATION_BACKFILL_GLOBAL_CONCURRENCY,
      groupConcurrency: INTEGRATION_BACKFILL_GLOBAL_CONCURRENCY,
    },
    drainIntegrationBackfillAdmission,
  );

  await createAndWork<WithingsSyncPayload>(
    boss,
    WITHINGS_SYNC_QUEUE,
    { localConcurrency: 1 },
    handleWithingsFallbackSync,
  );
  await createAndWork<WithingsActivitySyncPayload>(
    boss,
    WITHINGS_ACTIVITY_QUEUE,
    { localConcurrency: 1 },
    handleWithingsActivitySync,
  );
  await createAndWork<WithingsSleepSyncPayload>(
    boss,
    WITHINGS_SLEEP_QUEUE,
    { localConcurrency: 1 },
    handleWithingsSleepSync,
  );
  await createAndWork<WithingsEcgSyncPayload>(
    boss,
    WITHINGS_ECG_SYNC_QUEUE,
    { localConcurrency: 1 },
    handleWithingsEcgSync,
  );
  await createAndWork<WithingsOAuthStateCleanupPayload>(
    boss,
    WITHINGS_OAUTH_STATE_CLEANUP_QUEUE,
    { localConcurrency: 1 },
    handleWithingsOAuthStateCleanup,
  );
  // v1.11.0 — WHOOP per-resource sync handlers. Webhook-driven per-user +
  // cron full-iteration. Serial concurrency so a backfill-heavy tick never
  // crowds the request pool and stays inside WHOOP's 100 req/min app cap.
  await createAndWork<WhoopSyncPayload>(
    boss,
    WHOOP_RECOVERY_SYNC_QUEUE,
    { localConcurrency: 1 },
    handleWhoopRecoverySync,
  );
  await createAndWork<WhoopSyncPayload>(
    boss,
    WHOOP_SLEEP_SYNC_QUEUE,
    { localConcurrency: 1 },
    handleWhoopSleepSync,
  );
  await createAndWork<WhoopSyncPayload>(
    boss,
    WHOOP_WORKOUT_SYNC_QUEUE,
    { localConcurrency: 1 },
    handleWhoopWorkoutSync,
  );
  await createAndWork<WhoopSyncPayload>(
    boss,
    WHOOP_CYCLE_SYNC_QUEUE,
    { localConcurrency: 1 },
    handleWhoopCycleSync,
  );
  // v1.11.0 — self-converging WHOOP backfill. This source queue retains the
  // per-connection singleton and forwards admitted work to the shared drain.
  await createAndWork<WhoopBackfillPayload>(
    boss,
    WHOOP_BACKFILL_QUEUE,
    { localConcurrency: WHOOP_BACKFILL_CONCURRENCY },
    async (jobs) => {
      for (const job of jobs) {
        await enqueueIntegrationBackfillAdmission(boss, {
          kind: "whoop-backfill",
          data: job.data,
        });
      }
      return jobDone({ jobs: jobs.length });
    },
  );
  await createAndWork<WhoopOAuthStateCleanupPayload>(
    boss,
    WHOOP_OAUTH_STATE_CLEANUP_QUEUE,
    { localConcurrency: 1 },
    handleWhoopOAuthStateCleanup,
  );
  // v1.30.x — daily sweep for the native OIDC handoff ledger.
  await createAndWork<OidcNativeHandoffCleanupPayload>(
    boss,
    OIDC_NATIVE_HANDOFF_CLEANUP_QUEUE,
    { localConcurrency: 1 },
    handleOidcNativeHandoffCleanup,
  );
  // v1.12.0 — Fitbit poll-sync (cron full-iteration; no webhook). Serial
  // concurrency so a backfill-heavy tick never crowds the request pool.
  await createAndWork<FitbitSyncPayload>(
    boss,
    FITBIT_SYNC_QUEUE,
    { localConcurrency: 1 },
    handleFitbitSync,
  );
  // v1.12.0 — self-converging Fitbit backfill. This source queue retains the
  // per-connection singleton and forwards admitted work to the shared drain.
  await createAndWork<FitbitBackfillPayload>(
    boss,
    FITBIT_BACKFILL_QUEUE,
    { localConcurrency: FITBIT_BACKFILL_CONCURRENCY },
    async (jobs) => {
      for (const job of jobs) {
        await enqueueIntegrationBackfillAdmission(boss, {
          kind: "fitbit-backfill",
          data: job.data,
        });
      }
      return jobDone({ jobs: jobs.length });
    },
  );
  // One-shot Fitbit sleep duplicate repair. This source queue retains the
  // per-connection singleton and forwards the watermark-safe bounded sleep
  // re-read to the shared drain.
  await createAndWork<FitbitSleepRepairPayload>(
    boss,
    FITBIT_SLEEP_REPAIR_QUEUE,
    { localConcurrency: FITBIT_SLEEP_REPAIR_CONCURRENCY },
    async (jobs) => {
      for (const job of jobs) {
        await enqueueIntegrationBackfillAdmission(boss, {
          kind: "fitbit-sleep-repair",
          data: job.data,
        });
      }
      return jobDone({ jobs: jobs.length });
    },
  );
  await createAndWork<FitbitOAuthStateCleanupPayload>(
    boss,
    FITBIT_OAUTH_STATE_CLEANUP_QUEUE,
    { localConcurrency: 1 },
    handleFitbitOAuthStateCleanup,
  );
  // v1.26.0 — Google Health poll-sync (cron full-iteration; no webhook). Serial
  // concurrency so a backfill-heavy tick never crowds the request pool.
  await createAndWork<GoogleHealthSyncPayload>(
    boss,
    GOOGLE_HEALTH_SYNC_QUEUE,
    { localConcurrency: 1 },
    handleGoogleHealthSync,
  );
  // v1.26.0 — self-converging Google Health backfill. This source queue
  // retains the per-connection singleton and forwards admitted work to the
  // shared drain.
  await createAndWork<GoogleHealthBackfillPayload>(
    boss,
    GOOGLE_HEALTH_BACKFILL_QUEUE,
    { localConcurrency: GOOGLE_HEALTH_BACKFILL_CONCURRENCY },
    async (jobs) => {
      for (const job of jobs) {
        await enqueueIntegrationBackfillAdmission(boss, {
          kind: "google-health-backfill",
          data: job.data,
        });
      }
      return jobDone({ jobs: jobs.length });
    },
  );
  // v1.28.x — one-shot Google Health sleep duplicate repair. This source
  // queue retains the per-connection singleton and forwards the watermark-safe
  // full sleep-history re-read to the shared drain.
  await createAndWork<GoogleHealthSleepRepairPayload>(
    boss,
    GOOGLE_HEALTH_SLEEP_REPAIR_QUEUE,
    { localConcurrency: GOOGLE_HEALTH_SLEEP_REPAIR_CONCURRENCY },
    async (jobs) => {
      for (const job of jobs) {
        await enqueueIntegrationBackfillAdmission(boss, {
          kind: "google-health-sleep-repair",
          data: job.data,
        });
      }
      return jobDone({ jobs: jobs.length });
    },
  );
  await createAndWork<GoogleHealthOAuthStateCleanupPayload>(
    boss,
    GOOGLE_HEALTH_OAUTH_STATE_CLEANUP_QUEUE,
    { localConcurrency: 1 },
    handleGoogleHealthOAuthStateCleanup,
  );
  // v1.17.1 — one-shot sleep-timeline backfill. This source queue retains the
  // per-(user, provider) singleton and forwards admitted work to the shared
  // drain.
  await createAndWork<SleepTimelineBackfillPayload>(
    boss,
    SLEEP_TIMELINE_BACKFILL_QUEUE,
    { localConcurrency: SLEEP_TIMELINE_BACKFILL_CONCURRENCY },
    async (jobs) => {
      for (const job of jobs) {
        await enqueueIntegrationBackfillAdmission(boss, {
          kind: "sleep-timeline-backfill",
          data: job.data,
        });
      }
      return jobDone({ jobs: jobs.length });
    },
  );
  // v1.18.1 — one-shot lab-biomarker backfill. This source queue retains the
  // per-user singleton and forwards admitted work to the shared drain.
  await createAndWork<LabBiomarkerBackfillPayload>(
    boss,
    LAB_BIOMARKER_BACKFILL_QUEUE,
    { localConcurrency: LAB_BIOMARKER_BACKFILL_CONCURRENCY },
    async (jobs) => {
      for (const job of jobs) {
        await enqueueIntegrationBackfillAdmission(boss, {
          kind: "lab-biomarker-backfill",
          data: job.data,
        });
      }
      return jobDone({ jobs: jobs.length });
    },
  );
  // v1.17.0 — Nightscout CGM poll-cohort sync. The hourly cron tick (no
  // `userId`) walks every configured instance; one user's unreachable host is
  // warned, not fatal.
  await createAndWork<NightscoutSyncPayload>(
    boss,
    NIGHTSCOUT_SYNC_QUEUE,
    { localConcurrency: 1 },
    handleNightscoutSync,
  );
  // v1.17.0 (F4) — Polar + Oura OAuth poll-cohort sync. The hourly cron tick
  // (no `userId`) re-walks every connected user; one user's revoked grant is
  // warned, not fatal.
  await createAndWork<PolarSyncPayload>(
    boss,
    POLAR_SYNC_QUEUE,
    { localConcurrency: 1 },
    handlePolarSync,
  );
  await createAndWork<OuraSyncPayload>(
    boss,
    OURA_SYNC_QUEUE,
    { localConcurrency: 1 },
    handleOuraSync,
  );
  // v1.28.x — Strava OAuth poll-cohort sync (poll-only; webhook deferred). The
  // hourly cron tick (no `userId`) re-walks every connected user; one user's
  // revoked grant is warned, not fatal.
  await createAndWork<StravaSyncPayload>(
    boss,
    STRAVA_SYNC_QUEUE,
    { localConcurrency: 1 },
    handleStravaSync,
  );
  // v1.28.x — self-converging Strava backfill. This source queue retains the
  // per-connection singleton and forwards admitted work to the shared drain.
  await createAndWork<StravaBackfillPayload>(
    boss,
    STRAVA_BACKFILL_QUEUE,
    { localConcurrency: STRAVA_BACKFILL_CONCURRENCY },
    async (jobs) => {
      for (const job of jobs) {
        await enqueueIntegrationBackfillAdmission(boss, {
          kind: "strava-backfill",
          data: job.data,
        });
      }
      return jobDone({ jobs: jobs.length });
    },
  );
  return allQueues;
}

/**
 * Fire-and-forget boot discovery for the self-converging integration backfills.
 * Each pass is idempotent across reboots and never fails worker boot on a miss
 * (errors come back through the helper's result value).
 */
export async function enqueueIntegrationSyncBootDiscovery(): Promise<void> {
  // v1.11.0 — WHOOP backfill. Finds every WHOOP connection not yet backfilled
  // and enqueues one full-history sync per account. A completed backfill stamps
  // `backfillCompletedAt`, dropping the connection from the discovery set.
  try {
    const { enqueued, skipped, error } = await enqueueBootTimeWhoopBackfill(
      bootStaggerSecondsFor("whoop-backfill"),
    );
    if (error) {
      workerLog("error", `[whoop-backfill] boot discovery failed: ${error}`);
    } else {
      workerLog(
        "info",
        `[whoop-backfill] boot discovery: enqueued=${enqueued} skipped=${skipped}`,
      );
    }
  } catch (err) {
    workerLog(
      "error",
      "[whoop-backfill] boot discovery threw an unexpected error",
      err,
    );
  }

  // v1.12.0 — Fitbit backfill. Finds every Fitbit connection not yet
  // backfilled and enqueues one full-history sync per account.
  try {
    const { enqueued, skipped, error } = await enqueueBootTimeFitbitBackfill(
      bootStaggerSecondsFor("fitbit-backfill"),
    );
    if (error) {
      workerLog("error", `[fitbit-backfill] boot discovery failed: ${error}`);
    } else {
      workerLog(
        "info",
        `[fitbit-backfill] boot discovery: enqueued=${enqueued} skipped=${skipped}`,
      );
    }
  } catch (err) {
    workerLog(
      "error",
      "[fitbit-backfill] boot discovery threw an unexpected error",
      err,
    );
  }

  // v1.26.0 — Google Health backfill. Finds every Google Health connection not
  // yet backfilled and enqueues one full-history sync per account.
  try {
    const { enqueued, skipped, error } =
      await enqueueBootTimeGoogleHealthBackfill(
        bootStaggerSecondsFor("google-health-backfill"),
      );
    if (error) {
      workerLog(
        "error",
        `[google-health-backfill] boot discovery failed: ${error}`,
      );
    } else {
      workerLog(
        "info",
        `[google-health-backfill] boot discovery: enqueued=${enqueued} skipped=${skipped}`,
      );
    }
  } catch (err) {
    workerLog(
      "error",
      "[google-health-backfill] boot discovery threw an unexpected error",
      err,
    );
  }

  // v1.28.x — one-shot Google Health sleep duplicate repair. Finds every
  // connection not yet repaired and enqueues one full sleep re-read per
  // account; a completed pass stamps `sleepRepairedAt`.
  try {
    const { enqueued, skipped, error } =
      await enqueueBootTimeGoogleHealthSleepRepair(
        bootStaggerSecondsFor("google-health-sleep-repair"),
      );
    if (error) {
      workerLog(
        "error",
        `[google-health-sleep-repair] boot discovery failed: ${error}`,
      );
    } else {
      workerLog(
        "info",
        `[google-health-sleep-repair] boot discovery: enqueued=${enqueued} skipped=${skipped}`,
      );
    }
  } catch (err) {
    workerLog(
      "error",
      "[google-health-sleep-repair] boot discovery threw an unexpected error",
      err,
    );
  }

  // v1.17.1 — one-shot sleep-timeline backfill. Finds every WHOOP + Withings
  // connection whose sleep rows predate the stamp/shape fix and enqueues one
  // job per (user, provider). A completed pass stamps `sleepTimelineBackfillAt`.
  try {
    const { enqueued, skipped, error } =
      await enqueueBootTimeSleepTimelineBackfill(
        bootStaggerSecondsFor("sleep-timeline-backfill"),
      );
    if (error) {
      workerLog(
        "error",
        `[sleep-timeline-backfill] boot discovery failed: ${error}`,
      );
    } else {
      workerLog(
        "info",
        `[sleep-timeline-backfill] boot discovery: enqueued=${enqueued} skipped=${skipped}`,
      );
    }
  } catch (err) {
    workerLog(
      "error",
      "[sleep-timeline-backfill] boot discovery threw an unexpected error",
      err,
    );
  }

  // v1.28.x — Strava backfill. Finds every Strava connection not yet
  // backfilled and enqueues one full-history sync per account.
  try {
    const { enqueued, skipped, error } = await enqueueBootTimeStravaBackfill(
      bootStaggerSecondsFor("strava-backfill"),
    );
    if (error) {
      workerLog("error", `[strava-backfill] boot discovery failed: ${error}`);
    } else {
      workerLog(
        "info",
        `[strava-backfill] boot discovery: enqueued=${enqueued} skipped=${skipped}`,
      );
    }
  } catch (err) {
    workerLog(
      "error",
      "[strava-backfill] boot discovery threw an unexpected error",
      err,
    );
  }

  // v1.18.1 — one-shot lab-biomarker backfill. Finds every user holding an
  // un-linked live lab reading and enqueues one job each. A completed pass
  // links every reading, dropping the user from the discovery set.
  try {
    const { enqueued, skipped, error } =
      await enqueueBootTimeLabBiomarkerBackfill(
        bootStaggerSecondsFor("lab-biomarker-backfill"),
      );
    if (error) {
      workerLog(
        "error",
        `[lab-biomarker-backfill] boot discovery failed: ${error}`,
      );
    } else {
      workerLog(
        "info",
        `[lab-biomarker-backfill] boot discovery: enqueued=${enqueued} skipped=${skipped}`,
      );
    }
  } catch (err) {
    workerLog(
      "error",
      "[lab-biomarker-backfill] boot discovery threw an unexpected error",
      err,
    );
  }

  // One-shot Fitbit sleep duplicate repair. Finds every connection not yet
  // repaired and enqueues one bounded sleep re-read per account; a completed
  // pass stamps `sleepRepairedAt`.
  try {
    const { enqueued, skipped, error } = await enqueueBootTimeFitbitSleepRepair(
      bootStaggerSecondsFor("fitbit-sleep-repair"),
    );
    if (error) {
      workerLog(
        "error",
        `[fitbit-sleep-repair] boot discovery failed: ${error}`,
      );
    } else {
      workerLog(
        "info",
        `[fitbit-sleep-repair] boot discovery: enqueued=${enqueued} skipped=${skipped}`,
      );
    }
  } catch (err) {
    workerLog(
      "error",
      "[fitbit-sleep-repair] boot discovery threw an unexpected error",
      err,
    );
  }
}
