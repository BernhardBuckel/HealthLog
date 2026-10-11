/**
 * Raw SQL never reads the clock through the session time zone.
 *
 * Stored times are UTC in `timestamp` columns without a zone. Postgres
 * compares such a column with `NOW()` / `CURRENT_TIMESTAMP` /
 * `clock_timestamp()` by converting through the session time zone, and
 * assigns one of them to such a column the same way, so on a database whose
 * default is not UTC a fresh passkey challenge read as already expired. Every
 * connection is pinned to UTC (`@/lib/db-session`), and on top of that every
 * raw-SQL clock read writes `NOW() AT TIME ZONE 'UTC'`, which yields the naive
 * UTC timestamp whatever the session says.
 *
 * The few bare reads left are listed below with the reason they are safe:
 * each feeds a `timestamptz` column or returns the instant to JavaScript.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");
const SRC = join(ROOT, "src");

/** `file: reason` for every bare clock read that is deliberately left. */
const ALLOWED: Record<string, string> = {
  "src/lib/rollups/mood-rollups.ts": "computed_at is timestamptz",
  "src/lib/rollups/medication-compliance-rollups.ts":
    "computed_at is timestamptz",
  "src/lib/jobs/job-failures.ts": "pg-boss tables are timestamptz",
  "src/lib/jobs/reminder/registrar-shared.ts": "pg-boss tables are timestamptz",
  "src/lib/db-compat.ts": "DDL default on a timestamptz column",
};

const SQL_CLOCK =
  /(?<![.\w])(?:NOW\(\)|CURRENT_TIMESTAMP\b|clock_timestamp\(\))|(?:(?<!=)[<>]|=)\s*now\(\)\s*(?:$|[,)]|[-+]\s*(?:make_interval|INTERVAL))|\bnow\(\)\s*[-+]\s*(?:make_interval|INTERVAL)/;
const ANCHORED =
  /(?:NOW\(\)|CURRENT_TIMESTAMP|clock_timestamp\(\)) AT TIME ZONE 'UTC'/g;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (name === "generated" || name === "__tests__") continue;
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name))
      out.push(full);
  }
  return out;
}

function offenders(): string[] {
  const found: string[] = [];
  for (const file of walk(SRC)) {
    const rel = relative(ROOT, file);
    if (ALLOWED[rel]) continue;
    readFileSync(file, "utf8")
      .split("\n")
      .forEach((line, index) => {
        if (/^\s*(\/\/|\*|\/\*|--)/.test(line)) return;
        if (SQL_CLOCK.test(line.replace(ANCHORED, ""))) {
          found.push(`${rel}:${index + 1}: ${line.trim()}`);
        }
      });
  }
  return found;
}

describe("raw SQL clock reads are anchored to UTC", () => {
  it("finds the anchored form across the swept files", () => {
    // The matcher must see something, or a broken walk would pass.
    const passkey = readFileSync(join(SRC, "lib/auth/passkey.ts"), "utf8");
    expect(passkey.match(ANCHORED)?.length).toBeGreaterThanOrEqual(3);
    expect(SQL_CLOCK.test("AND expires_at > NOW()")).toBe(true);
    expect(SQL_CLOCK.test("updated_at = now()")).toBe(true);
    expect(SQL_CLOCK.test("const started = now();")).toBe(false);
    expect(SQL_CLOCK.test("elapsedMs: () => now() - started,")).toBe(false);
    expect(SQL_CLOCK.test("const ends = now() + perCallMs;")).toBe(false);
    expect(
      SQL_CLOCK.test("deleted_at >= now() - make_interval(days => 1)"),
    ).toBe(true);
    expect(SQL_CLOCK.test("Date.now()")).toBe(false);
  });

  it("leaves no bare NOW() / CURRENT_TIMESTAMP outside the allowlist", () => {
    expect(offenders()).toEqual([]);
  });

  it("keeps the allowlist honest: every entry still has a bare read", () => {
    for (const rel of Object.keys(ALLOWED)) {
      const lines = readFileSync(join(ROOT, rel), "utf8")
        .replace(ANCHORED, "")
        .split("\n");
      expect(
        lines.some((line) => SQL_CLOCK.test(line)),
        rel,
      ).toBe(true);
    }
  });
});
