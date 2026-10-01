/**
 * v1.12.0 — rated mood factors: resolver + write-path unit coverage.
 *
 * `resolveRatedFactors` resolves catalog keys, drops unknown / non-RATED
 * keys, and rejects an out-of-scale rating. `createTagLinks` persists the
 * rating onto the join and de-dupes a key passed both as a binary key and
 * a rated factor.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const moodTagFindMany = vi.fn();
const linkCreateMany = vi.fn().mockResolvedValue({ count: 0 });
const linkDeleteMany = vi.fn().mockResolvedValue({ count: 0 });
const linkFindMany = vi.fn().mockResolvedValue([]);
const moodEntryFindUnique = vi.fn();

vi.mock("@/lib/db", () => ({
  prisma: {
    moodEntry: { findUnique: (...a: unknown[]) => moodEntryFindUnique(...a) },
    moodTag: { findMany: (...a: unknown[]) => moodTagFindMany(...a) },
    moodEntryTagLink: {
      createMany: (...a: unknown[]) => linkCreateMany(...a),
      deleteMany: (...a: unknown[]) => linkDeleteMany(...a),
      findMany: (...a: unknown[]) => linkFindMany(...a),
    },
  },
}));

import {
  resolveRatedFactors,
  createTagLinks,
  replaceTagLinks,
  replaceRatedFactorLinks,
  RatedFactorOutOfRangeError,
  MoodEntryOwnershipError,
} from "@/lib/mood/tag-links";

beforeEach(() => {
  moodTagFindMany.mockReset();
  linkCreateMany.mockReset().mockResolvedValue({ count: 0 });
  linkDeleteMany.mockReset().mockResolvedValue({ count: 0 });
  linkFindMany.mockReset().mockResolvedValue([]);
  // Default: the acting user owns the entry under test.
  moodEntryFindUnique.mockReset().mockResolvedValue({ userId: "user-1" });
});

/** Existing-link row as `replaceTagLinks` selects it. */
function link(
  moodTagId: string,
  isActive: boolean,
  kind: "BINARY" | "RATED" = "BINARY",
) {
  return { moodTagId, moodTag: { isActive, kind } };
}

describe("resolveRatedFactors", () => {
  it("resolves a valid factor to its catalog id + rating", async () => {
    moodTagFindMany.mockResolvedValue([
      { id: "mt_factor_work", key: "factor_work", scaleMin: 1, scaleMax: 5 },
    ]);
    const out = await resolveRatedFactors([{ key: "factor_work", rating: 4 }]);
    expect(out).toEqual([{ moodTagId: "mt_factor_work", rating: 4 }]);
  });

  it("drops unknown / non-RATED keys (catalog is the source of truth)", async () => {
    // The query already filters by `kind: 'RATED'` + `isActive`, so an
    // unknown / binary key simply doesn't come back.
    moodTagFindMany.mockResolvedValue([]);
    const out = await resolveRatedFactors([{ key: "happy", rating: 3 }]);
    expect(out).toEqual([]);
  });

  it("rejects a rating above the factor's scaleMax", async () => {
    moodTagFindMany.mockResolvedValue([
      {
        id: "mt_factor_conflict",
        key: "factor_conflict",
        scaleMin: 1,
        scaleMax: 2,
      },
    ]);
    await expect(
      resolveRatedFactors([{ key: "factor_conflict", rating: 4 }]),
    ).rejects.toBeInstanceOf(RatedFactorOutOfRangeError);
  });

  it("rejects a rating below the factor's scaleMin", async () => {
    moodTagFindMany.mockResolvedValue([
      { id: "mt_factor_work", key: "factor_work", scaleMin: 1, scaleMax: 5 },
    ]);
    await expect(
      resolveRatedFactors([{ key: "factor_work", rating: 0 }]),
    ).rejects.toBeInstanceOf(RatedFactorOutOfRangeError);
  });

  it("is a no-op on an empty input", async () => {
    const out = await resolveRatedFactors([]);
    expect(out).toEqual([]);
    expect(moodTagFindMany).not.toHaveBeenCalled();
  });
});

describe("createTagLinks with rated factors", () => {
  it("persists the rating onto the join row", async () => {
    moodTagFindMany.mockResolvedValue([
      { id: "mt_factor_work", key: "factor_work", scaleMin: 1, scaleMax: 5 },
    ]);
    await createTagLinks("entry-1", "user-1", [], undefined, [
      { key: "factor_work", rating: 5 },
    ]);
    expect(linkCreateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [
          { moodEntryId: "entry-1", moodTagId: "mt_factor_work", rating: 5 },
        ],
      }),
    );
  });

  it("propagates the out-of-range error before any write", async () => {
    moodTagFindMany.mockResolvedValue([
      {
        id: "mt_factor_conflict",
        key: "factor_conflict",
        scaleMin: 1,
        scaleMax: 2,
      },
    ]);
    await expect(
      createTagLinks("entry-1", "user-1", [], undefined, [
        { key: "factor_conflict", rating: 5 },
      ]),
    ).rejects.toBeInstanceOf(RatedFactorOutOfRangeError);
    expect(linkCreateMany).not.toHaveBeenCalled();
  });
});

describe("replaceTagLinks — archived-tag links survive an entry edit", () => {
  it("preserves an archived-tag link when the body omits its key (note-only edit)", async () => {
    // The entry carries an archived custom tag + an active catalogue tag.
    // The web edit re-sends only the keys the picker can render — the
    // active one — so the archived key is absent from the body.
    linkFindMany.mockResolvedValue([
      link("mt_custom_archived", false),
      link("mt_happy", true),
    ]);
    // `resolveTagKeysToIds` (isActive: true pinned) resolves the body keys.
    moodTagFindMany.mockResolvedValue([{ id: "mt_happy" }]);

    await replaceTagLinks("entry-1", "user-1", ["happy"]);

    expect(linkDeleteMany).not.toHaveBeenCalled();
    expect(linkCreateMany).not.toHaveBeenCalled();
  });

  it("preserves archived links even when the body clears every tag", async () => {
    linkFindMany.mockResolvedValue([
      link("mt_custom_archived", false),
      link("mt_happy", true),
    ]);
    moodTagFindMany.mockResolvedValue([]);

    await replaceTagLinks("entry-1", "user-1", []);

    // Only the ACTIVE link is cleared; the archived link is history.
    expect(linkDeleteMany).toHaveBeenCalledWith({
      where: { moodEntryId: "entry-1", moodTagId: { in: ["mt_happy"] } },
    });
  });

  it("removes an active tag the body dropped", async () => {
    linkFindMany.mockResolvedValue([
      link("mt_happy", true),
      link("mt_tired", true),
    ]);
    moodTagFindMany.mockResolvedValue([{ id: "mt_happy" }]);

    await replaceTagLinks("entry-1", "user-1", ["happy"]);

    expect(linkDeleteMany).toHaveBeenCalledWith({
      where: { moodEntryId: "entry-1", moodTagId: { in: ["mt_tired"] } },
    });
    expect(linkCreateMany).not.toHaveBeenCalled();
  });

  it("adds a new tag while the archived link stays intact", async () => {
    linkFindMany.mockResolvedValue([
      link("mt_custom_archived", false),
      link("mt_happy", true),
    ]);
    moodTagFindMany.mockResolvedValue([{ id: "mt_happy" }, { id: "mt_calm" }]);

    await replaceTagLinks("entry-1", "user-1", ["happy", "calm"]);

    expect(linkCreateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [{ moodEntryId: "entry-1", moodTagId: "mt_calm" }],
      }),
    );
    expect(linkDeleteMany).not.toHaveBeenCalled();
  });

  it("preserves active RATED links while replacing binary links", async () => {
    linkFindMany.mockResolvedValue([
      link("mt_happy", true),
      link("mt_factor_work", true, "RATED"),
    ]);
    moodTagFindMany.mockResolvedValue([]);

    await replaceTagLinks("entry-1", "user-1", []);

    expect(linkDeleteMany).toHaveBeenCalledWith({
      where: { moodEntryId: "entry-1", moodTagId: { in: ["mt_happy"] } },
    });
    expect(linkDeleteMany).not.toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          moodTagId: { in: expect.arrayContaining(["mt_factor_work"]) },
        }),
      }),
    );
  });

  it("createTagLinks (the bulk-ingest path) is additive — it never deletes a link", async () => {
    // The bulk route re-posts an entry via `createTagLinks`; an archived
    // key cannot resolve (isActive pinned) but no existing link is ever
    // deleted, so archived history survives a re-ingest by construction.
    moodTagFindMany.mockResolvedValue([{ id: "mt_happy" }]);

    await createTagLinks("entry-1", "user-1", ["happy", "custom:gone"]);

    expect(linkDeleteMany).not.toHaveBeenCalled();
    expect(linkCreateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [{ moodEntryId: "entry-1", moodTagId: "mt_happy" }],
        skipDuplicates: true,
      }),
    );
  });

  it("replaceRatedFactorLinks deletes every active RATED row, including a null-rated legacy link", async () => {
    moodTagFindMany.mockResolvedValue([]);

    await replaceRatedFactorLinks("entry-1", "user-1", []);

    expect(linkDeleteMany).toHaveBeenCalledWith({
      where: {
        moodEntryId: "entry-1",
        moodTag: { isActive: true, kind: "RATED" },
      },
    });
  });
  it("replaces RATED scores without deleting binary links", async () => {
    moodTagFindMany.mockResolvedValue([
      { id: "mt_factor_work", key: "factor_work", scaleMin: 1, scaleMax: 5 },
    ]);

    await replaceRatedFactorLinks("entry-1", "user-1", [
      { key: "factor_work", rating: 4 },
    ]);

    expect(linkDeleteMany).toHaveBeenCalledWith({
      where: {
        moodEntryId: "entry-1",
        moodTag: { isActive: true, kind: "RATED" },
      },
    });
    expect(linkCreateMany).toHaveBeenCalledWith({
      data: [
        { moodEntryId: "entry-1", moodTagId: "mt_factor_work", rating: 4 },
      ],
      skipDuplicates: true,
    });
  });
});

describe("entry-ownership guard", () => {
  it("createTagLinks throws and writes nothing when the entry is owned by another user", async () => {
    moodEntryFindUnique.mockResolvedValue({ userId: "attacker" });
    await expect(
      createTagLinks("entry-1", "user-1", ["happy"], undefined, []),
    ).rejects.toBeInstanceOf(MoodEntryOwnershipError);
    expect(moodTagFindMany).not.toHaveBeenCalled();
    expect(linkCreateMany).not.toHaveBeenCalled();
  });

  it("createTagLinks throws when the entry does not exist", async () => {
    moodEntryFindUnique.mockResolvedValue(null);
    await expect(
      createTagLinks("missing", "user-1", ["happy"], undefined, []),
    ).rejects.toBeInstanceOf(MoodEntryOwnershipError);
    expect(linkCreateMany).not.toHaveBeenCalled();
  });

  it("replaceRatedFactorLinks throws and touches no links for a foreign entry", async () => {
    moodEntryFindUnique.mockResolvedValue({ userId: "attacker" });
    await expect(
      replaceRatedFactorLinks("entry-1", "user-1", []),
    ).rejects.toBeInstanceOf(MoodEntryOwnershipError);
    expect(linkDeleteMany).not.toHaveBeenCalled();
    expect(linkCreateMany).not.toHaveBeenCalled();
  });

  it("createTagLinks proceeds for an owned entry", async () => {
    moodTagFindMany.mockResolvedValue([]);
    await createTagLinks("entry-1", "user-1", [], undefined, []);
    expect(moodEntryFindUnique).toHaveBeenCalledWith({
      where: { id: "entry-1" },
      select: { userId: true },
    });
  });
});

describe("the write helpers report the keys they did not store", () => {
  it("createTagLinks returns the unresolved binary and factor keys", async () => {
    // First lookup: rated factors (only `factor_work` is a live factor).
    // Second lookup: binary keys (`happy` live; the other two are unknown or
    // archived, which the `isActive` filter makes look the same).
    moodTagFindMany
      .mockResolvedValueOnce([
        { id: "mt_factor_work", key: "factor_work", scaleMin: 1, scaleMax: 5 },
      ])
      .mockResolvedValueOnce([{ id: "mt_happy", key: "happy" }]);

    const dropped = await createTagLinks(
      "entry-1",
      "user-1",
      ["happy", "custom:gone", "no_such_tag", "happy"],
      undefined,
      [
        { key: "factor_work", rating: 3 },
        { key: "factor_retired", rating: 2 },
      ],
    );

    expect(dropped).toEqual({
      droppedTagKeys: ["custom:gone", "no_such_tag"],
      droppedFactorKeys: ["factor_retired"],
    });
  });

  it("createTagLinks reports nothing when every key landed", async () => {
    moodTagFindMany.mockResolvedValue([{ id: "mt_happy", key: "happy" }]);
    expect(await createTagLinks("entry-1", "user-1", ["happy"])).toEqual({
      droppedTagKeys: [],
      droppedFactorKeys: [],
    });
  });

  it("replaceTagLinks does not report a key whose archived link it preserved", async () => {
    // `custom:old` is archived but already on the entry: the edit keeps it,
    // so it is not dropped. `custom:never` resolves to nothing anywhere.
    moodTagFindMany.mockResolvedValue([]);
    linkFindMany.mockResolvedValue([
      {
        moodTagId: "mt_old",
        moodTag: { isActive: false, kind: "BINARY", key: "custom:old" },
      },
    ]);
    expect(
      await replaceTagLinks("entry-1", "user-1", [
        "custom:old",
        "custom:never",
      ]),
    ).toEqual(["custom:never"]);
  });

  it("replaceRatedFactorLinks does not report an archived factor that stays on the entry", async () => {
    moodTagFindMany.mockResolvedValue([]);
    linkFindMany.mockResolvedValue([{ moodTag: { key: "factor_archived" } }]);
    expect(
      await replaceRatedFactorLinks("entry-1", "user-1", [
        { key: "factor_archived", rating: 2 },
        { key: "factor_unknown", rating: 2 },
      ]),
    ).toEqual(["factor_unknown"]);
  });
});
