/**
 * POST /api/admin/encryption/key-backup/verify  { encryptionKey }
 *
 * "Check my copy": the admin pastes the backed-up key and learns whether it
 * is the active key. The value is compared in memory (constant time on the
 * decoded bytes) and dropped. It is never stored, never logged, never echoed:
 * the Zod issue list is not returned for this body (a validation failure is a
 * plain 422), and the field name is on the observability denylist.
 *
 * A boolean answer is no oracle against a 256-bit key; the 5 per minute limit
 * per admin is there to keep the route from being anyone's busy loop. Over
 * plain HTTP the value crosses the network in clear, as the admin's password
 * does; the client says so before sending.
 */
import type { NextRequest } from "next/server";
import { z } from "zod/v4";

import { apiHandler, requireAdmin } from "@/lib/api-handler";
import { apiError, apiSuccess, safeJson } from "@/lib/api-response";
import { auditLog } from "@/lib/auth/audit";
import { annotate } from "@/lib/logging/context";
import { checkRateLimit } from "@/lib/rate-limit";
import { candidateMatchesKey, getActiveKeyId } from "@/lib/crypto";

export const dynamic = "force-dynamic";

const KEY_BACKUP_VERIFY_LIMIT = 5;
const KEY_BACKUP_VERIFY_WINDOW_MS = 60 * 1000;

const verifySchema = z
  .object({ encryptionKey: z.string().min(1).max(256) })
  .strict();

export const POST = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAdmin();
  annotate({ action: { name: "admin.encryption.keyBackup.verify" } });

  const limit = await checkRateLimit(
    `key-backup-verify:${user.id}`,
    KEY_BACKUP_VERIFY_LIMIT,
    KEY_BACKUP_VERIFY_WINDOW_MS,
  );
  if (!limit.allowed) {
    return apiError("Too many checks. Try again in a minute.", 429);
  }

  const body = await safeJson(request, { maxBytes: 1024 });
  if (body.error) return body.error;
  const parsed = verifySchema.safeParse(body.data);
  if (!parsed.success) {
    // Deliberately not `returnAllZodIssues`: nothing derived from this body
    // goes back over the wire.
    return apiError("Paste the key as 64 hex characters.", 422);
  }

  const activeKeyId = getActiveKeyId();
  const matches = candidateMatchesKey(parsed.data.encryptionKey, activeKeyId);
  annotate({ meta: { key_backup_verify_matches: matches } });
  await auditLog("encryption.keyBackup.verified", {
    userId: user.id,
    details: { keyId: activeKeyId, matches },
  });
  return apiSuccess({ matches, keyId: activeKeyId });
});
