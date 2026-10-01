/**
 * One verdict, one pill mapping.
 *
 * There used to be three `pillStateFor` implementations — one per card family —
 * and they disagreed with each other. The same ledger state painted red on the
 * Withings card and orange on the Polar card, on the same page. The server now
 * resolves the verdict once; this pins that the client projects it once, and
 * that a fourth dialect cannot be minted without someone editing this file.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { walkSourceFiles } from "@/__tests__/helpers/source-files";

import type { SyncVerdict } from "@/lib/integrations/sync-verdict";
import {
  pickStatus,
  pillFailurePropsFor,
  pillStateForVerdict,
} from "../shared";

describe("pillStateForVerdict — the verdict→pill table", () => {
  const table: Array<[SyncVerdict | undefined, string]> = [
    ["fresh", "connected"],
    ["stale", "stale"],
    ["stalled", "stalled"],
    ["failing", "warning"],
    ["reauth_required", "error"],
    ["parked", "parked"],
    ["pending_first_sync", "pending-setup"],
    ["disconnected", "disconnected"],
    // Still loading: the card renders its neutral default rather than
    // guessing at a status it has not been told.
    [undefined, "disconnected"],
  ];

  it.each(table)("maps %s to the %s pill", (verdict, expected) => {
    expect(pillStateForVerdict(verdict)).toBe(expected);
  });

  /**
   * The decision this release makes and must not silently lose: **red means
   * "your action fixes this"**. Reconnecting cannot repair an upstream 503 or
   * a cron that stopped running, so neither of those may reach the destructive
   * pill.
   */
  it("reserves the error pill for the states a reconnect actually fixes", () => {
    const red = table
      .filter(([, state]) => state === "error")
      .map(([verdict]) => verdict);
    expect(red).toEqual(["reauth_required"]);
    expect(pillStateForVerdict("failing")).not.toBe("error");
    expect(pillStateForVerdict("stalled")).not.toBe("error");
  });
});

describe("pillFailurePropsFor", () => {
  it("projects the active bucket and envelope threshold onto the pill", () => {
    const status = pickStatus(
      {
        threshold: 3,
        integrations: [
          {
            integration: "withings",
            state: "error_transient",
            lastSuccessAt: null,
            lastAttemptAt: "2026-07-28T12:00:00.000Z",
            lastError: "upstream unavailable",
            consecutiveFailuresByKind: {
              transient: 2,
              reauth_required: 0,
              persistent: 1,
            },
          },
        ],
      },
      "withings",
    );

    expect(pillFailurePropsFor(status)).toEqual({
      failureCount: 2,
      failureThreshold: 3,
    });
  });

  it("returns no ratio for a healthy zero-count status", () => {
    const status = pickStatus(
      {
        threshold: 3,
        integrations: [
          {
            integration: "withings",
            state: "connected",
            lastSuccessAt: "2026-07-28T12:00:00.000Z",
            lastAttemptAt: "2026-07-28T12:00:00.000Z",
            lastError: null,
            consecutiveFailuresByKind: {
              transient: 0,
              reauth_required: 0,
              persistent: 0,
            },
          },
        ],
      },
      "withings",
    );

    expect(pillFailurePropsFor(status)).toEqual({});
  });
});

describe("structural guard — no second pill dialect", () => {
  const SRC = join(process.cwd(), "src");

  function sourceFiles(): string[] {
    return walkSourceFiles(SRC, { floor: 3000 })
      .filter((p) => !p.startsWith("generated/"))
      .filter((p) => !p.includes("__tests__"))
      .filter((p) => !p.endsWith(".test.ts") && !p.endsWith(".test.tsx"));
  }

  /**
   * The one module allowed to define a status→pill mapping. A tripwire, not a
   * proof: it cannot show the mapping is right, only that nobody added a
   * second one without editing this file.
   */
  const MAPPER_HOME = "components/settings/integrations/shared.tsx";

  it("defines the mapping in exactly one module", () => {
    const definers = sourceFiles().filter((rel) =>
      /function\s+pillStateFor\w*\s*\(/.test(
        readFileSync(join(SRC, rel), "utf8"),
      ),
    );
    expect(definers).toEqual([MAPPER_HOME]);
  });
});
