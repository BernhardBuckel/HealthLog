/**
 * v1.18.1 — `resolveOrMintBiomarker`: the auto-link-on-write helper.
 *
 * Every free-text lab write resolves (or mints) a user-scoped Biomarker by
 * `(userId, lower(analyte))` so NO `LabResult` row ever persists unlinked.
 * Asserts: case-insensitive reuse, mint-on-miss from the reading's own
 * spelling, no silent rewrite of an existing marker, and the concurrent
 * unique-violation race adopting the winner.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  biomarker: { findFirst: vi.fn(), create: vi.fn() },
}));

vi.mock("@/lib/db", () => ({ prisma: db }));

import { resolveOrMintBiomarker } from "@/lib/labs/biomarker-store";

const baseInput = {
  analyte: "LDL",
  unit: "mg/dL",
  referenceLow: null,
  referenceHigh: 116 as number | null,
  panel: "lipids" as string | null,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("resolveOrMintBiomarker", () => {
  it("reuses an existing marker (case-insensitive) without minting", async () => {
    db.biomarker.findFirst.mockResolvedValue({
      id: "bm_existing",
      name: "LDL Cholesterol",
      unit: "mg/dL",
      lowerBound: null,
      upperBound: 100,
      panel: "lipids",
      analyteKey: null,
    });

    const out = await resolveOrMintBiomarker("u1", {
      ...baseInput,
      analyte: "ldl", // lowercase free-text spelling
    });

    expect(out.id).toBe("bm_existing");
    // Existing marker keeps its own unit/range — the incoming free-text
    // values do NOT rewrite it.
    expect(out.upperBound).toBe(100);
    expect(db.biomarker.create).not.toHaveBeenCalled();
    // Match is case-insensitive on the catalog identity.
    const where = db.biomarker.findFirst.mock.calls[0][0].where;
    expect(where.name).toEqual({ equals: "ldl", mode: "insensitive" });
    expect(where.userId).toBe("u1");
  });

  it("mints a new marker from the reading when none exists", async () => {
    db.biomarker.findFirst.mockResolvedValue(null);
    db.biomarker.create.mockResolvedValue({
      id: "bm_new",
      name: "LDL",
      unit: "mg/dL",
      lowerBound: null,
      upperBound: 116,
      panel: "lipids",
      analyteKey: null,
    });

    const out = await resolveOrMintBiomarker("u1", baseInput);

    expect(out.id).toBe("bm_new");
    const data = db.biomarker.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      userId: "u1",
      name: "LDL",
      unit: "mg/dL",
      lowerBound: null,
      upperBound: 116,
      panel: "lipids",
    });
  });

  it("trims the analyte before minting", async () => {
    db.biomarker.findFirst.mockResolvedValue(null);
    db.biomarker.create.mockResolvedValue({
      id: "bm_x",
      name: "Ferritin",
      unit: "ng/mL",
      lowerBound: 30,
      upperBound: 400,
      panel: null,
      analyteKey: null,
    });

    await resolveOrMintBiomarker("u1", {
      analyte: "  Ferritin  ",
      unit: "ng/mL",
      referenceLow: 30,
      referenceHigh: 400,
      panel: null,
    });

    expect(db.biomarker.create.mock.calls[0][0].data.name).toBe("Ferritin");
  });

  it("adopts the race winner on a concurrent unique violation", async () => {
    // First lookup misses; create throws (the other writer won the unique
    // index); the re-lookup finds the winner.
    db.biomarker.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({
      id: "bm_winner",
      name: "TSH",
      unit: "mIU/L",
      lowerBound: 0.4,
      upperBound: 4,
      panel: "thyroid",
    });
    db.biomarker.create.mockRejectedValue(new Error("unique constraint"));

    const out = await resolveOrMintBiomarker("u1", {
      analyte: "TSH",
      unit: "mIU/L",
      referenceLow: 0.4,
      referenceHigh: 4,
      panel: "thyroid",
    });

    expect(out.id).toBe("bm_winner");
    expect(db.biomarker.findFirst).toHaveBeenCalledTimes(2);
  });

  it("throws when the create fails and no race winner exists", async () => {
    db.biomarker.findFirst.mockResolvedValue(null);
    db.biomarker.create.mockRejectedValue(new Error("db down"));

    await expect(resolveOrMintBiomarker("u1", baseInput)).rejects.toThrow(
      /Failed to resolve biomarker/,
    );
  });
});
