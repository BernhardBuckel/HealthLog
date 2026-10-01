/**
 * Every `User` column has a backup verdict, read from the schema rather than
 * from a list somebody keeps.
 *
 * The account row mixes the person's choices with sign-in credentials,
 * provider keys, the operator's policy for the account and the host's own
 * cursors, so it cannot have one verdict the way a model does. A column added
 * tomorrow has to land in `USER_COLUMN_BACKUP_CLASS` (`src/lib/export/
 * backup-plan.ts`) or this fails naming it: a new preference that silently
 * stays behind on a restore, or a new secret that silently rides along in
 * every backup file, are the two failures this exists to stop.
 *
 * Mutation check: delete any key from the table and the first case goes red
 * naming the column; add a `User` column to the schema without classifying it
 * and the same case goes red naming that one.
 */
import { describe, expect, it } from "vitest";

import { parseWipeSchema } from "@/__tests__/helpers/wipe-schema-shape";
import { USER_COLUMN_BACKUP_CLASS } from "@/lib/export/backup-plan";
import { ACCOUNT_SETTING_COLUMNS } from "@/lib/export/account-settings-backup";

const columns = parseWipeSchema().get("User")?.scalars ?? [];
const classified = USER_COLUMN_BACKUP_CLASS as Readonly<Record<string, string>>;

describe("User column backup classification", () => {
  it("classifies every User column", () => {
    // A floor, so a parser that stops matching cannot pass on an empty list.
    expect(columns.length).toBeGreaterThan(100);
    const unclassified = columns.filter((c) => !Object.hasOwn(classified, c));
    expect(
      unclassified,
      "these User columns have no backup verdict. Add each to " +
        "USER_COLUMN_BACKUP_CLASS as SETTING, CREDENTIAL, IDENTITY or " +
        "OPERATIONAL, and if it is a SETTING give it a codec in " +
        "account-settings-backup.ts",
    ).toEqual([]);
  });

  it("names no column the schema no longer has", () => {
    const known = new Set(columns);
    expect(Object.keys(classified).filter((c) => !known.has(c))).toEqual([]);
  });

  it("carries exactly the columns classified as settings", () => {
    expect([...ACCOUNT_SETTING_COLUMNS].sort()).toEqual(
      Object.entries(classified)
        .filter(([, verdict]) => verdict === "SETTING")
        .map(([column]) => column)
        .sort(),
    );
  });

  it("carries no credential-shaped column as a setting", () => {
    // The insurance number is the one sealed setting: it is the person's own
    // data, sealed at rest for privacy, not a secret that grants anything.
    const sealedSettings = ACCOUNT_SETTING_COLUMNS.filter((column) =>
      /Encrypted$|Token|Secret|password|totp|oidc/i.test(column),
    );
    expect(sealedSettings).toEqual(["insuranceNumberEncrypted"]);
  });

  it("never classifies a sealed column other than the insurance number as anything but a credential", () => {
    const sealed = columns.filter(
      (c) => /Encrypted$/.test(c) && c !== "insuranceNumberEncrypted",
    );
    expect(sealed.length).toBeGreaterThan(20);
    expect(sealed.filter((c) => classified[c] !== "CREDENTIAL")).toEqual([]);
  });
});
