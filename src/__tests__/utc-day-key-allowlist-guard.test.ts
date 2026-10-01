/**
 * The allowlist of `healthlog/no-utc-day-key`.
 *
 * The lint rule refuses the UTC-day idioms in application source; a site
 * where the UTC day is right keeps it with an
 * `eslint-disable-next-line healthlog/no-utc-day-key -- <reason>` directive.
 * This guard reads every such directive and holds three lines the rule alone
 * cannot:
 *
 *   - every directive is the next-line form (a same-line or block disable on
 *     the first line of a file hides the rule's own refusal);
 *   - every reason says which kind of exception it is: `UTC by design:` (the
 *     UTC day is the correct answer) or `baseline:` (a known site that should
 *     move to the user's day and has not yet);
 *   - the `baseline:` set can only shrink. A new UTC-day site is fixed or
 *     argued as UTC by design, never parked.
 *
 * Mutation, done once by hand: a bare directive on a new line in
 * `src/lib/insights/score-row.ts` fails the reason check; an eleventh
 * `baseline:` directive fails the ceiling.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { walkSourceFiles } from "./helpers/source-files";

const SRC = join(__dirname, "..");
const RULE = "healthlog/no-utc-day-key";
/** Known sites still on the UTC day that should not be. Lower it, never raise it. */
const BASELINE_CEILING = 10;

interface Directive {
  file: string;
  line: number;
  text: string;
}

function directives(): Directive[] {
  const out: Directive[] = [];
  for (const file of walkSourceFiles(SRC, { floor: 2000 })) {
    // The rule does not run on tests, so no directive there means anything
    // (this file names the directive in its own documentation).
    if (/(^|\/)__tests__\/|\.test\.tsx?$/.test(file)) continue;
    const lines = readFileSync(join(SRC, file), "utf8").split("\n");
    lines.forEach((text, i) => {
      if (/eslint-disable/.test(text) && text.includes(RULE)) {
        out.push({ file, line: i + 1, text: text.trim() });
      }
    });
  }
  return out;
}

describe("no-utc-day-key allowlist", () => {
  const found = directives();

  it("finds the allowlist it guards", () => {
    // A walk that finds nothing would agree with every assertion below.
    expect(found.length).toBeGreaterThanOrEqual(40);
  });

  it("uses only next-line directives", () => {
    const offenders = found.filter(
      (d) => !d.text.includes(`eslint-disable-next-line ${RULE}`),
    );
    expect(offenders).toEqual([]);
  });

  it("gives every directive a classified reason", () => {
    const offenders = found.filter(
      (d) => !/ -- (UTC by design|baseline): \S.{8,}/.test(d.text),
    );
    expect(offenders).toEqual([]);
  });

  it("never grows the baseline", () => {
    const baseline = found.filter((d) => d.text.includes(" -- baseline: "));
    expect(baseline.length).toBeLessThanOrEqual(BASELINE_CEILING);
  });
});
