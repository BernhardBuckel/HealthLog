/**
 * v1.18.1 — server-side helpers for the user-scoped Biomarker catalog.
 *
 * The AES-256-GCM ↔ `Bytes` codec for `Biomarker.contextEncrypted`. The
 * per-marker context note ("what this means") is the only sensitive column on
 * the model; it shares the `encrypt()` string format (`"<keyId>.<base64>"`)
 * every other `*Encrypted` column uses, encoded as UTF-8 bytes.
 *
 * Mirrors the `LabResult.noteEncrypted` codec in `./store.ts` so the two
 * encrypted columns on the Labs feature share one byte layout.
 */
import { Buffer } from "node:buffer";

import { decrypt, encrypt } from "@/lib/crypto";
import { prisma } from "@/lib/db";
import { matchAnalyteKey } from "@/lib/labs/analyte-match";
import { getEvent } from "@/lib/logging/context";

/** Encrypt a UTF-8 context note into the `Bytes` payload the schema stores. */
export function encryptContextToBytes(
  plaintext: string,
): Uint8Array<ArrayBuffer> {
  const ciphertext = encrypt(plaintext);
  const encoded = Buffer.from(ciphertext, "utf8");
  const out = new Uint8Array(new ArrayBuffer(encoded.byteLength));
  out.set(encoded);
  return out;
}

/** Decrypt a stored `Bytes` context note back to plaintext. */
export function decryptContextFromBytes(buf: Uint8Array): string {
  return decrypt(Buffer.from(buf).toString("utf8"));
}

/** Decrypt a stored `Bytes` context note, fail-soft to `null` on any error.
 *
 * A single bad-key / malformed row must not 500 the whole catalog list, and
 * the list surface renders a missing context as nothing either way. The
 * single-resource GET path uses the throwing `decryptContextFromBytes` so a
 * genuine decrypt failure there surfaces instead of silently masking a
 * key-rotation gap, and the backup export reads through its own helper that
 * marks the row rather than blanking it. */
export function decryptContextSoft(buf: Uint8Array | null): string | null {
  if (!buf) return null;
  try {
    return decryptContextFromBytes(buf);
  } catch (err) {
    // Undecryptable context (key gap / corruption): fail soft to null so one
    // bad row never 500s the catalog list, but log it (F-CRYPTO-2) so a
    // systemic key gap surfaces instead of masking as an empty context.
    getEvent()?.addWarning(
      `biomarker context decrypt failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }
}

/** The minimal Biomarker shape the lab-write resolver returns. */
export interface MintedBiomarker {
  id: string;
  name: string;
  unit: string;
  lowerBound: number | null;
  upperBound: number | null;
  panel: string | null;
}

/**
 * v1.18.1 — resolve (or mint) the user-scoped Biomarker for a free-text lab
 * write so NO `LabResult` row ever persists unlinked.
 *
 * The catalog identity is `(userId, lower(analyte))`: a reading for "LDL",
 * "ldl", and "LDL " all resolve to one marker. An existing marker (hand-
 * defined or previously minted) is reused as-is — its unit / range are
 * authoritative and the incoming free-text unit / bounds are NOT allowed to
 * silently rewrite it. When no marker exists yet, one is minted from the
 * reading's own free-text spelling / unit / bounds. The `@@unique([userId,
 * name])` index is the structural backstop; a concurrent double-write
 * converges via the catch-and-refetch.
 *
 * Turning the boot-time backfill into a pure historical migration: from
 * v1.18.1 on, every write goes through here, so the only unlinked rows that
 * can exist are pre-upgrade ones the backfill heals.
 */
export async function resolveOrMintBiomarker(
  userId: string,
  input: {
    analyte: string;
    unit: string;
    referenceLow: number | null;
    referenceHigh: number | null;
    panel: string | null;
  },
): Promise<MintedBiomarker> {
  const name = input.analyte.trim();
  const select = {
    id: true,
    name: true,
    unit: true,
    lowerBound: true,
    upperBound: true,
    panel: true,
  } as const;

  // Case-insensitive match on the catalog identity. Postgres is the store;
  // `mode: "insensitive"` keeps "LDL" === "ldl" without a functional index.
  const existing = await prisma.biomarker.findFirst({
    where: { userId, name: { equals: name, mode: "insensitive" } },
    select,
  });
  if (existing) return existing;

  try {
    return await prisma.biomarker.create({
      data: {
        userId,
        name,
        unit: input.unit,
        lowerBound: input.referenceLow,
        upperBound: input.referenceHigh,
        panel: input.panel,
        analyteKey: matchAnalyteKey({ name, unit: input.unit }),
      },
      select,
    });
  } catch {
    // A concurrent write minted the same `(userId, name)` first — adopt it.
    const raced = await prisma.biomarker.findFirst({
      where: { userId, name: { equals: name, mode: "insensitive" } },
      select,
    });
    if (raced) return raced;
    throw new Error("Failed to resolve biomarker for lab write");
  }
}
