/**
 * The filing suggestion can propose every document kind the vault files,
 * including the ones added after the prompt was first written: the prompt
 * names each kind, and the model's answer is accepted for each one.
 *
 * Mutation check: dropping SICK_NOTE from `INBOUND_DOCUMENT_KINDS` turns the
 * SICK_NOTE cases red (the prompt no longer offers it, and the answer falls
 * back to null).
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logging/context", () => ({ annotate: vi.fn() }));

import { runDocumentAssist } from "@/lib/documents/assist";
import { INBOUND_DOCUMENT_KINDS } from "@/lib/validations/inbound-documents";

function providerAnswering(kind: string) {
  const generateCompletion = vi.fn(async () => ({
    content: JSON.stringify({ title: null, kind, documentDate: null }),
  }));
  return { provider: { generateCompletion } as never, generateCompletion };
}

describe("filing suggestion kinds", () => {
  it.each([...INBOUND_DOCUMENT_KINDS])(
    "accepts %s from the model",
    async (kind) => {
      const { provider } = providerAnswering(kind);
      const suggestion = await runDocumentAssist({
        provider,
        providerType: "local",
        ocrText: "text",
      });
      expect(suggestion.kind).toBe(kind);
    },
  );

  it("offers the sick note in the prompt, with the words a sick note carries", async () => {
    const { provider, generateCompletion } = providerAnswering("SICK_NOTE");
    await runDocumentAssist({ provider, providerType: "local", ocrText: "x" });
    const params = JSON.stringify(generateCompletion.mock.calls[0]);
    expect(params).toContain("SICK_NOTE");
    expect(params).toContain("Arbeitsunfähigkeitsbescheinigung");
  });

  it("drops a kind the vault does not file", async () => {
    const { provider } = providerAnswering("PARKING_TICKET");
    const suggestion = await runDocumentAssist({
      provider,
      providerType: "local",
      ocrText: "text",
    });
    expect(suggestion.kind).toBeNull();
  });
});
