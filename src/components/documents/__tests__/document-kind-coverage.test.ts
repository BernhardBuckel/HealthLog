/**
 * Every document kind the database knows is one the vault can file, show and
 * name. A kind reaches the screen through a dynamic key
 * (`documents.kind.${kind}`), which the call-site coverage guard cannot see,
 * so a kind added to the schema without its label would render as a raw key
 * in the filter, the bulk bar and the detail sheet.
 *
 * Mutation check: removing `SICK_NOTE` from any locale's `documents.kind`
 * turns the label case red for that locale; dropping it from
 * `INBOUND_DOCUMENT_KINDS` turns the parity case red.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { InboundDocumentKind } from "@/generated/prisma/enums";
import { locales } from "@/lib/i18n/config";
import { INBOUND_DOCUMENT_KINDS } from "@/lib/validations/inbound-documents";

import {
  DOCUMENT_KIND_ICONS,
  DOCUMENT_KIND_ORDER,
} from "../document-kind-meta";

function kindLabels(locale: string): Record<string, unknown> {
  const bundle = JSON.parse(
    readFileSync(join(process.cwd(), "messages", `${locale}.json`), "utf8"),
  ) as { documents?: { kind?: Record<string, unknown> } };
  return bundle.documents?.kind ?? {};
}

describe("document kinds", () => {
  it("the validation list is exactly the database enum", () => {
    expect([...INBOUND_DOCUMENT_KINDS].sort()).toEqual(
      Object.values(InboundDocumentKind).sort(),
    );
  });

  it("every kind has a place in the rail and a glyph", () => {
    expect([...DOCUMENT_KIND_ORDER].sort()).toEqual(
      [...INBOUND_DOCUMENT_KINDS].sort(),
    );
    for (const kind of INBOUND_DOCUMENT_KINDS) {
      expect(DOCUMENT_KIND_ICONS[kind], kind).toBeDefined();
    }
    expect(DOCUMENT_KIND_ORDER.at(-1)).toBe("OTHER");
  });

  it.each([...locales])("every kind has a label in %s", (locale) => {
    const labels = kindLabels(locale);
    const missing = INBOUND_DOCUMENT_KINDS.filter(
      (kind) =>
        typeof labels[kind] !== "string" ||
        (labels[kind] as string).trim() === "",
    );
    expect(missing).toEqual([]);
  });
});
