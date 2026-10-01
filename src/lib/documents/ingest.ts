/**
 * One way into the vault for a file that has already been read into memory.
 *
 * The upload route (`POST /api/documents/inbound`, cookie, `["*"]` or a
 * `documents:write` token) and the document picker's import route
 * (`POST /api/documents/sources/{system}/import`, which fetches a picked
 * document from Paperless-ngx or Papra) both store through here, so the rules a
 * stored document is held to cannot differ by the way it arrived:
 *
 *   - a source key answers before the bytes are looked at: a key already held
 *     (live, tombstoned, remembered as an alias or kept in the purge ledger) is
 *     a duplicate or a "deleted", never a second copy;
 *   - the per-file cap, the empty-file refusal and magic-byte classification
 *     (the wire Content-Type is never trusted);
 *   - pre-links to the caller's own live episodes and visits, refused when an
 *     id names nothing the caller owns;
 *   - sha256 duplicate detection against live rows, remembering the source key
 *     for the existing document so a later delete keeps that key deleted too;
 *     for an import, also against deleted (not yet purged) rows, which answer
 *     "deleted" rather than storing the file again;
 *   - the quota gate and the insert in one transaction under a per-user
 *     advisory lock, and the race on either partial unique index resolved the
 *     way the fast paths above would have answered;
 *   - the audit row, the wide-event annotation, and the background index,
 *     thumbnail and summary jobs (the summary only when the `documentAi`
 *     capability is open and the upload did not ask to defer AI reading).
 *
 * The callers own authentication, rate buckets, request parsing and the shape
 * of their responses. This module returns what happened; it builds no HTTP.
 */
import type { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

import type { AiCapabilityState } from "@/lib/ai/capabilities/types";
import { auditLog } from "@/lib/auth/audit";
import { prisma } from "@/lib/db";
import {
  narrowOwnedEncounterIds,
  narrowOwnedEpisodeIds,
} from "@/lib/documents/links";
import {
  findSourceKey,
  rememberSourceAlias,
  type SourceKeyMatch,
} from "@/lib/documents/source-key";
import {
  encryptDocumentContent,
  type SerialisableDocument,
} from "@/lib/documents/store";
import { detectDocumentType } from "@/lib/documents/upload-policy";
import { enqueueDocumentIndex } from "@/lib/jobs/document-index";
import { enqueueDocumentSummary } from "@/lib/jobs/document-summary";
import { enqueueDocumentThumbnail } from "@/lib/jobs/document-thumbnail";
import { linkTargets } from "@/lib/links";
import { annotate } from "@/lib/logging/context";
import { isP2002 } from "@/lib/prisma-errors";
import type {
  DocumentSourceSystemValue,
  InboundDocumentKindValue,
} from "@/lib/validations/inbound-documents";
import { dateOnlyAtNoonUtc, dayKeyAsUtcMidnight } from "@/lib/tz/date-only";
import { userDayKey } from "@/lib/tz/format";
import { resolveUserTimezone } from "@/lib/tz/resolver";

/**
 * The person's own uploads per hour, from the web or the phone, and the
 * picker's imports with them. A store-only upload touches no provider — the
 * only abuse vector is disk, so a generous ceiling is enough. A narrow
 * `documents:write` token draws on its own bucket instead
 * (`resolveDocumentUploadLimitPerHour`).
 */
export const UPLOAD_LIMIT_PER_HOUR = 60;
export const UPLOAD_WINDOW_MS = 60 * 60 * 1000;

/** The bucket a person's own uploads and picker imports share. */
export function personalUploadBucket(userId: string): string {
  return `documents-upload:${userId}`;
}

/**
 * A YYYY-MM-DD as UTC midnight: the lower bound of that date for a range
 * filter over stored date-only values (which sit at noon UTC, or at UTC
 * midnight for rows written before the noon anchor). Not a storage anchor;
 * a stored date goes through `dateOnlyAtNoonUtc`.
 */
export function isoDateToUtc(value: string): Date {
  return dayKeyAsUtcMidnight(value);
}

export interface IngestInput {
  userId: string;
  /** A narrow `documents:write` token rather than a session or `["*"]`. */
  scoped: boolean;
  /** For the audit row. */
  ipAddress: string | null;
  bytes: Buffer;
  filename: string | null;
  title: string | null;
  kind: InboundDocumentKindValue | null;
  /** YYYY-MM-DD; the upload day when absent. */
  documentDate: string | null;
  episodeIds: string[];
  encounterIds: string[];
  sourceSystem: DocumentSourceSystemValue | null;
  sourceId: string | null;
  /**
   * The source instance (origin) of the key, or null for a key sent without
   * one; see `src/lib/documents/source-key.ts` for how null matches.
   */
  sourceInstance: string | null;
  /** Hold back automatic AI reading (`aiRead=defer`). */
  aiDeferred: boolean;
  /**
   * The caller already asked about this source key (the upload's query-string
   * form answers before the bucket is charged). Skips the second lookup.
   */
  sourceKeyChecked: boolean;
  /** The per-file cap and the quota, resolved by the caller. */
  limits: { maxFileBytes: number; quotaBytes: number };
  /**
   * The `documentAi` capability, asked by the caller's route only once a new
   * document was stored (a duplicate never asks). Passed in rather than asked
   * here so each route that can queue AI work names the capability in its own
   * source, where the AI route inventory reads it.
   */
  documentAi: () => Promise<AiCapabilityState>;
}

export type IngestResult =
  | { kind: "sourceKey"; match: SourceKeyMatch }
  | { kind: "tooLarge"; maxFileBytes: number }
  | { kind: "empty" }
  | { kind: "unsupportedType" }
  | { kind: "episodeNotFound" }
  | { kind: "encounterNotFound" }
  | { kind: "aliasLimit" }
  | { kind: "duplicate"; document: SerialisableDocument }
  | { kind: "quotaExceeded"; usedBytes: number; quotaBytes: number }
  | {
      kind: "stored";
      document: SerialisableDocument;
      servingClass: string;
      linkedEpisodes: number;
      linkedVisits: number;
    };

/** Internal signal: the quota gate inside the insert transaction tripped. */
class QuotaExceededError extends Error {
  constructor(public readonly usedBytes: number) {
    super("Document quota exceeded");
    this.name = "QuotaExceededError";
  }
}

/** A live row with the same bytes, remembering the source key for it. */
async function answerDuplicate(
  input: IngestInput,
  existing: SerialisableDocument,
): Promise<IngestResult> {
  // An import sending bytes that are already stored under another key (or
  // none) is answered with that document — and the key is remembered for it,
  // so once the person deletes the document this key stays deleted too.
  if (input.sourceSystem && input.sourceId) {
    const remembered = await rememberSourceAlias(
      input.userId,
      existing.id,
      input.sourceSystem,
      input.sourceId,
      input.sourceInstance,
    );
    if (remembered === "limit") return { kind: "aliasLimit" };
  }
  return { kind: "duplicate", document: existing };
}

export async function ingestDocument(
  input: IngestInput,
): Promise<IngestResult> {
  const { userId, sourceSystem, sourceId, limits, bytes } = input;
  const sourceInstance = sourceId ? input.sourceInstance : null;

  // A source key answers before the bytes are looked at: an import re-sending
  // what it sent before is a duplicate, and one re-sending a document the
  // person deleted is refused a second copy — live and tombstoned rows both
  // count (the unique index has no `deleted_at` predicate), and past the purge
  // the ledger remembers.
  if (sourceSystem && sourceId && !input.sourceKeyChecked) {
    const match = await findSourceKey(
      userId,
      sourceSystem,
      sourceId,
      sourceInstance,
    );
    if (match) return { kind: "sourceKey", match };
  }

  if (bytes.byteLength > limits.maxFileBytes) {
    return { kind: "tooLarge", maxFileBytes: limits.maxFileBytes };
  }
  if (bytes.byteLength === 0) return { kind: "empty" };

  // Magic-byte classification; the wire Content-Type is never trusted.
  const detected = detectDocumentType(bytes, input.filename);
  if (!detected) return { kind: "unsupportedType" };

  // Pre-linking: every episode id must be a LIVE episode of the caller.
  const episodeIds = await narrowOwnedEpisodeIds(userId, input.episodeIds);
  if (episodeIds === null) return { kind: "episodeNotFound" };

  // Same for the visit ids the review step offered. A refusal rather than a
  // silent drop: the person saw a visit named and would otherwise watch the
  // upload succeed without the link they asked for.
  const encounterIds = await narrowOwnedEncounterIds(
    userId,
    input.encounterIds,
  );
  if (encounterIds === null) return { kind: "encounterNotFound" };

  // sha256 of the PLAINTEXT for same-user duplicate detection.
  const contentSha256 = createHash("sha256").update(bytes).digest("hex");

  // Fast-path dedupe check; the partial unique index closes the race below.
  const existing = await prisma.inboundDocument.findFirst({
    where: { userId, contentSha256, deletedAt: null },
    omit: { contentEncrypted: true },
  });
  if (existing) return answerDuplicate(input, existing);

  // An import (a source key is present) of bytes the person deleted here,
  // arriving under a key HealthLog has not seen: another system, another
  // instance, or a re-scan with a new id. The deletion was a decision about
  // the document, not about one key, so it is answered "deleted", and the
  // new key is remembered on the tombstone so the purge carries it into the
  // ledger. After the 30-day purge the bytes and their hash are gone and only
  // the keys remain; no content hash of a deleted document is kept. A person
  // uploading the file by hand (no key) is making a new copy on purpose.
  if (sourceSystem && sourceId) {
    const tombstone = await prisma.inboundDocument.findFirst({
      where: { userId, contentSha256, deletedAt: { not: null } },
      select: { id: true },
      orderBy: { deletedAt: "desc" },
    });
    if (tombstone) {
      const remembered = await rememberSourceAlias(
        userId,
        tombstone.id,
        sourceSystem,
        sourceId,
        sourceInstance,
      );
      if (remembered === "limit") return { kind: "aliasLimit" };
      return {
        kind: "sourceKey",
        match: { state: "deleted", id: tombstone.id },
      };
    }
  }

  // Quota gate + insert + pre-links in ONE transaction. Usage counts every
  // non-purged row — tombstones still hold TOAST bytes, so "deleted" bytes
  // are never invisible weight (undo-delete never changes usage).
  let document: SerialisableDocument;
  try {
    document = await prisma.$transaction(async (tx) => {
      // Serialise the quota gate per user: without this, N concurrent
      // uploads all read the same SUM before any of them commits and the
      // quota can be overshot by up to N × cap in one burst. The advisory
      // lock is transaction-scoped (released on commit/rollback) and keyed
      // on the user id, so uploads by different users never queue on each
      // other.
      // (`pg_advisory_xact_lock` returns void, which the client cannot
      // deserialize as a column — selecting FROM it yields a plain int row.)
      await tx.$queryRaw`
        SELECT 1 AS locked
        FROM pg_advisory_xact_lock(hashtextextended('documents-quota:' || ${userId}, 0))
      `;
      const rows = await tx.$queryRaw<Array<{ used: bigint }>>`
        SELECT COALESCE(SUM(byte_size), 0)::bigint AS used
        FROM inbound_documents
        WHERE user_id = ${userId}
      `;
      const usedBytes = Number(rows[0]?.used ?? 0);
      if (usedBytes + bytes.byteLength > limits.quotaBytes) {
        throw new QuotaExceededError(usedBytes);
      }

      const { content, codec } = encryptDocumentContent(bytes);

      // No mass assignment — every column is set field-by-field; `userId`
      // comes from the session, never the body. `documentDate` defaults to
      // the upload day so display == sort == filter (user-editable later).
      const created = await tx.inboundDocument.create({
        data: {
          userId,
          kind: input.kind ?? "OTHER",
          // Stored plaintext on purpose (mirrors `filename`) so the list can
          // ILIKE-search + ORDER BY it. It MAY hold PHI the user types; that
          // is the accepted tradeoff for server-side search/sort — the
          // document body stays encrypted.
          title: input.title,
          filename: input.filename ? input.filename.slice(0, 255) : null,
          mimeType: detected.mimeType,
          byteSize: bytes.byteLength,
          contentEncrypted: content,
          contentCodec: codec,
          contentSha256,
          status: "STORED",
          // The upload day when none is stated is the uploader's own day,
          // not the UTC one (just after midnight east of UTC that was
          // yesterday).
          documentDate: dateOnlyAtNoonUtc(
            input.documentDate ??
              userDayKey(new Date(), await resolveUserTimezone(input.userId)),
          ),
          sourceSystem,
          sourceId,
          sourceInstance,
          aiReadDeferred: input.aiDeferred,
        },
        omit: { contentEncrypted: true },
      });

      if (episodeIds.length > 0) {
        await linkTargets(tx, {
          userId,
          sourceKind: "document",
          sourceId: created.id,
          targetKind: "conditionEpisode",
          targetIds: episodeIds,
        });
      }
      if (encounterIds.length > 0) {
        await linkTargets(tx, {
          userId,
          sourceKind: "document",
          sourceId: created.id,
          targetKind: "encounter",
          targetIds: encounterIds,
        });
      }
      return created;
    });
  } catch (err) {
    if (err instanceof QuotaExceededError) {
      return {
        kind: "quotaExceeded",
        usedBytes: err.usedBytes,
        quotaBytes: limits.quotaBytes,
      };
    }
    if (isP2002(err)) {
      // A racing upload won one of the two partial unique indexes — the same
      // source key, or the same bytes. Surface the winner exactly as the fast
      // paths above would have.
      if (sourceSystem && sourceId) {
        const match = await findSourceKey(
          userId,
          sourceSystem,
          sourceId,
          sourceInstance,
        );
        if (match) return { kind: "sourceKey", match };
      }
      const winner = await prisma.inboundDocument.findFirst({
        where: { userId, contentSha256, deletedAt: null },
        omit: { contentEncrypted: true },
      });
      if (winner) return answerDuplicate(input, winner);
    }
    throw err;
  }

  await auditLog("documents.inbound.store", {
    userId,
    ipAddress: input.ipAddress,
    details: {
      documentId: document.id,
      mime: detected.mimeType,
      ...(input.scoped ? { scoped: true } : {}),
      ...(sourceSystem ? { sourceSystem } : {}),
    },
  });

  annotate({
    action: { name: "documents.vault.upload" },
    meta: {
      documentId: document.id,
      byteSize: document.byteSize,
      servingClass: detected.servingClass,
      linked: episodeIds.length,
      linkedVisits: encounterIds.length,
      scoped: input.scoped,
      sourceSystem,
      aiDeferred: input.aiDeferred,
    },
  });

  // Auto-index the freshly stored document for content search: enqueue a
  // fire-and-forget background job (provider-first, local text-layer fallback).
  // The caller never blocks on or fails because of indexing — the enqueue is
  // not awaited and swallows its own errors (a missing boss or a transient
  // send failure is a silent no-op). Only fresh inserts enqueue — a duplicate
  // returns early above and never reaches here.
  //
  // `aiRead=defer` narrows it to the local text layer: an import of a whole
  // archive must not turn into one provider call per file. The person reads
  // them later, deliberately, from the document itself.
  if (input.aiDeferred) {
    void enqueueDocumentIndex(userId, document.id, { localOnly: true });
  } else {
    void enqueueDocumentIndex(userId, document.id);
  }

  // Render a preview thumbnail in the background too (pure local compute — no
  // egress). Same fire-and-forget contract; a dropped enqueue is recoverable
  // via the boot backfill.
  void enqueueDocumentThumbnail(userId, document.id);

  // Summarise the freshly stored document in the background — but ONLY when the
  // `documentsAutoAiRead` opt-in is ON (the job re-checks it and the egress
  // consent, and no-ops otherwise) and the `documentAi` capability is open for
  // this record. Storing never depends on AI: the document is stored above
  // whatever the capability says, and the index job still runs its
  // provider-free text-layer path.
  //
  // A deferred upload skips it outright and keeps `summaryState: NONE`, so
  // the detail sheet offers "Generate summary" rather than a pending state.
  const documentAi = input.aiDeferred
    ? { available: false as const, reason: "deferred" }
    : await input.documentAi();
  if (documentAi.available) {
    void enqueueDocumentSummary(userId, document.id);
  } else {
    annotate({
      action: { name: "documents.summary.enqueueSkipped" },
      meta: { documentId: document.id, reason: documentAi.reason },
    });
  }

  return {
    kind: "stored",
    document,
    servingClass: detected.servingClass,
    linkedEpisodes: episodeIds.length,
    linkedVisits: encounterIds.length,
  };
}
