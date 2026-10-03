/**
 * Background document AI runs (v1.40) end to end against a real Postgres:
 * the queuing routes, the worker body, the poll route and the reaper, with a
 * spy standing in for every model call.
 *
 * What only this file can prove:
 *   1. Migration 0366 applied clean (every write below lands in the table).
 *   2. Enqueue → worker → poll round-trips the same body the synchronous
 *      route answers with, for "Read with AI" and for a lab scan, and the
 *      synchronous route is unchanged without `Prefer: respond-async`.
 *   3. The sealed input is ciphertext at rest and is dropped when the run
 *      finishes.
 *   4. A run is its owner's: another account's poll is the same 404 as a run
 *      that does not exist.
 *   5. Consent withdrawn while a run waited stops it in the worker, before
 *      anything reaches a model.
 *   6. The reaper fails a run no worker took (and hands its reservation back)
 *      and deletes a finished run an hour after it ended.
 */
import { Buffer } from "node:buffer";

import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { encrypt } from "@/lib/crypto";

import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";

vi.mock("next/headers", async () => {
  const { cookieJar, headerJar } = await import("./mock-next-headers");
  return {
    headers: vi.fn(async () => ({
      get: (name: string) => headerJar.get(name.toLowerCase()) ?? null,
    })),
    cookies: vi.fn(async () => ({
      get: (name: string) => {
        const value = cookieJar.get(name);
        return value ? { name, value } : undefined;
      },
      set: (name: string, value: string) => {
        cookieJar.set(name, value);
      },
      delete: (name: string) => {
        cookieJar.delete(name);
      },
    })),
  };
});

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

const queue = vi.hoisted(() => ({
  up: true,
  send: vi.fn(async () => "job-1"),
}));
vi.mock("@/lib/jobs/boss-instance", () => ({
  getGlobalBoss: () => (queue.up ? { send: queue.send } : null),
}));
const send = queue.send;

vi.mock("@/lib/documents/describe", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/documents/describe")>()),
  transcribeDocument: vi.fn(async () => ({
    text: "Entlassbrief Leukozyten erhoeht",
  })),
}));
vi.mock("@/lib/labs/ocr-extract", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/labs/ocr-extract")>()),
  runOcrExtraction: vi.fn(async () => ({
    reportDate: "2027-01-10",
    providerType: "anthropic",
    rows: [],
  })),
}));
vi.mock("@/lib/documents/auto-stage-labs", () => ({
  maybeAutoStageLabFacts: vi.fn(async () => ({
    staged: false,
    reason: "not-lab",
  })),
}));

import { transcribeDocument } from "@/lib/documents/describe";
import { runOcrExtraction } from "@/lib/labs/ocr-extract";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQABXvMqOgAAAABJRU5ErkJggg==",
  "base64",
);

let counter = 0;

async function makeUser() {
  const suffix = `r-${counter++}`;
  return getPrismaClient().user.create({
    data: {
      username: `runs-${suffix}`,
      email: `runs-${suffix}@example.test`,
      role: "USER",
      timezone: "UTC",
      locale: "en",
      onboardingCompletedAt: new Date(),
      aiProvider: "ANTHROPIC",
      aiModel: "claude-sonnet-4-6",
      aiAnthropicKeyEncrypted: encrypt("sk-ant-integration-test"),
      labsLocalOcrEnabled: true,
      modulePreferencesJson: { inboundDocuments: true, labs: true },
    },
  });
}

async function grantConsent(userId: string) {
  return getPrismaClient().consentReceipt.create({
    data: {
      userId,
      kind: "ai_extraction",
      artefact: "test",
      signedAt: new Date(),
    },
  });
}

async function signIn(userId: string) {
  const session = await getPrismaClient().session.create({
    data: { userId, expiresAt: new Date(Date.now() + 600_000) },
  });
  cookieJar.set("healthlog_session", session.id);
}

async function storeDocument(userId: string) {
  const { encryptDocumentContent } = await import("@/lib/documents/store");
  const { content, codec } = encryptDocumentContent(PNG);
  return getPrismaClient().inboundDocument.create({
    data: {
      userId,
      kind: "OTHER",
      filename: "letter.png",
      mimeType: "image/png",
      byteSize: PNG.byteLength,
      status: "STORED",
      contentEncrypted: content,
      contentCodec: codec,
    },
  });
}

interface Envelope<T = unknown> {
  data: T;
  error: string | null;
  meta?: Record<string, unknown>;
}

async function postIndex(documentId: string, prefer: boolean) {
  const { POST } = await import("@/app/api/documents/inbound/[id]/index/route");
  const { NextRequest } = await import("next/server");
  const res = await POST(
    new NextRequest(
      `http://localhost/api/documents/inbound/${documentId}/index`,
      {
        method: "POST",
        headers: prefer ? { prefer: "respond-async" } : {},
      },
    ) as never,
    { params: Promise.resolve({ id: documentId }) } as never,
  );
  return {
    status: res.status,
    headers: res.headers,
    body: (await res.json()) as Envelope,
  };
}

async function postLabScanText(text: string) {
  const { POST } = await import("@/app/api/labs/ocr/extract/route");
  const res = await POST(
    new Request("http://localhost/api/labs/ocr/extract", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "text", text }),
    }) as never,
  );
  return { status: res.status, body: (await res.json()) as Envelope };
}

async function poll(runId: string) {
  const { GET } = await import("@/app/api/ai-runs/[id]/route");
  const res = await GET(
    new Request(`http://localhost/api/ai-runs/${runId}`) as never,
    { params: Promise.resolve({ id: runId }) } as never,
  );
  return {
    status: res.status,
    body: (await res.json()) as Envelope<Record<string, unknown>>,
  };
}

async function work(runId: string) {
  const { runDocumentAiRun } = await import("@/lib/jobs/document-ai-run");
  return runDocumentAiRun(runId, Date.now() + 45 * 60_000);
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
  queue.up = true;
  send.mockClear();
  vi.mocked(transcribeDocument).mockClear();
  vi.mocked(runOcrExtraction).mockClear();
});

describe("Read with AI in the background", () => {
  it("queues, runs in the worker, and serves the route's own body", async () => {
    const user = await makeUser();
    await grantConsent(user.id);
    const document = await storeDocument(user.id);
    await signIn(user.id);

    const queued = await postIndex(document.id, true);
    expect(queued.status).toBe(202);
    expect(queued.headers.get("preference-applied")).toBe("respond-async");
    const { runId } = queued.body.data as { runId: string };
    expect(queued.headers.get("location")).toBe(`/api/ai-runs/${runId}`);
    expect(transcribeDocument).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledOnce();

    const waiting = await poll(runId);
    expect(waiting.status).toBe(200);
    expect(waiting.body.data).toMatchObject({
      status: "QUEUED",
      kind: "DOCUMENT_INDEX",
      documentId: document.id,
      result: null,
    });

    // A second press while the read is queued attaches to the same run.
    const again = await postIndex(document.id, true);
    expect(again.status).toBe(202);
    expect((again.body.data as { runId: string }).runId).toBe(runId);
    expect(send).toHaveBeenCalledOnce();

    expect(await work(runId)).toBe("succeeded");
    expect(transcribeDocument).toHaveBeenCalledOnce();

    const done = await poll(runId);
    expect(done.body.data).toMatchObject({
      status: "SUCCEEDED",
      error: null,
      retryAfterMs: null,
      result: {
        documentId: document.id,
        indexed: true,
        labFactsStaged: 0,
      },
    });
    const index = await getPrismaClient().documentContentIndex.findUnique({
      where: { documentId: document.id },
    });
    expect(index).not.toBeNull();
  });

  it("answers synchronously, exactly as before, without the header", async () => {
    const user = await makeUser();
    await grantConsent(user.id);
    const document = await storeDocument(user.id);
    await signIn(user.id);

    const res = await postIndex(document.id, false);
    expect(res.status).toBe(200);
    expect(res.headers.get("preference-applied")).toBeNull();
    expect(res.body.data).toMatchObject({
      documentId: document.id,
      indexed: true,
      labFactsStaged: 0,
    });
    expect(send).not.toHaveBeenCalled();
    expect(await getPrismaClient().documentAiRun.count()).toBe(0);
  });

  it("stops in the worker when consent was withdrawn while the run waited", async () => {
    const user = await makeUser();
    const receipt = await grantConsent(user.id);
    const document = await storeDocument(user.id);
    await signIn(user.id);

    const queued = await postIndex(document.id, true);
    const { runId } = queued.body.data as { runId: string };
    await getPrismaClient().consentReceipt.update({
      where: { id: receipt.id },
      data: { revokedAt: new Date() },
    });

    expect(await work(runId)).toBe("failed");
    expect(transcribeDocument).not.toHaveBeenCalled();
    const done = await poll(runId);
    expect(done.body.data).toMatchObject({
      status: "FAILED",
      result: null,
      error: { code: "consent.ai.required", status: 403 },
    });
  });

  it("answers 503 and leaves no live run when no worker queue is reachable", async () => {
    const user = await makeUser();
    await grantConsent(user.id);
    const document = await storeDocument(user.id);
    await signIn(user.id);
    queue.up = false;

    const res = await postIndex(document.id, true);
    expect(res.status).toBe(503);
    expect(res.body.meta?.errorCode).toBe("aiRuns.workerUnavailable");
    const live = await getPrismaClient().documentAiRun.count({
      where: { status: { in: ["QUEUED", "RUNNING"] } },
    });
    expect(live).toBe(0);
  });
});

describe("a lab scan in the background", () => {
  it("seals the text, reads it in the worker, drops the input, serves the rows", async () => {
    const user = await makeUser();
    await grantConsent(user.id);
    await signIn(user.id);

    const queued = await postLabScanText("Hämoglobin 14,2 g/dL");
    expect(queued.status).toBe(202);
    const { runId } = queued.body.data as { runId: string };

    const stored = await getPrismaClient().documentAiRun.findUniqueOrThrow({
      where: { id: runId },
    });
    expect(stored.kind).toBe("LABS_OCR_EXTRACT");
    expect(stored.inputEncrypted).not.toBeNull();
    expect(Buffer.from(stored.inputEncrypted!).toString("utf8")).not.toContain(
      "Hämoglobin",
    );
    expect(JSON.stringify(stored.paramsJson)).not.toContain("Hämoglobin");

    expect(await work(runId)).toBe("succeeded");
    expect(runOcrExtraction).toHaveBeenCalledWith(
      expect.objectContaining({ ocrText: "Hämoglobin 14,2 g/dL" }),
    );

    const after = await getPrismaClient().documentAiRun.findUniqueOrThrow({
      where: { id: runId },
    });
    expect(after.inputEncrypted).toBeNull();
    expect(after.resultEncrypted).not.toBeNull();
    expect(Buffer.from(after.resultEncrypted!).toString("utf8")).not.toContain(
      "2027-01-10",
    );

    const done = await poll(runId);
    expect(done.body.data).toMatchObject({
      status: "SUCCEEDED",
      kind: "LABS_OCR_EXTRACT",
      documentId: null,
      result: { reportDate: "2027-01-10", providerType: "anthropic", rows: [] },
    });
  });
});

describe("whose run it is", () => {
  it("is the same 404 for another account's run and for no run", async () => {
    const owner = await makeUser();
    await grantConsent(owner.id);
    await signIn(owner.id);
    const queued = await postLabScanText("Glucose 95 mg/dL");
    const { runId } = queued.body.data as { runId: string };

    const other = await makeUser();
    await signIn(other.id);
    const foreign = await poll(runId);
    expect(foreign.status).toBe(404);
    expect(foreign.body.meta?.errorCode).toBe("aiRuns.notFound");

    const missing = await poll("does-not-exist");
    expect(missing.status).toBe(404);
    expect(missing.body.meta?.errorCode).toBe("aiRuns.notFound");

    await signIn(owner.id);
    expect((await poll(runId)).status).toBe(200);
  });
});

describe("the reaper", () => {
  it("fails a run no worker took and hands its reservation back", async () => {
    const user = await makeUser();
    await grantConsent(user.id);
    await signIn(user.id);
    const queued = await postLabScanText("Glucose 95 mg/dL");
    const { runId } = queued.body.data as { runId: string };

    const { readDailySpend, buildDateKey } =
      await import("@/lib/ai/coach/budget");
    expect(
      (await readDailySpend(user.id, buildDateKey())).total,
    ).toBeGreaterThan(0);

    const { reapAiRuns } = await import("@/lib/documents/ai-runs/store");
    const later = new Date(Date.now() + 16 * 60_000);
    expect(await reapAiRuns(later)).toEqual({
      workerUnavailable: 1,
      timedOut: 0,
      deleted: 0,
    });
    expect((await readDailySpend(user.id, buildDateKey())).total).toBe(0);

    const run = await getPrismaClient().documentAiRun.findUniqueOrThrow({
      where: { id: runId },
    });
    expect(run.status).toBe("FAILED");
    expect(run.errorCode).toBe("aiRuns.workerUnavailable");
    expect(run.inputEncrypted).toBeNull();

    // A worker that turns up late finds nothing to claim.
    expect(await work(runId)).toBe("skipped");
    expect(runOcrExtraction).not.toHaveBeenCalled();
  });

  it("deletes a finished run an hour after it ended, and the poll stops serving it first", async () => {
    const user = await makeUser();
    await grantConsent(user.id);
    await signIn(user.id);
    const queued = await postLabScanText("Glucose 95 mg/dL");
    const { runId } = queued.body.data as { runId: string };
    expect(await work(runId)).toBe("succeeded");

    await getPrismaClient().documentAiRun.update({
      where: { id: runId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    // Past its retention the run is gone for the client even before the
    // reaper's tick.
    expect((await poll(runId)).status).toBe(404);

    const { reapAiRuns } = await import("@/lib/documents/ai-runs/store");
    const summary = await reapAiRuns();
    expect(summary.deleted).toBe(1);
    expect(
      await getPrismaClient().documentAiRun.findUnique({
        where: { id: runId },
      }),
    ).toBeNull();
  });
});
