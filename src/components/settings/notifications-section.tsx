"use client";

import Link from "next/link";
import { Bell, Smartphone } from "lucide-react";

import { useAuth } from "@/hooks/use-auth";
import { useTranslations } from "@/lib/i18n/context";
import { LowStockCard } from "@/components/settings/low-stock-card";
import { SectionHeading } from "@/components/ui/section-heading";
import { MoodReminderCard } from "@/components/settings/mood-reminder-card";
import { NotificationContentCard } from "@/components/settings/notification-content-card";
import { Button } from "@/components/ui/button";

/**
 * `<NotificationsSection>` — Settings → Notifications ("Benachrichtigungen").
 *
 * v1.18.0 (S4) — the single module-gated home for reminder TYPES. Earlier the
 * settings carried two near-identical entries: this Notifications screen and a
 * separate "Erinnerungen" hub that only deep-linked into the canonical editors
 * ("doppelt gemoppelt"). The hub is gone (its route 301-redirects here); the
 * reminder TYPES now live centrally on this one screen.
 *
 * Each reminder-type card is shown ONLY when its module is enabled, read from
 * the resolved `useAuth().user.modules` map (the same `/auth/me` map nav and
 * Insights pills gate off). Mood → `mood`, low-stock runway → `medications`
 * (a toggleable fail-open module since D3, so a missing key reads as enabled
 * and a stale `/me` payload never blanks a card).
 *
 * v1.25.7 — delivery channels move to Settings → Integrationen (channels are
 * delivery providers, the same family as the connected services). This screen
 * keeps ONLY the reminder-TYPE content; `/settings/channels` 301-redirects to
 * `/settings/integrations#channels`.
 *
 * v1.18.6 (W9) — the page heading + subtitle come from the shared
 * `<SettingsSectionFrame>`. The proactive-Coach nudge card lives under
 * Settings → Coach (it is a Coach setting, not a generic notification).
 */
export function NotificationsSection() {
  const { isAuthenticated, user } = useAuth();
  const { t } = useTranslations();

  // v1.18.0 (S4) — module-gated per-type visibility. Fail OPEN (`!== false`)
  // so a stale `/me` payload without the module map keeps every card visible.
  const moodEnabled = user?.modules?.mood !== false;
  const medsEnabled = user?.modules?.medications !== false;
  const anyReminder = moodEnabled || medsEnabled;

  return (
    <div className="space-y-10">
      {/* Group 1 — Reminders ("what you receive"). Rendered only when at
          least one reminder-type card is visible, so a fully-disabled
          account never shows an empty heading. */}
      {anyReminder ? (
        <section className="space-y-4">
          <SectionHeading
            icon={Bell}
            title={t("settings.sections.notifications.remindersHeading")}
          />

          {/* Mood check-in reminder — only when the mood module is enabled. */}
          {moodEnabled ? (
            <div id="mood-reminder" className="scroll-mt-28">
              <MoodReminderCard isAuthenticated={isAuthenticated} />
            </div>
          ) : null}

          {/* Medication low-stock runway — only when the medications module
              is enabled (toggleable, fail-open, since D3). */}
          {medsEnabled ? (
            <div id="low-stock" className="scroll-mt-28">
              <LowStockCard isAuthenticated={isAuthenticated} />
            </div>
          ) : null}
        </section>
      ) : null}

      {/* Group 2 — How notifications look on the phone. Not module-gated:
          it applies to every notification the account receives. */}
      <section className="space-y-4">
        <SectionHeading
          icon={Smartphone}
          title={t("settings.sections.notifications.displayHeading")}
        />
        <div id="notification-content" className="scroll-mt-28">
          <NotificationContentCard isAuthenticated={isAuthenticated} />
        </div>
      </section>
      {/* Cross-links to the other two notification surfaces. At the END of
          the page: a screen that opens with two ways off it never says what
          it is for. */}
      <div
        className="flex flex-wrap gap-2"
        data-slot="notifications-crosslinks"
      >
        <Button asChild variant="outline" size="sm">
          <Link href="/notifications">
            {t("settings.sections.notifications.matrixLink")}
          </Link>
        </Button>
        <Button asChild variant="outline" size="sm">
          <Link href="/settings/integrations#channels">
            {t("settings.sections.notifications.channelsLink")}
          </Link>
        </Button>
      </div>
    </div>
  );
}
