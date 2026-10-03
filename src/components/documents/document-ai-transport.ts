"use client";

/**
 * v1.27.22 (Document vault P2) — the shared client transport for the document
 * AI routes (suggest / summary / index). One place decides VISION vs local-OCR
 * TEXT so every affordance posts a shape the endpoint accepts:
 *   - `mode: "vision"` → an empty-body POST; the server decrypts the stored
 *     original and runs one provider call.
 *   - `mode: "text"`  → the browser OCR's the image on-device (tesseract, lazy
 *     loaded) and posts ONLY the text. Images only — a PDF/attachment in text
 *     mode is refused client-side before any download/OCR work.
 *
 * A provider call is slow, so requests opt out of the default 15 s fetch window.
 * The ceiling is derived from the `ai.provider.responseTimeoutMs` the account
 * payload publishes (the person's response-timeout setting, resolved on the
 * server) times the model calls the route can make, plus a margin, so the
 * browser never abandons a read the server is still allowed to finish.
 *
 * v1.40 — a route that offers the background path is called with
 * `Prefer: respond-async` (`background`). The request then only queues the
 * read and answers 202 quickly, and the result is polled from the run, so no
 * proxy in front of the server can cut a long read. Such a call carries no
 * model-time ceiling at all; the run's own deadline (the same setting) ends
 * it on the server.
 */
import type { QueryClient } from "@tanstack/react-query";

import { resolveAiRun, type WaitForAiRunOptions } from "@/hooks/use-ai-run";
import { apiFetchRaw, apiPost } from "@/lib/api/api-fetch";
import { clientAbortMs } from "@/lib/ai/effective-timeout";
import type { AiRunAccepted } from "@/lib/documents/ai-runs/types";
import { ocrImageToText, LocalOcrError } from "@/lib/labs/local-ocr";

/** The transport an AI call uses, resolved from the OCR capability probe. */
export type DocumentAiMode = "vision" | "text";

/** The document facts the transport needs to fetch + OCR the original. */
export interface DocumentAiTarget {
  documentId: string;
  mimeType: string;
  filename: string | null;
  servingClass: "inline" | "attachment";
}

/**
 * A client-side precondition failure that never reached the server (the image
 * couldn't be fetched, the file isn't an image for text mode, or local OCR
 * failed). Carries a stable `reason` the UI maps to a translated message.
 */
export class DocumentAssistClientError extends Error {
  readonly reason: "textImageOnly" | "originalFetch" | "ocr";
  constructor(reason: DocumentAssistClientError["reason"]) {
    super(reason);
    this.name = "DocumentAssistClientError";
    this.reason = reason;
  }
}

function isImageMime(mime: string): boolean {
  return mime.startsWith("image/");
}

/** Fetch the stored original as a `File` for in-browser OCR (same-origin). */
async function fetchOriginalAsFile(target: DocumentAiTarget): Promise<File> {
  let res: Response;
  try {
    res = await apiFetchRaw(
      `/api/documents/inbound/${target.documentId}/original`,
      { signal: AbortSignal.timeout(30_000) },
    );
  } catch {
    throw new DocumentAssistClientError("originalFetch");
  }
  if (!res.ok) throw new DocumentAssistClientError("originalFetch");
  const blob = await res.blob();
  return new File([blob], target.filename ?? "document", {
    type: blob.type || target.mimeType,
  });
}

/** How long a queuing request may take: the upload and the enqueue, no model. */
const QUEUE_REQUEST_TIMEOUT_MS = 60_000;

/** The background path of a document AI call. */
export interface DocumentAiBackground extends WaitForAiRunOptions {
  queryClient: QueryClient;
  onQueued?: () => void;
}

/** Run one document AI call over the chosen transport. */
export async function runDocumentAi<T>(opts: {
  path: string;
  mode: DocumentAiMode;
  target: DocumentAiTarget;
  /** `ai.provider.responseTimeoutMs` from the account payload. */
  responseTimeoutMs: number;
  /**
   * The most sequential model calls the route makes on one request: one for
   * suggest and summary; three for index (the transcription, then the lab
   * staging read with its one corrective retry).
   */
  modelCalls: number;
  /** Queue the read and poll it (the route must offer `Prefer: respond-async`). */
  background?: DocumentAiBackground;
}): Promise<T> {
  const background = opts.background;
  const timeoutMs = background
    ? QUEUE_REQUEST_TIMEOUT_MS
    : clientAbortMs(opts.responseTimeoutMs, opts.modelCalls);
  const headers: HeadersInit | undefined = background
    ? { Prefer: "respond-async" }
    : undefined;
  const settle = async (data: T | AiRunAccepted): Promise<T> =>
    background
      ? resolveAiRun<T>(background.queryClient, data, background)
      : (data as T);
  if (opts.mode === "text") {
    if (
      opts.target.servingClass !== "inline" ||
      !isImageMime(opts.target.mimeType)
    ) {
      // tesseract.js reads images only — refuse before any download/OCR work.
      throw new DocumentAssistClientError("textImageOnly");
    }
    const file = await fetchOriginalAsFile(opts.target);
    let text: string;
    try {
      text = await ocrImageToText(file);
    } catch (err) {
      throw err instanceof LocalOcrError
        ? new DocumentAssistClientError("ocr")
        : err;
    }
    return settle(
      await apiPost<T | AiRunAccepted>(
        opts.path,
        { mode: "text", text },
        { signal: AbortSignal.timeout(timeoutMs), headers },
      ),
    );
  }
  // Vision: empty body → the route dispatches to its vision handler.
  return settle(
    await apiPost<T | AiRunAccepted>(opts.path, undefined, {
      signal: AbortSignal.timeout(timeoutMs),
      headers,
    }),
  );
}

/** The index route's result, including the lab-staging continuation. */
export interface DocumentIndexResult {
  indexed: boolean;
  tokenCount: number;
  /**
   * How many lab facts the read continued into staging (PENDING, for the
   * review step). 0 when the document is not a lab report or staging was not
   * eligible. Confirmation stays the only write into Labs.
   */
  labFactsStaged: number;
}

/**
 * Populate / refresh one document's content index over the chosen transport.
 * Always in the background: the read and the lab staging after it are up to
 * three model calls, which no proxy timeout should be able to cut.
 */
export function runDocumentIndex(opts: {
  mode: DocumentAiMode;
  target: DocumentAiTarget;
  responseTimeoutMs: number;
  background: DocumentAiBackground;
}): Promise<DocumentIndexResult> {
  return runDocumentAi<DocumentIndexResult>({
    path: `/api/documents/inbound/${opts.target.documentId}/index`,
    mode: opts.mode,
    target: opts.target,
    responseTimeoutMs: opts.responseTimeoutMs,
    modelCalls: 3,
    background: opts.background,
  });
}
