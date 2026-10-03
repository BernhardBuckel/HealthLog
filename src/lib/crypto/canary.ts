/**
 * Boot check: does the configured encryption key open this database?
 *
 * Without it, a server started with a different `ENCRYPTION_KEY` than the one
 * its database was written with (a reinstalled NAS app over an old dataset, a
 * restored dump under a fresh key) signs people in normally, because sessions
 * hash with `API_TOKEN_HMAC_KEY`, and then answers random 500s wherever a value
 * has to be decrypted. This module turns that into one clear refusal.
 *
 * For every configured key id, `encryption_key_canaries` holds a known
 * plaintext sealed under that key:
 *
 *   - row present: it must decrypt to the expected value, else the key is not
 *     the one the row was written with;
 *   - row absent: before writing one, look for ANY existing ciphertext under
 *     that key id in the registered string columns and try it. Without this
 *     probe, the first boot after an upgrade (or a re-keyed boot over a
 *     database that predates the canary) would seal the wrong key as the
 *     right one. A value that opens, or no value at all, lets the canary be
 *     written (`ON CONFLICT DO NOTHING`, so two processes racing is fine).
 *
 * The probe is bounded by a time budget; past it, the canary is written
 * without a verdict from existing data, which is exactly the behaviour before
 * this check existed.
 *
 * Never logs or returns key material. The canary is written by raw SQL and is
 * deliberately not in the rotation registry: it belongs to its key id.
 */
import {
  decrypt,
  encryptUnderKeyId,
  extractKeyId,
  getConfiguredKeyIds,
} from "@/lib/crypto";
import { ENCRYPTED_COLUMNS } from "@/lib/crypto/encrypted-columns";

export const CANARY_PREFIX = "healthlog-canary:";

export function canaryPlaintext(keyId: string): string {
  return `${CANARY_PREFIX}${keyId}`;
}

/** How long the existing-data probe may take before the canary is written anyway. */
export const PROBE_BUDGET_MS = 10_000;

/** The slice of a Prisma client this module needs. */
export interface CanaryClient {
  $queryRaw<T = unknown>(
    query: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<T>;
  $executeRaw(
    query: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<number>;
}

type ProbeDelegate = {
  findFirst: (args: {
    where: Record<string, unknown>;
    select: Record<string, boolean>;
  }) => Promise<Record<string, unknown> | null>;
};

export type KeyCheckOutcome =
  | {
      state: "ok";
      /** Key ids whose canary this run wrote. */
      written: string[];
      /** Key ids whose canary existed and opened. */
      verified: string[];
    }
  | { state: "mismatch"; keyIds: string[] }
  | { state: "error"; message: string };

function opensAs(ciphertext: string, keyId: string, expected?: string) {
  try {
    if (extractKeyId(ciphertext) !== keyId) return false;
    const plain = decrypt(ciphertext);
    return expected === undefined ? true : plain === expected;
  } catch {
    return false;
  }
}

/**
 * Look for one existing value sealed under `keyId` and try it. Returns
 * `"opens"`, `"fails"`, or `"none"` (no value found inside the budget).
 */
export async function probeExistingData(
  client: unknown,
  keyId: string,
  deadline: number,
): Promise<"opens" | "fails" | "none"> {
  const delegates = client as Record<string, ProbeDelegate | undefined>;
  for (const column of ENCRYPTED_COLUMNS) {
    if (Date.now() > deadline) return "none";
    if (column.kind !== "string" || column.codec || column.codecField) {
      continue;
    }
    const delegate =
      delegates[column.model.charAt(0).toLowerCase() + column.model.slice(1)];
    if (!delegate || typeof delegate.findFirst !== "function") continue;
    let row: Record<string, unknown> | null;
    try {
      row = await delegate.findFirst({
        where: { [column.field]: { startsWith: `${keyId}.` } },
        select: { [column.field]: true },
      });
    } catch {
      continue;
    }
    const value = row?.[column.field];
    if (typeof value !== "string") continue;
    return opensAs(value, keyId) ? "opens" : "fails";
  }
  return "none";
}

/**
 * Run the check for every configured key id. Never throws: a failure to run
 * the check at all is reported as `error`, and only a value that provably does
 * not open is reported as `mismatch`.
 */
export async function checkEncryptionKeyCanaries(
  client: CanaryClient,
  options: { probeBudgetMs?: number } = {},
): Promise<KeyCheckOutcome> {
  let keyIds: string[];
  try {
    keyIds = getConfiguredKeyIds();
  } catch (err) {
    return { state: "error", message: (err as Error).message };
  }

  let rows: Array<{ key_id: string; ciphertext: string }>;
  try {
    rows = await client.$queryRaw<
      Array<{ key_id: string; ciphertext: string }>
    >`SELECT key_id, ciphertext FROM encryption_key_canaries WHERE key_id = ANY(${keyIds})`;
  } catch (err) {
    return { state: "error", message: (err as Error).message };
  }
  const stored = new Map(rows.map((r) => [r.key_id, r.ciphertext]));

  const mismatched: string[] = [];
  const verified: string[] = [];
  const missing: string[] = [];
  for (const keyId of keyIds) {
    const ciphertext = stored.get(keyId);
    if (ciphertext === undefined) {
      missing.push(keyId);
    } else if (opensAs(ciphertext, keyId, canaryPlaintext(keyId))) {
      verified.push(keyId);
    } else {
      mismatched.push(keyId);
    }
  }

  const deadline = Date.now() + (options.probeBudgetMs ?? PROBE_BUDGET_MS);
  const toWrite: string[] = [];
  for (const keyId of missing) {
    const probe = await probeExistingData(client, keyId, deadline);
    if (probe === "fails") mismatched.push(keyId);
    else toWrite.push(keyId);
  }

  if (mismatched.length > 0) {
    // Nothing is written while any key fails: a process in this state must
    // not leave anything behind sealed under a key that may be wrong.
    return { state: "mismatch", keyIds: mismatched.sort() };
  }

  try {
    for (const keyId of toWrite) {
      const ciphertext = encryptUnderKeyId(canaryPlaintext(keyId), keyId);
      await client.$executeRaw`INSERT INTO encryption_key_canaries (key_id, ciphertext) VALUES (${keyId}, ${ciphertext}) ON CONFLICT (key_id) DO NOTHING`;
    }
  } catch (err) {
    return { state: "error", message: (err as Error).message };
  }

  return { state: "ok", written: toWrite, verified };
}

/**
 * The one block an operator reads in the container log. English literal on
 * purpose: logs are not translated. Names the key ids, never a key.
 */
export function keyMismatchLogBlock(keyIds: string[]): string {
  const ids = keyIds.map((id) => `'${id}'`).join(", ");
  return [
    "============================================================",
    " HealthLog refuses to serve: encryption key does not match",
    "============================================================",
    ` The encryption key configured for key id ${ids} cannot open the`,
    " data already stored in this database. Serving anyway would fail on",
    " every encrypted value, so every API request answers 503 with",
    " errorCode 'encryption.key_mismatch' and /api/health reports",
    " reason 'encryption_key_mismatch'. Background jobs are not started.",
    "",
    " Fix it one of three ways, then restart:",
    "  1. Restore the original ENCRYPTION_KEY (or ENCRYPTION_KEYS entry)",
    "     this database was written with.",
    "  2. Point DATABASE_URL at the database that belongs to this key.",
    "  3. Start fresh: an empty database with this key. Stored data and",
    "     in-database backups of the old database cannot be read without",
    "     the old key.",
    "============================================================",
  ].join("\n");
}
