/**
 * Start a background run from a route that has already authorised and
 * charged it: create the row, hand it to the worker, answer 202. When the
 * worker cannot be reached the run is failed on the spot, the reservation and
 * the rate slot go back, and the answer is 503, so nobody polls a run that
 * nothing will ever pick up.
 */
import type { Buffer } from "node:buffer";

import { prisma } from "@/lib/db";
import { enqueueDocumentAiRun } from "@/lib/jobs/document-ai-run";
import { annotate } from "@/lib/logging/context";

import { acceptedRunResponse, workerUnavailableResponse } from "./http";
import { createAiRun, failAiRun, settleAiRunBudget } from "./store";
import {
  AI_RUN_ERROR_CODES,
  type AiRunParams,
  type DocumentAiRunKindValue,
} from "./types";

/**
 * The live run of this kind for this document, if one is queued or running:
 * a second press of "Read with AI" (another tab, a double click) attaches to
 * it instead of paying for a second read.
 */
export async function findLiveDocumentRun(
  userId: string,
  documentId: string,
  kind: DocumentAiRunKindValue,
): Promise<string | null> {
  const row = await prisma.documentAiRun.findFirst({
    where: {
      userId,
      documentId,
      kind,
      status: { in: ["QUEUED", "RUNNING"] },
      expiresAt: { gt: new Date() },
    },
    select: { id: true },
    orderBy: { createdAt: "desc" },
  });
  return row?.id ?? null;
}

export async function startAiRun(args: {
  userId: string;
  kind: DocumentAiRunKindValue;
  documentId?: string | null;
  params: AiRunParams;
  input?: Buffer | null;
  /** Hand the route's rate slot back when the run cannot start. */
  refundSlot: () => Promise<void>;
}): Promise<Response> {
  const runId = await createAiRun({
    userId: args.userId,
    kind: args.kind,
    documentId: args.documentId ?? null,
    params: args.params,
    input: args.input ?? null,
  });
  const enqueued = await enqueueDocumentAiRun(runId, args.userId);
  if (!enqueued) {
    await failAiRun(
      runId,
      {
        status: 503,
        errorCode: AI_RUN_ERROR_CODES.workerUnavailable,
        message: "The background worker is not available.",
      },
      "QUEUED",
    );
    await settleAiRunBudget(args.userId, args.params.budget, 0, null);
    await args.refundSlot();
    annotate({
      action: { name: "ai_runs.worker_unavailable" },
      meta: { kind: args.kind },
    });
    return workerUnavailableResponse();
  }
  annotate({
    action: { name: "ai_runs.queued" },
    meta: { kind: args.kind, mode: args.params.mode },
  });
  return acceptedRunResponse(runId);
}
