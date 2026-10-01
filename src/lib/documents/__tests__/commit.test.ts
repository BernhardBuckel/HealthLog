/**
 * v1.25.1 — commit-path unit-integrity tests.
 *
 * Committing a numeric observation against an EXISTING biomarker must not
 * silently rewrite the document's stated unit with the catalog's. When the
 * units disagree the fact is rejected (fail closed) so the user reconciles on
 * the review screen, exactly like the `unitRequired` guard — never a corrupt
 * "6.1 mmol/L written as 6.1 mg/dL" reading.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    labResult: { create: vi.fn() },
  },
}));

vi.mock("@/lib/labs/biomarker-store", () => ({
  resolveOrMintBiomarker: vi.fn(),
}));

vi.mock("@/lib/documents/store", () => ({
  decryptFactData: vi.fn(),
}));

import { commitApprovedFact, FactCommitError } from "@/lib/documents/commit";
import { prisma } from "@/lib/db";
import { resolveOrMintBiomarker } from "@/lib/labs/biomarker-store";
import { decryptFactData } from "@/lib/documents/store";
import type { ExtractedFact } from "@/generated/prisma/client";
import { userDayKey } from "@/lib/tz/format";

function observationFact(): ExtractedFact {
  return {
    id: "fact-1",
    factType: "OBSERVATION",
    dataEncrypted: new Uint8Array(),
  } as unknown as ExtractedFact;
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("commitApprovedFact — OBSERVATION unit integrity", () => {
  it("rejects a numeric observation whose stated unit differs from an existing marker's unit", async () => {
    vi.mocked(decryptFactData).mockReturnValue({
      label: "Glucose",
      value: 6.1,
      unit: "mmol/L",
      referenceLow: null,
      referenceHigh: null,
      effectiveDate: "2025-01-01",
    } as never);
    // Existing marker stored in mg/dL — the resolver returns it as-is.
    vi.mocked(resolveOrMintBiomarker).mockResolvedValue({
      id: "bm-1",
      name: "Glucose",
      unit: "mg/dL",
      lowerBound: 70,
      upperBound: 100,
      panel: null,
    });

    await expect(
      commitApprovedFact("user-1", observationFact()),
    ).rejects.toMatchObject({ code: "observation.unitMismatch" });
    await expect(
      commitApprovedFact("user-1", observationFact()),
    ).rejects.toBeInstanceOf(FactCommitError);
    expect(prisma.labResult.create).not.toHaveBeenCalled();
  });

  it("commits when the stated unit matches the marker's unit (case/space-insensitive)", async () => {
    vi.mocked(decryptFactData).mockReturnValue({
      label: "Glucose",
      value: 95,
      unit: " mg/DL ",
      referenceLow: null,
      referenceHigh: null,
      effectiveDate: "2025-01-01",
    } as never);
    vi.mocked(resolveOrMintBiomarker).mockResolvedValue({
      id: "bm-1",
      name: "Glucose",
      unit: "mg/dL",
      lowerBound: 70,
      upperBound: 100,
      panel: null,
    });
    vi.mocked(prisma.labResult.create).mockResolvedValue({
      id: "lr-1",
    } as never);

    const ref = await commitApprovedFact("user-1", observationFact());
    expect(ref).toEqual({ recordType: "labResult", recordId: "lr-1" });
    expect(prisma.labResult.create).toHaveBeenCalledOnce();
    // The stated date is stored at noon UTC: it reads back on the stated day
    // as a UTC label and formatted in a zone west of UTC alike. UTC midnight
    // showed the reading a day early there.
    const takenAt = vi.mocked(prisma.labResult.create).mock.calls[0]![0].data
      .takenAt as Date;
    expect(takenAt.toISOString()).toBe("2025-01-01T12:00:00.000Z");
    expect(userDayKey(takenAt, "America/Los_Angeles")).toBe("2025-01-01");
  });
});
