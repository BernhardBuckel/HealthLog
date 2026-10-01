import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";

/**
 * v1.8.5 — structured-tag link helpers.
 *
 * Resolve a list of catalog tag keys (`mood_tags.key`) to their ids and
 * write the `mood_entry_tag_links` join for a mood entry. The catalog is
 * the source of truth: an unknown or archived key never mints a link, so a
 * stale client cannot link a tag the deployment doesn't carry. The write
 * helpers return the keys they did not store, and the routes report them
 * per entry (`droppedTagKeys` / `droppedFactorKeys`), so a client is never
 * told an entry landed whole when part of it did not.
 *
 * Every helper accepts an optional `db` client so the caller can thread
 * the same `$transaction` client that wrote the entry — the entry row and
 * its links then commit (or roll back) together.
 */

/**
 * A Prisma client the helpers can run against: the singleton or a
 * `$transaction` interactive client.
 */
type TagLinkDb = PrismaClient | Prisma.TransactionClient;

/**
 * Raised when the acting user does not own the target mood entry. The
 * link helpers refuse to touch links for an entry the session does not
 * own — a structural guard so an edit route can never write a link into
 * another user's entry by passing an attacker-supplied id.
 */
export class MoodEntryOwnershipError extends Error {
  constructor(public readonly moodEntryId: string) {
    super(`Mood entry ${moodEntryId} is not owned by the acting user`);
    this.name = "MoodEntryOwnershipError";
  }
}

/**
 * Assert the target mood entry belongs to `userId`. Throws
 * `MoodEntryOwnershipError` if it does not exist or is owned by someone
 * else. Runs against the same client (tx or singleton) as the link write
 * so the check and the write see one consistent snapshot.
 */
async function assertEntryOwnership(
  moodEntryId: string,
  userId: string,
  db: TagLinkDb,
): Promise<void> {
  const owner = await db.moodEntry.findUnique({
    where: { id: moodEntryId },
    select: { userId: true },
  });
  if (!owner || owner.userId !== userId) {
    throw new MoodEntryOwnershipError(moodEntryId);
  }
}

/**
 * v1.12.0 — a rated factor as it arrives on the wire: a catalog
 * (`mood_tags.key`) + the user's score for this entry.
 */
export interface RatedFactorInput {
  key: string;
  rating: number;
}

/**
 * v1.12.0 — a rated factor resolved to its catalog row id, ready to
 * write onto the `mood_entry_tag_links` join.
 */
interface ResolvedRatedFactor {
  moodTagId: string;
  rating: number;
}

/**
 * v1.12.0 — thrown when a submitted factor rating falls outside the
 * resolved `MoodTag`'s own `scaleMin..scaleMax`. The route maps this to a
 * 422 (the per-tag scale is the real gate; the Zod schema only enforces
 * the outer 1..5 envelope). Unknown / non-RATED keys are NOT an error —
 * the entry still lands without them, matching the binary `tagKeys`
 * posture, and the write helpers report them back as dropped.
 */
export class RatedFactorOutOfRangeError extends Error {
  constructor(
    public readonly key: string,
    public readonly rating: number,
    public readonly scaleMin: number,
    public readonly scaleMax: number,
  ) {
    super(
      `Rating ${rating} for factor "${key}" is outside its scale ${scaleMin}..${scaleMax}`,
    );
    this.name = "RatedFactorOutOfRangeError";
  }
}

/**
 * The submitted keys a write did not store: unknown to the catalog, archived,
 * another account's custom tag, or the wrong kind for the field they came in.
 * Empty arrays when everything landed.
 */
export interface DroppedLinkKeys {
  droppedTagKeys: string[];
  droppedFactorKeys: string[];
}

/**
 * Resolve rated-factor inputs against the catalog. Unknown keys, inactive
 * tags, and `kind = 'BINARY'` keys are not resolved (the catalog is the
 * source of truth, same posture as `resolveTagKeysToIds`). A rating
 * outside the resolved tag's `scaleMin..scaleMax` throws
 * `RatedFactorOutOfRangeError` so the route returns 422. The last value
 * wins on a duplicate key in the same payload.
 */
export async function resolveRatedFactors(
  factors: RatedFactorInput[],
  db: TagLinkDb = prisma,
): Promise<ResolvedRatedFactor[]> {
  return (await resolveRatedFactorsReporting(factors, db)).resolved;
}

/** `resolveRatedFactors`, plus the submitted keys that did not resolve. */
async function resolveRatedFactorsReporting(
  factors: RatedFactorInput[],
  db: TagLinkDb,
): Promise<{ resolved: ResolvedRatedFactor[]; dropped: string[] }> {
  if (factors.length === 0) return { resolved: [], dropped: [] };
  // Last-writer-wins on a duplicate key in the same submission.
  const byKey = new Map<string, number>();
  for (const f of factors) byKey.set(f.key, f.rating);

  const rows = await db.moodTag.findMany({
    // Rated factors are catalogue-only (v1 customs are BINARY); pin to
    // `user_id IS NULL` so a custom row can never be resolved as a factor.
    where: {
      key: { in: [...byKey.keys()] },
      isActive: true,
      kind: "RATED",
      userId: null,
    },
    select: { id: true, key: true, scaleMin: true, scaleMax: true },
  });

  const resolved: ResolvedRatedFactor[] = [];
  for (const row of rows) {
    const rating = byKey.get(row.key);
    if (rating === undefined) continue;
    if (rating < row.scaleMin || rating > row.scaleMax) {
      throw new RatedFactorOutOfRangeError(
        row.key,
        rating,
        row.scaleMin,
        row.scaleMax,
      );
    }
    resolved.push({ moodTagId: row.id, rating });
  }
  const found = new Set(rows.map((row) => row.key));
  return {
    resolved,
    dropped: [...byKey.keys()].filter((key) => !found.has(key)),
  };
}

/**
 * Resolve tag keys to ids, dropping unknown / inactive keys. Returns the ids
 * (deduped).
 *
 * v1.13.0 — when `ownerUserId` is given, a `custom:`-prefixed key resolves
 * ONLY against that user's own custom tags; a bare catalogue key resolves
 * against the global catalogue. A custom key owned by someone else simply
 * does not match (dropped silently — the same posture as an unknown key), so
 * a caller can never link another user's custom tag. Without `ownerUserId`
 * the resolution is catalogue-only (`user_id IS NULL`), never matching any
 * custom row — the safe default, since `{ userId: undefined }` in a Prisma
 * filter would otherwise match every row.
 *
 * `kind` narrows resolution when a caller owns only one half of the split
 * link contract. Edit-time `tagKeys` are binary-only; rated factors use
 * `resolveRatedFactors` and carry their score separately.
 */
export async function resolveTagKeysToIds(
  keys: string[],
  db: TagLinkDb = prisma,
  ownerUserId?: string,
  kind?: "BINARY" | "RATED",
): Promise<string[]> {
  return (await resolveTagKeysReporting(keys, db, ownerUserId, kind)).ids;
}

/** `resolveTagKeysToIds`, plus the submitted keys that did not resolve. */
async function resolveTagKeysReporting(
  keys: string[],
  db: TagLinkDb,
  ownerUserId?: string,
  kind?: "BINARY" | "RATED",
): Promise<{ ids: string[]; dropped: string[] }> {
  const unique = Array.from(new Set(keys));
  if (unique.length === 0) return { ids: [], dropped: [] };
  const ownerClause = ownerUserId
    ? { OR: [{ userId: null }, { userId: ownerUserId }] }
    : { userId: null };
  const rows = await db.moodTag.findMany({
    where: {
      key: { in: unique },
      isActive: true,
      ...(kind ? { kind } : {}),
      ...ownerClause,
    },
    select: { id: true, key: true },
  });
  const found = new Set(rows.map((row) => row.key));
  return {
    ids: rows.map((row) => row.id),
    dropped: unique.filter((key) => !found.has(key)),
  };
}

/**
 * Create the structured-tag links for a freshly-created entry. No-op on
 * an empty / all-unknown key set.
 *
 * v1.12.0 — optionally also writes rated-factor links (`kind = 'RATED'`
 * catalog tags carrying a per-entry `rating`). Binary keys leave `rating`
 * NULL; rated factors persist their score. A factor key passed in both
 * `keys` and `ratedFactors` resolves to a single link carrying the
 * rating (the rated insert wins via `skipDuplicates`, which is why the
 * rated rows are written first). Throws `RatedFactorOutOfRangeError` (→
 * route 422) when a rating is out of the factor's scale. Asserts the
 * entry belongs to `userId` before any write — a defensive guard against
 * linking into an entry the acting session does not own.
 *
 * Returns the submitted keys that were not stored, for the route to report.
 */
export async function createTagLinks(
  moodEntryId: string,
  userId: string,
  keys: string[],
  db: TagLinkDb = prisma,
  ratedFactors: RatedFactorInput[] = [],
): Promise<DroppedLinkKeys> {
  await assertEntryOwnership(moodEntryId, userId, db);
  // Resolve rated factors FIRST so an out-of-range rating aborts before
  // any write, and so the rated rows (which carry a value) take priority
  // over a bare binary row for the same tag id under `skipDuplicates`.
  const { resolved: resolvedFactors, dropped: droppedFactorKeys } =
    await resolveRatedFactorsReporting(ratedFactors, db);
  const ratedTagIds = new Set(resolvedFactors.map((f) => f.moodTagId));

  if (resolvedFactors.length > 0) {
    await db.moodEntryTagLink.createMany({
      // Field-by-field — no mass assignment of the wire object.
      data: resolvedFactors.map((f) => ({
        moodEntryId,
        moodTagId: f.moodTagId,
        rating: f.rating,
      })),
      skipDuplicates: true,
    });
  }

  const binary = await resolveTagKeysReporting(keys, db, userId);
  const tagIds = binary.ids.filter(
    // A key already written as a rated link is not re-inserted as a
    // bare binary row (that would lose the rating to `skipDuplicates`).
    (id) => !ratedTagIds.has(id),
  );
  if (tagIds.length > 0) {
    await db.moodEntryTagLink.createMany({
      data: tagIds.map((moodTagId) => ({ moodEntryId, moodTagId })),
      skipDuplicates: true,
    });
  }
  return { droppedTagKeys: binary.dropped, droppedFactorKeys };
}

/**
 * Replace the active BINARY structured-tag link set for an entry. `keys` is
 * the desired binary set; RATED links are owned by
 * `replaceRatedFactorLinks` and remain untouched. Passing an empty array
 * clears every active binary link. Asserts the entry belongs to `userId`
 * before touching links — a defensive guard against editing links on an
 * entry the acting session does not own.
 *
 * The submitted keys govern ACTIVE tag links only. `resolveTagKeysToIds`
 * pins `isActive: true`, so an archived tag's key can never resolve back
 * into the desired set — without the `isActive` guard below, editing just
 * the note of an old entry would land its archived-tag links in
 * `toDelete` and silently destroy history the archive contract promises
 * to keep (the picker cannot render an archived key as selected, so the
 * client body never carries it). Links whose tag is archived
 * (`isActive: false`) are therefore preserved untouched no matter what
 * the body carries; a purge (`DELETE /api/mood/tags/custom/[key]?purge=true`)
 * remains the only path that removes them.
 *
 * Returns the submitted keys that are not on the entry afterwards. A key
 * whose archived link was preserved is on the entry, so it is not reported.
 */
export async function replaceTagLinks(
  moodEntryId: string,
  userId: string,
  keys: string[],
  db: TagLinkDb = prisma,
): Promise<string[]> {
  await assertEntryOwnership(moodEntryId, userId, db);
  const desired = await resolveTagKeysReporting(keys, db, userId, "BINARY");
  const desiredIds = new Set(desired.ids);
  const existing = await db.moodEntryTagLink.findMany({
    where: { moodEntryId },
    select: {
      moodTagId: true,
      moodTag: { select: { isActive: true, kind: true, key: true } },
    },
  });
  const preservedKeys = new Set(
    existing
      .filter((row) => !row.moodTag.isActive && row.moodTag.kind === "BINARY")
      .map((row) => row.moodTag.key),
  );
  const existingIds = new Set(existing.map((row) => row.moodTagId));

  const toDelete = existing
    .filter(
      (row) =>
        row.moodTag.isActive &&
        row.moodTag.kind === "BINARY" &&
        !desiredIds.has(row.moodTagId),
    )
    .map((row) => row.moodTagId);
  const toCreate = [...desiredIds].filter((id) => !existingIds.has(id));

  if (toDelete.length > 0) {
    await db.moodEntryTagLink.deleteMany({
      where: { moodEntryId, moodTagId: { in: toDelete } },
    });
  }
  if (toCreate.length > 0) {
    await db.moodEntryTagLink.createMany({
      data: toCreate.map((moodTagId) => ({ moodEntryId, moodTagId })),
      skipDuplicates: true,
    });
  }
  return desired.dropped.filter((key) => !preservedKeys.has(key));
}

/**
 * v1.12.0 — replace the full rated-factor link set for an entry. A
 * changed rating on the same factor is a real change, so the helper deletes
 * every active RATED link and re-inserts the desired set. This also upgrades
 * legacy/null-rated RATED rows without colliding with their join key. Binary
 * links are left untouched. Passing an empty array clears every rated link.
 * Throws `RatedFactorOutOfRangeError` (→ route 422) before any write when a
 * rating is out of scale. Asserts the entry belongs to `userId` before any
 * write.
 *
 * Returns the submitted factor keys that are not on the entry afterwards; an
 * archived factor whose link survives is on the entry and is not reported.
 */
export async function replaceRatedFactorLinks(
  moodEntryId: string,
  userId: string,
  factors: RatedFactorInput[],
  db: TagLinkDb = prisma,
): Promise<string[]> {
  await assertEntryOwnership(moodEntryId, userId, db);
  // Resolve (and range-check) before mutating so an out-of-range rating
  // aborts the replace cleanly.
  const { resolved, dropped } = await resolveRatedFactorsReporting(factors, db);
  // Looked up only when something did not resolve: which of those keys still
  // sit on the entry as an archived factor the replacement leaves alone.
  const preservedKeys =
    dropped.length === 0
      ? new Set<string>()
      : new Set(
          (
            await db.moodEntryTagLink.findMany({
              where: {
                moodEntryId,
                moodTag: {
                  isActive: false,
                  kind: "RATED",
                  key: { in: dropped },
                },
              },
              select: { moodTag: { select: { key: true } } },
            })
          ).map((row) => row.moodTag.key),
        );

  // Drop every active RATED link, including a legacy row whose rating is
  // null. Same archive contract as `replaceTagLinks`: a link whose tag has
  // been archived since the entry was logged is history, not editable state
  // and survives the replacement.
  await db.moodEntryTagLink.deleteMany({
    where: {
      moodEntryId,
      moodTag: { isActive: true, kind: "RATED" },
    },
  });

  if (resolved.length > 0) {
    await db.moodEntryTagLink.createMany({
      data: resolved.map((f) => ({
        moodEntryId,
        moodTagId: f.moodTagId,
        rating: f.rating,
      })),
      skipDuplicates: true,
    });
  }
  return dropped.filter((key) => !preservedKeys.has(key));
}

/**
 * The wire form of `DroppedLinkKeys`: each list only when it is non-empty.
 * Absent means every submitted key of that kind landed, which keeps the
 * common response byte-identical to what clients read before the fields
 * existed.
 */
export function droppedLinkKeysForWire(
  dropped: DroppedLinkKeys,
): Partial<DroppedLinkKeys> {
  return {
    ...(dropped.droppedTagKeys.length > 0
      ? { droppedTagKeys: dropped.droppedTagKeys }
      : {}),
    ...(dropped.droppedFactorKeys.length > 0
      ? { droppedFactorKeys: dropped.droppedFactorKeys }
      : {}),
  };
}

/** No key dropped: the value a write that carried no keys reports. */
export const NO_DROPPED_LINK_KEYS: DroppedLinkKeys = Object.freeze({
  droppedTagKeys: [],
  droppedFactorKeys: [],
}) as DroppedLinkKeys;
