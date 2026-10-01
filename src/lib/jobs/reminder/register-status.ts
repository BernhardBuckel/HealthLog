/**
 * Status / insight / computed-score queue registrar.
 *
 * Owns the nightly per-metric insight-status ladder (general / BP / weight /
 * pulse / BMI / mood / medication-compliance), the comprehensive-insight
 * pre-generation, the on-demand per-metric status generation, the nightly
 * computed scores (recovery / stress / strain), the proactive Coach nudge, the
 * Coach memory refresh, the period-narrative warm, and the medication
 * low-stock pass.
 *
 * v1.4.37 dead-queue contract: every queue name appears in `allQueues`, its
 * cron (where it has one) appears as a `[QUEUE, CRON]` tuple in `schedules`,
 * and a `createAndWork(boss, QUEUE, …, handler)` binding drains it. The
 * status-wiring guards (`status-cron-candidates`, `insight-pregenerate`,
 * `insight-status-generate`, `recovery-score-queue`,
 * `stress-strain-retention-queue`, `period-narrative-warm`,
 * `coach-memory-refresh-queue`) read THIS module.
 */
import { PgBoss } from "pg-boss";
import { reportWorkerError } from "@/lib/jobs/report-worker-error";
import { recordError } from "@/lib/jobs/worker-status";
import {
  INSIGHT_PREGENERATE_QUEUE,
  INSIGHT_PREGENERATE_CRON,
  type InsightPregeneratePayload,
} from "@/lib/jobs/insight-pregenerate";
import {
  MORNING_DIGEST_REFRESH_QUEUE,
  runMorningDigestRefresh,
  type MorningDigestRefreshPayload,
} from "@/lib/jobs/morning-digest-refresh";
import { DATA_ARRIVAL_QUEUE, handleDataArrival } from "@/lib/jobs/data-arrival";
import {
  REACTION_LINE_QUEUE,
  handleReactionLine,
} from "@/lib/jobs/reaction-line";
import type { ReactionLineJob } from "@/lib/arrivals/reaction-line-shared";
import {
  handleWorkoutInsightGenerate,
  WORKOUT_INSIGHT_GENERATE_CONCURRENCY,
  WORKOUT_INSIGHT_GENERATE_QUEUE,
  type WorkoutInsightGeneratePayload,
} from "@/lib/jobs/workout-insight-generate";
import type { DataArrival } from "@/lib/arrivals/types";
import {
  DAILY_BRIEFING_QUEUE,
  DAILY_BRIEFING_CRON,
  runDailyBriefingTick,
} from "@/lib/jobs/daily-briefing";
import { maybeDispatchDailyBriefing } from "@/lib/daily/daily-briefing-push";
import {
  RECOVERY_SCORE_QUEUE,
  RECOVERY_SCORE_CRON,
  runRecoveryScore,
} from "@/lib/jobs/recovery-score";
import {
  COACH_NUDGE_QUEUE,
  COACH_NUDGE_CRON,
  runCoachNudgeTick,
} from "@/lib/jobs/coach-nudge";
import {
  COACH_REMINDER_SWEEP_QUEUE,
  COACH_REMINDER_SWEEP_CRON,
  runCoachReminderSweep,
} from "@/lib/jobs/coach-reminder-sweep";
import {
  COACH_PLAN_REVIEW_QUEUE,
  COACH_PLAN_REVIEW_CRON,
  runCoachPlanReviewTick,
} from "@/lib/jobs/coach-plan-review";
import {
  MEDICATION_LOW_STOCK_QUEUE,
  MEDICATION_LOW_STOCK_CRON,
  runMedicationLowStockTick,
} from "@/lib/jobs/medication-low-stock";
import {
  STRESS_SCORE_QUEUE,
  STRESS_SCORE_CRON,
  runStressScore,
} from "@/lib/jobs/stress-score";
import {
  STRAIN_SCORE_QUEUE,
  STRAIN_SCORE_CRON,
  runStrainScore,
} from "@/lib/jobs/strain-score";
import {
  PERIOD_NARRATIVE_QUEUE,
  PERIOD_NARRATIVE_CRON,
  runPeriodNarrativeWarm,
  warmOneNarrative,
  type PeriodNarrativePayload,
} from "@/lib/jobs/period-narrative-warm";
import {
  COACH_MEMORY_REFRESH_QUEUE,
  type CoachMemoryRefreshPayload,
} from "@/lib/ai/coach/coach-memory-shared";
import { runCoachMemoryRefresh } from "@/lib/ai/coach/coach-memory-refresh-worker";
import {
  INSIGHT_STATUS_GENERATE_QUEUE,
  INSIGHT_STATUS_GENERATE_CONCURRENCY,
  type InsightStatusGeneratePayload,
} from "@/lib/jobs/insight-status-generate";
import { withBackgroundEvent } from "@/lib/logging/background";
import { jobDone, type JobOutcome } from "@/lib/jobs/job-outcome";
import { jobBudget } from "@/lib/jobs/job-budget";
import { lockedPass, WHOLE_PASS } from "@/lib/jobs/long-pass";
import { INSIGHT_PREGENERATE_EXPIRE_SECONDS } from "@/lib/jobs/insight-pregenerate-shared";
import { PERIOD_NARRATIVE_EXPIRE_SECONDS } from "@/lib/jobs/period-narrative-shared";
import { getWorkerPrisma, workerLog } from "./shared";
import {
  createAndSchedule,
  createAndWork,
  insightRetryOptions,
  nightlyInsightPassOptions,
  type QueuePolicyTable,
  type ScheduleEntry,
} from "./registrar-shared";
import {
  GeneralStatusPayload,
  BloodPressureStatusPayload,
  WeightStatusPayload,
  PulseStatusPayload,
  BmiStatusPayload,
  MoodStatusPayload,
  MedicationComplianceStatusPayload,
  handleGeneralStatusGenerate,
  handleBloodPressureStatusGenerate,
  handleWeightStatusGenerate,
  handlePulseStatusGenerate,
  handleBmiStatusGenerate,
  handleMoodStatusGenerate,
  handleMedicationComplianceStatusGenerate,
  handleInsightPregenerateJob,
  handleInsightStatusGenerate,
} from "./insights-handlers";

const GENERAL_STATUS_QUEUE = "insights-general-status";

const GENERAL_STATUS_CRON = "0 2 * * *"; // daily at 02:00

const BLOOD_PRESSURE_STATUS_QUEUE = "insights-blood-pressure-status";

const BLOOD_PRESSURE_STATUS_CRON = "5 2 * * *"; // daily at 02:05

const WEIGHT_STATUS_QUEUE = "insights-weight-status";

const WEIGHT_STATUS_CRON = "10 2 * * *"; // daily at 02:10

const PULSE_STATUS_QUEUE = "insights-pulse-status";

const PULSE_STATUS_CRON = "15 2 * * *"; // daily at 02:15

const BMI_STATUS_QUEUE = "insights-bmi-status";

const BMI_STATUS_CRON = "20 2 * * *"; // daily at 02:20
// v1.15.20 — mood joins the nightly per-metric status ladder. Same gate +
// discovery as the six older crons (see status-cron-candidates.ts); 02:30
// continues the 5-minute stagger after BMI (02:20) and compliance (02:25).

const MOOD_STATUS_QUEUE = "insights-mood-status";

const MOOD_STATUS_CRON = "30 2 * * *"; // daily at 02:30

const MEDICATION_COMPLIANCE_STATUS_QUEUE =
  "insights-medication-compliance-status";

const MEDICATION_COMPLIANCE_STATUS_CRON = "25 2 * * *"; // daily at 02:25

const allQueues = [
  GENERAL_STATUS_QUEUE,
  BLOOD_PRESSURE_STATUS_QUEUE,
  WEIGHT_STATUS_QUEUE,
  PULSE_STATUS_QUEUE,
  BMI_STATUS_QUEUE,
  // v1.15.20 — mood joins the nightly status ladder. The queue MUST be
  // registered here or pg-boss never provisions it and the 02:30 schedule
  // silently no-ops (the v1.4.37 dead-queue class).
  MOOD_STATUS_QUEUE,
  MEDICATION_COMPLIANCE_STATUS_QUEUE,
  // v1.7.0 — nightly comprehensive-insight pre-generation so the daily
  // briefing is warm before the user opens /insights or the dashboard
  // snapshot. Without this entry the 04:30 schedule silently no-ops.
  INSIGHT_PREGENERATE_QUEUE,
  // v1.8.3 — on-demand per-metric status generation. The read-only status
  // route enqueues here on a cold card; without this entry pg-boss never
  // provisions the queue and the enqueue silently drops. No cron schedule —
  // a send-only queue driven by navigation.
  INSIGHT_STATUS_GENERATE_QUEUE,
  // S4 — event-driven morning digest refresh, enqueued by the sleep-arrival
  // trigger when last night's completed sleep lands. No cron schedule — a
  // send-only queue driven by sleep ingest; without this entry pg-boss never
  // provisions the queue and every enqueue silently drops.
  MORNING_DIGEST_REFRESH_QUEUE,
  // v1.31.0 — the data-arrival spine. Every salient ingest emits here; the
  // worker claims the day's reaction marker and fans out to the reaction
  // surfaces. No cron schedule — a send-only queue driven by ingest; without
  // this entry pg-boss never provisions the queue and every emit silently
  // drops (the v1.4.37 dead-queue class).
  DATA_ARRIVAL_QUEUE,
  // v1.31.0 — the day's single arrival reaction line. Send-only, enqueued by
  // the spine worker on the pass that claimed the day's marker. Without this
  // entry pg-boss never provisions the queue and every enqueue silently drops.
  REACTION_LINE_QUEUE,
  // v1.31.0 — the per-workout Activity Insight, dispatched by the spine when a
  // workout lands. No cron schedule — nothing warms it and no read path
  // triggers it, so this entry is the only thing that provisions the queue.
  WORKOUT_INSIGHT_GENERATE_QUEUE,
  // v1.10.0 — computed scores (WX-C / WX-E). Nightly Recovery / Stress /
  // Strain compute + store. The queue MUST be registered here or pg-boss
  // never provisions it and the nightly schedule silently never fires.
  RECOVERY_SCORE_QUEUE,
  STRESS_SCORE_QUEUE,
  STRAIN_SCORE_QUEUE,
  // v1.11.0 — nightly period-narrative warm + single-user warm enqueued by
  // the read-only narrative GET.
  PERIOD_NARRATIVE_QUEUE,
  // v1.11.1 — combined Coach memory-refresh (rolling conversation summary +
  // durable fact extraction), enqueued fire-and-forget from a long chat turn.
  COACH_MEMORY_REFRESH_QUEUE,
  // v1.15.20 — proactive Coach nudge. Without this entry the daily 05:15
  // schedule silently no-ops and no nudge ever fires.
  COACH_NUDGE_QUEUE,
  // v1.22 (M4) — daily Coach-reminder sweep. Without this entry the 05:20
  // schedule silently no-ops and no "remind me" reminder ever surfaces.
  COACH_REMINDER_SWEEP_QUEUE,
  // v1.22 (W9, C2) — daily n-of-1 experiment review worker. Without this entry
  // the 05:25 schedule silently no-ops and no experiment read-back is written.
  COACH_PLAN_REVIEW_QUEUE,
  // v1.16.11 — daily medication low-stock pass. Without this entry the 09:00
  // schedule silently no-ops and no low-stock alert ever fires.
  MEDICATION_LOW_STOCK_QUEUE,
  // S5 — daily-briefing fallback cron. The primary morning push rides the
  // sleep-arrival finalisation hook below; this queue is the fixed local-morning
  // slot for the no-sleep-arrived case. Without this entry the every-15-min
  // schedule silently no-ops and the fallback push never fires.
  DAILY_BRIEFING_QUEUE,
];

const schedules: ScheduleEntry[] = [
  [GENERAL_STATUS_QUEUE, GENERAL_STATUS_CRON, nightlyInsightPassOptions],
  [
    BLOOD_PRESSURE_STATUS_QUEUE,
    BLOOD_PRESSURE_STATUS_CRON,
    nightlyInsightPassOptions,
  ],
  [WEIGHT_STATUS_QUEUE, WEIGHT_STATUS_CRON, nightlyInsightPassOptions],
  [PULSE_STATUS_QUEUE, PULSE_STATUS_CRON, nightlyInsightPassOptions],
  [BMI_STATUS_QUEUE, BMI_STATUS_CRON, nightlyInsightPassOptions],
  // v1.15.20 — mood status nightly, continuing the 02:xx ladder.
  [MOOD_STATUS_QUEUE, MOOD_STATUS_CRON, nightlyInsightPassOptions],
  [
    MEDICATION_COMPLIANCE_STATUS_QUEUE,
    MEDICATION_COMPLIANCE_STATUS_CRON,
    nightlyInsightPassOptions,
  ],
  // v1.7.0 — nightly 04:30 Europe/Berlin comprehensive-insight
  // pre-generation. Budget-gated per user inside the handler.
  [
    INSIGHT_PREGENERATE_QUEUE,
    INSIGHT_PREGENERATE_CRON,
    {
      ...insightRetryOptions,
      expireInSeconds: INSIGHT_PREGENERATE_EXPIRE_SECONDS,
    },
  ],
  // v1.10.0 — computed scores (WX-C). Nightly 04:45 Europe/Berlin
  // Recovery-score compute + store, after the rollup-feeding consolidation
  // + drain so the signals it reads are already folded.
  [RECOVERY_SCORE_QUEUE, RECOVERY_SCORE_CRON],
  // v1.10.0 — computed scores (WX-E). Nightly 04:50 Europe/Berlin
  // Stress-score compute + store, after the dense intra-day retention
  // drain so the HRV inputs it reads are settled.
  [STRESS_SCORE_QUEUE, STRESS_SCORE_CRON],
  // v1.10.0 — computed scores (WX-E). Nightly 04:55 Europe/Berlin
  // Strain-score compute + store, after the recovery + stress passes so
  // the nightly score writes stay ordered.
  [STRAIN_SCORE_QUEUE, STRAIN_SCORE_CRON],
  // v1.11.0 — nightly 05:05 Europe/Berlin period-narrative warm. The
  // handler only fans out on a week (Mon) / month (1st) boundary; every
  // other night is a cheap no-op. Budget-gated per user inside the runner.
  [
    PERIOD_NARRATIVE_QUEUE,
    PERIOD_NARRATIVE_CRON,
    {
      ...insightRetryOptions,
      expireInSeconds: PERIOD_NARRATIVE_EXPIRE_SECONDS,
    },
  ],
  // v1.15.20 — daily 05:15 Europe/Berlin proactive Coach nudge, after
  // the 04:45–04:55 score crons so the recovery-score trigger reads
  // settled rows. Deterministic triggers only — no AI call on this path.
  [COACH_NUDGE_QUEUE, COACH_NUDGE_CRON],
  // v1.22 (M4) — daily 05:20 Europe/Berlin Coach-reminder sweep, just after
  // the nudge tick. Flips overdue reminders to `due` + mints plan-review
  // reminders from passed CoachPlan.reviewDate. In-app surface only; no push.
  [COACH_REMINDER_SWEEP_QUEUE, COACH_REMINDER_SWEEP_CRON],
  // v1.22 (W9, C2) — daily 05:25 Europe/Berlin n-of-1 experiment review, just
  // after the reminder sweep mints the plan-review reminders this worker reads.
  // Writes the grounded before/after read-back; no provider call, no push.
  [COACH_PLAN_REVIEW_QUEUE, COACH_PLAN_REVIEW_CRON],
  // v1.16.11 — medication low-stock pass at 09:00 Europe/Berlin: a
  // supply alert is an errand prompt, so it fires at a time the user
  // can act on it. Once daily; the per-medication stamp keeps it at
  // one push per threshold crossing.
  [MEDICATION_LOW_STOCK_QUEUE, MEDICATION_LOW_STOCK_CRON],
  // S5 — daily-briefing fallback slot. Ticks every 15 min; the per-user
  // local-hour gate inside the tick selects each user's fixed morning slot, so
  // one UTC cron serves every timezone. The `push_attempts` cap suppresses it
  // when the sleep-arrival finalisation push already fired this morning.
  [DAILY_BRIEFING_QUEUE, DAILY_BRIEFING_CRON],
];

/**
 * De-duplication policy per status queue.
 *
 * Most queues here are keyless nightly cron ticks — no `singletonKey` on any
 * send — so a policy would only constrain the empty key and is deliberately
 * omitted. The LLM-bound warm queues (insight pre-generate, per-metric status
 * generate, period narrative, Coach memory refresh) already pass an explicit
 * `singletonSeconds` on every send, which populates `singleton_on` and is
 * therefore constrained by pg-boss's `job_i4` index REGARDLESS of queue policy.
 * Those already de-duplicate today; changing their policy would layer a second,
 * differently-shaped constraint over a working one for no gain, so they are
 * left alone.
 *
 * That leaves exactly two queues here whose keys would otherwise be inert.
 */
const queuePolicies: QueuePolicyTable = {
  // v1.31.0 — the arrival spine's day-scoped keys
  // (`arrival:<user>:<kind>:<localDate>`) carry the SAME requirement as the
  // morning refresh below, for the same reason: a user's local date cannot be
  // expressed as a wall-clock `singletonSeconds` window, so the date lives in
  // the key and the policy has to honour it. Under `standard` the key
  // coalesces nothing at all, and a device posting a batch per minute would
  // queue a job per batch instead of one per day.
  //
  // `exclusive` rather than `short` because the handler is self-converging:
  // it claims a durable unique row, so a second run while the first is active
  // is pure duplicated work, and the next ingest re-emits anyway.
  //
  // The `workout` kind is the deliberate exception — it is keyed per workout
  // id and DOES pass `singletonSeconds`, so it is constrained by pg-boss's
  // `job_i4` index regardless of this policy. Both shapes coexist on one
  // queue safely: they populate different columns.
  // The reaction line's key is `reaction-line:<user>:<kind>:<localDate>` — the
  // same day-scoped shape, and for the same reason: a wall-clock window cannot
  // express a user's local date. `exclusive` is what makes the key real, and it
  // is the queue-level restatement of the durable claim the worker re-checks
  // (`generatedAt`) before it spends anything.
  [REACTION_LINE_QUEUE]: {
    policy: "exclusive",
    reason:
      "Day-scoped per-kind keys carry the user's local date; under standard they coalesce nothing and a retried spine job could stack a second provider call behind the first.",
  },
  [DATA_ARRIVAL_QUEUE]: {
    policy: "exclusive",
    reason:
      "Day-scoped arrival keys carry the user's local date; under standard they coalesce nothing and a chatty ingest queues a job per batch. The worker claims a durable unique row, so a concurrent second run is pure duplicated work.",
  },
  // The sleep-arrival trigger has seven write seams that can each enqueue for
  // the same user and the same local date. The key is
  // `morning-refresh:<user>:<localDate>`, and `exclusive` turns that into a
  // real at-most-once-per-user-per-local-morning contract across queued,
  // active, and retry-backoff states.
  //
  // `singletonSeconds` is NOT the tool here and the existing comment at the
  // enqueue site says so: its window is a floor() over wall-clock, which does
  // not line up with a user's local date, so it would both split one morning
  // across two buckets and merge two mornings into one. The local date already
  // lives in the key; the policy just has to honour it.
  [MORNING_DIGEST_REFRESH_QUEUE]: {
    policy: "exclusive",
    reason:
      "Seven sleep-write seams enqueue the same user+localDate key; exclusive makes the at-most-once-per-morning contract real. A wall-clock singletonSeconds window cannot express a local date.",
  },
};

/**
 * Register every status / insight / computed-score queue. Returns the queue
 * names created (for the boot-level aggregate assertion).
 */
export async function registerStatusQueues(
  boss: PgBoss,
): Promise<readonly string[]> {
  await createAndSchedule(boss, allQueues, schedules, queuePolicies);

  await createAndWork<GeneralStatusPayload>(
    boss,
    GENERAL_STATUS_QUEUE,
    { localConcurrency: 1 },
    lockedPass(
      GENERAL_STATUS_QUEUE,
      () => WHOLE_PASS,
      handleGeneralStatusGenerate,
    ),
  );
  await createAndWork<BloodPressureStatusPayload>(
    boss,
    BLOOD_PRESSURE_STATUS_QUEUE,
    { localConcurrency: 1 },
    lockedPass(
      BLOOD_PRESSURE_STATUS_QUEUE,
      () => WHOLE_PASS,
      handleBloodPressureStatusGenerate,
    ),
  );
  await createAndWork<WeightStatusPayload>(
    boss,
    WEIGHT_STATUS_QUEUE,
    { localConcurrency: 1 },
    lockedPass(
      WEIGHT_STATUS_QUEUE,
      () => WHOLE_PASS,
      handleWeightStatusGenerate,
    ),
  );
  await createAndWork<PulseStatusPayload>(
    boss,
    PULSE_STATUS_QUEUE,
    { localConcurrency: 1 },
    lockedPass(PULSE_STATUS_QUEUE, () => WHOLE_PASS, handlePulseStatusGenerate),
  );
  await createAndWork<BmiStatusPayload>(
    boss,
    BMI_STATUS_QUEUE,
    { localConcurrency: 1 },
    lockedPass(BMI_STATUS_QUEUE, () => WHOLE_PASS, handleBmiStatusGenerate),
  );
  await createAndWork<MoodStatusPayload>(
    boss,
    MOOD_STATUS_QUEUE,
    { localConcurrency: 1 },
    lockedPass(MOOD_STATUS_QUEUE, () => WHOLE_PASS, handleMoodStatusGenerate),
  );
  await createAndWork<MedicationComplianceStatusPayload>(
    boss,
    MEDICATION_COMPLIANCE_STATUS_QUEUE,
    { localConcurrency: 1 },
    lockedPass(
      MEDICATION_COMPLIANCE_STATUS_QUEUE,
      () => WHOLE_PASS,
      handleMedicationComplianceStatusGenerate,
    ),
  );
  // v1.7.0 — nightly comprehensive-insight pre-generation.
  //
  // v1.16.8 — localConcurrency 2 (was 1). The queue carries BOTH the
  // scheduled 04:30 cohort walk AND the visit-triggered per-user force
  // warms; with a single slot a force warm enqueued during the nightly
  // batch sat behind the entire cohort and the visiting user stared at
  // a cold dashboard for the duration. Two slots let one force warm run
  // alongside the batch while still bounding provider-level concurrency
  // (the cohort walk is itself sequential per user, and the content-hash
  // gate + per-user budget gate inside the handler cover the rare
  // double-tick overlap the old single slot serialised away).
  await createAndWork<InsightPregeneratePayload>(
    boss,
    INSIGHT_PREGENERATE_QUEUE,
    { localConcurrency: 2 },
    // The cohort walk is one pass at a time; a forced warm is one per
    // account, so it never waits behind the walk.
    lockedPass(
      INSIGHT_PREGENERATE_QUEUE,
      (job) =>
        job.data?.force && job.data.userId
          ? `user:${job.data.userId}`
          : WHOLE_PASS,
      handleInsightPregenerateJob,
    ),
  );
  // S4 — event-driven morning digest refresh. One forced comprehensive
  // regeneration per user per local morning, enqueued by the sleep-arrival
  // trigger. Single-flight: the enqueue-side singletonKey already collapses a
  // night's samples into one job, and the handler's marker re-check makes a
  // rare double-fire a no-op, so one slot is enough and bounds the provider
  // concurrency the same way the nightly path does.
  await createAndWork<MorningDigestRefreshPayload>(
    boss,
    MORNING_DIGEST_REFRESH_QUEUE,
    { localConcurrency: 1 },
    async (jobs): Promise<JobOutcome> => {
      return withBackgroundEvent("job.morning_digest_refresh", async (evt) => {
        // The counts the batch already decides on: one refresh per job, and
        // the finalised subset that reaches the morning push seam.
        let refreshed = 0;
        let finalised = 0;
        for (const job of jobs) {
          try {
            const result = await runMorningDigestRefresh(
              getWorkerPrisma(),
              job.data,
            );
            refreshed++;
            evt.addMeta(
              "morning_refresh",
              `${result.status}:${result.comprehensive ?? "none"}`,
            );
            // S5 — the day just finalised (last night's sleep folded in), so
            // this is the natural, event-driven moment to fire the calm morning
            // push carrying the FINAL digest. Fully fault-isolated inside the
            // seam; the opt-in / morning-window / once-per-day gates all live
            // there, so a user who never opted in or is outside the window is a
            // clean no-op. The fallback cron covers the no-sleep-arrived case.
            if (result.status === "finalised") {
              finalised++;
              const pushResult = await maybeDispatchDailyBriefing(
                getWorkerPrisma(),
                job.data.userId,
                new Date(),
              );
              evt.addMeta("daily_briefing_push", pushResult);
            }
          } catch (err) {
            recordError();
            workerLog("error", "[morning-digest-refresh] pass failed", err);
            // Rethrow so the queue's retry policy re-runs the refresh; the
            // marker re-check keeps a retry idempotent.
            throw err;
          }
        }
        return jobDone({ refreshed, finalised });
      });
    },
  );
  // v1.8.3 — on-demand per-metric status generation enqueued by the
  // read-only status route on a cold card. Low concurrency so a first
  // visit that cold-misses several cards can't saturate the Prisma pool
  // or fan out an unbounded number of concurrent provider calls.
  await createAndWork<InsightStatusGeneratePayload>(
    boss,
    INSIGHT_STATUS_GENERATE_QUEUE,
    { localConcurrency: INSIGHT_STATUS_GENERATE_CONCURRENCY },
    handleInsightStatusGenerate,
  );
  // v1.10.0 — computed scores (WX-C). Nightly Recovery-score compute +
  // store. The cron tick carries an empty payload; the runner iterates every
  // eligible user and upserts one `COMPUTED RECOVERY_SCORE` row per scored
  // day (idempotent — a re-fire overwrites in place). Single-flight so two
  // ticks never double-walk the cohort.
  await createAndWork(
    boss,
    RECOVERY_SCORE_QUEUE,
    { localConcurrency: 1 },
    async (): Promise<JobOutcome> => {
      try {
        const summary = await runRecoveryScore(getWorkerPrisma());
        workerLog(
          "info",
          `[recovery-score] considered=${summary.considered} stored=${summary.stored} insufficient=${summary.insufficient} errored=${summary.errored}`,
        );
        return jobDone({
          considered: summary.considered,
          stored: summary.stored,
          insufficient: summary.insufficient,
          errored: summary.errored,
        });
      } catch (err) {
        recordError();
        workerLog("error", "[recovery-score] pass failed", err);
        throw err;
      }
    },
  );
  // v1.15.20 — proactive Coach nudge. Single-flight; the push-attempts
  // ledger caps a user at one nudge per rolling week, so an overlapping
  // tick would only waste reads. Deterministic triggers, no AI call.
  await createAndWork(
    boss,
    COACH_NUDGE_QUEUE,
    { localConcurrency: 1 },
    async (): Promise<JobOutcome> => {
      return withBackgroundEvent("job.coach_nudge", async (evt) => {
        try {
          const summary = await runCoachNudgeTick(
            getWorkerPrisma(),
            new Date(),
          );
          evt.setBackground({
            task_name: "job.coach_nudge",
            result: {
              candidates_scanned: summary.candidatesScanned,
              dispatched: summary.dispatched,
              persisted: summary.persisted,
              skipped_opted_out: summary.skippedOptedOut,
              skipped_no_provider: summary.skippedNoProvider,
              skipped_unavailable: summary.skippedUnavailable,
              skipped_recent_nudge: summary.skippedRecentNudge,
              skipped_recent_engagement: summary.skippedRecentEngagement,
              skipped_no_trigger: summary.skippedNoTrigger,
              skipped_no_channel: summary.skippedNoChannel,
              failed: summary.failed,
            },
          });
          // A per-user failure never fails this pass — it rides out as the
          // `failed` count, exactly as it does in the wide event.
          return jobDone({
            candidates_scanned: summary.candidatesScanned,
            dispatched: summary.dispatched,
            persisted: summary.persisted,
            failed: summary.failed,
          });
        } catch (err) {
          evt.setError(err);
          recordError();
          throw err;
        }
      });
    },
  );
  // v1.16.11 — medication low-stock pass. Single-flight; the
  // per-medication stamp makes a re-fire idempotent (already-notified
  // crossings skip), so an overlapping tick would only waste reads.
  await createAndWork(
    boss,
    MEDICATION_LOW_STOCK_QUEUE,
    { localConcurrency: 1 },
    async (): Promise<JobOutcome> => {
      return withBackgroundEvent("job.medication_low_stock", async (evt) => {
        try {
          const summary = await runMedicationLowStockTick(
            getWorkerPrisma(),
            new Date(),
          );
          evt.setBackground({
            task_name: "job.medication_low_stock",
            result: {
              users_scanned: summary.usersScanned,
              skipped_threshold_off: summary.skippedThresholdOff,
              medications_evaluated: summary.medicationsEvaluated,
              notified: summary.notified,
              rearmed: summary.rearmed,
              skipped_already_notified: summary.skippedAlreadyNotified,
              skipped_above_threshold: summary.skippedAboveThreshold,
              skipped_no_runway: summary.skippedNoRunway,
              skipped_no_channel: summary.skippedNoChannel,
              failed: summary.failed,
            },
          });
          // A per-medication failure never fails this pass — it rides out as
          // the `failed` count.
          return jobDone({
            users_scanned: summary.usersScanned,
            medications_evaluated: summary.medicationsEvaluated,
            notified: summary.notified,
            rearmed: summary.rearmed,
            failed: summary.failed,
          });
        } catch (err) {
          evt.setError(err);
          recordError();
          throw err;
        }
      });
    },
  );
  // v1.31.0 — the data-arrival spine. Single-flight: the worker's whole job is
  // to claim a durable unique row, so two slots would only race each other for
  // a claim exactly one of them can win. It makes no provider call — a
  // module-graph test pins that — so one slot costs nothing in throughput.
  await createAndWork<DataArrival>(
    boss,
    DATA_ARRIVAL_QUEUE,
    { localConcurrency: 1 },
    handleDataArrival,
  );
  // v1.31.0 — the arrival reaction line. Single-flight: this is the spine's
  // ONE provider call, and a second concurrent slot would only race the same
  // durable `generatedAt` claim exactly one of them can win.
  await createAndWork<ReactionLineJob>(
    boss,
    REACTION_LINE_QUEUE,
    { localConcurrency: 1 },
    handleReactionLine,
  );
  // v1.31.0 — the per-workout Activity Insight. Serial: this IS the provider
  // path the spine deliberately does not walk, so it stays off the request pool
  // and cannot fan out concurrent completions when several workouts land in one
  // sync.
  await createAndWork<WorkoutInsightGeneratePayload>(
    boss,
    WORKOUT_INSIGHT_GENERATE_QUEUE,
    { localConcurrency: WORKOUT_INSIGHT_GENERATE_CONCURRENCY },
    handleWorkoutInsightGenerate,
  );
  // S5 — daily-briefing fallback slot. Single-flight; the `push_attempts`
  // frequency cap makes an overlapping tick a no-op (a second same-day attempt
  // is suppressed), and the tick only loads a digest for opted-in users at
  // their exact local fallback hour. No provider call — it reads the cached
  // digest and dispatches the deterministic line + cached lead.
  await createAndWork(
    boss,
    DAILY_BRIEFING_QUEUE,
    { localConcurrency: 1 },
    async (): Promise<JobOutcome> => {
      return withBackgroundEvent("job.daily_briefing", async (evt) => {
        try {
          const summary = await runDailyBriefingTick(
            getWorkerPrisma(),
            new Date(),
          );
          evt.setBackground({
            task_name: "job.daily_briefing",
            result: {
              candidates_scanned: summary.candidatesScanned,
              in_slot: summary.inSlot,
              sent: summary.sent,
              suppressed_frequency: summary.suppressedFrequency,
              no_digest: summary.noDigest,
              opted_out: summary.optedOut,
              no_channel: summary.noChannel,
              outside_window: summary.outsideWindow,
              failed: summary.failed,
            },
          });
          // Most ticks land outside every user's slot; that is the tick doing
          // its job, so a zero `sent` is a success with zero counts.
          return jobDone({
            candidates_scanned: summary.candidatesScanned,
            in_slot: summary.inSlot,
            sent: summary.sent,
            failed: summary.failed,
          });
        } catch (err) {
          evt.setError(err);
          recordError();
          throw err;
        }
      });
    },
  );
  // v1.10.0 — computed scores (WX-E). Nightly Stress-score (HRV-derived
  // proxy) compute + store. Single-flight so two ticks never double-walk
  // the cohort. The runner iterates every eligible user and upserts one
  // `COMPUTED STRESS_SCORE` row per scored day (idempotent — a re-fire
  // overwrites in place).
  await createAndWork(
    boss,
    STRESS_SCORE_QUEUE,
    { localConcurrency: 1 },
    async (): Promise<JobOutcome> => {
      try {
        const summary = await runStressScore(getWorkerPrisma());
        workerLog(
          "info",
          `[stress-score] considered=${summary.considered} stored=${summary.stored} insufficient=${summary.insufficient} errored=${summary.errored}`,
        );
        return jobDone({
          considered: summary.considered,
          stored: summary.stored,
          insufficient: summary.insufficient,
          errored: summary.errored,
        });
      } catch (err) {
        recordError();
        workerLog("error", "[stress-score] pass failed", err);
        throw err;
      }
    },
  );
  // v1.10.0 — computed scores (WX-E). Nightly Strain-score (Banister TRIMP
  // cardio-load) compute + store. Single-flight; upserts one `COMPUTED
  // STRAIN_SCORE` row per scored day (idempotent).
  await createAndWork(
    boss,
    STRAIN_SCORE_QUEUE,
    { localConcurrency: 1 },
    async (): Promise<JobOutcome> => {
      try {
        const summary = await runStrainScore(getWorkerPrisma());
        workerLog(
          "info",
          `[strain-score] considered=${summary.considered} stored=${summary.stored} insufficient=${summary.insufficient} errored=${summary.errored}`,
        );
        return jobDone({
          considered: summary.considered,
          stored: summary.stored,
          insufficient: summary.insufficient,
          errored: summary.errored,
        });
      } catch (err) {
        recordError();
        workerLog("error", "[strain-score] pass failed", err);
        throw err;
      }
    },
  );
  // v1.11.0 — period-narrative warm. A scheduled tick (no `userId`) runs the
  // boundary-gated nightly fan-out; a `userId` payload runs a single-user warm
  // enqueued by the read-only GET on a cold/stale read. Single-flight so two
  // ticks never double-walk the cohort; the per-user budget gate covers the
  // fan-out and the enqueue `singletonKey` covers the single-user path.
  await createAndWork<PeriodNarrativePayload>(
    boss,
    PERIOD_NARRATIVE_QUEUE,
    { localConcurrency: 1 },
    lockedPass(
      PERIOD_NARRATIVE_QUEUE,
      (job) => (job.data?.userId ? `user:${job.data.userId}` : WHOLE_PASS),
      async (jobs): Promise<JobOutcome> => {
        // Two modes on one queue, so the outcome counts them separately: a
        // non-boundary night is a scheduled pass that generated nothing, which
        // is a success with zero counts, not an idle queue.
        let singleUser = 0;
        let scheduled = 0;
        let generated = 0;
        let failed = 0;
        let stoppedEarly = false;
        for (const job of jobs) {
          try {
            if (job.data?.userId) {
              await warmOneNarrative(job.data);
              singleUser++;
            } else {
              const summary = await runPeriodNarrativeWarm(getWorkerPrisma(), {
                shouldStop: jobBudget(jobs),
              });
              scheduled++;
              generated += summary.generated;
              failed += summary.failed;
              stoppedEarly ||= summary.stoppedEarly;
              workerLog(
                "info",
                `[period-narrative] periods=${summary.periods.join(",") || "none"} total=${summary.total} generated=${summary.generated} cached=${summary.cached} skipped=${summary.skipped} insufficient=${summary.insufficient} failed=${summary.failed} budget=${summary.budgetBlocked}`,
              );
            }
          } catch (err) {
            recordError();
            await reportWorkerError(PERIOD_NARRATIVE_QUEUE, err, {
              mode: job.data?.userId ? "single-user" : "scheduled",
            });
            throw err;
          }
        }
        return jobDone({
          single_user: singleUser,
          scheduled,
          generated,
          failed,
          stopped_early: stoppedEarly,
        });
      },
    ),
  );
  // v1.11.1 — combined Coach memory refresh: rolling conversation summary +
  // durable fact extraction for one long conversation. localConcurrency 1 so a
  // burst of long-conversation turns can't fan out concurrent provider calls;
  // each step is budget-gated inside runStatusCompletion and fault-isolated.
  await createAndWork<CoachMemoryRefreshPayload>(
    boss,
    COACH_MEMORY_REFRESH_QUEUE,
    { localConcurrency: 1 },
    async (jobs): Promise<JobOutcome> => {
      // An incomplete payload is skipped rather than failed, so it has to be
      // countable — otherwise a queue full of them reads as a clean run.
      let refreshed = 0;
      let skippedIncomplete = 0;
      for (const job of jobs) {
        if (!job.data?.conversationId || !job.data?.userId) {
          skippedIncomplete++;
          continue;
        }
        try {
          await runCoachMemoryRefresh(job.data);
          refreshed++;
        } catch (err) {
          recordError();
          workerLog("error", "[coach-memory-refresh] failed", err);
          throw err;
        }
      }
      return jobDone({
        refreshed,
        skipped_incomplete: skippedIncomplete,
      });
    },
  );

  // v1.22 (M4) — daily Coach-reminder sweep. Single-flight; surfacing an
  // overdue reminder into the user's Coach thread and minting plan-review
  // reminders are both idempotent across re-fires (an already-surfaced
  // reminder is not re-written; a plan whose reviewDate was cleared is not
  // re-minted). No provider call, no push — the message body is a
  // deterministic localized template around the user's own note.
  await createAndWork(
    boss,
    COACH_REMINDER_SWEEP_QUEUE,
    { localConcurrency: 1 },
    async (): Promise<JobOutcome> => {
      return withBackgroundEvent("job.coach_reminder_sweep", async (evt) => {
        try {
          const summary = await runCoachReminderSweep(
            getWorkerPrisma(),
            new Date(),
          );
          evt.setBackground({
            task_name: "job.coach_reminder_sweep",
            result: {
              reminders_due: summary.remindersDue,
              plan_reviews_minted: summary.planReviewsMinted,
              context_surfaced: summary.contextSurfaced,
              nag_dismissed: summary.nagDismissed,
              errored: summary.errored,
            },
          });
          return jobDone({
            reminders_due: summary.remindersDue,
            plan_reviews_minted: summary.planReviewsMinted,
            context_surfaced: summary.contextSurfaced,
            nag_dismissed: summary.nagDismissed,
            errored: summary.errored,
          });
        } catch (err) {
          evt.setError(err);
          recordError();
          throw err;
        }
      });
    },
  );

  // v1.22 (W9, C2) — n-of-1 experiment review worker: reads the plan-review
  // reminders the sweep minted and writes the grounded before/after read-back
  // into the plan's encrypted outcome column, flipping it to `reviewed`.
  // Idempotent (a reviewed plan is not re-processed). No provider call, no push.
  await createAndWork(
    boss,
    COACH_PLAN_REVIEW_QUEUE,
    { localConcurrency: 1 },
    async (): Promise<JobOutcome> => {
      return withBackgroundEvent("job.coach_plan_review", async (evt) => {
        try {
          const summary = await runCoachPlanReviewTick(
            getWorkerPrisma(),
            new Date(),
          );
          evt.setBackground({
            task_name: "job.coach_plan_review",
            result: {
              reviewed: summary.reviewed,
              insufficient: summary.insufficient,
              errored: summary.errored,
            },
          });
          return jobDone({
            reviewed: summary.reviewed,
            insufficient: summary.insufficient,
            errored: summary.errored,
          });
        } catch (err) {
          evt.setError(err);
          recordError();
          throw err;
        }
      });
    },
  );

  return allQueues;
}
