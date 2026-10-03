"use client";

/**
 * Dashboard banner for an admin while the encryption key backup step is due.
 * Not dismissable by design: it goes away when the step is done, and comes
 * back when the key changes. Renders nothing for anyone who is not an admin,
 * and asks the server nothing for them either.
 */

import Link from "next/link";
import { KeyRound } from "lucide-react";
import { useTranslations } from "@/lib/i18n/context";
import { useKeyBackupStatus } from "@/components/admin/use-key-backup-status";

export function KeyBackupBanner({ isAdmin }: { isAdmin: boolean }) {
  const { t } = useTranslations();
  const { data } = useKeyBackupStatus(isAdmin);
  if (!isAdmin || !data?.due) return null;
  return (
    <div
      role="status"
      data-testid="key-backup-banner"
      className="border-warning/40 bg-warning/10 flex flex-col gap-3 rounded-xl border p-4 sm:flex-row sm:items-center"
    >
      <KeyRound className="text-warning h-5 w-5 shrink-0" aria-hidden="true" />
      <div className="flex-1 space-y-1">
        <p className="text-sm font-semibold">
          {t("dashboard.keyBackupBanner.title")}
        </p>
        <p className="text-sm">{t("dashboard.keyBackupBanner.body")}</p>
      </div>
      <Link
        href="/admin/encryption"
        className="text-primary inline-flex min-h-11 items-center text-sm font-medium underline-offset-4 hover:underline"
      >
        {t("dashboard.keyBackupBanner.action")}
      </Link>
    </div>
  );
}
