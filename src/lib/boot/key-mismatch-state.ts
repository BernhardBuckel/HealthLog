/**
 * Process-wide record of the boot key check's verdict.
 *
 * The check runs once in `instrumentation.ts`; the readers are `apiHandler`
 * (every API route), `/api/health` and the root layout. Those live in
 * different bundles of the same Node process, so module state is not shared
 * between them and the verdict is pinned on `globalThis` under a registry
 * symbol instead. This module imports nothing, so pulling it into the request
 * path costs nothing.
 *
 * Only a positive mismatch is recorded. A check that could not run (database
 * unreachable, keys not configured) leaves the process serving: those failures
 * already have their own loud signals, and refusing on them would turn a
 * transient database hiccup at boot into an outage.
 */

export interface KeyMismatchState {
  /** Configured key ids whose canary did not open under the configured key. */
  keyIds: string[];
  /** When the check found it (ISO). */
  detectedAt: string;
}

const STATE_SYMBOL = Symbol.for("healthlog.encryptionKeyMismatch");

type GlobalWithState = typeof globalThis & {
  [STATE_SYMBOL]?: KeyMismatchState | null;
};

/** The paths that keep answering while the process refuses everything else. */
export const KEY_MISMATCH_EXEMPT_PATHS: ReadonlySet<string> = new Set([
  "/api/health",
  "/api/version",
]);

/** Wire code for the refusal; catalogued in `src/lib/openapi/error-codes.ts`. */
export const KEY_MISMATCH_ERROR_CODE = "encryption.key_mismatch";

/** The `/api/health` reason while the process refuses. */
export const KEY_MISMATCH_HEALTH_REASON = "encryption_key_mismatch";

export function getKeyMismatchState(): KeyMismatchState | null {
  return (globalThis as GlobalWithState)[STATE_SYMBOL] ?? null;
}

export function isKeyMismatch(): boolean {
  return getKeyMismatchState() !== null;
}

export function setKeyMismatchState(state: KeyMismatchState | null): void {
  (globalThis as GlobalWithState)[STATE_SYMBOL] = state;
}
