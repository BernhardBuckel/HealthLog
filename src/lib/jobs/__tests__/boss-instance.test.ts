import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

interface MockBoss {
  start: Mock<() => Promise<unknown>>;
  stop: Mock<(options?: { graceful?: boolean }) => Promise<void>>;
  on: Mock<(event: string, handler: (error: Error) => void) => MockBoss>;
  emitError(error: Error): void;
}

const { PgBoss, instances, startOutcomes } = vi.hoisted(() => {
  const instances: MockBoss[] = [];
  const startOutcomes: Array<() => Promise<unknown>> = [];
  const PgBoss = vi.fn(function MockPgBoss(this: MockBoss) {
    let errorHandler: ((error: Error) => void) | undefined;
    this.start = vi.fn(() =>
      (startOutcomes.shift() ?? (() => Promise.resolve(undefined)))(),
    );
    this.stop = vi.fn(async () => undefined);
    this.on = vi.fn((event: string, handler: (error: Error) => void) => {
      if (event === "error") errorHandler = handler;
      return this;
    });
    this.emitError = (error: Error) => errorHandler?.(error);
    instances.push(this);
  });
  return { PgBoss, instances, startOutcomes };
});

vi.mock("pg-boss", () => ({ PgBoss }));
import {
  createWorkerBoss,
  getGlobalBoss,
  startGlobalBossProducer,
} from "../boss-instance";

const globalState = globalThis as Record<string, unknown>;

beforeEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  instances.length = 0;
  startOutcomes.length = 0;
  delete globalState.__healthlog_pgboss__;
  delete globalState.__healthlog_pgboss_start__;
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("web-process pg-boss producer", () => {
  it("waits for delayed pg-boss schema readiness with capped exponential backoff", async () => {
    vi.useFakeTimers();
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
    startOutcomes.push(
      () => Promise.reject(new Error("schema not ready")),
      () => Promise.reject(new Error("schema still not ready")),
      () => Promise.reject(new Error("schema still not ready")),
      () => Promise.resolve(undefined),
    );

    const starting = startGlobalBossProducer("postgres://healthlog@test/db", {
      maxAttempts: 4,
      retryBaseDelayMs: 10,
      retryMaxDelayMs: 20,
    });
    await vi.runAllTimersAsync();
    const boss = await starting;

    expect(PgBoss).toHaveBeenCalledTimes(4);
    expect(timeoutSpy.mock.calls.map((call) => call[1])).toEqual([10, 20, 20]);
    expect(PgBoss).toHaveBeenLastCalledWith({
      connectionString: "postgres://healthlog@test/db",
      max: 2,
      connectionTimeoutMillis: 20_000,
      options: "-c TimeZone=UTC",
      migrate: false,
      schedule: false,
      supervise: false,
    });
    expect(boss).toBe(getGlobalBoss());
  });

  it("keeps supervised reconnect active after a bounded failed batch", async () => {
    vi.useFakeTimers();
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
    startOutcomes.push(() => Promise.resolve(undefined));
    await startGlobalBossProducer("postgres://healthlog@test/db", {
      maxAttempts: 2,
      retryBaseDelayMs: 10,
      retryMaxDelayMs: 20,
    });

    startOutcomes.push(
      () => Promise.reject(new Error("db unavailable 1")),
      () => Promise.reject(new Error("db unavailable 2")),
      () => Promise.resolve(undefined),
    );
    instances[0].emitError(new Error("connection lost"));
    await vi.runAllTimersAsync();
    await Promise.resolve();

    expect(PgBoss).toHaveBeenCalledTimes(4);
    expect(timeoutSpy.mock.calls.map((call) => call[1])).toEqual([10, 20]);
    expect(instances[0].stop).toHaveBeenCalledWith({ graceful: false });
    expect(getGlobalBoss()).toBe(instances[3]);
  });
});

describe("worker pg-boss pool", () => {
  it("uses the pg-boss share of the process connection budget", () => {
    createWorkerBoss("postgres://healthlog@test/db");

    expect(PgBoss).toHaveBeenCalledWith({
      connectionString: "postgres://healthlog@test/db",
      max: 2,
      connectionTimeoutMillis: 20_000,
      options: "-c TimeZone=UTC",
    });
  });
});
