import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";

/**
 * v1.38.19 — the day's spend, split by who paid for it.
 *
 * `/api/admin/provider-health` answers `spendToday` and nothing rendered it,
 * which is the "the reader is the follow-up" shape the two-ended rule exists to
 * stop. It is also the one screen that answers the question a budget refusal
 * raises: a day at 1.24 M tokens is alarming until you can see that 151 200 of
 * them were the instance's own key and the rest ran on the users' own plans —
 * and it is the second figure the operator ceiling is enforced against.
 */

const mockQueryState = vi.hoisted(() => ({
  data: null as null | object,
  isPending: false,
  isError: false,
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({
    data: mockQueryState.data,
    isPending: mockQueryState.isPending,
    isError: mockQueryState.isError,
  }),
}));

import { ProviderHealthSection } from "../provider-health-section";

function render(data: object | null) {
  mockQueryState.data = data;
  mockQueryState.isPending = false;
  mockQueryState.isError = false;
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <ProviderHealthSection />
    </I18nProvider>,
  );
}

describe("<ProviderHealthSection> — today's spend by cost owner", () => {
  it("shows both figures, the account count, and which day they count", () => {
    const html = render({
      providers: [],
      spendToday: {
        totalTokens: 1_240_000,
        operatorTokens: 151_200,
        accounts: 3,
      },
    });
    expect(html).toContain("1,240,000");
    expect(html).toContain("151,200");
    expect(html).toContain("accounts with spend: 3");
    // Each account's own day, not one date for the whole instance.
    expect(html).toContain("each account&#x27;s own calendar day");
  });

  it("renders a zero day rather than hiding the readout", () => {
    const html = render({
      providers: [],
      spendToday: { totalTokens: 0, operatorTokens: 0, accounts: 0 },
    });
    expect(html).toContain('data-slot="ai-spend-today"');
  });

  it("says nothing when the payload carries no spend", () => {
    expect(render({ providers: [] })).not.toContain(
      'data-slot="ai-spend-today"',
    );
  });
});
