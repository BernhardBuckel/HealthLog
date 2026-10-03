"use client";

import { useQuery } from "@tanstack/react-query";
import { apiGet } from "@/lib/api/api-fetch";
import { queryKeys } from "@/lib/query-keys";

export type KeyBackupPlatform =
  "compose" | "truenas" | "coolify" | "unraid" | "portainer";

/** `GET /api/admin/encryption/key-backup`; key id and fingerprint only. */
export interface KeyBackupStatus {
  due: boolean;
  activeKeyId: string;
  fingerprint: string;
  confirmedAt: string | null;
  confirmedKeyId: string | null;
  confirmedFingerprint: string | null;
  confirmedBy: { id: string; email: string | null } | null;
  platformHint: KeyBackupPlatform;
}

/**
 * The key backup step's state. `enabled` lets the dashboard banner ask only
 * for an admin; the route itself is admin-only and cookie-only.
 */
export function useKeyBackupStatus(enabled = true) {
  return useQuery({
    queryKey: queryKeys.adminEncryptionKeyBackup(),
    queryFn: () =>
      apiGet<KeyBackupStatus>("/api/admin/encryption/key-backup", {
        credentials: "include",
      }),
    enabled,
    staleTime: 60_000,
  });
}
