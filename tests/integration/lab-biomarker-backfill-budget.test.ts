/**
 * The lab-biomarker backfill stops on its job budget between analyte groups,
 * against a real Postgres.
 *
 * A stop must leave every group it finished linked and every other reading
 * untouched, and the retry must pick up exactly the rest: a linked reading
 * drops out of the backfill's scan, so nothing is linked twice and nothing is
 * skipped.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { getPrismaClient, truncateAllTables } from "./setup";
import { runLabBiomarkerBackfillForUser } from "@/lib/jobs/lab-biomarker-backfill";

const USER_ID = "user-lab-backfill-budget";

beforeEach(async () => {
  const prisma = getPrismaClient();
  await truncateAllTables(prisma);
  await prisma.user.create({
    data: {
      id: USER_ID,
      username: "lab-budget",
      email: "lab-budget@example.test",
    },
  });
  const takenAt = new Date("2026-06-01T08:00:00.000Z");
  await prisma.labResult.createMany({
    data: ["LDL", "LDL", "HbA1c", "TSH"].map((analyte, i) => ({
      userId: USER_ID,
      analyte,
      unit: "mg/dL",
      value: 100 + i,
      takenAt: new Date(takenAt.getTime() + i * 86_400_000),
    })),
  });
});

async function unlinked() {
  return getPrismaClient().labResult.count({
    where: { userId: USER_ID, biomarkerId: null },
  });
}

describe("lab-biomarker backfill under a job budget", () => {
  it("stops after the group in hand and the retry links the rest", async () => {
    let asked = 0;
    // Allow exactly one group, then say stop.
    const shouldStop = () => asked++ >= 1;

    await expect(
      runLabBiomarkerBackfillForUser(USER_ID, shouldStop),
    ).rejects.toThrow(/stopped on its job budget/);

    const prisma = getPrismaClient();
    expect(await prisma.biomarker.count({ where: { userId: USER_ID } })).toBe(
      1,
    );
    const linkedAfterStop = 4 - (await unlinked());
    // One group: either the two LDL rows or one single-row analyte.
    expect([1, 2]).toContain(linkedAfterStop);

    const retry = await runLabBiomarkerBackfillForUser(USER_ID);
    expect(retry.linked).toBe(4 - linkedAfterStop);
    expect(await unlinked()).toBe(0);
    expect(await prisma.biomarker.count({ where: { userId: USER_ID } })).toBe(
      3,
    );
  });

  it("runs to the end when the budget never stops it", async () => {
    const result = await runLabBiomarkerBackfillForUser(USER_ID, () => false);
    expect(result).toEqual({ markers: 3, linked: 4 });
    expect(await unlinked()).toBe(0);
  });
});
