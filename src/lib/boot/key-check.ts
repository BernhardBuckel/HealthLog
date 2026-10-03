/**
 * Runs the encryption key check once per process at boot and records the
 * verdict for the request path (`./key-mismatch-state.ts`).
 *
 * Returns true when the process must refuse: the caller then starts neither
 * the queue producer nor the worker, because a process holding the wrong key
 * must never write. The process keeps running so `/api/health` and the
 * explanation page can say why; a crash loop would hide the reason in a log
 * that the people most likely to hit this (a NAS app catalog install) never
 * open.
 */
import {
  checkEncryptionKeyCanaries,
  keyMismatchLogBlock,
  type CanaryClient,
} from "@/lib/crypto/canary";
import { setKeyMismatchState } from "./key-mismatch-state";

export async function runBootKeyCheck(client: CanaryClient): Promise<boolean> {
  const outcome = await checkEncryptionKeyCanaries(client);
  if (outcome.state === "mismatch") {
    setKeyMismatchState({
      keyIds: outcome.keyIds,
      detectedAt: new Date().toISOString(),
    });
    console.error(keyMismatchLogBlock(outcome.keyIds));
    return true;
  }
  setKeyMismatchState(null);
  if (outcome.state === "error") {
    // The check could not run. The loaders and the database each have their
    // own loud signal for that; serving stays on.
    console.warn(
      `[boot] Encryption key check skipped: ${outcome.message.slice(0, 300)}`,
    );
  } else if (outcome.written.length > 0) {
    console.info(
      `[boot] Encryption key check: recorded key id(s) ${outcome.written.join(", ")}`,
    );
  }
  return false;
}
