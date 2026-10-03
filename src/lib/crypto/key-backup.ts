/**
 * The "Back up your encryption key" step: instance state and its rules.
 *
 * The confirmation lives on the `AppSettings` singleton, bound to the active
 * key id and that key's fingerprint, so it is an instance fact (it survives
 * the admin who gave it) and a rotation or a re-keyed install makes the step
 * due again. Nothing here ever reads, returns or stores the key itself.
 */
import { prisma } from "@/lib/db";
import { envValue } from "@/lib/env";
import { getActiveKeyId, getKeyFingerprint } from "@/lib/crypto";

/** Where the operator sets the key; picks the tab the step opens on. */
export const KEY_BACKUP_PLATFORMS = [
  "compose",
  "truenas",
  "coolify",
  "unraid",
  "portainer",
] as const;
export type KeyBackupPlatform = (typeof KEY_BACKUP_PLATFORMS)[number];

/** Wire code for a confirmation given for a key that is no longer active. */
export const KEY_BACKUP_STALE_CODE = "encryption.keyBackup.stale";

/**
 * `HEALTHLOG_PLATFORM`, when it names a known platform; `compose` otherwise.
 * Catalog templates set it so the step opens on the right instructions.
 */
export function resolvePlatformHint(
  raw: string | undefined = envValue("HEALTHLOG_PLATFORM"),
): KeyBackupPlatform {
  const value = raw?.trim().toLowerCase();
  return (KEY_BACKUP_PLATFORMS as readonly string[]).includes(value ?? "")
    ? (value as KeyBackupPlatform)
    : "compose";
}

export interface KeyBackupStatus {
  /** True until a confirmation exists for the active key id AND fingerprint. */
  due: boolean;
  activeKeyId: string;
  /** Fingerprint of the active key (first 12 hex of SHA-256 over its bytes). */
  fingerprint: string;
  confirmedAt: string | null;
  confirmedKeyId: string | null;
  confirmedFingerprint: string | null;
  /** The confirming admin, while that account exists. */
  confirmedBy: { id: string; email: string | null } | null;
  platformHint: KeyBackupPlatform;
}

interface StoredConfirmation {
  encryptionKeyBackupConfirmedAt: Date | null;
  encryptionKeyBackupConfirmedKeyId: string | null;
  encryptionKeyBackupConfirmedFingerprint: string | null;
}

/** Pure rule: is the stored confirmation for this exact key? */
export function isKeyBackupDue(
  stored: StoredConfirmation | null,
  activeKeyId: string,
  fingerprint: string,
): boolean {
  return !(
    stored?.encryptionKeyBackupConfirmedAt &&
    stored.encryptionKeyBackupConfirmedKeyId === activeKeyId &&
    stored.encryptionKeyBackupConfirmedFingerprint === fingerprint
  );
}

function activeKey(): { activeKeyId: string; fingerprint: string } {
  const activeKeyId = getActiveKeyId();
  // The active id is always configured, so the fingerprint is never null.
  return { activeKeyId, fingerprint: getKeyFingerprint(activeKeyId) ?? "" };
}

export async function readKeyBackupStatus(): Promise<KeyBackupStatus> {
  const { activeKeyId, fingerprint } = activeKey();
  const row = await prisma.appSettings.findUnique({
    where: { id: "singleton" },
    select: {
      encryptionKeyBackupConfirmedAt: true,
      encryptionKeyBackupConfirmedKeyId: true,
      encryptionKeyBackupConfirmedFingerprint: true,
      encryptionKeyBackupConfirmedByUserId: true,
    },
  });
  const confirmedBy = row?.encryptionKeyBackupConfirmedByUserId
    ? await prisma.user.findUnique({
        where: { id: row.encryptionKeyBackupConfirmedByUserId },
        select: { id: true, email: true },
      })
    : null;
  return {
    due: isKeyBackupDue(row, activeKeyId, fingerprint),
    activeKeyId,
    fingerprint,
    confirmedAt: row?.encryptionKeyBackupConfirmedAt?.toISOString() ?? null,
    confirmedKeyId: row?.encryptionKeyBackupConfirmedKeyId ?? null,
    confirmedFingerprint: row?.encryptionKeyBackupConfirmedFingerprint ?? null,
    confirmedBy: confirmedBy ?? null,
    platformHint: resolvePlatformHint(),
  };
}

export type ConfirmKeyBackupResult =
  | { ok: true; status: KeyBackupStatus }
  | { ok: false; activeKeyId: string; fingerprint: string };

/**
 * Record the confirmation, but only for the key the admin was shown: a page
 * opened before a rotation must not confirm the new key.
 */
export async function confirmKeyBackup(input: {
  keyId: string;
  fingerprint: string;
  userId: string;
}): Promise<ConfirmKeyBackupResult> {
  const { activeKeyId, fingerprint } = activeKey();
  if (input.keyId !== activeKeyId || input.fingerprint !== fingerprint) {
    return { ok: false, activeKeyId, fingerprint };
  }
  const now = new Date();
  await prisma.appSettings.upsert({
    where: { id: "singleton" },
    create: {
      id: "singleton",
      encryptionKeyBackupConfirmedAt: now,
      encryptionKeyBackupConfirmedKeyId: activeKeyId,
      encryptionKeyBackupConfirmedFingerprint: fingerprint,
      encryptionKeyBackupConfirmedByUserId: input.userId,
    },
    update: {
      encryptionKeyBackupConfirmedAt: now,
      encryptionKeyBackupConfirmedKeyId: activeKeyId,
      encryptionKeyBackupConfirmedFingerprint: fingerprint,
      encryptionKeyBackupConfirmedByUserId: input.userId,
    },
  });
  return { ok: true, status: await readKeyBackupStatus() };
}
