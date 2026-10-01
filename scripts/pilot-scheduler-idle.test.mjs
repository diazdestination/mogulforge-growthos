import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import http from "node:http";
import https from "node:https";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { reviewedSchema } from "./pilot-staging-bootstrap.mjs";
import { fixtureIds, fixtureRows } from "./restore-drill-fixture.mjs";
import { trackPgliteSocketCleanup } from "./test-support/pglite-socket-cleanup.mjs";
import { IMAGE_REF, RELEASE_SHA } from "./pilot-scheduler-probe.mjs";
import { IDLE_INTERLOCK, assertInertDefaults, cleanupIdleRuntime, idleChildEnvironment, idleConfiguration,
  idleFailureEvidence, idlePreflight, loadIdleRuntime, readDefaultSeedSpec, runIdleSupervisor,
  tenantFingerprint, verifyIdleSources } from "./pilot-scheduler-idle.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const env = { FLY_APP_NAME: "mogulforge-growthos-staging", APP_ORIGIN: "https://mogulforge-growthos-staging.fly.dev",
  SCHEDULER_AUTOSTART: "false", GROWTHOS_OUTBOUND_HOLD: "true", STAGING_OUTBOUND_APPROVED: "false",
  STAGING_SCHEMA_PUSH_APPROVED: "false", PILOT_SCHEDULER_PROBE_APPROVED: "true", PILOT_SCHEDULER_IDLE_APPROVED: "true",
  PILOT_SCHEDULER_MAIN_APP_STOPPED: "true", PILOT_SCHEDULER_ZERO_SERVICES: "true",
  RESTORE_DRILL_RELEASE_SHA: RELEASE_SHA, RESTORE_DRILL_IMAGE_REF: IMAGE_REF,
  DATABASE_URL: "postgresql://growthos-staging-live:synthetic@pgbouncer.zp2wjrejd2zodn4q.flympg.net/growthos_staging?sslmode=require" };
const slugs = ["restore-drill-pilot-a", "restore-drill-pilot-b"];
const orgs = slugs.map((slug) => ({ id: fixtureIds(slug).organization, slug, name: `SYNTHETIC RESTORE ONLY — ${slug}` }));
const identity = { database: "growthos_staging", login: "growthos-staging-live", role: "growthos-staging-live" };

function defaults(spec, org) {
  const sms = { id: randomUUID(), organization_id: org, name: spec.DEFAULT_ABANDONED_SMS_TEMPLATE_NAME,
    channel: "sms", subject: null, body: spec.GENERIC_ABANDONED_SMS_BODY, is_active: true };
  const email = { id: randomUUID(), organization_id: org, name: spec.DEFAULT_ABANDONED_EMAIL_TEMPLATE_NAME,
    channel: "email", subject: spec.GENERIC_ABANDONED_EMAIL_SUBJECT, body: spec.GENERIC_ABANDONED_EMAIL_BODY, is_active: true };
  const rule = { id: randomUUID(), organization_id: org, name: spec.DEFAULT_ABANDONED_FOLLOWUP_NAME,
    seed_key: spec.DEFAULT_ABANDONED_FOLLOWUP_SEED_KEY, event: "assessment.abandoned", is_active: true, conditions: {},
    actions: [ { type: "send_sms", params: { templateId: sms.id, body: spec.DEFAULT_ABANDONED_SMS_BODY } },
      { type: "send_email", params: { templateId: email.id, subject: spec.DEFAULT_ABANDONED_EMAIL_SUBJECT, body: spec.DEFAULT_ABANDONED_EMAIL_BODY } },
      { type: "create_task", params: { title: "Call back: homeowner abandoned concierge chat" } } ] };
  return { rules: [rule], templates: [sms, email] };
}

describe("actual scheduler acceptance guards and lifecycle", () => {
  it("pins held staging, stopped main and zero-service attestations", () => {
    expect(idleConfiguration(env).releaseSha).toBe(RELEASE_SHA);
    for (const key of ["PILOT_SCHEDULER_IDLE_APPROVED", "PILOT_SCHEDULER_MAIN_APP_STOPPED", "PILOT_SCHEDULER_ZERO_SERVICES"])
      expect(() => idleConfiguration({ ...env, [key]: "false" })).toThrow();
    expect(() => idleConfiguration({ ...env, SCHEDULER_AUTOSTART: "true" })).toThrow();
    expect(() => idleConfiguration({ ...env, DATABASE_URL: env.DATABASE_URL.replace("growthos_staging", "production") })).toThrow();
  });
  it("hash-checks every real scheduler/helper source and parses only pinned default constants", async () => {
    await expect(verifyIdleSources(root)).resolves.toBeUndefined();
    const spec = await readDefaultSeedSpec(root);
    expect(Object.keys(spec)).toHaveLength(10);
    expect(spec.DEFAULT_ABANDONED_FOLLOWUP_SEED_KEY).toBe("default.assessment_abandoned_followup");
    await expect(verifyIdleSources(root, (path, encoding) => path.endsWith("scheduler.ts") ? "changed" : readFile(path, encoding)))
      .rejects.toThrow("pilot_idle_source_mismatch");
  });
  it("passes no provider credentials, storage-cleanup directory, runtime injection or ambient secret to child", () => {
    const child = idleChildEnvironment({ ...env, PATH: "synthetic-path", TWILIO_AUTH_TOKEN: "do-not-copy",
      RESEND_API_KEY: "do-not-copy", OPENAI_API_KEY: "do-not-copy", OAUTH_TOKEN_ENCRYPTION_KEY: "do-not-copy",
      PRIVATE_OBJECT_DIR: "do-not-copy", NODE_OPTIONS: "--require danger", RANDOM_SECRET: "do-not-copy" });
    expect(child.SCHEDULER_AUTOSTART).toBe("true");
    expect(child.GROWTHOS_OUTBOUND_HOLD).toBe("true");
    expect(child.PATH).toBe("synthetic-path");
    expect(child.SESSION_SECRET).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(child)).not.toContain("do-not-copy");
    expect(child.NODE_OPTIONS).toBeUndefined();
  });
  it("allows only complete exact defaults and same-tenant template references", async () => {
    const spec = await readDefaultSeedSpec(root), a = defaults(spec, orgs[0].id), b = defaults(spec, orgs[1].id);
    expect(() => assertInertDefaults(orgs.map((o) => o.id), [...a.rules, ...b.rules], [...a.templates, ...b.templates], spec)).not.toThrow();
    const bad = structuredClone(a.rules); bad[0].actions[0].params.templateId = b.templates[0].id;
    expect(() => assertInertDefaults([orgs[0].id], bad, a.templates, spec)).toThrow("pilot_idle_customized_automation");
    expect(() => assertInertDefaults([orgs[0].id], a.rules, [a.templates[0]], spec)).toThrow("pilot_idle_partial_or_extra_defaults");
    expect(() => assertInertDefaults([orgs[0].id], a.rules, [{ ...a.templates[0], body: "custom" }, a.templates[1]], spec)).toThrow("pilot_idle_customized_templates");
    expect(() => assertInertDefaults([orgs[0].id], b.rules, b.templates, spec)).toThrow("pilot_idle_foreign_defaults");
  });
  it("redacts arbitrary errors while retaining only fixed phases and safe SQLSTATE", () => {
    const error = Object.assign(new TypeError("private password and provider payload"), { code: "XX000" });
    const safe = idleFailureEvidence(error, "first_worker");
    expect(safe).toMatchObject({ error: "pilot_idle_operation_failed", phase: "first_worker", sqlstate: "XX000" });
    expect(JSON.stringify(safe)).not.toMatch(/password|payload/);
  });
});

function supervisorFixture(options = {}) {
  let record, forkCount = 0, interlock = false;
  const children = [], queries = [], lines = [], handlers = {};
  const client = { on: vi.fn((event, callback) => { handlers[event] = callback; }), release: vi.fn(), async query(sql, values = []) {
    queries.push({ sql, values });
    if (["BEGIN READ ONLY", "ROLLBACK", "SET statement_timeout = '8s'"].includes(sql)) return { rows: [] };
    if (sql.startsWith("SELECT current_database")) return { rows: [identity] };
    if (sql.includes("FROM organizations ORDER")) return { rows: orgs };
    if (sql.includes("AS unsafe_count")) return { rows: [{ unsafe_count: options.unsafe ? 1 : 0 }] };
    if (sql === "SELECT * FROM automations" || sql === "SELECT * FROM message_templates") return { rows: [] };
    if (sql.includes("information_schema.columns")) return { rows: [{ table_name: "contacts" }] };
    if (sql.startsWith("SELECT md5")) return { rows: [{ digest: options.changedFingerprint && forkCount === 2 ? "b".repeat(32) : "a".repeat(32) }] };
    if (sql.startsWith("SELECT * FROM scheduler_runtime")) return { rows: record ? [{ ...record }] : [] };
    if (sql.startsWith("SELECT pg_try_advisory_lock")) {
      if (values[0] === IDLE_INTERLOCK) interlock = !options.otherSupervisor;
      return { rows: [{ acquired: values[0] === IDLE_INTERLOCK ? interlock : true }] };
    }
    if (sql.startsWith("SELECT pg_advisory_unlock")) {
      if (values[0] === IDLE_INTERLOCK) interlock = false;
      return { rows: [{ released: !(options.falseSharedUnlock && values[0] === IDLE_INTERLOCK) &&
        !(options.falseSchedulerUnlock && values[0] !== IDLE_INTERLOCK) }] };
    }
    if (sql.startsWith("DELETE FROM scheduler_runtime")) {
      if (record?.owner_id === values[0] && record.state === "stopped") { record = undefined; return { rows: [{ name: "automation" }] }; }
      return { rows: [] };
    }
    throw new Error("Unexpected mocked idle SQL");
  } };
  const pool = { on: vi.fn(), connect: vi.fn(async () => client), end: vi.fn(async () => {
    if (options.lateObserverLoss) handlers.error?.(new Error("private late observer connection error"));
    if (options.closeFailure) throw new Error("private pool close error");
  }) };
  const forkProcess = vi.fn((_file, _args, config) => {
    const child = new EventEmitter(), owner = randomUUID(), index = ++forkCount;
    expect(interlock).toBe(true);
    expect(config.execArgv).toEqual([]);
    expect(config.env.PRIVATE_OBJECT_DIR).toBeUndefined();
    child.stdout = { resume: vi.fn() }; child.stderr = { resume: vi.fn() };
    child.kill = vi.fn((signal) => {
      if (signal === "SIGKILL") { queueMicrotask(() => child.emit("exit", null, "SIGKILL")); return true; }
      record = { name: "automation", owner_id: options.foreignOwner && index === 2 ? randomUUID() : owner, state: "stopped" };
      queueMicrotask(() => { child.emit("message", { phase: "stopped", ownerId: owner, state: "stopped", providerNetworkAttempts: 0 }); child.emit("exit", 0, null); });
      return true;
    });
    children.push(child);
    setImmediate(() => {
      record = { name: "automation", owner_id: owner, state: "idle" };
      for (let cycle = 0; cycle < (index === 1 ? 2 : 1); cycle++) {
        const started = Date.parse("2026-10-01T00:00:00.000Z") + cycle * (options.fastInterval ? 1000 : 61000);
        child.emit("message", { phase: "cycle", ownerId: owner, health: "healthy", intervalMs: 60000,
          startedAt: new Date(started).toISOString(), completedAt: new Date(started + 500).toISOString(),
          heartbeatAt: new Date(started + 501).toISOString(), providerNetworkAttempts: 0 });
      }
    });
    return child;
  });
  return { args: { env, root, createPool: () => pool, forkProcess, emit: (line) => lines.push(line) }, pool, client, lines,
    children, queries, forkProcess, currentRecord: () => record, locked: () => interlock };
}

describe("supervisor", () => {
  it("holds one interlock through two real-interval observations, fresh owner, graceful stops and exact cleanup", async () => {
    const f = supervisorFixture(), result = await runIdleSupervisor(f.args);
    expect(result).toMatchObject({ ok: true, intervalMs: 60000, ownRuntimeRowRemoved: true, tenantStateUnchanged: true,
      exclusiveSupervisorInterlockHeld: true, providerCredentialsInherited: false, actualServerBootstrapRun: false });
    expect(result.firstWorker.cycles).toHaveLength(2);
    expect(result.replacementWorker.cycles).toHaveLength(1);
    expect(result.firstWorker.ownerId).not.toBe(result.replacementWorker.ownerId);
    expect(f.currentRecord()).toBeUndefined(); expect(f.locked()).toBe(false);
    expect(f.pool.end).toHaveBeenCalledOnce(); expect(f.client.release).toHaveBeenCalledWith(true);
    expect(f.queries.filter((q) => q.sql.startsWith("DELETE"))).toHaveLength(1);
    expect(f.lines).toHaveLength(1); expect(JSON.parse(f.lines[0]).ok).toBe(true);
    expect(f.lines[0]).not.toMatch(/postgresql:|synthetic@/);
  });
  it.each([{ otherSupervisor: true }, { unsafe: true }])("refuses unsafe/overlapping runs before spawning: %j", async (options) => {
    const f = supervisorFixture(options);
    await expect(runIdleSupervisor(f.args)).rejects.toThrow(/^pilot_idle_/);
    expect(f.forkProcess).not.toHaveBeenCalled(); expect(f.queries.some((q) => q.sql.startsWith("DELETE"))).toBe(false);
    expect(f.pool.end).toHaveBeenCalledOnce(); expect(f.lines).toHaveLength(0);
  });
  it.each([{ fastInterval: true }, { changedFingerprint: true }, { foreignOwner: true }, { closeFailure: true },
    { lateObserverLoss: true }, { falseSharedUnlock: true }, { falseSchedulerUnlock: true }])(
    "does not publish successful evidence for a failed acceptance: %j", async (options) => {
      const f = supervisorFixture(options);
      await expect(runIdleSupervisor(f.args)).rejects.toThrow(/^pilot_idle_/);
      expect(f.lines).toHaveLength(0); expect(f.pool.end).toHaveBeenCalledOnce(); expect(f.locked()).toBe(false);
      if (options.foreignOwner) expect(f.currentRecord()?.state).toBe("stopped");
    });
});

describe("real schema and source scheduler on disposable local PostgreSQL emulator", () => {
  const requireApi = createRequire(new URL("../artifacts/api-server/package.json", import.meta.url));
  const { PGlite } = requireApi("@electric-sql/pglite");
  const { PGLiteSocketServer, PGLiteSocketHandler } = requireApi("@electric-sql/pglite-socket");
  let database, spec, socketCleanup;
  const client = { async query(sql, values) {
    const result = await database.query(sql, values);
    return sql.startsWith("SELECT current_database") ? { rows: [identity] } : result;
  } };
  const insert = async (table, row) => {
    const keys = Object.keys(row), json = ["metadata", "payload", "evidence", "options", "line_items", "conditions", "actions"];
    await database.query(`INSERT INTO ${table}(${keys.join(",")}) VALUES(${keys.map((_, i) => `$${i + 1}`).join(",")})`,
      keys.map((key) => json.includes(key) ? JSON.stringify(row[key]) : row[key]));
  };
  beforeAll(async () => {
    database = await PGlite.create(); await database.exec(await reviewedSchema()); spec = await readDefaultSeedSpec(root);
    for (const slug of slugs) for (const [table, row] of fixtureRows(slug, "synthetic-test-only")) await insert(table, row);
    for (const org of orgs) {
      const rows = defaults(spec, org.id);
      for (const row of rows.templates) await insert("message_templates", row);
      for (const row of rows.rules) await insert("automations", row);
    }
  }, 25000);
  afterAll(async () => {
    if (socketCleanup) await socketCleanup.stop();
    if (database) await database.close();
  });
  it("executes the full read-only preflight including known inert boot defaults, without changing tenant data", async () => {
    const before = await tenantFingerprint(client, orgs.map((o) => o.id));
    await expect(idlePreflight(client, spec)).resolves.toMatchObject({ defaultRules: 2, defaultTemplates: 4 });
    expect(await tenantFingerprint(client, orgs.map((o) => o.id))).toBe(before);
  });
  it("refuses pending synthetic actions and retains them untouched", async () => {
    const id = randomUUID();
    await insert("scheduled_actions", { id, organization_id: orgs[0].id, action: JSON.stringify({ type: "create_task" }), run_at: new Date() });
    try {
      await expect(idlePreflight(client, spec)).rejects.toThrow("pilot_idle_queued_contactable_or_cleanup_work");
      expect((await database.query("SELECT status FROM scheduled_actions WHERE id=$1", [id])).rows[0].status).toBe("pending");
    } finally { await database.query("DELETE FROM scheduled_actions WHERE id=$1", [id]); }
  });
  it("refuses modified boot defaults and does not repair/delete them", async () => {
    const row = (await database.query("SELECT id, body FROM message_templates LIMIT 1")).rows[0];
    await database.query("UPDATE message_templates SET body='modified' WHERE id=$1", [row.id]);
    try { await expect(idlePreflight(client, spec)).rejects.toThrow("pilot_idle_customized_templates"); }
    finally { await database.query("UPDATE message_templates SET body=$2 WHERE id=$1", [row.id, row.body]); }
  });
  it("never deletes another owner's row or its own still-running row", async () => {
    const owner = randomUUID();
    await database.query("INSERT INTO scheduler_runtime(name,owner_id,state,interval_ms,started_at,heartbeat_at) VALUES('automation',$1,'running',60000,now(),now())", [owner]);
    try {
      await expect(idlePreflight(client, spec)).rejects.toThrow("pilot_idle_runtime_not_exclusively_available");
      await expect(cleanupIdleRuntime(client, owner)).rejects.toThrow("pilot_idle_cleanup_foreign_or_running_owner");
      await database.query("UPDATE scheduler_runtime SET state='stopped' WHERE owner_id=$1", [owner]);
      await expect(cleanupIdleRuntime(client, randomUUID())).rejects.toThrow("pilot_idle_cleanup_foreign_or_running_owner");
      expect((await database.query("SELECT owner_id FROM scheduler_runtime WHERE name='automation'")).rows[0].owner_id).toBe(owner);
      await cleanupIdleRuntime(client, owner);
    } finally { await database.query("DELETE FROM scheduler_runtime WHERE name='automation' AND owner_id=$1", [owner]); }
  });
  it("runs the actual full scheduler twice at its real 60-second interval, then stops without changing tenant state", async () => {
    const server = new PGLiteSocketServer({ db: database, host: "127.0.0.1", port: 0, maxConnections: 5 });
    socketCleanup = trackPgliteSocketCleanup(server, PGLiteSocketHandler);
    const previousEnv = { ...process.env }, previousFetch = globalThis.fetch;
    const original = { httpRequest: http.request, httpGet: http.get, httpsRequest: https.request, httpsGet: https.get };
    let runtime, owner, blocked = 0;
    try {
      await server.start();
      const localUrl = `postgresql://postgres:synthetic@${server.getServerConn()}/postgres`;
      expect(new URL(localUrl).hostname).toBe("127.0.0.1");
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, Object.fromEntries(Object.entries(previousEnv).filter(([key]) => /^(PATH|SystemRoot|WINDIR|TEMP|TMP|PATHEXT|COMSPEC|LANG|TZ)$/i.test(key))),
        { NODE_ENV: "test", LOG_LEVEL: "silent", DATABASE_URL: localUrl, SCHEDULER_AUTOSTART: "true", GROWTHOS_OUTBOUND_HOLD: "true",
          STAGING_OUTBOUND_APPROVED: "false", SESSION_SECRET: "synthetic-local-only-session-secret-32-chars", OBJECT_STORAGE_PROVIDER: "postgres" });
      const deny = () => { blocked++; throw new Error("Local test forbids provider traffic"); };
      globalThis.fetch = deny; http.request = deny; http.get = deny; https.request = deny; https.get = deny;
      const before = await tenantFingerprint(client, orgs.map((o) => o.id));
      runtime = await loadIdleRuntime(root);
      runtime.startAutomationScheduler();
      const cycles = [], started = Date.now();
      while (cycles.length < 2 && Date.now() - started < 80000) {
        await new Promise((done) => setTimeout(done, 300));
        const row = (await runtime.pool.query("SELECT * FROM scheduler_runtime WHERE name='automation'")).rows[0];
        if (row?.state === "degraded") throw new Error(`Synthetic scheduler stages failed: ${row.failed_stages.join(",")}`);
        if (row?.state === "idle" && !cycles.some((cycle) => cycle.completed_at.getTime() === row.completed_at.getTime())) {
          owner = row.owner_id; cycles.push(row);
        }
      }
      expect(cycles).toHaveLength(2);
      expect(cycles.every((cycle) => cycle.interval_ms === 60000 && cycle.failed_stages.length === 0)).toBe(true);
      expect(cycles[1].started_at.getTime() - cycles[0].completed_at.getTime()).toBeGreaterThanOrEqual(59000);
      await runtime.stopAutomationScheduler();
      expect((await runtime.pool.query("SELECT state FROM scheduler_runtime WHERE owner_id=$1", [owner])).rows[0].state).toBe("stopped");
      expect(blocked).toBe(0);
      expect(await tenantFingerprint(client, orgs.map((o) => o.id))).toBe(before);
      await cleanupIdleRuntime(client, owner);
    } finally {
      if (runtime) { await runtime.stopAutomationScheduler(); await runtime.dispose(); }
      globalThis.fetch = previousFetch; http.request = original.httpRequest; http.get = original.httpGet; https.request = original.httpsRequest; https.get = original.httpsGet;
      for (const key of Object.keys(process.env)) delete process.env[key]; Object.assign(process.env, previousEnv);
      await socketCleanup.stop();
      if (owner) await database.query("DELETE FROM scheduler_runtime WHERE name='automation' AND owner_id=$1", [owner]);
    }
  }, 95000);
});
