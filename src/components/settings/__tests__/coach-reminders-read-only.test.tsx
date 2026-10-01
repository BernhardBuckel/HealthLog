/**
 * Stored Coach reminders stay readable and erasable with the Coach unavailable.
 *
 * A "remind me about X" note is the person's own record, like the stored facts
 * and conversations. Before v1.39 Settings → Coach mounted the reminders card
 * only while the Coach was shown, and Settings → AI never mounted it, so a
 * person whose Coach was switched off or hidden could neither read nor erase
 * what it had kept. Now:
 *
 *   - the card lists every reminder and offers delete on each, whatever the
 *     Coach's state;
 *   - keeping, resolving or dismissing one is Coach use (the PATCH route
 *     refuses it then), so those controls appear only with the Coach
 *     available;
 *   - Settings → Coach shows the card with Hide Coach on, and Settings → AI
 *     shows it through `<StoredCoachMemory>` only when reminders exist.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const coach = vi.hoisted(() => ({ available: false }));
vi.mock("@/hooks/use-ai-capability", () => ({
  useAiCapability: () => ({
    available: coach.available,
    reason: coach.available ? null : "user_disabled",
    onDeviceAllowed: false,
  }),
}));
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: {
      id: "u1",
      role: "USER",
      timezone: "Europe/Berlin",
      disableCoach: !coach.available,
      // The record's module map, which the section's gate reads.
      modules: { coach: coach.available },
    },
    isAuthenticated: true,
    isLoading: false,
    refetch: vi.fn(),
  }),
}));
vi.mock("@/hooks/use-mounted", () => ({ useMounted: () => true }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/settings/coach",
}));

import { I18nProvider } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";

import { CoachRemindersSection } from "../coach-reminders-section";
import { CoachSection } from "../coach-section";
import { StoredCoachMemory } from "../coach-memory-section";

const reminder = (id: string, status: string) => ({
  id,
  note: `note ${id}`,
  metric: null,
  triggerKind: "date",
  dueAt: null,
  contextCue: null,
  status,
  source: "extractor",
  createdAt: "2026-09-01T08:00:00.000Z",
  updatedAt: "2026-09-01T08:00:00.000Z",
});
const STORED = [
  reminder("r-proposed", "proposed"),
  reminder("r-active", "active"),
  reminder("r-surfaced", "surfaced"),
];

function render(node: React.ReactNode, reminders: unknown[]): string {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: 0, staleTime: Infinity } },
  });
  client.setQueryData(queryKeys.coachReminders(), reminders);
  client.setQueryData(queryKeys.coachFacts(), []);
  client.setQueryData(queryKeys.coachConversationHistory(""), {
    pages: [{ conversations: [], nextCursor: null }],
    pageParams: [null],
  });
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <I18nProvider initialLocale="en">{node}</I18nProvider>
    </QueryClientProvider>,
  );
}

const count = (html: string, needle: string) => html.split(needle).length - 1;

beforeEach(() => {
  // Everything is seeded; a background refetch must not reach the network.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("{}", { status: 500 })),
  );
});
afterEach(() => vi.unstubAllGlobals());

describe("<CoachRemindersSection>", () => {
  it("stays readable and erasable with the Coach unavailable", () => {
    coach.available = false;
    const html = render(<CoachRemindersSection isAuthenticated />, STORED);
    expect(count(html, 'data-testid="settings-coach-reminder"')).toBe(3);
    expect(html).toContain("note r-proposed");
    // Every reminder can be removed.
    expect(count(html, 'data-slot="coach-reminder-delete"')).toBe(3);
    // Keeping, resolving or dismissing one is Coach use and is not offered.
    expect(html).not.toContain("settings-coach-reminder-confirm");
    expect(html).not.toContain("settings-coach-reminder-done");
    expect(html).not.toContain("settings-coach-reminder-dismiss");
    expect(html).toContain("you can still read and delete your reminders");
  });

  it("offers the lifecycle controls with the Coach available", () => {
    coach.available = true;
    const html = render(<CoachRemindersSection isAuthenticated />, STORED);
    expect(html).toContain('data-testid="settings-coach-reminder-confirm"');
    expect(html).toContain('data-testid="settings-coach-reminder-done"');
    expect(html).toContain('data-testid="settings-coach-reminder-dismiss"');
    expect(count(html, 'data-slot="coach-reminder-delete"')).toBe(3);
    expect(html).not.toContain("you can still read and delete your reminders");
  });
});

describe("where the reminders show while the Coach is unavailable", () => {
  it("Settings → Coach shows them with Hide Coach on", () => {
    coach.available = false;
    const html = render(<CoachSection />, STORED);
    expect(html).toContain('data-testid="settings-coach-reminders-card"');
    expect(html).toContain("note r-active");
    // The Coach's tuning stays hidden with the Coach.
    expect(html).not.toContain('id="coach-nudge"');
  });

  it("Settings → Coach does not invite new reminders with Hide Coach on", () => {
    coach.available = false;
    const html = render(<CoachSection />, []);
    expect(html).not.toContain('data-testid="settings-coach-reminders-card"');
  });

  it("Settings → AI shows them through <StoredCoachMemory> when they exist", () => {
    coach.available = false;
    const html = render(<StoredCoachMemory isAuthenticated />, STORED);
    expect(html).toContain('data-testid="settings-coach-reminders-card"');
    expect(count(html, 'data-slot="coach-reminder-delete"')).toBe(3);
  });

  it("Settings → AI shows nothing for somebody with no stored reminders", () => {
    coach.available = false;
    expect(render(<StoredCoachMemory isAuthenticated />, [])).toBe("");
  });
});
