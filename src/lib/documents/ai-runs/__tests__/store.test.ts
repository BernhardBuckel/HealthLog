/**
 * The run service's reads and the reaper's decisions, with Prisma stubbed.
 * The integration file (`tests/integration/document-ai-runs.test.ts`) proves
 * the same against Postgres; this one pins the arithmetic and the branches.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const findFirst = vi.fn();
const findMany = vi.fn();
const updateMany = vi.fn();
const deleteMany = vi.fn();
vi.mock("@/lib/db", () => ({
  prisma: {
    documentAiRun: {
      findFirst: (...a: unknown[]) => findFirst(...a),
      findMany: (...a: unknown[]) => findMany(...a),
      updateMany: (...a: unknown[]) => updateMany(...a),
      deleteMany: (...a: unknown[]) => deleteMany(...a),
    },
  },
}));
const reconcileSpend = vi.fn();
vi.mock("@/lib/ai/coach/budget", () => ({
  reconcileSpend: (...a: unknown[]) => reconcileSpend(...a),
}));

import { _resetCryptoCacheForTests, encryptBytes } from "@/lib/crypto";
import { DOCUMENT_AI_RUN_RESULT_AAD } from "@/lib/crypto/encrypted-columns";
import { readAiRunForUser, reapAiRuns } from "@/lib/documents/ai-runs/store";

const NOW = new Date("2027-01-15T10:00:00.000Z");
const at = (msAgo: number) => new Date(NOW.getTime() - msAgo);

function row(overrides: Record<string, unknown>) {
  return {
    id: "r1",
    kind: "LABS_OCR_EXTRACT",
    documentId: null,
    status: "QUEUED",
    resultEncrypted: null,
    errorCode: null,
    errorStatus: null,
    errorMessage: null,
    createdAt: at(10_000),
    startedAt: null,
    finishedAt: null,
    expiresAt: new Date(NOW.getTime() + 60_000),
    ...overrides,
  };
}

beforeEach(() => {
  vi.stubEnv("ENCRYPTION_KEYS", "");
  vi.stubEnv("ENCRYPTION_ACTIVE_KEY_ID", "");
  vi.stubEnv("ENCRYPTION_KEY", "ab".repeat(32));
  _resetCryptoCacheForTests();
  vi.clearAllMocks();
  updateMany.mockResolvedValue({ count: 1 });
  deleteMany.mockResolvedValue({ count: 0 });
});

describe("readAiRunForUser", () => {
  it("scopes the read to the caller", async () => {
    findFirst.mockResolvedValue(null);
    expect(await readAiRunForUser("u1", "r1", NOW)).toBeNull();
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "r1", userId: "u1" } }),
    );
  });

  it("reports the queue wait and a poll interval that backs off", async () => {
    findFirst.mockResolvedValue(row({ createdAt: at(10_000) }));
    const early = await readAiRunForUser("u1", "r1", NOW);
    expect(early).toMatchObject({ status: "QUEUED", queuedForMs: 10_000 });
    expect(early?.retryAfterMs).toBe(1500 + 500);

    findFirst.mockResolvedValue(row({ createdAt: at(10 * 60_000) }));
    const late = await readAiRunForUser("u1", "r1", NOW);
    expect(late?.retryAfterMs).toBe(5000);
  });

  it("opens a result and stops the poll", async () => {
    const sealed = encryptBytes(
      Buffer.from(JSON.stringify({ rows: [], reportDate: null })),
      DOCUMENT_AI_RUN_RESULT_AAD,
    );
    findFirst.mockResolvedValue(
      row({
        status: "SUCCEEDED",
        resultEncrypted: new Uint8Array(sealed),
        finishedAt: at(1000),
      }),
    );
    expect(await readAiRunForUser("u1", "r1", NOW)).toMatchObject({
      status: "SUCCEEDED",
      result: { rows: [], reportDate: null },
      error: null,
      retryAfterMs: null,
      queuedForMs: null,
    });
  });

  it("reports a result that no longer opens as a failure, never an empty success", async () => {
    findFirst.mockResolvedValue(
      row({
        status: "SUCCEEDED",
        resultEncrypted: new Uint8Array([1, 2, 3]),
      }),
    );
    expect(await readAiRunForUser("u1", "r1", NOW)).toMatchObject({
      status: "FAILED",
      result: null,
      error: { code: "aiRuns.failed", status: 500 },
    });
  });

  it("hands back the route's own failure", async () => {
    findFirst.mockResolvedValue(
      row({
        status: "FAILED",
        errorCode: "labs.ocr.extractFailed",
        errorStatus: 422,
        errorMessage: "Couldn't read the report. Try a clearer photo.",
      }),
    );
    expect((await readAiRunForUser("u1", "r1", NOW))?.error).toEqual({
      code: "labs.ocr.extractFailed",
      status: 422,
      message: "Couldn't read the report. Try a clearer photo.",
    });
  });

  it("treats a finished run past its retention as gone", async () => {
    findFirst.mockResolvedValue(row({ status: "FAILED", expiresAt: at(1) }));
    expect(await readAiRunForUser("u1", "r1", NOW)).toBeNull();
  });
});

describe("reapAiRuns", () => {
  it("fails a waiting run as worker-unavailable and refunds it, a running one as timed out", async () => {
    findMany.mockResolvedValue([
      {
        id: "q1",
        userId: "u1",
        status: "QUEUED",
        paramsJson: {
          mode: "vision",
          budget: { reserved: 8000, owner: "user", dateKey: "2027-01-15" },
        },
      },
      {
        id: "x1",
        userId: "u2",
        status: "RUNNING",
        paramsJson: { mode: "text" },
      },
    ]);
    deleteMany.mockResolvedValue({ count: 4 });

    expect(await reapAiRuns(NOW)).toEqual({
      workerUnavailable: 1,
      timedOut: 1,
      deleted: 4,
    });
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "q1", status: "QUEUED" },
        data: expect.objectContaining({
          status: "FAILED",
          errorCode: "aiRuns.workerUnavailable",
          inputEncrypted: null,
        }),
      }),
    );
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "x1", status: "RUNNING" },
        data: expect.objectContaining({ errorCode: "aiRuns.timedOut" }),
      }),
    );
    // Only the run nobody claimed is refunded; a running one's reservation
    // belongs to the worker that claimed it.
    expect(reconcileSpend).toHaveBeenCalledOnce();
    expect(reconcileSpend).toHaveBeenCalledWith(
      "u1",
      8000,
      0,
      "2027-01-15",
      0,
      {
        servedBy: null,
        reservedOwner: "user",
      },
    );
    expect(deleteMany).toHaveBeenCalledWith({
      where: {
        status: { in: ["SUCCEEDED", "FAILED"] },
        expiresAt: { lte: NOW },
      },
    });
  });

  it("does not refund a run another party ended first", async () => {
    findMany.mockResolvedValue([
      {
        id: "q1",
        userId: "u1",
        status: "QUEUED",
        paramsJson: {
          mode: "vision",
          budget: { reserved: 8000, owner: "user", dateKey: "2027-01-15" },
        },
      },
    ]);
    updateMany.mockResolvedValue({ count: 0 });
    expect((await reapAiRuns(NOW)).workerUnavailable).toBe(0);
    expect(reconcileSpend).not.toHaveBeenCalled();
  });
});
