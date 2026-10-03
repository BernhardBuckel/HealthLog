/**
 * The login page's transport notice (#1097): the blocked banner names both
 * operator fixes, the localhost note is soft, and "ok" renders nothing.
 * Mutation check: render the banner for `soft` and the second case goes red.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import { InsecureTransportBanner } from "@/components/auth/insecure-transport-banner";
import type { TransportVerdict } from "@/lib/auth/client-transport";

function render(verdict: TransportVerdict, locale: "en" | "de" = "en") {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>
      <InsecureTransportBanner verdict={verdict} />
    </I18nProvider>,
  );
}

describe("InsecureTransportBanner", () => {
  it("blocked: an alert naming SESSION_COOKIE_SECURE and https", () => {
    const html = render("blocked");
    expect(html).toContain('data-testid="insecure-transport-banner"');
    expect(html).toContain('role="alert"');
    expect(html).toContain("SESSION_COOKIE_SECURE=false");
    expect(html).toContain("https://");
  });

  it("soft: a note on localhost, no alert", () => {
    const html = render("soft");
    expect(html).toContain('data-testid="insecure-transport-note"');
    expect(html).not.toContain('role="alert"');
  });

  it("ok: nothing", () => {
    expect(render("ok")).toBe("");
  });

  it("speaks German", () => {
    expect(render("blocked", "de")).toContain("https://");
    expect(render("blocked", "de")).not.toContain(
      "This server only sets its sign-in cookie",
    );
  });
});
