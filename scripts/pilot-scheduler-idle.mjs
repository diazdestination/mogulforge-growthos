/** Same-image, provider-free actual scheduler idle/ordinary restart acceptance. */
import { createHash, randomBytes } from "node:crypto";
import { fork } from "node:child_process";
import { mkdir, mkdtemp, readFile, rmdir, unlink } from "node:fs/promises";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
import https from "node:https";
import { IMAGE_REF, RELEASE_SHA, SOURCE_HASHES, prepareRuntimePool, probeConfiguration,
  probeFailureEvidence, probePoolOptions } from "./pilot-scheduler-probe.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const FILE = fileURLToPath(import.meta.url);
const SLUGS = ["restore-drill-pilot-a", "restore-drill-pilot-b"];
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const HELPER = '// One namespace for the real scheduler and its shared pool. No server bootstrap.\n' +
  'export { startAutomationScheduler, stopAutomationScheduler } from "../artifacts/api-server/src/services/scheduler";\n' +
  'export { pool } from "../lib/db/src/index";\n';
export const IDLE_SOURCE_HASHES = { ...SOURCE_HASHES,
  "artifacts/api-server/src/services/scheduler.ts": "2101e3019448b13f83abf4237db805d395adc33509ab76388e617230971b94d8",
  "artifacts/api-server/src/services/scheduler-loop.ts": "ae378682d9f1b495769b4935dd8100e37c2dded5227d0336b22db116a67660e0",
  "artifacts/api-server/src/services/automation.ts": "1e615fe60b70c65529d0b1c61e707b073d29409d0255decf70e0313decf901c1",
};
const PHASES = new Set(["configuration", "source", "connect", "preflight", "fingerprint", "first_worker",
  "restart_worker", "final_fingerprint", "runtime_cleanup", "cleanup", "worker_import", "worker_start", "worker_poll", "worker_stop"]);
const fail = (label) => { throw new Error(label); };
const ensure = (value, label) => { if (!value) fail(label); };
const digest = (text) => createHash("sha256").update(text.replace(/\r\n/g, "\n")).digest("hex");
const identitySql = "SELECT current_database() AS database, session_user AS login, current_user AS role";
const runtimeSql = "SELECT * FROM scheduler_runtime WHERE name = 'automation'";
export const IDLE_INTERLOCK = "growthos:pilot:hosted-supervisor";

export function idleConfiguration(env = process.env) {
  const identity = probeConfiguration(env);
  ensure(env.PILOT_SCHEDULER_IDLE_APPROVED === "true" && env.PILOT_SCHEDULER_MAIN_APP_STOPPED === "true" &&
    env.PILOT_SCHEDULER_ZERO_SERVICES === "true",
    "pilot_idle_approval_or_stopped_attestation_missing");
  return identity;
}

export async function verifyIdleSources(root = ROOT, read = readFile) {
  for (const [path, hash] of Object.entries(IDLE_SOURCE_HASHES))
    ensure(digest(await read(resolve(root, path), "utf8")) === hash, "pilot_idle_source_mismatch");
  ensure((await read(resolve(root, "scripts/pilot-scheduler-idle-runtime.ts"), "utf8")).replace(/\r\n/g, "\n") === HELPER,
    "pilot_idle_helper_mismatch");
}

export async function readDefaultSeedSpec(root = ROOT, read = readFile) {
  const text = await read(resolve(root, "artifacts/api-server/src/services/automation.ts"), "utf8");
  ensure(digest(text) === IDLE_SOURCE_HASHES["artifacts/api-server/src/services/automation.ts"], "pilot_idle_source_mismatch");
  const names = ["DEFAULT_ABANDONED_FOLLOWUP_NAME", "DEFAULT_ABANDONED_FOLLOWUP_SEED_KEY", "DEFAULT_ABANDONED_SMS_TEMPLATE_NAME",
    "DEFAULT_ABANDONED_EMAIL_TEMPLATE_NAME", "DEFAULT_ABANDONED_SMS_BODY", "DEFAULT_ABANDONED_EMAIL_SUBJECT",
    "DEFAULT_ABANDONED_EMAIL_BODY", "GENERIC_ABANDONED_SMS_BODY", "GENERIC_ABANDONED_EMAIL_SUBJECT", "GENERIC_ABANDONED_EMAIL_BODY"];
  return Object.fromEntries(names.map((name) => {
    const match = new RegExp(`\\b${name}\\s*=\\s*("(?:[^"\\\\]|\\\\.)*")\\s*;`).exec(text);
    ensure(match, "pilot_idle_seed_source_unrecognized");
    return [name, JSON.parse(match[1])];
  }));
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
export function assertInertDefaults(orgIds, rules, templates, spec) {
  ensure(rules.every((row) => orgIds.includes(row.organization_id)) && templates.every((row) => orgIds.includes(row.organization_id)), "pilot_idle_foreign_defaults");
  for (const org of orgIds) {
    const selected = rules.filter((row) => row.organization_id === org);
    const mail = templates.filter((row) => row.organization_id === org);
    if (!selected.length && !mail.length) continue;
    ensure(selected.length === 1 && mail.length === 2, "pilot_idle_partial_or_extra_defaults");
    const sms = mail.find((row) => row.name === spec.DEFAULT_ABANDONED_SMS_TEMPLATE_NAME);
    const email = mail.find((row) => row.name === spec.DEFAULT_ABANDONED_EMAIL_TEMPLATE_NAME);
    ensure(sms && email && sms.id !== email.id && sms.channel === "sms" && sms.subject === null &&
      sms.body === spec.GENERIC_ABANDONED_SMS_BODY && email.channel === "email" &&
      email.subject === spec.GENERIC_ABANDONED_EMAIL_SUBJECT && email.body === spec.GENERIC_ABANDONED_EMAIL_BODY &&
      sms.is_active === true && email.is_active === true, "pilot_idle_customized_templates");
    const rule = selected[0];
    const actions = [
      { type: "send_sms", params: { templateId: sms.id, body: spec.DEFAULT_ABANDONED_SMS_BODY } },
      { type: "send_email", params: { templateId: email.id, subject: spec.DEFAULT_ABANDONED_EMAIL_SUBJECT, body: spec.DEFAULT_ABANDONED_EMAIL_BODY } },
      { type: "create_task", params: { title: "Call back: homeowner abandoned concierge chat" } },
    ];
    ensure(rule.name === spec.DEFAULT_ABANDONED_FOLLOWUP_NAME && rule.seed_key === spec.DEFAULT_ABANDONED_FOLLOWUP_SEED_KEY &&
      rule.event === "assessment.abandoned" && rule.is_active === true && canonical(rule.conditions) === "{}" &&
      canonical(rule.actions) === canonical(actions), "pilot_idle_customized_automation");
  }
}

const unsafeSql = `SELECT
  (SELECT count(*) FROM scheduled_actions) + (SELECT count(*) FROM reactivation_campaigns) +
  (SELECT count(*) FROM webhook_deliveries) + (SELECT count(*) FROM webhook_endpoints WHERE is_active = true OR previous_secret IS NOT NULL) +
  (SELECT count(*) FROM playbook_enrollments) + (SELECT count(*) FROM appointments) + (SELECT count(*) FROM conversations) +
  (SELECT count(*) FROM api_keys WHERE is_active = true AND revoked_at IS NULL) +
  (SELECT count(*) FROM service_obligations WHERE status = 'active') +
  (SELECT count(*) FROM bie_action_proposals WHERE status <> 'rejected') +
  (SELECT count(*) FROM revenue_executions WHERE state <> 'blocked') +
  (SELECT count(*) FROM gmail_connections WHERE revoked_at IS NULL) +
  (SELECT count(*) FROM twilio_client_bindings) +
  (SELECT count(*) FROM org_settings WHERE fallback_notification_inbox IS NOT NULL OR customer_email_sender_user_id IS NOT NULL OR google_reviews IS NOT NULL) +
  (SELECT count(*) FROM portal_login_codes) + (SELECT count(*) FROM portal_sessions) +
  (SELECT count(*) FROM email_intelligence_messages) +
  (SELECT count(*) FROM contacts WHERE phone IS NOT NULL OR email IS NULL OR email NOT LIKE '%.invalid'
    OR do_not_contact = false OR do_not_contact_email = false OR do_not_contact_sms = false) +
  (SELECT count(*) FROM users WHERE email IS NULL OR email NOT LIKE '%.invalid' OR password_hash IS NOT NULL OR is_platform_admin = true)
  AS unsafe_count`;

export async function idlePreflight(client, spec, { allowStoppedOwner } = {}) {
  await client.query("BEGIN READ ONLY");
  try {
    const identity = (await client.query(identitySql)).rows[0];
    ensure(identity?.database === "growthos_staging" && identity.login === "growthos-staging-live" && identity.role === identity.login,
      "pilot_idle_database_identity_mismatch");
    const orgs = (await client.query("SELECT id, slug, name FROM organizations ORDER BY slug")).rows;
    ensure(orgs.length === 2 && orgs.every((row, index) => row.slug === SLUGS[index] &&
      row.name === `SYNTHETIC RESTORE ONLY — ${row.slug}` && UUID.test(row.id)), "pilot_idle_nonfixture_organizations");
    // Existing fixture identities are pinned independently of a display name.
    for (const row of orgs) {
      const h = createHash("sha256").update(`growthos-restore-v1:${row.slug}:organization`).digest("hex");
      ensure(row.id === `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`, "pilot_idle_fixture_identity_mismatch");
    }
    const count = (await client.query(unsafeSql)).rows[0]?.unsafe_count;
    ensure(count !== undefined && Number(count) === 0, "pilot_idle_queued_contactable_or_cleanup_work");
    const rules = (await client.query("SELECT * FROM automations")).rows;
    const templates = (await client.query("SELECT * FROM message_templates")).rows;
    assertInertDefaults(orgs.map((row) => row.id), rules, templates, spec);
    const rows = (await client.query(runtimeSql)).rows;
    ensure(allowStoppedOwner ? rows.length === 1 && rows[0].owner_id === allowStoppedOwner && rows[0].state === "stopped" : rows.length === 0,
      "pilot_idle_runtime_not_exclusively_available");
    return { orgIds: orgs.map((row) => row.id), defaultRules: rules.length, defaultTemplates: templates.length };
  } finally { await client.query("ROLLBACK"); }
}

export async function tenantFingerprint(client, orgIds) {
  const tables = (await client.query("SELECT table_name FROM information_schema.columns WHERE table_schema='public' AND column_name='organization_id' ORDER BY table_name")).rows;
  const result = {};
  result.organizations = (await client.query("SELECT md5(coalesce(string_agg(md5(to_jsonb(t)::text), ',' ORDER BY md5(to_jsonb(t)::text)), '')) AS digest FROM organizations t")).rows[0]?.digest;
  ensure(/^[a-f0-9]{32}$/.test(result.organizations || ""), "pilot_idle_fingerprint_invalid");
  for (const { table_name: table } of tables) {
    ensure(/^[a-z_]+$/.test(table), "pilot_idle_table_identifier_invalid");
    result[table] = (await client.query(`SELECT md5(coalesce(string_agg(md5(to_jsonb(t)::text), ',' ORDER BY md5(to_jsonb(t)::text)), '')) AS digest
      FROM ${table} t WHERE organization_id = ANY($1::uuid[])`, [orgIds])).rows[0]?.digest;
    ensure(/^[a-f0-9]{32}$/.test(result[table] || ""), "pilot_idle_fingerprint_invalid");
  }
  return canonical(result);
}

/** Disposable CJS build of one pinned helper; preserves a single db/runtime namespace. */
export async function loadIdleRuntime(root = ROOT) {
  const api = resolve(root, "artifacts/api-server");
  const require = createRequire(resolve(api, "package.json"));
  const cache = resolve(api, "node_modules/.cache");
  await mkdir(cache, { recursive: true });
  const folder = await mkdtemp(resolve(cache, "pilot-idle-"));
  const output = resolve(folder, "runtime.cjs");
  const remove = async () => {
    await unlink(output).catch((error) => { if (error.code !== "ENOENT") throw error; });
    await rmdir(folder);
  };
  try {
    await require("esbuild").build({ entryPoints: [resolve(root, "scripts/pilot-scheduler-idle-runtime.ts")],
      outfile: output, platform: "node", format: "cjs", bundle: true, packages: "external", logLevel: "silent",
      plugins: [{ name: "bundle-workspace-source", setup(builder) {
        builder.onResolve({ filter: /^(@workspace\/|drizzle-zod$)/ },
          (args) => ({ path: require.resolve(args.path, { paths: [args.resolveDir] }) }));
      } }] });
    const runtime = require(output);
    prepareRuntimePool(runtime.pool);
    return { ...runtime, async dispose() {
      try { await runtime.pool.end(); }
      finally { delete require.cache[output]; await remove(); }
    } };
  } catch (error) { await remove().catch(() => {}); throw error; }
}

export function idleChildEnvironment(parent, previousOwner) {
  idleConfiguration(parent);
  ensure(!previousOwner || UUID.test(previousOwner), "pilot_idle_previous_owner_invalid");
  const inherited = Object.fromEntries(Object.entries(parent).filter(([key]) => /^(PATH|SystemRoot|WINDIR|TEMP|TMP|PATHEXT|COMSPEC|LANG|TZ)$/i.test(key)));
  return { ...inherited, NODE_ENV: "production", LOG_LEVEL: "silent", DATABASE_URL: parent.DATABASE_URL,
    SESSION_SECRET: randomBytes(32).toString("hex"), OBJECT_STORAGE_PROVIDER: "postgres",
    FLY_APP_NAME: "mogulforge-growthos-staging", APP_ORIGIN: "https://mogulforge-growthos-staging.fly.dev",
    AUTO_MIGRATE: "false", SCHEDULER_AUTOSTART: "true", GROWTHOS_OUTBOUND_HOLD: "true", STAGING_OUTBOUND_APPROVED: "false",
    STAGING_SCHEMA_PUSH_APPROVED: "false", PILOT_SCHEDULER_PROBE_APPROVED: "true", PILOT_SCHEDULER_IDLE_APPROVED: "true",
    PILOT_SCHEDULER_MAIN_APP_STOPPED: "true", PILOT_SCHEDULER_ZERO_SERVICES: "true", PILOT_SCHEDULER_IDLE_CHILD: "true",
    RESTORE_DRILL_RELEASE_SHA: RELEASE_SHA, RESTORE_DRILL_IMAGE_REF: IMAGE_REF,
    ...(previousOwner ? { PILOT_IDLE_PREVIOUS_OWNER: previousOwner } : {}) };
}

function deadline(promise, ms, label) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label)), ms); })])
    .finally(() => clearTimeout(timer));
}

export function idleFailureEvidence(error, phase = "cleanup") {
  const common = probeFailureEvidence(error);
  return { check: "pilot_scheduler_idle", ok: false,
    error: /^pilot_(idle|scheduler)_[a-z_]+$/.test(error?.message || "") ? error.message : "pilot_idle_operation_failed",
    phase: PHASES.has(phase) ? phase : "cleanup", sqlstate: common.sqlstate, failureKind: common.failureKind };
}

/** Deletes only the stopped row acknowledged by our final child, under the real lock. */
export async function cleanupIdleRuntime(client, expectedOwner) {
  ensure(UUID.test(expectedOwner || ""), "pilot_idle_cleanup_owner_missing");
  const key = "growthos:scheduler:automation";
  const acquired = (await client.query("SELECT pg_try_advisory_lock(hashtext($1)) AS acquired", [key])).rows[0]?.acquired;
  ensure(acquired === true, "pilot_idle_cleanup_worker_still_active");
  try {
    const result = await client.query("DELETE FROM scheduler_runtime WHERE name='automation' AND owner_id=$1 AND state='stopped' RETURNING name", [expectedOwner]);
    ensure(result.rows.length === 1, "pilot_idle_cleanup_foreign_or_running_owner");
  } finally {
    const released = (await client.query("SELECT pg_advisory_unlock(hashtext($1)) AS released", [key])).rows[0]?.released;
    ensure(released === true, "pilot_idle_cleanup_lock_release_unconfirmed");
  }
}

function superviseChild(env, { previousOwner, cyclesRequired, forkProcess = fork, root = ROOT } = {}) {
  const child = forkProcess(FILE, ["--worker"], { cwd: root, env: idleChildEnvironment(env, previousOwner),
    execArgv: [], stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: true });
  // Consume but never forward raw application logs, driver stacks or SDK output.
  child.stdout?.resume(); child.stderr?.resume();
  const cycles = [], subscribers = new Set();
  let owner, stopped, exited, failure;
  const wake = () => { for (const callback of subscribers) callback(); };
  child.on("message", (value) => {
    if (!value || !["cycle", "stopped", "failure"].includes(value.phase)) return;
    if (value.phase === "failure") {
      failure = new Error("pilot_idle_worker_reported_failure");
      failure.workerEvidence = idleFailureEvidence({ message: value.diagnostic?.error, code: value.diagnostic?.sqlstate }, value.diagnostic?.phase);
      wake(); return;
    }
    if (!UUID.test(value.ownerId || "") || (owner && owner !== value.ownerId) || value.ownerId === previousOwner || value.providerNetworkAttempts !== 0) {
      failure = new Error("pilot_idle_worker_identity_or_network_mismatch"); wake(); return;
    }
    owner = value.ownerId;
    if (value.phase === "cycle") {
      if (value.intervalMs !== 60000 || value.health !== "healthy" || !Number.isFinite(Date.parse(value.completedAt)) || !Number.isFinite(Date.parse(value.startedAt)) ||
        !Number.isFinite(Date.parse(value.heartbeatAt)) || Date.parse(value.heartbeatAt) < Date.parse(value.completedAt)) {
        failure = new Error("pilot_idle_worker_cycle_invalid");
      } else if (!cycles.some((row) => row.completedAt === value.completedAt) && cycles.length < 4)
        cycles.push({ startedAt: value.startedAt, completedAt: value.completedAt, heartbeatAt: value.heartbeatAt });
    } else if (value.state === "stopped") stopped = true;
    else failure = new Error("pilot_idle_worker_stop_invalid");
    wake();
  });
  child.once("error", () => { failure = new Error("pilot_idle_worker_process_failed"); wake(); });
  child.once("exit", (code, signal) => { exited = { code, signal }; wake(); });
  const wait = (predicate, timeout, label) => deadline(new Promise((done, reject) => {
    const check = () => {
      if (failure) { subscribers.delete(check); reject(failure); }
      else if (predicate()) { subscribers.delete(check); done(); }
      else if (exited) { subscribers.delete(check); reject(new Error("pilot_idle_worker_exited_early")); }
    };
    subscribers.add(check); check();
  }), timeout, label);
  const stop = async () => {
    if (!exited) child.kill("SIGTERM");
    await wait(() => Boolean(stopped && exited), 20000, "pilot_idle_worker_stop_timeout");
    ensure(exited.code === 0 && !exited.signal, "pilot_idle_worker_exit_failed");
  };
  return { get owner() { return owner; }, get stopped() { return stopped; },
    async run() {
      await wait(() => cycles.length >= cyclesRequired, cyclesRequired === 2 ? 105000 : 35000, "pilot_idle_cycle_timeout");
      if (cyclesRequired === 2) ensure(Date.parse(cycles[1].startedAt) - Date.parse(cycles[0].completedAt) >= 59000,
        "pilot_idle_normal_interval_not_observed");
      await stop();
      return { ownerId: owner, cycles: cycles.slice(0, cyclesRequired), stopped: true, exitCode: exited.code, providerNetworkAttempts: 0 };
    },
    async close() {
      if (exited) return;
      try { await stop(); } catch { if (!exited) child.kill("SIGKILL"); }
      if (!exited) await deadline(new Promise((done) => child.once("exit", done)), 5000, "pilot_idle_worker_kill_timeout");
    } };
}

export async function runIdleSupervisor({ env = process.env, root = ROOT, read = readFile, createPool,
  forkProcess = fork, emit = console.log } = {}) {
  let phase = "configuration", pool, client, latestWorker, completed = false, cleanupComplete = false, evidence, failure;
  let interlockOwned = false, observerLost = false;
  const workers = [];
  try {
    const identity = idleConfiguration(env);
    phase = "source";
    await verifyIdleSources(root, read);
    const spec = await readDefaultSeedSpec(root, read);
    const require = createRequire(resolve(root, "artifacts/api-server/package.json"));
    pool = createPool ? createPool() : new (require("pg").Pool)({ connectionString: env.DATABASE_URL, ...probePoolOptions(1, "growthos-pilot-idle-supervisor") });
    pool.on("error", () => {});
    phase = "connect";
    client = await pool.connect(); client.on("error", () => {
      observerLost = true;
      for (const worker of workers) void worker.close().catch(() => {});
    });
    await client.query("SET statement_timeout = '8s'");
    interlockOwned = (await client.query("SELECT pg_try_advisory_lock(hashtext($1)) AS acquired", [IDLE_INTERLOCK])).rows[0]?.acquired === true;
    ensure(interlockOwned, "pilot_idle_other_acceptance_active");
    phase = "preflight";
    const before = await idlePreflight(client, spec);
    phase = "fingerprint";
    const fingerprint = await tenantFingerprint(client, before.orgIds);
    phase = "first_worker";
    latestWorker = superviseChild(env, { cyclesRequired: 2, root, forkProcess }); workers.push(latestWorker);
    const first = await latestWorker.run();
    ensure(!observerLost, "pilot_idle_supervisor_connection_lost");
    await idlePreflight(client, spec, { allowStoppedOwner: first.ownerId });
    phase = "restart_worker";
    latestWorker = superviseChild(env, { previousOwner: first.ownerId, cyclesRequired: 1, root, forkProcess }); workers.push(latestWorker);
    const replacement = await latestWorker.run();
    ensure(!observerLost, "pilot_idle_supervisor_connection_lost");
    ensure(replacement.ownerId !== first.ownerId, "pilot_idle_restart_owner_unchanged");
    await idlePreflight(client, spec, { allowStoppedOwner: replacement.ownerId });
    phase = "final_fingerprint";
    ensure(await tenantFingerprint(client, before.orgIds) === fingerprint, "pilot_idle_tenant_state_changed");
    phase = "runtime_cleanup";
    await cleanupIdleRuntime(client, replacement.ownerId); cleanupComplete = true;
    evidence = { check: "pilot_scheduler_idle", ok: true, ...identity, imageReference: IMAGE_REF,
      actualSchedulerModule: true, intervalMs: 60000, firstWorker: first, replacementWorker: replacement,
      restartKind: "graceful child-process restart", tenantStateUnchanged: true, mainAppChanged: false,
      defaultRulesPreserved: before.defaultRules, defaultTemplatesPreserved: before.defaultTemplates,
      outboundHeld: true, providerCredentialsInherited: false, providerNetworkAttempts: 0,
      actualServerBootstrapRun: false, zeroServicesOperatorAttested: true, mainStoppedOperatorAttested: true, ownRuntimeRowRemoved: true,
      exclusiveSupervisorInterlockHeld: true,
      crashAfterEffectVerified: false, productionAlwaysOnVerified: false,
      boundary: "Bounded same-image actual scheduler idle and ordinary process restart; not provider delivery, crash-after-effect or production uptime proof." };
    completed = true;
  } catch (error) {
    const safe = new Error(/^pilot_(idle|scheduler)_[a-z_]+$/.test(error?.message || "") ? error.message : "pilot_idle_operation_failed");
    safe.idleEvidence = idleFailureEvidence(error, phase);
    if (error?.workerEvidence) safe.idleEvidence.worker = error.workerEvidence;
    failure = safe;
  } finally {
    const recordFailure = (error) => {
      if (!failure) { failure = new Error("pilot_idle_cleanup_failed"); failure.idleEvidence = idleFailureEvidence(error, "cleanup"); }
    };
    for (const worker of workers) await worker.close().catch(recordFailure);
    // Failure cleanup may touch only the row acknowledged stopped by our child.
    if (!completed && !cleanupComplete && latestWorker?.stopped && latestWorker.owner && client)
      await cleanupIdleRuntime(client, latestWorker.owner).catch(recordFailure);
    if (client && interlockOwned && !observerLost) {
      await client.query("SELECT pg_advisory_unlock(hashtext($1)) AS released", [IDLE_INTERLOCK])
        .then((result) => ensure(result.rows[0]?.released === true, "pilot_idle_supervisor_lock_release_unconfirmed"))
        .catch(recordFailure);
    }
    if (client) { try { client.release(true); } catch (error) { recordFailure(error); } }
    if (pool) await deadline(pool.end(), 12000, "pilot_idle_observer_close_timeout").catch(recordFailure);
  }
  if (failure) throw failure;
  ensure(!observerLost, "pilot_idle_supervisor_connection_lost");
  emit(JSON.stringify(evidence, null, 2));
  return evidence;
}

/** Only the private fork path can invoke the child. No ambient provider credentials survive. */
async function runIdleChild() {
  ensure(typeof process.send === "function" && process.env.PILOT_SCHEDULER_IDLE_CHILD === "true", "pilot_idle_private_child_required");
  const env = process.env;
  const expected = idleChildEnvironment({ ...env, SCHEDULER_AUTOSTART: "false" }, env.PILOT_IDLE_PREVIOUS_OWNER);
  const allowed = new Set(Object.keys(expected));
  ensure(Object.keys(env).every((key) => allowed.has(key)) && env.SCHEDULER_AUTOSTART === "true", "pilot_idle_child_environment_rejected");
  await verifyIdleSources();
  let networkAttempts = 0;
  const deny = () => { networkAttempts++; throw new Error("pilot_idle_provider_network_forbidden"); };
  globalThis.fetch = deny; http.request = deny; http.get = deny; https.request = deny; https.get = deny;
  syncBuiltinESMExports();
  const runtime = await loadIdleRuntime();
  let owner, timer, stopped = false, poll = Promise.resolve(), completeStop;
  const done = new Promise((resolveDone) => { completeStop = resolveDone; });
  const seen = new Set();
  const send = (message) => { if (process.connected) process.send(message); };
  const stop = async (error) => {
    if (stopped) return; stopped = true; clearTimeout(timer);
    try {
      await deadline(runtime.stopAutomationScheduler(), 18000, "pilot_idle_child_drain_timeout");
      const row = (await runtime.pool.query(runtimeSql)).rows[0];
      ensure(owner && row?.owner_id === owner && row.state === "stopped", "pilot_idle_child_stop_owner_mismatch");
      if (error) throw error;
      ensure(networkAttempts === 0, "pilot_idle_provider_network_forbidden");
      send({ phase: "stopped", ownerId: owner, state: "stopped", providerNetworkAttempts: networkAttempts });
    } catch (cause) { send({ phase: "failure", diagnostic: idleFailureEvidence(cause, "worker_stop") }); process.exitCode = 1; }
    finally {
      try { await deadline(runtime.dispose(), 12000, "pilot_idle_child_pool_close_timeout"); }
      catch (cause) { send({ phase: "failure", diagnostic: idleFailureEvidence(cause, "worker_stop") }); process.exitCode = 1; }
      completeStop();
    }
  };
  const tick = async () => {
    try {
      const row = (await runtime.pool.query(runtimeSql)).rows[0];
      if (row && row.owner_id !== env.PILOT_IDLE_PREVIOUS_OWNER && row.state !== "stopped") {
        ensure(UUID.test(row.owner_id) && (!owner || owner === row.owner_id), "pilot_idle_child_owner_changed");
        owner = row.owner_id;
        ensure(row.interval_ms === 60000 && ["running", "idle"].includes(row.state) && row.failed_stages.length === 0,
          "pilot_idle_child_cycle_unhealthy");
        if (row.state === "idle" && row.completed_at && !seen.has(row.completed_at.toISOString())) {
          seen.add(row.completed_at.toISOString());
          send({ phase: "cycle", ownerId: owner, health: "healthy", intervalMs: row.interval_ms,
            startedAt: row.started_at.toISOString(), completedAt: row.completed_at.toISOString(), heartbeatAt: row.heartbeat_at.toISOString(),
            providerNetworkAttempts: networkAttempts });
        }
      }
      ensure(networkAttempts === 0, "pilot_idle_provider_network_forbidden");
    } catch (error) { await stop(error); }
    if (!stopped) timer = setTimeout(() => { poll = tick(); }, 1000);
  };
  process.once("SIGTERM", () => { void stop(); });
  process.once("disconnect", () => { void stop(new Error("pilot_idle_supervisor_disconnected")); });
  // Keep the standalone child alive; the actual scheduler's idle timer is unref'ed.
  const hardLimit = setTimeout(() => { void stop(new Error("pilot_idle_child_lifetime_exceeded")); }, 125000);
  runtime.startAutomationScheduler(); // Real source default: 60 seconds, no interval override.
  poll = tick();
  try { await done; await poll; }
  finally { clearTimeout(hardLimit); clearTimeout(timer); if (process.connected) process.disconnect(); }
}

if (process.argv[1] && resolve(process.argv[1]) === FILE) {
  const main = async () => {
    if (process.argv.length === 3 && process.argv[2] === "--worker") return runIdleChild();
    ensure(process.argv.length === 2, "pilot_idle_arguments_forbidden");
    return runIdleSupervisor();
  };
  main().catch((error) => {
    const evidence = error.idleEvidence || idleFailureEvidence(error, "worker_import");
    if (typeof process.send === "function" && process.connected) { process.send({ phase: "failure", diagnostic: evidence }); process.disconnect(); }
    else console.error(JSON.stringify(evidence, null, 2));
    process.exitCode = 1;
  });
}
