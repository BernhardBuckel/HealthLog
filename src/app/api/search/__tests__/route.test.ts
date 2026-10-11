/**
 * `POST /api/search` — admission, validation, the rate limit, one search in
 * flight per actor, and what the route hands the search and the log.
 *
 * The search itself is `searchRecords`, covered by its own unit tests and by
 * `tests/integration/record-search.test.ts` against Postgres; here it is a
 * spy, so the test can assert exactly what the route passes it.
 *
 * Mutation checks (each run, each seen red):
 *   - admit on `("read", "profile")` instead of the whole record → "admits
 *     the whole record only" goes red;
 *   - drop `.min(SEARCH_QUERY_MIN)` → "refuses a one-letter query" goes red;
 *   - put the query into the annotation → "never logs the query" goes red;
 *   - pass `actor.id` as the record → "searches the record the session acts
 *     for" goes red.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  requireRecordAuth: vi.fn(),
  checkRateLimit: vi.fn(),
  searchRecords: vi.fn(),
  annotate: vi.fn(),
  resolveModuleMap: vi.fn(),
  domainVisible: vi.fn(() => true),
}));

vi.mock("@/lib/api-handler", () => ({
  apiHandler: (handler: unknown) => handler,
  requireRecordAuth: mocks.requireRecordAuth,
}));
vi.mock("@/lib/logging/context", () => ({
  annotate: mocks.annotate,
  getEvent: () => undefined,
}));
vi.mock("@/lib/db", () => ({ prisma: {} }));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: mocks.checkRateLimit }));
vi.mock("@/lib/modules/gate", () => ({
  resolveModuleMap: mocks.resolveModuleMap,
}));
vi.mock("@/lib/sharing/acting-domains", () => ({
  actingDomainVisibility: vi.fn(async () => mocks.domainVisible),
}));
vi.mock("@/lib/tz/resolver", () => ({
  resolveUserTimezone: vi.fn(async () => "Europe/Berlin"),
}));
vi.mock("@/lib/search/search-records", () => ({
  searchRecords: mocks.searchRecords,
}));

import { POST } from "../route";
import { searchesInFlight } from "@/lib/search/in-flight";

const handler = POST as unknown as (req: NextRequest) => Promise<Response>;

/**
 * A search request. Written as the query string the route used to take, so
 * every case reads as before; the route receives it as a JSON body.
 */
function request(query: string, init: { signal?: AbortSignal } = {}) {
  const params = new URLSearchParams(query);
  const body: Record<string, unknown> = {};
  for (const [key, value] of params) {
    body[key] = key === "limit" && /^\d+$/.test(value) ? Number(value) : value;
  }
  return new NextRequest("http://localhost/api/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: init.signal,
  });
}

const OWNER = { id: "owner-1", locale: "de" };
const ACTOR = { id: "actor-1", locale: "en" };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireRecordAuth.mockResolvedValue({
    user: OWNER,
    actor: ACTOR,
    grantId: "grant-1",
  });
  mocks.checkRateLimit.mockResolvedValue({ allowed: true });
  mocks.resolveModuleMap.mockResolvedValue({ illness: false });
  mocks.searchRecords.mockResolvedValue({
    groups: [
      {
        kind: "visit",
        hits: [
          {
            id: "visit:v1",
            kind: "visit",
            title: { text: "Schulter", marks: [[0, 8]] },
            context: [],
            snippet: null,
            day: "2026-01-02",
            path: "/checkups?visit=v1",
            source: null,
          },
        ],
        more: false,
      },
    ],
    truncated: false,
    stats: { sources: 12, rows: 40, candidates: 1, elapsedMs: 3 },
  });
});

describe("POST /api/search", () => {
  it("admits the whole record only, at read", async () => {
    await handler(request("q=schulter"));
    expect(mocks.requireRecordAuth).toHaveBeenCalledWith("read", "record");
  });

  it("propagates a refused admission without searching", async () => {
    mocks.requireRecordAuth.mockRejectedValueOnce(new Error("denied"));
    await expect(handler(request("q=schulter"))).rejects.toThrow("denied");
    expect(mocks.searchRecords).not.toHaveBeenCalled();
  });

  it("searches the record the session acts for, with its masks", async () => {
    const res = await handler(request("q=Schulter&limit=7"));
    expect(res.status).toBe(200);
    expect(mocks.searchRecords).toHaveBeenCalledTimes(1);
    const args = mocks.searchRecords.mock.calls[0][0];
    expect(args.recordId).toBe("owner-1");
    expect(args.query).toBe("Schulter");
    expect(args.limit).toBe(7);
    expect(args.modules).toEqual({ illness: false });
    expect(args.domainVisible).toBe(mocks.domainVisible);
    expect(args.timezone).toBe("Europe/Berlin");
    // Labels follow the reader, not the record.
    expect(args.displayLocale).toBe("en");
    const body = await res.json();
    expect(body.data.groups[0].hits[0].path).toBe("/checkups?visit=v1");
    expect(body.data.truncated).toBe(false);
    expect(body.data.stats).toBeUndefined();
  });

  it("defaults the limit", async () => {
    await handler(request("q=knie"));
    expect(mocks.searchRecords.mock.calls[0][0].limit).toBe(5);
  });

  it.each([
    ["a one-letter query", "q=a"],
    ["a blank query", "q=%20%20%20"],
    ["a missing query", "limit=5"],
    ["an over-long query", `q=${"x".repeat(101)}`],
    ["a zero limit", "q=knie&limit=0"],
    ["a limit above the cap", "q=knie&limit=21"],
    ["a non-numeric limit", "q=knie&limit=lots"],
    ["a fractional limit", "q=knie&limit=2.5"],
  ])("refuses %s with 422 and never searches", async (_label, query) => {
    const res = await handler(request(query));
    expect(res.status).toBe(422);
    expect(mocks.searchRecords).not.toHaveBeenCalled();
  });

  it("does not echo a refused query", async () => {
    const secret = "Psychotherapie".repeat(8);
    const res = await handler(request(`q=${secret}`));
    expect(res.status).toBe(422);
    expect(await res.text()).not.toContain("Psychotherapie");
  });

  it("rate limits per actor before reading anything", async () => {
    mocks.checkRateLimit.mockResolvedValueOnce({ allowed: false });
    const res = await handler(request("q=schulter"));
    expect(res.status).toBe(429);
    expect(mocks.checkRateLimit.mock.calls[0][0]).toBe("search:actor-1");
    expect(mocks.searchRecords).not.toHaveBeenCalled();
  });

  it("never logs the query, only its length and the counts", async () => {
    await handler(request("q=Psychotherapie"));
    const logged = JSON.stringify(mocks.annotate.mock.calls);
    expect(logged).not.toMatch(/psychotherapie/i);
    const run = mocks.annotate.mock.calls.find(
      ([e]) => e.action.name === "search.query.run",
    );
    expect(run?.[0].meta).toMatchObject({
      query_length: 14,
      hits: 1,
      groups: 1,
      truncated: false,
      delegated: true,
    });
  });

  it("keeps the query out of the URL", async () => {
    const req = request("q=Psychotherapie");
    expect(req.url).not.toMatch(/psychotherapie/i);
    const res = await handler(req);
    expect(res.status).toBe(200);
    expect(mocks.searchRecords.mock.calls[0][0].query).toBe("Psychotherapie");
  });

  it("refuses a body that is not JSON", async () => {
    const res = await handler(
      new NextRequest("http://localhost/api/search", {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: "q=schulter",
      }),
    );
    expect(res.status).toBe(415);
    expect(mocks.searchRecords).not.toHaveBeenCalled();
  });

  it("allows 20 searches a minute per actor", async () => {
    await handler(request("q=schulter"));
    expect(mocks.checkRateLimit).toHaveBeenCalledWith(
      "search:actor-1",
      20,
      60_000,
    );
  });

  it("hands the search an abort signal that follows the client", async () => {
    const client = new AbortController();
    let seen: AbortSignal | undefined;
    mocks.searchRecords.mockImplementationOnce(async (args) => {
      seen = args.signal;
      client.abort();
      return {
        groups: [],
        truncated: true,
        stats: { sources: 1, rows: 0, candidates: 0, elapsedMs: 1 },
      };
    });
    await handler(request("q=schulter", { signal: client.signal }));
    expect(seen?.aborted).toBe(true);
  });

  it("stops an actor's earlier search when a newer one starts", async () => {
    let release: () => void = () => {};
    let firstSignal: AbortSignal | undefined;
    mocks.searchRecords.mockImplementationOnce(
      (args) =>
        new Promise((resolve) => {
          firstSignal = args.signal;
          release = () =>
            resolve({
              groups: [],
              truncated: true,
              stats: { sources: 1, rows: 0, candidates: 0, elapsedMs: 1 },
            });
        }),
    );
    const first = handler(request("q=schul"));
    await vi.waitFor(() => expect(firstSignal).toBeDefined());
    expect(firstSignal?.aborted).toBe(false);

    const second = await handler(request("q=schulter"));
    expect(second.status).toBe(200);
    expect(firstSignal?.aborted).toBe(true);

    release();
    const superseded = await first;
    expect(superseded.status).toBe(409);
    expect((await superseded.json()).meta?.errorCode).toBe("search.superseded");
    expect(searchesInFlight()).toBe(0);
  });

  it("does not stop another actor's search", async () => {
    let firstSignal: AbortSignal | undefined;
    let release: () => void = () => {};
    mocks.searchRecords.mockImplementationOnce(
      (args) =>
        new Promise((resolve) => {
          firstSignal = args.signal;
          release = () =>
            resolve({
              groups: [],
              truncated: false,
              stats: { sources: 1, rows: 0, candidates: 0, elapsedMs: 1 },
            });
        }),
    );
    const first = handler(request("q=schul"));
    await vi.waitFor(() => expect(firstSignal).toBeDefined());

    mocks.requireRecordAuth.mockResolvedValueOnce({
      user: { id: "owner-2", locale: "de" },
      actor: { id: "actor-2", locale: "de" },
      grantId: null,
    });
    await handler(request("q=knie"));
    expect(firstSignal?.aborted).toBe(false);
    release();
    expect((await first).status).toBe(200);
  });
});
