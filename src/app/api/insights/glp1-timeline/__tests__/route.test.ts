/**
 * `GET /api/insights/glp1-timeline` — the reported surface.
 *
 * A side-effect day was assembled by matching the stored mood tag against a
 * hand-written English/German word list. Tap the nausea chip with the UI in
 * French, Spanish, Italian or Polish and the day never appeared on the
 * timeline: a thinner therapy history, with nothing anywhere saying why.
 *
 * The property asserted here is equality, not presence — a tag recorded in any
 * shipped locale contributes exactly what the English one does.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  medicationFindMany: vi.fn(),
  moodFindMany: vi.fn(),
  annotate: vi.fn(),
}));

vi.mock("@/lib/api-handler", () => ({
  apiHandler: (handler: unknown) => handler,
  requireRecordAuth: vi.fn(async () => ({
    user: { id: "user-1" },
    actor: { id: "user-1" },
    grantId: null,
  })),
}));
vi.mock("@/lib/logging/context", () => ({ annotate: mocks.annotate }));
vi.mock("@/lib/db", () => ({
  prisma: {
    medication: { findMany: mocks.medicationFindMany },
    moodEntry: { findMany: mocks.moodFindMany },
  },
}));

import { GET } from "../route";

const handler = GET as unknown as (req: NextRequest) => Promise<Response>;

function request(): NextRequest {
  return new NextRequest("http://localhost/api/insights/glp1-timeline");
}

/** One GLP-1 medication with no events of its own, so only mood days show. */
function medication() {
  return {
    name: "Mounjaro",
    doseChanges: [],
    intakeEvents: [],
    inventoryEvents: [],
  };
}

function moodDay(day: number, tags: string[]) {
  return {
    date: `2026-04-${String(day).padStart(2, "0")}`,
    moodLoggedAt: new Date(Date.UTC(2026, 3, day, 9, 0, 0)),
    tags: JSON.stringify(tags),
  };
}

interface TimelineBody {
  data: {
    hasGlp1: boolean;
    entries: Array<{ date: string; kind: string; tags?: string[] }>;
  };
}

async function timeline(moods: ReturnType<typeof moodDay>[]) {
  mocks.medicationFindMany.mockResolvedValue([medication()]);
  mocks.moodFindMany.mockResolvedValue(moods);
  const res = await handler(request());
  const body = (await res.json()) as TimelineBody;
  return body.data;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/insights/glp1-timeline side-effect days", () => {
  it("builds the same timeline from a French record as from an English one", async () => {
    const en = await timeline([
      moodDay(10, ["nausea"]),
      moodDay(11, ["headache", "fatigue"]),
    ]);
    const fr = await timeline([
      moodDay(10, ["Nausées"]),
      moodDay(11, ["Maux de tête", "Fatigue"]),
    ]);
    expect(fr).toEqual(en);
    expect(fr.entries).toEqual([
      {
        date: "2026-04-11T12:00:00Z",
        kind: "side-effect",
        tags: ["headache", "fatigue"],
      },
      { date: "2026-04-10T12:00:00Z", kind: "side-effect", tags: ["nausea"] },
    ]);
  });

  it("files a side effect under the entry's own day, not its UTC day", async () => {
    // Logged 2026-04-10 at 20:00 in Los Angeles: already the 11th in UTC.
    const out = await timeline([
      {
        date: "2026-04-10",
        moodLoggedAt: new Date("2026-04-11T03:00:00.000Z"),
        tags: JSON.stringify(["nausea"]),
      },
    ]);
    expect(out.entries).toEqual([
      { date: "2026-04-10T12:00:00Z", kind: "side-effect", tags: ["nausea"] },
    ]);
  });

  it("recognises the chip label of every shipped locale", async () => {
    const out = await timeline([
      moodDay(10, ["Übelkeit"]),
      moodDay(11, ["Estreñimiento"]),
      moodDay(12, ["Stitichezza"]),
      moodDay(13, ["Zgaga"]),
      moodDay(14, ["Perte d’appétit"]),
    ]);
    expect(out.entries.map((e) => e.tags)).toEqual([
      ["appetite-loss"],
      ["heartburn"],
      ["constipation"],
      ["constipation"],
      ["nausea"],
    ]);
  });

  it("emits the catalogue key, not the string the entry was written with", async () => {
    // The stored column mixes languages as soon as an account switches UI
    // locale. A key renders in the reader's language; a stored label renders
    // in whichever one the writer happened to be using.
    const out = await timeline([moodDay(10, ["Nudności", "Übelkeit"])]);
    expect(out.entries[0].tags).toEqual(["nausea"]);
  });

  it("leaves free-text mood tags off the therapy timeline", async () => {
    const out = await timeline([moodDay(10, ["gym", "date night"])]);
    expect(out.entries).toEqual([]);
  });

  it("counts what it could not classify on the wide event", async () => {
    // Not dropped without trace: the miss rate stays answerable from a
    // dashboard, while the tag text — the user's own prose — stays in the
    // database.
    await timeline([moodDay(10, ["Nudności", "siłownia", "rodzina"])]);
    expect(mocks.annotate).toHaveBeenCalledWith({
      action: { name: "insights.glp1-timeline.read" },
      meta: { side_effect_days: 1, unresolved_mood_tags: 2 },
    });
  });
});
