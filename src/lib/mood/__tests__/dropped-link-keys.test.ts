import { describe, expect, it } from "vitest";

import { droppedAnyLinkKeys } from "@/lib/mood/dropped-link-keys";

describe("droppedAnyLinkKeys — the web's read of a mood write response", () => {
  it("is false for a response that lists nothing (the fields are absent)", () => {
    expect(droppedAnyLinkKeys({})).toBe(false);
    expect(droppedAnyLinkKeys(null)).toBe(false);
    expect(droppedAnyLinkKeys({ droppedTagKeys: [] })).toBe(false);
  });

  it("is true when either list names a key", () => {
    expect(droppedAnyLinkKeys({ droppedTagKeys: ["custom:gone"] })).toBe(true);
    expect(droppedAnyLinkKeys({ droppedFactorKeys: ["factor_x"] })).toBe(true);
  });
});
