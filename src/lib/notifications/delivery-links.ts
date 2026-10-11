/**
 * Attach the tap target and the quick actions to a delivery.
 *
 * Called by the dispatcher once per recipient, after the delivery identity
 * is known and before the channel cascade, so every channel of one dispatch
 * carries the same target and the same (single-use) action tokens. The
 * senders only translate these fields into their own wire format; none of
 * them decides where a notification leads.
 */
import { prisma } from "@/lib/db";
import { defaultLocale, locales, type Locale } from "@/lib/i18n/config";
import { getServerTranslator } from "@/lib/i18n/server-translator";
import { getEvent } from "@/lib/logging/context";
import {
  buildMoodQuickActions,
  type QuickActionId,
} from "@/lib/notifications/action-token";
import { isManagedGuardianDelivery } from "@/lib/notifications/managed-delivery";
import {
  absoluteAppUrl,
  configuredAppOrigin,
  resolveTapPath,
} from "@/lib/notifications/tap-target";
import type { NotificationPayload } from "@/lib/notifications/types";

const QUICK_ACTION_LABEL_KEYS: Record<QuickActionId, string> = {
  "mood-good": "notifications.quickActions.moodGood",
  "mood-okay": "notifications.quickActions.moodOkay",
  "mood-bad": "notifications.quickActions.moodBad",
};

async function recipientLocale(userId: string): Promise<Locale> {
  try {
    const row = await prisma.user.findUnique({
      where: { id: userId },
      select: { locale: true },
    });
    const value = row?.locale;
    if (value && (locales as readonly string[]).includes(value)) {
      return value as Locale;
    }
  } catch {
    // A failed read only costs the label its language.
  }
  return defaultLocale;
}

/**
 * Whether this delivery may offer the mood quick answers: a mood reminder
 * delivered to the account it is about. A Guardian never gets a button that
 * writes into a record they are only notified about.
 */
function offersMoodActions(payload: NotificationPayload): boolean {
  return (
    payload.eventType === "MOOD_REMINDER" &&
    !payload.suppressActions &&
    !payload.discreet &&
    !isManagedGuardianDelivery(payload)
  );
}

export async function withDeliveryLinks(
  payload: NotificationPayload,
  recipientUserId: string,
  now: number = Date.now(),
): Promise<NotificationPayload> {
  const path = resolveTapPath(payload);
  const moodActions = offersMoodActions(payload);
  if (!path && !moodActions) return payload;

  const origin = configuredAppOrigin();
  const { t } = getServerTranslator(await recipientLocale(recipientUserId));

  const next: NotificationPayload = { ...payload };
  if (path) {
    next.tap = {
      path,
      url: absoluteAppUrl(path, origin),
      label: t("notifications.links.open"),
    };
  }

  if (moodActions && origin) {
    try {
      next.quickActions = buildMoodQuickActions({
        userId: recipientUserId,
        origin,
        labels: {
          "mood-good": t(QUICK_ACTION_LABEL_KEYS["mood-good"]),
          "mood-okay": t(QUICK_ACTION_LABEL_KEYS["mood-okay"]),
          "mood-bad": t(QUICK_ACTION_LABEL_KEYS["mood-bad"]),
        },
        now,
      });
    } catch (err) {
      // No signing key: the reminder still goes out, only without answers.
      getEvent()?.addWarning(
        `notification quick actions unavailable: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  return next;
}
