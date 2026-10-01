/**
 * The environment settings default their date fields to today. "Today" is
 * the user's day: the UTC day was yesterday west of UTC in the evening and
 * tomorrow east of it in the small hours.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { I18nProvider } from "@/lib/i18n/context";

const auth = vi.hoisted(() => ({ timezone: "America/Los_Angeles" }));
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: { timezone: auth.timezone, modules: { environment: true } },
    isAuthenticated: true,
  }),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/settings/environment",
  useSearchParams: () => new URLSearchParams(""),
}));

import { EnvironmentSection } from "../environment-section";

function backfillEnd(): string | undefined {
  const client = new QueryClient({ defaultOptions: { queries: { retry: 0 } } });
  const html = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <I18nProvider initialLocale="en">
        <EnvironmentSection />
      </I18nProvider>
    </QueryClientProvider>,
  );
  return /id="env-backfill-end"[^>]*value="([^"]*)"/.exec(html)?.[1];
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("<EnvironmentSection> date defaults", () => {
  it("defaults to the user's day west of UTC", () => {
    auth.timezone = "America/Los_Angeles";
    vi.setSystemTime(new Date("2026-07-03T03:00:00.000Z")); // 2 July, 20:00
    expect(backfillEnd()).toBe("2026-07-02");
  });

  it("defaults to the user's day east of UTC", () => {
    auth.timezone = "Pacific/Kiritimati";
    vi.setSystemTime(new Date("2026-07-02T12:00:00.000Z")); // 3 July, 02:00
    expect(backfillEnd()).toBe("2026-07-03");
  });
});
