import { describe, expect, it } from "vitest";
import { isKeyBackupDue, resolvePlatformHint } from "../key-backup";

const confirmed = (keyId: string, fingerprint: string) => ({
  encryptionKeyBackupConfirmedAt: new Date("2026-10-03T10:00:00Z"),
  encryptionKeyBackupConfirmedKeyId: keyId,
  encryptionKeyBackupConfirmedFingerprint: fingerprint,
});

describe("key backup step", () => {
  it("is due without any confirmation", () => {
    expect(isKeyBackupDue(null, "v1", "abcdefabcdef")).toBe(true);
    expect(
      isKeyBackupDue(
        {
          encryptionKeyBackupConfirmedAt: null,
          encryptionKeyBackupConfirmedKeyId: null,
          encryptionKeyBackupConfirmedFingerprint: null,
        },
        "v1",
        "abcdefabcdef",
      ),
    ).toBe(true);
  });

  it("is done only for the exact key that was confirmed", () => {
    expect(
      isKeyBackupDue(confirmed("v1", "abcdefabcdef"), "v1", "abcdefabcdef"),
    ).toBe(false);
  });

  it("is due again after a rotation (new active id)", () => {
    expect(
      isKeyBackupDue(confirmed("v1", "abcdefabcdef"), "v2", "abcdefabcdef"),
    ).toBe(true);
  });

  it("is due again after a re-keyed install (same id, other key)", () => {
    expect(
      isKeyBackupDue(confirmed("v1", "abcdefabcdef"), "v1", "123456123456"),
    ).toBe(true);
  });

  it("reads the platform hint and falls back to compose", () => {
    expect(resolvePlatformHint("truenas")).toBe("truenas");
    expect(resolvePlatformHint(" Unraid ")).toBe("unraid");
    expect(resolvePlatformHint(undefined)).toBe("compose");
    expect(resolvePlatformHint("kubernetes")).toBe("compose");
  });
});
