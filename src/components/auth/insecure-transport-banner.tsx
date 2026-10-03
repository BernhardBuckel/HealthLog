"use client";

/**
 * Login-page notice for a page whose session cookie cannot stick (#1097).
 *
 * `blocked`: the server sets its sign-in cookie only over https:// and this
 * page is plain http:// on a network address. The browser would drop the
 * cookie, so the sign-in controls are disabled and the two operator fixes are
 * named. `soft`: the same on localhost, where most browsers accept the cookie;
 * the form stays usable.
 */

import { useSyncExternalStore } from "react";
import { TriangleAlert } from "lucide-react";
import { useTranslations } from "@/lib/i18n/context";
import type {
  ClientTransport,
  TransportVerdict,
} from "@/lib/auth/client-transport";

const noopSubscribe = () => () => {};

/**
 * The page's transport, read after hydration only (the server render has no
 * `location`), so the first client render matches the server HTML.
 */
export function useClientTransport(): ClientTransport | undefined {
  const raw = useSyncExternalStore(
    noopSubscribe,
    () => `${window.location.protocol}//${window.location.host}`,
    () => null,
  );
  if (!raw) return undefined;
  const [scheme, host] = raw.split("//");
  return { protocol: scheme === "https:" ? "https" : "http", host };
}

export function InsecureTransportBanner({
  verdict,
}: {
  verdict: TransportVerdict;
}) {
  const { t } = useTranslations();
  if (verdict === "ok") return null;
  if (verdict === "soft") {
    return (
      <p
        data-testid="insecure-transport-note"
        className="text-muted-foreground rounded-lg border p-3 text-xs"
      >
        {t("auth.insecureTransport.localhostNote")}
      </p>
    );
  }
  return (
    <div
      role="alert"
      data-testid="insecure-transport-banner"
      className="border-warning/40 bg-warning/10 space-y-2 rounded-lg border p-3 text-sm"
    >
      <p className="flex items-start gap-2 font-semibold">
        <TriangleAlert
          className="text-warning mt-0.5 h-4 w-4 shrink-0"
          aria-hidden="true"
        />
        {t("auth.insecureTransport.title")}
      </p>
      <p>{t("auth.insecureTransport.body")}</p>
      <ul className="list-disc space-y-1 ps-5">
        <li>{t("auth.insecureTransport.fixLan")}</li>
        <li>{t("auth.insecureTransport.fixHttps")}</li>
      </ul>
    </div>
  );
}
