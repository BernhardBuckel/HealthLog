"use client";

/**
 * v1.40 — follow a background document AI run to its end.
 *
 * A route that queues a read answers 202 with `{ runId, status, pollAfterMs }`.
 * `resolveAiRun` takes whatever the route answered: a synchronous body passes
 * straight through, a queued run is polled through the query cache
 * (`queryKeys.aiRun`) until it ends. The result resolves exactly like the
 * synchronous body did; a failed run throws the same `ApiError` (message,
 * status, `meta.errorCode`) the synchronous route would have, so every
 * existing error mapping keeps working.
 *
 * `useAiRunPhase` is the calm state a screen shows while a read runs in the
 * background, and the hint when no worker has picked it up yet.
 */
import { useCallback, useState } from "react";
import type { QueryClient } from "@tanstack/react-query";

import { ApiError, apiGet } from "@/lib/api/api-fetch";
import type { AiRunAccepted, AiRunDto } from "@/lib/documents/ai-runs/types";
import { queryKeys } from "@/lib/query-keys";

/** A queued run has waited this long: say the background worker may be down. */
export const AI_RUN_WORKER_HINT_MS = 30_000;

const DEFAULT_POLL_MS = 1500;

/** Whether a route's 2xx body is a queued run rather than its result. */
export function isAiRunAccepted(data: unknown): data is AiRunAccepted {
  return (
    typeof data === "object" &&
    data !== null &&
    typeof (data as { runId?: unknown }).runId === "string" &&
    (data as { status?: unknown }).status === "QUEUED"
  );
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export interface WaitForAiRunOptions {
  /** Called with every poll answer while the run has not ended. */
  onProgress?: (run: AiRunDto) => void;
  signal?: AbortSignal;
  /** Injectable for tests. */
  wait?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** Poll one run until it ends; resolve its result or throw its failure. */
export async function waitForAiRun<T>(
  queryClient: QueryClient,
  accepted: AiRunAccepted,
  options: WaitForAiRunOptions = {},
): Promise<T> {
  const wait = options.wait ?? sleep;
  const key = queryKeys.aiRun(accepted.runId);
  let delay = accepted.pollAfterMs > 0 ? accepted.pollAfterMs : DEFAULT_POLL_MS;
  try {
    for (;;) {
      await wait(delay, options.signal);
      const run = await queryClient.fetchQuery({
        queryKey: key,
        queryFn: () =>
          apiGet<AiRunDto>(
            `/api/ai-runs/${encodeURIComponent(accepted.runId)}`,
          ),
        staleTime: 0,
        retry: 2,
      });
      if (run.status === "SUCCEEDED") return run.result as T;
      if (run.status === "FAILED") {
        const error = run.error ?? {
          code: "aiRuns.failed",
          message: "The background read failed.",
          status: 500,
        };
        throw new ApiError(error.message, error.status, {
          errorCode: error.code,
        });
      }
      options.onProgress?.(run);
      delay = run.retryAfterMs ?? DEFAULT_POLL_MS;
    }
  } finally {
    // The answer has been handed to the caller; it does not stay in memory.
    queryClient.removeQueries({ queryKey: key });
  }
}

/** A route's 2xx body, followed to its result when it is a queued run. */
export async function resolveAiRun<T>(
  queryClient: QueryClient,
  data: T | AiRunAccepted,
  options: WaitForAiRunOptions & { onQueued?: () => void } = {},
): Promise<T> {
  if (!isAiRunAccepted(data)) return data;
  options.onQueued?.();
  return waitForAiRun<T>(queryClient, data, options);
}

export type AiRunPhase = "idle" | "background" | "waitingForWorker";

/**
 * The phase a screen renders while a read runs in the background: `background`
 * once the route queued it, `waitingForWorker` once it has sat in the queue
 * past {@link AI_RUN_WORKER_HINT_MS}.
 */
export function useAiRunPhase() {
  const [phase, setPhase] = useState<AiRunPhase>("idle");
  const onQueued = useCallback(() => setPhase("background"), []);
  const onProgress = useCallback((run: AiRunDto) => {
    setPhase(
      run.status === "QUEUED" && (run.queuedForMs ?? 0) >= AI_RUN_WORKER_HINT_MS
        ? "waitingForWorker"
        : "background",
    );
  }, []);
  const reset = useCallback(() => setPhase("idle"), []);
  return { phase, onQueued, onProgress, reset };
}
