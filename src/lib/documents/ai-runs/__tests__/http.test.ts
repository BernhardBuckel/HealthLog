/**
 * The HTTP edges of a background run: which requests asked for it, and the
 * 202 they get.
 */
import { describe, expect, it } from "vitest";

import { AiUnavailableError } from "@/lib/ai/capabilities/refusal";
import {
  acceptedRunResponse,
  outcomeResponse,
  prefersRespondAsync,
  refusalAsFailure,
  workerUnavailableResponse,
} from "@/lib/documents/ai-runs/http";

const req = (prefer?: string) =>
  new Request("http://localhost/x", {
    method: "POST",
    headers: prefer === undefined ? {} : { Prefer: prefer },
  });

describe("prefersRespondAsync", () => {
  it("reads RFC 7240 preferences, case-insensitively and among others", () => {
    expect(prefersRespondAsync(req("respond-async"))).toBe(true);
    expect(prefersRespondAsync(req("Respond-Async"))).toBe(true);
    expect(prefersRespondAsync(req("return=minimal, respond-async"))).toBe(
      true,
    );
    expect(prefersRespondAsync(req("respond-async; wait=10"))).toBe(true);
  });

  it("keeps the synchronous path for every other request", () => {
    expect(prefersRespondAsync(req())).toBe(false);
    expect(prefersRespondAsync(req("return=minimal"))).toBe(false);
    expect(prefersRespondAsync(req("respond-asynchronously"))).toBe(false);
  });
});

describe("acceptedRunResponse", () => {
  it("answers 202 with the run, the poll address and the applied preference", async () => {
    const res = acceptedRunResponse("run1");
    expect(res.status).toBe(202);
    expect(res.headers.get("Preference-Applied")).toBe("respond-async");
    expect(res.headers.get("Location")).toBe("/api/ai-runs/run1");
    expect(await res.json()).toEqual({
      data: { runId: "run1", status: "QUEUED", pollAfterMs: 1500 },
      error: null,
    });
  });
});

describe("outcomes", () => {
  it("renders a failure as the route's own envelope", async () => {
    const res = outcomeResponse({
      ok: false,
      status: 422,
      message: "Couldn't read the stored document.",
      errorCode: "documents.inbound.extractFailed",
    });
    expect(res.status).toBe(422);
    expect((await res.json()).meta).toEqual({
      errorCode: "documents.inbound.extractFailed",
    });
  });

  it("keeps a capability refusal's status and code", () => {
    expect(
      refusalAsFailure(new AiUnavailableError("labsOcr", "consent_required")),
    ).toEqual({
      status: 403,
      message: "AI consent is required for this feature",
      errorCode: "consent.ai.required",
    });
    expect(refusalAsFailure(new Error("x"))).toBeNull();
  });

  it("names the missing worker", async () => {
    const res = workerUnavailableResponse();
    expect(res.status).toBe(503);
    expect((await res.json()).meta.errorCode).toBe("aiRuns.workerUnavailable");
  });
});
