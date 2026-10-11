/**
 * v1.19.0 — server-authoritative mood logging from the Telegram bot.
 *
 * The HTTP mood-create path (`POST /api/mood-entries`) is bound to a
 * cookie/Bearer session via `requireAuth`; the Telegram webhook resolves
 * the user from the linked chat instead. This helper holds the shared
 * write so the two entry points agree on the canonical shape: the same
 * `getScoreForMood` / `moodDateKey` derivation, the same per-user `tz`
 * anchoring, the same cache invalidation + DAY-rollup recompute the route
 * fires. `source` is "TELEGRAM" by default; a notification quick answer
 * (`/api/notifications/action/<token>`) writes the same shape under
 * "NOTIFICATION". Both are free-text source values, no enum migration.
 *
 * The `userId` is NEVER taken from the Telegram payload — the caller
 * passes the id it resolved from the stored `telegramChatId` binding.
 */
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { prisma as defaultPrisma } from "@/lib/db";
import { MOOD_ENUM_BY_SCORE } from "@/lib/mood/labels";
import { getScoreForMood } from "@/lib/validations/mood";
import { deriveA1 } from "@/lib/mood/level-a";
import { moodDateKey } from "@/lib/mood/date-key";
import { DEFAULT_TIMEZONE } from "@/lib/tz/format";
import { encryptNote } from "@/lib/crypto/note-cipher";
import { invalidateUserMood } from "@/lib/cache/invalidate";
import { recomputeMoodBucketsForEntry } from "@/lib/rollups/mood-rollups";
import { getEvent } from "@/lib/logging/context";

/** The quick-write sources that share this helper. */
export type QuickMoodSource = "TELEGRAM" | "NOTIFICATION";

export interface TelegramMoodResult {
  /** True when a new row was written; false when the idempotency key already had one. */
  created: boolean;
  moodEntryId: string;
  score: number;
}

/**
 * Log a mood entry on behalf of a Telegram-linked user.
 *
 * Idempotent on `externalId` (the per-tap key the caller derives from
 * `telegram:mood:<chatId>:<messageId>:<score>`): a redelivered callback
 * update converges onto the same row via the NULL-distinct
 * `(userId, source, externalId)` unique instead of minting a duplicate.
 */
export async function logTelegramMood(input: {
  userId: string;
  score: number;
  tz: string | null;
  /** Stable per-tap id for Telegram redelivery dedup. */
  externalId: string;
  note?: string | null;
  /** Provenance of the quick write. Default "TELEGRAM". */
  source?: QuickMoodSource;
  client?: PrismaClient | Prisma.TransactionClient;
}): Promise<TelegramMoodResult> {
  const source = input.source ?? "TELEGRAM";
  const prisma = (input.client ?? defaultPrisma) as PrismaClient;
  const mood = MOOD_ENUM_BY_SCORE[input.score];
  if (!mood) {
    throw new Error(`Invalid mood score: ${input.score}`);
  }
  const score = getScoreForMood(mood);
  const moodLoggedAt = new Date();
  const tz = input.tz ?? DEFAULT_TIMEZONE;
  const date = moodDateKey(moodLoggedAt, tz);

  const existing = await prisma.moodEntry.findUnique({
    where: {
      userId_source_externalId: {
        userId: input.userId,
        source,
        externalId: input.externalId,
      },
    },
    select: { id: true },
  });

  if (existing) {
    return { created: false, moodEntryId: existing.id, score };
  }

  const entry = await prisma.moodEntry.create({
    data: {
      userId: input.userId,
      date,
      tz,
      mood,
      score,
      // v1.37 — pleasantness derived from the same label the score comes
      // from, so a mood tapped in the chat carries the value a mood typed
      // into the web form would. Nothing here can answer the other four.
      moodA1: deriveA1(mood),
      // v1.23 — encrypt the note at rest; legacy plaintext column nulled.
      note: null,
      noteEncrypted: encryptNote(input.note ?? null),
      source,
      externalId: input.externalId,
      moodLoggedAt,
    },
    select: {
      id: true,
      date: true,
      mood: true,
      note: true,
      noteEncrypted: true,
      tags: true,
    },
  });

  invalidateUserMood(input.userId);

  // Best-effort rollup refresh — a cache tier, never a write-path invariant.
  try {
    await recomputeMoodBucketsForEntry(input.userId, date);
  } catch (rollupErr) {
    getEvent()?.addMeta(
      "telegram_mood_rollup_failed",
      rollupErr instanceof Error ? rollupErr.message : String(rollupErr),
    );
  }

  return { created: true, moodEntryId: entry.id, score };
}

/**
 * Attach a free-text note to an existing Telegram-logged mood entry and
 * refresh the derived caches/rollups. Bounded to 500 chars (the same cap
 * the mood-create Zod schema enforces) so an oversized reply can't bloat
 * the column.
 */
export async function attachTelegramMoodNote(input: {
  userId: string;
  moodEntryId: string;
  note: string;
  client?: PrismaClient | Prisma.TransactionClient;
}): Promise<boolean> {
  const prisma = (input.client ?? defaultPrisma) as PrismaClient;
  const note = input.note.slice(0, 500);
  const updated = await prisma.moodEntry.updateMany({
    where: {
      id: input.moodEntryId,
      userId: input.userId,
      deletedAt: null,
    },
    // v1.23 — encrypt the attached note at rest; legacy plaintext column nulled.
    data: { note: null, noteEncrypted: encryptNote(note) },
  });
  if (updated.count === 0) return false;
  invalidateUserMood(input.userId);
  return true;
}
