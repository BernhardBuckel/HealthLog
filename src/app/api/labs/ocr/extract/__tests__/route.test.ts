/**
 * v1.20.1 — POST /api/labs/ocr/extract.
 *
 * Focus: the text-mode structuring pass reserves the proportionate text budget
 * ceiling (`AI_BUDGETS.ocrExtractText`), not the far larger vision ceiling.
 *
 * v1.40 — the route queues the read and answers 202; the read itself, its
 * budget settlement and its failures are pinned in
 * `src/lib/labs/__tests__/ocr-run.test.ts`. What stays here is everything the
 * route still refuses before anything is queued.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/api-handler", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/api-handler")>(
      "@/lib/api-handler",
    );
  return {
    ...actual,
    apiHandler: <T extends (...args: unknown[]) => Promise<Response>>(
      h: T,
    ): T => h,
    requireAuth: vi.fn(),
  };
});

vi.mock("@/lib/db", () => ({
  prisma: { user: { findUnique: vi.fn() } },
}));
vi.mock("@/lib/logging/context", () => ({ annotate: vi.fn() }));
vi.mock("@/lib/labs/ocr-capability", () => ({
  requireLabsOcrProvider: vi.fn(),
}));
vi.mock("@/lib/ai/capabilities/gate", () => ({
  requireAiCapability: vi.fn(),
}));
vi.mock("@/lib/documents/rasterize-pdf", () => ({
  rasterizePdf: vi.fn(),
}));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(),
  refundRateLimit: vi.fn().mockResolvedValue(undefined),
  rateLimitHeaders: vi.fn(() => ({})),
}));
vi.mock("@/lib/ai/coach/budget", () => ({
  buildDateKey: vi.fn(() => "2026-06-26"),
  reserveBudget: vi.fn(),
  reconcileSpend: vi.fn().mockResolvedValue(undefined),
  resolveDailyCap: vi.fn(() => 200_000),
  resolveDailyCapFor: vi.fn(() => 200_000),
  resolveCostOwner: vi.fn(() => "operator" as const),
}));
vi.mock("@/lib/documents/ai-runs/start", () => ({
  startAiRun: vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          data: { runId: "run-1", status: "QUEUED", pollAfterMs: 1500 },
          error: null,
        }),
        { status: 202 },
      ),
  ),
}));
vi.mock("@/lib/labs/ocr-extract", async () => {
  const actual = await vi.importActual<typeof import("@/lib/labs/ocr-extract")>(
    "@/lib/labs/ocr-extract",
  );
  return { ...actual, runOcrExtraction: vi.fn() };
});

import { POST } from "../route";
import { startAiRun } from "@/lib/documents/ai-runs/start";
import { AI_BUDGETS } from "@/lib/ai/ai-budgets";
import { requireAuth } from "@/lib/api-handler";
import { prisma } from "@/lib/db";
import { requireLabsOcrProvider } from "@/lib/labs/ocr-capability";
import { requireAiCapability } from "@/lib/ai/capabilities/gate";
import { AiUnavailableError } from "@/lib/ai/capabilities/refusal";
import { rasterizePdf } from "@/lib/documents/rasterize-pdf";
import { reserveBudget } from "@/lib/ai/coach/budget";
import { checkRateLimit, refundRateLimit } from "@/lib/rate-limit";
import { runOcrExtraction } from "@/lib/labs/ocr-extract";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "tester", role: "USER" as const },
};

function textReq(text = "Glucose 95 mg/dL"): Request {
  return new Request("http://localhost/api/labs/ocr/extract", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode: "text", text }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.mocked(checkRateLimit).mockResolvedValue({
    allowed: true,
    remaining: 5,
    resetAt: Date.now() + 3_600_000,
  } as never);
  vi.mocked(requireAuth).mockResolvedValue(SESSION_OK as never);
  vi.mocked(prisma.user.findUnique).mockResolvedValue({
    labsLocalOcrEnabled: true,
  } as never);
  vi.mocked(requireAiCapability).mockResolvedValue({
    available: true,
    reason: null,
    onDeviceAllowed: true,
  });
  vi.mocked(requireLabsOcrProvider).mockResolvedValue({
    entry: { providerType: "openai", instance: {} as never },
    providerType: "openai",
  } as never);
  vi.mocked(reserveBudget).mockResolvedValue({
    allowed: true,
    reserved: AI_BUDGETS.ocrExtractText.maxTokens ?? 0,
    totalAfter: AI_BUDGETS.ocrExtractText.maxTokens ?? 0,
    owner: "operator",
    operatorAfter: AI_BUDGETS.ocrExtractText.maxTokens ?? 0,
  } as never);
});

describe("POST /api/labs/ocr/extract — text mode budget", () => {
  it("reserves the cheaper text ceiling, not the vision ceiling", async () => {
    const res = await POST(textReq());
    expect(res.status).toBe(202);

    // The reservation must use the text ceiling — proven distinct from the
    // vision ceiling so a future merge can't silently re-point it.
    expect(AI_BUDGETS.ocrExtractText.maxTokens).toBeLessThan(
      AI_BUDGETS.ocrExtract.maxTokens ?? Infinity,
    );
    expect(reserveBudget).toHaveBeenCalledWith(
      "user-1",
      AI_BUDGETS.ocrExtractText.maxTokens,
      "2026-06-26",
      // F1 — the provider-aware daily cap (mocked) is threaded as the 4th arg.
      200_000,
      // ...the cost owner that cap is enforced against as the 5th...
      "operator",
      // ...and the surface the ceiling is rationed for as the 6th.
      "coach",
    );
  });

  it("queues the text, sealed in the run, with the reservation it took", async () => {
    const res = await POST(textReq("Glucose 95 mg/dL"));
    expect(res.status).toBe(202);
    expect(runOcrExtraction).not.toHaveBeenCalled();
    expect(startAiRun).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        kind: "LABS_OCR_EXTRACT",
        params: {
          mode: "text",
          budget: {
            reserved: AI_BUDGETS.ocrExtractText.maxTokens,
            owner: "operator",
            dateKey: "2026-06-26",
          },
        },
        input: Buffer.from("Glucose 95 mg/dL", "utf8"),
      }),
    );
  });
});

describe("POST /api/labs/ocr/extract — vision uploads", () => {
  function pdfReq(): Request {
    // A minimal `%PDF-` header is all `detectOcrMimeType` needs to sniff a PDF.
    const bytes = new Uint8Array([
      0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x25, 0xe2, 0xe3,
      0xcf, 0xd3, 0x0a,
    ]);
    const file = new File([bytes], "report.pdf", {
      type: "application/pdf",
    });
    const form = new FormData();
    form.append("file", file);
    return new Request("http://localhost/api/labs/ocr/extract", {
      method: "POST",
      body: form,
    });
  }

  beforeEach(() => {
    // A non-Anthropic vision provider (codex): no native PDF block, so the
    // route must rasterize.
    vi.mocked(requireLabsOcrProvider).mockResolvedValue({
      entry: { providerType: "codex", instance: {} as never },
      providerType: "codex",
      pdfSupported: false,
    } as never);
    vi.mocked(reserveBudget).mockResolvedValue({
      allowed: true,
      reserved: AI_BUDGETS.ocrExtract.maxTokens ?? 0,
      totalAfter: AI_BUDGETS.ocrExtract.maxTokens ?? 0,
      owner: "operator",
      operatorAfter: AI_BUDGETS.ocrExtract.maxTokens ?? 0,
    } as never);
  });

  it("queues a PDF with its sniffed type; the worker renders it", async () => {
    const res = await POST(pdfReq());
    expect(res.status).toBe(202);
    // Rendering is the worker's job now; nothing is read in the request.
    expect(rasterizePdf).not.toHaveBeenCalled();
    expect(runOcrExtraction).not.toHaveBeenCalled();
    expect(startAiRun).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "LABS_OCR_EXTRACT",
        params: expect.objectContaining({
          mode: "vision",
          mime: "application/pdf",
        }),
      }),
    );
  });

  it("hands the slot back when the upload is not an image or PDF", async () => {
    const form = new FormData();
    form.append(
      "file",
      new File([new TextEncoder().encode("plain text")], "note.txt", {
        type: "text/plain",
      }),
    );
    const res = await POST(
      new Request("http://localhost/api/labs/ocr/extract", {
        method: "POST",
        body: form,
      }) as never,
    );
    expect(res.status).toBe(415);
    expect(refundRateLimit).toHaveBeenCalledWith("labs-ocr:user-1");
    expect(runOcrExtraction).not.toHaveBeenCalled();
  });
});

describe("POST /api/labs/ocr/extract — the hourly scan bucket", () => {
  it("charges the ceiling the operator set", async () => {
    vi.stubEnv("LABS_OCR_LIMIT_PER_HOUR", "40");
    const res = await POST(textReq() as never);
    expect(res.status).toBe(202);
    expect(checkRateLimit).toHaveBeenCalledWith(
      "labs-ocr:user-1",
      40,
      60 * 60 * 1000,
    );
  });

  it("answers 429 with the reset instant when the bucket is spent", async () => {
    vi.mocked(checkRateLimit).mockResolvedValue({
      allowed: false,
      remaining: 0,
      resetAt: Date.parse("2026-09-15T15:00:00Z"),
    } as never);
    const res = await POST(textReq() as never);
    expect(res.status).toBe(429);
    const body = (await res.json()) as {
      meta: { errorCode: string; retryAt: string };
    };
    expect(body.meta.errorCode).toBe("labs.ocr.rateLimited");
    expect(body.meta.retryAt).toBe("2026-09-15T15:00:00.000Z");
    expect(runOcrExtraction).not.toHaveBeenCalled();
  });

  it("hands the slot back for a malformed text body", async () => {
    const res = await POST(
      new Request("http://localhost/api/labs/ocr/extract", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "text" }),
      }) as never,
    );
    expect(res.status).toBe(422);
    expect(refundRateLimit).toHaveBeenCalledWith("labs-ocr:user-1");
  });

  it("hands the slot back when the daily budget turns the scan away", async () => {
    vi.mocked(reserveBudget).mockResolvedValue({
      allowed: false,
      reserved: 0,
      totalAfter: 999_999,
      owner: "operator",
      operatorAfter: 999_999,
    } as never);
    const res = await POST(textReq() as never);
    expect(res.status).toBe(429);
    expect(refundRateLimit).toHaveBeenCalledWith("labs-ocr:user-1");
    expect(runOcrExtraction).not.toHaveBeenCalled();
  });

  it("keeps the slot once the scan is queued", async () => {
    const queued = await POST(textReq() as never);
    expect(queued.status).toBe(202);
    expect(refundRateLimit).not.toHaveBeenCalled();
  });
});

describe("POST /api/labs/ocr/extract — the labsOcr capability", () => {
  it("refuses before anything is read when the operator turned document reading off", async () => {
    vi.mocked(requireAiCapability).mockRejectedValue(
      new AiUnavailableError("labsOcr", "operator_disabled"),
    );
    const error = await POST(textReq()).catch((e) => e);
    expect(error).toBeInstanceOf(AiUnavailableError);
    expect(error.meta.errorCode).toBe("assistant.disabled.documentAi");
    expect(requireAiCapability).toHaveBeenCalledWith("labsOcr", {
      pickDecides: true,
    });
    expect(requireLabsOcrProvider).not.toHaveBeenCalled();
    expect(checkRateLimit).not.toHaveBeenCalled();
    expect(runOcrExtraction).not.toHaveBeenCalled();
  });

  it("stops at the wire when the pick is refused, before any slot or budget is spent", async () => {
    vi.mocked(requireLabsOcrProvider).mockRejectedValue(
      new AiUnavailableError("labsOcr", "consent_required"),
    );
    const error = await POST(textReq()).catch((e) => e);
    expect(error.meta).toEqual({
      errorCode: "consent.ai.required",
      capability: "labsOcr",
      reason: "consent_required",
    });
    expect(requireLabsOcrProvider).toHaveBeenCalledWith("user-1", "text");
    expect(checkRateLimit).not.toHaveBeenCalled();
    expect(reserveBudget).not.toHaveBeenCalled();
    expect(runOcrExtraction).not.toHaveBeenCalled();
  });

  it("asks for the vision pick on a multipart upload", async () => {
    vi.mocked(requireLabsOcrProvider).mockRejectedValue(
      new AiUnavailableError("labsOcr", "no_provider", null, {
        errorCode: "labs.ocr.providerUnsupported",
      }),
    );
    const form = new FormData();
    form.append("file", new File([new Uint8Array([1])], "a.png"));
    const error = await POST(
      new Request("http://localhost/api/labs/ocr/extract", {
        method: "POST",
        body: form,
      }),
    ).catch((e) => e);
    expect(requireLabsOcrProvider).toHaveBeenCalledWith("user-1", "vision");
    expect(error.status).toBe(422);
    expect(error.meta.errorCode).toBe("labs.ocr.providerUnsupported");
  });
});
