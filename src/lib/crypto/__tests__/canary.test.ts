import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetCryptoCacheForTests,
  candidateMatchesKey,
  encrypt,
  encryptUnderKeyId,
  fingerprintKeyBytes,
  getKeyFingerprint,
} from "@/lib/crypto";
import {
  canaryPlaintext,
  checkEncryptionKeyCanaries,
  keyMismatchLogBlock,
  type CanaryClient,
} from "../canary";

const KEY_A =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const KEY_B =
  "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";

function useKey(hex: string) {
  vi.stubEnv("ENCRYPTION_KEYS", "");
  vi.stubEnv("ENCRYPTION_ACTIVE_KEY_ID", "");
  vi.stubEnv("ENCRYPTION_KEY", hex);
  _resetCryptoCacheForTests();
}

/** An in-memory stand-in for the two raw statements and the probe delegates. */
function fakeClient(opts: {
  canaries?: Record<string, string>;
  /** delegate → field → stored values (in row order). */
  probe?: Record<string, Record<string, string[]>>;
}) {
  const canaries = new Map(Object.entries(opts.canaries ?? {}));
  const inserts: string[] = [];
  const client = {
    async $queryRaw() {
      return [...canaries.entries()].map(([key_id, ciphertext]) => ({
        key_id,
        ciphertext,
      }));
    },
    async $executeRaw(_q: TemplateStringsArray, ...values: unknown[]) {
      const [keyId, ciphertext] = values as [string, string];
      inserts.push(keyId);
      if (!canaries.has(keyId)) canaries.set(keyId, ciphertext);
      return 1;
    },
  } as unknown as CanaryClient & Record<string, unknown>;
  for (const [delegate, fields] of Object.entries(opts.probe ?? {})) {
    client[delegate] = {
      async findMany(args: {
        select: Record<string, boolean>;
        take: number;
        skip?: number;
      }) {
        const field = Object.keys(args.select)[0];
        const skip = args.skip ?? 0;
        return (fields[field] ?? [])
          .slice(skip, skip + args.take)
          .map((value) => ({ [field]: value }));
      },
    };
  }
  return { client, canaries, inserts };
}

describe("encryption key canary", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    useKey(KEY_A);
  });

  it("writes a canary for a configured key with no row and no data", async () => {
    const { client, canaries, inserts } = fakeClient({});
    const outcome = await checkEncryptionKeyCanaries(client);
    expect(outcome).toEqual({
      state: "ok",
      written: ["v1"],
      verified: [],
      inconclusive: [],
    });
    expect(inserts).toEqual(["v1"]);
    expect(canaries.get("v1")?.startsWith("v1.")).toBe(true);
  });

  it("verifies a canary written under the same key", async () => {
    const { client, inserts } = fakeClient({
      canaries: { v1: encryptUnderKeyId(canaryPlaintext("v1"), "v1") },
    });
    const outcome = await checkEncryptionKeyCanaries(client);
    expect(outcome).toEqual({
      state: "ok",
      written: [],
      verified: ["v1"],
      inconclusive: [],
    });
    expect(inserts).toEqual([]);
  });

  it("reports a mismatch when the key changed under the same id", async () => {
    const sealedUnderA = encryptUnderKeyId(canaryPlaintext("v1"), "v1");
    useKey(KEY_B);
    const { client, inserts } = fakeClient({ canaries: { v1: sealedUnderA } });
    const outcome = await checkEncryptionKeyCanaries(client);
    expect(outcome).toEqual({ state: "mismatch", keyIds: ["v1"] });
    expect(inserts).toEqual([]);
  });

  it("reports a mismatch for a canary that opens to the wrong value", async () => {
    // A row from another key id copied over: opens, but says the wrong thing.
    const { client } = fakeClient({
      canaries: { v1: encryptUnderKeyId(canaryPlaintext("v2"), "v1") },
    });
    const outcome = await checkEncryptionKeyCanaries(client);
    expect(outcome.state).toBe("mismatch");
  });

  it("refuses to seal a wrong key when existing data predates the canary", async () => {
    const existing = [encrypt("a stored token"), encrypt("another token")];
    useKey(KEY_B);
    const { client, inserts } = fakeClient({
      probe: {
        user: {
          codexAccessTokenEncrypted: [existing[0]],
          codexRefreshTokenEncrypted: [existing[1]],
        },
      },
    });
    const outcome = await checkEncryptionKeyCanaries(client);
    expect(outcome).toEqual({ state: "mismatch", keyIds: ["v1"] });
    expect(inserts).toEqual([]);
  });

  it("writes the canary when existing data opens under the key", async () => {
    const { client, inserts } = fakeClient({
      probe: {
        user: { codexAccessTokenEncrypted: [encrypt("a stored token")] },
      },
    });
    const outcome = await checkEncryptionKeyCanaries(client);
    expect(outcome.state).toBe("ok");
    expect(inserts).toEqual(["v1"]);
  });

  it("one damaged row among good ones does not take the server down", async () => {
    // A row that claims key id v1 but does not open (damaged, or sealed by
    // something else), found FIRST, then values that open.
    const damaged = "v1." + Buffer.alloc(40, 7).toString("base64");
    const { client, inserts } = fakeClient({
      probe: {
        user: {
          codexAccessTokenEncrypted: [damaged],
          codexRefreshTokenEncrypted: [encrypt("a stored token")],
        },
      },
    });
    const outcome = await checkEncryptionKeyCanaries(client);
    expect(outcome.state).toBe("ok");
    expect(inserts).toEqual(["v1"]);
  });

  it("several values in one column count, so a wrong key with one busy column still refuses", async () => {
    const values = [encrypt("one"), encrypt("two"), encrypt("three")];
    useKey(KEY_B);
    const { client, inserts } = fakeClient({
      probe: { user: { codexAccessTokenEncrypted: values } },
    });
    const outcome = await checkEncryptionKeyCanaries(client);
    expect(outcome).toEqual({ state: "mismatch", keyIds: ["v1"] });
    expect(inserts).toEqual([]);
  });

  it("a single value that does not open is inconclusive: no mismatch, no canary", async () => {
    const existing = encrypt("the only stored token");
    useKey(KEY_B);
    const { client, inserts } = fakeClient({
      probe: { user: { codexAccessTokenEncrypted: [existing] } },
    });
    const outcome = await checkEncryptionKeyCanaries(client);
    expect(outcome).toEqual({
      state: "ok",
      written: [],
      verified: [],
      inconclusive: ["v1"],
    });
    expect(inserts).toEqual([]);
  });

  it("reports an error, not a mismatch, when the table cannot be read", async () => {
    const client = {
      $queryRaw: async () => {
        throw new Error('relation "encryption_key_canaries" does not exist');
      },
      $executeRaw: async () => 0,
    } as unknown as CanaryClient;
    const outcome = await checkEncryptionKeyCanaries(client);
    expect(outcome.state).toBe("error");
  });

  it("reports an error when no key is configured", async () => {
    vi.stubEnv("ENCRYPTION_KEY", "");
    _resetCryptoCacheForTests();
    const outcome = await checkEncryptionKeyCanaries(fakeClient({}).client);
    expect(outcome.state).toBe("error");
  });

  it("names the key ids and never a key in the log block", () => {
    const block = keyMismatchLogBlock(["v1"]);
    expect(block).toContain("'v1'");
    expect(block).toContain("encryption.key_mismatch");
    expect(block).not.toContain(KEY_A);
  });
});

describe("key fingerprint and copy check", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    useKey(KEY_A);
  });

  it("is the first 12 hex of SHA-256 over the raw key bytes", () => {
    expect(getKeyFingerprint("v1")).toBe(
      fingerprintKeyBytes(Buffer.from(KEY_A, "hex")),
    );
    expect(getKeyFingerprint("v1")).toMatch(/^[0-9a-f]{12}$/);
    expect(getKeyFingerprint("v1")).not.toBe(
      fingerprintKeyBytes(Buffer.from(KEY_B, "hex")),
    );
    expect(getKeyFingerprint("nope")).toBeNull();
  });

  it("matches the configured key in hex, base64 and with whitespace", () => {
    expect(candidateMatchesKey(KEY_A, "v1")).toBe(true);
    expect(candidateMatchesKey(`  ${KEY_A.toUpperCase()}\n`, "v1")).toBe(true);
    expect(
      candidateMatchesKey(Buffer.from(KEY_A, "hex").toString("base64"), "v1"),
    ).toBe(true);
  });

  it("does not match another key, garbage, or an unknown id", () => {
    expect(candidateMatchesKey(KEY_B, "v1")).toBe(false);
    expect(candidateMatchesKey("not a key", "v1")).toBe(false);
    expect(candidateMatchesKey(KEY_A, "v9")).toBe(false);
  });
});
