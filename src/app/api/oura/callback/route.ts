import { prisma } from "@/lib/db";
import { apiHandler } from "@/lib/api-handler";
import { getSession } from "@/lib/auth/session";
import { annotate, getEvent } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { encrypt } from "@/lib/crypto";
import { exchangeCode, isAcceptedOuraIssuer } from "@/lib/oura/client";
import { getOuraClientCredentials } from "@/lib/oura/credentials";
import {
  oauthStateCookieName,
  stateMatchesCookie,
  verifySignedState,
} from "@/lib/oauth/signed-state";
import { markReconnected } from "@/lib/integrations/status";
import { OURA_SYNC_QUEUE } from "@/lib/jobs/integration-poll-queues";
import { getGlobalBoss } from "@/lib/jobs/boss-instance";
import { NextRequest, NextResponse } from "next/server";

/**
 * v1.17.0 (F4) — OAuth callback from Oura.
 *
 * Identity + CSRF mirror the Polar callback: the `state` param is a stateless
 * HMAC-signed token, enforced as a byte-exact double-submit against the
 * httpOnly cookie AND verified for signature / expiry / `oura` provider
 * binding. The `userId` is read from inside the verified token, cross-checked
 * against the web session when present.
 *
 * On success: exchange the code, persist the encrypted access + refresh token
 * on `User`, clear any prior reauth state, and redirect back to Settings.
 */
const ERR = (reason: string) =>
  NextResponse.redirect(
    new URL(
      `/settings/integrations?oura=error&reason=${reason}`,
      process.env.NEXT_PUBLIC_APP_URL!,
    ),
  );

export const GET = apiHandler(async (request: NextRequest) => {
  annotate({ action: { name: "oura.callback" } });

  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const cookieState = request.cookies.get(oauthStateCookieName("oura"))?.value;

  if (!stateMatchesCookie(state, cookieState)) {
    annotate({ meta: { reason: "csrf1" } });
    return ERR("csrf1");
  }

  const verified = verifySignedState("oura", state);
  if (!verified) {
    annotate({ meta: { reason: "state" } });
    return ERR("state");
  }
  const userId = verified.userId;

  const evt = getEvent();
  if (evt) evt.setAuth({ user_id: userId, auth_method: "session" });

  const sessionData = await getSession();
  if (sessionData && sessionData.user.id !== userId) {
    annotate({ meta: { reason: "cross_user" } });
    return ERR("cross_user");
  }

  if (!code) return ERR("nocode");

  // RFC 9207: an authorization server that names itself must be Oura's. The
  // issuer also tells which token endpoint the code belongs to. Older apps
  // send none, which is fine.
  const iss = searchParams.get("iss");
  if (!isAcceptedOuraIssuer(iss)) {
    annotate({ meta: { reason: "issuer" } });
    return ERR("issuer");
  }

  try {
    const creds = await getOuraClientCredentials(userId);
    if (!creds) return ERR("nocreds");

    const tokens = await exchangeCode(code, creds, iss);

    await prisma.user.update({
      where: { id: userId },
      data: {
        ouraAccessTokenEncrypted: encrypt(tokens.access_token),
        ouraRefreshTokenEncrypted: encrypt(tokens.refresh_token),
      },
    });

    await auditLog("oura.connect", { userId });
    await markReconnected(userId, "oura");

    // Start the first sync now instead of leaving the user staring at an empty
    // card until the next hourly tick. The poll handler has accepted a
    // single-user payload since it was written; this is the producer that was
    // missing. Reconnects ride the same path. Best-effort by design: the hourly
    // cron remains the safety net, so a missing boss instance must never strand
    // the redirect.
    const boss = getGlobalBoss();
    if (boss) {
      await boss
        .send(OURA_SYNC_QUEUE, { userId })
        .catch((err) =>
          getEvent()?.addWarning(`oura-sync connect enqueue failed: ${err}`),
        );
    }

    const response = NextResponse.redirect(
      new URL(
        "/settings/integrations?oura=connected",
        process.env.NEXT_PUBLIC_APP_URL!,
      ),
    );
    response.cookies.delete(oauthStateCookieName("oura"));
    return response;
  } catch (err) {
    getEvent()?.setError(err);
    return ERR("token");
  }
});
