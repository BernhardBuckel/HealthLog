import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { I18nProvider } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import type { LabResultDto, LabResultListResponse } from "../types";

/**
 * Every row of the compact list is five grid cells from `lg` up. The range
 * badge renders nothing for a reading without a reference range, so without
 * its own cell the range bar and the trend slid one column to the left on
 * exactly those rows.
 */

vi.mock("@/lib/api/api-fetch", () => ({
  apiGet: () => new Promise(() => {}),
  apiDelete: vi.fn(),
}));

import { LabList } from "../lab-list";

function reading(over: Partial<LabResultDto>): LabResultDto {
  return {
    id: "r1",
    biomarkerId: "b1",
    panel: null,
    analyte: "Ferritin",
    value: 80,
    valueText: null,
    unit: "ng/mL",
    referenceLow: 30,
    referenceHigh: 400,
    catalogReferenceLow: 30,
    catalogReferenceHigh: 400,
    sourceReferenceLow: null,
    sourceReferenceHigh: null,
    sourceReferenceText: null,
    referenceOrigin: "catalog",
    referenceDivergesFromCatalog: false,
    takenAt: "2026-09-01T12:00:00.000Z",
    source: "MANUAL",
    hasNote: false,
    rangeStatus: "in_range",
    createdAt: "2026-09-01T12:00:00.000Z",
    updatedAt: "2026-09-01T12:00:00.000Z",
    ...over,
  } as LabResultDto;
}

function renderList(results: LabResultDto[]) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  const data: LabResultListResponse = {
    results,
    meta: { total: results.length, limit: 500, offset: 0 },
  };
  queryClient.setQueryData(
    queryKeys.labResultsList({
      biomarkerId: undefined,
      analyte: undefined,
      panel: undefined,
      from: undefined,
      to: undefined,
      page: 0,
      sortDir: "desc",
    }),
    data,
  );
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <I18nProvider initialLocale="en">
        <LabList />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

function count(html: string, needle: string): number {
  return html.split(needle).length - 1;
}

describe("<LabList> columns", () => {
  it("gives the badge its own cell even when a reading has no reference range", () => {
    const html = renderList([
      reading({ id: "a", biomarkerId: "b1", analyte: "Ferritin" }),
      reading({
        id: "b",
        biomarkerId: "b2",
        analyte: "Lipoprotein (a)",
        referenceLow: null,
        referenceHigh: null,
        catalogReferenceLow: null,
        catalogReferenceHigh: null,
        rangeStatus: "unknown",
      }),
    ]);
    expect(count(html, 'href="/labs/')).toBe(2);
    // One cell per row, rendered even where the badge itself renders nothing.
    expect(count(html, 'data-slot="lab-list-badge-cell"')).toBe(2);
    expect(html).toMatch(/<div data-slot="lab-list-badge-cell"[^>]*><\/div>/);
  });

  it("hides the chevron from lg up and keeps it on a phone", () => {
    const html = renderList([reading({})]);
    expect(html).toMatch(/class="[^"]*lucide-chevron-right[^"]*lg:invisible/);
  });
});
