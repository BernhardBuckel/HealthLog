import { afterEach, describe, expect, it, vi } from "vitest";

import {
  checkSessionTimeZone,
  isUtcTimeZone,
  runBootTimeZoneCheck,
} from "../time-zone-check";

function clientAnswering(rows: unknown) {
  return { $queryRawUnsafe: vi.fn().mockResolvedValue(rows) };
}

describe("boot time zone check", () => {
  afterEach(() => vi.restoreAllMocks());

  it("accepts the spellings Postgres reports for UTC", () => {
    for (const name of ["UTC", "Etc/UTC", "utc", "UCT", "Zulu"]) {
      expect(isUtcTimeZone(name)).toBe(true);
    }
    for (const name of ["Europe/Berlin", "GMT+1", "America/New_York"]) {
      expect(isUtcTimeZone(name)).toBe(false);
    }
  });

  it("stays quiet on a UTC session", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = clientAnswering([{ TimeZone: "UTC" }]);
    expect(await runBootTimeZoneCheck(client)).toEqual({
      state: "utc",
      timeZone: "UTC",
    });
    expect(client.$queryRawUnsafe).toHaveBeenCalledWith("SHOW TimeZone");
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns, naming the zone and the fix, on any other zone", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const outcome = await runBootTimeZoneCheck(
      clientAnswering([{ TimeZone: "Europe/Berlin" }]),
    );
    expect(outcome).toEqual({ state: "mismatch", timeZone: "Europe/Berlin" });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('"Europe/Berlin"');
    expect(warn.mock.calls[0][0]).toContain("SET timezone TO 'UTC'");
  });

  it("never throws when the database cannot answer", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = {
      $queryRawUnsafe: vi.fn().mockRejectedValue(new Error("down")),
    };
    expect(await checkSessionTimeZone(client)).toEqual({
      state: "error",
      message: "down",
    });
    await runBootTimeZoneCheck(client);
    expect(warn.mock.calls[0][0]).toContain("skipped: down");
  });
});
