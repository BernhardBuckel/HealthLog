/**
 * GET /api/admin/encryption/key-backup
 *
 * Whether the "Back up your encryption key" step is due, for the admin step,
 * the overview tile and the dashboard banner. A light read (one settings row),
 * separate from `/status`, which walks the whole encrypted corpus. Key id and
 * fingerprint only, never key material. Cookie-only admin.
 */
import { apiHandler, requireAdmin } from "@/lib/api-handler";
import { apiSuccess } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { readKeyBackupStatus } from "@/lib/crypto/key-backup";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async () => {
  await requireAdmin();
  annotate({ action: { name: "admin.encryption.keyBackup.status" } });
  const status = await readKeyBackupStatus();
  annotate({ meta: { key_backup_due: status.due } });
  return apiSuccess(status);
});
