/**
 * Fact extraction from a stored document: the body both the synchronous
 * extract route and the background run execute, so the two paths cannot
 * drift.
 *
 * One extraction (a read and its one corrective retry) over text the browser
 * read, the document's own stored text, or the stored original, against a
 * reservation the caller already took and which is settled here. The facts
 * land PENDING for the mandatory review step; the confirm route stays the only
 * write into the person's record.
 *
 * Staging re-checks the document under a row lock. The route refuses a
 * confirmed or partly confirmed document before it charges anything, but a
 * background read can take minutes, and a review the person finishes in the
 * meantime must never have its approved facts replaced by fresh PENDING ones
 * (which could then be approved a second time). So the staging transaction
 * locks the document row, asks again, and refuses with the route's own code.
 */
import { Buffer } from "node:buffer";

import type { ProviderChainType } from "@/lib/ai/provider-chain";
import { auditLog } from "@/lib/auth/audit";
import { prisma } from "@/lib/db";
import {
  refundDocumentAiSlot,
  type LoadedDocument,
} from "@/lib/documents/ai-route-support";
import {
  InboundExtractError,
  runInboundExtraction,
  type InboundExtractionResult,
  type RunInboundExtractionArgs,
} from "@/lib/documents/extract";
import {
  decryptDocumentContent,
  encryptFactData,
  encryptFactProvenance,
} from "@/lib/documents/store";
import { detectOcrMimeType } from "@/lib/labs/ocr-upload";
import { annotate } from "@/lib/logging/context";
import { dateOnlyAtNoonUtc } from "@/lib/tz/date-only";

import {
  runFailure,
  unreadableDocument,
  type DocumentTextPick,
  type DocumentVisionPick,
  type RunOrigin,
} from "./run-support";
import { settleAiRunBudget } from "./store";
import type { AiRunBudget, AiRunOutcome } from "./types";

/** The extraction and its one corrective retry. */
export const DOCUMENT_EXTRACT_MODEL_CALLS = 2;

/**
 * What the extraction reads: text the browser read (`text`), the document's
 * own content index (`stored`, loaded by the caller), or the stored original
 * (`vision`).
 */
export type DocumentExtractInput =
  | {
      mode: "text" | "stored";
      text: string;
      pick: DocumentTextPick;
      budget: AiRunBudget;
    }
  | { mode: "vision"; pick: DocumentVisionPick; budget: AiRunBudget };

/** The staged document with its facts, for the route's detail body. */
export type StagedDocument = Awaited<ReturnType<typeof stageExtraction>>;

class StagingRefused extends Error {
  constructor(readonly outcome: AiRunOutcome<never>) {
    super("staging refused");
  }
}

/**
 * Replace the document's staged facts and flip it to EXTRACTED in one
 * transaction, after locking the row and asking again whether it may be.
 *
 * Re-extraction is allowed only when NO fact is APPROVED and the document is
 * not CONFIRMED, so clearing every prior staged fact here can never drop an
 * approved row or sever a committed-record provenance link: the only facts
 * present are PENDING / REJECTED leftovers from an earlier run.
 */
async function stageExtraction(
  documentId: string,
  userId: string,
  result: InboundExtractionResult,
) {
  return prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ status: string }[]>`
      SELECT status::text AS status
        FROM inbound_documents
       WHERE id = ${documentId} AND user_id = ${userId} AND deleted_at IS NULL
       FOR UPDATE`;
    const status = locked[0]?.status;
    if (!status) {
      throw new StagingRefused(
        runFailure({
          status: 404,
          message: "Document not found",
          errorCode: "documents.inbound.notFound",
        }),
      );
    }
    if (status === "CONFIRMED") {
      throw new StagingRefused(
        runFailure({
          status: 422,
          message: "This document has already been confirmed.",
          errorCode: "documents.inbound.alreadyConfirmed",
        }),
      );
    }
    const approved = await tx.extractedFact.count({
      where: { documentId, userId, status: "APPROVED" },
    });
    if (approved > 0) {
      throw new StagingRefused(
        runFailure({
          status: 409,
          message:
            "Some facts from this document are already confirmed. Finish reviewing or discard it before extracting again.",
          errorCode: "documents.inbound.alreadyPartlyConfirmed",
        }),
      );
    }
    await tx.extractedFact.deleteMany({ where: { documentId, userId } });
    await tx.inboundDocument.update({
      where: { id: documentId },
      data: {
        status: "EXTRACTED",
        providerType: result.providerType,
        reportDate: result.reportDate
          ? dateOnlyAtNoonUtc(result.reportDate)
          : null,
        facts: {
          create: result.facts.map((f) => ({
            userId,
            factType: f.factType,
            status: "PENDING" as const,
            confidence: f.confidence,
            needsReview: f.needsReview,
            dataEncrypted: encryptFactData(f.data),
            provenanceEncrypted: encryptFactProvenance(f.provenance),
          })),
        },
      },
    });
    return tx.inboundDocument.findUniqueOrThrow({
      where: { id: documentId },
      include: { facts: { orderBy: { createdAt: "asc" } } },
    });
  });
}

/**
 * The provider input for the stored original: decrypted, its MIME re-derived
 * from the bytes (never the stored label), a PDF only for a provider that
 * reads one. Every miss happens before the dispatch.
 */
function visionArgs(
  document: LoadedDocument,
  pick: DocumentVisionPick,
):
  Pick<RunInboundExtractionArgs, "images" | "documents"> | AiRunOutcome<never> {
  let buffer: Buffer;
  try {
    buffer = decryptDocumentContent(
      document.contentEncrypted,
      document.contentCodec,
    );
  } catch {
    return runFailure({
      status: 422,
      message: "Couldn't read the stored document.",
      errorCode: "documents.inbound.extractFailed",
    });
  }
  const mime = detectOcrMimeType(buffer);
  if (!mime) {
    return runFailure({
      status: 422,
      message: "This document can't be scanned. Use local OCR (text mode).",
      errorCode: "documents.inbound.fileType",
    });
  }
  if (mime === "application/pdf" && !pick.pdfSupported) {
    return runFailure({
      status: 422,
      message:
        "PDF scanning needs a Claude vision provider; use local OCR instead.",
      errorCode: "documents.inbound.pdfNeedsAnthropic",
    });
  }
  const dataBase64 = buffer.toString("base64");
  return mime === "application/pdf"
    ? { images: [], documents: [{ mediaType: "application/pdf", dataBase64 }] }
    : { images: [{ mediaType: mime, dataBase64 }], documents: [] };
}

/** Extract and stage facts from one owned document. The caller authorised and charged it. */
export async function executeDocumentExtract(args: {
  userId: string;
  document: LoadedDocument;
  input: DocumentExtractInput;
  origin: RunOrigin;
}): Promise<AiRunOutcome<StagedDocument>> {
  const { userId, document, input, origin } = args;
  const { pick, budget } = input;
  const servedBy = pick.entry.providerType as ProviderChainType;

  let source: Pick<
    RunInboundExtractionArgs,
    "images" | "documents" | "ocrText"
  >;
  if (input.mode === "vision") {
    const prepared = visionArgs(document, input.pick);
    if ("ok" in prepared) {
      // Preparation failed before any provider dispatch: the reservation and
      // the slot go back.
      await settleAiRunBudget(userId, budget, 0, null);
      await refundDocumentAiSlot(userId);
      return prepared;
    }
    source = prepared;
  } else {
    source = { ocrText: input.text };
  }

  let result: InboundExtractionResult;
  try {
    result = await runInboundExtraction({
      provider: pick.entry.instance,
      providerType: pick.providerType,
      ...source,
    });
  } catch (err) {
    await settleAiRunBudget(userId, budget, 0, null);
    if (!(err instanceof InboundExtractError)) {
      annotate({
        action: { name: "documents.inbound.extractFailed" },
        meta: { reason: "provider_error", mode: input.mode },
      });
    }
    return unreadableDocument(err instanceof InboundExtractError);
  }
  await settleAiRunBudget(userId, budget, budget.reserved, servedBy);

  let staged: StagedDocument;
  try {
    staged = await stageExtraction(document.id, userId, result);
  } catch (err) {
    if (!(err instanceof StagingRefused)) {
      // The reservation is already settled for the call that was made; a
      // write that failed is answered as the route always answered it.
      annotate({
        action: { name: "documents.inbound.extractFailed" },
        meta: { reason: "staging_error", mode: input.mode },
      });
      return unreadableDocument(false);
    }
    annotate({
      action: { name: "documents.inbound.extractRefusedAtStaging" },
      meta: {
        documentId: document.id,
        errorCode: err.outcome.ok ? null : err.outcome.errorCode,
      },
    });
    return err.outcome;
  }

  await auditLog("documents.inbound.extract", {
    userId,
    ...(origin.worker ? { actorUserId: userId } : {}),
    ipAddress: origin.ipAddress,
    details: {
      documentId: document.id,
      facts: staged.facts.length,
      mode: input.mode,
    },
  });
  return { ok: true, data: staged };
}
