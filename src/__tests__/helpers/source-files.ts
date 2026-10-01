/**
 * The one file walker the structural guards share.
 *
 * ## Why this exists rather than `fs.globSync`
 *
 * A guard that freezes a discovered set against an allowlist is only as
 * honest as its idea of "every source file". `fs.globSync` has a rule that
 * silently narrows that idea: a glob's `*` never matches a leading dot, so
 * `**\/*.{ts,tsx}` skips every dot-prefixed directory without saying so.
 *
 * `src/app/.well-known/` holds three live route modules — the two OAuth
 * discovery documents the MCP server publishes and the
 * apple-app-site-association handler. Every guard built on `globSync` walked
 * straight past all three and reported a clean sweep over a tree with a hole
 * in it. Demonstrated, not assumed: an unlisted `getSession()` call planted
 * in `app/.well-known/oauth-authorization-server/route.ts` left
 * `session-surface-guard` at 9 passed, and fails it once the walk goes
 * through here.
 *
 * `readdirSync(root, { recursive: true })` has no dot rule. It is the reason
 * `delegable-surface-guard.test.ts` already walks by hand; this helper makes
 * that the shared behaviour instead of one guard's private correction.
 *
 * ## Why `floor` is required and not optional
 *
 * The other way a sweep goes quiet is by finding nothing at all: an empty
 * match set agrees with an empty allowlist, and the guard passes on a tree it
 * never read. A wrong root, a renamed directory, or a walk that throws away
 * every entry all look exactly like compliance. So every caller states the
 * size it expects to walk, pinned below the real count with headroom, and a
 * walk that comes back smaller throws instead of reporting a clean sweep.
 * The floor covers the walk; a guard that filters further is still on the
 * hook for a floor over its own narrowed set.
 *
 * ## What it returns
 *
 * Posix-separated paths relative to `root`, sorted, so a guard's output and
 * its failure message read the same on every platform. Directory entries are
 * dropped by the extension filter.
 *
 * ## What it does not do
 *
 * It applies no exclusions of its own — not `generated/`, not `__tests__`,
 * not `.test.ts`. Each guard states its own, because what counts as out of
 * scope is the guard's claim to make, not the walker's.
 *
 * And it must not be rooted at the repository root. Descending into
 * dot-prefixed directories is the whole point, but at the root that means
 * `.git` and — on a maintainer's machine mid-release — the `.wt-*` sibling
 * worktrees, each a full second copy of the tree that would double every
 * match. Every caller roots at `src/`, `e2e/` or a subtree of one.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";

export function walkSourceFiles(
  root: string,
  options: { floor: number; extensions?: readonly string[] },
): string[] {
  const extensions = options.extensions ?? [".ts", ".tsx"];
  const files = readdirSync(root, { recursive: true })
    .map((entry) => String(entry).split(sep).join("/"))
    .filter((rel) => extensions.some((ext) => rel.endsWith(ext)))
    .sort();

  if (files.length < options.floor) {
    throw new Error(
      `walkSourceFiles(${root}) found ${files.length} file(s) matching ` +
        `${extensions.join(", ")}, below the stated floor of ${options.floor}. ` +
        `A sweep this small is a broken walk, not a clean tree — check the ` +
        `root before lowering the floor.`,
    );
  }
  return files;
}

/**
 * A source file with its comments removed, line comments FIRST.
 *
 * The order is the whole reason this is shared rather than re-spelled per
 * guard. Every private copy in this directory strips block comments first,
 * with one non-greedy `/\*[\s\S]*?\*\//` pass, and that pass cannot tell a
 * real block opener from a `/*` that happens to sit inside a line comment.
 * This tree has one: `src/app/mood/page-client.tsx` explains its gate with
 * "Every `/api/mood-entries/*` route also enforces the gate", and the `/*` in
 * that path opened a fake block that swallowed the next 2.2 kB of real code —
 * the module gate three lines below it included. A guard reading that source
 * was searching a file with a hole in it and reporting a clean sweep.
 *
 * So each line is walked once, left to right: whichever opener comes first
 * wins, a line comment ends the line, and a block comment carries its state to
 * the next one. Line-comment detection needs `//` at the start of a line or
 * after whitespace, so a URL inside a string survives.
 *
 * Its honest limit: it is a scanner, not a parser. A `/*` inside a string
 * literal still opens a block, and a guard that needs more than this needs a
 * real parse.
 */
export function stripComments(source: string): string {
  const lines: string[] = [];
  let inBlock = false;

  for (const line of source.split("\n")) {
    let rest = line;
    let kept = "";

    while (rest.length > 0) {
      if (inBlock) {
        const closes = rest.indexOf("*/");
        if (closes === -1) break;
        rest = rest.slice(closes + 2);
        inBlock = false;
        continue;
      }

      const lineComment = rest.search(/(^|\s)\/\//);
      const blockComment = rest.indexOf("/*");

      if (
        blockComment !== -1 &&
        (lineComment === -1 || blockComment < lineComment)
      ) {
        kept += rest.slice(0, blockComment);
        rest = rest.slice(blockComment + 2);
        inBlock = true;
        continue;
      }

      if (lineComment !== -1) {
        kept += rest.slice(0, rest.indexOf("//", lineComment));
        break;
      }

      kept += rest;
      break;
    }

    lines.push(kept);
  }

  return lines.join("\n");
}

/**
 * Asserts that a sweep found at least `floor` things, and returns them.
 *
 * `walkSourceFiles` puts a floor under the walk. This puts one under what a
 * guard does with it: the narrowed file set, the call sites a matcher picked
 * out, the routes an inventory extracted. A matcher that drifts out of step
 * with the code — a renamed helper, a call split across two lines, a regex
 * that stopped compiling the way it was meant to — returns an empty list, and
 * an empty list agrees with every allowlist and every "none of these may
 * exist" rule. That is how the Bearer-scope guard stayed green for weeks while
 * matching nothing.
 *
 * Pin `floor` at the real count when the set is a closed inventory, and below
 * it with headroom only when the count legitimately moves. A floor of zero is
 * refused: it is the bug this exists to prevent, spelled as a parameter.
 */
export function requireFloor<T>(
  label: string,
  found: readonly T[],
  floor: number,
): readonly T[] {
  if (!Number.isInteger(floor) || floor < 1) {
    throw new Error(
      `requireFloor(${label}): floor must be a positive integer, got ${floor}.`,
    );
  }
  if (found.length < floor) {
    throw new Error(
      `${label}: found ${found.length}, below the stated floor of ${floor}. ` +
        `A matcher that finds this little has drifted from the code it ` +
        `reads; fix the matcher before lowering the floor.`,
    );
  }
  return found;
}

export interface SourceMatch {
  /** Path relative to the scanned root, posix-separated. */
  file: string;
  /** 1-based line of the match start. */
  line: number;
  /** The matched text. */
  text: string;
}

/**
 * Walk `root`, run `pattern` over every kept file, and return each match —
 * with a floor on the files read AND a floor on the matches found.
 *
 * `pattern` must carry the `g` flag; it is the only way to report more than
 * one hit per file, and a non-global regex silently finding one hit per file
 * is the kind of quiet narrowing this helper is for.
 */
export function scanSourceMatches(
  root: string,
  pattern: RegExp,
  options: {
    fileFloor: number;
    matchFloor: number;
    extensions?: readonly string[];
    include?: (rel: string) => boolean;
    stripComments?: boolean;
  },
): SourceMatch[] {
  if (!pattern.global) {
    throw new Error(`scanSourceMatches: pattern ${pattern} needs the g flag.`);
  }
  const files = walkSourceFiles(root, {
    floor: options.fileFloor,
    extensions: options.extensions,
  }).filter(options.include ?? (() => true));
  requireFloor(`scanSourceMatches(${root}) files`, files, options.fileFloor);

  const matches: SourceMatch[] = [];
  for (const file of files) {
    const raw = readFileSync(join(root, file), "utf8");
    const source = options.stripComments ? stripComments(raw) : raw;
    for (const m of source.matchAll(pattern)) {
      const line = source.slice(0, m.index).split("\n").length;
      matches.push({ file, line, text: m[0] });
    }
  }
  return requireFloor(
    `scanSourceMatches(${root}, ${pattern})`,
    matches,
    options.matchFloor,
  ) as SourceMatch[];
}
