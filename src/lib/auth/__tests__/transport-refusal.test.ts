import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logging/context", () => ({ annotate: vi.fn() }));

import { isLocalhostHost, transportVerdict } from "@/lib/auth/client-transport";
import {
  cookieCannotStick,
  INSECURE_TRANSPORT_CODE,
  refuseWhenCookieCannotStick,
} from "@/lib/auth/transport-refusal";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("isLocalhostHost", () => {
  it.each([
    "localhost",
    "localhost:3000",
    "app.localhost:8080",
    "127.0.0.1",
    "127.0.0.1:3000",
    "127.1.2.3",
    "[::1]",
    "[::1]:3000",
    "LOCALHOST",
  ])("treats %s as loopback", (host) => {
    expect(isLocalhostHost(host)).toBe(true);
  });

  it.each([
    "192.168.1.20:3000",
    "truenas.local:30180",
    "healthlog.example.com",
    "10.0.0.5",
    "127.0.0.1.nip.io",
    "localhost.example.com",
    "[fe80::1]:3000",
  ])("treats %s as a network address", (host) => {
    expect(isLocalhostHost(host)).toBe(false);
  });
});

describe("transportVerdict", () => {
  const http = (host: string) => ({ protocol: "http" as const, host });
  it("blocks plain http on a network address when cookies are Secure", () => {
    expect(transportVerdict(true, http("192.168.1.20:3000"))).toBe("blocked");
  });
  it("only notes plain http on localhost", () => {
    expect(transportVerdict(true, http("localhost:3000"))).toBe("soft");
  });
  it("passes https, non-Secure cookies, and an unknown transport", () => {
    expect(
      transportVerdict(true, { protocol: "https", host: "nas.local" }),
    ).toBe("ok");
    expect(transportVerdict(false, http("192.168.1.20:3000"))).toBe("ok");
    expect(transportVerdict(true, undefined)).toBe("ok");
  });
});

describe("refuseWhenCookieCannotStick", () => {
  const body = (protocol: string, host = "192.168.1.20:3000") => ({
    email: "a",
    password: "b",
    clientTransport: { protocol, host },
  });

  it("refuses http + Secure with 409 and the code", async () => {
    vi.stubEnv("SESSION_COOKIE_SECURE", "true");
    const response = refuseWhenCookieCannotStick(body("http"));
    expect(response?.status).toBe(409);
    const json = await response!.json();
    expect(json.meta).toEqual({
      errorCode: INSECURE_TRANSPORT_CODE,
      sessionCookieSecure: true,
    });
  });

  it("passes https, localhost, a body without the field, and SESSION_COOKIE_SECURE=false", () => {
    vi.stubEnv("SESSION_COOKIE_SECURE", "true");
    expect(refuseWhenCookieCannotStick(body("https"))).toBeNull();
    expect(
      refuseWhenCookieCannotStick(body("http", "localhost:3000")),
    ).toBeNull();
    expect(
      refuseWhenCookieCannotStick({ email: "a", password: "b" }),
    ).toBeNull();
    expect(refuseWhenCookieCannotStick(null)).toBeNull();
    vi.stubEnv("SESSION_COOKIE_SECURE", "false");
    expect(cookieCannotStick(body("http"))).toBe(false);
  });

  it("ignores a malformed field rather than refusing on it", () => {
    vi.stubEnv("SESSION_COOKIE_SECURE", "true");
    expect(
      cookieCannotStick({ clientTransport: { protocol: "gopher", host: "x" } }),
    ).toBe(false);
    expect(cookieCannotStick({ clientTransport: "http" })).toBe(false);
  });

  it("follows NODE_ENV when SESSION_COOKIE_SECURE is unset", () => {
    vi.stubEnv("SESSION_COOKIE_SECURE", "");
    vi.stubEnv("NODE_ENV", "production");
    expect(cookieCannotStick(body("http"))).toBe(true);
  });
});
