/**
 * Following a background run from the browser (v1.40): a synchronous body
 * passes through untouched, a queued run is polled through the key factory
 * until it ends, the poll interval follows the server's `retryAfterMs`, the
 * progress callback sees the queue wait (the "waiting for the background
 * worker" hint), a failure throws the synchronous route's `ApiError`, and the
 * answer does not stay in the cache.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";

const apiGet = vi.fn();
vi.mock("@/lib/api/api-fetch", async (importOriginal) => ({
  ApiError: (await importOriginal<typeof import("@/lib/api/api-fetch")>())
    .ApiError,
  apiGet: (...a: unknown[]) => apiGet(...a),
}));

import {
  AI_RUN_WORKER_HINT_MS,
  isAiRunAccepted,
  resolveAiRun,
  waitForAiRun,
} from "@/hooks/use-ai-run";
import { queryKeys } from "@/lib/query-keys";

const accepted = { runId: "r1", status: "QUEUED" as const, pollAfterMs: 1500 };

function run(overrides: Record<string, unknown>) {
  return {
    id: "r1",
    kind: "DOCUMENT_INDEX",
    documentId: "d1",
    status: "QUEUED",
    result: null,
    error: null,
    createdAt: "2027-01-15T10:00:00.000Z",
    startedAt: null,
    finishedAt: null,
    queuedForMs: 0,
    retryAfterMs: 1500,
    ...overrides,
  };
}

let queryClient: QueryClient;
const waits: number[] = [];
const wait = async (ms: number) => {
  waits.push(ms);
};

beforeEach(() => {
  apiGet.mockReset();
  waits.length = 0;
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
});

describe("isAiRunAccepted", () => {
  it("tells a queued run from a result", () => {
    expect(isAiRunAccepted(accepted)).toBe(true);
    expect(isAiRunAccepted({ indexed: true, tokenCount: 1 })).toBe(false);
    expect(isAiRunAccepted(null)).toBe(false);
    expect(isAiRunAccepted({ runId: "r1", status: "SUCCEEDED" })).toBe(false);
  });
});

describe("waitForAiRun", () => {
  it("polls until the run succeeds and backs off as the server says", async () => {
    apiGet
      .mockResolvedValueOnce(run({ status: "QUEUED", queuedForMs: 1000 }))
      .mockResolvedValueOnce(
        run({ status: "RUNNING", queuedForMs: null, retryAfterMs: 4000 }),
      )
      .mockResolvedValueOnce(
        run({
          status: "SUCCEEDED",
          result: { indexed: true },
          retryAfterMs: null,
        }),
      );
    const progress = vi.fn();
    const result = await waitForAiRun(queryClient, accepted, {
      wait,
      onProgress: progress,
    });
    expect(result).toEqual({ indexed: true });
    expect(waits).toEqual([1500, 1500, 4000]);
    expect(apiGet).toHaveBeenCalledWith("/api/ai-runs/r1");
    expect(progress).toHaveBeenCalledTimes(2);
    expect(queryClient.getQueryData(queryKeys.aiRun("r1"))).toBeUndefined();
  });

  it("throws the failure the synchronous route would have answered with", async () => {
    apiGet.mockResolvedValueOnce(
      run({
        status: "FAILED",
        error: {
          code: "consent.ai.required",
          message: "AI consent is required for this feature",
          status: 403,
        },
        retryAfterMs: null,
      }),
    );
    await expect(
      waitForAiRun(queryClient, accepted, { wait }),
    ).rejects.toMatchObject({
      name: "ApiError",
      status: 403,
      meta: { errorCode: "consent.ai.required" },
    });
    expect(queryClient.getQueryData(queryKeys.aiRun("r1"))).toBeUndefined();
  });

  it("stops when the caller aborts", async () => {
    const controller = new AbortController();
    controller.abort(new Error("left"));
    await expect(
      waitForAiRun(queryClient, accepted, { signal: controller.signal }),
    ).rejects.toThrow("left");
    expect(apiGet).not.toHaveBeenCalled();
  });
});

describe("resolveAiRun", () => {
  it("passes a synchronous body straight through", async () => {
    const onQueued = vi.fn();
    expect(
      await resolveAiRun(queryClient, { indexed: true }, { wait, onQueued }),
    ).toEqual({ indexed: true });
    expect(onQueued).not.toHaveBeenCalled();
    expect(apiGet).not.toHaveBeenCalled();
  });

  it("reports the queue and follows the run", async () => {
    apiGet.mockResolvedValueOnce(
      run({ status: "SUCCEEDED", result: { rows: [] }, retryAfterMs: null }),
    );
    const onQueued = vi.fn();
    expect(
      await resolveAiRun(queryClient, accepted, { wait, onQueued }),
    ).toEqual({ rows: [] });
    expect(onQueued).toHaveBeenCalledOnce();
  });
});

describe("the worker hint threshold", () => {
  it("is long enough not to flash on an ordinary queue wait", () => {
    expect(AI_RUN_WORKER_HINT_MS).toBeGreaterThanOrEqual(30_000);
  });
});
