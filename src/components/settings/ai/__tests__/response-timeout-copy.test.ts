/**
 * The response-timeout copy names the defaults the server applies.
 *
 * The placeholder said "Default (~120)" while most surfaces fell back to 60 s
 * and the briefing to 180 s. The numbers now come from the server constants
 * through interpolation; this pins that every locale interpolates them instead
 * of writing a number of its own, and that the rendered text carries them.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { AI_BUDGETS } from "@/lib/ai/ai-budgets";
import { PROVIDER_DEFAULT_TIMEOUT_MS } from "@/lib/ai/effective-timeout";

import { RESPONSE_TIMEOUT_COPY_PARAMS } from "../response-timeout-card";

const LOCALES = ["de", "en", "es", "fr", "it", "ko", "pl"] as const;

function aiCopy(locale: string): Record<string, string> {
  const bundle = JSON.parse(
    readFileSync(join(process.cwd(), "messages", `${locale}.json`), "utf8"),
  ) as { settings: { ai: Record<string, string> } };
  return bundle.settings.ai;
}

function render(template: string): string {
  return template.replace(/\{(\w+)\}/g, (_, k: string) =>
    String(
      RESPONSE_TIMEOUT_COPY_PARAMS[
        k as keyof typeof RESPONSE_TIMEOUT_COPY_PARAMS
      ],
    ),
  );
}

describe("response-timeout copy", () => {
  it("reads its numbers from the server constants", () => {
    expect(RESPONSE_TIMEOUT_COPY_PARAMS.seconds).toBe(
      PROVIDER_DEFAULT_TIMEOUT_MS / 1000,
    );
    expect(RESPONSE_TIMEOUT_COPY_PARAMS.briefingSeconds).toBe(
      AI_BUDGETS.comprehensive.timeoutMs! / 1000,
    );
    expect(RESPONSE_TIMEOUT_COPY_PARAMS.briefingSeconds).toBeGreaterThan(0);
  });

  it.each(LOCALES)(
    "%s interpolates the defaults and writes none itself",
    (locale) => {
      const copy = aiCopy(locale);
      const placeholder = copy.responseTimeoutPlaceholder;
      const body = copy.responseTimeoutBody;
      expect(placeholder).toContain("{seconds}");
      expect(body).toContain("{seconds}");
      expect(body).toContain("{briefingSeconds}");
      // No literal number outside the placeholders: a hardcoded one would drift.
      expect(placeholder.replace(/\{\w+\}/g, "")).not.toMatch(/\d/);
      expect(body.replace(/\{\w+\}/g, "")).not.toMatch(/\d/);

      expect(render(placeholder)).toContain(
        String(PROVIDER_DEFAULT_TIMEOUT_MS / 1000),
      );
      expect(render(body)).toContain(
        String(AI_BUDGETS.comprehensive.timeoutMs! / 1000),
      );
    },
  );
});
