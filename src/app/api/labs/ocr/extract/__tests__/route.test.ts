/**
 * v1.20.1 — POST /api/labs/ocr/extract, TEXT mode.
 *
 * Focus: the text-mode structuring pass reserves the proportionate text budget
 * ceiling (`AI_BUDGETS.ocrExtractText`), not the far larger vision ceiling, and
 * on a clean extraction failure it refunds the reservation in full rather than
 * charging it.
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
vi.mock("@/lib/labs/ocr-extract", async () => {
  const actual = await vi.importActual<typeof import("@/lib/labs/ocr-extract")>(
    "@/lib/labs/ocr-extract",
  );
  return { ...actual, runOcrExtraction: vi.fn() };
});

import { POST } from "../route";
import { AI_BUDGETS } from "@/lib/ai/ai-budgets";
import { requireAuth } from "@/lib/api-handler";
import { prisma } from "@/lib/db";
import { requireLabsOcrProvider } from "@/lib/labs/ocr-capability";
import { requireAiCapability } from "@/lib/ai/capabilities/gate";
import { AiUnavailableError } from "@/lib/ai/capabilities/refusal";
import { rasterizePdf } from "@/lib/documents/rasterize-pdf";
import { reserveBudget, reconcileSpend } from "@/lib/ai/coach/budget";
import { checkRateLimit, refundRateLimit } from "@/lib/rate-limit";
import { OcrExtractError, runOcrExtraction } from "@/lib/labs/ocr-extract";
import { annotate } from "@/lib/logging/context";

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
    vi.mocked(runOcrExtraction).mockResolvedValue({ rows: [] } as never);

    const res = await POST(textReq());
    expect(res.status).toBe(200);

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

  it("refunds the reservation in full on a clean extract failure", async () => {
    vi.mocked(runOcrExtraction).mockRejectedValue(
      new OcrExtractError("unreadable"),
    );

    const res = await POST(textReq());
    expect(res.status).toBe(422);

    // actual spend reconciles to 0 — the failed structuring pass is refunded,
    // not charged at the reserved estimate.
    expect(reconcileSpend).toHaveBeenCalledWith(
      "user-1",
      AI_BUDGETS.ocrExtractText.maxTokens,
      0,
      "2026-06-26",
      0,
      { servedBy: null, reservedOwner: "operator" },
    );
  });

  it("identifies provider failures instead of blaming image quality", async () => {
    vi.mocked(runOcrExtraction).mockRejectedValue(new Error("provider down"));

    const res = await POST(textReq());
    const body = (await res.json()) as { error: string };

    expect(res.status).toBe(502);
    expect(body.error).toContain("configured AI provider");
  });

  it("never passes the upstream body on, to the caller or to the event", async () => {
    const upstreamBody = "ami-id instance-id iam/security-credentials/admin";
    vi.mocked(runOcrExtraction).mockRejectedValue(
      Object.assign(new Error("Local AI request failed (403)"), {
        httpStatus: 403,
        model: "llama3",
        bodyExcerpt: upstreamBody,
      }),
    );

    const res = await POST(textReq());
    expect(res.status).toBe(502);
    expect(await res.text()).not.toContain("iam/security-credentials");
    const events = JSON.stringify(vi.mocked(annotate).mock.calls);
    expect(events).not.toContain("iam/security-credentials");
    // The status and the model stay, so an operator can still tell why.
    expect(annotate).toHaveBeenCalledWith(
      expect.objectContaining({
        meta: expect.objectContaining({ upstreamStatus: 403, model: "llama3" }),
      }),
    );
  });
});

describe("POST /api/labs/ocr/extract — vision PDF rasterization", () => {
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

  it("rasterizes a PDF for a non-Anthropic vision provider and sends the page images", async () => {
    vi.mocked(rasterizePdf).mockResolvedValue({
      ok: true,
      images: [{ mediaType: "image/jpeg", dataBase64: "cGFnZQ==" }],
      pageCount: 1,
    });
    vi.mocked(runOcrExtraction).mockResolvedValue({ rows: [] } as never);

    const res = await POST(pdfReq());
    expect(res.status).toBe(200);
    // The whole PDF was read: no coverage note on the response.
    const whole = (await res.json()) as { data: Record<string, unknown> };
    expect(whole.data).not.toHaveProperty("pageCoverage");
    expect(rasterizePdf).toHaveBeenCalledOnce();
    // The rendered page images flow through as `input_image`s; no native PDF
    // document block is sent for a non-Anthropic provider.
    expect(runOcrExtraction).toHaveBeenCalledWith(
      expect.objectContaining({
        images: [{ mediaType: "image/jpeg", dataBase64: "cGFnZQ==" }],
        documents: [],
      }),
    );
  });

  it("says on the response when only the first pages of a long PDF were read", async () => {
    const tenPages = Array.from({ length: 10 }, () => ({
      mediaType: "image/jpeg" as const,
      dataBase64: "cGFnZQ==",
    }));
    vi.mocked(rasterizePdf).mockResolvedValue({
      ok: true,
      images: tenPages,
      pageCount: 23,
    });
    vi.mocked(runOcrExtraction).mockResolvedValue({ rows: [] } as never);

    const res = await POST(pdfReq());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { pageCoverage?: { read: number; total: number } };
    };
    expect(body.data.pageCoverage).toEqual({ read: 10, total: 23 });
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

  it("falls back to pdfNeedsAnthropic when rasterization fails", async () => {
    vi.mocked(rasterizePdf).mockResolvedValue({
      ok: false,
      reason: "render-failed",
    });

    const res = await POST(pdfReq());
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string | null };
    expect(body.error).toBeTruthy();
    // A failed render never reaches the provider — and refunds the reservation.
    expect(runOcrExtraction).not.toHaveBeenCalled();
    expect(reconcileSpend).toHaveBeenCalledWith(
      "user-1",
      AI_BUDGETS.ocrExtract.maxTokens,
      0,
      "2026-06-26",
      0,
      { servedBy: null, reservedOwner: "operator" },
    );
  });
});

describe("POST /api/labs/ocr/extract — the hourly scan bucket", () => {
  it("charges the ceiling the operator set", async () => {
    vi.stubEnv("LABS_OCR_LIMIT_PER_HOUR", "40");
    vi.mocked(runOcrExtraction).mockResolvedValue({ rows: [] } as never);
    const res = await POST(textReq() as never);
    expect(res.status).toBe(200);
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

  it("keeps the slot once the provider was actually called", async () => {
    vi.mocked(runOcrExtraction).mockRejectedValue(new Error("provider down"));
    const failed = await POST(textReq() as never);
    expect(failed.status).toBe(502);
    expect(refundRateLimit).not.toHaveBeenCalled();

    vi.mocked(runOcrExtraction).mockResolvedValue({ rows: [] } as never);
    const ok = await POST(textReq() as never);
    expect(ok.status).toBe(200);
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
