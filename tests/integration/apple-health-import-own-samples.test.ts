/**
 * The Apple Health export must not bring back what HealthLog wrote into Apple
 * Health itself.
 *
 * The iOS app writes manual entries into Apple Health, and mirrors Withings and
 * import rows into it, each stamped with `dev.healthlog.app.origin = healthlog`.
 * The server already holds those readings under their own source, so the same
 * sample arriving through an export is a second copy: the series shows it
 * twice and the rollups count it twice.
 *
 * Asserted against a real Postgres:
 *   - a record carrying the marker is left out, and counted;
 *   - a record without it lands as before;
 *   - the marker is read from a child `<MetadataEntry>` that follows the
 *     record's open tag, so the record is committed at its close tag;
 *   - a manual entry mirrored before the marker existed (a MANUAL row with the
 *     same type and value within 2 s) is left out and counted separately;
 *   - a MANUAL row with another value, or 3 s away, is not a match;
 *   - a Withings row of the same value and time is not a match either (those
 *     are mirrored with the marker, so a match would only add false positives).
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { getPrismaClient, truncateAllTables } from "./setup";
import { streamParseExportXml } from "@/lib/measurements/import-apple-health-export";

const prisma = getPrismaClient();

beforeEach(async () => {
  await truncateAllTables(prisma);
});

function writeXml(records: string): string {
  const dir = mkdtempSync(join(tmpdir(), "healthlog-import-own-"));
  const xmlPath = join(dir, "export.xml");
  writeFileSync(
    xmlPath,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE HealthData [<!ELEMENT HealthData (Record)*>]>
<HealthData locale="en_US">
${records}
</HealthData>`,
  );
  return xmlPath;
}

const weight = (value: number, end: string, children = "") =>
  `  <Record type="HKQuantityTypeIdentifierBodyMass" sourceName="Health" unit="kg" startDate="${end}" endDate="${end}" value="${value}">${children}</Record>`;
const OWN = `<MetadataEntry key="dev.healthlog.app.origin" value="healthlog"/>`;
const OTHER = `<MetadataEntry key="HKWasUserEntered" value="1"/>`;

async function run(records: string) {
  const user = await prisma.user.create({
    data: { username: "own-samples", email: "own@example.test", role: "USER" },
  });
  const result = await streamParseExportXml({
    xmlPath: writeXml(records),
    userId: user.id,
    userTimezone: "Europe/Berlin",
    prisma,
  });
  const rows = await prisma.measurement.findMany({
    where: { userId: user.id, type: "WEIGHT", source: "APPLE_HEALTH" },
    orderBy: { measuredAt: "asc" },
  });
  return { user, result, rows };
}

describe("a record HealthLog wrote itself (the origin marker)", () => {
  it("is left out and counted; an ordinary record still lands", async () => {
    const { result, rows } = await run(
      [
        weight(80.1, "2026-05-14 08:00:00 +0200", `\n    ${OWN}\n  `),
        weight(80.2, "2026-05-14 09:00:00 +0200", `\n    ${OTHER}\n  `),
        weight(80.3, "2026-05-14 10:00:00 +0200"),
      ].join("\n"),
    );
    expect(rows.map((r) => r.value)).toEqual([80.2, 80.3]);
    expect(result.writtenByHealthLog).toEqual({
      byMarker: 1,
      matchedManual: 0,
    });
  });

  it("finds the marker among other metadata entries", async () => {
    const { result, rows } = await run(
      weight(80.1, "2026-05-14 08:00:00 +0200", `\n  ${OTHER}\n  ${OWN}\n`),
    );
    expect(rows).toHaveLength(0);
    expect(result.writtenByHealthLog.byMarker).toBe(1);
  });

  it("does not let one record's marker spill onto the next", async () => {
    const { rows } = await run(
      [
        weight(80.1, "2026-05-14 08:00:00 +0200", `\n  ${OWN}\n`),
        weight(80.2, "2026-05-14 09:00:00 +0200"),
      ].join("\n"),
    );
    expect(rows.map((r) => r.value)).toEqual([80.2]);
  });

  it("needs the exact value: another origin does not count", async () => {
    const { rows } = await run(
      weight(
        80.1,
        "2026-05-14 08:00:00 +0200",
        `<MetadataEntry key="dev.healthlog.app.origin" value="other"/>`,
      ),
    );
    expect(rows).toHaveLength(1);
  });
});

const bpRecord = (
  type: "Systolic" | "Diastolic",
  value: number,
  at: string,
  children = "",
) =>
  `    <Record type="HKQuantityTypeIdentifierBloodPressure${type}" sourceName="Health" unit="mmHg" startDate="${at}" endDate="${at}" value="${value}">${children}</Record>`;
const correlation = (inner: string, children = "") =>
  `  <Correlation type="HKCorrelationTypeIdentifierBloodPressure" sourceName="Health" startDate="2026-05-14 08:00:00 +0200" endDate="2026-05-14 08:00:00 +0200">${children}\n${inner}\n  </Correlation>`;

describe("blood pressure correlations and self-closing records", () => {
  const AT = "2026-05-14 08:00:00 +0200";
  async function runBp(records: string) {
    const user = await prisma.user.create({
      data: { username: "own-bp", email: "bp@example.test", role: "USER" },
    });
    const result = await streamParseExportXml({
      xmlPath: writeXml(records),
      userId: user.id,
      userTimezone: "Europe/Berlin",
      prisma,
    });
    const rows = await prisma.measurement.findMany({
      where: {
        userId: user.id,
        type: { in: ["BLOOD_PRESSURE_SYS", "BLOOD_PRESSURE_DIA"] },
      },
      orderBy: [{ type: "asc" }],
    });
    return { result, values: rows.map((r) => r.value) };
  }

  it("imports an unmarked correlation's two records", async () => {
    const { values, result } = await runBp(
      correlation(
        [bpRecord("Systolic", 121, AT), bpRecord("Diastolic", 79, AT)].join(
          "\n",
        ),
      ),
    );
    expect(values).toEqual([121, 79]);
    expect(result.writtenByHealthLog.byMarker).toBe(0);
  });

  it("leaves out both records when the marker is on the correlation, before them", async () => {
    const { values, result } = await runBp(
      correlation(
        [bpRecord("Systolic", 121, AT), bpRecord("Diastolic", 79, AT)].join(
          "\n",
        ),
        `\n    ${OWN}`,
      ),
    );
    expect(values).toEqual([]);
    expect(result.writtenByHealthLog.byMarker).toBe(2);
  });

  it("leaves out both records when the marker is on the correlation, after them", async () => {
    const records = [
      bpRecord("Systolic", 121, AT),
      bpRecord("Diastolic", 79, AT),
    ].join("\n");
    const { values } = await runBp(
      `  <Correlation type="HKCorrelationTypeIdentifierBloodPressure" sourceName="Health" startDate="${AT}" endDate="${AT}">\n${records}\n    ${OWN}\n  </Correlation>`,
    );
    expect(values).toEqual([]);
  });

  it("leaves out only the record that carries the marker", async () => {
    const { values } = await runBp(
      correlation(
        [
          bpRecord("Systolic", 121, AT, `\n      ${OWN}\n    `),
          bpRecord("Diastolic", 79, AT),
        ].join("\n"),
      ),
    );
    expect(values).toEqual([79]);
  });

  it("does not let a correlation's marker spill onto the next record", async () => {
    const { values } = await runBp(
      [
        correlation(
          [bpRecord("Systolic", 121, AT), bpRecord("Diastolic", 79, AT)].join(
            "\n",
          ),
          `\n    ${OWN}`,
        ),
        bpRecord("Systolic", 130, "2026-05-14 09:00:00 +0200"),
      ].join("\n"),
    );
    expect(values).toEqual([130]);
  });

  it("imports a self-closing record, with no children to wait for", async () => {
    const { rows } = await run(
      `  <Record type="HKQuantityTypeIdentifierBodyMass" sourceName="Health" unit="kg" startDate="${AT}" endDate="${AT}" value="80.9"/>`,
    );
    expect(rows.map((r) => r.value)).toEqual([80.9]);
  });
});

describe("the synthetic export fixture", () => {
  // `export-own-origin.synthetic.xml` is invented, in the shape Apple's DTD
  // documents. It shows the parser reads a file laid out like an export; it
  // cannot show that Apple writes a custom metadata key verbatim.
  it("leaves out the two marked records and imports the other three", async () => {
    const user = await prisma.user.create({
      data: { username: "own-fixture", email: "fx@example.test", role: "USER" },
    });
    const result = await streamParseExportXml({
      xmlPath: join(
        process.cwd(),
        "tests/fixtures/apple-health/export-own-origin.synthetic.xml",
      ),
      userId: user.id,
      userTimezone: "Europe/Berlin",
      prisma,
    });
    const rows = await prisma.measurement.findMany({
      where: { userId: user.id, type: "WEIGHT", source: "APPLE_HEALTH" },
      orderBy: { measuredAt: "asc" },
    });
    expect(rows.map((r) => r.value)).toEqual([80.2, 80.4, 80.5]);
    expect(result.writtenByHealthLog).toEqual({
      byMarker: 2,
      matchedManual: 0,
    });
  });
});

describe("a manual entry mirrored before the marker existed", () => {
  async function runAgainst(
    manual: { value: number; at: string; source?: "MANUAL" | "WITHINGS" },
    record: { value: number; at: string },
  ) {
    const user = await prisma.user.create({
      data: { username: "own-fallback", email: "f@example.test", role: "USER" },
    });
    await prisma.measurement.create({
      data: {
        userId: user.id,
        type: "WEIGHT",
        unit: "kg",
        source: manual.source ?? "MANUAL",
        value: manual.value,
        measuredAt: new Date(manual.at),
      },
    });
    const result = await streamParseExportXml({
      xmlPath: writeXml(weight(record.value, "2026-05-14 08:00:00 +0200")),
      userId: user.id,
      userTimezone: "Europe/Berlin",
      prisma,
    });
    const rows = await prisma.measurement.findMany({
      where: { userId: user.id, type: "WEIGHT", source: "APPLE_HEALTH" },
    });
    return { result, rows };
  }

  it("is left out when a MANUAL row has the same value within 2 s", async () => {
    const { result, rows } = await runAgainst(
      { value: 80.4, at: "2026-05-14T06:00:01.500Z" },
      { value: 80.4, at: "" },
    );
    expect(rows).toHaveLength(0);
    expect(result.writtenByHealthLog).toEqual({
      byMarker: 0,
      matchedManual: 1,
    });
  });

  it("is kept when the value differs", async () => {
    const { result, rows } = await runAgainst(
      { value: 80.9, at: "2026-05-14T06:00:00.000Z" },
      { value: 80.4, at: "" },
    );
    expect(rows).toHaveLength(1);
    expect(result.writtenByHealthLog.matchedManual).toBe(0);
  });

  it("is kept when the MANUAL row is 3 s away", async () => {
    const { rows } = await runAgainst(
      { value: 80.4, at: "2026-05-14T06:00:03.000Z" },
      { value: 80.4, at: "" },
    );
    expect(rows).toHaveLength(1);
  });

  it("is kept against a Withings row of the same value and time", async () => {
    const { result, rows } = await runAgainst(
      { value: 80.4, at: "2026-05-14T06:00:00.000Z", source: "WITHINGS" },
      { value: 80.4, at: "" },
    );
    expect(rows).toHaveLength(1);
    expect(result.writtenByHealthLog.matchedManual).toBe(0);
  });
});
