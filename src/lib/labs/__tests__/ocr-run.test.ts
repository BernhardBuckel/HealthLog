/**
 * The lab scan read the background worker runs (v1.40), moved out of the
 * route with the guarantees the route's own tests used to pin: the budget is
 * settled against what the provider was asked to do, a PDF is rendered for a
 * provider that cannot read one, a long PDF says which pages were read, and a
 * provider failure is named as one without the upstream body reaching the
 * stored failure or the event stream.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logging/context", () => ({ annotate: vi.fn() }));
vi.mock("@/lib/documents/rasterize-pdf", () => ({ rasterizePdf: vi.fn() }));
vi.mock("@/lib/ai/coach/budget", () => ({
  reconcileSpend: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/labs/ocr-extract", async () => {
  const actual = await vi.importActual<typeof import("@/lib/labs/ocr-extract")>(
    "@/lib/labs/ocr-extract",
  );
  return { ...actual, runOcrExtraction: vi.fn() };
});

import { reconcileSpend } from "@/lib/ai/coach/budget";
import { rasterizePdf } from "@/lib/documents/rasterize-pdf";
import { OcrExtractError, runOcrExtraction } from "@/lib/labs/ocr-extract";
import { executeOcrExtraction } from "@/lib/labs/ocr-run";
import { annotate } from "@/lib/logging/context";

const budget = {
  reserved: 1500,
  owner: "operator" as const,
  dateKey: "2027-01-15",
};
const textPick = {
  entry: { providerType: "openai", instance: {} as never },
  providerType: "openai",
} as never;
const codexPick = {
  entry: { providerType: "codex", instance: {} as never },
  providerType: "codex",
  pdfSupported: false,
} as never;

const text = () => ({ mode: "text" as const, text: "Hb 14", pick: textPick });
const pdf = () => ({
  mode: "vision" as const,
  bytes: Buffer.from("%PDF-1.4"),
  mime: "application/pdf" as const,
  pick: codexPick,
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("text mode", () => {
  it("charges the reservation to the provider that served", async () => {
    vi.mocked(runOcrExtraction).mockResolvedValue({ rows: [] } as never);
    const out = await executeOcrExtraction({
      userId: "u1",
      input: text(),
      budget,
    });
    expect(out).toEqual({ ok: true, data: { rows: [] } });
    expect(reconcileSpend).toHaveBeenCalledWith(
      "u1",
      1500,
      1500,
      "2027-01-15",
      0,
      {
        servedBy: "openai",
        reservedOwner: "operator",
      },
    );
  });

  it("refunds the reservation in full on a clean extract failure", async () => {
    vi.mocked(runOcrExtraction).mockRejectedValue(new OcrExtractError("x"));
    const out = await executeOcrExtraction({
      userId: "u1",
      input: text(),
      budget,
    });
    expect(out).toMatchObject({
      ok: false,
      status: 422,
      errorCode: "labs.ocr.extractFailed",
    });
    expect(reconcileSpend).toHaveBeenCalledWith(
      "u1",
      1500,
      0,
      "2027-01-15",
      0,
      {
        servedBy: null,
        reservedOwner: "operator",
      },
    );
  });

  it("names a provider failure and never keeps the upstream body", async () => {
    vi.mocked(runOcrExtraction).mockRejectedValue(
      Object.assign(new Error("Local AI request failed (403)"), {
        httpStatus: 403,
        model: "llama3",
        bodyExcerpt: "ami-id iam/security-credentials/admin",
      }),
    );
    const out = await executeOcrExtraction({
      userId: "u1",
      input: text(),
      budget,
    });
    expect(out).toMatchObject({ ok: false, status: 502 });
    expect(JSON.stringify(out)).toContain("configured AI provider");
    expect(JSON.stringify(out)).not.toContain("iam/security-credentials");
    expect(JSON.stringify(vi.mocked(annotate).mock.calls)).not.toContain(
      "iam/security-credentials",
    );
    expect(annotate).toHaveBeenCalledWith(
      expect.objectContaining({
        meta: expect.objectContaining({ upstreamStatus: 403, model: "llama3" }),
      }),
    );
  });
});

describe("vision mode", () => {
  it("renders a PDF for a provider without native PDF and sends the pages", async () => {
    vi.mocked(rasterizePdf).mockResolvedValue({
      ok: true,
      images: [{ mediaType: "image/jpeg", dataBase64: "cGFnZQ==" }],
      pageCount: 1,
    });
    vi.mocked(runOcrExtraction).mockResolvedValue({ rows: [] } as never);
    const out = await executeOcrExtraction({
      userId: "u1",
      input: pdf(),
      budget,
    });
    expect(out).toEqual({ ok: true, data: { rows: [] } });
    expect(runOcrExtraction).toHaveBeenCalledWith(
      expect.objectContaining({
        images: [{ mediaType: "image/jpeg", dataBase64: "cGFnZQ==" }],
        documents: [],
      }),
    );
  });

  it("says when only the first pages of a long PDF were read", async () => {
    vi.mocked(rasterizePdf).mockResolvedValue({
      ok: true,
      images: Array.from({ length: 10 }, () => ({
        mediaType: "image/jpeg" as const,
        dataBase64: "cGFnZQ==",
      })),
      pageCount: 23,
    });
    vi.mocked(runOcrExtraction).mockResolvedValue({ rows: [] } as never);
    const out = await executeOcrExtraction({
      userId: "u1",
      input: pdf(),
      budget,
    });
    expect(out).toEqual({
      ok: true,
      data: { rows: [], pageCoverage: { read: 10, total: 23 } },
    });
  });

  it("falls back to pdfNeedsAnthropic and refunds when rendering fails", async () => {
    vi.mocked(rasterizePdf).mockResolvedValue({
      ok: false,
      reason: "render-failed",
    });
    const out = await executeOcrExtraction({
      userId: "u1",
      input: pdf(),
      budget,
    });
    expect(out).toMatchObject({
      ok: false,
      status: 422,
      errorCode: "labs.ocr.pdfNeedsAnthropic",
    });
    expect(runOcrExtraction).not.toHaveBeenCalled();
    expect(reconcileSpend).toHaveBeenCalledWith(
      "u1",
      1500,
      0,
      "2027-01-15",
      0,
      {
        servedBy: null,
        reservedOwner: "operator",
      },
    );
  });
});
