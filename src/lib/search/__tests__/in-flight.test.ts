import { describe, expect, it } from "vitest";

import { SUPERSEDED, beginSearch, searchesInFlight } from "../in-flight";

describe("beginSearch", () => {
  it("a newer search of the same record stops the one before it", () => {
    const first = beginSearch("actor", "record-a");
    const second = beginSearch("actor", "record-a");
    expect(first.signal.aborted).toBe(true);
    expect(first.signal.reason).toBe(SUPERSEDED);
    expect(second.signal.aborted).toBe(false);
    first.end();
    second.end();
    expect(searchesInFlight()).toBe(0);
  });

  it("searches of two different records by one actor run side by side", () => {
    const own = beginSearch("actor", "record-a");
    const shared = beginSearch("actor", "record-b");
    expect(own.signal.aborted).toBe(false);
    expect(shared.signal.aborted).toBe(false);
    own.end();
    shared.end();
    expect(searchesInFlight()).toBe(0);
  });
});
