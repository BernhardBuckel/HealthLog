/**
 * The shapes a background document AI run carries: its kinds and states, the
 * outcome a run body returns, the error codes only a run can produce, and the
 * DTO the poll route publishes.
 *
 * A run is a ticket. The request that asked for the read answers 202 with the
 * run id, the worker does the read, and the client polls
 * `GET /api/ai-runs/{id}` until the run is terminal. The result lives in the
 * row for an hour after it finishes and then the row is deleted.
 */
import type { AiCapabilityKey } from "@/lib/ai/capabilities/types";
import type { Locale } from "@/lib/i18n/config";
import type {
  InboundDocumentKindValue,
  InboundDocumentStatusValue,
} from "@/lib/validations/inbound-documents";
import type { OcrExtractResponseDto } from "@/lib/validations/labs-ocr";

export const DOCUMENT_AI_RUN_KINDS = [
  "DOCUMENT_INDEX",
  "LABS_OCR_EXTRACT",
  "DOCUMENT_SUMMARY",
  "DOCUMENT_SUGGEST",
  "DOCUMENT_EXTRACT",
] as const;
export type DocumentAiRunKindValue = (typeof DOCUMENT_AI_RUN_KINDS)[number];

/**
 * The capability each kind of run answers to: the one its queuing route asks,
 * asked again by the worker for the record before anything leaves.
 */
export const DOCUMENT_AI_RUN_CAPABILITY: Record<
  DocumentAiRunKindValue,
  AiCapabilityKey
> = {
  DOCUMENT_INDEX: "documentAi",
  LABS_OCR_EXTRACT: "labsOcr",
  DOCUMENT_SUMMARY: "documentAi",
  DOCUMENT_SUGGEST: "documentAi",
  DOCUMENT_EXTRACT: "documentAi",
};

export const DOCUMENT_AI_RUN_STATUSES = [
  "QUEUED",
  "RUNNING",
  "SUCCEEDED",
  "FAILED",
] as const;
export type DocumentAiRunStatusValue =
  (typeof DOCUMENT_AI_RUN_STATUSES)[number];

/**
 * The codes only a background run produces. Every other failure a run
 * reports carries the code its synchronous route answers with, so a client
 * maps both paths through one table.
 */
export const AI_RUN_ERROR_CODES = {
  notFound: "aiRuns.notFound",
  workerUnavailable: "aiRuns.workerUnavailable",
  timedOut: "aiRuns.timedOut",
  failed: "aiRuns.failed",
} as const;

/** How long a queued run waits for a worker before it is failed. */
export const AI_RUN_QUEUE_WAIT_MS = 15 * 60 * 1000;

/** How long a finished run stays readable before the reaper deletes it. */
export const AI_RUN_RETENTION_MS = 60 * 60 * 1000;

/** Room a running run gets on top of its model calls (decrypt, raster, write). */
export const AI_RUN_MARGIN_MS = 60 * 1000;

/** The interval the 202 tells a client to wait before its first poll. */
export const AI_RUN_POLL_AFTER_MS = 1500;

/** The budget reservation taken at enqueue, settled by whoever ends the run. */
export interface AiRunBudget {
  reserved: number;
  owner: "operator" | "user";
  dateKey: string;
}

/** What a run needs to know to run. Never health data. */
export interface AiRunParams {
  /** `vision` reads the stored original or the uploaded scan; `text` reads text the browser read. */
  mode: "vision" | "text";
  /** The sniffed MIME of an uploaded scan (lab scan, vision mode only). */
  mime?: "image/jpeg" | "image/png" | "image/webp" | "application/pdf";
  /** Present when the enqueue reserved budget for a provider call. */
  budget?: AiRunBudget;
  /** A summary run: what to produce, whether to store it, and in which language. */
  summary?: {
    output: "summary" | "text";
    persist: boolean;
    replace: boolean;
    locale: Locale;
  };
  /** An extract run: which text it structures. `stored` reads the content index. */
  extract?: { input: "text" | "stored" | "vision" };
}

/** "Read with AI": the same body the synchronous index route answers with. */
export interface DocumentIndexRunResult {
  documentId: string;
  indexed: true;
  tokenCount: number;
  labFactsStaged: number;
}

/** A summary run: the summary route's body. */
export type DocumentSummaryRunResult =
  | { summary: string; persistence?: "stored" | "withheld" | "failed" }
  | { text: string };

/** A suggest run: the suggest route's body (drafts, nothing written). */
export interface DocumentSuggestRunResult {
  suggestions: {
    title: string | null;
    kind: InboundDocumentKindValue | null;
    documentDate: string | null;
  };
}

/**
 * An extract run. Smaller than the synchronous route's body (the whole
 * document detail): the facts are staged on the document, and the client
 * reads them from there.
 */
export interface DocumentExtractRunResult {
  documentId: string;
  factsStaged: number;
  status: InboundDocumentStatusValue;
}

export type AiRunResult =
  | DocumentIndexRunResult
  | OcrExtractResponseDto
  | DocumentSummaryRunResult
  | DocumentSuggestRunResult
  | DocumentExtractRunResult;

/**
 * What one run body produced: the success body, or the failure the
 * synchronous route would have answered with.
 */
export type AiRunOutcome<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; message: string; errorCode: string };

/** The poll route's body. */
export interface AiRunDto {
  id: string;
  kind: DocumentAiRunKindValue;
  documentId: string | null;
  status: DocumentAiRunStatusValue;
  result: AiRunResult | null;
  error: { code: string; message: string; status: number } | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  /** How long the run has waited for a worker, while it is still queued. */
  queuedForMs: number | null;
  /** When to ask again, while the run is not terminal. */
  retryAfterMs: number | null;
}

/** The 202 body. */
export interface AiRunAccepted {
  runId: string;
  status: "QUEUED";
  pollAfterMs: number;
}
