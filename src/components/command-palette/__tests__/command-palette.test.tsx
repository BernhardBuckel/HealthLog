import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Activity, Moon, Plus, Smile } from "lucide-react";

import { I18nProvider } from "@/lib/i18n/context";
import type { PaletteEntry } from "@/lib/command-palette/build-index";
import type { SearchResponse } from "@/lib/search/contract";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: { id: "user-1" } }),
}));
vi.mock("@/hooks/use-module-toggle", () => ({
  useModuleToggle: () => ({ mutate: vi.fn() }),
}));
vi.mock("@/lib/insights/coach-launch-context", () => ({
  useCoachLaunch: () => null,
}));
vi.mock("@/components/day/use-today-key", () => ({
  useTodayKey: () => "2026-10-09",
}));

const ENTRIES: PaletteEntry[] = [
  {
    id: "insights:sleep",
    group: "insights",
    title: "Sleep",
    hint: "Insights",
    keywords: ["schlaf"],
    icon: Moon,
    run: { kind: "href", href: "/insights/sleep" },
  },
  {
    id: "nav:/measurements",
    group: "pages",
    title: "Measurements",
    keywords: [],
    icon: Activity,
    run: { kind: "href", href: "/measurements" },
  },
  {
    id: "module:mood",
    group: "modules",
    title: "Mood",
    keywords: [],
    icon: Smile,
    run: { kind: "module", module: "mood", enabled: true },
  },
  {
    id: "action:capture",
    group: "actions",
    title: "New entry",
    keywords: [],
    icon: Plus,
    run: { kind: "action", action: "capture" },
  },
  {
    id: "action:today",
    group: "actions",
    title: "Open today",
    keywords: [],
    icon: Plus,
    run: { kind: "action", action: "today" },
  },
];

vi.mock("../use-palette-index", () => ({
  usePaletteIndex: () => ENTRIES,
}));

const recordSearch = vi.hoisted(() => ({
  state: {
    query: null as string | null,
    data: undefined as SearchResponse | undefined,
    loading: false,
    error: false,
  },
}));
vi.mock("../use-record-search", () => ({
  useRecordSearch: () => recordSearch.state,
}));

import { PaletteBody, arrangeResults } from "../command-palette";

function render(isMobile = false) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <PaletteBody isMobile={isMobile} />
    </I18nProvider>,
  );
}

describe("arrangeResults", () => {
  it("empty query: recent places first, then the main actions", () => {
    const sections = arrangeResults("", ENTRIES, ["insights:sleep", "gone"]);
    expect(sections.map((s) => s.group)).toEqual(["recent", "actions"]);
    expect(sections[0]?.entries.map((e) => e.id)).toEqual(["insights:sleep"]);
    expect(sections[1]?.entries.map((e) => e.id)).toEqual([
      "action:capture",
      "action:today",
    ]);
  });

  it("a query groups the hits in the order of each group's best hit", () => {
    const sections = arrangeResults("schlaf", ENTRIES, []);
    expect(sections.map((s) => s.group)).toEqual(["insights"]);
    // "mo": Mood is a prefix (modules), Measurements no match; "o" in
    // "Open today" is a word start (actions) and ranks below the prefix.
    const mixed = arrangeResults("mo", ENTRIES, []);
    expect(mixed.map((s) => s.group)).toEqual(["modules"]);
    const both = arrangeResults("o", ENTRIES, []);
    expect(both[0]?.entries[0]?.title).toBe("Open today");
  });

  it("no hit, no sections", () => {
    expect(arrangeResults("zzzz", ENTRIES, [])).toEqual([]);
  });
});

describe("<PaletteBody>", () => {
  it("is a combobox that controls a listbox and points at the first option", () => {
    const html = render();
    const controls = html.match(/aria-controls="([^"]+)"/)?.[1];
    expect(html).toContain('role="combobox"');
    expect(html).toContain('aria-autocomplete="list"');
    expect(controls).toBeTruthy();
    expect(html).toContain(`id="${controls}" role="listbox"`);
    const active = html.match(/aria-activedescendant="([^"]+)"/)?.[1];
    expect(html).toContain(`id="${active}" role="option" aria-selected="true"`);
  });

  it("labels its groups and the field", () => {
    const html = render();
    expect(html).toContain('role="group"');
    expect(html).toContain('aria-label="Search"');
    expect(html).toContain(
      'placeholder="Search pages, settings, your records…"',
    );
    expect(html).toContain(">Actions<");
  });

  it("shows the key hints on a desktop and a Cancel button on a phone", () => {
    expect(render(false)).toContain("Esc");
    const phone = render(true);
    expect(phone).not.toContain(">Esc<");
    expect(phone).toContain(">Cancel<");
  });
});

const HITS: SearchResponse = {
  groups: [
    {
      kind: "visit",
      more: false,
      hits: [
        {
          id: "visit:v1",
          kind: "visit",
          title: { text: "Arthroskopie", marks: [] },
          context: [{ text: "Schulter (links)", marks: [[0, 8]] }],
          snippet: null,
          day: "2026-03-02",
          path: "/checkups?visit=v1",
          source: null,
        },
      ],
    },
    {
      kind: "note",
      more: false,
      hits: [
        {
          id: "moodNote:m1",
          kind: "note",
          title: null,
          context: [],
          snippet: { text: "Die <b>SCHULTER</b> zwickt", marks: [[7, 15]] },
          day: "2026-03-05",
          path: "/mood?day=2026-03-05",
          source: "mood",
        },
      ],
    },
  ],
  truncated: true,
};

describe("<PaletteBody> in your records", () => {
  it("lists the record hits after the local results as options", () => {
    recordSearch.state = {
      query: "schulter",
      data: HITS,
      loading: false,
      error: false,
    };
    const html = render();
    expect(html).toContain('data-group="records"');
    expect(html).toContain(">In your records<");
    expect(html).toContain('data-entry="record:visit:v1"');
    expect(html).toContain('data-entry="record:moodNote:m1"');
    // After every local option.
    expect(html.indexOf('data-entry="action:today"')).toBeLessThan(
      html.indexOf('data-entry="record:visit:v1"'),
    );
    // The matched part is marked, as text.
    expect(html).toContain("<mark");
    expect(html).toContain(">Schulter</mark> (links)");
    // A note without a name is called by what it was written on.
    expect(html).toContain("Mood note");
    // Record text is never parsed as markup.
    expect(html).not.toContain("<b>");
    expect(html).toContain("&lt;b&gt;");
    expect(html).toContain("Only the most recent entries were searched.");
  });

  it("says when it is searching, and when nothing matched", () => {
    recordSearch.state = {
      query: "schulter",
      data: undefined,
      loading: true,
      error: false,
    };
    expect(render()).toContain("Searching your records…");
    recordSearch.state = {
      query: "schulter",
      data: { groups: [], truncated: false },
      loading: false,
      error: false,
    };
    expect(render()).toContain("Nothing in your records for “schulter”.");
    recordSearch.state = {
      query: "schulter",
      data: undefined,
      loading: false,
      error: true,
    };
    expect(render()).toContain("Your records could not be searched.");
  });

  it("shows nothing of the records while no search applies", () => {
    recordSearch.state = {
      query: null,
      data: undefined,
      loading: false,
      error: false,
    };
    expect(render()).not.toContain('data-group="records"');
  });
});
