/**
 * POST /api/admin/encryption/key-backup/confirm  { keyId, fingerprint }
 *
 * The admin states that the active encryption key is backed up. The body
 * names the key the admin was shown; when that is no longer the active key
 * (rotated, or the server restarted with another key since the page loaded)
 * the answer is 409 `encryption.keyBackup.stale` and nothing is recorded.
 * No step-up: confirming is a low-risk write that reveals nothing.
 */
import type { NextRequest } from "next/server";
import { z } from "zod/v4";

import { apiHandler, requireAdmin } from "@/lib/api-handler";
import {
  apiError,
  apiSuccess,
  getClientIp,
  returnAllZodIssues,
  safeJson,
} from "@/lib/api-response";
import { auditLog } from "@/lib/auth/audit";
import { annotate } from "@/lib/logging/context";
import {
  confirmKeyBackup,
  KEY_BACKUP_STALE_CODE,
} from "@/lib/crypto/key-backup";

export const dynamic = "force-dynamic";

const confirmSchema = z
  .object({
    keyId: z.string().min(1).max(32),
    fingerprint: z.string().regex(/^[0-9a-f]{12}$/),
  })
  .strict();

export const POST = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAdmin();
  annotate({ action: { name: "admin.encryption.keyBackup.confirm" } });

  const body = await safeJson(request, { maxBytes: 1024 });
  if (body.error) return body.error;
  const parsed = confirmSchema.safeParse(body.data);
  if (!parsed.success) return returnAllZodIssues(parsed.error);

  const result = await confirmKeyBackup({
    keyId: parsed.data.keyId,
    fingerprint: parsed.data.fingerprint,
    userId: user.id,
  });
  if (!result.ok) {
    annotate({ meta: { key_backup_stale: true } });
    return apiError(
      "The encryption key changed since this page was loaded. Reload and confirm the backup of the current key.",
      409,
      {
        errorCode: KEY_BACKUP_STALE_CODE,
        activeKeyId: result.activeKeyId,
        fingerprint: result.fingerprint,
      },
    );
  }

  await auditLog("encryption.keyBackup.confirmed", {
    userId: user.id,
    ipAddress: getClientIp(request),
    details: {
      keyId: result.status.activeKeyId,
      fingerprint: result.status.fingerprint,
    },
  });
  return apiSuccess(result.status);
});
