/**
 * Structural guard: every pg-boss queue declares how long its job can run, and
 * a long one is safe against pg-boss's expiry.
 *
 * pg-boss gives a job fifteen minutes unless the send says otherwise, then
 * fails it, fires its abort signal and retries it while the handler keeps
 * going. The full-history imports ran beside themselves that way (#1066), and
 * so could every other job that legitimately needs longer: the nightly status
 * passes, the pre-generation, the record scan, the key rotation, the backups.
 *
 * `src/lib/jobs/queue-runtime.ts` declares every queue `short`, `budgeted` or
 * `long`. This guard holds the tree to it:
 *
 *   - every queue bound with `createAndWork` is in the table, and every table
 *     entry is bound;
 *   - every `boss.send` and every schedule tuple names a queue in the table;
 *   - a `long` queue has an expiry between the default and pg-boss's 24-hour
 *     ceiling, every send and schedule for it carries `expireInSeconds` (or an
 *     identifier the table names as its carrier), it stops on the job's budget
 *     where the table says (`jobBudget` / `jobDeadline`, or a declared
 *     one-shot), and it is exclusive per identity where the table says
 *     (`lockedPass` at the binding, or the named marker);
 *   - a `budgeted` queue stops on the budget and relies on the default expiry;
 *   - a `short` queue's sends set no expiry of their own, which would mean the
 *     job is longer than the table claims.
 *
 * Floors fail the guard if a matcher stops matching, and the "plants" cases
 * run the checks over a planted long queue that lacks each protection in turn
 * (the mutation proof kept in the suite). Removing `lockedPass` from the
 * pr-detection binding, or the expiry from its cron tuple, fails the real
 * checks below.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { walkSourceFiles } from "./helpers/source-files";
import {
  DEFAULT_JOB_EXPIRE_SECONDS,
  QUEUE_RUNTIME,
  type QueueRuntime,
  type SourceSite,
} from "@/lib/jobs/queue-runtime";

const SRC = join(process.cwd(), "src");
const REGISTRARS = [
  "lib/jobs/reminder/register-integration-sync.ts",
  "lib/jobs/reminder/register-maintenance.ts",
  "lib/jobs/reminder/register-reminders.ts",
  "lib/jobs/reminder/register-rollup.ts",
  "lib/jobs/reminder/register-status.ts",
];
/** pg-boss refuses an expiry of 24 hours or more. */
const MAX_EXPIRE_SECONDS = 24 * 60 * 60;

const files = walkSourceFiles(SRC, { floor: 3000 })
  .filter((p) => !p.startsWith("generated/"))
  .filter((p) => !p.includes("__tests__"))
  .filter((p) => !p.endsWith(".test.ts") && !p.endsWith(".test.tsx"));
const source = new Map(
  files.map((f) => [f, readFileSync(join(SRC, f), "utf8")]),
);

/** Strip comments so documentation that quotes code never matches. */
function code(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** Index just past the bracket that closes the one at `open`. */
function closeOf(text: string, open: number): number {
  const pair: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
  const want = pair[text[open]];
  let depth = 1;
  let i = open + 1;
  while (depth > 0 && i < text.length) {
    if (text[i] === text[open]) depth += 1;
    else if (text[i] === want) depth -= 1;
    i += 1;
  }
  return i;
}

type Definitions = Map<string, Array<{ file: string; name: string }>>;

/** `const NAME = "queue-name"` definitions, per file. */
function definitionsOf(texts: ReadonlyMap<string, string>): Definitions {
  const definitions: Definitions = new Map();
  for (const [file, text] of texts) {
    for (const m of text.matchAll(
      /\bconst\s+([A-Z][A-Z0-9_]*)\s*(?::\s*string\s*)?=\s*"([a-z0-9-]+)"/g,
    )) {
      const list = definitions.get(m[1]) ?? [];
      list.push({ file, name: m[2] });
      definitions.set(m[1], list);
    }
  }
  return definitions;
}

/** Resolve a queue identifier as seen from `file`, preferring its own. */
function resolve(
  definitions: Definitions,
  file: string,
  ident: string,
): string | null {
  const defs = definitions.get(ident) ?? [];
  const own = defs.find((d) => d.file === file);
  if (own) return own.name;
  const names = new Set(defs.map((d) => d.name));
  return names.size === 1 ? [...names][0] : null;
}

interface Site {
  file: string;
  queue: string;
  text: string;
}

/** Every `createAndWork(boss, QUEUE, …)` in the registrars. */
function bindings(
  texts: ReadonlyMap<string, string>,
  definitions: Definitions,
): Site[] {
  const out: Site[] = [];
  for (const file of REGISTRARS) {
    const text = code(texts.get(file) ?? "");
    for (const m of text.matchAll(
      /createAndWork\s*(?:<[^(]*?>)?\(\s*boss\s*,\s*([A-Z][A-Z0-9_]*)/g,
    )) {
      const open = text.indexOf("(", m.index);
      const queue = resolve(definitions, file, m[1]);
      if (queue) {
        out.push({ file, queue, text: text.slice(open, closeOf(text, open)) });
      }
    }
  }
  return out;
}

/** Every `boss.send(QUEUE, …)` / `getGlobalBoss()?.send(QUEUE, …)`. */
function sends(
  texts: ReadonlyMap<string, string>,
  definitions: Definitions,
): Site[] {
  const out: Site[] = [];
  for (const [file, raw] of texts) {
    const text = code(raw);
    for (const m of text.matchAll(
      /\b(?:boss|getGlobalBoss\(\)\??)\s*\.\s*send\s*(?:<[^(]*?>)?\(\s*([A-Z][A-Z0-9_]*)/g,
    )) {
      const open = text.indexOf("(", text.indexOf("send", m.index));
      const queue = resolve(definitions, file, m[1]);
      if (queue) {
        out.push({ file, queue, text: text.slice(open, closeOf(text, open)) });
      }
    }
  }
  return out;
}

/** Every `[QUEUE, CRON, options?]` tuple in a registrar's `schedules`. */
function schedules(
  texts: ReadonlyMap<string, string>,
  definitions: Definitions,
): Site[] {
  const out: Site[] = [];
  for (const file of REGISTRARS) {
    const text = code(texts.get(file) ?? "");
    const m = /const\s+schedules\s*:\s*ScheduleEntry\[\]\s*=\s*\[/.exec(text);
    if (!m) continue;
    const open = m.index + m[0].length - 1;
    const body = text.slice(open + 1, closeOf(text, open) - 1);
    for (let i = 0; i < body.length; i += 1) {
      if (body[i] !== "[") continue;
      const end = closeOf(body, i);
      const tuple = body.slice(i, end);
      const ident = /^\[\s*([A-Z][A-Z0-9_]*)/.exec(tuple)?.[1];
      const queue = ident ? resolve(definitions, file, ident) : null;
      if (queue) out.push({ file, queue, text: tuple });
      i = end - 1;
    }
  }
  return out;
}

/** The text of `fn` (a function or a const) in `file`. */
function bodyOf(
  texts: ReadonlyMap<string, string>,
  site: { file: string; fn: string },
): string {
  const text = code(texts.get(site.file) ?? "");
  const m = new RegExp(
    `(?:function\\s+${site.fn}\\b|const\\s+${site.fn}\\b)`,
  ).exec(text);
  if (!m) return "";
  const end = text.indexOf("\n}", m.index);
  return text.slice(m.index, end < 0 ? undefined : end + 2);
}

function siteText(
  texts: ReadonlyMap<string, string>,
  site: SourceSite,
  binding: Site | undefined,
): string {
  return site === "binding" ? (binding?.text ?? "") : bodyOf(texts, site);
}

const STOPS = /\bjob(?:Budget|Deadline)\s*\(/;

/** Every finding for one queue's declaration against the tree. */
function check(
  queue: string,
  entry: QueueRuntime,
  texts: ReadonlyMap<string, string>,
  all: { bindings: Site[]; sends: Site[]; schedules: Site[] },
): string[] {
  const problems: string[] = [];
  const binding = all.bindings.find((b) => b.queue === queue);
  const carriers = [...all.sends, ...all.schedules].filter(
    (s) => s.queue === queue,
  );
  if (entry.runtime === "long") {
    if (
      !(entry.expireInSeconds > DEFAULT_JOB_EXPIRE_SECONDS) ||
      !(entry.expireInSeconds < MAX_EXPIRE_SECONDS)
    ) {
      problems.push(`${queue}: expiry ${entry.expireInSeconds}s out of range`);
    }
    for (const site of carriers) {
      const carried =
        /\bexpireInSeconds\b/.test(site.text) ||
        entry.expiryVia.some((v) => new RegExp(`\\b${v}\\b`).test(site.text));
      if (!carried) {
        problems.push(
          `${queue}: ${site.file} sends or schedules it without an expiry`,
        );
      }
    }
    if (typeof entry.stop === "object" && "oneShot" in entry.stop) {
      if (entry.stop.oneShot.length < 20) {
        problems.push(`${queue}: a one-shot needs its reason`);
      }
    } else if (!STOPS.test(siteText(texts, entry.stop, binding))) {
      problems.push(`${queue}: does not stop on the job's budget`);
    }
    if (entry.exclusive === "lockedPass") {
      if (!/\blockedPass\s*\(/.test(binding?.text ?? "")) {
        problems.push(`${queue}: binding holds no lockedPass`);
      }
    } else if (
      !siteText(texts, entry.exclusive.at, binding).includes(
        entry.exclusive.marker,
      )
    ) {
      problems.push(`${queue}: no "${entry.exclusive.marker}" where declared`);
    }
  } else {
    if (entry.runtime === "budgeted") {
      if (!STOPS.test(siteText(texts, entry.budget, binding))) {
        problems.push(`${queue}: does not stop on the job's budget`);
      }
    }
    for (const site of carriers) {
      if (/\bexpireInSeconds\b/.test(site.text)) {
        problems.push(
          `${queue}: ${site.file} sets an expiry on a queue declared ${entry.runtime}`,
        );
      }
    }
  }
  return problems;
}

function scan(texts: ReadonlyMap<string, string>) {
  const definitions = definitionsOf(texts);
  return {
    bindings: bindings(texts, definitions),
    sends: sends(texts, definitions),
    schedules: schedules(texts, definitions),
  };
}

describe("every queue declares its runtime", () => {
  const all = scan(source);
  const bound = new Set(all.bindings.map((b) => b.queue));

  it("finds the bindings, sends and schedules it is meant to police", () => {
    // Pinned below the counts on 2026-10-01 (112 / 64 / 74).
    expect(all.bindings.length).toBeGreaterThanOrEqual(105);
    expect(all.sends.length).toBeGreaterThanOrEqual(50);
    expect(all.schedules.length).toBeGreaterThanOrEqual(70);
    expect(
      Object.values(QUEUE_RUNTIME).filter((e) => e.runtime === "long").length,
    ).toBeGreaterThanOrEqual(15);
  });

  it("every bound queue is in the table, and every entry is bound", () => {
    expect([...bound].filter((q) => !(q in QUEUE_RUNTIME)).sort()).toEqual([]);
    expect(
      Object.keys(QUEUE_RUNTIME)
        .filter((q) => !bound.has(q))
        .sort(),
    ).toEqual([]);
  });

  it("every send and schedule names a queue in the table", () => {
    const unknown = [...all.sends, ...all.schedules]
      .filter((s) => !(s.queue in QUEUE_RUNTIME))
      .map((s) => `${s.file} → ${s.queue}`);
    expect(unknown).toEqual([]);
  });

  it("every queue meets its declaration", () => {
    const problems = Object.entries(QUEUE_RUNTIME).flatMap(([queue, entry]) =>
      check(queue, entry, source, all),
    );
    expect(problems).toEqual([]);
  });

  it("plants: a long queue missing any protection is caught", () => {
    const registrar = REGISTRARS[1];
    const planted = (binding: string, schedule: string) =>
      new Map([
        ...source,
        [
          registrar,
          `const PLANT_QUEUE = "planted-long";\n` +
            `const schedules: ScheduleEntry[] = [\n  ${schedule},\n];\n` +
            `async function register(boss) {\n  await createAndWork(boss, PLANT_QUEUE, { localConcurrency: 1 }, ${binding});\n}\n`,
        ],
      ]);
    const entry: QueueRuntime = {
      runtime: "long",
      expireInSeconds: 3600,
      expiryVia: [],
      stop: "binding",
      exclusive: "lockedPass",
      why: "planted",
    };
    const findings = (binding: string, schedule: string) => {
      const texts = planted(binding, schedule);
      return check("planted-long", entry, texts, scan(texts));
    };
    const safe = [
      "lockedPass(PLANT_QUEUE, () => WHOLE_PASS, async (jobs) => run(jobBudget(jobs)))",
      "[PLANT_QUEUE, CRON, { expireInSeconds: 3600 }]",
    ] as const;
    expect(findings(...safe)).toEqual([]);
    expect(findings(safe[0], "[PLANT_QUEUE, CRON]")).toEqual([
      `planted-long: ${registrar} sends or schedules it without an expiry`,
    ]);
    expect(
      findings("lockedPass(PLANT_QUEUE, () => WHOLE_PASS, run)", safe[1]),
    ).toEqual(["planted-long: does not stop on the job's budget"]);
    expect(findings("async (jobs) => run(jobBudget(jobs))", safe[1])).toEqual([
      "planted-long: binding holds no lockedPass",
    ]);
    expect(
      check(
        "planted-long",
        { ...entry, expireInSeconds: 900 },
        ...((): [ReadonlyMap<string, string>, ReturnType<typeof scan>] => {
          const texts = planted(...safe);
          return [texts, scan(texts)];
        })(),
      ),
    ).toEqual(["planted-long: expiry 900s out of range"]);
  });
});
