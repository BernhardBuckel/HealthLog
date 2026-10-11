/**
 * The bounds of the record search and the masks that pick its sources. The
 * reads themselves are exercised against Postgres in
 * `tests/integration/record-search.test.ts`.
 *
 * Mutation checks (each run, each seen red):
 *   - drop the deadline check in `scanNewest` → "stops when the budget has
 *     run out" goes red;
 *   - drop the `scanned >= maxRows` stop → "never reads more than the cap"
 *     goes red;
 *   - drop the domain test from `readableSources` → "drops a source the grant
 *     does not cover" goes red.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: {} }));

import type { SearchCandidate } from "../match";
import {
  readableSources,
  scanNewest,
  searchRecords,
  type ScanBudget,
} from "../search-records";

const { loadRecordCandidates } = vi.hoisted(() => ({
  loadRecordCandidates: vi.fn(async () => []),
}));
vi.mock("@/lib/mcp/record-search", () => ({ loadRecordCandidates }));

function budget(deadlineIn = 10_000, clock = { t: 0 }): ScanBudget {
  return {
    deadline: clock.t + deadlineIn,
    now: () => clock.t,
    truncated: false,
    rows: 0,
  };
}

/** A source of `total` rows, newest first, every `hitEvery`-th one a hit. */
function source(total: number, hitEvery = 1) {
  const rows = Array.from({ length: total }, (_, i) => ({ id: `r${i}`, i }));
  const reads: number[] = [];
  return {
    reads,
    read: async (cursor: string | null, take: number) => {
      const start = cursor ? rows.findIndex((r) => r.id === cursor) + 1 : 0;
      reads.push(take);
      return rows.slice(start, start + take);
    },
    match: (row: { id: string; i: number }) =>
      row.i % hitEvery === 0
        ? ({ id: row.id } as unknown as SearchCandidate)
        : null,
  };
}

describe("scanNewest", () => {
  it("reads a small source to its end and is not truncated", async () => {
    const b = budget();
    const s = source(30, 10);
    const out = await scanNewest({ budget: b, wanted: 5, batch: 10, ...s });
    expect(out.map((c) => c.id)).toEqual(["r0", "r10", "r20"]);
    expect(b.truncated).toBe(false);
    expect(b.rows).toBe(30);
  });

  it("stops once it holds more hits than wanted", async () => {
    const b = budget();
    const s = source(10_000, 1);
    const out = await scanNewest({ budget: b, wanted: 3, batch: 10, ...s });
    expect(out.length).toBe(10);
    expect(s.reads).toEqual([10]);
    expect(b.truncated).toBe(false);
  });

  it("never reads more than the cap, and says so", async () => {
    const b = budget();
    const s = source(10_000, 1_000_000);
    await scanNewest({ budget: b, wanted: 3, batch: 100, maxRows: 450, ...s });
    expect(b.rows).toBe(450);
    // The last batch probes one row past the cap and does not keep it.
    expect(s.reads).toEqual([100, 100, 100, 100, 51]);
    expect(b.truncated).toBe(true);
  });

  it("does not call a source holding exactly the cap truncated", async () => {
    const b = budget();
    const s = source(450, 1_000_000);
    await scanNewest({ budget: b, wanted: 3, batch: 100, maxRows: 450, ...s });
    expect(b.rows).toBe(450);
    expect(b.truncated).toBe(false);
  });

  it("calls a source one row past the cap truncated", async () => {
    const b = budget();
    const s = source(451, 1_000_000);
    await scanNewest({ budget: b, wanted: 3, batch: 100, maxRows: 450, ...s });
    expect(b.rows).toBe(450);
    expect(b.truncated).toBe(true);
  });

  it("stops when the budget has run out, and says so", async () => {
    const clock = { t: 0 };
    const b = budget(100, clock);
    const s = source(10_000, 1_000_000);
    const read = async (cursor: string | null, take: number) => {
      clock.t += 60;
      return s.read(cursor, take);
    };
    await scanNewest({ budget: b, wanted: 3, batch: 10, read, match: s.match });
    expect(s.reads.length).toBe(2);
    expect(b.truncated).toBe(true);
  });
});

describe("an abandoned search", () => {
  it("stops a scan at its next batch once the signal aborts", async () => {
    const controller = new AbortController();
    const b = { ...budget(), signal: controller.signal };
    const s = source(10_000, 1_000_000);
    const read = async (cursor: string | null, take: number) => {
      controller.abort();
      return s.read(cursor, take);
    };
    await scanNewest({ budget: b, wanted: 3, batch: 10, read, match: s.match });
    expect(s.reads).toEqual([10]);
    expect(b.truncated).toBe(true);
  });

  it("starts no source when the request is already gone", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await searchRecords({
      recordId: "u1",
      query: "schulter",
      limit: 5,
      modules: null,
      domainVisible: () => true,
      displayLocale: "en",
      timezone: "UTC",
      signal: controller.signal,
    });
    // `prisma` is an empty object here: any source that ran would throw.
    expect(loadRecordCandidates).not.toHaveBeenCalled();
    expect(result.groups).toEqual([]);
    expect(result.truncated).toBe(true);
  });

  it("hands the clinical kinds the shared budget", async () => {
    const clock = { t: 0 };
    loadRecordCandidates.mockImplementationOnce(async (...args: unknown[]) => {
      const options = args[3] as { shouldStop: () => boolean };
      expect(options.shouldStop()).toBe(false);
      clock.t = 2_000;
      expect(options.shouldStop()).toBe(true);
      return [];
    });
    await searchRecords({
      recordId: "u1",
      query: "schulter",
      limit: 5,
      modules: null,
      // Only the clinical kinds: every other source would reach `prisma`.
      domainVisible: (domain) => domain === "profile",
      displayLocale: "en",
      timezone: "UTC",
      now: () => clock.t,
      budgetMs: 1_500,
    });
    expect(loadRecordCandidates).toHaveBeenCalledTimes(1);
  });
});

describe("readableSources", () => {
  const all = () => true;

  it("reads everything on an owner's record with every module on", () => {
    expect(readableSources({}, all)).toHaveLength(13);
  });

  it("drops the sources of a switched-off module, never a core one", () => {
    const sources = readableSources(
      { illness: false, mood: false, inboundDocuments: false },
      all,
    );
    expect(sources).not.toContain("condition");
    expect(sources).not.toContain("symptom");
    expect(sources).not.toContain("symptomNote");
    expect(sources).not.toContain("illnessNote");
    expect(sources).not.toContain("moodNote");
    expect(sources).not.toContain("document");
    expect(sources).toContain("visit");
    expect(sources).toContain("measurementNote");
  });

  it("drops a source the grant does not cover", () => {
    const sources = readableSources({}, (domain) => domain !== "mind");
    expect(sources).not.toContain("moodNote");
    expect(sources).toContain("visit");
  });
});
