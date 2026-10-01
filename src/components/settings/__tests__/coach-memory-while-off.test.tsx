/**
 * What the Coach stored stays readable and deletable while the Coach is off.
 *
 * Coach conversations and the facts the Coach remembered are the person's
 * own records, not caches. Before v1.39 Settings → Coach hid the memory card
 * together with the Coach's tuning as soon as the Coach was hidden, and with
 * the Coach module off the whole page was out of reach, so a person could
 * neither see nor erase what had been stored. Now:
 *
 *   - Settings → Coach always shows the memory (facts and conversations),
 *     whatever `disableCoach` says;
 *   - Settings → AI shows the same cards through `<StoredCoachMemory>` while
 *     Settings → Coach is not reachable, and only when rows exist.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const authState = vi.hoisted(() => ({ disableCoach: true }));
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: {
      id: "u1",
      role: "USER",
      timezone: "Europe/Berlin",
      disableCoach: authState.disableCoach,
      // The server's module map mirrors the record's opt-out.
      modules: { coach: !authState.disableCoach },
    },
    isAuthenticated: true,
    isLoading: false,
    refetch: vi.fn(),
  }),
}));
// Past hydration: the section's own gates read the account only once
// mounted, and a static render is otherwise the pre-hydration pass, where
// every card shows and the test could not tell a gate from its absence.
vi.mock("@/hooks/use-mounted", () => ({ useMounted: () => true }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/settings/coach",
}));

import { I18nProvider } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";

import { CoachSection } from "../coach-section";
import { StoredCoachMemory } from "../coach-memory-section";

const FACT = {
  id: "fact-1",
  category: "goal",
  text: "Wants to walk to work twice a week",
  confidence: 0.9,
  createdAt: "2026-09-01T08:00:00.000Z",
};
const CONVERSATION = {
  id: "conv-1",
  title: "Morning blood pressure",
  createdAt: "2026-09-01T08:00:00.000Z",
  updatedAt: "2026-09-01T08:05:00.000Z",
  messageCount: 4,
  fenced: false,
  attachments: [],
};

type Stored = { facts: unknown[]; conversations: unknown[]; plans?: unknown[] };

const PLAN = {
  id: "plan-1",
  metric: "steps",
  ifCue: "after lunch",
  thenAction: "walk ten minutes",
  target: null,
  status: "active",
  reviewDate: null,
  sourceConversationId: null,
  createdAt: "2026-09-01T08:00:00.000Z",
  updatedAt: "2026-09-01T08:00:00.000Z",
};

function client(stored: Stored) {
  const c = new QueryClient({
    defaultOptions: { queries: { retry: 0, staleTime: Infinity } },
  });
  c.setQueryData(queryKeys.coachFacts(), stored.facts);
  c.setQueryData(queryKeys.coachConversationHistory(""), {
    pages: [{ conversations: stored.conversations, nextCursor: null }],
    pageParams: [null],
  });
  if (stored.plans)
    c.setQueryData(queryKeys.coachPlans("scope:all"), stored.plans);
  return c;
}

function render(node: React.ReactNode, stored: Stored) {
  return renderToStaticMarkup(
    <QueryClientProvider client={client(stored)}>
      <I18nProvider initialLocale="en">{node}</I18nProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  // Everything is seeded; a background refetch must not reach the network.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("{}", { status: 500 })),
  );
});
afterEach(() => vi.unstubAllGlobals());

describe("Settings → Coach keeps the Coach memory while the Coach is hidden", () => {
  it("shows the facts and the conversations with Hide Coach on", () => {
    authState.disableCoach = true;
    const html = render(<CoachSection />, {
      facts: [FACT],
      conversations: [CONVERSATION],
    });
    expect(html).toContain('data-testid="settings-coach-memory-card"');
    expect(html).toContain("Wants to walk to work twice a week");
    expect(html).toContain('data-testid="settings-coach-conversations-card"');
    expect(html).toContain("Morning blood pressure");
    // Deletable: the per-row controls are there.
    expect(html).toContain('data-slot="settings-coach-memory-forget"');
    expect(html).toContain('data-slot="settings-coach-conversation-delete"');
    // The Coach's tuning stays hidden with the Coach.
    expect(html).not.toContain('id="coach-nudge"');
  });
});

describe("<StoredCoachMemory> (Settings → AI while the Coach page is out of reach)", () => {
  it("shows what is stored, readable and deletable", () => {
    const html = render(<StoredCoachMemory isAuthenticated />, {
      facts: [FACT],
      conversations: [CONVERSATION],
    });
    expect(html).toContain('data-testid="settings-coach-memory-card"');
    expect(html).toContain('data-testid="settings-coach-conversations-card"');
    expect(html).toContain('data-slot="settings-coach-conversation-open"');
    expect(html).toContain('data-slot="settings-coach-conversation-delete"');
  });

  it("shows only the card that has rows", () => {
    const html = render(<StoredCoachMemory isAuthenticated />, {
      facts: [],
      conversations: [CONVERSATION],
    });
    expect(html).not.toContain('data-testid="settings-coach-memory-card"');
    expect(html).toContain('data-testid="settings-coach-conversations-card"');
  });

  it("renders nothing for somebody the Coach never stored anything for", () => {
    const html = render(<StoredCoachMemory isAuthenticated />, {
      facts: [],
      conversations: [],
    });
    expect(html).toBe("");
  });
});

describe("the way to /coach/plans and /coach/conversations with the Coach off", () => {
  it("links to the stored plans from Settings → AI when plans exist", () => {
    const html = render(<StoredCoachMemory isAuthenticated />, {
      facts: [],
      conversations: [],
      plans: [PLAN],
    });
    expect(html).toContain('data-testid="settings-coach-plans-card"');
    expect(html).toContain('href="/coach/plans"');
  });

  it("links to the stored plans from Settings → Coach with Hide Coach on", () => {
    authState.disableCoach = true;
    const html = render(<CoachSection />, {
      facts: [],
      conversations: [],
      plans: [PLAN],
    });
    expect(html).toContain('href="/coach/plans"');
  });

  it("shows no plans card without plans", () => {
    const html = render(<StoredCoachMemory isAuthenticated />, {
      facts: [],
      conversations: [],
      plans: [],
    });
    expect(html).not.toContain("settings-coach-plans-card");
  });

  it("links to the full conversation list from the conversations card", () => {
    const html = render(<StoredCoachMemory isAuthenticated />, {
      facts: [],
      conversations: [CONVERSATION],
    });
    expect(html).toContain('data-slot="settings-coach-conversations-open-all"');
    expect(html).toContain('href="/coach/conversations"');
  });
});
