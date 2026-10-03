/**
 * The cycle sheet's "add a custom symptom" popover offers the same icon
 * picker as the symptoms feature, and must look and behave the same: 44 px
 * targets on a phone, 36 px from `sm`, a translated name per icon.
 *
 * The popover portals and portals do not render server-side, so it is
 * replaced by pass-through wrappers; what is measured is the picker inside.
 *
 * Mutation check (run, seen red): put the cycle sheet's own inline picker
 * back (`size-7`, `aria-label={name}`) → this test goes red.
 */
import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: ReactNode }) => <>{children}</>,
  PopoverTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
}));

vi.mock("../use-cycle", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../use-cycle")>()),
  useCreateCustomSymptom: () => ({
    mutateAsync: vi.fn(),
    reset: vi.fn(),
    isPending: false,
    isError: false,
    error: null,
  }),
}));

import { CUSTOM_SYMPTOM_ICON_ALLOWLIST } from "@/lib/cycle/custom-symptoms-shared";
import { I18nProvider } from "@/lib/i18n/context";
import { AddSymptomChip } from "../log-day-sheet";

describe("cycle custom-symptom icon picker", () => {
  it("has 44 px targets on a phone and translated icon names", () => {
    const html = renderToStaticMarkup(
      <I18nProvider initialLocale="de">
        <AddSymptomChip onCreated={() => {}} />
      </I18nProvider>,
    );
    const buttons = html.match(/<button[^>]*role="radio"[^>]*>/g) ?? [];
    expect(buttons).toHaveLength(CUSTOM_SYMPTOM_ICON_ALLOWLIST.length);
    for (const button of buttons) {
      expect(button).toContain("size-11");
      expect(button).toContain("sm:size-9");
      expect(button).not.toMatch(/\bsize-7\b/);
    }
    expect(html).toContain('aria-label="Herzschlag"');
    expect(html).not.toContain('aria-label="HeartPulse"');
  });
});
