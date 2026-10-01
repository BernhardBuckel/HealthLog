/**
 * Settings card-header drift guard.
 *
 * Every Settings card paints the same header shape — a muted icon, an
 * `<h2 class="text-lg font-semibold">` title, and an optional muted
 * description. The canonical primitive `SettingsCardHeader`
 * (`_card-header.tsx`) owns that shape; routing every card header through
 * it keeps the typography, the icon sizing, and the description size in
 * one place instead of drifting across hand-rolled `flex … <h2 text-lg`
 * permutations (the audit found five distinct variants once).
 *
 * This test globs every `*-section.tsx` / `*-card.tsx` under
 * `src/components/settings/` and flags any file that still hand-rolls a
 * top-level card header — a `<h2>` tag whose className carries `text-lg`.
 * The primitive itself is excluded (it OWNS the `<h2 text-lg>`), and a
 * short, explicitly-documented allowlist covers the handful of headers
 * that legitimately cannot use the primitive yet.
 *
 * Mirrors the call-site coverage guards under `src/__tests__/`: walk the
 * tree, match a mechanical pattern, assert the offending set is empty.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { requireFloor } from "@/__tests__/helpers/source-files";

const ROOT = join(__dirname, "../../../..");
const SETTINGS_DIR = join(ROOT, "src/components/settings");

// Files allowed to retain a hand-rolled `<h2 text-lg>` header.
const ALLOWLIST = new Set<string>([
  // allowed: collapsible-toggle header, button-wrapped, typography already canonical
  "security-activity-card.tsx",
  // allowed: collapsible-toggle header, button-wrapped, typography already canonical
  "security-sessions-card.tsx",
]);

// The primitive itself owns the canonical `<h2 text-lg>`.
const PRIMITIVE = "_card-header.tsx";

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "__tests__" || name === "node_modules") continue;
    const p = join(dir, name);
    const stat = statSync(p);
    if (stat.isDirectory()) {
      walk(p, out);
    } else if (name.endsWith("-section.tsx") || name.endsWith("-card.tsx")) {
      out.push(p);
    }
  }
  return out;
}

// A hand-rolled card header: a `<h2` tag whose className (within a small
// window, so a multi-line opening tag still matches) carries `text-lg`.
const AD_HOC_HEADER = /<h2\b[\s\S]{0,160}?text-lg/;

describe("Settings card headers route through SettingsCardHeader", () => {
  it("has no hand-rolled <h2 text-lg> outside the primitive + allowlist", () => {
    const offenders: string[] = [];

    const files = requireFloor("settings cards", walk(SETTINGS_DIR), 80);
    for (const file of files) {
      const base = file.slice(file.lastIndexOf("/") + 1);
      if (base === PRIMITIVE) continue;
      if (ALLOWLIST.has(base)) continue;

      const source = readFileSync(file, "utf8");
      if (AD_HOC_HEADER.test(source)) {
        offenders.push(relative(ROOT, file));
      }
    }

    expect(
      offenders,
      `These Settings files still hand-roll a card header (\`<h2 ... text-lg>\`).\n` +
        `Route them through <SettingsCardHeader> (src/components/settings/_card-header.tsx),\n` +
        `or, if a header genuinely cannot use the primitive, add it to the ALLOWLIST\n` +
        `in this test with a one-line justification.\n\n` +
        offenders.map((f) => `  - ${f}`).join("\n"),
    ).toEqual([]);
  });
});
