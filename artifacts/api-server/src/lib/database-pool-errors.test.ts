import { EventEmitter } from "node:events";
import { expect, it, vi } from "vitest";
import { observeDatabasePoolErrors } from "./database-pool-errors";

it("observes idle pool failure without a process-level exception handler", () => {
  const pool = new EventEmitter(),
    logger = { error: vi.fn() };
  const before = process.listenerCount("uncaughtException");
  observeDatabasePoolErrors(pool, logger);
  expect(pool.listenerCount("error")).toBe(1);
  expect(() => pool.emit("error", new Error("synthetic outage"))).not.toThrow();
  expect(logger.error).toHaveBeenCalledOnce();
  expect(process.listenerCount("uncaughtException")).toBe(before);
});

it("logs only fixed fields and never driver errors or clients", () => {
  const pool = new EventEmitter(),
    logger = { error: vi.fn() };
  observeDatabasePoolErrors(pool, logger);
  pool.emit(
    "error",
    Object.assign(new Error("private-host password provider body"), {
      connectionString: "postgresql://private-secret@private-host/database",
      detail: "private tenant payload",
    }),
    { password: "private-client-secret" },
  );
  expect(logger.error.mock.calls).toEqual([
    [
      { event: "database_pool_idle_error" },
      "An idle database connection was lost; database readiness may be unavailable",
    ],
  ]);
});

it("does not intercept, retry, or transform normal query failures", async () => {
  const failure = new Error("synthetic query failure");
  const pool = Object.assign(new EventEmitter(), {
    query: vi.fn().mockRejectedValue(failure),
  });
  const originalQuery = pool.query,
    logger = { error: vi.fn() };
  observeDatabasePoolErrors(pool, logger);
  await expect(pool.query("SELECT 1")).rejects.toBe(failure);
  expect(pool.query).toBe(originalQuery);
  expect(pool.query).toHaveBeenCalledOnce();
  expect(logger.error).not.toHaveBeenCalled();
});

it("leaves the pool usable for independent later requests after an idle error", async () => {
  const pool = Object.assign(new EventEmitter(), {
    query: vi.fn().mockResolvedValue({ rows: [{ ready: 1 }] }),
  });
  const logger = { error: vi.fn() };
  observeDatabasePoolErrors(pool, logger);
  pool.emit("error", new Error("synthetic idle disconnect"));
  await expect(pool.query("SELECT 1")).resolves.toEqual({
    rows: [{ ready: 1 }],
  });
  expect(pool.query).toHaveBeenCalledOnce();
});
