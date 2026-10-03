/**
 * GET /api/admin/encryption/status
 *
 * v1.23 — read-only admin view of encryption coverage + rotation progress.
 * Buckets every registered encrypted column's rows by key id (the same scan the
 * rotation tooling does), so an operator can SEE whether a rotation finished
 * before dropping a legacy key, instead of guessing.
 *
 * Returns ONLY key IDS (operator-chosen labels like `v1` / `v2`) and ROW
 * COUNTS — never key material. The configured-key set is surfaced as a count.
 *
 * Auth: cookie-only `requireAdmin` (a Bearer token can never reach admin). The
 * scan is on-demand with a short in-process cache so repeated panel renders
 * don't re-scan the corpus each time; the rotation run state is read from the
 * audit trail (DB-backed, so it is correct across the web/worker processes).
 */
import { prisma } from "@/lib/db";
import { apiHandler, requireAdmin } from "@/lib/api-handler";
import { apiSuccess } from "@/lib/api-response";
import { readKeyBackupStatus } from "@/lib/crypto/key-backup";
import { annotate } from "@/lib/logging/context";
import { getConfiguredKeyIds } from "@/lib/crypto";
import {
  offhostBackupConfigured,
  probeOffhostLifecycle,
} from "@/lib/jobs/offhost-backup";
import {
  scanCorpus,
  type CorpusClient,
  type CorpusScan,
} from "@/lib/crypto/encryption-corpus";

const SCAN_CACHE_TTL_MS = 15_000;
let scanCache: { at: number; scan: CorpusScan } | null = null;

interface RotationState {
  state: "idle" | "running" | "completed" | "failed";
  lastRequestedAt: string | null;
  lastCompletedAt: string | null;
  lastResult: { scanned: number; rotated: number; errors: number } | null;
}

async function readRotationState(): Promise<RotationState> {
  const rows = await prisma.auditLog.findMany({
    where: {
      action: {
        in: [
          "admin.encryption.rotate.requested",
          "admin.encryption.rotate.completed",
          "admin.encryption.rotate.failed",
        ],
      },
    },
    orderBy: { createdAt: "desc" },
    take: 10,
    select: { action: true, createdAt: true, details: true },
  });

  const requested = rows.find(
    (r) => r.action === "admin.encryption.rotate.requested",
  );
  const finished = rows.find(
    (r) =>
      r.action === "admin.encryption.rotate.completed" ||
      r.action === "admin.encryption.rotate.failed",
  );

  let lastResult: RotationState["lastResult"] = null;
  if (
    finished?.action === "admin.encryption.rotate.completed" &&
    finished.details
  ) {
    try {
      const d = JSON.parse(finished.details) as {
        scanned?: number;
        rotated?: number;
        errors?: number;
      };
      lastResult = {
        scanned: d.scanned ?? 0,
        rotated: d.rotated ?? 0,
        errors: d.errors ?? 0,
      };
    } catch {
      lastResult = null;
    }
  }

  // "running" iff the most recent request is newer than the most recent
  // completion/failure.
  let state: RotationState["state"] = "idle";
  if (requested && (!finished || requested.createdAt > finished.createdAt)) {
    state = "running";
  } else if (finished?.action === "admin.encryption.rotate.completed") {
    state = "completed";
  } else if (finished?.action === "admin.encryption.rotate.failed") {
    state = "failed";
  }

  return {
    state,
    lastRequestedAt: requested?.createdAt.toISOString() ?? null,
    lastCompletedAt: finished?.createdAt.toISOString() ?? null,
    lastResult,
  };
}

/**
 * Which keys the backups still need.
 *
 * Rotation re-encrypts every row in the database and re-seals every stored
 * backup's envelope, but the content INSIDE a backup keeps the key it was
 * written under: a restore writes it back verbatim. So "every row is on the
 * active key" is not the same as "the old key can go". This answers the second
 * question per key id, from what each copy recorded as it was written: the
 * stored copies that need it and the oldest of them, and for the off-host
 * bucket the last night an object needing it went in, plus how long the
 * bucket's lifecycle rule keeps objects after that.
 */
export interface BackupKeyNeeds {
  stored: Array<{ keyId: string; copies: number; oldestAt: string }>;
  /** Copies written before v1.39.3, which recorded no key ids. */
  unrecorded: { copies: number; oldestAt: string | null };
  offhost: Array<{
    keyId: string;
    firstWrittenAt: string;
    lastWrittenAt: string;
    /** When the last object needing this key expires; null when unknown. */
    neededUntil: string | null;
  }>;
  /** The bucket's expiry, when it has one the credential may read. */
  offhostExpirationDays: number | null;
  /** Retired key ids some backup still needs (never the active one). */
  retiredKeysStillNeeded: string[];
}

async function readBackupKeyNeeds(
  activeKeyId: string,
  now: Date,
): Promise<BackupKeyNeeds> {
  const [stored, unrecorded, offhostRows] = await Promise.all([
    prisma.$queryRaw<
      Array<{ key_id: string; copies: number; oldest_at: Date }>
    >`
      SELECT k AS key_id, count(*)::int AS copies, min(created_at) AS oldest_at
      FROM data_backups, unnest(inner_key_ids) AS k
      WHERE inner_key_ids_recorded
      GROUP BY k
      ORDER BY k
    `,
    prisma.dataBackup.aggregate({
      where: { innerKeyIdsRecorded: false },
      _count: { _all: true },
      _min: { createdAt: true },
    }),
    prisma.offhostBackupKeyUse.findMany({ orderBy: { keyId: "asc" } }),
  ]);
  const lifecycle =
    offhostRows.length > 0 && offhostBackupConfigured()
      ? await probeOffhostLifecycle()
      : null;
  const expirationDays =
    lifecycle?.state === "configured" ? lifecycle.expirationDays : null;

  const offhost = offhostRows.map((row) => ({
    keyId: row.keyId,
    firstWrittenAt: row.firstWrittenAt.toISOString(),
    lastWrittenAt: row.lastWrittenAt.toISOString(),
    neededUntil:
      expirationDays === null
        ? null
        : new Date(
            row.lastWrittenAt.getTime() + (expirationDays + 1) * 86_400_000,
          ).toISOString(),
  }));

  const needed = new Set<string>();
  for (const row of stored) needed.add(row.key_id);
  for (const row of offhost) {
    if (row.neededUntil === null || Date.parse(row.neededUntil) > +now) {
      needed.add(row.keyId);
    }
  }
  needed.delete(activeKeyId);

  return {
    stored: stored.map((row) => ({
      keyId: row.key_id,
      copies: row.copies,
      oldestAt: row.oldest_at.toISOString(),
    })),
    unrecorded: {
      copies: unrecorded._count._all,
      oldestAt: unrecorded._min.createdAt?.toISOString() ?? null,
    },
    offhost,
    offhostExpirationDays: expirationDays,
    retiredKeysStillNeeded: [...needed].sort(),
  };
}

export const GET = apiHandler(async () => {
  await requireAdmin();
  annotate({ action: { name: "admin.encryption.status" } });

  const now = Date.now();
  let scan: CorpusScan;
  if (scanCache && now - scanCache.at < SCAN_CACHE_TTL_MS) {
    scan = scanCache.scan;
  } else {
    scan = await scanCorpus(prisma as unknown as CorpusClient);
    scanCache = { at: now, scan };
  }

  const rotation = await readRotationState();
  const backups = await readBackupKeyNeeds(scan.activeKeyId, new Date());
  const keyBackup = await readKeyBackupStatus();

  annotate({
    meta: {
      encryption_total_rows: scan.totalRows,
      encryption_stale_rows: scan.staleRows,
      encryption_rotation_complete: scan.rotationComplete,
    },
  });

  return apiSuccess({
    activeKeyId: scan.activeKeyId,
    // COUNT only — never the key material.
    configuredKeyCount: getConfiguredKeyIds().length,
    rotationComplete: scan.rotationComplete,
    totalRows: scan.totalRows,
    activeRows: scan.activeRows,
    staleRows: scan.staleRows,
    columns: scan.columns,
    rotation,
    backups,
    // The "Back up your encryption key" step, bound to the active key.
    keyBackup,
    // Every row rotated AND no backup still needs a retired key: the one
    // state in which dropping an old key loses nothing. Copies that recorded
    // no key ids count against it, because they may hold any key that
    // existed when they were written.
    safeToDropRetiredKeys:
      scan.rotationComplete &&
      backups.retiredKeysStillNeeded.length === 0 &&
      backups.unrecorded.copies === 0,
  });
});
