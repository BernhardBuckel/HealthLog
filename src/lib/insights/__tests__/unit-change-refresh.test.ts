import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    insightNarrative: { findMany: vi.fn() },
  },
}));
vi.mock("@/lib/insights/status-invalidation", () => ({
  enqueueStatusRefillForUser: vi.fn(),
}));
vi.mock("@/lib/jobs/period-narrative-shared", () => ({
  enqueueNarrativeWarm: vi.fn(),
}));
vi.mock("@/lib/jobs/insight-pregenerate-shared", () => ({
  enqueueForceWarm: vi.fn(),
}));

import { prisma } from "@/lib/db";
import { enqueueStatusRefillForUser } from "@/lib/insights/status-invalidation";
import { enqueueNarrativeWarm } from "@/lib/jobs/period-narrative-shared";
import { enqueueForceWarm } from "@/lib/jobs/insight-pregenerate-shared";
import { refreshTextsAfterUnitChange } from "../unit-change-refresh";

beforeEach(() => {
  vi.resetAllMocks();
});

describe("refreshTextsAfterUnitChange", () => {
  it("refills the status cards in the reader's locale and re-warms each stored narrative", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      locale: "de",
    } as never);
    vi.mocked(enqueueStatusRefillForUser).mockResolvedValue(12);
    vi.mocked(prisma.insightNarrative.findMany).mockResolvedValue([
      { period: "week", locale: "de" },
      { period: "month", locale: "en" },
      { period: "year", locale: "de" },
      { period: "week", locale: "xx" },
    ] as never);

    await refreshTextsAfterUnitChange("user-1");

    expect(enqueueStatusRefillForUser).toHaveBeenCalledWith("user-1", "de");
    expect(enqueueNarrativeWarm).toHaveBeenCalledTimes(2);
    expect(enqueueNarrativeWarm).toHaveBeenCalledWith({
      userId: "user-1",
      period: "week",
      locale: "de",
    });
    expect(enqueueNarrativeWarm).toHaveBeenCalledWith({
      userId: "user-1",
      period: "month",
      locale: "en",
    });
  });

  it("re-warms a cached briefing in the language it was written in", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      locale: "de",
      insightsCachedAt: new Date(),
      insightsCachedLocale: "en",
    } as never);
    vi.mocked(prisma.insightNarrative.findMany).mockResolvedValue([]);

    await refreshTextsAfterUnitChange("user-1");

    expect(enqueueForceWarm).toHaveBeenCalledWith({
      userId: "user-1",
      locale: "en",
    });
  });

  it("leaves the briefing alone when none was ever written", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      locale: "de",
      insightsCachedAt: null,
    } as never);
    vi.mocked(prisma.insightNarrative.findMany).mockResolvedValue([]);

    await refreshTextsAfterUnitChange("user-1");

    expect(enqueueForceWarm).not.toHaveBeenCalled();
  });

  it("never throws into the preference write", async () => {
    vi.mocked(prisma.user.findUnique).mockRejectedValue(new Error("db down"));
    await expect(refreshTextsAfterUnitChange("user-1")).resolves.toBe(
      undefined,
    );
  });
});
