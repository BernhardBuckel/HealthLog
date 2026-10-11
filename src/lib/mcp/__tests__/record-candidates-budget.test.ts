/**
 * `loadRecordCandidates` under the in-app search's budget: a kind stops
 * building candidates once `shouldStop` says so, keeps its newest rows, and
 * says it did not see everything; a kind not started when the budget is
 * spent is not read at all.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    user: { findUnique: vi.fn(async () => null) },
    encounter: { findMany: vi.fn() },
    illnessEpisode: { findMany: vi.fn(async () => []) },
  },
}));

vi.mock("@/lib/db", () => ({ prisma: prismaMock }));

import { loadRecordCandidates } from "../record-search";

function encounters(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `e${i}`,
    userId: "u1",
    occurredAt: new Date(Date.UTC(2026, 0, 30 - i)),
    kind: "CHECKUP",
    status: "COMPLETED",
    reasonEncrypted: null,
    outcomeEncrypted: null,
    bodySiteEncrypted: null,
    laterality: null,
    practitioner: null,
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("loadRecordCandidates under a budget", () => {
  it("stops a kind part-way, newest first, and reports it", async () => {
    prismaMock.encounter.findMany.mockResolvedValue(encounters(10));
    let checks = 0;
    const truncated: string[] = [];

    const out = await loadRecordCandidates("u1", "visit", "", {
      kinds: new Set(["visit"]),
      rowsPerKind: 100,
      // One check before the kind starts, then one per row: the fifth
      // check, before the fourth row, says stop.
      shouldStop: () => ++checks > 4,
      onTruncated: (kind) => truncated.push(kind),
    });

    expect(out.map((c) => c.id)).toEqual(["visit:e0", "visit:e1", "visit:e2"]);
    expect(truncated).toContain("visit");
  });

  it("does not read a kind once the budget is already spent", async () => {
    const truncated: string[] = [];
    const out = await loadRecordCandidates("u1", "visit", "", {
      kinds: new Set(["visit", "condition"]),
      shouldStop: () => true,
      onTruncated: (kind) => truncated.push(kind),
    });
    expect(out).toEqual([]);
    expect(prismaMock.encounter.findMany).not.toHaveBeenCalled();
    expect(prismaMock.illnessEpisode.findMany).not.toHaveBeenCalled();
    expect(truncated.sort()).toEqual(["condition", "visit"]);
  });

  it("reads everything and reports nothing without a budget", async () => {
    prismaMock.encounter.findMany.mockResolvedValue(encounters(10));
    const truncated: string[] = [];
    const out = await loadRecordCandidates("u1", "visit", "", {
      kinds: new Set(["visit"]),
      rowsPerKind: 100,
      onTruncated: (kind) => truncated.push(kind),
    });
    expect(out).toHaveLength(10);
    expect(truncated).toEqual([]);
  });

  it("does not call a kind holding exactly its cap truncated", async () => {
    prismaMock.encounter.findMany.mockResolvedValue(encounters(5));
    const truncated: string[] = [];
    const out = await loadRecordCandidates("u1", "visit", "", {
      kinds: new Set(["visit"]),
      rowsPerKind: 5,
      onTruncated: (kind) => truncated.push(kind),
    });
    expect(out).toHaveLength(5);
    expect(truncated).toEqual([]);
    // One row past the cap is asked for, as the probe.
    expect(prismaMock.encounter.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 6 }),
    );
  });

  it("calls a kind with a row past its cap truncated, and keeps the cap", async () => {
    prismaMock.encounter.findMany.mockResolvedValue(encounters(6));
    const truncated: string[] = [];
    const out = await loadRecordCandidates("u1", "visit", "", {
      kinds: new Set(["visit"]),
      rowsPerKind: 5,
      onTruncated: (kind) => truncated.push(kind),
    });
    expect(out).toHaveLength(5);
    expect(truncated).toEqual(["visit"]);
  });
});
