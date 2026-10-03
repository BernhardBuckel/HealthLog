"use client";

/**
 * `<KeyBackupCard>` — the "Back up your encryption key" step on the admin
 * Encryption page.
 *
 * Shows the active key id and its fingerprint (never the key), where the key
 * lives on each platform, what is lost without it, a "Check my copy" field
 * and the confirmation. The confirmation is bound to the key id and
 * fingerprint shown here: if the server's key changed since the page loaded,
 * the server answers 409 and the card reloads.
 */

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { SettingsCardActions } from "@/components/settings/_card-actions";
import { QueryErrorRow } from "@/components/ui/query-error-row";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import { ApiError, apiFetch, apiPost } from "@/lib/api/api-fetch";
import {
  useKeyBackupStatus,
  type KeyBackupPlatform,
  type KeyBackupStatus,
} from "./use-key-backup-status";

const PLATFORMS: KeyBackupPlatform[] = [
  "compose",
  "truenas",
  "coolify",
  "unraid",
  "portainer",
];

/** Literal keys per platform, so the i18n coverage guard sees every one. */
function platformCopy(
  t: (key: string) => string,
  p: KeyBackupPlatform,
): { label: string; where: string } {
  switch (p) {
    case "truenas":
      return {
        label: t("admin.keyBackup.platform.truenasLabel"),
        where: t("admin.keyBackup.platform.truenasWhere"),
      };
    case "coolify":
      return {
        label: t("admin.keyBackup.platform.coolifyLabel"),
        where: t("admin.keyBackup.platform.coolifyWhere"),
      };
    case "unraid":
      return {
        label: t("admin.keyBackup.platform.unraidLabel"),
        where: t("admin.keyBackup.platform.unraidWhere"),
      };
    case "portainer":
      return {
        label: t("admin.keyBackup.platform.portainerLabel"),
        where: t("admin.keyBackup.platform.portainerWhere"),
      };
    case "compose":
      return {
        label: t("admin.keyBackup.platform.composeLabel"),
        where: t("admin.keyBackup.platform.composeWhere"),
      };
  }
}

export function KeyBackupCard() {
  const { t } = useTranslations();
  const fmt = useFormatters();
  const queryClient = useQueryClient();
  const status = useKeyBackupStatus();
  const [candidate, setCandidate] = useState("");
  const [checkResult, setCheckResult] = useState<boolean | null>(null);

  const invalidate = () =>
    Promise.all([
      queryClient.invalidateQueries({
        queryKey: queryKeys.adminEncryptionKeyBackup(),
      }),
      queryClient.invalidateQueries({
        queryKey: queryKeys.adminEncryptionStatus(),
      }),
    ]);

  const confirm = useMutation({
    mutationFn: (s: KeyBackupStatus) =>
      apiPost<KeyBackupStatus>(
        "/api/admin/encryption/key-backup/confirm",
        { keyId: s.activeKeyId, fingerprint: s.fingerprint },
        { credentials: "include" },
      ),
    onSuccess: async () => {
      toast(t("admin.keyBackup.confirmed"));
      await invalidate();
    },
    onError: async (err: Error) => {
      if (err instanceof ApiError && err.status === 409) {
        toast.error(t("admin.keyBackup.stale"));
        await invalidate();
        return;
      }
      toast.error(err.message || t("admin.keyBackup.confirmFailed"));
    },
  });

  const verify = useMutation({
    // Not `apiPost`: no idempotency key, so no cached response row exists
    // for a request whose body was a key.
    mutationFn: (encryptionKey: string) =>
      apiFetch<{ matches: boolean }>(
        "/api/admin/encryption/key-backup/verify",
        {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ encryptionKey }),
        },
      ),
    onSuccess: (data) => {
      setCheckResult(data.matches);
      setCandidate("");
    },
    onError: (err: Error) => {
      setCheckResult(null);
      toast.error(err.message || t("admin.keyBackup.checkFailed"));
    },
  });

  const insecure =
    typeof window !== "undefined" && window.isSecureContext === false;

  if (!status.data) {
    return (
      <SettingsCard>
        <SettingsCardHeader
          icon={KeyRound}
          title={t("admin.keyBackup.title")}
          description={t("admin.keyBackup.description")}
        />
        {status.isError ? (
          <QueryErrorRow
            message={t("admin.keyBackup.loadError")}
            onRetry={() => void status.refetch()}
          />
        ) : (
          <div className="text-muted-foreground flex items-center gap-2 text-sm">
            <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
            {t("admin.keyBackup.loading")}
          </div>
        )}
      </SettingsCard>
    );
  }

  const s = status.data;
  return (
    <SettingsCard data-testid="key-backup-card">
      <SettingsCardHeader
        icon={KeyRound}
        title={t("admin.keyBackup.title")}
        description={t("admin.keyBackup.description")}
        status={
          s.due ? (
            <Badge variant="outline" className="border-warning/40 text-warning">
              {t("admin.keyBackup.badgeDue")}
            </Badge>
          ) : (
            <Badge variant="outline">{t("admin.keyBackup.badgeDone")}</Badge>
          )
        }
      />

      <dl className="grid gap-3 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-muted-foreground">
            {t("admin.keyBackup.keyId")}
          </dt>
          <dd className="font-mono">{s.activeKeyId}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">
            {t("admin.keyBackup.fingerprint")}
          </dt>
          <dd className="font-mono" data-testid="key-backup-fingerprint">
            {s.fingerprint}
          </dd>
        </div>
      </dl>

      <p className="text-sm">{t("admin.keyBackup.whatIsLost")}</p>

      <Tabs defaultValue={s.platformHint}>
        <TabsList className="flex-wrap">
          {PLATFORMS.map((p) => (
            <TabsTrigger key={p} value={p}>
              {platformCopy(t, p).label}
            </TabsTrigger>
          ))}
        </TabsList>
        {PLATFORMS.map((p) => (
          <TabsContent key={p} value={p} className="text-sm">
            {platformCopy(t, p).where}
          </TabsContent>
        ))}
      </Tabs>

      <p className="text-muted-foreground text-sm">
        {t("admin.keyBackup.fingerprintHint")}
      </p>

      <form
        className="space-y-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (candidate.trim()) verify.mutate(candidate);
        }}
      >
        <Label htmlFor="key-backup-candidate">
          {t("admin.keyBackup.checkLabel")}
        </Label>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            id="key-backup-candidate"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={candidate}
            onChange={(e) => {
              setCandidate(e.target.value);
              setCheckResult(null);
            }}
            className="font-mono"
          />
          <Button
            type="submit"
            variant="outline"
            disabled={!candidate.trim() || verify.isPending}
          >
            {verify.isPending && (
              <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
            )}
            {t("admin.keyBackup.checkButton")}
          </Button>
        </div>
        <p className="text-muted-foreground text-xs">
          {insecure
            ? t("admin.keyBackup.checkInsecureNote")
            : t("admin.keyBackup.checkNote")}
        </p>
        {checkResult !== null && (
          <p
            role="status"
            data-testid="key-backup-check-result"
            className={
              checkResult ? "text-sm" : "text-destructive text-sm font-medium"
            }
          >
            {checkResult
              ? t("admin.keyBackup.checkMatches")
              : t("admin.keyBackup.checkNoMatch")}
          </p>
        )}
      </form>

      {!s.due && s.confirmedAt && (
        <p className="text-muted-foreground text-sm">
          {s.confirmedBy?.email
            ? t("admin.keyBackup.confirmedAtBy", {
                date: fmt.dateTime(new Date(s.confirmedAt)),
                who: s.confirmedBy.email,
              })
            : t("admin.keyBackup.confirmedAt", {
                date: fmt.dateTime(new Date(s.confirmedAt)),
              })}
        </p>
      )}
      {s.due && s.confirmedKeyId && (
        <p className="text-sm">
          {t("admin.keyBackup.dueAgain", { keyId: s.confirmedKeyId })}
        </p>
      )}

      {s.due && (
        <SettingsCardActions>
          <Button
            onClick={() => confirm.mutate(s)}
            disabled={confirm.isPending}
          >
            {confirm.isPending && (
              <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
            )}
            {t("admin.keyBackup.confirmButton")}
          </Button>
        </SettingsCardActions>
      )}
    </SettingsCard>
  );
}
