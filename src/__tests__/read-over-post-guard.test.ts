/**
 * `readOverPost` lets a delegable route answer a POST at the grant's read
 * level. That widens what a read-only grant reaches, so the set of routes
 * declaring it is frozen here: adding one is a reviewed diff, not an
 * accident. Today it is the record search alone, whose query is health data
 * that must stay out of URLs.
 *
 * The matcher tolerates whitespace and line breaks, and the guard asserts it
 * matched something, so a rewrite that hides the declaration from the regex
 * fails instead of passing on an empty set.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { globSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = process.cwd();

const FROZEN = ["src/app/api/search/route.ts"];

describe("readOverPost declarations", () => {
  it("are exactly the frozen set", () => {
    const declaring = globSync("src/**/*.ts", { cwd: ROOT })
      .filter((file) => !file.includes(`${sep}__tests__${sep}`))
      .filter((file) => file !== join("src", "lib", "api-handler.ts"))
      .filter((file) =>
        /readOverPost\s*:\s*true/.test(readFileSync(join(ROOT, file), "utf8")),
      )
      .map((file) => relative(ROOT, join(ROOT, file)).split(sep).join("/"))
      .sort();
    expect(declaring.length).toBeGreaterThan(0);
    expect(declaring).toEqual(FROZEN);
  });
});
