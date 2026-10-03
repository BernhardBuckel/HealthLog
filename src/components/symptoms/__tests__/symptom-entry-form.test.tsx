/**
 * The symptom quick-entry form (v1.40): the person's symptoms as chips with
 * the inline "add" chip beside them, the 0-10 slider, and the "during" episode
 * selector only while an episode is open.
 *
 * Mutation checks (each run, each seen red):
 *   - drop the `resolvedAt === null` filter on the episodes → "offers no
 *     episode selector when every episode is resolved" goes red;
 *   - render the add chip unconditionally → "a delegate who may log but not
 *     manage gets no add chip" goes red.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const state = vi.hoisted(() => ({
  canManage: true,
  episodes: [] as Array<{
    id: string;
    label: string;
    resolvedAt: string | null;
  }>,
}));

vi.mock("@/hooks/use-record-capabilities", () => ({
  useRecordCapabilities: () => ({
    canManageDomain: () => state.canManage,
    canWriteDomain: () => true,
  }),
  useActiveRecordName: () => null,
}));

vi.mock("@/components/illness/use-illness", () => ({
  useIllnessEpisodes: () => ({ data: state.episodes, isLoading: false }),
}));

vi.mock("../use-symptoms", () => ({
  useSymptomDefinitions: () => ({
    isLoading: false,
    data: {
      limit: 8,
      definitions: [
        {
          id: "d1",
          label: "Aura",
          icon: "Zap",
          sortOrder: 0,
          isActive: true,
          recent: { count30d: 0, maxIntensity30d: null, lastOccurredAt: null },
        },
        {
          id: "d2",
          label: "Headache",
          icon: "Brain",
          sortOrder: 1,
          isActive: true,
          recent: { count30d: 0, maxIntensity30d: null, lastOccurredAt: null },
        },
      ],
    },
  }),
  useLogSymptomEvent: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useCreateSymptomDefinition: () => ({
    mutateAsync: vi.fn(),
    reset: vi.fn(),
    isPending: false,
    isError: false,
    error: null,
  }),
}));

import { I18nProvider } from "@/lib/i18n/context";
import { SymptomEntryForm } from "../symptom-entry-form";

function render(): string {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <SymptomEntryForm />
    </I18nProvider>,
  );
}

describe("<SymptomEntryForm>", () => {
  it("lists the person's symptoms as chips, nothing chosen, with the add chip", () => {
    state.canManage = true;
    state.episodes = [];
    const html = render();
    expect(html.match(/data-testid="symptom-chip"/g)).toHaveLength(2);
    expect(html).toContain("Aura");
    expect(html).toContain("Headache");
    expect(html).not.toContain('aria-checked="true"');
    expect(html).toContain('data-testid="symptom-add-chip"');
    // The intensity is a slider on the 0-10 scale.
    expect(html).toContain('data-slot="slider-field"');
    expect(html).toContain('aria-valuemax="10"');
  });

  it("a delegate who may log but not manage gets no add chip", () => {
    state.canManage = false;
    expect(render()).not.toContain('data-testid="symptom-add-chip"');
  });

  it("offers the episode selector only while an episode is open", () => {
    state.canManage = true;
    state.episodes = [{ id: "e1", label: "Migraine", resolvedAt: null }];
    expect(render()).toContain("-episode");
  });

  it("offers no episode selector when every episode is resolved", () => {
    state.episodes = [
      { id: "e1", label: "Cold", resolvedAt: "2026-08-08T00:00:00.000Z" },
    ];
    expect(render()).not.toContain("-episode");
  });
});
