/**
 * Unit tests for the `healthlog/no-utc-day-key` rule: the UTC-day idioms are
 * refused in application source, allowed in `src/lib/tz/` and in tests, and a
 * disable directive for the rule must be next-line-only and carry a reason.
 */
import { describe, expect, it } from "vitest";
import { Linter, RuleTester } from "eslint";
import rule from "../no-utc-day-key.js";

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2023,
    sourceType: "module",
    parserOptions: { ecmaFeatures: { jsx: true } },
  },
});

const APP = "/repo/src/lib/insights/some-reader.ts";

ruleTester.run("no-utc-day-key", rule, {
  valid: [
    { code: "const day = userDayKey(at, tz);", filename: APP },
    { code: "const day = dateOnlyKey(row.documentDate);", filename: APP },
    // A month key is not a day key.
    { code: "const month = at.toISOString().slice(0, 7);", filename: APP },
    // A full instant is fine.
    { code: "const iso = at.toISOString();", filename: APP },
    // Noon UTC is the date-only storage anchor.
    { code: "const d = new Date(`${key}T12:00:00.000Z`);", filename: APP },
    // A fixed instant literal is not day parsing.
    { code: 'const d = new Date("2026-06-10T08:00:00.000Z");', filename: APP },
    // The time zone module owns the idiom.
    {
      code: "export const k = (d) => d.toISOString().slice(0, 10);",
      filename: "/repo/src/lib/tz/date-only.ts",
    },
    // Fixtures pick concrete days on purpose.
    {
      code: 'const d = new Date("2026-06-10"); const k = d.toISOString().slice(0, 10);',
      filename: "/repo/src/lib/insights/__tests__/reader.test.ts",
    },
    // Outside src/ entirely.
    {
      code: "const k = d.toISOString().slice(0, 10);",
      filename: "/repo/scripts/backfill.ts",
    },
  ],
  invalid: [
    {
      code: "const day = at.toISOString().slice(0, 10);",
      filename: APP,
      errors: [{ messageId: "utcSlice" }],
    },
    {
      code: "const day = at.toISOString().substring(0, 10);",
      filename: APP,
      errors: [{ messageId: "utcSlice" }],
    },
    {
      code: 'const day = at.toISOString().split("T")[0];',
      filename: APP,
      errors: [{ messageId: "utcSlice" }],
    },
    {
      code: "const day = new Date(now - 86400000)\n  .toISOString()\n  .slice(0, 10);",
      filename: APP,
      errors: [{ messageId: "utcSlice" }],
    },
    {
      code: 'const d = new Date("2026-06-10");',
      filename: APP,
      errors: [{ messageId: "utcMidnightParse" }],
    },
    {
      code: "const d = new Date(`${key}T00:00:00.000Z`);",
      filename: APP,
      errors: [{ messageId: "utcMidnightParse" }],
    },
    {
      code: "const ms = Date.parse(`${key}T00:00:00Z`);",
      filename: APP,
      errors: [{ messageId: "utcMidnightParse" }],
    },
    {
      code: "<input max={new Date().toISOString().slice(0, 10)} />;",
      filename: "/repo/src/components/settings/form.tsx",
      errors: [{ messageId: "utcSlice" }],
    },
  ],
});

/**
 * Disable directives name the rule under the plugin's own prefix, which the
 * RuleTester does not use, so they run through a Linter with the plugin
 * registered as `healthlog` — the way the flat config loads it.
 */
describe("no-utc-day-key disable directives", () => {
  const linter = new Linter({ configType: "flat" });
  const config = [
    {
      files: ["**/*.ts"],
      plugins: { healthlog: { rules: { "no-utc-day-key": rule } } },
      rules: { "healthlog/no-utc-day-key": "error" },
    },
  ];
  const lint = (code) =>
    linter
      .verify(code, config, { filename: "src/lib/insights/reader.ts" })
      .map((m) => m.messageId ?? m.message);

  it("accepts a next-line directive that gives a reason", () => {
    expect(
      lint(
        "// eslint-disable-next-line healthlog/no-utc-day-key -- UTC by design: file name stamp\nconst s = new Date().toISOString().slice(0, 10);",
      ),
    ).toEqual([]);
  });

  it("refuses a directive without a reason", () => {
    expect(
      lint(
        "// eslint-disable-next-line healthlog/no-utc-day-key\nconst s = d.toISOString().slice(0, 10);",
      ),
    ).toEqual(["missingReason"]);
  });

  it("refuses a reason too short to say anything", () => {
    expect(
      lint(
        "// eslint-disable-next-line healthlog/no-utc-day-key -- ok\nconst s = d.toISOString().slice(0, 10);",
      ),
    ).toEqual(["missingReason"]);
  });

  it("refuses a same-line or whole-file disable, which would hide the next site too", () => {
    // The site itself is suppressed by the directive, so the only report is
    // the directive's own, placed at the top of the file where the directive
    // does not reach.
    expect(
      lint(
        "const a = 1;\nconst s = d.toISOString().slice(0, 10); // eslint-disable-line healthlog/no-utc-day-key -- UTC by design: file name stamp",
      ),
    ).toEqual(["nextLineOnly"]);
    expect(
      lint(
        "const a = 1;\n/* eslint-disable healthlog/no-utc-day-key -- UTC by design: file name stamp */\nconst s = d.toISOString().slice(0, 10);",
      ),
    ).toEqual(["nextLineOnly"]);
  });
});
