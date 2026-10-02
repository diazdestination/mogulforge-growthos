import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
const clientConstructor = vi.hoisted(() => vi.fn());
vi.mock("pg", () => ({ default: { Client: clientConstructor } }));
import {
  createReadinessProbe,
  READINESS_CHECK_MS,
  READINESS_CLOSE_MS,
  READINESS_QUERY_MS,
} from "./readiness";

function client() {
  return Object.assign(new EventEmitter(), {
    connect: vi.fn(async () => {}),
    query: vi.fn(async () => ({ rows: [{ ready: 1 }] })),
    end: vi.fn(async () => {}),
  });
}
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

it("performs only SELECT 1, closes its isolated client, and coalesces/caches requests", async () => {
  let now = 0;
  const selected = client(),
    createClient = vi.fn(() => selected),
    check = createReadinessProbe({ createClient, now: () => now });
  expect(await Promise.all([check(), check(), check()])).toEqual([
    true,
    true,
    true,
  ]);
  expect(createClient).toHaveBeenCalledOnce();
  expect(selected.end).toHaveBeenCalledOnce();
  expect(selected.query).toHaveBeenCalledWith({
    text: "SELECT 1 AS ready",
    query_timeout: READINESS_QUERY_MS,
  });
  expect(await check()).toBe(true);
  expect(createClient).toHaveBeenCalledOnce();
  now = 1001;
  expect(await check()).toBe(true);
  expect(createClient).toHaveBeenCalledTimes(2);
});
it.each(["connect", "query"] as const)(
  "returns failure and closes on %s errors without exposing their contents",
  async (method) => {
    const selected = client();
    selected[method].mockRejectedValue(
      new Error("DATABASE_URL secret password provider-body"),
    );
    expect(await createReadinessProbe({ createClient: () => selected })()).toBe(
      false,
    );
    expect(selected.end).toHaveBeenCalledOnce();
  },
);
it("returns failure for malformed success data or asynchronous client failure", async () => {
  const malformed = client();
  malformed.query.mockResolvedValue({ rows: [] });
  expect(await createReadinessProbe({ createClient: () => malformed })()).toBe(
    false,
  );
  const failed = client();
  failed.connect.mockImplementation(async () => {
    failed.emit("error", new Error("SECRET"));
  });
  expect(await createReadinessProbe({ createClient: () => failed })()).toBe(
    false,
  );
});
it.each(["connect", "query"] as const)(
  "bounds a hung %s and attempts client cleanup",
  async (method) => {
    vi.useFakeTimers();
    const selected = client();
    selected[method].mockImplementation(() => new Promise<never>(() => {}));
    const check = createReadinessProbe({ createClient: () => selected })();
    await vi.advanceTimersByTimeAsync(READINESS_CHECK_MS);
    expect(await check).toBe(false);
    expect(selected.end).toHaveBeenCalledOnce();
  },
);
it("does not start a query if a connection completes after the deadline", async () => {
  vi.useFakeTimers();
  let finish!: () => void;
  const selected = client();
  selected.connect.mockImplementation(
    () =>
      new Promise<void>((done) => {
        finish = done;
      }),
  );
  const check = createReadinessProbe({ createClient: () => selected })();
  await vi.advanceTimersByTimeAsync(READINESS_CHECK_MS);
  expect(await check).toBe(false);
  finish();
  await Promise.resolve();
  expect(selected.query).not.toHaveBeenCalled();
});
it("bounds cleanup and opens no further client until a pending close really completes", async () => {
  vi.useFakeTimers();
  let finish!: () => void;
  const selected = client();
  selected.end.mockImplementation(
    () =>
      new Promise<void>((done) => {
        finish = done;
      }),
  );
  const createClient = vi.fn(() => selected),
    check = createReadinessProbe({ createClient });
  const first = check();
  await vi.advanceTimersByTimeAsync(READINESS_CLOSE_MS);
  expect(await first).toBe(false);
  await vi.advanceTimersByTimeAsync(2000);
  expect(await check()).toBe(false);
  expect(createClient).toHaveBeenCalledOnce();
  selected.end.mockResolvedValue();
  finish();
  await vi.advanceTimersByTimeAsync(0);
  expect(await check()).toBe(true);
  expect(createClient).toHaveBeenCalledTimes(2);
});
it("fails closed without accumulating clients after rejected cleanup", async () => {
  const selected = client();
  selected.end.mockRejectedValue(new Error("private close failure"));
  const createClient = vi.fn(() => selected),
    check = createReadinessProbe({ createClient });
  expect(await check()).toBe(false);
  expect(await check()).toBe(false);
  expect(createClient).toHaveBeenCalledOnce();
});
it("uses bounded driver options without PgBouncer-incompatible startup parameters", async () => {
  vi.stubEnv("DATABASE_URL", "postgresql://synthetic@127.0.0.1/synthetic");
  clientConstructor.mockImplementation(function () {
    return client();
  });
  expect(await createReadinessProbe()()).toBe(true);
  expect(clientConstructor).toHaveBeenCalledWith({
    connectionString: "postgresql://synthetic@127.0.0.1/synthetic",
    connectionTimeoutMillis: 1000,
    query_timeout: 750,
  });
});
it("does not fall back to ambient PostgreSQL settings when DATABASE_URL is missing", async () => {
  vi.stubEnv("DATABASE_URL", "");
  expect(await createReadinessProbe()()).toBe(false);
  expect(clientConstructor).not.toHaveBeenCalled();
});
