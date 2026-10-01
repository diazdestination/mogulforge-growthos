import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";
import { trackPgliteSocketCleanup } from "./pglite-socket-cleanup.mjs";

const turn = () => new Promise((done) => setImmediate(done));
function gate() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture() {
  const pending = gate();
  class Handler {
    isAttached = true;
    detach() { return pending.promise.then(() => { this.isAttached = false; return this; }); }
  }
  const server = { getStats: () => ({ activeConnections: 0, queuedQueries: 0 }), stop: vi.fn(async () => {}) };
  return { pending, Handler, server, original: Handler.prototype.detach };
}

describe("test-only PGlite socket lifecycle", () => {
  it("waits for the actual detach promise even after active handler count becomes zero", async () => {
    const f = fixture(), cleanup = trackPgliteSocketCleanup(f.server, f.Handler), handler = new f.Handler();
    const detach = handler.detach(), stop = cleanup.stop();
    let finished = false; stop.then(() => { finished = true; });
    await turn(); await turn();
    expect(f.server.stop).not.toHaveBeenCalled(); expect(finished).toBe(false);
    f.pending.resolve(); await detach; await stop;
    expect(f.server.stop).toHaveBeenCalledOnce(); expect(handler.isAttached).toBe(false);
    expect(f.Handler.prototype.detach).toBe(f.original);
    expect(cleanup.stop()).toBe(stop);
  });
  it("includes a late/repeated detach queued by the listener close callback", async () => {
    const f = fixture(), cleanup = trackPgliteSocketCleanup(f.server, f.Handler), handler = new f.Handler();
    f.server.stop.mockImplementation(async () => { setImmediate(() => { void handler.detach(); void handler.detach(); }); });
    const stop = cleanup.stop();
    let finished = false; stop.then(() => { finished = true; });
    await turn(); await turn(); await turn();
    expect(f.server.stop).toHaveBeenCalledOnce(); expect(finished).toBe(false);
    f.pending.resolve(); await stop;
    expect(handler.isAttached).toBe(false); expect(f.Handler.prototype.detach).toBe(f.original);
  });
  it.each([new Error("deterministic detach failure"), undefined])("reports every detach rejection instead of hiding it: %s", async (cause) => {
    const f = fixture(), cleanup = trackPgliteSocketCleanup(f.server, f.Handler), handler = new f.Handler();
    // Model the library's unawaited call. The adapter must surface its rejection
    // from the awaited stop(), rather than allowing a late unhandled rejection.
    void handler.detach();
    f.pending.reject(cause);
    const error = await cleanup.stop().catch((error) => error);
    expect(error).toBeInstanceOf(AggregateError);
    expect(error.errors).toEqual([cause]); expect(f.Handler.prototype.detach).toBe(f.original);
  });
  it("fails boundedly if a recorded detach never finishes", async () => {
    const f = fixture(), cleanup = trackPgliteSocketCleanup(f.server, f.Handler, { timeoutMs: 0 });
    void new f.Handler().detach();
    await expect(cleanup.stop()).rejects.toThrow("pglite_socket_cleanup_drain_timeout");
    f.pending.resolve();
    expect(f.Handler.prototype.detach).toBe(f.original);
  });
  it("does not mask listener-stop errors", async () => {
    const f = fixture(), cleanup = trackPgliteSocketCleanup(f.server, f.Handler);
    const error = new Error("listener stop failed"); f.server.stop.mockRejectedValue(error);
    await expect(cleanup.stop()).rejects.toBe(error);
    expect(f.Handler.prototype.detach).toBe(f.original);
  });
  it("refuses overlapping prototype ownership within one test worker", async () => {
    const f = fixture(), cleanup = trackPgliteSocketCleanup(f.server, f.Handler);
    expect(() => trackPgliteSocketCleanup(f.server, f.Handler)).toThrow("pglite_socket_cleanup_already_registered");
    await cleanup.stop();
  });
});

describe("real protocol socket teardown", () => {
  const requireApi = createRequire(new URL("../../artifacts/api-server/package.json", import.meta.url));
  const { PGlite } = requireApi("@electric-sql/pglite");
  const { PGLiteSocketServer, PGLiteSocketHandler } = requireApi("@electric-sql/pglite-socket");
  const { Pool } = requireApi("pg");

  it("waits for a real disconnected client's gated ROLLBACK before database close", async () => {
    const database = await PGlite.create();
    const server = new PGLiteSocketServer({ db: database, host: "127.0.0.1", port: 0, maxConnections: 3 });
    const cleanup = trackPgliteSocketCleanup(server, PGLiteSocketHandler);
    const rollbackStarted = gate(), rollbackMayFinish = gate();
    const exec = database.exec.bind(database);
    const close = vi.spyOn(database, "close");
    let pool, client, shutdown, complete = false;
    database.exec = async (...args) => {
      if (args[0] === "ROLLBACK") { rollbackStarted.resolve(); await rollbackMayFinish.promise; }
      return exec(...args);
    };
    try {
      await server.start();
      pool = new Pool({ connectionString: `postgresql://postgres:synthetic@${server.getServerConn()}/postgres`, connectionTimeoutMillis: 3000 });
      client = await pool.connect();
      await client.query("BEGIN");
      expect(database.isInTransaction()).toBe(true);
      client.release(true); client = undefined;
      await pool.end(); pool = undefined;
      shutdown = (async () => { await cleanup.stop(); await database.close(); complete = true; })();
      await rollbackStarted.promise;
      // No duration sleep: exact pending rollback is now observed and gated.
      await turn();
      expect(server.getStats().activeConnections).toBe(0);
      expect(close).not.toHaveBeenCalled(); expect(complete).toBe(false);
      rollbackMayFinish.resolve(); await shutdown;
      expect(close).toHaveBeenCalledOnce(); expect(complete).toBe(true);
    } finally {
      rollbackMayFinish.resolve();
      if (client) client.release(true);
      if (pool) await pool.end();
      if (shutdown) await shutdown;
      else { await cleanup.stop(); await database.close(); }
    }
  }, 15000);

  it("drains repeated multi-client close events without an arbitrary delay", async () => {
    for (let iteration = 0; iteration < 5; iteration++) {
      const database = await PGlite.create();
      const server = new PGLiteSocketServer({ db: database, host: "127.0.0.1", port: 0, maxConnections: 3 });
      const cleanup = trackPgliteSocketCleanup(server, PGLiteSocketHandler);
      let pool;
      try {
        await server.start();
        pool = new Pool({ connectionString: `postgresql://postgres:synthetic@${server.getServerConn()}/postgres`, max: 3, connectionTimeoutMillis: 3000 });
        const clients = await Promise.all([pool.connect(), pool.connect(), pool.connect()]);
        await Promise.all(clients.map((client) => client.query("SELECT 1")));
        for (const client of clients) client.release(true);
        await pool.end(); pool = undefined;
        await cleanup.stop();
        expect(server.getStats()).toMatchObject({ activeConnections: 0, queuedQueries: 0 });
      } finally {
        if (pool) await pool.end();
        await cleanup.stop(); await database.close();
      }
    }
  }, 20000);
});
