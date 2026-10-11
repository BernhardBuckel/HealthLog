import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";

import type {
  EmailChannelConfig,
  NotificationPayload,
} from "@/lib/notifications/types";
import type { SendOutcome } from "@/lib/notifications/retry-policy";
import { getEvent } from "@/lib/logging/context";
import { recordPushAttemptForPayload } from "@/lib/notifications/senders/push-attempt-record";
import { loadEmailConfig } from "@/lib/notifications/senders/email-config";
import { plainPushText } from "@/lib/notifications/strip-emoji";
import { stripHtml } from "@/lib/notifications/strip-html";

/**
 * SMTP / email sender (v1.17.1).
 *
 * The SMTP transport is OPERATOR-configured via `SMTP_*` env (see
 * `email-config.ts`); the per-user config carries only the recipient address.
 * When SMTP is unconfigured the send returns a soft `skipped` outcome and the
 * dispatcher never surfaces the channel (the Settings card is hidden too).
 *
 * Body is PLAIN TEXT — no markdown library (hard rule). Routine reminders run
 * through `plainPushText` so the colour-coded phase emoji don't leak into the
 * subject/body; SYSTEM_ALERTs keep their severity glyphs.
 *
 * Transport errors map to a transient `SendOutcome` so the dispatcher's
 * backoff/auto-disable machinery absorbs a flapping mail server exactly like
 * the HTTP channels. nodemailer surfaces `err.responseCode` for SMTP-level
 * rejections; a 5xx permanent rejection (bad recipient, relay denied) is a
 * hard reject so the channel auto-disables rather than retrying forever.
 */

// Cache one transporter per process keyed on the resolved transport config.
// Rebuilding a transporter per send would re-establish the connection pool on
// every dispatch; nodemailer transports are safe to reuse.
let cachedTransporter: Transporter | undefined;
let cachedTransportKey: string | undefined;

function getTransporter(): { transporter: Transporter; from: string } | null {
  const config = loadEmailConfig();
  if (!config) return null;

  const key = JSON.stringify({
    host: config.host,
    port: config.port,
    secure: config.secure,
    hasAuth: Boolean(config.auth),
  });
  if (cachedTransporter && cachedTransportKey === key) {
    return { transporter: cachedTransporter, from: config.from };
  }

  cachedTransporter = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    ...(config.auth ? { auth: config.auth } : {}),
    // Bound every phase of the SMTP exchange. nodemailer's defaults (2 min
    // connect, 30 s greeting, 10 min socket) would let a hung/blackholed relay
    // pin a dispatch worker for minutes per send. These caps map a stall to the
    // transient `SendOutcome` `classifySmtpError` already retries, matching the
    // webhook sender's 5 s ethos.
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
  cachedTransportKey = key;
  return { transporter: cachedTransporter, from: config.from };
}

/** Test-only: drop the cached transporter so a re-configured env takes effect. */
export function resetEmailTransporterForTesting(): void {
  cachedTransporter = undefined;
  cachedTransportKey = undefined;
}

function classifySmtpError(err: unknown): {
  hardReject: boolean;
  reason: string;
  message: string;
  failureCode?: string;
  smtpCode?: number;
} {
  const message = err instanceof Error ? err.message : "smtp_send_failed";
  // nodemailer attaches `responseCode` (the SMTP reply code) on protocol-level
  // rejections and a `code` string on transport faults. 5xx = permanent (bad
  // mailbox, relay denied) → hard reject so the channel auto-disables.
  // 4xx / connection errors = transient → retry.
  const responseCode =
    typeof err === "object" && err !== null && "responseCode" in err
      ? (err as { responseCode?: number }).responseCode
      : undefined;
  const code =
    typeof err === "object" && err !== null && "code" in err
      ? (err as { code?: unknown }).code
      : undefined;
  const smtpCode = typeof responseCode === "number" ? responseCode : undefined;
  // The test card's vocabulary, so the test route can say which it was.
  // Anything unrecognised stays without a code.
  const failureCode =
    code === "EAUTH"
      ? "credentials_rejected"
      : code === "ETIMEDOUT"
        ? "timeout"
        : code === "ECONNECTION" ||
            code === "ESOCKET" ||
            code === "EDNS" ||
            code === "ECONNREFUSED" ||
            // STARTTLS or TLS handshake failure (typically port 465 set up
            // as 587 or the reverse) and a server that does not speak SMTP.
            code === "ETLS" ||
            code === "EPROTOCOL"
          ? "connection_failed"
          : smtpCode !== undefined && smtpCode >= 500
            ? "upstream_rejected"
            : smtpCode !== undefined && smtpCode >= 400
              ? "upstream_error"
              : // An envelope or message refused without a reply code.
                code === "EENVELOPE" || code === "EMESSAGE"
                ? "upstream_rejected"
                : undefined;
  const extras = {
    ...(failureCode ? { failureCode } : {}),
    ...(smtpCode !== undefined ? { smtpCode } : {}),
  };
  if (smtpCode !== undefined && smtpCode >= 500) {
    return { hardReject: true, reason: "email_smtp_5xx", message, ...extras };
  }
  return { hardReject: false, reason: "email_smtp_error", message, ...extras };
}

export async function sendViaEmail(
  config: EmailChannelConfig,
  payload: NotificationPayload,
): Promise<SendOutcome> {
  const userId = payload.recipientUserId ?? payload.userId;
  const start = performance.now();

  const transport = getTransporter();
  if (!transport) {
    // Operator hasn't configured SMTP — soft skip, no channel burn.
    recordPushAttemptForPayload(payload, userId, {
      userId: payload.userId,
      channel: "EMAIL",
      eventType: payload.eventType,
      result: "skipped",
      reason: "email_not_configured",
    });
    return { ok: false, hardReject: false, reason: "email_not_configured" };
  }

  if (!config.recipient) {
    recordPushAttemptForPayload(payload, userId, {
      userId: payload.userId,
      channel: "EMAIL",
      eventType: payload.eventType,
      result: "skipped",
      reason: "email_no_recipient",
    });
    return { ok: false, hardReject: false, reason: "email_no_recipient" };
  }

  // Plain text only — strip HTML + decorative emoji on routine reminders.
  const subject = plainPushText(payload.title, payload.eventType);
  const body = plainPushText(stripHtml(payload.message), payload.eventType);
  // The tap target as a plain link line (plain text body, no markup).
  const text = payload.tap?.url
    ? `${body}\n\n${payload.tap.label}: ${payload.tap.url}`
    : body;

  try {
    await transport.transporter.sendMail({
      from: transport.from,
      to: config.recipient,
      subject,
      text,
    });

    getEvent()?.addExternalCall({
      service: "email",
      method: "sendMail",
      duration_ms: Math.round(performance.now() - start),
    });
    recordPushAttemptForPayload(payload, userId, {
      userId: payload.userId,
      channel: "EMAIL",
      eventType: payload.eventType,
      result: "ok",
    });
    return { ok: true };
  } catch (err) {
    const classified = classifySmtpError(err);
    getEvent()?.addExternalCall({
      service: "email",
      method: "sendMail",
      duration_ms: Math.round(performance.now() - start),
      error: classified.message,
    });
    recordPushAttemptForPayload(payload, userId, {
      userId: payload.userId,
      channel: "EMAIL",
      eventType: payload.eventType,
      result: "error",
      reason: classified.reason,
    });
    return {
      ok: false,
      hardReject: classified.hardReject,
      reason: classified.reason,
      message: classified.message,
      ...(classified.failureCode
        ? { failureCode: classified.failureCode }
        : {}),
      ...(classified.smtpCode !== undefined
        ? { smtpCode: classified.smtpCode }
        : {}),
    };
  }
}
