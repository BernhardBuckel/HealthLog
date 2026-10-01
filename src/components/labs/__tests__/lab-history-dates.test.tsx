import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { makeFormatters } from "@/lib/format-locale";
import { I18nProvider } from "@/lib/i18n/context";
import type { LabResultDto } from "../types";

/**
 * A reading imported from a report that states only its date is stored at
 * 12:00 UTC. Formatted in the reader's zone it read as the next day from
 * UTC+12 to UTC+14. A reading typed with its time of day is an instant and
 * keeps reading in the reader's zone.
 *
 * Server rendering cannot see the reader's profile zone, so the test hands
 * it over the two ways the app reads it: the formatter hook and the
 * mirrored zone the legacy helpers read.
 */
const zone = vi.hoisted(() => ({ current: "UTC" }));

vi.mock("@/lib/timezone-mirror", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/timezone-mirror")>()),
  readStoredTimezone: () => zone.current,
}));
vi.mock("@/lib/i18n/context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/i18n/context")>();
  return {
    ...actual,
    useFormatters: () => makeFormatters("en", zone.current, "AUTO", "AUTO"),
  };
});
vi.mock("@/lib/api/api-fetch", () => ({
  apiGet: () => new Promise(() => {}),
  apiDelete: vi.fn(),
  apiPost: vi.fn(),
  apiPut: vi.fn(),
}));

const { LabHistoryList } = await import("../lab-history-list");

function reading(id: string, takenAt: string): LabResultDto {
  return {
    id,
    biomarkerId: "bm-1",
    panel: null,
    analyte: "TSH",
    value: 1.8,
    valueText: null,
    unit: "mIU/L",
    referenceLow: 0.4,
    referenceHigh: 4,
    catalogReferenceLow: 0.4,
    catalogReferenceHigh: 4,
    sourceReferenceLow: null,
    sourceReferenceHigh: null,
    sourceReferenceText: null,
    referenceOrigin: "catalog",
    referenceDivergesFromCatalog: false,
    takenAt,
    source: "MANUAL",
    hasNote: false,
    rangeStatus: "in-range",
    createdAt: takenAt,
    updatedAt: takenAt,
  } as LabResultDto;
}

function render(readings: LabResultDto[]) {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <I18nProvider initialLocale="en">
        <LabHistoryList readings={readings} />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

const previousTz = process.env.TZ;

describe("lab reading dates across zones", () => {
  afterEach(() => {
    process.env.TZ = previousTz;
    zone.current = "UTC";
  });

  describe.each(["Pacific/Kiritimati", "America/Los_Angeles"])(
    "in %s",
    (tz) => {
      beforeEach(() => {
        process.env.TZ = tz;
        zone.current = tz;
      });

      it("shows a date-only reading on its stated date", () => {
        const html = render([reading("r1", "2025-10-04T12:00:00.000Z")]);
        expect(html).toContain("10/04/2025");
        expect(html).not.toContain("10/05/2025");
        expect(html).not.toContain("10/03/2025");
      });
    },
  );

  it("dates a reading typed with its time of day in the reader's zone", () => {
    // 20:30 UTC on 4 October is 10:30 on 5 October in Kiritimati.
    process.env.TZ = "Pacific/Kiritimati";
    zone.current = "Pacific/Kiritimati";
    const html = render([reading("r1", "2025-10-04T20:30:00.000Z")]);
    expect(html).toContain("10/05/2025");
  });
});
