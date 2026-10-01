import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { IMAGE_REF, RELEASE_SHA, prepareRuntimePool, probeConfiguration, probeFailureEvidence, probePoolOptions, reserveProbeRuntime, runSchedulerProbe, safeProbeError,
  verifyProbeSources } from "./pilot-scheduler-probe.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const env = {
  FLY_APP_NAME: "mogulforge-growthos-staging", APP_ORIGIN: "https://mogulforge-growthos-staging.fly.dev",
  SCHEDULER_AUTOSTART: "false", GROWTHOS_OUTBOUND_HOLD: "true", STAGING_OUTBOUND_APPROVED: "false",
  STAGING_SCHEMA_PUSH_APPROVED: "false", PILOT_SCHEDULER_PROBE_APPROVED: "true",
  RESTORE_DRILL_RELEASE_SHA: RELEASE_SHA, RESTORE_DRILL_IMAGE_REF: IMAGE_REF,
  DATABASE_URL: "postgresql://growthos-staging-live:synthetic@pgbouncer.zp2wjrejd2zodn4q.flympg.net/growthos_staging?sslmode=require",
};
const orgs = ["restore-drill-pilot-a", "restore-drill-pilot-b"].map((slug) => {
  const h = createHash("sha256").update(`growthos-restore-v1:${slug}:organization`).digest("hex");
  return { id: `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`,
    slug, name: `SYNTHETIC RESTORE ONLY — ${slug}` };
});

function fixture(options = {}) {
  const queries = [], records = new Map(), locks = new Map();
  let clientIndex = 0, tick = Date.now(), runtimeCalls = 0;
  const runtimePool = { end: vi.fn(async () => {}) };
  const loadRuntime = vi.fn(async () => ({
    pool: runtimePool,
    schedulerHealth: (row) => row.state === "running" ? "running" : row.state === "degraded" ? "degraded" : "healthy",
    async runSchedulerCycle(work, { name, ownerId }) {
      runtimeCalls++;
      const key = `growthos:scheduler:${name}`;
      if (locks.has(key)) return "busy";
      locks.set(key, "runtime");
      const row = { name, owner_id: ownerId, state: "running", heartbeat_at: new Date(++tick),
        started_at: new Date(tick), completed_at: null, failed_stages: [], current_stage: null };
      records.set(name, row);
      try {
        await work(async (stage, phase) => {
          if (options.failObserve) throw new Error("private provider credential secret");
          row.heartbeat_at = new Date(++tick);
          row.current_stage = phase === "running" ? stage : null;
          if (phase === "failed") row.failed_stages.push(stage);
        });
      } catch { row.failed_stages.push("cycle-interrupted"); }
      finally { locks.delete(key); }
      row.state = row.failed_stages.length ? "degraded" : "idle";
      row.completed_at = new Date(++tick);
      if (options.foreignOwner && ownerId.endsWith(":recovered")) row.owner_id = "unrelated-owner";
      return row.state;
    },
  }));
  const clients = [];
  const pool = {
    on: vi.fn(), end: vi.fn(async () => {}),
    async connect() {
      if (options.connectError) throw options.connectError;
      const index = clientIndex++;
      let identityCalls = 0;
      const client = { on: vi.fn(), release: vi.fn(), async query(sql, values = []) {
        queries.push({ index, sql, values });
        if (sql.startsWith("SELECT current_database")) {
          identityCalls++;
          return { rows: [{ database: options.wrongDatabase ? "production" : "growthos_staging",
            login: "growthos-staging-live", role: "growthos-staging-live",
            pid: 101 + (options.sameSession ? 0 : index) + (options.changedPid && identityCalls > 1 ? 10 : 0) }] };
        }
        if (sql.includes("FROM organizations ORDER")) return { rows: options.nonfixture ? [{ ...orgs[0], slug: "real-client" }] : orgs };
        if (sql.includes("AS unsafe_count")) {
          if (options.queueError) throw options.queueError;
          return { rows: [{ unsafe_count: options.unsafe ? "1" : "0" }] };
        }
        if (sql.startsWith("SELECT md5")) return { rows: [{ digest: "unchanged-runtime" }] };
        if (sql.startsWith("SELECT pg_try_advisory_lock")) {
          const current = locks.get(values[0]);
          if (current === undefined || current === index) { locks.set(values[0], index); return { rows: [{ acquired: true }] }; }
          return { rows: [{ acquired: false }] };
        }
        if (sql.startsWith("SELECT pg_advisory_unlock")) {
          const released = locks.get(values[0]) === index;
          if (released) locks.delete(values[0]);
          return { rows: [{ released }] };
        }
        if (sql.startsWith("INSERT INTO scheduler_runtime")) {
          if (options.collision) return { rows: [] };
          records.set(values[0], { name: values[0], owner_id: values[1] });
          return { rows: [{ name: values[0] }] };
        }
        if (sql.startsWith("SELECT * FROM scheduler_runtime")) return { rows: records.has(values[0]) ? [{ ...records.get(values[0]) }] : [] };
        if (sql.startsWith("DELETE FROM scheduler_runtime")) {
          const record = records.get(values[0]);
          if (record && values[1].includes(record.owner_id)) { records.delete(values[0]); return { rows: [{ name: values[0] }] }; }
          return { rows: [] };
        }
        if (["BEGIN READ ONLY", "ROLLBACK", "SET statement_timeout = '8s'"].includes(sql)) return { rows: [] };
        throw new Error("Unexpected SQL in mocked probe");
      } };
      clients.push(client);
      return client;
    },
  };
  const lines = [];
  const args = { env, root, createPool: vi.fn(() => pool), loadRuntime, emit: (line) => lines.push(line) };
  return { args, pool, runtimePool, clients, records, locks, queries, loadRuntime, lines, calls: () => runtimeCalls };
}

describe("bounded staging scheduler probe", () => {
  it("keeps timeout out of startup packets and awaits SQL setup before runtime checkout", async () => {
    const options = probePoolOptions(2, "synthetic-probe");
    expect(options.statement_timeout).toBeUndefined();
    expect(options.query_timeout).toBe(10000);
    expect(options.connectionTimeoutMillis).toBe(5000);
    const pool = { options: { statement_timeout: 8000 }, on: vi.fn() };
    prepareRuntimePool(pool);
    expect(pool.options.statement_timeout).toBeUndefined();
    const done = vi.fn();
    let complete;
    const client = { query: vi.fn(() => new Promise((resolve) => { complete = resolve; })) };
    pool.options.verify(client, done);
    expect(done).not.toHaveBeenCalled();
    complete();
    await Promise.resolve();
    expect(client.query).toHaveBeenCalledWith("SET statement_timeout = '8s'");
    expect(done).toHaveBeenCalledWith();
  });
  it("pins the exact source image, staging target and all holds", () => {
    expect(probeConfiguration(env).releaseSha).toBe(RELEASE_SHA);
    for (const [key, value] of Object.entries({ FLY_APP_NAME: "mogulforge-growthos", APP_ORIGIN: "https://app.mogulforge.ai",
      SCHEDULER_AUTOSTART: "true", GROWTHOS_OUTBOUND_HOLD: "false", STAGING_OUTBOUND_APPROVED: "true",
      STAGING_SCHEMA_PUSH_APPROVED: "true", AUTO_MIGRATE: "true", RESTORE_DRILL_ONLY: "true",
      PILOT_SCHEDULER_PROBE_APPROVED: "false", RESTORE_DRILL_RELEASE_SHA: "other", RESTORE_DRILL_IMAGE_REF: "latest",
      PGOPTIONS: "-c role=admin" })) {
      expect(() => probeConfiguration({ ...env, [key]: value }), key).toThrow();
    }
    for (const changed of [env.DATABASE_URL.replace("zp2wjrejd2zodn4q", "kzpwm0j18eg04nv3"),
      env.DATABASE_URL.replace("growthos_staging", "fly-db"), env.DATABASE_URL.replace("growthos-staging-live", "fly-user"),
      env.DATABASE_URL + "&host=production", env.DATABASE_URL + "&options=-crole%3Dadmin", env.DATABASE_URL + "#fragment",
      env.DATABASE_URL.replace(".net/", ".net:5433/"), "invalid"]) {
      expect(() => probeConfiguration({ ...env, DATABASE_URL: changed })).toThrow();
    }
  });
  it("checks canonical source hashes and the complete import helper before loading code", async () => {
    await expect(verifyProbeSources(root)).resolves.toBeUndefined();
    for (const replacement of ["scheduler-runtime.ts", "pilot-scheduler-runtime.ts"]) {
      await expect(verifyProbeSources(root, async (path, encoding) => path.endsWith(replacement) ? "wrong source" : readFile(path, encoding)))
        .rejects.toThrow(/pilot_scheduler_(source_hash_mismatch|helper_mismatch)/);
    }
  });
  it("proves independent held sessions, actual-runtime choreography, failure visibility and exact cleanup", async () => {
    const f = fixture();
    const result = await runSchedulerProbe(f.args);
    expect(result.backendPids).toEqual([101, 102]);
    expect(result.concurrentCycleExcluded).toBe(true);
    expect(result.failedStageVisible).toBe(true);
    expect(result.ownRuntimeRowRemoved).toBe(true);
    expect(result.schedulerRestartVerified).toBe(false);
    expect(result.alwaysOnIdleCyclesVerified).toBe(false);
    expect(result.realSchedulerStagesCalled).toBe(false);
    expect(result.providersCalled).toBe(false);
    expect(f.calls()).toBe(5);
    expect(f.records.size).toBe(0);
    expect(f.locks.size).toBe(0);
    expect(f.runtimePool.end).toHaveBeenCalledOnce();
    expect(f.args.createPool.mock.calls[0][0].statement_timeout).toBeUndefined();
    expect(f.queries.filter((q) => q.sql === "SET statement_timeout = '8s'")).toHaveLength(2);
    expect(f.pool.end).toHaveBeenCalledOnce();
    expect(f.clients.every((c) => c.release.mock.calls[0][0] === true)).toBe(true);
    const deletion = f.queries.filter((q) => q.sql.startsWith("DELETE"));
    expect(deletion).toHaveLength(1);
    expect(deletion[0].sql).toContain("WHERE name = $1 AND owner_id = ANY");
    expect(deletion[0].values[0]).toMatch(/^pilot-scheduler-probe-[a-f0-9-]{36}$/);
    expect(f.lines.join()).not.toMatch(/synthetic@|postgresql:|password|private provider/);
  });
  it.each([{ wrongDatabase: true }, { nonfixture: true }, { unsafe: true }, { sameSession: true }])(
    "refuses unsafe preflight before a runtime import or write: %j", async (options) => {
      const f = fixture(options);
      await expect(runSchedulerProbe(f.args)).rejects.toThrow(/^pilot_scheduler_/);
      expect(f.loadRuntime).not.toHaveBeenCalled();
      expect(f.queries.some((q) => /^(INSERT|DELETE|UPDATE)/.test(q.sql))).toBe(false);
      expect(f.pool.end).toHaveBeenCalledOnce();
      expect(f.clients.every((c) => c.release.mock.calls.length === 1)).toBe(true);
    });
  it("never replaces or deletes a collided runtime row", async () => {
    const f = fixture({ collision: true });
    await expect(runSchedulerProbe(f.args)).rejects.toThrow("pilot_scheduler_probe_row_exists");
    expect(f.loadRuntime).not.toHaveBeenCalled();
    expect(f.queries.some((q) => q.sql.startsWith("DELETE"))).toBe(false);
    expect(f.locks.size).toBe(0);
  });
  it("cleans its own reservation when a synthetic runtime callback fails", async () => {
    const f = fixture({ failObserve: true });
    await expect(runSchedulerProbe(f.args)).rejects.toThrow("pilot_scheduler_cycle_did_not_enter");
    expect(f.records.size).toBe(0);
    expect(f.locks.size).toBe(0);
    expect(f.lines).toEqual([]);
  });
  it("cannot validate one connection and let the real runtime inherit a different connection", async () => {
    const f = fixture();
    try {
      for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
      vi.stubEnv("DATABASE_URL", env.DATABASE_URL.replace(":synthetic@", ":different@"));
      await expect(runSchedulerProbe({ ...f.args, loadRuntime: undefined }))
        .rejects.toThrow("pilot_scheduler_runtime_environment_mismatch");
      expect(f.records.size).toBe(0);
      expect(f.lines).toEqual([]);
    } finally { vi.unstubAllEnvs(); }
  });
  it("preserves an unexpected replacement owner and fails cleanup visibly", async () => {
    const f = fixture({ foreignOwner: true });
    await expect(runSchedulerProbe(f.args)).rejects.toThrow("pilot_scheduler_cleanup_incomplete");
    expect([...f.records.values()][0].owner_id).toBe("unrelated-owner");
    expect(f.lines).toEqual([]);
  });
  it("rejects changed session backends and still removes only its own probe row", async () => {
    const f = fixture({ changedPid: true });
    await expect(runSchedulerProbe(f.args)).rejects.toThrow("pilot_scheduler_session_backend_changed");
    expect(f.records.size).toBe(0);
    expect(f.lines).toEqual([]);
  });
  it("redacts arbitrary driver/provider errors", () => {
    expect(safeProbeError(new Error("password=private customer payload"))).toBe("pilot_scheduler_operation_failed");
    expect(safeProbeError(new Error("pilot_scheduler_cleanup_incomplete"))).toBe("pilot_scheduler_cleanup_incomplete");
    expect(probeFailureEvidence({ message: "private", probeStage: "private", code: "LEAK!" }))
      .toEqual({ check: "pilot_scheduler_probe", ok: false, error: "pilot_scheduler_operation_failed", stage: "unknown", sqlstate: null, failureKind: "operation_error" });
  });
  it.each([["connectError", "08P01", "observer_connect"], ["queueError", "42703", "preflight_queues"]])(
    "emits only a fixed stage and allowlisted SQLSTATE for %s", async (key, code, stage) => {
      const f = fixture({ [key]: Object.assign(new Error("private message; postgres://secret@host; SQL payload"), { code,
        detail: "private customer", query: "private SQL", hint: "password" }) });
      const error = await runSchedulerProbe(f.args).catch((value) => value);
      expect(probeFailureEvidence(error)).toMatchObject({ check: "pilot_scheduler_probe", ok: false,
        error: "pilot_scheduler_operation_failed", stage, sqlstate: code, failureKind: "database_error" });
      expect(probeFailureEvidence(error).runtimeName).toMatch(/^pilot-scheduler-probe-[a-f0-9-]{36}$/);
      expect(JSON.stringify(probeFailureEvidence(error))).not.toMatch(/private|password|postgres:/);
    });
  it.each([
    [Object.assign(new Error("private permission detail"), { code: "42501" }), "database_error", "42501"],
    [Object.assign(new Error("private check constraint"), { code: "23514" }), "database_error", "23514"],
    [Object.assign(new Error("private unsupported operation"), { code: "0A000" }), "database_error", "0A000"],
    [new Error("Query read timeout"), "driver_query_timeout", null],
    [Object.assign(new Error("private statement"), { code: "57014" }), "database_timeout", "57014"],
    [new TypeError("private value"), "javascript_type_error", null],
    [new ReferenceError("private name"), "javascript_reference_error", null],
    [new Error("Client has encountered a connection error and is not queryable"), "connection_failure", null],
  ])("preserves a safe reservation error category without exposing the cause", async (cause, kind, code) => {
    const error = await reserveProbeRuntime({ query: async () => { throw cause; } }, "synthetic", "synthetic-owner")
      .catch((value) => value);
    const evidence = probeFailureEvidence(error);
    expect(evidence).toMatchObject({ error: "pilot_scheduler_operation_failed", stage: "probe_reservation", sqlstate: code, failureKind: kind });
    expect(evidence.operationElapsedMs).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(evidence)).not.toMatch(/private|Query read timeout|not queryable/);
  });
  it("labels malformed reservation results instead of throwing an opaque TypeError", async () => {
    await expect(reserveProbeRuntime({ query: async () => undefined }, "synthetic", "synthetic-owner"))
      .rejects.toThrow("pilot_scheduler_reservation_result_invalid");
  });
});
