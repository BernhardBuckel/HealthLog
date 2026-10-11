/**
 * Signed, short-lived, single-use tokens behind notification quick actions.
 *
 * A quick action is a button inside a notification ("Good", "Okay", "Bad"
 * on the mood reminder) that the notification app calls directly, with no
 * HealthLog session: ntfy's `http` action POSTs to a URL and nothing else.
 * The URL therefore carries the whole credential, and this module is what
 * makes that safe:
 *
 *  - Bound. The token names the user and the one action it performs. A
 *    token minted for one user cannot act for another (the user id is inside
 *    the signed payload), and a token for "okay" cannot log "bad".
 *  - Signed. HMAC-SHA256 over the payload, under a subkey derived from
 *    `API_TOKEN_HMAC_KEY` with a fixed label, so the tag can never collide
 *    with an OAuth state or a Bearer-token hash made from the same root key.
 *    Compared with `timingSafeEqual`.
 *  - Short-lived. The expiry is inside the signed payload; a token is good
 *    for `ACTION_TOKEN_TTL_MS` after the reminder was sent.
 *  - Single-use. The three answers of one reminder share one nonce, and the
 *    write it authorises is keyed on that nonce (`MoodEntry`'s unique
 *    `(userId, source, externalId)`), so the first answer wins and every
 *    later tap on the same reminder, whichever button, is refused. The
 *    database constraint is the arbiter, so two concurrent taps cannot both
 *    write.
 *
 * Layout: `na1.<userId>.<action>.<expiryMs>.<nonce>.<tag>`. Every field is
 * free of `.` by construction (a cuid, a fixed action id, digits, base64url),
 * so the split is unambiguous, and every field is URL-path safe.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * The mood quick answers and the five-point mood scale value each one logs
 * (`MOOD_ENUM_BY_SCORE`: 4 = GUT, 3 = OKAY, 2 = SCHLECHT). Three answers,
 * because ntfy shows at most three actions; the scale's outer points
 * (1 and 5) stay in the app and in the Telegram keyboard, which shows all
 * five.
 */
export const MOOD_QUICK_ACTIONS = {
  "mood-good": 4,
  "mood-okay": 3,
  "mood-bad": 2,
} as const;

export type QuickActionId = keyof typeof MOOD_QUICK_ACTIONS;

export const QUICK_ACTION_IDS = Object.keys(
  MOOD_QUICK_ACTIONS,
) as QuickActionId[];

/**
 * Six hours: long enough to answer a reminder sent at the chosen evening
 * hour before going to bed, short enough that a notification left on a
 * phone overnight no longer writes anything the next day.
 */
export const ACTION_TOKEN_TTL_MS = 6 * 60 * 60 * 1000;

const VERSION = "na1";
const SEP = ".";
const MAX_TOKEN_LENGTH = 300;
const KEY_LABEL = "healthlog:notification-action:v1";

function signingKey(): Buffer {
  const root = process.env.API_TOKEN_HMAC_KEY;
  if (!root || root.length < 32) {
    throw new Error(
      "API_TOKEN_HMAC_KEY must be set (>=32 chars) to sign notification actions",
    );
  }
  return createHmac("sha256", root).update(KEY_LABEL).digest();
}

function sign(payload: string): string {
  return createHmac("sha256", signingKey()).update(payload).digest("base64url");
}

function isQuickActionId(value: string): value is QuickActionId {
  return Object.prototype.hasOwnProperty.call(MOOD_QUICK_ACTIONS, value);
}

/** A fresh nonce shared by every action offered on one notification. */
export function newActionNonce(): string {
  return randomBytes(16).toString("base64url");
}

export function mintActionToken(input: {
  userId: string;
  action: QuickActionId;
  nonce: string;
  now?: number;
}): string {
  const expiry = (input.now ?? Date.now()) + ACTION_TOKEN_TTL_MS;
  const payload = [
    VERSION,
    input.userId,
    input.action,
    String(expiry),
    input.nonce,
  ].join(SEP);
  return `${payload}${SEP}${sign(payload)}`;
}

export type ActionTokenVerdict =
  | {
      ok: true;
      userId: string;
      action: QuickActionId;
      nonce: string;
      expiry: number;
    }
  | { ok: false; reason: "malformed" | "bad_signature" | "expired" };

/**
 * Verify a token. The signature is checked before the expiry, so an expired
 * verdict is only ever given for a token this server actually minted; a
 * forged or altered token reads as `bad_signature` whatever its expiry says.
 * Never throws on bad input (only on a missing server key, which is an
 * operator misconfiguration).
 */
export function verifyActionToken(
  token: string | null | undefined,
  now: number = Date.now(),
): ActionTokenVerdict {
  if (!token || token.length > MAX_TOKEN_LENGTH) {
    return { ok: false, reason: "malformed" };
  }
  const parts = token.split(SEP);
  if (parts.length !== 6) return { ok: false, reason: "malformed" };
  const [version, userId, action, expiryStr, nonce, tag] = parts as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  if (version !== VERSION || !userId || !nonce || !tag) {
    return { ok: false, reason: "malformed" };
  }
  if (!isQuickActionId(action)) return { ok: false, reason: "malformed" };
  const expiry = Number.parseInt(expiryStr, 10);
  if (!Number.isFinite(expiry) || String(expiry) !== expiryStr) {
    return { ok: false, reason: "malformed" };
  }

  const expected = Buffer.from(
    sign([version, userId, action, expiryStr, nonce].join(SEP)),
  );
  const received = Buffer.from(tag);
  if (
    received.length !== expected.length ||
    !timingSafeEqual(received, expected)
  ) {
    return { ok: false, reason: "bad_signature" };
  }
  if (now >= expiry) return { ok: false, reason: "expired" };

  return { ok: true, userId, action, nonce, expiry };
}

/** The `MoodEntry.externalId` that makes one reminder's answers single-use. */
export function quickActionExternalId(nonce: string): string {
  return `notification-action:${nonce}`;
}

/** The public route a quick action calls. */
export const QUICK_ACTION_ROUTE_PREFIX = "/api/notifications/action/";

export interface NotificationQuickAction {
  id: QuickActionId;
  label: string;
  /** Absolute URL the notification app POSTs to. */
  url: string;
}

/**
 * The three mood answers for one reminder, sharing one nonce. Needs the
 * public origin: an app on a phone can only call an absolute URL.
 */
export function buildMoodQuickActions(input: {
  userId: string;
  origin: string;
  labels: Record<QuickActionId, string>;
  now?: number;
}): NotificationQuickAction[] {
  const nonce = newActionNonce();
  return QUICK_ACTION_IDS.map((id) => ({
    id,
    label: input.labels[id],
    url: `${input.origin}${QUICK_ACTION_ROUTE_PREFIX}${mintActionToken({
      userId: input.userId,
      action: id,
      nonce,
      now: input.now,
    })}`,
  }));
}
