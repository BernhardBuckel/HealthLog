/**
 * What the browser knows and the server does not: whether this page was
 * opened over https://. A `Secure` cookie only sticks on an https:// page
 * (and, in most browsers, on http://localhost). The server knows whether it
 * will issue `Secure` cookies (`shouldEmitSecureCookie`, published as
 * `sessionCookieSecure` on `GET /api/auth/registration-status`); combining the
 * two facts says, before any credential leaves the browser, whether a sign-in
 * here can finish.
 *
 * Pure and dependency-free: imported by the login page and by the server
 * refusal (`./transport-refusal.ts`) so both sides apply the same rule.
 */

export interface ClientTransport {
  protocol: "http" | "https";
  /** `location.host`: hostname plus an optional port. */
  host: string;
}

/**
 * Loopback names a browser treats as a secure context. A `Secure` cookie set
 * on one of them usually sticks even over http://, so a sign-in there gets a
 * soft note, never a refusal.
 */
export function isLocalhostHost(host: string): boolean {
  let name = host.trim().toLowerCase();
  if (name.startsWith("[")) {
    // [::1] or [::1]:3000
    name = name.slice(
      1,
      name.indexOf("]") === -1 ? undefined : name.indexOf("]"),
    );
  } else if (name.split(":").length === 2) {
    name = name.split(":")[0];
  }
  if (name === "localhost" || name.endsWith(".localhost")) return true;
  if (name === "::1") return true;
  return /^127(?:\.\d{1,3}){3}$/.test(name);
}

/**
 * - `blocked`: the server sets `Secure` cookies and this page is plain http on
 *   a non-loopback host; a sign-in cannot keep its cookie, so it must not start.
 * - `soft`: the same on a loopback host; most browsers accept it, say so.
 * - `ok`: nothing to say.
 */
export type TransportVerdict = "ok" | "soft" | "blocked";

export function transportVerdict(
  sessionCookieSecure: boolean,
  transport: ClientTransport | undefined,
): TransportVerdict {
  if (!sessionCookieSecure || !transport || transport.protocol !== "http") {
    return "ok";
  }
  return isLocalhostHost(transport.host) ? "soft" : "blocked";
}

/** The current page's transport, for the request bodies the server checks. */
export function currentClientTransport(): ClientTransport | undefined {
  if (typeof window === "undefined") return undefined;
  const protocol = window.location.protocol === "https:" ? "https" : "http";
  return { protocol, host: window.location.host };
}
