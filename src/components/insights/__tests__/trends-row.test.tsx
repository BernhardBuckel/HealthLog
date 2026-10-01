import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@/lib/i18n/context";

/**
 * v1.4.20 phase B3 — `<TrendsRow>` mounts three small charts (BP /
 * weight / mood) and an annotation under each.
 *
 * Recharts is dynamic-imported behind `next/dynamic`, so SSR
 * snapshots show the loading skeleton — that's still enough to verify
 * the row's layout chrome (3-up grid wrapper + per-metric annotation
 * slots).
 *
 * v1.4.25 W7 added a `useAuth()` call inside `<TrendsRow>` to plumb
 * `userTimezone` through to the dynamically-imported chart components,
 * so the test wraps every render in a TanStack-Query provider — the
 * stub charts never trigger an actual fetch but `useAuth` requires a
 * client to mount.
 */

vi.mock("next/dynamic", () => ({
  default: () => {
    const Stub = ({
      title,
      unit,
      valueScale,
      valueOffset,
    }: {
      title?: string;
      unit?: string;
      valueScale?: number;
      valueOffset?: number;
    }) => (
      <div
        data-slot="trends-row-chart-stub"
        data-unit={unit}
        data-scale={valueScale}
        data-offset={valueOffset}
      >
        {title ?? "chart"}
      </div>
    );
    Stub.displayName = "TrendsRowChartStub";
    return Stub;
  },
}));

const account = vi.hoisted(() => ({
  user: null as Record<string, unknown> | null,
}));
vi.mock("@/hooks/use-auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/use-auth")>()),
  useAuth: () => ({ user: account.user, isAuthenticated: true }),
  useAccountOnceMounted: () => account.user,
}));

import { TrendsRow } from "../trends-row";
import type { DailyBriefing } from "@/lib/ai/schema";

function briefing(
  metrics: DailyBriefing["keyFindings"][number]["sourceMetric"][],
): DailyBriefing {
  return {
    paragraph: "Synthesised briefing paragraph.",
    keyFindings: metrics.map((sourceMetric) => ({
      tone: "watch" as const,
      headline: `${sourceMetric} headline`,
      detail: `${sourceMetric} detail`,
      delta: null,
      sourceWindow: "30d" as const,
      sourceMetric,
    })),
  };
}

function render(node: React.ReactNode, locale: "en" | "de" = "en") {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <I18nProvider initialLocale={locale}>{node}</I18nProvider>
    </QueryClientProvider>,
  );
}

describe("<TrendsRow>", () => {
  it("renders the row title in English", () => {
    const html = render(<TrendsRow />);
    expect(html).toMatch(/data-slot="trends-row"/);
    expect(html).toContain("Trends");
  });

  it("renders the row title in German", () => {
    const html = render(<TrendsRow />, "de");
    expect(html).toContain("Trends");
  });

  it("mounts a card per metric (BP / weight / mood)", () => {
    const html = render(<TrendsRow />);
    expect(html).toMatch(/data-metric="bp"/);
    expect(html).toMatch(/data-metric="weight"/);
    expect(html).toMatch(/data-metric="mood"/);
  });

  it("renders a 3-up grid layout", () => {
    const html = render(<TrendsRow />);
    expect(html).toMatch(/md:grid-cols-3/);
    expect(html).toMatch(/grid-cols-1/);
  });

  // ── v1.4.28 R3c-Insights — equal-height contract (FB-K1/K2) ───────
  it("pins the row container to `auto-rows-fr` so every cell sits on the same row track", () => {
    // Per Inv-3 the row already used `md:auto-rows-fr`. v1.4.28 lifts
    // the modifier so the single-column path on phone-class viewports
    // honours the same template. The class is load-bearing for the
    // 3-slot tile contract — if a future refactor drops it the rows
    // start collapsing on long annotations again.
    const html = render(<TrendsRow />);
    expect(html).toMatch(/\bauto-rows-fr\b/);
  });

  it("wraps each chart in a fixed-height chart slot (FB-K1 mood-tile alignment)", () => {
    // The chart slot is the visible "where does the chart series
    // start" landmark across BP / weight / mood. Wrapping the chart
    // in `trends-row-chart-slot` lets us pin the chart-envelope
    // height in one place instead of bleeding chart-component
    // padding through the row.
    const html = render(<TrendsRow />);
    const slots = html.match(/data-slot="trends-row-chart-slot"/g) ?? [];
    expect(slots.length).toBe(3);
  });

  it("pins every chart slot to a known responsive height so Recharts mounts with a size (CLS fix)", () => {
    // v1.4.36 W2 — without an explicit height the Recharts
    // ResponsiveContainer mounts with width=-1 height=-1 and emits a
    // console warning per chart. The mood card also drifted taller
    // than BP / weight on hydration.
    //
    // v1.5.4.x — wrapper raised from 140 to 180 px. The 140 px slot
    // matched the chart's internal painting area, but the mini-mode
    // card shell adds ~34 px of header + padding above it. The
    // resulting overflow pushed the chart envelope down into the
    // TrendAnnotation row below — visible as text sitting on top of
    // the chart. 180 px absorbs the full envelope so the three tiles
    // share one chart-band baseline without overlap.
    //
    // v1.22.0 — the slot height became `clamp(140px,32vh,180px)` so a
    // rotated phone doesn't lose half the screen to the fixed band. The
    // 180 px envelope still holds on desktop + portrait (where 32vh
    // clears 180 px); only short landscape viewports shrink to the floor.
    const html = render(<TrendsRow />);
    const slots =
      html.match(/data-slot="trends-row-chart-slot"[^>]*class="[^"]*"/g) ?? [];
    expect(slots.length).toBe(3);
    for (const slot of slots) {
      expect(slot).toMatch(/h-\[clamp\(140px,32vh,180px\)\]/);
    }
  });

  it("bounds the chart slot so the mood card's axis labels stay contained (item I)", () => {
    // v1.11.4 item I — the mood mini chart is a `<Card>` (extra header
    // + padding chrome) wrapping a categorical y-axis + a date x-axis;
    // its tick labels used to bleed past the 180 px envelope and
    // overlap the caption below. The slot now (a) clips with
    // `overflow-hidden` so nothing escapes the envelope and (b) drives
    // both mini charts' internal band down to 120 px via
    // `[--chart-height:120px]` so the mood card's full envelope
    // (band + header + axis labels) fits inside 180 px and the three
    // tiles share one chart-band baseline.
    const html = render(<TrendsRow />);
    const slots =
      html.match(/data-slot="trends-row-chart-slot"[^>]*class="[^"]*"/g) ?? [];
    expect(slots.length).toBe(3);
    for (const slot of slots) {
      expect(slot).toMatch(/overflow-hidden/);
      expect(slot).toMatch(/\[--chart-height:120px\]/);
    }
  });

  it("renders annotations when supplied", () => {
    const html = render(
      <TrendsRow
        annotations={{
          bp: "BP trending down — a pattern worth watching.",
          weight: "Weight down 1.4 kg over 30 days.",
          mood: "Mood stable, scoring 4 of 5 most days.",
        }}
      />,
    );
    expect(html).toContain("BP trending down");
    expect(html).toContain("Weight down 1.4 kg");
    expect(html).toContain("Mood stable");
  });

  it("renders the empty-state hint when annotations are absent", () => {
    const html = render(<TrendsRow />);
    expect(html).toContain("Awaiting more data");
    // All three metric slots show the hint when nothing is supplied.
    const matches = html.match(/Awaiting more data/g) ?? [];
    expect(matches.length).toBe(3);
  });

  it("loading=true paints the pending shimmer for every metric (no 'mehr Daten' flash)", () => {
    // v1.4.36 W2 T3 — pre-fix the row painted "Awaiting more data"
    // across all three metrics whenever the advisor query was in
    // flight. The loading flag now propagates to each annotation
    // slot so the user reads a generating-state shimmer instead.
    const html = render(<TrendsRow loading />);
    const pending = html.match(/data-slot="trend-annotation-pending"/g) ?? [];
    expect(pending.length).toBe(3);
    expect(html).not.toContain("Awaiting more data");
  });

  it("loading=true keeps the shimmer even when annotations are supplied (regenerate-in-flight)", () => {
    const html = render(
      <TrendsRow
        loading
        annotations={{
          bp: "stale BP",
          weight: "stale weight",
          mood: "stale mood",
        }}
      />,
    );
    expect(html).not.toContain("stale BP");
    expect(html).not.toContain("stale weight");
    expect(html).not.toContain("stale mood");
    const pending = html.match(/data-slot="trend-annotation-pending"/g) ?? [];
    expect(pending.length).toBe(3);
  });

  // ── v1.8.5 — dynamic chart set driven by the daily briefing ───────
  it("charts the metrics the briefing flags, in briefing order", () => {
    const html = render(
      <TrendsRow briefing={briefing(["weight", "pulse", "sleep"])} />,
    );
    expect(html).toMatch(/data-metric="weight"/);
    expect(html).toMatch(/data-metric="pulse"/);
    expect(html).toMatch(/data-metric="sleep"/);
    // The default BP / mood tiles drop out when the briefing flags
    // other metrics.
    expect(html).not.toMatch(/data-metric="bp"/);
    expect(html).not.toMatch(/data-metric="mood"/);
  });

  it("caps the briefing-driven set at three tiles", () => {
    const html = render(
      <TrendsRow
        briefing={briefing(["weight", "pulse", "sleep", "hrv", "steps"])}
      />,
    );
    const cards = html.match(/data-slot="trends-row-card"/g) ?? [];
    expect(cards.length).toBe(3);
  });

  it("falls back to BP / weight / mood when the briefing is empty", () => {
    const html = render(<TrendsRow briefing={briefing([])} />);
    expect(html).toMatch(/data-metric="bp"/);
    expect(html).toMatch(/data-metric="weight"/);
    expect(html).toMatch(/data-metric="mood"/);
  });

  it("captions an additive metric with its standard description (no advisor annotation slot)", () => {
    // v1.8.6 W8 — additive metrics carry no advisor annotation, so the
    // tile must fall back to the metric's standard one-line caption
    // rather than painting empty space below the chart. The
    // `<TrendAnnotation>` slot is reserved for the legacy triple.
    const html = render(<TrendsRow briefing={briefing(["pulse"])} />);
    expect(html).toMatch(/data-metric="pulse"/);
    expect(html).not.toMatch(/data-slot="trend-annotation-empty"/);
    // The standard caption renders in its place.
    expect(html).toMatch(
      /data-slot="trends-row-caption"[^>]*data-metric="pulse"/,
    );
    expect(html).toContain("Resting pulse over the last 30 days.");
  });

  it("never renders a caption-less card — every briefing-driven tile carries a caption", () => {
    // Regression guard for the v1.8.5 caption-drop: a briefing that
    // flags additive metrics with no advisor annotation used to paint
    // the chart with empty space underneath. Every tile must surface
    // either a `<TrendAnnotation>` slot (legacy triple) or the
    // standard `trends-row-caption` description (additive metrics).
    const html = render(
      <TrendsRow briefing={briefing(["hrv", "steps", "distance"])} />,
    );
    const cards = html.match(/data-slot="trends-row-card"/g) ?? [];
    expect(cards.length).toBe(3);
    // None of these additive metrics carries an advisor annotation, so
    // all three captions come through the standard description slot.
    const captions = html.match(/data-slot="trends-row-caption"/g) ?? [];
    expect(captions.length).toBe(3);
    expect(html).toContain("Heart-rate variability over the last 30 days.");
    expect(html).toContain("Daily step count over the last 30 days.");
    expect(html).toContain(
      "Walking and running distance over the last 30 days.",
    );
  });

  it("propagates per-metric confidence chips", () => {
    const html = render(
      <TrendsRow
        annotations={{
          bp: "BP trending down.",
          weight: "Weight steady.",
          mood: "Mood stable.",
        }}
        confidence={{ bp: "high", weight: "moderate", mood: "low" }}
      />,
    );
    expect(html).toContain("High confidence");
    expect(html).toContain("Moderate confidence");
    expect(html).toContain("Low confidence");
  });

  // ── v1.18.6 — detail-page cross-links (the Insights→steps gap) ──────
  it("links each metric card to its detail page", () => {
    const html = render(<TrendsRow />);
    // The default BP / weight / mood triple each link to their sub-page.
    expect(html).toContain('data-slot="trends-row-detail-link"');
    expect(html).toContain('href="/insights/blood-pressure"');
    expect(html).toContain('href="/insights/weight"');
    expect(html).toContain('href="/insights/mood"');
  });

  it("offers the steps detail link when the briefing flags steps", () => {
    // Steps has a routed sub-page but the overview never linked to it; a
    // briefing finding on steps now charts it AND drills into /insights/steps.
    const html = render(<TrendsRow briefing={briefing(["steps"])} />);
    expect(html).toMatch(/data-metric="steps"/);
    expect(html).toContain('href="/insights/steps"');
  });

  it("plots a transformed slot in the reader's unit, scale and offset included", () => {
    account.user = { unitPreference: "imperial", glucoseUnit: null };
    try {
      const html = render(
        <TrendsRow briefing={briefing(["weight", "distance", "body_temp"])} />,
      );
      expect(html).toContain('data-unit="lb"');
      expect(html).toContain('data-unit="mi"');
      expect(html).toContain('data-unit="°F"');
      expect(html).toContain('data-offset="32"');
      expect(html).not.toContain('data-unit="kg"');
      expect(html).not.toContain('data-unit="km"');
    } finally {
      account.user = null;
    }
  });

  it("plots distance in kilometres, scaled from metres, for a metric reader", () => {
    const html = render(<TrendsRow briefing={briefing(["distance"])} />);
    expect(html).toContain('data-unit="km"');
    expect(html).toContain('data-scale="0.001"');
  });
});
