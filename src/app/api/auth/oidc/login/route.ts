import { randomBytes } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { apiHandler } from "@/lib/api-handler";
import { annotate, getEvent } from "@/lib/logging/context";
import { checkAuthSurfaceRateLimit } from "@/lib/rate-limit";
import { encrypt } from "@/lib/crypto";
import { shouldEmitSecureCookie } from "@/lib/auth/secure-cookie";
import { transportVerdict } from "@/lib/auth/client-transport";
import { s256Challenge, isValidChallenge } from "@/lib/mcp/oauth/pkce";
import { buildNativeCallbackUrl } from "@/lib/auth/oidc-native-handoff";
import {
  buildAuthorizationUrl,
  discoverOidcMetadata,
  getOidcConfig,
  getOidcRedirectUri,
  oidcAppUrl,
  sanitizeOidcNextPath,
} from "@/lib/auth/oidc";
import {
  OIDC_STATE_COOKIE,
  OIDC_STATE_COOKIE_PATH,
  OIDC_STATE_TTL_MS,
} from "@/lib/auth/oidc-cookie";

/**
 * Redirects the browser to the configured OIDC provider's authorization
 * endpoint. Full-page navigation, not a fetch — every failure branch
 * redirects to `/auth/login?error=...` rather than returning a JSON
 * envelope, mirroring `src/app/api/withings/connect/route.ts`.
 */
export const GET = apiHandler(async (req: NextRequest) => {
  annotate({ action: { name: "auth.oidc.login" } });

  // v1.30.x — native SSO. The iOS app opens this URL inside an
  // `ASWebAuthenticationSession` with `client=native` and its own PKCE
  // `code_challenge`. Both are query params here only; they are validated and
  // folded into the AES-256-GCM state blob so nothing native-specific rides the
  // IdP round-trip as a URL parameter. The `client` param is attacker-flippable
  // at this route, but routing THIS request's error to the custom scheme leaks
  // nothing — an error redirect carries no code, ticket, or session (spec §1).
  const isNative = req.nextUrl.searchParams.get("client") === "native";
  const appCodeChallenge = req.nextUrl.searchParams.get("code_challenge");

  // Native-aware error redirect: the scheme for a native start, the web login
  // page otherwise. Machine-readable `error=<reason>` in both.
  const loginError = (reason: string): NextResponse => {
    if (isNative) {
      return NextResponse.redirect(buildNativeCallbackUrl({ error: reason }));
    }
    return NextResponse.redirect(oidcAppUrl(`/auth/login?error=${reason}`));
  };

  const config = getOidcConfig();
  if (!config) {
    return loginError("oidc_disabled");
  }

  // The SSO button states the page's transport. A browser on plain http://
  // with Secure-only cookies would come back from the provider and drop the
  // session cookie, so it is stopped here instead of after the round trip.
  if (!isNative) {
    const clientProto = req.nextUrl.searchParams.get("client_proto");
    const clientHost = req.nextUrl.searchParams.get("client_host") ?? "";
    if (
      (clientProto === "http" || clientProto === "https") &&
      transportVerdict(shouldEmitSecureCookie(), {
        protocol: clientProto,
        host: clientHost,
      }) === "blocked"
    ) {
      annotate({ meta: { reason: "insecure_transport" } });
      return loginError("insecure_transport");
    }
  }

  const rl = await checkAuthSurfaceRateLimit(
    req,
    "auth:oidc:login",
    10,
    15 * 60 * 1000,
  );
  if (!rl.allowed) {
    return loginError("oidc_rate_limited");
  }

  // A native start MUST carry a valid S256 challenge (43–128 chars). `plain` is
  // structurally unsupported — the exchange only ever verifies S256.
  if (isNative && !isValidChallenge(appCodeChallenge)) {
    annotate({ meta: { reason: "invalid_native_request" } });
    return loginError("oidc_invalid_request");
  }

  let metadata;
  try {
    metadata = await discoverOidcMetadata(config);
  } catch (err) {
    getEvent()?.setError(err);
    return loginError("oidc_failed");
  }

  const state = randomBytes(32).toString("base64url");
  const nonce = randomBytes(32).toString("base64url");
  const codeVerifier = randomBytes(64).toString("base64url");
  const codeChallenge = s256Challenge(codeVerifier);

  // `next` is a post-login WEB path, meaningless to the app — pin it to "/" on
  // the native branch (one less input to sanitize).
  const safeNext = isNative
    ? "/"
    : sanitizeOidcNextPath(req.nextUrl.searchParams.get("next"), req.url);

  const redirectUri = getOidcRedirectUri();
  const authorizationUrl = buildAuthorizationUrl({
    metadata,
    config,
    state,
    nonce,
    codeChallenge,
    redirectUri,
  });

  const response = NextResponse.redirect(authorizationUrl);
  // The server↔IdP PKCE (`codeVerifier`) stays independent of the app↔server
  // PKCE (`appCodeChallenge`). The native flag + challenge live ONLY inside the
  // AES-256-GCM blob, so the callback branches on tamper-authenticated state a
  // network attacker or the IdP cannot flip.
  const cookiePayload = encrypt(
    JSON.stringify({
      state,
      nonce,
      codeVerifier,
      next: safeNext,
      ...(isNative
        ? { native: true as const, appCodeChallenge: appCodeChallenge! }
        : {}),
    }),
  );
  response.cookies.set(OIDC_STATE_COOKIE, cookiePayload, {
    httpOnly: true,
    secure: shouldEmitSecureCookie(),
    // Cross-site top-level redirect back from the IdP, same reasoning as
    // the session cookie and the Withings OAuth state cookie.
    sameSite: "lax",
    maxAge: Math.floor(OIDC_STATE_TTL_MS / 1000),
    // Shared constant — the callback's delete must repeat this exact path
    // (RFC 6265 keys cookies by name+domain+path).
    path: OIDC_STATE_COOKIE_PATH,
  });

  return response;
});
