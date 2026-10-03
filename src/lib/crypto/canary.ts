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
 *   - row absent: before writing one, sample existing ciphertext under that
 *     key id from the registered string columns and try it. Without this
 *     probe, the first boot after an upgrade (or a re-keyed boot over a
 *     database that predates the canary) would seal the wrong key as the
 *     right one.
 *
 * The probe samples up to `PROBE_SAMPLE_LIMIT` values, one per column first
 * (different columns are different writers, so one bad writer cannot speak
 * for the whole database), then further values from columns that had any.
 * Its verdict, and what each one does:
 *
 *   - `opens`: at least one value opened. A wrong key opens nothing, so the
 *     key is right and any value that failed is a damaged or foreign row, not
 *     a key problem. The canary is written.
 *   - `fails`: two or more values were tried and none opened. That is what a
 *     wrong key looks like; the process refuses (mismatch).
 *   - `inconclusive`: exactly one value was found and it did not open. One
 *     row cannot tell a wrong key from one damaged row, and the two possible
 *     mistakes are not equal: declaring a mismatch takes a correctly keyed
 *     server down with 503 on every request, while serving keeps today's
 *     behaviour. So the process serves, but writes NO canary either (that
 *     would seal a key that may be wrong), logs a warning, and probes again
 *     at the next boot, by which time more data may decide it.
 *   - `none`: nothing found inside the time budget. The canary is written,
 *     which is exactly the behaviour before this check existed.
 *
 * Writes are `ON CONFLICT DO NOTHING`, so two processes racing is fine.
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

/** How many existing values the probe tries at most per key id. */
export const PROBE_SAMPLE_LIMIT = 5;

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
  findMany: (args: {
    where: Record<string, unknown>;
    select: Record<string, boolean>;
    take: number;
    skip?: number;
  }) => Promise<Array<Record<string, unknown>>>;
};

export type ProbeVerdict = "opens" | "fails" | "inconclusive" | "none";

export type KeyCheckOutcome =
  | {
      state: "ok";
      /** Key ids whose canary this run wrote. */
      written: string[];
      /** Key ids whose canary existed and opened. */
      verified: string[];
      /**
       * Key ids with no canary whose only existing value did not open: not a
       * mismatch, no canary written, probed again at the next boot.
       */
      inconclusive: string[];
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
 * Sample existing values sealed under `keyId` and try them; see the module
 * comment for what each verdict means and why.
 */
export async function probeExistingData(
  client: unknown,
  keyId: string,
  deadline: number,
): Promise<ProbeVerdict> {
  const delegates = client as Record<string, ProbeDelegate | undefined>;
  const columns = ENCRYPTED_COLUMNS.filter(
    (c) => c.kind === "string" && !c.codec && !c.codecField,
  );
  let tried = 0;
  const columnsWithData: typeof columns = [];

  const sample = async (
    column: (typeof columns)[number],
    skip: number,
    take: number,
  ): Promise<string[]> => {
    const delegate =
      delegates[column.model.charAt(0).toLowerCase() + column.model.slice(1)];
    if (!delegate || typeof delegate.findMany !== "function") return [];
    try {
      const rows = await delegate.findMany({
        where: { [column.field]: { startsWith: `${keyId}.` } },
        select: { [column.field]: true },
        take,
        ...(skip > 0 ? { skip } : {}),
      });
      return rows
        .map((row) => row[column.field])
        .filter((v): v is string => typeof v === "string");
    } catch {
      return [];
    }
  };

  // Pass 1: one value per column, so different writers are heard first.
  for (const column of columns) {
    if (tried >= PROBE_SAMPLE_LIMIT || Date.now() > deadline) break;
    const values = await sample(column, 0, 1);
    if (values.length === 0) continue;
    columnsWithData.push(column);
    tried += 1;
    if (opensAs(values[0], keyId)) return "opens";
  }
  // Pass 2: more values from the columns that had any, up to the limit.
  for (const column of columnsWithData) {
    if (tried >= PROBE_SAMPLE_LIMIT || Date.now() > deadline) break;
    const values = await sample(column, 1, PROBE_SAMPLE_LIMIT - tried);
    for (const value of values) {
      tried += 1;
      if (opensAs(value, keyId)) return "opens";
    }
  }

  if (tried >= 2) return "fails";
  if (tried === 1) return "inconclusive";
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
  const inconclusive: string[] = [];
  for (const keyId of missing) {
    const probe = await probeExistingData(client, keyId, deadline);
    if (probe === "fails") mismatched.push(keyId);
    else if (probe === "inconclusive") inconclusive.push(keyId);
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

  return { state: "ok", written: toWrite, verified, inconclusive };
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
