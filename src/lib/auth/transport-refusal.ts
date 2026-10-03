/**
 * Refuse a browser sign-in whose session cookie cannot stick, BEFORE it spends
 * anything: before the password is verified (so the account throttle never
 * counts it), before an MFA ticket is minted, before a ticket or a one-time
 * code is consumed, before a passkey challenge is issued.
 *
 * The fact comes from the client (`clientTransport`), not from proxy headers:
 * a TLS proxy that omits `X-Forwarded-Proto` would make a header heuristic
 * refuse a correctly served install. A body without the field is never
 * refused. The header heuristic in `secure-cookie.ts` stays as the operator
 * log line for clients that do not send it.
 */
import { apiError } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { shouldEmitSecureCookie } from "@/lib/auth/secure-cookie";
import { transportVerdict } from "@/lib/auth/client-transport";
import { clientTransportSchema } from "@/lib/validations/client-transport";

export const INSECURE_TRANSPORT_CODE = "auth.session.insecure_transport";

/** True when the body states a transport the session cookie cannot survive. */
export function cookieCannotStick(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const parsed = clientTransportSchema.safeParse(
    (body as { clientTransport?: unknown }).clientTransport,
  );
  if (!parsed.success) return false;
  return transportVerdict(shouldEmitSecureCookie(), parsed.data) === "blocked";
}

/** The 409 to return, or null when the sign-in may proceed. */
export function refuseWhenCookieCannotStick(body: unknown): Response | null {
  if (!cookieCannotStick(body)) return null;
  annotate({ action: { name: "auth.session.insecure_transport.refused" } });
  return apiError(
    "This server only sets its sign-in cookie over https://, but this page was opened over http://, so signing in cannot complete here. Open the https:// address, or set SESSION_COOKIE_SECURE=false for a server that is only reached over plain HTTP on a private network.",
    409,
    { errorCode: INSECURE_TRANSPORT_CODE, sessionCookieSecure: true },
  );
}
