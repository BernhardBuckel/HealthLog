/**
 * A lab report scan, run in the background worker.
 *
 * `POST /api/labs/ocr/extract` checks the capability, the rate bucket and the
 * budget, validates the upload, seals it into a `DocumentAiRun` and answers
 * 202. This is the read itself: the same PDF handling the route used to do in
 * the request (a native document block on a PDF-capable provider, rendered
 * page images on any other), one extraction with its corrective retry, and the
 * reservation settled against what the provider was asked to do.
 *
 * Nothing is written to the person's record here. The proposed rows go back
 * through the run for the mandatory review screen, and the commit route stays
 * the only write path.
 */
import type { Buffer } from "node:buffer";

import { AI_BUDGETS } from "@/lib/ai/ai-budgets";
import type { ProviderChainType } from "@/lib/ai/provider-chain";
import { settleAiRunBudget } from "@/lib/documents/ai-runs/store";
import type { AiRunBudget, AiRunOutcome } from "@/lib/documents/ai-runs/types";
import { rasterizePdf } from "@/lib/documents/rasterize-pdf";
import type { ProviderChainResolved } from "@/lib/ai/provider-runner";
import type { VisionProviderPick } from "@/lib/labs/ocr-capability";
import { OcrExtractError, runOcrExtraction } from "@/lib/labs/ocr-extract";
import { annotate } from "@/lib/logging/context";
import type { OcrExtractResponseDto } from "@/lib/validations/labs-ocr";

/** The most sequential model calls one scan makes: the read and one retry. */
export const OCR_EXTRACT_MODEL_CALLS = 2;

/** The tokens a scan reserves at enqueue, by mode. */
export const OCR_RESERVE_TOKENS = {
  vision: AI_BUDGETS.ocrExtract.maxTokens,
  text: AI_BUDGETS.ocrExtractText.maxTokens,
} as const;

export type OcrVisionPick = NonNullable<VisionProviderPick["pick"]>;
export interface OcrTextPick {
  entry: ProviderChainResolved;
  providerType: string;
}

export type OcrRunInput =
  | { mode: "text"; text: string; pick: OcrTextPick }
  | {
      mode: "vision";
      bytes: Buffer;
      mime: "image/jpeg" | "image/png" | "image/webp" | "application/pdf";
      pick: OcrVisionPick;
    };

/**
 * The wide-event facts of a failed provider call: the status and the model,
 * never the upstream body. The base URL can be one a user typed, and what an
 * arbitrary endpoint answers has no business in the event stream (v1.39.3);
 * the stored failure carries neither.
 */
function providerFailureMeta(error: unknown, mode?: "text") {
  const err = error as { httpStatus?: unknown; model?: unknown };
  return {
    reason: "provider_error",
    ...(mode ? { mode } : {}),
    ...(typeof err.httpStatus === "number"
      ? { upstreamStatus: err.httpStatus }
      : {}),
    ...(typeof err.model === "string" ? { model: err.model } : {}),
  };
}

/** A failure in the shape the route would answer with (`errorCode` literal, so the catalogue guard reads it). */
const failure = (f: {
  status: number;
  message: string;
  errorCode: string;
}): AiRunOutcome<never> => ({ ok: false, ...f });

/** Read one lab report into proposed rows. The caller authorised the read. */
export async function executeOcrExtraction(args: {
  userId: string;
  input: OcrRunInput;
  budget: AiRunBudget | undefined;
}): Promise<AiRunOutcome<OcrExtractResponseDto>> {
  const { userId, input, budget } = args;
  const servedBy = input.pick.entry.providerType as ProviderChainType;

  if (input.mode === "text") {
    try {
      const result = await runOcrExtraction({
        userId,
        provider: input.pick.entry.instance,
        providerType: input.pick.providerType,
        ocrText: input.text,
      });
      await settleAiRunBudget(userId, budget, budget?.reserved ?? 0, servedBy);
      return { ok: true, data: result };
    } catch (err) {
      // A failed structuring call produced no usable rows; the reservation
      // goes back in full rather than being charged.
      await settleAiRunBudget(userId, budget, 0, null);
      if (err instanceof OcrExtractError) {
        return failure({
          status: 422,
          message: "Couldn't read the report. Try a clearer photo.",
          errorCode: "labs.ocr.extractFailed",
        });
      }
      annotate({
        action: { name: "labs.ocr.extractFailed" },
        meta: providerFailureMeta(err, "text"),
      });
      return failure({
        status: 502,
        message:
          "The configured AI provider could not process this report. Check the provider configuration and retry.",
        errorCode: "labs.ocr.extractFailed",
      });
    }
  }

  const { pick, bytes, mime } = input;
  let images: {
    mediaType: "image/jpeg" | "image/png" | "image/webp";
    dataBase64: string;
  }[];
  let documents: { mediaType: "application/pdf"; dataBase64: string }[];
  let pageCoverage: { read: number; total: number } | undefined;

  if (mime === "application/pdf") {
    if (pick.pdfSupported) {
      images = [];
      documents = [
        { mediaType: "application/pdf", dataBase64: bytes.toString("base64") },
      ];
    } else {
      const raster = await rasterizePdf(bytes);
      if (!raster.ok) {
        annotate({
          action: { name: "labs.ocr.fileRejected" },
          meta: { reason: "pdf_rasterize_failed" },
        });
        await settleAiRunBudget(userId, budget, 0, null);
        return failure({
          status: 422,
          message: "Couldn't read this PDF; upload a photo instead.",
          errorCode: "labs.ocr.pdfNeedsAnthropic",
        });
      }
      images = raster.images;
      documents = [];
      // A PDF longer than the page cap is read from its first pages only, and
      // the person reviewing the rows is the one who needs to know.
      if (raster.pageCount > raster.images.length) {
        pageCoverage = { read: raster.images.length, total: raster.pageCount };
        annotate({
          action: { name: "labs.ocr.pagesCapped" },
          meta: { read: raster.images.length, total: raster.pageCount },
        });
      }
    }
  } else {
    images = [{ mediaType: mime, dataBase64: bytes.toString("base64") }];
    documents = [];
  }

  try {
    const result = await runOcrExtraction({
      userId,
      provider: pick.entry.instance,
      providerType: pick.providerType,
      images,
      documents,
    });
    // The orchestration does not surface token counts; the reserved estimate
    // is the spend ceiling (the provider already billed it).
    await settleAiRunBudget(userId, budget, budget?.reserved ?? 0, servedBy);
    return {
      ok: true,
      data: pageCoverage ? { ...result, pageCoverage } : result,
    };
  } catch (err) {
    await settleAiRunBudget(userId, budget, 0, servedBy);
    if (err instanceof OcrExtractError) {
      return failure({
        status: 422,
        message: "Couldn't read the report. Try a clearer photo.",
        errorCode: "labs.ocr.extractFailed",
      });
    }
    annotate({
      action: { name: "labs.ocr.extractFailed" },
      meta: providerFailureMeta(err),
    });
    return failure({
      status: 502,
      message:
        "The configured AI provider could not process this report. Check the provider configuration and retry.",
      errorCode: "labs.ocr.extractFailed",
    });
  }
}
