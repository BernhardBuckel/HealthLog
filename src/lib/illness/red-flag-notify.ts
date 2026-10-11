/**
 * v1.18.4 — illness red-flag escalation push.
 *
 * The illness correlation engine (`computeIllnessCorrelation`) surfaces a
 * retrospective "seek care" red flag when a vital held an absolute clinical
 * floor for a sustained run (sustained low SpO2, sustained fever). Until now
 * that escalation only rendered in-app on the correlation surface; it never
 * left a push. This helper bridges it to the notification dispatcher so the
 * escalation reaches the user wherever they configured a channel.
 *
 * It dispatches at the URGENT level: every configured channel delivers at its
 * highest urgency (APNs time-sensitive, ntfy max, Web Push `Urgency: high`,
 * webhook `urgent`). There is NO dependency on APNs — an instance with only
 * ntfy / Web Push / Telegram / webhook / email still gets the escalation at
 * the strongest tier those channels support.
 *
 * Owner-scoped (the authenticated episode owner) and module-gated by the
 * caller (`requireIllnessEnabled`). De-duplicated through a record event:
 * at most one escalation per episode per rolling window, so a
 * correlation surface that is re-read repeatedly never re-fires the alarm.
 */
import { prisma } from "@/lib/db";
import { getEvent } from "@/lib/logging/context";
import { dispatchLocalisedNotification } from "@/lib/notifications/dispatch-localised";
import { claimNotificationEvent } from "@/lib/notifications/reminder-dedup";
import type { IllnessRedFlag } from "@/lib/illness/correlation";

/** One escalation per episode per this window. */
const DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Stable event key prefix so the dedupe lookup is exact-matchable. */
const LEDGER_REASON_PREFIX = "illness_red_flag:";

/**
 * Emit an urgent escalation push for an episode's red flags, at most once
 * per `DEDUPE_WINDOW_MS`. No-op when `redFlags` is empty. Never throws —
 * a notification failure must not break the correlation read.
 */
export async function notifyIllnessRedFlag(input: {
  userId: string;
  episodeId: string;
  redFlags: IllnessRedFlag[];
}): Promise<void> {
  const { userId, episodeId, redFlags } = input;
  if (redFlags.length === 0) return;

  try {
    // Red-flag alerts are deliberately outside the closed Guardian fan-out
    // allowlist. Managed records therefore retain the existing no-delivery,
    // no-anchor behaviour for this distinct SYSTEM_ALERT producer.
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { managedProfileAt: true },
    });
    if (user?.managedProfileAt) return;

    // Claim this episode's record event before provider egress. The claim
    // serializes concurrent readers without holding a transaction open for
    // delivery itself.
    const reason = `${LEDGER_REASON_PREFIX}${episodeId}`;
    const since = new Date(Date.now() - DEDUPE_WINDOW_MS);
    const claimed = await claimNotificationEvent(prisma, {
      recordUserId: userId,
      eventType: "SYSTEM_ALERT",
      dedupKey: reason,
      since,
    });
    if (!claimed) return;

    // Prefer the most clinically actionable reason for the body. Both copy
    // keys already exist in every locale bundle (i18n integrity guarantee).
    const fever = redFlags.find((f) => f.reason === "sustained_fever");
    const messageKey = fever
      ? "illness.correlation.redFlagFever"
      : "illness.correlation.redFlagSpo2";

    await dispatchLocalisedNotification({
      userId,
      titleKey: "illness.correlation.redFlagTitle",
      messageKey,
      eventType: "SYSTEM_ALERT",
      urgent: true,
      // Tap target: the illness episode the red flag belongs to.
      metadata: { url: `/illness/${encodeURIComponent(episodeId)}` },
    });

    getEvent()?.addMeta("illness_red_flag_notified", episodeId);
  } catch (err) {
    getEvent()?.addWarning(
      `illness red-flag notify failed for episode ${episodeId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}
