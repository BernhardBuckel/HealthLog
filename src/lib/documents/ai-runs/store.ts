/**
 * The `DocumentAiRun` row: create, claim, finish, fail, read, reap.
 *
 * Every state change is a conditional `updateMany` on the state it leaves, so
 * the worker, the reaper and a second delivery of the same job can never both
 * move one run: whoever matched the row did it, the rest see a count of zero.
 * The budget reservation taken at enqueue is settled exactly once, by the
 * party that ends the run (the worker after its provider call, or the reaper
 * for a run no worker ever picked up).
 */
import { Buffer } from "node:buffer";

import { Prisma } from "@/generated/prisma/client";
import { reconcileSpend } from "@/lib/ai/coach/budget";
import type { ProviderChainType } from "@/lib/ai/provider-chain";
import { decryptBytes, encryptBytes } from "@/lib/crypto";
import {
  DOCUMENT_AI_RUN_INPUT_AAD,
  DOCUMENT_AI_RUN_RESULT_AAD,
} from "@/lib/crypto/encrypted-columns";
import { prisma } from "@/lib/db";

import {
  AI_RUN_ERROR_CODES,
  AI_RUN_POLL_AFTER_MS,
  AI_RUN_QUEUE_WAIT_MS,
  AI_RUN_RETENTION_MS,
  type AiRunBudget,
  type AiRunDto,
  type AiRunParams,
  type AiRunResult,
  type DocumentAiRunKindValue,
} from "./types";

/** The longest a client is told to wait between polls. */
const MAX_POLL_INTERVAL_MS = 5000;

export interface CreateAiRunArgs {
  userId: string;
  kind: DocumentAiRunKindValue;
  documentId?: string | null;
  params: AiRunParams;
  /** The input only the run can read later: an upload, or browser-read text. */
  input?: Buffer | null;
  now?: Date;
}

/** Insert a queued run. The caller enqueues the job right after. */
export async function createAiRun(args: CreateAiRunArgs): Promise<string> {
  const now = args.now ?? new Date();
  const row = await prisma.documentAiRun.create({
    data: {
      userId: args.userId,
      kind: args.kind,
      documentId: args.documentId ?? null,
      status: "QUEUED",
      paramsJson: args.params as unknown as Prisma.InputJsonValue,
      inputEncrypted: args.input
        ? new Uint8Array(encryptBytes(args.input, DOCUMENT_AI_RUN_INPUT_AAD))
        : null,
      createdAt: now,
      expiresAt: new Date(now.getTime() + AI_RUN_QUEUE_WAIT_MS),
    },
    select: { id: true },
  });
  return row.id;
}

/** A run the worker has claimed, with its input opened. */
export interface ClaimedAiRun {
  id: string;
  userId: string;
  kind: DocumentAiRunKindValue;
  documentId: string | null;
  params: AiRunParams;
  input: Buffer | null;
}

/**
 * Move a queued run to RUNNING with the deadline the reaper enforces. Null
 * when the run is gone or no longer queued (a second delivery, or the reaper
 * failed it while it waited).
 */
export async function claimAiRun(
  id: string,
  runDeadline: Date,
  now: Date = new Date(),
): Promise<ClaimedAiRun | null> {
  const moved = await prisma.documentAiRun.updateMany({
    where: { id, status: "QUEUED" },
    data: { status: "RUNNING", startedAt: now, expiresAt: runDeadline },
  });
  if (moved.count !== 1) return null;
  const row = await prisma.documentAiRun.findUnique({
    where: { id },
    select: {
      id: true,
      userId: true,
      kind: true,
      documentId: true,
      paramsJson: true,
      inputEncrypted: true,
    },
  });
  if (!row) return null;
  let input: Buffer | null = null;
  if (row.inputEncrypted) {
    input = decryptBytes(
      Buffer.from(row.inputEncrypted),
      DOCUMENT_AI_RUN_INPUT_AAD,
    );
  }
  return {
    id: row.id,
    userId: row.userId,
    kind: row.kind,
    documentId: row.documentId,
    params: row.paramsJson as unknown as AiRunParams,
    input,
  };
}

/** Store the result and drop the input. False when the run was already ended. */
export async function completeAiRun(
  id: string,
  result: AiRunResult,
  now: Date = new Date(),
): Promise<boolean> {
  const sealed = encryptBytes(
    Buffer.from(JSON.stringify(result), "utf8"),
    DOCUMENT_AI_RUN_RESULT_AAD,
  );
  const moved = await prisma.documentAiRun.updateMany({
    where: { id, status: "RUNNING" },
    data: {
      status: "SUCCEEDED",
      resultEncrypted: new Uint8Array(sealed),
      inputEncrypted: null,
      finishedAt: now,
      expiresAt: new Date(now.getTime() + AI_RUN_RETENTION_MS),
    },
  });
  return moved.count === 1;
}

export interface AiRunFailure {
  status: number;
  message: string;
  errorCode: string;
}

/**
 * Fail a run that is still queued or running and drop its input. False when
 * another party ended it first.
 */
export async function failAiRun(
  id: string,
  failure: AiRunFailure,
  from: "QUEUED" | "RUNNING" | "ANY" = "ANY",
  now: Date = new Date(),
): Promise<boolean> {
  const moved = await prisma.documentAiRun.updateMany({
    where: {
      id,
      status: from === "ANY" ? { in: ["QUEUED", "RUNNING"] } : from,
    },
    data: {
      status: "FAILED",
      errorCode: failure.errorCode,
      errorStatus: failure.status,
      errorMessage: failure.message,
      inputEncrypted: null,
      finishedAt: now,
      expiresAt: new Date(now.getTime() + AI_RUN_RETENTION_MS),
    },
  });
  return moved.count === 1;
}

/**
 * Settle the reservation taken at enqueue. `servedBy` null with `actual` 0
 * hands it back in full. Best effort: the run's own state matters more than
 * the meter.
 */
export async function settleAiRunBudget(
  userId: string,
  budget: AiRunBudget | undefined,
  actual: number,
  servedBy: ProviderChainType | null,
): Promise<void> {
  if (!budget || budget.reserved <= 0) return;
  try {
    await reconcileSpend(userId, budget.reserved, actual, budget.dateKey, 0, {
      servedBy,
      reservedOwner: budget.owner,
    });
  } catch {
    // The run's outcome is already decided; a failed refund is not a reason
    // to change it.
  }
}

function openResult(sealed: Uint8Array | null): AiRunResult | null {
  if (!sealed) return null;
  try {
    const plain = decryptBytes(Buffer.from(sealed), DOCUMENT_AI_RUN_RESULT_AAD);
    return JSON.parse(plain.toString("utf8")) as AiRunResult;
  } catch {
    return null;
  }
}

/**
 * One run as its owner sees it, or null when it does not exist, belongs to
 * somebody else, or has outlived its retention (the reaper may not have
 * deleted it yet; it is gone either way).
 */
export async function readAiRunForUser(
  userId: string,
  id: string,
  now: Date = new Date(),
): Promise<AiRunDto | null> {
  const row = await prisma.documentAiRun.findFirst({
    where: { id, userId },
    select: {
      id: true,
      kind: true,
      documentId: true,
      status: true,
      resultEncrypted: true,
      errorCode: true,
      errorStatus: true,
      errorMessage: true,
      createdAt: true,
      startedAt: true,
      finishedAt: true,
      expiresAt: true,
    },
  });
  if (!row) return null;
  const terminal = row.status === "SUCCEEDED" || row.status === "FAILED";
  if (terminal && row.expiresAt.getTime() <= now.getTime()) return null;

  const result =
    row.status === "SUCCEEDED" ? openResult(row.resultEncrypted) : null;
  // A result that no longer opens (a key rotated away under it) is reported
  // as a failure rather than as a success with nothing in it.
  const unreadable = row.status === "SUCCEEDED" && result === null;
  const age = now.getTime() - row.createdAt.getTime();
  const sinceStart = row.startedAt
    ? now.getTime() - row.startedAt.getTime()
    : 0;
  return {
    id: row.id,
    kind: row.kind,
    documentId: row.documentId,
    status: unreadable ? "FAILED" : row.status,
    result,
    error:
      row.status === "FAILED" || unreadable
        ? {
            code: unreadable
              ? AI_RUN_ERROR_CODES.failed
              : (row.errorCode ?? AI_RUN_ERROR_CODES.failed),
            message: unreadable
              ? "The result of this run can no longer be read."
              : (row.errorMessage ?? "The run failed."),
            status: unreadable ? 500 : (row.errorStatus ?? 500),
          }
        : null,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
    queuedForMs: row.status === "QUEUED" ? Math.max(0, age) : null,
    retryAfterMs: terminal
      ? null
      : Math.min(
          MAX_POLL_INTERVAL_MS,
          // Poll briskly at first, then back off: most reads finish within
          // seconds, and a slow local model can take minutes.
          AI_RUN_POLL_AFTER_MS + Math.floor(Math.max(age, sinceStart) / 20),
        ),
  };
}

export interface ReapSummary {
  workerUnavailable: number;
  timedOut: number;
  deleted: number;
}

/**
 * The reaper's one pass, keyed on `expiresAt`, which always holds the next
 * deadline of a run:
 *
 *   - QUEUED past it: no worker picked the run up. Failed as
 *     `aiRuns.workerUnavailable`, and its reservation is handed back.
 *   - RUNNING past it: the run outlived every model call it was allowed.
 *     Failed as `aiRuns.timedOut`. The reservation stays with the worker that
 *     claimed it; a worker that died with it leaves it charged, the cautious
 *     direction for a meter.
 *   - SUCCEEDED / FAILED past it: an hour after it finished. Deleted.
 */
export async function reapAiRuns(
  now: Date = new Date(),
  batch = 500,
): Promise<ReapSummary> {
  const summary: ReapSummary = {
    workerUnavailable: 0,
    timedOut: 0,
    deleted: 0,
  };

  const stuck = await prisma.documentAiRun.findMany({
    where: { status: { in: ["QUEUED", "RUNNING"] }, expiresAt: { lte: now } },
    select: { id: true, userId: true, status: true, paramsJson: true },
    orderBy: { expiresAt: "asc" },
    take: batch,
  });
  for (const run of stuck) {
    if (run.status === "QUEUED") {
      const failed = await failAiRun(
        run.id,
        {
          status: 503,
          errorCode: AI_RUN_ERROR_CODES.workerUnavailable,
          message:
            "No background worker picked this up. Ask the server operator to check the worker.",
        },
        "QUEUED",
        now,
      );
      if (failed) {
        summary.workerUnavailable += 1;
        const params = run.paramsJson as unknown as AiRunParams | null;
        await settleAiRunBudget(run.userId, params?.budget, 0, null);
      }
    } else {
      const failed = await failAiRun(
        run.id,
        {
          status: 504,
          errorCode: AI_RUN_ERROR_CODES.timedOut,
          message: "Reading took longer than the AI response time allows.",
        },
        "RUNNING",
        now,
      );
      if (failed) summary.timedOut += 1;
    }
  }

  const gone = await prisma.documentAiRun.deleteMany({
    where: { status: { in: ["SUCCEEDED", "FAILED"] }, expiresAt: { lte: now } },
  });
  summary.deleted = gone.count;
  return summary;
}
