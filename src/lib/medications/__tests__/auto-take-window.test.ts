/**
 * v1.42.2 — which window edits reopen past days for the auto-take pass.
 */
import { describe, expect, it, vi } from "vitest";

import {
  moveAutoTakeFloorToNow,
  windowWidens,
} from "@/lib/medications/auto-take";

const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

describe("windowWidens", () => {
  it("an earlier or removed start, a later or removed end, reopens time", () => {
    const before = { startsOn: d("2026-06-10"), endsOn: d("2026-06-20") };
    expect(windowWidens(before, { ...before, startsOn: d("2026-06-01") })).toBe(
      true,
    );
    expect(windowWidens(before, { ...before, startsOn: null })).toBe(true);
    expect(windowWidens(before, { ...before, endsOn: d("2026-06-30") })).toBe(
      true,
    );
    expect(windowWidens(before, { ...before, endsOn: null })).toBe(true);
  });

  it("a later start, an earlier end, or no change reopens nothing", () => {
    const before = { startsOn: d("2026-06-10"), endsOn: d("2026-06-20") };
    expect(windowWidens(before, before)).toBe(false);
    expect(windowWidens(before, { ...before, startsOn: d("2026-06-12") })).toBe(
      false,
    );
    expect(windowWidens(before, { ...before, endsOn: d("2026-06-15") })).toBe(
      false,
    );
    expect(
      windowWidens(
        { startsOn: null, endsOn: null },
        { startsOn: d("2026-06-01"), endsOn: d("2026-06-30") },
      ),
    ).toBe(false);
  });
});

describe("moveAutoTakeFloorToNow", () => {
  it("moves only an auto-taken medication's earlier floor", async () => {
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const now = new Date("2026-06-10T10:00:00.000Z");
    await moveAutoTakeFloorToNow({ medication: { updateMany } }, "m1", now);
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: "m1",
        autoMarkTaken: true,
        autoMarkTakenSince: { lt: now },
      },
      data: { autoMarkTakenSince: now },
    });
  });
});
