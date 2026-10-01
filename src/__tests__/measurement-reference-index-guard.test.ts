/**
 * #1031 — every column that points into `measurements` has an index.
 *
 * Postgres enforces a foreign key into `measurements` with a trigger that runs
 * once per deleted reading and looks the referencing rows up by the
 * referencing column. Without an index on that column each lookup is a
 * sequential scan of the whole referencing table. Two such columns had none,
 * and deleting 1.89 million readings spent 38 of its 40 seconds in those
 * lookups; on a slower host the restore's clearing step ran past the
 * statement timeout and rolled back. The tombstone purge and account
 * deletion delete readings the same way.
 *
 * Read from the migrations, because one of the two keys (personal records,
 * migration 0054) exists only in SQL and not as a Prisma relation: every
 * foreign key into `measurements`, inline or added with ALTER TABLE, must
 * have an index in some migration that leads with its column.
 *
 * Mutation check: delete the `personal_records` index from migration 0362
 * and this goes red naming `personal_records.source_measurement_id`.
 */
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const dir = resolve(__dirname, "../../prisma/migrations");
const sql = readdirSync(dir, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort()
  .map((name) => readFileSync(resolve(dir, name, "migration.sql"), "utf8"))
  .join("\n");

/** `table.column` of every foreign key into `measurements`. */
function measurementReferences(): string[] {
  const refs = new Set<string>();
  // ALTER TABLE "t" ADD CONSTRAINT … FOREIGN KEY ("c") REFERENCES "measurements"
  for (const m of sql.matchAll(
    /ALTER TABLE "(\w+)"\s+ADD CONSTRAINT "\w+"\s+FOREIGN KEY \("(\w+)"\)\s+REFERENCES "measurements"/g,
  )) {
    refs.add(`${m[1]}.${m[2]}`);
  }
  // CREATE TABLE "t" ( … "c" TEXT REFERENCES "measurements" … )
  for (const table of sql.matchAll(
    /CREATE TABLE (?:IF NOT EXISTS )?"(\w+)"\s*\(([\s\S]*?)\n\);/g,
  )) {
    for (const col of table[2]!.matchAll(
      /^\s*"(\w+)"[^\n]*REFERENCES "measurements"/gm,
    )) {
      refs.add(`${table[1]}.${col[1]}`);
    }
  }
  return [...refs].sort();
}

function hasLeadingIndex(ref: string): boolean {
  const [table, column] = ref.split(".");
  return new RegExp(
    `CREATE (?:UNIQUE )?INDEX (?:IF NOT EXISTS )?"?\\w+"?\\s+ON "${table}"(?: USING \\w+)?\\s*\\(\\s*"${column}"`,
  ).test(sql);
}

describe("columns that point into measurements are indexed", () => {
  const refs = measurementReferences();

  it("finds the references (a matcher that finds none proves nothing)", () => {
    expect(refs.length).toBeGreaterThanOrEqual(2);
    expect(refs).toEqual(
      expect.arrayContaining([
        "ecg_recordings.measurement_id",
        "personal_records.source_measurement_id",
      ]),
    );
  });

  it("each has an index that leads with its column", () => {
    expect(refs.filter((ref) => !hasLeadingIndex(ref))).toEqual([]);
  });
});
