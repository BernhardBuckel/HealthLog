/**
 * ntfy sender unit tests.
 *
 * Covers the outbound shape (a JSON publish to the server root carrying
 * topic, priority and tags, bearer token), the outcome classification, and (#947) the
 * NOTIFICATION_PRIVATE_ORIGINS grant: a listed server rides the
 * operator-approved pin, an unlisted one keeps the public pin, and a listed
 * origin admits nothing beside itself.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const safeFetchMock = vi.fn();
const recordPushAttemptMock = vi.fn();
const annotateMock = vi.fn();

vi.mock("@/lib/safe-fetch", () => ({
  safeFetch: (...args: unknown[]) => safeFetchMock(...args),
  SafeFetchError: class SafeFetchError extends Error {
    kind: string;
    constructor(message: string, kind: string) {
      super(message);
      this.kind = kind;
    }
  },
}));

vi.mock("@/lib/logging/context", () => ({
  getEvent: () => ({
    addWarning: vi.fn(),
    addExternalCall: vi.fn(),
    hasAction: () => false,
  }),
  annotate: (...args: unknown[]) => annotateMock(...args),
}));

vi.mock("@/lib/notifications/senders/push-attempt-record", () => ({
  recordPushAttempt: (...args: unknown[]) => recordPushAttemptMock(...args),
  recordPushAttemptForPayload: (
    _payload: unknown,
    _recipientUserId: string,
    attempt: unknown,
  ) => recordPushAttemptMock(attempt),
}));

import { sendViaNtfy } from "../ntfy";
import { SafeFetchError } from "@/lib/safe-fetch";

const config = {
  serverUrl: "https://ntfy.example.com/",
  topic: "health",
  authToken: "tk_secret",
};

function payload(over?: Record<string, unknown>) {
  return {
    eventType: "SYSTEM_ALERT" as const,
    userId: "user-1",
    title: "Title",
    message: "<b>Body</b>",
    ...over,
  };
}

type EgressOpts = {
  requirePublicHost?: boolean;
  operatorApprovedPrivateOrigin?: string;
};

const ORIGINAL_PRIVATE_ORIGINS = process.env.NOTIFICATION_PRIVATE_ORIGINS;

beforeEach(() => {
  safeFetchMock.mockReset();
  recordPushAttemptMock.mockReset();
  annotateMock.mockReset();
  delete process.env.NOTIFICATION_PRIVATE_ORIGINS;
});

afterEach(() => {
  vi.clearAllMocks();
  if (ORIGINAL_PRIVATE_ORIGINS === undefined) {
    delete process.env.NOTIFICATION_PRIVATE_ORIGINS;
  } else {
    process.env.NOTIFICATION_PRIVATE_ORIGINS = ORIGINAL_PRIVATE_ORIGINS;
  }
});

describe("sendViaNtfy", () => {
  it("POSTs a JSON message to the server root through safeFetch under the public pin and returns ok on 200", async () => {
    safeFetchMock.mockResolvedValue({ ok: true, status: 200 });

    const result = await sendViaNtfy(config, payload());

    expect(result).toEqual({ ok: true, statusCode: 200 });
    const [url, init, opts] = safeFetchMock.mock.calls[0] as [
      string,
      { method?: string; headers?: Record<string, string>; body?: string },
      EgressOpts,
    ];
    expect(url).toBe("https://ntfy.example.com/");
    expect(init.method).toBe("POST");
    expect(init.headers?.Authorization).toBe("Bearer tk_secret");
    expect(init.headers?.["Content-Type"]).toBe("application/json");
    expect(JSON.parse(init.body!)).toEqual({
      topic: "health",
      title: "Title",
      message: "Body",
      priority: 3,
      tags: ["system-alert"],
    });
    expect(opts.requirePublicHost).toBe(true);
    expect(opts.operatorApprovedPrivateOrigin).toBeUndefined();
    expect(recordPushAttemptMock).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "NTFY", result: "ok" }),
    );
  });

  it("hard-rejects on 410 (topic gone)", async () => {
    safeFetchMock.mockResolvedValue({ ok: false, status: 410 });

    const result = await sendViaNtfy(config, payload());

    expect(result.ok).toBe(false);
    expect(result.hardReject).toBe(true);
    expect(result.reason).toBe("ntfy_410_gone");
  });

  it("reports a soft, named refusal when safeFetch blocks a private host (SSRF)", async () => {
    safeFetchMock.mockRejectedValue(
      new SafeFetchError("refused private host", "private_host"),
    );

    const result = await sendViaNtfy(config, payload());

    expect(result).toMatchObject({
      ok: false,
      hardReject: false,
      reason: "ntfy_private_origin_refused",
      errorCode: "private_origin_not_approved",
    });
    expect(recordPushAttemptMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "NTFY",
        result: "error",
        reason: "ntfy_private_origin_refused",
      }),
    );
  });

  it("keeps a genuine network fault distinct from a policy refusal", async () => {
    safeFetchMock.mockRejectedValue(new SafeFetchError("timeout", "timeout"));

    const result = await sendViaNtfy(config, payload());

    expect(result.reason).toBe("ntfy_network_error");
    expect(result.errorCode).toBeUndefined();
  });

  describe("NOTIFICATION_PRIVATE_ORIGINS (#947)", () => {
    it("dials a listed server through the operator-approved pin and marks the event", async () => {
      process.env.NOTIFICATION_PRIVATE_ORIGINS = "http://ntfy.lan:8080";
      safeFetchMock.mockResolvedValue({ ok: true, status: 200 });

      const result = await sendViaNtfy(
        { serverUrl: "http://ntfy.lan:8080", topic: "health" },
        payload(),
      );

      expect(result.ok).toBe(true);
      const [url, , opts] = safeFetchMock.mock.calls[0] as [
        string,
        unknown,
        EgressOpts,
      ];
      expect(url).toBe("http://ntfy.lan:8080/");
      expect(opts.requirePublicHost).toBe(false);
      expect(opts.operatorApprovedPrivateOrigin).toBe("http://ntfy.lan:8080");
      expect(annotateMock).toHaveBeenCalledWith({
        action: { name: "notification.egress.private_origin" },
      });
      expect(annotateMock).toHaveBeenCalledWith({
        meta: { channel: "ntfy", origin: "http://ntfy.lan:8080" },
      });
    });

    it("keeps the public pin for a server the operator did not list", async () => {
      process.env.NOTIFICATION_PRIVATE_ORIGINS = "https://gotify.example.com";
      safeFetchMock.mockResolvedValue({ ok: true, status: 200 });

      await sendViaNtfy(config, payload());

      const [, , opts] = safeFetchMock.mock.calls[0] as [
        string,
        unknown,
        EgressOpts,
      ];
      expect(opts.requirePublicHost).toBe(true);
      expect(opts.operatorApprovedPrivateOrigin).toBeUndefined();
      expect(annotateMock).not.toHaveBeenCalled();
    });

    it.each([
      ["sibling port", "http://ntfy.lan:9090"],
      ["other scheme", "https://ntfy.lan:8080"],
      ["sub-host", "http://push.ntfy.lan:8080"],
      ["unlisted private literal", "http://192.168.1.9"],
    ])(
      "refuses a %s without dialling: a listed origin admits only itself",
      async (_label, serverUrl) => {
        process.env.NOTIFICATION_PRIVATE_ORIGINS = "http://ntfy.lan:8080";

        const result = await sendViaNtfy(
          { serverUrl, topic: "health" },
          payload(),
        );

        expect(safeFetchMock).not.toHaveBeenCalled();
        expect(result).toMatchObject({
          ok: false,
          hardReject: false,
          reason: "ntfy_private_origin_refused",
          errorCode: "private_origin_not_approved",
        });
        expect(annotateMock).not.toHaveBeenCalled();
      },
    );
  });

  it("reports the not-grantable code for a metadata target, without dialling (M1)", async () => {
    const result = await sendViaNtfy(
      { serverUrl: "http://169.254.169.254", topic: "health" },
      payload(),
    );

    expect(safeFetchMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      ok: false,
      hardReject: false,
      reason: "ntfy_private_origin_refused",
      errorCode: "private_origin_not_grantable",
    });
  });
});

describe("sendViaNtfy — what the server said (#947)", () => {
  it("carries a short error body on a non-2xx", async () => {
    safeFetchMock.mockResolvedValue(
      new Response('{"code":40009,"http":400,"error":"invalid request"}', {
        status: 400,
      }),
    );

    const result = await sendViaNtfy(config, payload());

    expect(result).toMatchObject({
      ok: false,
      statusCode: 400,
      upstreamBody: '{"code":40009,"http":400,"error":"invalid request"}',
    });
  });

  it("drops a body that echoes the auth token or the topic", async () => {
    safeFetchMock.mockResolvedValueOnce(
      new Response("token tk_secret rejected", { status: 403 }),
    );
    expect((await sendViaNtfy(config, payload())).upstreamBody).toBeUndefined();

    safeFetchMock.mockResolvedValueOnce(
      new Response("topic health is reserved", { status: 403 }),
    );
    expect((await sendViaNtfy(config, payload())).upstreamBody).toBeUndefined();
  });

  it("names a timeout", async () => {
    safeFetchMock.mockRejectedValue(new SafeFetchError("timed out", "timeout"));
    expect((await sendViaNtfy(config, payload())).failureCode).toBe("timeout");
  });
});

describe("sendViaNtfy — tap target and quick actions", () => {
  function messageOfFirstCall(): Record<string, unknown> {
    const [, init] = safeFetchMock.mock.calls[0] as [
      string,
      { headers: Record<string, string>; body: string },
    ];
    // Nothing of the message rides a header any more.
    expect(Object.keys(init.headers).sort()).toEqual(
      ["Authorization", "Content-Type"].sort(),
    );
    return JSON.parse(init.body) as Record<string, unknown>;
  }

  it("sets click to the resolved absolute tap URL", async () => {
    safeFetchMock.mockResolvedValue({ ok: true, status: 200 });
    await sendViaNtfy(
      config,
      payload({
        eventType: "DAILY_BRIEFING",
        tap: {
          path: "/",
          url: "https://health.example/",
          label: "Open in HealthLog",
        },
      }),
    );
    const message = messageOfFirstCall();
    expect(message.click).toBe("https://health.example/");
    expect(message.actions).toBeUndefined();
  });

  it("omits click when no public origin produced a URL", async () => {
    safeFetchMock.mockResolvedValue({ ok: true, status: 200 });
    await sendViaNtfy(
      config,
      payload({ tap: { path: "/", url: null, label: "Open" } }),
    );
    expect(messageOfFirstCall().click).toBeUndefined();
  });

  it("sends the quick answers as three POST http actions that clear the notification", async () => {
    safeFetchMock.mockResolvedValue({ ok: true, status: 200 });
    await sendViaNtfy(
      config,
      payload({
        eventType: "MOOD_REMINDER",
        quickActions: [
          { id: "mood-good", label: "Good", url: "https://h.example/a/1" },
          { id: "mood-okay", label: "Okay", url: "https://h.example/a/2" },
          { id: "mood-bad", label: "Bad", url: "https://h.example/a/3" },
        ],
      }),
    );
    expect(messageOfFirstCall().actions).toEqual([
      {
        action: "http",
        label: "Good",
        url: "https://h.example/a/1",
        method: "POST",
        clear: true,
      },
      {
        action: "http",
        label: "Okay",
        url: "https://h.example/a/2",
        method: "POST",
        clear: true,
      },
      {
        action: "http",
        label: "Bad",
        url: "https://h.example/a/3",
        method: "POST",
        clear: true,
      },
    ]);
  });

  it("carries non-ASCII titles and labels as plain UTF-8, URLs untouched", async () => {
    safeFetchMock.mockResolvedValue({ ok: true, status: 200 });
    await sendViaNtfy(
      config,
      payload({
        eventType: "MOOD_REMINDER",
        title: "기분은 어떠세요?",
        quickActions: [
          { id: "mood-good", label: "Świetnie", url: "https://h.example/a/1" },
          { id: "mood-okay", label: "보통", url: "https://h.example/a/2" },
          { id: "mood-bad", label: "Così così", url: "https://h.example/a/3" },
        ],
      }),
    );
    const message = messageOfFirstCall();
    expect(message.title).toBe("기분은 어떠세요?");
    const actions = message.actions as { label: string; url: string }[];
    expect(actions.map((a) => a.label)).toEqual([
      "Świetnie",
      "보통",
      "Così così",
    ]);
    expect(actions.map((a) => a.url)).toEqual([
      "https://h.example/a/1",
      "https://h.example/a/2",
      "https://h.example/a/3",
    ]);
    expect(JSON.stringify(message)).not.toContain("=?UTF-8?");
  });
});

describe("ntfy message helpers", () => {
  it("caps the actions at three and keeps labels verbatim", async () => {
    const { buildNtfyActions } = await import("../ntfy");
    const actions = buildNtfyActions({
      quickActions: [
        { id: "mood-good", label: 'Go;od, "yes"', url: "https://h/1" },
        { id: "mood-okay", label: "B", url: "https://h/2" },
        { id: "mood-bad", label: "C", url: "https://h/3" },
        { id: "mood-bad", label: "D", url: "https://h/4" },
      ],
    });
    expect(actions).toHaveLength(3);
    // JSON needs no separator escaping: the label reaches ntfy as written.
    expect(actions[0]!.label).toBe('Go;od, "yes"');
    expect(actions.map((a) => a.url)).not.toContain("https://h/4");
    expect(buildNtfyActions({ quickActions: [] })).toEqual([]);
  });

  it("maps a medication reminder to high priority (4)", async () => {
    const { buildNtfyMessage } = await import("../ntfy");
    expect(
      buildNtfyMessage(
        "t",
        payload({ eventType: "MEDICATION_REMINDER" }) as never,
      ).priority,
    ).toBe(4);
  });
});
