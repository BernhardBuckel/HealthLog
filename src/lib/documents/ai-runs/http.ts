/**
 * The HTTP side of a background run: reading `Prefer: respond-async`, the 202
 * a route answers with, and turning a run body's outcome back into the
 * response the synchronous route has always given.
 */
import { apiError, apiSuccess } from "@/lib/api-response";
import { AiUnavailableError } from "@/lib/ai/capabilities/refusal";

import type { AiRunFailure } from "./store";
import {
  AI_RUN_ERROR_CODES,
  AI_RUN_POLL_AFTER_MS,
  type AiRunAccepted,
  type AiRunOutcome,
} from "./types";

/**
 * Whether the request asked for the background path (RFC 7240). Without the
 * header the four document routes answer exactly as they always have, which
 * is what a client that has not adopted runs relies on.
 */
export function prefersRespondAsync(request: Request): boolean {
  const header = request.headers.get("prefer");
  if (!header) return false;
  return header
    .split(",")
    .some(
      (preference) =>
        preference.split(";")[0]?.trim().toLowerCase() === "respond-async",
    );
}

/** The 202 for a queued run, with the poll address and the applied preference. */
export function acceptedRunResponse(runId: string): Response {
  const body: AiRunAccepted = {
    runId,
    status: "QUEUED",
    pollAfterMs: AI_RUN_POLL_AFTER_MS,
  };
  const response = apiSuccess(body, 202);
  response.headers.set("Preference-Applied", "respond-async");
  response.headers.set("Location", `/api/ai-runs/${runId}`);
  return response;
}

/** The answer when the run could not be handed to the background worker. */
export function workerUnavailableResponse(): Response {
  return apiError(
    "The background worker is not available. Try again in a moment.",
    503,
    { errorCode: AI_RUN_ERROR_CODES.workerUnavailable },
  );
}

/** A run body's outcome as the synchronous route's response. */
export function outcomeResponse<T>(outcome: AiRunOutcome<T>): Response {
  return outcome.ok
    ? apiSuccess(outcome.data)
    : apiError(outcome.message, outcome.status, {
        errorCode: outcome.errorCode,
      });
}

/**
 * A capability refusal thrown inside a run, as the failure the route would
 * have rendered for it. Null for anything else.
 */
export function refusalAsFailure(error: unknown): AiRunFailure | null {
  if (!(error instanceof AiUnavailableError)) return null;
  return {
    status: error.status,
    message: error.message,
    errorCode: error.meta.errorCode,
  };
}
