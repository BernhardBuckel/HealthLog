/**
 * AI capability route inventory, across the whole API tree.
 *
 * Proves, from source text, the route half of "data never depends on AI":
 *
 *   1. Every `route.ts` under `src/app/api` that asks an AI capability
 *      (`requireAiCapability` / `getAiCapability`) is on `AI_ROUTES`, which
 *      names the capability and whether it refuses (`action`) or answers 200
 *      with the model text nulled (`mixed`).
 *   2. Each `AI_ROUTES` entry asks exactly the capabilities it declares, by
 *      literal key; an `action` route calls `requireAiCapability`, a `mixed`
 *      read never does (a mixed read never refuses for an AI reason).
 *   3. Every `DATA_ROUTES` entry asks neither gate, nor the retired
 *      `requireAssistantSurface`.
 *   4. The matchers find what they judge: non-zero counts, and a call split
 *      across lines still matches.
 *
 * What it does NOT prove: that a gate sits before the work it guards, or that
 * a mixed read really nulls the text. The route tests and the integration
 * files (`tests/integration/ai-optional-*.test.ts`) prove behaviour; this
 * proves no route escapes classification and no data route grows a gate.
 *
 * 5. Every kind of background run (`DOCUMENT_AI_RUN_KINDS`) is queued by a
 *    route on `AI_ROUTES` that asks the capability the worker asks again for
 *    that kind (`DOCUMENT_AI_RUN_CAPABILITY`), so a run cannot answer to a
 *    different switch than the request that started it.
 *
 * Mutation checks (each turned this file red by name): adding
 * `await requireAiCapability("statusText")` to `insights/ecg/route.ts`;
 * removing the capability call from `insights/chat/route.ts`; swapping
 * `getAiCapability` for `requireAiCapability` in `insights/narrative`.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { AI_CAPABILITY_KEYS } from "@/lib/ai/capabilities/types";
import {
  DOCUMENT_AI_RUN_CAPABILITY,
  DOCUMENT_AI_RUN_KINDS,
  type DocumentAiRunKindValue,
} from "@/lib/documents/ai-runs/types";

import { AI_ROUTES, DATA_ROUTES } from "./ai-route-inventory";

const repoRoot = resolve(__dirname, "..", "..", "..", "..");

/** Comment lines out, so prose naming a gate is not read as a call. */
function code(path: string): string {
  return readFileSync(resolve(repoRoot, path), "utf8")
    .split("\n")
    .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
    .join("\n");
}

/** Whitespace-tolerant: a call split across lines still matches. */
const GATE_CALL =
  /\b(?:(requireAiCapability|getAiCapability)\s*\(\s*"(\w+)"|(aiCapabilityToServe)\s*\([^,()]*,\s*"(\w+)")/g;
const ANY_GATE =
  /\b(?:requireAiCapability|getAiCapability|aiCapabilityToServe)\s*\(/;
const REQUIRE_GATE = /\brequireAiCapability\s*\(/;
const RETIRED_GATE = /\brequireAssistantSurface\s*\(/;

function gateCalls(text: string): Array<{ fn: string; key: string }> {
  return [...text.matchAll(GATE_CALL)].map((m) => ({
    fn: m[1] ?? m[3],
    key: m[2] ?? m[4],
  }));
}

function routeFiles(): string[] {
  const root = resolve(repoRoot, "src/app/api");
  const hits: string[] = [];
  function walk(dir: string): void {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        if (entry === "__tests__" || entry === "node_modules") continue;
        walk(full);
      } else if (entry === "route.ts") {
        hits.push(relative(repoRoot, full).split(/[\\/]/).join("/"));
      }
    }
  }
  walk(root);
  return hits.sort();
}

const ROUTES = routeFiles();

describe("AI capability route inventory", () => {
  it("the matcher reads a call split across lines", () => {
    const split = 'await requireAiCapability(\n    "coach",\n  );';
    expect(gateCalls(split)).toEqual([
      { fn: "requireAiCapability", key: "coach" },
    ]);
    expect(ANY_GATE.test("getAiCapability (\n")).toBe(true);
    expect(
      gateCalls('aiCapabilityToServe(\n    user.id,\n    "statusText",\n  )'),
    ).toEqual([{ fn: "aiCapabilityToServe", key: "statusText" }]);
  });

  it("finds the routes it is meant to judge", () => {
    expect(ROUTES.length).toBeGreaterThan(100);
    const asking = ROUTES.filter((path) => ANY_GATE.test(code(path)));
    // A matcher that stopped matching would agree with an empty world.
    expect(asking.length).toBeGreaterThan(0);
    expect(asking.length).toBe(Object.keys(AI_ROUTES).length);
    expect(Object.keys(DATA_ROUTES).length).toBeGreaterThan(0);
  });

  it("every route that asks an AI capability is on AI_ROUTES", () => {
    const unlisted = ROUTES.filter(
      (path) => ANY_GATE.test(code(path)) && !(path in AI_ROUTES),
    );
    expect(
      unlisted,
      "these routes ask an AI capability but are not on AI_ROUTES — add them with their capability, or remove the gate from a data route",
    ).toEqual([]);
  });

  describe.each(Object.entries(AI_ROUTES))("%s", (path, entry) => {
    it("exists and asks exactly the capabilities it declares", () => {
      expect(ROUTES, `${path} no longer exists`).toContain(path);
      const calls = gateCalls(code(path));
      expect(calls.length, `${path} asks no capability`).toBeGreaterThan(0);
      for (const { key } of calls) {
        expect(AI_CAPABILITY_KEYS as readonly string[]).toContain(key);
      }
      expect([...new Set(calls.map((c) => c.key))].sort()).toEqual(
        [...entry.capabilities].sort(),
      );
    });

    it(`is ${entry.kind === "action" ? "an action that refuses" : "a mixed read that never refuses"}`, () => {
      const refuses = REQUIRE_GATE.test(code(path));
      expect(
        refuses,
        entry.kind === "action"
          ? `${path} is an action but never calls requireAiCapability`
          : `${path} is a mixed read but calls requireAiCapability — a mixed read answers 200 and nulls the model text`,
      ).toBe(entry.kind === "action");
    });
  });

  it("no data route asks an AI capability or the retired gate", () => {
    const offenders = Object.keys(DATA_ROUTES).filter((path) => {
      const text = code(path);
      return ANY_GATE.test(text) || RETIRED_GATE.test(text);
    });
    expect(
      offenders,
      "data routes never depend on AI: remove the gate, or move the route to AI_ROUTES if it now serves model text",
    ).toEqual([]);
  });

  it("no data route is stale or listed twice", () => {
    const missing = Object.keys(DATA_ROUTES).filter(
      (path) => !ROUTES.includes(path),
    );
    expect(missing, "DATA_ROUTES names files that do not exist").toEqual([]);
    const both = Object.keys(DATA_ROUTES).filter((path) => path in AI_ROUTES);
    expect(both).toEqual([]);
  });
});

/** The route that queues each kind of background run. */
const RUN_QUEUED_BY: Record<DocumentAiRunKindValue, string> = {
  DOCUMENT_INDEX: "src/app/api/documents/inbound/[id]/index/route.ts",
  LABS_OCR_EXTRACT: "src/app/api/labs/ocr/extract/route.ts",
  DOCUMENT_SUMMARY: "src/app/api/documents/inbound/[id]/summary/route.ts",
  DOCUMENT_SUGGEST: "src/app/api/documents/inbound/[id]/suggest/route.ts",
  DOCUMENT_EXTRACT: "src/app/api/documents/inbound/[id]/extract/route.ts",
};

describe("background run kinds", () => {
  it.each(DOCUMENT_AI_RUN_KINDS)(
    "%s is queued by an AI route under the capability the worker re-checks",
    (kind) => {
      const path = RUN_QUEUED_BY[kind];
      const entry = AI_ROUTES[path];
      expect(entry, `${path} is not on AI_ROUTES`).toBeDefined();
      expect(entry.capabilities).toContain(DOCUMENT_AI_RUN_CAPABILITY[kind]);
      expect(
        new RegExp(`kind:\\s*"${kind}"`).test(code(path)),
        `${path} does not queue ${kind}`,
      ).toBe(true);
    },
  );
});
