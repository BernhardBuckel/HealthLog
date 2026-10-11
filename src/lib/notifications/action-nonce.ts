/**
 * The record that a quick-action nonce was spent.
 *
 * A reminder's answers are single-use through the mood entry they write: its
 * unique `(userId, source, externalId)` key refuses a second entry under the
 * same nonce. That holds only while the entry exists. A user who answers,
 * then deletes the entry and purges it from the trash inside the token's
 * six hours, frees the key, and the same notification button would write a
 * second entry. So the nonce is claimed on its own as well, in the
 * idempotency table, which already holds one-shot claims under a unique key
 * and is swept by expiry (`idempotency-cleanup.ts`). The claim expires with
 * the token, so the table holds it exactly as long as it matters.
 *
 * The row can never be read back as a cached response: its method is not an
 * HTTP verb, its path names no route, and its fingerprint is null, which
 * `withIdempotency` never replays.
 */
import { prisma } from "@/lib/db";
import { isP2002 } from "@/lib/prisma-errors";
import { quickActionExternalId } from "@/lib/notifications/action-token";

const CLAIM_METHOD = "NOTIFICATION_ACTION";
const CLAIM_PATH = "/api/notifications/action";
const CLAIM_STATUS = 0;

/**
 * Claim a reminder's nonce. `true` when this call won it, `false` when the
 * nonce was already spent (by an earlier answer or a concurrent one).
 */
export async function claimActionNonce(input: {
  userId: string;
  nonce: string;
  expiry: number;
}): Promise<boolean> {
  try {
    await prisma.idempotencyKey.create({
      data: {
        userId: input.userId,
        key: quickActionExternalId(input.nonce),
        method: CLAIM_METHOD,
        path: CLAIM_PATH,
        requestFingerprint: null,
        responseStatus: CLAIM_STATUS,
        responseBody: "",
        expiresAt: new Date(input.expiry),
      },
    });
    return true;
  } catch (err) {
    if (isP2002(err)) return false;
    throw err;
  }
}

/**
 * Give a claim back when the write it guarded failed for a reason other than
 * the nonce being spent, so the person can tap the answer again.
 */
export async function releaseActionNonce(input: {
  userId: string;
  nonce: string;
}): Promise<void> {
  await prisma.idempotencyKey.deleteMany({
    where: {
      userId: input.userId,
      key: quickActionExternalId(input.nonce),
      method: CLAIM_METHOD,
      path: CLAIM_PATH,
    },
  });
}
