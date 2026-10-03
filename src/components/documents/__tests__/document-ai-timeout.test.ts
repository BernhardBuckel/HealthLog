/**
 * The browser waits as long as the server may, and no longer has to wait at
 * all for a read that runs in the background.
 *
 * Document reads and lab OCR used to abort on fixed windows (120 s, 90 s, and
 * the 15 s default on the lab text path) while the server, for a slow local
 * model, was allowed far longer. A synchronous route still derives its window
 * from `ai.provider.responseTimeoutMs` (per call, times the calls, plus a
 * 30 s margin). Since v1.40 "Read with AI" and the lab scan only queue the
 * read: the request gets a short ceiling for the upload and the enqueue, and
 * the result comes from the run.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";

const apiPost = vi.fn();
const apiFetch = vi.fn();
const apiGet = vi.fn();
vi.mock("@/lib/api/api-fetch", async (importOriginal) => ({
  ApiError: (await importOriginal<typeof import("@/lib/api/api-fetch")>())
    .ApiError,
  apiPost: (...a: unknown[]) => apiPost(...a),
  apiFetch: (...a: unknown[]) => apiFetch(...a),
  apiFetchRaw: vi.fn(),
  apiGet: (...a: unknown[]) => apiGet(...a),
  apiPatch: vi.fn(),
}));
vi.mock("@/lib/labs/local-ocr", () => ({
  ocrImageToText: vi.fn(),
  LocalOcrError: class extends Error {},
}));

import {
  runDocumentAi,
  runDocumentIndex,
} from "@/components/documents/document-ai-transport";
import { postOcrExtract } from "@/components/labs/use-ocr-extract";

const target = {
  documentId: "d1",
  mimeType: "application/pdf",
  filename: "report.pdf",
  servingClass: "attachment" as const,
};

const accepted = { runId: "run1", status: "QUEUED", pollAfterMs: 0 };
const indexResult = {
  documentId: "d1",
  indexed: true,
  tokenCount: 12,
  labFactsStaged: 0,
};

let timeout: ReturnType<typeof vi.spyOn>;
let queryClient: QueryClient;

beforeEach(() => {
  apiPost.mockReset().mockResolvedValue(accepted);
  apiFetch.mockReset().mockResolvedValue(accepted);
  apiGet.mockReset().mockResolvedValue({
    id: "run1",
    status: "SUCCEEDED",
    result: indexResult,
    error: null,
    retryAfterMs: null,
  });
  timeout = vi.spyOn(AbortSignal, "timeout");
  queryClient = new QueryClient();
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  timeout.mockRestore();
  vi.useRealTimers();
});

describe("document AI requests", () => {
  it("queue Read with AI and resolve the run's result", async () => {
    const result = await runDocumentIndex({
      mode: "vision",
      target,
      responseTimeoutMs: 300_000,
      background: { queryClient },
    });
    expect(result).toEqual(indexResult);
    expect(timeout).toHaveBeenCalledWith(60_000);
    expect(timeout).not.toHaveBeenCalledWith(3 * 300_000 + 30_000);
    const init = apiPost.mock.calls[0][2] as RequestInit;
    expect(new Headers(init.headers).get("Prefer")).toBe("respond-async");
    expect(apiGet).toHaveBeenCalledWith("/api/ai-runs/run1");
  });

  it("give a one-call synchronous route one call plus the margin", async () => {
    apiPost.mockResolvedValue({ title: "x" });
    await runDocumentAi({
      path: "/api/documents/inbound/d1/summary?mode=summary",
      mode: "vision",
      target,
      responseTimeoutMs: 300_000,
      modelCalls: 1,
    });
    expect(timeout).toHaveBeenCalledWith(330_000);
    const init = apiPost.mock.calls[0][2] as RequestInit;
    expect(new Headers(init.headers ?? {}).get("Prefer")).toBeNull();
  });
});

describe("lab OCR requests", () => {
  it("vision upload queues the read and polls the rows", async () => {
    const rows = { reportDate: null, providerType: "anthropic", rows: [] };
    apiGet.mockResolvedValue({
      id: "run1",
      status: "SUCCEEDED",
      result: rows,
      error: null,
      retryAfterMs: null,
    });
    const result = await postOcrExtract(
      { file: new File(["x"], "r.png") },
      queryClient,
    );
    expect(result).toEqual(rows);
    expect(timeout).toHaveBeenCalledWith(60_000);
    expect(apiFetch.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  it("text mode no longer rides the 15 s default", async () => {
    await postOcrExtract({ text: "Hb 14" }, queryClient);
    expect(timeout).toHaveBeenCalledWith(60_000);
    expect(apiPost.mock.calls[0][2].signal).toBeInstanceOf(AbortSignal);
  });

  it("a failed run throws what the synchronous route would have", async () => {
    apiGet.mockResolvedValue({
      id: "run1",
      status: "FAILED",
      result: null,
      error: {
        code: "labs.ocr.extractFailed",
        message: "Couldn't read the report.",
        status: 422,
      },
      retryAfterMs: null,
    });
    await expect(
      postOcrExtract({ text: "Hb 14" }, queryClient),
    ).rejects.toMatchObject({
      name: "ApiError",
      status: 422,
      meta: { errorCode: "labs.ocr.extractFailed" },
    });
  });
});
