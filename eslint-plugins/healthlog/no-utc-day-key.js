/**
 * @fileoverview ESLint rule — a day is cut in a named way, not by slicing UTC.
 *
 * `instant.toISOString().slice(0, 10)` is the UTC day of an instant. For a
 * person that is the wrong day for part of every day anywhere off UTC: the
 * evening west of it, the small hours east of it. The same goes for parsing a
 * day key back as UTC midnight (`new Date("2026-06-10")`,
 * `` new Date(`${key}T00:00:00Z`) ``), which is the previous evening west of
 * UTC. The idiom kept coming back because it looks harmless, and each copy
 * was a place where an entry landed on the neighbouring day.
 *
 * The time zone module names every legitimate form:
 *
 *   - the day an instant fell on for a person: `userDayKey(instant, tz)`
 *   - a date-only value or a `@db.Date` column read back: `dateOnlyKey(value)`
 *   - a date-only value to store: `dateOnlyAtNoonUtc(key)`
 *   - a `@db.Date` column value to compare with: `dayKeyAsUtcMidnight(key)`
 *   - the first instant of a person's day: `startOfLocalDayKey(key, tz)`
 *
 * FLAGGED, in `src/` outside `src/lib/tz/` and outside test files:
 *
 *   - `<x>.toISOString().slice(0, 10)` and `.substring(0, 10)`
 *   - `<x>.toISOString().split("T")[0]`
 *   - `new Date("YYYY-MM-DD")` / `Date.parse("YYYY-MM-DD")`
 *   - `` new Date(`${key}T00:00:00Z`) `` (also `T00:00Z`, `T00:00:00.000Z`)
 *     and the same through `Date.parse`
 *
 * A site that means the UTC day on purpose (a file name, a key that is UTC by
 * design and documented as such) stays, with the reason on the line above:
 *
 *   // eslint-disable-next-line healthlog/no-utc-day-key -- UTC by design: <why>
 *
 * The sites that were already there when the rule arrived and should move to
 * the user's day carry `-- baseline: <what is missing>` instead. The guard
 * `src/__tests__/utc-day-key-allowlist-guard.test.ts` requires one of the two
 * prefixes on every directive and holds the baseline count to a ceiling that
 * only goes down.
 *
 * The rule refuses a disable directive for itself that carries no reason, or
 * that uses any form other than `eslint-disable-next-line` (a whole-file or
 * same-line disable would hide the next occurrence too).
 *
 * WHAT THIS RULE DOES NOT CATCH
 *
 * The UTC day assembled another way: `getUTCFullYear()` / `getUTCMonth()` /
 * `getUTCDate()` arithmetic, `toISOString().slice(0, 7)` month keys, an
 * `Intl.DateTimeFormat` pinned to `timeZone: "UTC"`, a slice through a
 * variable (`const iso = d.toISOString(); iso.slice(0, 10)`), or SQL
 * `date_trunc` without `AT TIME ZONE`. It removes the idiom, not every way to
 * reach the UTC calendar.
 */

"use strict";

const RULE_NAME = "healthlog/no-utc-day-key";
const EXEMPT_ROOTS = ["src/lib/tz/"];
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
const UTC_MIDNIGHT_TAIL_RE = /^T00:00(?::00(?:\.0{1,3})?)?Z$/;
const MIN_REASON_CHARS = 8;

function toPosix(filename) {
  return filename.replace(/\\/g, "/");
}

function isTestFile(posix) {
  return (
    /\.test\.[cm]?[jt]sx?$/.test(posix) ||
    /\.spec\.[cm]?[jt]sx?$/.test(posix) ||
    posix.includes("/__tests__/") ||
    posix.includes("/__mocks__/")
  );
}

function isEnforced(filename) {
  const posix = toPosix(filename);
  if (!posix.includes("/src/") && !posix.startsWith("src/")) return false;
  if (EXEMPT_ROOTS.some((root) => posix.includes(root))) return false;
  if (isTestFile(posix)) return false;
  return true;
}

function propertyName(member) {
  if (!member || member.type !== "MemberExpression") return null;
  if (!member.computed && member.property.type === "Identifier") {
    return member.property.name;
  }
  if (member.computed && member.property.type === "Literal") {
    return String(member.property.value);
  }
  return null;
}

/** `<x>.toISOString()` with no arguments. */
function isToIsoStringCall(node) {
  return (
    node &&
    node.type === "CallExpression" &&
    node.arguments.length === 0 &&
    propertyName(node.callee) === "toISOString"
  );
}

function isNumberLiteral(node, value) {
  return node && node.type === "Literal" && node.value === value;
}

/** A day key parsed as UTC midnight: a date-only string or `${k}T00:00Z`. */
function isUtcMidnightDayArg(arg) {
  if (!arg) return false;
  if (arg.type === "Literal" && typeof arg.value === "string") {
    return DATE_ONLY_RE.test(arg.value);
  }
  if (arg.type === "TemplateLiteral" && arg.expressions.length >= 1) {
    const last = arg.quasis[arg.quasis.length - 1];
    const tail = last.value.cooked ?? last.value.raw;
    return typeof tail === "string" && UTC_MIDNIGHT_TAIL_RE.test(tail);
  }
  return false;
}

/** @type {import("eslint").Rule.RuleModule} */
const noUtcDayKeyRule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Cut a day through the time zone module (userDayKey, dateOnlyKey, dateOnlyAtNoonUtc, dayKeyAsUtcMidnight) instead of slicing or parsing UTC.",
    },
    schema: [],
    messages: {
      utcSlice:
        "This is the UTC day of an instant. For a person's day use userDayKey(instant, tz); for a date-only value or a @db.Date column use dateOnlyKey(value) (both in @/lib/tz). If UTC is meant, say why: `// eslint-disable-next-line healthlog/no-utc-day-key -- <reason>`.",
      utcMidnightParse:
        "This parses a day as UTC midnight, the previous evening west of UTC. Store a date-only value with dateOnlyAtNoonUtc(key), compare a @db.Date column with dayKeyAsUtcMidnight(key), or take a person's day start with startOfLocalDayKey(key, tz). If UTC midnight is meant, say why: `// eslint-disable-next-line healthlog/no-utc-day-key -- <reason>`.",
      missingReason:
        "A disable directive for healthlog/no-utc-day-key must say why the UTC day is right here: `-- <reason>` after the rule name.",
      nextLineOnly:
        "Disable healthlog/no-utc-day-key only with `eslint-disable-next-line`, one site at a time, so the next occurrence is still caught.",
    },
  },
  create(context) {
    const filename = context.filename ?? context.getFilename?.();
    if (!filename || !isEnforced(filename)) {
      return {};
    }
    const sourceCode = context.sourceCode ?? context.getSourceCode();

    function checkDirectives() {
      for (const comment of sourceCode.getAllComments()) {
        const text = comment.value.trim();
        const match = /^eslint-disable(-next-line|-line)?\b([\s\S]*)$/.exec(
          text,
        );
        if (!match || !match[2].includes(RULE_NAME)) continue;
        if (match[1] !== "-next-line") {
          // A same-line or block directive suppresses reports at its own
          // position, so the refusal is placed at the top of the file. One
          // sitting on the very first line still hides it; the allowlist
          // guard test (src/__tests__/utc-day-key-allowlist-guard.test.ts)
          // reads every directive and catches that case.
          context.report({
            loc: { line: 1, column: 0 },
            messageId: "nextLineOnly",
          });
          continue;
        }
        const reason = match[2].split(/\s--\s/)[1];
        if (!reason || reason.trim().length < MIN_REASON_CHARS) {
          context.report({ loc: comment.loc, messageId: "missingReason" });
        }
      }
    }

    function checkDateParse(node) {
      if (isUtcMidnightDayArg(node.arguments[0])) {
        context.report({ node, messageId: "utcMidnightParse" });
      }
    }

    return {
      "Program:exit": checkDirectives,
      CallExpression(node) {
        const name = propertyName(node.callee);
        if (
          (name === "slice" || name === "substring") &&
          node.arguments.length === 2 &&
          isNumberLiteral(node.arguments[0], 0) &&
          isNumberLiteral(node.arguments[1], 10) &&
          isToIsoStringCall(node.callee.object)
        ) {
          context.report({ node, messageId: "utcSlice" });
          return;
        }
        if (
          name === "parse" &&
          node.callee.object.type === "Identifier" &&
          node.callee.object.name === "Date"
        ) {
          checkDateParse(node);
        }
      },
      MemberExpression(node) {
        // `<x>.toISOString().split("T")[0]`
        if (
          node.computed &&
          isNumberLiteral(node.property, 0) &&
          node.object.type === "CallExpression" &&
          propertyName(node.object.callee) === "split" &&
          node.object.arguments.length >= 1 &&
          node.object.arguments[0].type === "Literal" &&
          node.object.arguments[0].value === "T" &&
          isToIsoStringCall(node.object.callee.object)
        ) {
          context.report({ node, messageId: "utcSlice" });
        }
      },
      NewExpression(node) {
        if (node.callee.type === "Identifier" && node.callee.name === "Date") {
          checkDateParse(node);
        }
      },
    };
  },
};

module.exports = noUtcDayKeyRule;
