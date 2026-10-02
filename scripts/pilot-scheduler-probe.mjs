/** Code-only, explicitly approved staging probe. Never starts the real scheduler. */
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const RELEASE_SHA = "c050067000f3ea1f2d94aa53b3a9c4f71f0d3b41";
export const IMAGE_REF = "registry.fly.io/mogulforge-growthos-staging@sha256:0111edc86aaf844e83b0250be7a9deb7accf604d983a66dfbe876f7cd03a42ce";
export const SOURCE_HASHES = {
  "artifacts/api-server/src/services/scheduler-runtime.ts": "83e1e5562d7bf09777db3283f669d7d0a55b393956648a674ba3f493098a29e1",
  "lib/db/src/index.ts": "fc285bc83108137ba57c4c2774a35053e3c25fda1292c3d7a16a57d43dd9679c",
  "lib/db/src/schema/scheduler.ts": "7d92cf16ff0f99eac41074d9b749b160494913f2a15fe5b0714579b849bd5235",
};
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const HOST = "pgbouncer.zp2wjrejd2zodn4q.flympg.net";
const DATABASE = "growthos_staging";
const LOGIN = "growthos-staging-live";
const SLUGS = ["restore-drill-pilot-a", "restore-drill-pilot-b"];
const fail = (label) => { throw new Error(label); };
const ensure = (condition, label) => { if (!condition) fail(label); };
const sha256 = (text) => createHash("sha256").update(text.replace(/\r\n/g, "\n")).digest("hex");
const STAGES = new Set(["configuration", "source_verification", "observer_connect", "observer_session_setup",
  "preflight_begin", "preflight_identity", "preflight_organizations", "preflight_queues", "preflight_rollback",
  "peer_identity", "runtime_snapshot", "probe_lock", "probe_reservation", "runtime_import", "external_exclusion",
  "running_cycle", "running_heartbeat", "concurrent_exclusion", "completed_cycle", "lock_reacquire",
  "failure_cycle", "recovery_cycle", "final_session_check", "cleanup_cycle", "cleanup_runtime",
  "cleanup_row", "cleanup_locks", "cleanup_observer"]);
// Deliberately allowlisted SQLSTATE values, not arbitrary five-character text.
const SQLSTATES = new Set(["08000", "08001", "08003", "08004", "08006", "08007", "08P01", "0A000",
  "22023", "22P02", "23502", "23503", "23505", "23514", "23P01", "25006", "25P01", "25P02", "25P03",
  "28000", "28P01", "3D000", "3F000", "40001", "40P01", "42501", "42601", "42703", "42704", "42804", "42809",
  "42P01", "42P10", "53100", "53200", "53300", "53400", "54000", "54001", "54011", "54023", "55000", "55P03",
  "57014", "57P01", "57P02", "57P03", "58000", "58030", "XX000"]);
const FAILURE_KINDS = new Set(["database_error", "database_timeout", "database_lock_timeout", "driver_query_timeout",
  "connection_failure", "javascript_type_error", "javascript_reference_error", "javascript_syntax_error", "module_load_failure", "operation_error"]);
function sqlstate(error) {
  for (let depth = 0; error && depth < 4; depth++, error = error.cause) {
    if (SQLSTATES.has(error.sqlstate)) return error.sqlstate;
    if (SQLSTATES.has(error.code)) return error.code;
  }
  return null;
}
function failureKind(error) {
  if (FAILURE_KINDS.has(error?.failureKind)) return error.failureKind;
  const code = sqlstate(error);
  if (code === "57014") return "database_timeout";
  if (code === "55P03") return "database_lock_timeout";
  if (code) return "database_error";
  for (let depth = 0; error && depth < 4; depth++, error = error.cause) {
    if (error.message === "Query read timeout") return "driver_query_timeout";
    if (["Connection terminated unexpectedly", "Connection terminated", "Connection terminated due to connection timeout",
      "timeout exceeded when trying to connect", "Client has encountered a connection error and is not queryable",
      "Client was closed and is not queryable"].includes(error.message) ||
      ["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "EPIPE", "ENOTFOUND", "EAI_AGAIN"].includes(error.code)) return "connection_failure";
    if (error.name === "TypeError") return "javascript_type_error";
    if (error.name === "ReferenceError") return "javascript_reference_error";
    if (error.name === "SyntaxError") return "javascript_syntax_error";
    if (error.code === "ERR_MODULE_NOT_FOUND" || error.code === "MODULE_NOT_FOUND") return "module_load_failure";
  }
  return "operation_error";
}
function diagnostic(error, stage) {
  const safe = new Error(safeProbeError(error));
  safe.probeStage = STAGES.has(error?.probeStage) ? error.probeStage : STAGES.has(stage) ? stage : "unknown";
  safe.sqlstate = sqlstate(error);
  safe.failureKind = failureKind(error);
  if (Number.isInteger(error?.operationElapsedMs) && error.operationElapsedMs >= 0)
    safe.operationElapsedMs = Math.min(error.operationElapsedMs, 60000);
  return safe;
}
async function atStage(stage, work) {
  try { return await work(); } catch (error) { throw diagnostic(error, stage); }
}

export function probePoolOptions(max, applicationName) {
  // Leave time for the 8-second SERVER timeout to return its SQLSTATE before
  // the driver's timeout (which has no SQLSTATE) wins the race.
  return { max, connectionTimeoutMillis: 5000, query_timeout: 10000, application_name: applicationName };
}
export function prepareRuntimePool(pool) {
  Object.assign(pool.options, probePoolOptions(4, "growthos-pilot-scheduler-probe"));
  // node-postgres sends statement_timeout in its startup packet when set as
  // an option. PgBouncer need not accept that parameter. Set it as SQL only
  // after connecting; pg-pool's verify callback blocks checkout until done.
  delete pool.options.statement_timeout;
  pool.options.verify = (client, done) => {
    client.query("SET statement_timeout = '8s'").then(() => done(), done);
  };
  pool.on("error", () => {});
}

export function probeConfiguration(env = process.env) {
  ensure(env.FLY_APP_NAME === "mogulforge-growthos-staging" &&
    env.APP_ORIGIN === "https://mogulforge-growthos-staging.fly.dev" &&
    env.SCHEDULER_AUTOSTART === "false" && env.GROWTHOS_OUTBOUND_HOLD === "true" &&
    env.STAGING_OUTBOUND_APPROVED === "false" && env.STAGING_SCHEMA_PUSH_APPROVED === "false" &&
    env.AUTO_MIGRATE !== "true" && !env.RESTORE_DRILL_ONLY &&
    env.PILOT_SCHEDULER_PROBE_APPROVED === "true", "pilot_scheduler_identity_or_holds_missing");
  ensure(env.RESTORE_DRILL_RELEASE_SHA === RELEASE_SHA && env.RESTORE_DRILL_IMAGE_REF === IMAGE_REF,
    "pilot_scheduler_release_mismatch");
  ensure(!["PGHOST", "PGDATABASE", "PGUSER", "PGSERVICE", "PGSERVICEFILE", "PGOPTIONS"]
    .some((key) => env[key]), "pilot_scheduler_connection_override_forbidden");
  let url;
  try { url = new URL(env.DATABASE_URL); } catch { fail("pilot_scheduler_database_url_invalid"); }
  ensure(["postgres:", "postgresql:"].includes(url.protocol) && url.hostname === HOST &&
    decodeURIComponent(url.pathname.slice(1)) === DATABASE && decodeURIComponent(url.username) === LOGIN &&
    Boolean(url.password) && (!url.port || url.port === "5432") && !url.hash &&
    [...url.searchParams].length <= 1 && [...url.searchParams].every(([key, value]) => key === "sslmode" && value === "require"),
    "pilot_scheduler_database_target_mismatch");
  return { host: HOST, database: DATABASE, login: LOGIN, releaseSha: RELEASE_SHA };
}

export async function verifyProbeSources(root = ROOT, read = readFile) {
  for (const [path, expected] of Object.entries(SOURCE_HASHES)) {
    ensure(sha256(await read(resolve(root, path), "utf8")) === expected,
      "pilot_scheduler_source_hash_mismatch");
  }
  // The uploaded helper is not application code from the image. Its entire
  // allowlisted content is checked before tsImport can load it.
  const helper = await read(resolve(root, "scripts/pilot-scheduler-runtime.ts"), "utf8");
  ensure(helper.replace(/\r\n/g, "\n") ===
    '// Import through one tsx namespace so the probe can close the scheduler\'s pool.\n' +
    '// Do not import scheduler.ts, automation.ts, app.ts, or any provider here.\n' +
    'export { runSchedulerCycle, schedulerHealth } from "../artifacts/api-server/src/services/scheduler-runtime";\n' +
    'export { pool } from "../lib/db/src/index";\n', "pilot_scheduler_helper_mismatch");
}

function fixtureOrgId(slug) {
  const h = createHash("sha256").update(`growthos-restore-v1:${slug}:organization`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

const identitySql = "SELECT current_database() AS database, session_user AS login, current_user AS role, pg_backend_pid() AS pid";
const runtimeSql = "SELECT * FROM scheduler_runtime WHERE name = $1";
const defaultDigestSql = "SELECT md5(coalesce((SELECT to_jsonb(r)::text FROM scheduler_runtime r WHERE name = 'automation'), '')) AS digest";
const lockSql = "SELECT pg_try_advisory_lock(hashtext($1)) AS acquired";
const unlockSql = "SELECT pg_advisory_unlock(hashtext($1)) AS released";
export async function reserveProbeRuntime(client, name, owner) {
  const started = Date.now();
  try {
    const reserved = await client.query(`INSERT INTO scheduler_runtime(name, owner_id, state, interval_ms, started_at, heartbeat_at)
        VALUES($1, $2, 'stopped', 60000, now(), now()) ON CONFLICT DO NOTHING RETURNING name`, [name, owner]);
    ensure(Array.isArray(reserved?.rows), "pilot_scheduler_reservation_result_invalid");
    ensure(reserved.rows.length === 1 && reserved.rows[0]?.name === name, "pilot_scheduler_probe_row_exists");
  } catch (error) {
    const safe = diagnostic(error, "probe_reservation");
    safe.operationElapsedMs = Math.min(60000, Math.max(0, Date.now() - started));
    throw safe;
  }
}
const unsafeSql = `SELECT
  (SELECT count(*) FROM scheduled_actions) +
  (SELECT count(*) FROM reactivation_campaigns) +
  (SELECT count(*) FROM webhook_deliveries) +
  (SELECT count(*) FROM webhook_endpoints WHERE is_active = true) +
  (SELECT count(*) FROM automations WHERE is_active = true) +
  (SELECT count(*) FROM playbook_enrollments WHERE status IN ('active', 'paused')) +
  (SELECT count(*) FROM appointments) +
  (SELECT count(*) FROM conversations) +
  (SELECT count(*) FROM api_keys WHERE is_active = true AND revoked_at IS NULL) +
  (SELECT count(*) FROM service_obligations WHERE status = 'active') +
  (SELECT count(*) FROM bie_action_proposals WHERE status <> 'rejected') +
  (SELECT count(*) FROM revenue_executions WHERE state <> 'blocked') +
  (SELECT count(*) FROM gmail_connections WHERE revoked_at IS NULL) +
  (SELECT count(*) FROM contacts WHERE phone IS NOT NULL OR email IS NULL OR email NOT LIKE '%.invalid'
    OR do_not_contact = false OR do_not_contact_email = false OR do_not_contact_sms = false) +
  (SELECT count(*) FROM users WHERE email IS NULL OR email NOT LIKE '%.invalid' OR password_hash IS NOT NULL OR is_platform_admin = true)
  AS unsafe_count`;

export async function probePreflight(client) {
  await atStage("preflight_begin", () => client.query("BEGIN READ ONLY"));
  try {
    const identity = (await atStage("preflight_identity", () => client.query(identitySql))).rows[0];
    ensure(identity?.database === DATABASE && identity.login === LOGIN && identity.role === LOGIN &&
      Number.isInteger(identity.pid), "pilot_scheduler_session_identity_mismatch");
    const orgs = (await atStage("preflight_organizations", () => client.query("SELECT id, slug, name FROM organizations ORDER BY slug"))).rows;
    ensure(orgs.length === 2 && orgs.every((org, index) => org.slug === SLUGS[index] &&
      org.id === fixtureOrgId(org.slug) && org.name === `SYNTHETIC RESTORE ONLY — ${org.slug}`),
      "pilot_scheduler_nonfixture_organizations");
    const unsafe = (await atStage("preflight_queues", () => client.query(unsafeSql))).rows[0]?.unsafe_count;
    ensure(unsafe !== undefined && Number(unsafe) === 0, "pilot_scheduler_queued_or_contactable_work");
    return identity;
  } finally { await atStage("preflight_rollback", () => client.query("ROLLBACK")); }
}

function runtimeRow(row) {
  ensure(row, "pilot_scheduler_runtime_missing");
  return { ...row, ownerId: row.owner_id, heartbeatAt: new Date(row.heartbeat_at),
    startedAt: new Date(row.started_at), completedAt: row.completed_at ? new Date(row.completed_at) : null,
    currentStage: row.current_stage, failedStages: row.failed_stages };
}

function deadline(promise, ms = 12000) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("pilot_scheduler_probe_timeout")), ms);
  })]).finally(() => clearTimeout(timer));
}

async function defaultRuntime(root, env) {
  // @workspace/db reads process.env at import time. Never validate one URL
  // for the observer and then let the real runtime inherit a different one.
  probeConfiguration(process.env);
  ensure(process.env.DATABASE_URL === env.DATABASE_URL, "pilot_scheduler_runtime_environment_mismatch");
  const require = createRequire(resolve(root, "scripts/package.json"));
  const { tsImport } = await import(pathToFileURL(require.resolve("tsx/esm/api")).href);
  const runtime = await tsImport(pathToFileURL(resolve(root, "scripts/pilot-scheduler-runtime.ts")).href, import.meta.url);
  // These configure only this one-shot import's still-unused pool, not the app.
  prepareRuntimePool(runtime.pool);
  return runtime;
}

/** Injected dependencies are for local unit tests; CLI accepts no arguments. */
export async function runSchedulerProbe({ env = process.env, root = ROOT, read = readFile,
  createPool, loadRuntime = defaultRuntime, emit = console.log } = {}) {
  const target = await atStage("configuration", () => probeConfiguration(env));
  await atStage("source_verification", () => verifyProbeSources(root, read));
  const require = createRequire(resolve(root, "artifacts/api-server/package.json"));
  const makePool = createPool || ((options) => new (require("pg").Pool)(options));
  const pool = makePool({ connectionString: env.DATABASE_URL,
    ...probePoolOptions(2, "growthos-pilot-scheduler-observer") });
  pool.on("error", () => {});
  const name = `pilot-scheduler-probe-${randomUUID()}`;
  const owners = ["reserved", "first", "contender", "failed", "recovered"].map((part) => `${name}:${part}`);
  const lockKey = `growthos:scheduler:${name}`;
  const clients = [];
  let runtime, first, finish, owned = false, failed = false, evidence, stage = "observer_connect";
  try {
    // Keep both pooled clients checked out for the entire experiment.
    for (let index = 0; index < 2; index++) {
      stage = "observer_connect";
      const client = await pool.connect();
      client.on("error", () => {}); // Queries report failure; never print the raw socket error.
      clients.push(client);
      stage = "observer_session_setup";
      await client.query("SET statement_timeout = '8s'");
    }
    const [a, b] = clients;
    stage = "preflight_identity";
    const identityA = await probePreflight(a);
    stage = "peer_identity";
    const identityB = (await b.query(identitySql)).rows[0];
    ensure(identityB?.database === DATABASE && identityB.login === LOGIN && identityB.role === LOGIN &&
      Number.isInteger(identityB.pid) && identityA.pid !== identityB.pid, "pilot_scheduler_sessions_not_independent");
    stage = "runtime_snapshot";
    const before = (await a.query(defaultDigestSql)).rows[0]?.digest;
    ensure(typeof before === "string", "pilot_scheduler_default_row_digest_missing");
    stage = "probe_lock";
    ensure((await a.query(lockSql, [lockKey])).rows[0]?.acquired === true, "pilot_scheduler_probe_name_busy");
    stage = "probe_reservation";
    await reserveProbeRuntime(a, name, owners[0]);
    owned = true;
    stage = "runtime_import";
    runtime = await loadRuntime(root, env);
    let unexpectedCallback = false;
    const neverWork = async () => { unexpectedCallback = true; };
    stage = "external_exclusion";
    ensure((await b.query(lockSql, [lockKey])).rows[0]?.acquired === false,
      "pilot_scheduler_session_lock_exclusion_failed");
    ensure(await runtime.runSchedulerCycle(neverWork, { name, ownerId: owners[2] }) === "busy" && !unexpectedCallback,
      "pilot_scheduler_external_lock_not_respected");
    ensure((await a.query(unlockSql, [lockKey])).rows[0]?.released === true, "pilot_scheduler_lock_release_failed");
    let entered;
    const started = new Promise((done) => { entered = done; });
    const held = new Promise((done) => { finish = done; });
    stage = "running_cycle";
    first = runtime.runSchedulerCycle(async (observe) => {
      await observe("scheduled-actions", "running");
      entered();
      await held;
      await observe("scheduled-actions", "succeeded");
    }, { name, ownerId: owners[1] });
    await deadline(Promise.race([started, first.then(() => fail("pilot_scheduler_cycle_did_not_enter"))]));
    stage = "running_heartbeat";
    const running = runtimeRow((await a.query(runtimeSql, [name])).rows[0]);
    ensure(running.ownerId === owners[1] && running.currentStage === "scheduled-actions" &&
      runtime.schedulerHealth(running) === "running", "pilot_scheduler_running_heartbeat_missing");
    stage = "concurrent_exclusion";
    ensure((await b.query(lockSql, [lockKey])).rows[0]?.acquired === false,
      "pilot_scheduler_runtime_lock_not_held");
    ensure(await runtime.runSchedulerCycle(neverWork, { name, ownerId: owners[2] }) === "busy" && !unexpectedCallback,
      "pilot_scheduler_concurrent_cycle_not_excluded");
    stage = "completed_cycle";
    finish();
    ensure(await deadline(first) === "idle", "pilot_scheduler_first_cycle_failed");
    first = undefined;
    const idle = runtimeRow((await a.query(runtimeSql, [name])).rows[0]);
    ensure(idle.ownerId === owners[1] && idle.completedAt && runtime.schedulerHealth(idle) === "healthy",
      "pilot_scheduler_completed_heartbeat_missing");
    stage = "lock_reacquire";
    ensure((await b.query(lockSql, [lockKey])).rows[0]?.acquired === true, "pilot_scheduler_lock_not_released");
    ensure((await b.query(unlockSql, [lockKey])).rows[0]?.released === true, "pilot_scheduler_lock_release_failed");
    stage = "failure_cycle";
    const degraded = await runtime.runSchedulerCycle(async (observe) => {
      await observe("scheduled-actions", "running");
      await observe("scheduled-actions", "failed");
    }, { name, ownerId: owners[3] });
    const failure = runtimeRow((await a.query(runtimeSql, [name])).rows[0]);
    ensure(degraded === "degraded" && failure.ownerId === owners[3] && failure.completedAt &&
      runtime.schedulerHealth(failure) === "degraded" &&
      JSON.stringify(failure.failedStages) === '["scheduled-actions"]', "pilot_scheduler_failure_not_visible");
    stage = "recovery_cycle";
    const recovery = await runtime.runSchedulerCycle(async (observe) => {
      await observe("scheduled-actions", "running");
      await observe("scheduled-actions", "succeeded");
    }, { name, ownerId: owners[4] });
    const recovered = runtimeRow((await a.query(runtimeSql, [name])).rows[0]);
    ensure(recovery === "idle" && recovered.ownerId === owners[4] && recovered.completedAt &&
      runtime.schedulerHealth(recovered) === "healthy" && recovered.failedStages.length === 0,
      "pilot_scheduler_recovery_not_visible");
    stage = "final_session_check";
    const finalPids = await Promise.all(clients.map(async (client) => (await client.query(identitySql)).rows[0]?.pid));
    ensure(finalPids[0] === identityA.pid && finalPids[1] === identityB.pid, "pilot_scheduler_session_backend_changed");
    ensure((await a.query(defaultDigestSql)).rows[0]?.digest === before, "pilot_scheduler_default_row_changed");
    evidence = { check: "pilot_scheduler_probe", ...target, imageReference: IMAGE_REF,
      sourceModuleHashesVerified: true, imageIdentity: "operator-pinned; correlate with Fly Machine image record",
      syntheticOrganizationsOnly: true, queuedEffectsAbsent: true,
      independentPooledSessions: 2, backendPids: finalPids, stableSessionBackends: true,
      externalLockRespected: true, concurrentCycleExcluded: true, releaseAndReacquireVerified: true,
      heartbeatVisible: true, failedStageVisible: true, recoveryVisible: true, defaultRuntimeUnchanged: true,
      schedulerAutostartEnabled: false, realSchedulerStagesCalled: false, providersCalled: false,
      schedulerRestartVerified: false, alwaysOnIdleCyclesVerified: false,
      boundary: "Synthetic runtime and session-lock evidence only; not normal scheduler, restart, delivery or pilot acceptance." };
  } catch (error) {
    failed = true;
    const safe = diagnostic(error, stage);
    safe.runtimeName = name;
    if (stage === "probe_reservation" && safe.message !== "pilot_scheduler_probe_row_exists")
      safe.reservationMayHaveCommitted = true;
    throw safe;
  } finally {
    finish?.();
    // A partially entered cycle must finish before deleting its owned row.
    let cleanupOk = true, cleanupError;
    const cleanupFailed = (error, phase) => { cleanupOk = false; cleanupError ||= diagnostic(error, phase); };
    if (first) await deadline(first).catch((error) => cleanupFailed(error, "cleanup_cycle"));
    if (runtime) await deadline(runtime.pool.end()).catch((error) => cleanupFailed(error, "cleanup_runtime"));
    if (owned && cleanupOk) {
      const removed = await clients[0].query("DELETE FROM scheduler_runtime WHERE name = $1 AND owner_id = ANY($2::text[]) RETURNING name", [name, owners])
        .catch((error) => cleanupFailed(error, "cleanup_row"));
      if (removed?.rows.length !== 1) cleanupFailed(new Error("pilot_scheduler_cleanup_incomplete"), "cleanup_row");
    }
    await Promise.all(clients.map(async (client) => {
      // Only this random probe lock, never pg_advisory_unlock_all(). Destroy
      // the checked-out clients as a second safeguard against leaked locks.
      await client.query(unlockSql, [lockKey]).catch((error) => cleanupFailed(error, "cleanup_locks"));
      client.release(true);
    }));
    await deadline(pool.end()).catch((error) => cleanupFailed(error, "cleanup_observer"));
    if (!cleanupOk) {
      const error = diagnostic(cleanupError, "cleanup_observer");
      error.message = "pilot_scheduler_cleanup_incomplete";
      error.runtimeName = name;
      throw error;
    }
    if (!failed && evidence) evidence.ownRuntimeRowRemoved = true;
  }
  emit(JSON.stringify(evidence, null, 2));
  return evidence;
}

export function safeProbeError(error) {
  return /^pilot_scheduler_[a-z_]+$/.test(error?.message || "") ? error.message : "pilot_scheduler_operation_failed";
}

export function probeFailureEvidence(error) {
  return { check: "pilot_scheduler_probe", ok: false, error: safeProbeError(error),
    stage: STAGES.has(error?.probeStage) ? error.probeStage : "unknown", sqlstate: sqlstate(error), failureKind: failureKind(error),
    ...(/^pilot-scheduler-probe-[a-f0-9-]{36}$/.test(error?.runtimeName || "") ? { runtimeName: error.runtimeName } : {}),
    ...(error?.reservationMayHaveCommitted === true ? { reservationMayHaveCommitted: true } : {}),
    ...(Number.isInteger(error?.operationElapsedMs) && error.operationElapsedMs >= 0
      ? { operationElapsedMs: Math.min(error.operationElapsedMs, 60000) } : {}) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const run = async () => {
    ensure(process.argv.length === 2, "pilot_scheduler_arguments_forbidden");
    await runSchedulerProbe();
  };
  run().catch((error) => {
    console.error(`PILOT_SCHEDULER_PROBE_FAILED:${safeProbeError(error)}`);
    console.error(JSON.stringify(probeFailureEvidence(error), null, 2));
    process.exitCode = 1;
  });
}
