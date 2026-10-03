/**
 * Person-defined symptoms (v1.40): the server-only half. Label and note
 * crypto, the row → wire mappers, the 30-day header summary and the one check
 * that decides whether an event may be filed against an episode.
 *
 * Free text (the symptom's name, the note on one occurrence) is held
 * AES-256-GCM encrypted in Bytes columns through the shared codec, the same
 * codec the illness episode note uses, and decrypted fail-soft on read: a key
 * gap on one row reads `null` rather than taking the page down.
 */
import { decryptFromBytes, encryptToBytes } from "@/lib/ai/coach/bytes-codec";
import { prisma } from "@/lib/db";
import { getEvent } from "@/lib/logging/context";
import type {
  SymptomDefinition,
  SymptomEvent,
} from "@/generated/prisma/client";

import type { SymptomDefinitionDTO, SymptomEventDTO } from "./shared";

export * from "./shared";

/** Encrypt a symptom label or event note for storage. */
export function encryptSymptomText(plaintext: string): Uint8Array<ArrayBuffer> {
  return encryptToBytes(plaintext);
}

/** Decrypt a stored label or note; null on a missing or unreadable value. */
export function decryptSymptomText(
  buf: Uint8Array | null,
  field: "label" | "note",
): string | null {
  if (!buf || buf.byteLength === 0) return null;
  try {
    return decryptFromBytes(buf);
  } catch (err) {
    getEvent()?.addWarning(
      `symptom ${field} decrypt failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }
}

/** Header summary of one definition over the trailing window. */
export interface SymptomRecentSummary {
  count30d: number;
  maxIntensity30d: number | null;
  lastOccurredAt: string | null;
}

const EMPTY_RECENT: SymptomRecentSummary = {
  count30d: 0,
  maxIntensity30d: null,
  lastOccurredAt: null,
};

export function toSymptomDefinitionDTO(
  row: Pick<
    SymptomDefinition,
    "id" | "labelEncrypted" | "icon" | "sortOrder" | "isActive"
  >,
  recent: SymptomRecentSummary = EMPTY_RECENT,
): SymptomDefinitionDTO {
  return {
    id: row.id,
    label: decryptSymptomText(row.labelEncrypted, "label"),
    icon: row.icon,
    sortOrder: row.sortOrder,
    isActive: row.isActive,
    recent,
  };
}

export function toSymptomEventDTO(row: SymptomEvent): SymptomEventDTO {
  return {
    id: row.id,
    definitionId: row.definitionId,
    occurredAt: row.occurredAt.toISOString(),
    intensity: row.intensity,
    note: decryptSymptomText(row.noteEncrypted, "note"),
    episodeId: row.episodeId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Every definition of the account with its 30-day summary, ordered for the
 * chip row. One grouped aggregate for the counts and maxima, one for the last
 * occurrence over all time (a symptom last felt two months ago still says so).
 */
export async function listSymptomDefinitions(
  userId: string,
  options: { includeHidden: boolean; now?: Date },
): Promise<SymptomDefinitionDTO[]> {
  const now = options.now ?? new Date();
  const since = new Date(now.getTime() - 30 * DAY_MS);
  const [rows, recent, last] = await Promise.all([
    prisma.symptomDefinition.findMany({
      where: { userId, ...(options.includeHidden ? {} : { isActive: true }) },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }, { id: "asc" }],
      select: {
        id: true,
        labelEncrypted: true,
        icon: true,
        sortOrder: true,
        isActive: true,
      },
    }),
    prisma.symptomEvent.groupBy({
      by: ["definitionId"],
      where: { userId, occurredAt: { gte: since, lte: now } },
      _count: { _all: true },
      _max: { intensity: true },
    }),
    prisma.symptomEvent.groupBy({
      by: ["definitionId"],
      where: { userId },
      _max: { occurredAt: true },
    }),
  ]);
  const recentById = new Map(recent.map((r) => [r.definitionId, r]));
  const lastById = new Map(last.map((r) => [r.definitionId, r._max]));
  return rows.map((row) => {
    const r = recentById.get(row.id);
    const lastAt = lastById.get(row.id)?.occurredAt ?? null;
    return toSymptomDefinitionDTO(row, {
      count30d: r?._count._all ?? 0,
      maxIntensity30d: r?._max.intensity ?? null,
      lastOccurredAt: lastAt ? lastAt.toISOString() : null,
    });
  });
}

/**
 * Whether `episodeId` names an episode an event of `userId` may be filed
 * against: the caller's own, not deleted, and still open. A resolved episode
 * is history; filing a new occurrence into it would rewrite what the person
 * recorded about how it ended.
 */
export async function isLinkableEpisode(
  userId: string,
  episodeId: string,
): Promise<boolean> {
  const episode = await prisma.illnessEpisode.findFirst({
    where: { id: episodeId, userId, deletedAt: null, resolvedAt: null },
    select: { id: true },
  });
  return episode !== null;
}
