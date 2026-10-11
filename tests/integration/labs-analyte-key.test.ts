/**
 * A marker is linked to its analyte, once, and the link is never overwritten.
 *
 * `Biomarker.analyteKey` says which analyte a marker is, so a reading in another
 * unit can be converted (#1095). It is set when a marker is created, by all
 * three creation paths, and, for a marker that already exists, the first time
 * it is needed. Against a real Postgres:
 *   - a marker created by name is linked when the name is a known analyte and
 *     its unit is one the analyte reaches, and left null otherwise;
 *   - the key reaches the API response;
 *   - `ensureAnalyteKey` fills a null key once and never replaces a key that is
 *     set, even by a different match, and two concurrent calls converge;
 *   - the mint path used by the lab writes and the legacy backfill set it too.
 */
import { NextRequest } from "next/server";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { cookieJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";
import { runLabBiomarkerBackfillForUser } from "@/lib/jobs/lab-biomarker-backfill";
import { ensureAnalyteKey } from "@/lib/labs/analyte-key-store";
import { resolveOrMintBiomarker } from "@/lib/labs/biomarker-store";

vi.mock("next/headers", async () => {
  const { cookieJar, headerJar } = await import("./mock-next-headers");
  return {
    headers: vi.fn(async () => ({
      get: (name: string) => headerJar.get(name.toLowerCase()) ?? null,
    })),
    cookies: vi.fn(async () => ({
      get: (name: string) => {
        const value = cookieJar.get(name);
        return value ? { name, value } : undefined;
      },
      set: (name: string, value: string) => cookieJar.set(name, value),
      delete: (name: string) => cookieJar.delete(name),
    })),
  };
});

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

const prisma = getPrismaClient();
const USER = "analyte-key-user";

beforeAll(async () => {
  await truncateAllTables(prisma);
  await prisma.user.create({ data: { id: USER, username: USER } });
});

async function post(body: Record<string, unknown>) {
  const s = await prisma.session.create({
    data: { userId: USER, expiresAt: new Date(Date.now() + 3_600_000) },
  });
  cookieJar.clear();
  cookieJar.set("healthlog_session", s.id);
  const { POST } = await import("@/app/api/biomarkers/route");
  return POST(
    new NextRequest("http://localhost/api/biomarkers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

describe("POST /api/biomarkers", () => {
  it("links a marker whose name is a known analyte, and returns the key", async () => {
    const res = await post({ name: "Blutzucker", unit: "mg/dL" });
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: { analyteKey: string } };
    expect(data.analyteKey).toBe("fasting-glucose");
    const row = await prisma.biomarker.findFirst({
      where: { userId: USER, name: "Blutzucker" },
    });
    expect(row?.analyteKey).toBe("fasting-glucose");
  });

  it("links a catalog seed by its localised name", async () => {
    const res = await post({ name: "Gesamtcholesterin", unit: "mg/dL" });
    const { data } = (await res.json()) as { data: { analyteKey: string } };
    expect(data.analyteKey).toBe("total-cholesterol");
  });

  it("leaves a free name, and a known name in an unreachable unit, unlinked", async () => {
    for (const [name, unit] of [
      ["My own marker", "mg/dL"],
      ["Glucose", "mEq/L"],
      ["Calcium (ionisiert)", "mmol/L"],
    ]) {
      const res = await post({ name, unit });
      expect(res.status).toBe(201);
      const { data } = (await res.json()) as {
        data: { analyteKey: string | null };
      };
      expect(data.analyteKey, name).toBeNull();
    }
  });
});

describe("ensureAnalyteKey", () => {
  it("fills a null key once", async () => {
    const marker = await prisma.biomarker.create({
      data: { userId: USER, name: "Harnsäure", unit: "µmol/L" },
    });
    expect(marker.analyteKey).toBeNull();
    expect(await ensureAnalyteKey(prisma, marker)).toBe("uric-acid");
    expect(
      (await prisma.biomarker.findUnique({ where: { id: marker.id } }))
        ?.analyteKey,
    ).toBe("uric-acid");
  });

  it("never replaces a key that is set, even when the name would match another", async () => {
    const marker = await prisma.biomarker.create({
      data: {
        userId: USER,
        name: "Blood glucose",
        unit: "mg/dL",
        analyteKey: "hba1c",
      },
    });
    // The caller read the row with the key set.
    expect(await ensureAnalyteKey(prisma, marker)).toBe("hba1c");
    // A caller holding a stale copy with a null key does not overwrite either.
    expect(
      await ensureAnalyteKey(prisma, { ...marker, analyteKey: null }),
    ).toBe("hba1c");
    expect(
      (await prisma.biomarker.findUnique({ where: { id: marker.id } }))
        ?.analyteKey,
    ).toBe("hba1c");
  });

  it("converges when two callers fill the same marker", async () => {
    const marker = await prisma.biomarker.create({
      data: { userId: USER, name: "Kreatinin", unit: "mg/dL" },
    });
    const [a, b] = await Promise.all([
      ensureAnalyteKey(prisma, marker),
      ensureAnalyteKey(prisma, marker),
    ]);
    expect(a).toBe("creatinine");
    expect(b).toBe("creatinine");
  });

  it("leaves a marker with no analyte null", async () => {
    const marker = await prisma.biomarker.create({
      data: { userId: USER, name: "Ferritin", unit: "ng/mL" },
    });
    expect(await ensureAnalyteKey(prisma, marker)).toBeNull();
  });
});

describe("the other creation paths", () => {
  it("links a marker minted by a lab write", async () => {
    const minted = await resolveOrMintBiomarker(USER, {
      analyte: "Gesamtbilirubin",
      unit: "µmol/L",
      referenceLow: null,
      referenceHigh: null,
      panel: null,
    });
    const row = await prisma.biomarker.findUnique({ where: { id: minted.id } });
    expect(row?.analyteKey).toBe("bilirubin-total");
  });

  it("links a marker the legacy backfill mints", async () => {
    await prisma.labResult.create({
      data: {
        userId: USER,
        analyte: "Kalzium",
        value: 2.4,
        unit: "mmol/L",
        takenAt: new Date("2026-05-01T08:00:00Z"),
        source: "MANUAL",
      },
    });
    await runLabBiomarkerBackfillForUser(USER);
    const row = await prisma.biomarker.findFirst({
      where: { userId: USER, name: "Kalzium" },
    });
    expect(row?.analyteKey).toBe("calcium-total");
  });
});
