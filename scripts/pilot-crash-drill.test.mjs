import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import http from "node:http";
import https from "node:https";
import { EventEmitter } from "node:events";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { RELEASE_SHA, IMAGE_REF } from "./hosted-pilot-drill.mjs";
import { reviewedSchema } from "./pilot-staging-bootstrap.mjs";
import { fixtureIds, fixtureRows } from "./restore-drill-fixture.mjs";
import {
  advanceSyntheticClock,
  attestCrashSources,
  crashConfiguration,
  crashFailure,
  crashIdentity,
  crashPreflight,
  crashWorkerEnvironment,
  executeCrashPhase,
  inspectCrashRecords,
  installCrashNetworkDeny,
  loadCrashRuntime,
  runCrashDrill,
  seedCrashActions,
  startOwnedCrashWorker,
} from "./pilot-crash-drill.mjs";

const env = {
  FLY_APP_NAME: "mogulforge-growthos-staging",
  APP_ORIGIN: "https://mogulforge-growthos-staging.fly.dev",
  AUTO_MIGRATE: "false",
  SCHEDULER_AUTOSTART: "false",
  GROWTHOS_OUTBOUND_HOLD: "true",
  STAGING_OUTBOUND_APPROVED: "false",
  STAGING_SCHEMA_PUSH_APPROVED: "false",
  OBJECT_STORAGE_PROVIDER: "postgres",
  PILOT_CRASH_DRILL_APPROVED: "true",
  PILOT_CRASH_MAIN_APP_STOPPED: "true",
  PILOT_CRASH_ZERO_PUBLIC_SERVICES: "true",
  PILOT_CRASH_RUN_NONCE: "a3".repeat(16),
  RESTORE_DRILL_RELEASE_SHA: RELEASE_SHA,
  RESTORE_DRILL_IMAGE_REF: IMAGE_REF,
  DATABASE_URL:
    "postgresql://growthos-staging-live:secret-for-test-only@pgbouncer.zp2wjrejd2zodn4q.flympg.net/growthos_staging",
};

describe("hosted crash probe guards", () => {
  it("requires exact approved source identity, holds and a deterministic nonce", () => {
    expect(crashConfiguration(env)).toEqual(
      crashIdentity(env.PILOT_CRASH_RUN_NONCE),
    );
    for (const [key, value] of [
      [
        "DATABASE_URL",
        env.DATABASE_URL.replace("zp2wjrejd2zodn4q", "kzpwm0j18eg04nv3"),
      ],
      [
        "DATABASE_URL",
        env.DATABASE_URL.replace("zp2wjrejd2zodn4q", "restored123"),
      ],
      [
        "DATABASE_URL",
        env.DATABASE_URL.replace("growthos_staging", "production"),
      ],
      [
        "DATABASE_URL",
        env.DATABASE_URL.replace(
          "growthos-staging-live",
          "growthos-restore-reader",
        ),
      ],
      ["DATABASE_URL", env.DATABASE_URL + "?host=production"],
      [
        "DATABASE_URL",
        env.DATABASE_URL.replace(
          "pgbouncer.zp2wjrejd2zodn4q.flympg.net",
          "127.0.0.1",
        ),
      ],
      ["GROWTHOS_OUTBOUND_HOLD", "false"],
      ["AUTO_MIGRATE", "true"],
      ["SCHEDULER_AUTOSTART", "true"],
      ["PILOT_CRASH_DRILL_APPROVED", "false"],
      ["PILOT_CRASH_MAIN_APP_STOPPED", "false"],
      ["PILOT_CRASH_ZERO_PUBLIC_SERVICES", "false"],
      ["RESTORE_DRILL_ONLY", "true"],
      ["PILOT_CRASH_RUN_NONCE", "arbitrary-value"],
      ["RESTORE_DRILL_IMAGE_REF", "latest"],
      ["PGOPTIONS", "unsafe"],
      ["NODE_OPTIONS", "--require unsafe"],
    ])
      expect(() => crashConfiguration({ ...env, [key]: value }), key).toThrow();
  });
  it("strips provider, reader, encryption, auth and arbitrary Node options from children", () => {
    const child = crashWorkerEnvironment(
      {
        ...env,
        PATH: "/usr/bin",
        TWILIO_AUTH_TOKEN: "secret",
        RESEND_API_KEY: "secret",
        OPENAI_API_KEY: "secret",
        FLY_API_TOKEN: "secret",
        NODE_OPTIONS: "secret",
        GOOGLE_CLIENT_SECRET: "secret",
        OAUTH_TOKEN_ENCRYPTION_KEY: "secret",
        RESTORE_DRILL_SESSION_BEARER: "secret",
        RESTORE_DRILL_RECOVERED_READER_DATABASE_URL: "secret",
      },
      crashIdentity(env.PILOT_CRASH_RUN_NONCE),
      "interrupt",
      "d".repeat(64),
    );
    expect(child.DATABASE_URL).toBe(env.DATABASE_URL);
    expect(child.SCHEDULER_AUTOSTART).toBe("false");
    expect(child.PILOT_CRASH_PARENT_PID).toBe(String(process.pid));
    for (const key of [
      "TWILIO_AUTH_TOKEN",
      "RESEND_API_KEY",
      "OPENAI_API_KEY",
      "GOOGLE_CLIENT_SECRET",
      "FLY_API_TOKEN",
      "NODE_OPTIONS",
      "OAUTH_TOKEN_ENCRYPTION_KEY",
      "RESTORE_DRILL_SESSION_BEARER",
      "RESTORE_DRILL_RECOVERED_READER_DATABASE_URL",
    ])
      expect(child[key]).toBeUndefined();
  });
  it("keeps raw driver messages and unknown SQLSTATE strings out of diagnostics", () => {
    const error = new Error(env.DATABASE_URL);
    error.cause = { code: "08P01", detail: "private details" };
    const evidence = crashFailure(
      error,
      "committed_effect",
      crashIdentity(env.PILOT_CRASH_RUN_NONCE),
      true,
    );
    expect(evidence).toMatchObject({
      error: "pilot_crash_operation_failed",
      sqlstate: "08P01",
      phase: "committed_effect",
      recordsMayExist: true,
    });
    expect(JSON.stringify(evidence)).not.toContain("secret-for-test-only");
    expect(
      crashFailure({ message: "private", code: "ABCDE" }, "private"),
    ).toMatchObject({ sqlstate: null, phase: "unknown" });
  });
  it("attests the actual pinned source and rejects any changed uploaded helper", async () => {
    const root = fileURLToPath(new URL("../", import.meta.url));
    expect(
      (await attestCrashSources(root, env)).sourceFileManifestVerified,
    ).toBe(true);
    await expect(
      attestCrashSources(root, env, async (path, encoding) =>
        String(path).endsWith("pilot-crash-runtime.ts")
          ? "modified helper"
          : readFile(path, encoding),
      ),
    ).rejects.toThrow("pilot_crash_helper_mismatch");
  });
  it("rejects unsafe configuration before connecting and never starts a worker", async () => {
    const connect = vi.fn(),
      startWorker = vi.fn(),
      emit = vi.fn();
    const result = await runCrashDrill({
      env: { ...env, PILOT_CRASH_DRILL_APPROVED: "false" },
      makeClient: connect,
      startWorker,
      emit,
    });
    expect(result.ok).toBe(false);
    expect(result.recordsMayExist).toBe(false);
    expect(connect).not.toHaveBeenCalled();
    expect(startWorker).not.toHaveBeenCalled();
  });
});

it("denies and counts HTTP paths before providers can run, without making a request", () => {
  const oldFetch = globalThis.fetch,
    oldRequest = http.request;
  const network = installCrashNetworkDeny();
  try {
    for (const call of [
      () => fetch("https://example.invalid"),
      () => http.request("http://example.invalid"),
      () => http.get("http://example.invalid"),
      () => https.request("https://example.invalid"),
      () => https.get("https://example.invalid"),
    ])
      expect(call).toThrow("pilot_crash_http_forbidden");
    expect(network.attempts).toBe(5);
  } finally {
    network.restore();
  }
  expect(globalThis.fetch).toBe(oldFetch);
  expect(http.request).toBe(oldRequest);
});

function supervisorClient({ failUnlock = false } = {}) {
  const client = new EventEmitter();
  client.connect = vi.fn(async () => {});
  client.end = vi.fn(async () => {});
  client.query = vi.fn(async (sql, values) => {
    if (sql.startsWith("SELECT current_database"))
      return {
        rows: [
          {
            database: "growthos_staging",
            login: "growthos-staging-live",
            role: "growthos-staging-live",
            pid: 42,
          },
        ],
      };
    if (sql.startsWith("SELECT id,slug,name"))
      return {
        rows: ["restore-drill-pilot-a", "restore-drill-pilot-b"].map(
          (slug) => ({
            id: fixtureIds(slug).organization,
            slug,
            name: `SYNTHETIC RESTORE ONLY — ${slug}`,
          }),
        ),
      };
    if (sql.includes("unsafe_count")) return { rows: [{ unsafe_count: "0" }] };
    if (sql.includes("pg_try_advisory_lock"))
      return { rows: [{ acquired: true }] };
    if (sql.includes("pg_advisory_unlock")) {
      if (failUnlock && values[0] === "growthos:scheduler:automation")
        throw new Error("secret cleanup failure");
      return { rows: [{ released: true }] };
    }
    if (sql.includes("SELECT count(*)")) return { rows: [{ count: "0" }] };
    if (sql.includes("AS digest")) return { rows: [{ digest: "unchanged" }] };
    return { rows: [] };
  });
  return client;
}

it("tries all owned cleanup steps even when one child kill and one lock release fail", async () => {
  const client = supervisorClient({ failUnlock: true });
  const child = {
    wait: vi.fn(async () => {
      throw new Error("secret worker error");
    }),
    kill: vi.fn(async () => {
      throw new Error("secret kill error");
    }),
  };
  const result = await runCrashDrill({
    env,
    attest: async () => ({}),
    makeClient: () => client,
    startWorker: () => child,
    emit: vi.fn(),
  });
  expect(result.ok).toBe(false);
  expect(result.recordsMayExist).toBe(true);
  expect(child.kill).toHaveBeenCalled();
  expect(client.end).toHaveBeenCalledOnce();
  const released = client.query.mock.calls
    .filter(([sql]) => sql.includes("pg_advisory_unlock"))
    .map(([, args]) => args[0]);
  expect(released).toEqual([
    "growthos:scheduler:automation",
    "growthos:pilot:hosted-supervisor",
  ]);
  expect(JSON.stringify(result)).not.toContain("secret");
});

it("terminates owned children immediately if the supervisor interlock connection is lost", async () => {
  const client = supervisorClient();
  const child = {
    kill: vi.fn(async () => ({ signal: "SIGKILL", code: null })),
    wait: vi.fn(async () => {
      client.emit("error", new Error("private connection detail"));
      return { blockedHttpAttempts: 0 };
    }),
  };
  const result = await runCrashDrill({
    env,
    attest: async () => ({}),
    makeClient: () => client,
    startWorker: () => child,
    emit: vi.fn(),
  });
  expect(result).toMatchObject({
    ok: false,
    error: "pilot_crash_interlock_lost",
    recordsMayExist: true,
  });
  expect(child.kill.mock.calls.length).toBeGreaterThanOrEqual(2);
  expect(client.end).toHaveBeenCalledOnce();
  expect(JSON.stringify(result)).not.toContain("private connection");
});

it("only kills the exact forked child and requires a zero-network-attempt phase acknowledgement", async () => {
  const child = new EventEmitter();
  child.stdout = { resume: vi.fn() };
  child.stderr = { resume: vi.fn() };
  child.send = vi.fn();
  child.kill = vi.fn((signal) => {
    setImmediate(() => child.emit("close", null, signal));
    return true;
  });
  const forkProcess = vi.fn(() => child);
  const owned = startOwnedCrashWorker(
    env,
    crashIdentity(env.PILOT_CRASH_RUN_NONCE),
    "interrupt",
    "/app",
    { forkProcess },
  );
  child.emit("message", { phase: "ready" });
  expect(child.send).toHaveBeenCalledWith({
    type: "start",
    capability: forkProcess.mock.calls[0][2].env.PILOT_CRASH_CAPABILITY,
  });
  expect(forkProcess.mock.calls[0][1]).toEqual(["--worker"]);
  child.emit("message", { phase: "effect_committed", blockedHttpAttempts: 1 });
  await expect(owned.wait("effect_committed", 1)).rejects.toThrow(
    "pilot_crash_worker_timeout",
  );
  child.emit("message", { phase: "effect_committed", blockedHttpAttempts: 0 });
  await expect(owned.wait("effect_committed")).resolves.toEqual({
    blockedHttpAttempts: 0,
  });
  await expect(owned.kill()).resolves.toEqual({
    code: null,
    signal: "SIGKILL",
  });
  await owned.kill();
  expect(child.kill).toHaveBeenCalledTimes(1);
  expect(child.kill).toHaveBeenCalledWith("SIGKILL");
});

describe("crash SQL and actual durable/scoped runtime on disposable PostgreSQL", () => {
  const requireApi = createRequire(
    new URL("../artifacts/api-server/package.json", import.meta.url),
  );
  const { PGlite } = requireApi("@electric-sql/pglite");
  const { PGLiteSocketServer } = requireApi("@electric-sql/pglite-socket");
  let database, server, runtime, client;
  const ids = crashIdentity(env.PILOT_CRASH_RUN_NONCE);
  const originalUrl = process.env.DATABASE_URL;
  beforeAll(async () => {
    database = await PGlite.create();
    await database.exec(await reviewedSchema());
    for (const slug of ["restore-drill-pilot-a", "restore-drill-pilot-b"])
      for (const [table, row] of fixtureRows(
        slug,
        "synthetic-revoked-credential",
      )) {
        const keys = Object.keys(row);
        await database.query(
          `INSERT INTO ${table}(${keys.join(",")}) VALUES(${keys.map((_, i) => `$${i + 1}`).join(",")})`,
          keys.map((key) =>
            [
              "metadata",
              "payload",
              "evidence",
              "options",
              "line_items",
            ].includes(key)
              ? JSON.stringify(row[key])
              : row[key],
          ),
        );
      }
    server = new PGLiteSocketServer({
      db: database,
      host: "127.0.0.1",
      port: 0,
      maxConnections: 10,
    });
    await server.start();
    process.env.DATABASE_URL = `postgresql://postgres:synthetic@${server.getServerConn()}/postgres`;
    runtime = await loadCrashRuntime(
      fileURLToPath(new URL("../", import.meta.url)),
    );
    // Test-only identity adapter: all statements execute against the disposable
    // emulator. No hosted connection guard or CLI bypass is added to the harness.
    const query = runtime.pool.query.bind(runtime.pool);
    runtime.pool.query = async (...args) => {
      const result = await query(...args);
      if (
        typeof args[0] === "string" &&
        args[0].startsWith("SELECT current_database()")
      )
        return {
          ...result,
          rows: [
            {
              ...result.rows[0],
              database: "growthos_staging",
              login: "growthos-staging-live",
              role: "growthos-staging-live",
            },
          ],
        };
      return result;
    };
    client = { query: (...args) => runtime.pool.query(...args) };
  }, 30000);
  afterAll(async () => {
    if (originalUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalUrl;
    if (runtime) await runtime.dispose();
    await new Promise((done) => setTimeout(done, 25));
    if (server) await server.stop();
    await new Promise((done) => setImmediate(done));
    if (database) await database.close();
  });
  it("runs every real safety query and rejects a contactable identity without changing it", async () => {
    await expect(crashPreflight(client, ids)).resolves.toHaveProperty("pid");
    const contact = (await client.query("SELECT id FROM contacts LIMIT 1"))
      .rows[0].id;
    await client.query(
      "UPDATE contacts SET phone='synthetic-phone-marker' WHERE id=$1",
      [contact],
    );
    await expect(crashPreflight(client, ids)).rejects.toThrow(
      "pilot_crash_contactable_or_queued_work",
    );
    expect(
      (await client.query("SELECT phone FROM contacts WHERE id=$1", [contact]))
        .rows[0].phone,
    ).toBe("synthetic-phone-marker");
    await client.query("UPDATE contacts SET phone=NULL WHERE id=$1", [contact]);
  });
  it("seeds only two actions and refuses same-nonce and new-nonce retries without deleting evidence", async () => {
    await seedCrashActions(client, ids);
    await expect(seedCrashActions(client, ids)).rejects.toThrow(
      "pilot_crash_existing_actions_refused",
    );
    await expect(
      seedCrashActions(client, crashIdentity("b4".repeat(16))),
    ).rejects.toThrow("pilot_crash_existing_actions_refused");
    expect(
      Number(
        (await client.query("SELECT count(*) AS count FROM scheduled_actions"))
          .rows[0].count,
      ),
    ).toBe(2);
    await expect(crashPreflight(client, ids, true)).resolves.toHaveProperty(
      "pid",
    );
  });
  it("proves actual durable no-replay and scoped recovery while the first synthetic effect stays suspended", async () => {
    let witnessed;
    const committed = new Promise((done) => {
      witnessed = done;
    });
    // This local test holds the callback; the hosted supervisor supplies the real
    // owned-process SIGKILL. The existing loopback crash test remains unchanged.
    void executeCrashPhase(
      runtime,
      ids,
      "interrupt",
      witnessed,
      () => new Promise(() => {}),
    );
    expect(await committed).toBe("effect_committed");
    const held = await inspectCrashRecords(client, ids, "interrupted");
    await expect(
      advanceSyntheticClock(client, ids, ids.second),
    ).rejects.toThrow("pilot_crash_clock_ownership_changed");
    await advanceSyntheticClock(client, ids, held.firstReceiptId);
    const notify = vi.fn();
    await executeCrashPhase(runtime, ids, "resume", notify, () =>
      Promise.resolve(),
    );
    expect(notify).toHaveBeenCalledWith("resumed");
    expect(await inspectCrashRecords(client, ids, "complete")).toMatchObject({
      taskCount: 2,
      receiptCount: 2,
    });
    await executeCrashPhase(runtime, ids, "resume", notify, () =>
      Promise.resolve(),
    );
    expect((await inspectCrashRecords(client, ids, "complete")).taskCount).toBe(
      2,
    );
    const clock = await client.query(
      "SELECT metadata FROM audit_events WHERE action='pilot.synthetic_crash_clock_advanced'",
    );
    expect(clock.rows).toHaveLength(1);
    expect(clock.rows[0].metadata).toMatchObject({
      syntheticClock: true,
      realElapsedWindow: false,
      onlyOwnedReceipt: true,
    });
    expect(
      Number(
        (await client.query("SELECT count(*) AS count FROM scheduler_runtime"))
          .rows[0].count,
      ),
    ).toBe(0);
  }, 20000);
});
