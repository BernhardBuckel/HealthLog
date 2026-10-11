import type {
  NtfyChannelConfig,
  NotificationPayload,
} from "@/lib/notifications/types";
import type { SendOutcome } from "@/lib/notifications/retry-policy";
import { classifyHttpStatus } from "@/lib/notifications/retry-policy";
import { getEvent } from "@/lib/logging/context";
import { recordPushAttemptForPayload } from "@/lib/notifications/senders/push-attempt-record";
import { safeFetch, SafeFetchError } from "@/lib/safe-fetch";
import { plainPushText } from "@/lib/notifications/strip-emoji";
import { stripHtml } from "@/lib/notifications/strip-html";
import { isUrgentPayload } from "@/lib/notifications/types";
import {
  annotatePrivateOriginEgress,
  evaluateNotificationTarget,
  PRIVATE_ORIGIN_NOT_APPROVED_CODE,
} from "@/lib/notifications/egress-policy";
import type { OriginReason } from "@/lib/private-origin-policy";
import {
  readUpstreamBody,
  secretsInUrl,
} from "@/lib/notifications/upstream-body";

/**
 * Send notification via ntfy (simple HTTP POST).
 * See https://docs.ntfy.sh/publish/
 *
 * Returns a structured `SendOutcome` so the dispatcher (v1.4.15 Phase B3)
 * can distinguish hard rejects (HTTP 410, topic deleted) from soft errors
 * (5xx, 429, network timeout) and apply the right retry / auto-disable
 * policy.
 */
export async function sendViaNtfy(
  config: NtfyChannelConfig,
  payload: NotificationPayload,
): Promise<SendOutcome> {
  const userId = payload.recipientUserId ?? payload.userId;
  const start = performance.now();
  // Set when the policy itself refuses, so the outcome can say which of the
  // two refusals it was: an origin the operator could list, or one no grant
  // can open.
  let policyReason: OriginReason | null = null;
  try {
    const url = `${config.serverUrl.replace(/\/$/, "")}/${encodeURIComponent(config.topic)}`;

    // v1.18.4 — an explicitly urgent payload escalates to ntfy's top
    // priority (`5` / max) so it bypasses the relay's batching and surfaces
    // loudest; MEDICATION_REMINDER keeps its long-standing `high` (4); the
    // rest stay `default` (3). `urgent` also adds a tag so the lock-screen
    // entry reads as an alert (unless discreet privacy collapses tags).
    const urgent = isUrgentPayload(payload) && payload.urgent === true;
    const priority = urgent
      ? "5"
      : payload.eventType === "MEDICATION_REMINDER"
        ? "high"
        : "default";
    const eventTag = payload.discreet
      ? "reminder"
      : payload.eventType.toLowerCase().replace(/_/g, "-");
    const headers: Record<string, string> = {
      Title: ntfyHeaderValue(plainPushText(payload.title, payload.eventType)),
      Priority: priority,
      // Discreet mode (cycle privacy): the X-Tags header is visible on the
      // lock screen, so collapse it to a generic tag instead of leaking the
      // cycle event name. An urgent (non-discreet) event also carries a
      // `warning` tag so the entry renders as an alert.
      Tags: urgent && !payload.discreet ? `warning,${eventTag}` : eventTag,
    };

    if (config.authToken) {
      headers["Authorization"] = `Bearer ${config.authToken}`;
    }

    // Tapping the notification opens this URL (ntfy `Click`). Absent when
    // the operator has not configured a public origin.
    if (payload.tap?.url) {
      headers["Click"] = payload.tap.url;
    }
    const actions = buildNtfyActionsHeader(payload);
    if (actions) {
      headers["Actions"] = ntfyHeaderValue(actions);
    }

    // Strip HTML tags for ntfy (plain text only) + emoji on routine reminders
    const body = plainPushText(stripHtml(payload.message), payload.eventType);

    // The DNS-rebinding pin (issue #217) sits on top of the input-time
    // guard enforced when the user saved the serverUrl; the authToken would
    // otherwise leak on a rebinding flip to a private address. A server the
    // operator listed in NOTIFICATION_PRIVATE_ORIGINS (#947) runs under the
    // operator-approved pin instead — same resolver pin, redirects
    // forbidden, loopback and metadata refused. Same verdict function as
    // the settings routes and the webhook sender.
    const policy = evaluateNotificationTarget(url);
    if (!policy.allowed || !policy.canonicalOrigin) {
      policyReason = policy.reasonCode;
      throw new SafeFetchError(
        "ntfy server refused by the notification origin policy",
        "private_host",
      );
    }
    if (policy.privateOriginApproved) {
      annotatePrivateOriginEgress("ntfy", policy.canonicalOrigin);
    }

    const res = await safeFetch(
      url,
      {
        method: "POST",
        headers,
        body,
      },
      {
        timeoutMs: 5_000,
        requirePublicHost: !policy.privateOriginApproved,
        ...(policy.privateOriginApproved
          ? { operatorApprovedPrivateOrigin: policy.canonicalOrigin }
          : {}),
      },
    );

    getEvent()?.addExternalCall({
      service: "ntfy",
      method: "sendNotification",
      duration_ms: Math.round(performance.now() - start),
      status: res.status,
    });

    if (res.ok) {
      recordPushAttemptForPayload(payload, userId, {
        userId: payload.userId,
        channel: "NTFY",
        eventType: payload.eventType,
        result: "ok",
      });
      return { ok: true, statusCode: res.status };
    }
    const classified = classifyHttpStatus(res.status, "ntfy");
    recordPushAttemptForPayload(payload, userId, {
      userId: payload.userId,
      channel: "NTFY",
      eventType: payload.eventType,
      result: "error",
      reason: classified.reason,
    });
    // What the server said, for the test button. The topic is treated as a
    // secret too: on a public ntfy server it is the only access control.
    const upstreamBody = await readUpstreamBody(res, [
      config.authToken,
      config.topic,
      ...secretsInUrl(config.serverUrl),
    ]);
    return {
      ok: false,
      statusCode: res.status,
      hardReject: classified.hardReject,
      reason: classified.reason,
      ...(upstreamBody ? { upstreamBody } : {}),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "request_failed";
    // A policy refusal is not a network fault (see the webhook sender): soft
    // classification, its own reason, and a code the test route can forward.
    const policyRefused =
      err instanceof SafeFetchError && err.kind === "private_host";
    const reason = policyRefused
      ? "ntfy_private_origin_refused"
      : "ntfy_network_error";
    const failureCode =
      err instanceof SafeFetchError && !policyRefused
        ? err.kind === "timeout"
          ? "timeout"
          : "connection_failed"
        : undefined;
    getEvent()?.addExternalCall({
      service: "ntfy",
      method: "sendNotification",
      duration_ms: Math.round(performance.now() - start),
      error: message,
    });
    recordPushAttemptForPayload(payload, userId, {
      userId: payload.userId,
      channel: "NTFY",
      eventType: payload.eventType,
      result: "error",
      reason,
    });
    return {
      ok: false,
      hardReject: false,
      reason,
      message,
      ...(policyRefused
        ? { errorCode: policyReason ?? PRIVATE_ORIGIN_NOT_APPROVED_CODE }
        : {}),
      ...(failureCode ? { failureCode } : {}),
    };
  }
}

/** ntfy shows at most three actions per notification. */
const NTFY_MAX_ACTIONS = 3;

/**
 * A label safe inside the `Actions` header's short format: `,` and `;`
 * separate fields and actions there, and a quote would open a quoted value.
 */
function ntfyActionLabel(label: string): string {
  return label.replace(/[,;"'\r\n]/g, " ").trim() || "?";
}

/**
 * The `Actions` header for the payload's quick answers, in ntfy's short
 * format (https://docs.ntfy.sh/publish/#action-buttons):
 *
 *   http, <label>, <url>, method=POST, clear=true; …
 *
 * `clear=true` dismisses the notification once the request succeeded, so a
 * reminder answered from the shade does not linger. The token in the URL is
 * the request's only credential (see `action-token.ts`).
 */
export function buildNtfyActionsHeader(
  payload: Pick<NotificationPayload, "quickActions">,
): string | null {
  const actions = (payload.quickActions ?? []).slice(0, NTFY_MAX_ACTIONS);
  if (actions.length === 0) return null;
  return actions
    .map(
      (action) =>
        `http, ${ntfyActionLabel(action.label)}, ${action.url}, method=POST, clear=true`,
    )
    .join("; ");
}

/**
 * A header value fetch can send and ntfy reads as UTF-8.
 *
 * `fetch` refuses any header character above U+00FF outright (a Korean
 * title or action label would fail the whole send), and a Latin-1 byte such
 * as `ü` reaches ntfy as invalid UTF-8. ntfy decodes RFC 2047 encoded words
 * in every header, so a value with anything beyond printable ASCII travels as
 * one `=?UTF-8?B?…?=` word; plain ASCII stays readable on the wire.
 */
export function ntfyHeaderValue(value: string): string {
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}
