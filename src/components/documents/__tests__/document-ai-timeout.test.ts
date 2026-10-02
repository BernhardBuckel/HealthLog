/**
 * The browser waits as long as the server may.
 *
 * Document reads and lab OCR used to abort on fixed windows (120 s, 90 s, and
 * the 15 s default on the lab text path) while the server, for a slow local
 * model, was allowed far longer. The windows now derive from
 * `ai.provider.responseTimeoutMs` on the account payload: the per-call value
 * times the model calls one request can make, plus a 30 s margin.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiPost = vi.fn();
const apiFetch = vi.fn();
vi.mock("@/lib/api/api-fetch", () => ({
  apiPost: (...a: unknown[]) => apiPost(...a),
  apiFetch: (...a: unknown[]) => apiFetch(...a),
  apiFetchRaw: vi.fn(),
  apiGet: vi.fn(),
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

let timeout: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  apiPost.mockReset().mockResolvedValue({});
  apiFetch.mockReset().mockResolvedValue({});
  timeout = vi.spyOn(AbortSignal, "timeout");
});

afterEach(() => {
  timeout.mockRestore();
});

describe("document AI requests", () => {
  it("give Read with AI three model calls under the published setting", async () => {
    await runDocumentIndex({
      mode: "vision",
      target,
      responseTimeoutMs: 300_000,
    });
    expect(timeout).toHaveBeenCalledWith(3 * 300_000 + 30_000);
  });

  it("give a one-call route one call plus the margin", async () => {
    await runDocumentAi({
      path: "/api/documents/inbound/d1/summary?mode=summary",
      mode: "vision",
      target,
      responseTimeoutMs: 300_000,
      modelCalls: 1,
    });
    expect(timeout).toHaveBeenCalledWith(330_000);
  });

  it("follow the server default when nothing is set", async () => {
    await runDocumentIndex({
      mode: "vision",
      target,
      responseTimeoutMs: 60_000,
    });
    expect(timeout).toHaveBeenCalledWith(210_000);
  });
});

describe("lab OCR requests", () => {
  it("vision upload waits for the read and its retry", async () => {
    await postOcrExtract({ file: new File(["x"], "r.png") }, 300_000);
    expect(timeout).toHaveBeenCalledWith(630_000);
    expect(apiFetch.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  it("text mode no longer rides the 15 s default", async () => {
    await postOcrExtract({ text: "Hb 14" }, 300_000);
    expect(timeout).toHaveBeenCalledWith(630_000);
    expect(apiPost.mock.calls[0][2].signal).toBeInstanceOf(AbortSignal);
  });
});
