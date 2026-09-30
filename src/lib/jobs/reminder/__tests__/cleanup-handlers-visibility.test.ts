/**
 * v1.33.0 — the retention purges have to be able to fail out loud.
 *
 * Both handlers used to catch every error into a wide-event warning and return
 * normally. pg-boss then recorded a successful job, so a purge that aborted on
 * `statement_timeout` every night for a year looked exactly like a purge with
 * nothing to do. That is the failure this whole change exists to remove, so
 * the propagation is pinned rather than left to convention.
 *
 * The second half pins the other half of the same problem: a run that stopped
 * at the batch cap still has a backlog, and without the flag that is also
 * indistinguishable from a clean run.
 *
 * Mutation check: drop the `throw err` from either handler and the matching
 * "surfaces the failure" test goes red; drop the `drained` meta and the
 * matching backlog test goes red.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  cleanupOldAuditLogs: vi.fn(),
  cleanupExpiredMeasurementTombstones: vi.fn(),
  cleanupExpiredMoodTombstones: vi.fn(),
  cleanupExpiredIntakeTombstones: vi.fn(),
  meta: {} as Record<string, unknown>,
  warnings: [] as string[],
}));

vi.mock("@/lib/jobs/audit-log-cleanup", () => ({
  cleanupOldAuditLogs: h.cleanupOldAuditLogs,
}));
vi.mock("@/lib/jobs/measurement-tombstone-cleanup", () => ({
  cleanupExpiredMeasurementTombstones: h.cleanupExpiredMeasurementTombstones,
  cleanupExpiredMoodTombstones: h.cleanupExpiredMoodTombstones,
  cleanupExpiredIntakeTombstones: h.cleanupExpiredIntakeTombstones,
}));
vi.mock("../shared", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getWorkerPrisma: () => ({}),
}));
vi.mock("@/lib/logging/background", () => ({
  withBackgroundEvent: async (
    _name: string,
    fn: (evt: {
      addMeta: (k: string, v: unknown) => void;
      addWarning: (w: string) => void;
    }) => Promise<void>,
  ) =>
    fn({
      addMeta: (k, v) => {
        h.meta[k] = v;
      },
      addWarning: (w) => {
        h.warnings.push(w);
      },
    }),
}));

import {
  handleAuditLogCleanup,
  handleMeasurementTombstoneCleanup,
} from "../cleanup-handlers";

const DRAINED = { deleted: 1, drained: true };
const TOMBSTONES_DRAINED = { ...DRAINED, deferredAccounts: 0 };

beforeEach(() => {
  vi.clearAllMocks();
  for (const key of Object.keys(h.meta)) delete h.meta[key];
  h.warnings.length = 0;
  h.cleanupOldAuditLogs.mockResolvedValue(DRAINED);
  h.cleanupExpiredMeasurementTombstones.mockResolvedValue(TOMBSTONES_DRAINED);
  h.cleanupExpiredMoodTombstones.mockResolvedValue(TOMBSTONES_DRAINED);
  h.cleanupExpiredIntakeTombstones.mockResolvedValue(TOMBSTONES_DRAINED);
});

describe("audit-log cleanup handler", () => {
  it("surfaces the failure instead of recording a successful job", async () => {
    h.cleanupOldAuditLogs.mockRejectedValue(new Error("statement timeout"));
    await expect(handleAuditLogCleanup([])).rejects.toThrow(
      "statement timeout",
    );
    expect(h.warnings.join(" ")).toContain("audit-log-cleanup failed");
  });

  it("reports a backlog left behind by the batch cap", async () => {
    h.cleanupOldAuditLogs.mockResolvedValue({
      deleted: 200_000,
      drained: false,
    });
    await handleAuditLogCleanup([]);
    expect(h.meta.audit_log_cleanup_deleted).toBe(200_000);
    expect(h.meta.audit_log_cleanup_drained).toBe(false);
    expect(h.warnings.join(" ")).toContain("backlog remains");
  });

  it("stays quiet when the backlog is drained", async () => {
    await handleAuditLogCleanup([]);
    expect(h.meta.audit_log_cleanup_drained).toBe(true);
    expect(h.warnings).toEqual([]);
  });
});

describe("tombstone cleanup handler", () => {
  it("surfaces the failure instead of recording a successful job", async () => {
    h.cleanupExpiredMeasurementTombstones.mockRejectedValue(
      new Error("statement timeout"),
    );
    await expect(handleMeasurementTombstoneCleanup([])).rejects.toThrow(
      "statement timeout",
    );
    expect(h.warnings.join(" ")).toContain("tombstone-cleanup failed");
  });

  it("reports a backlog when any of the three legs stopped short", async () => {
    h.cleanupExpiredMoodTombstones.mockResolvedValue({
      deleted: 200_000,
      drained: false,
      deferredAccounts: 0,
    });
    await handleMeasurementTombstoneCleanup([]);
    expect(h.meta.tombstone_cleanup_drained).toBe(false);
    expect(h.meta.mood_tombstone_cleanup_pruned).toBe(200_000);
    expect(h.warnings.join(" ")).toContain("backlog remains");
  });

  it("reports the accounts it left because a restore was running", async () => {
    h.cleanupExpiredMeasurementTombstones.mockResolvedValue({
      ...TOMBSTONES_DRAINED,
      deferredAccounts: 2,
    });
    const outcome = await handleMeasurementTombstoneCleanup([]);
    expect(h.meta.tombstone_cleanup_deferred_accounts).toBe(2);
    expect(outcome).toMatchObject({ did: { deferred_accounts: 2 } });
  });

  it("stays quiet when all three legs drained", async () => {
    await handleMeasurementTombstoneCleanup([]);
    expect(h.meta.tombstone_cleanup_drained).toBe(true);
    expect(h.warnings).toEqual([]);
  });
});
