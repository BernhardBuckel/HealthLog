/**
 * Absolute safety-floor escalation push (v1.18.6).
 *
 * Bridges a {@link SafetyFloorDecision} (from `safety-floors.ts`, already
 * confirm-gated) to the notification dispatcher at the URGENT level, reusing
 * the same urgent SYSTEM_ALERT + 24h-dedup mechanics as the illness red-flag
 * push (`red-flag-notify.ts`).
 *
 * Copy framing (firm, safety-reviewed):
 *   - NEVER diagnoses (no "hypertensive emergency", no "DKA").
 *   - ASYMPTOMATIC breach → "re-check and contact your doctor" copy.
 *   - SYMPTOM-COUPLED breach → emergency copy ("call emergency services").
 *   - The body always echoes the (already re-confirmed) reading value.
 *
 * Dedup: at most one push per (user, reason) per rolling 24h window, anchored
 * on a record event keyed by reason — so a user re-checking a
 * stubbornly-high reading repeatedly doesn't get spammed. Owner-scoped, never
 * throws (a notification failure must not break the measurement write).
 */
import { prisma } from "@/lib/db";
import { getEvent } from "@/lib/logging/context";
import { dispatchLocalisedNotification } from "@/lib/notifications/dispatch-localised";
import { claimNotificationEvent } from "@/lib/notifications/reminder-dedup";
import { convertGlucose, type GlucoseUnit } from "@/lib/glucose";
import {
  GLUCOSE_HYPO,
  GLUCOSE_HYPO_SEVERE,
  type SafetyFloorDecision,
  type SafetyFloorReason,
} from "@/lib/illness/safety-floors";

/** One escalation per (user, reason) per this window. */
const DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Stable event key prefix so the dedupe lookup is exact-matchable. */
const LEDGER_REASON_PREFIX = "safety_floor:";

/**
 * The i18n title/body keys for a decision. Two body variants per reason: the
 * asymptomatic "contact your doctor" copy and the symptom-coupled emergency
 * copy. Every key below resolves in all six locale bundles (i18n integrity
 * guarantee enforced by the locale-integrity test).
 */
function copyKeysFor(decision: SafetyFloorDecision): {
  titleKey: string;
  messageKey: string;
} {
  const variant = decision.symptomCoupled ? "Emergency" : "Doctor";
  const reasonKey: Record<SafetyFloorReason, string> = {
    bp_hypertensive: "bpHigh",
    bp_hypotensive: "bpLow",
    glucose_hypo: "glucoseLow",
    glucose_hypo_severe: "glucoseLowSevere",
    glucose_hyper: "glucoseHigh",
  };
  return {
    titleKey: `safety.floor.${reasonKey[decision.reason]}Title`,
    messageKey: `safety.floor.${reasonKey[decision.reason]}${variant}`,
  };
}

/**
 * Body params — the re-confirmed reading value(s) echoed into the copy.
 *
 * Glucose is stored canonically in mg/dL (`decision.value`), but the escalation
 * push must speak the user's own display unit — a mmol/L user reading "70
 * mg/dL" mid-hypo is the wrong unit at the single most safety-critical moment.
 * `glucoseUnit` is resolved by the caller (`safety-floor-check.ts`) from
 * `User.glucoseUnit`; every glucose copy key takes `{value} {unit}` and the
 * hypo variants also take `{threshold} {unit}` for the "below X" clause —
 * the literal "70 mg/dL" / "54 mg/dL" text no longer lives in the bundle.
 */
function paramsFor(
  decision: SafetyFloorDecision,
  glucoseUnit: GlucoseUnit,
): Record<string, string | number> {
  if (decision.kind === "BLOOD_PRESSURE") {
    return {
      systolic: decision.value,
      diastolic: decision.diastolic ?? 0,
    };
  }
  const params: Record<string, string | number> = {
    value: convertGlucose(decision.value, glucoseUnit),
    unit: glucoseUnit,
  };
  if (
    decision.reason === "glucose_hypo" ||
    decision.reason === "glucose_hypo_severe"
  ) {
    const thresholdMgdl =
      decision.reason === "glucose_hypo_severe"
        ? GLUCOSE_HYPO_SEVERE
        : GLUCOSE_HYPO;
    params.threshold = convertGlucose(thresholdMgdl, glucoseUnit);
  }
  return params;
}

/**
 * Emit an urgent escalation push for a confirmed safety-floor breach, at most
 * once per (user, reason) per `DEDUPE_WINDOW_MS`. No-op when `decision` is
 * null. Never throws.
 *
 * `glucoseUnit` is only consulted for `GLUCOSE` decisions; defaults to
 * canonical mg/dL when the caller omits it (BP-only callers never need it).
 */
export async function notifySafetyFloor(input: {
  userId: string;
  decision: SafetyFloorDecision | null;
  glucoseUnit?: GlucoseUnit;
}): Promise<void> {
  const { userId, decision } = input;
  if (!decision) return;

  try {
    const reason = `${LEDGER_REASON_PREFIX}${decision.reason}`;
    const since = new Date(Date.now() - DEDUPE_WINDOW_MS);
    const claimed = await claimNotificationEvent(prisma, {
      recordUserId: userId,
      eventType: "SYSTEM_ALERT",
      dedupKey: reason,
      since,
    });
    if (!claimed) return;

    const { titleKey, messageKey } = copyKeysFor(decision);
    await dispatchLocalisedNotification({
      userId,
      titleKey,
      messageKey,
      params: paramsFor(decision, input.glucoseUnit ?? "mg/dL"),
      eventType: "SYSTEM_ALERT",
      managedFanoutEvent: "SAFETY_FLOOR_ALERT",
      urgent: true,
      // Tap target: the readings the alert is about.
      metadata: { url: "/measurements" },
    });

    getEvent()?.addMeta("safety_floor_notified", decision.reason);
  } catch (err) {
    getEvent()?.addWarning(
      `safety-floor notify failed (${decision.reason}): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}
