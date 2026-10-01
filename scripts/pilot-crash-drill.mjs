/** Explicitly approved, source-staging-only crash probe; no provider or HTTP entrypoint. */
import { fork } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rmdir, unlink } from "node:fs/promises";
import { createRequire, syncBuiltinESMExports } from "node:module";
import http from "node:http";
import https from "node:https";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  attestRelease,
  RELEASE_FILES,
  RELEASE_SHA,
  IMAGE_REF,
} from "./hosted-pilot-drill.mjs";
import { fixtureIds } from "./restore-drill-fixture.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const SOURCE = {
  host: "pgbouncer.zp2wjrejd2zodn4q.flympg.net",
  database: "growthos_staging",
  login: "growthos-staging-live",
};
const SLUGS = ["restore-drill-pilot-a", "restore-drill-pilot-b"];
const LOCKS = [
  "growthos:pilot:hosted-supervisor",
  "growthos:scheduler:automation",
];
const PHASES = new Set([
  "configuration",
  "attestation",
  "connect",
  "locks",
  "preflight",
  "seed",
  "interrupt",
  "committed_effect",
  "kill_owned_child",
  "synthetic_clock",
  "restart",
  "final_acceptance",
  "cleanup",
  "worker_import",
  "worker_preflight",
  "worker_effect",
  "worker_resume",
]);
const SQLSTATES = new Set([
  "08000",
  "08001",
  "08003",
  "08006",
  "08P01",
  "22023",
  "22P02",
  "23502",
  "23503",
  "23505",
  "23514",
  "25006",
  "25P02",
  "28000",
  "28P01",
  "3D000",
  "40001",
  "40P01",
  "42501",
  "42601",
  "42703",
  "42804",
  "42P01",
  "53300",
  "55P03",
  "57014",
  "57P01",
  "XX000",
]);
const fail = (label) => {
  throw new Error(label);
};
const ensure = (condition, label) => {
  if (!condition) fail(label);
};
const digest = (value) => createHash("sha256").update(value).digest("hex");
const HELPER =
  "// Code-only synthetic crash probe. Never import app.ts, index.ts, or scheduler.ts.\n" +
  'export { pool } from "../lib/db/src/index";\n' +
  'export { runDurableAction } from "../artifacts/api-server/src/services/durable-execution";\n' +
  'export { processScheduledWork } from "../artifacts/api-server/src/services/automation";\n' +
  'export { getSchedulerHealth } from "../artifacts/api-server/src/services/scheduler-runtime";\n';
export const CRASH_SOURCE_HASHES = {
  ...RELEASE_FILES,
  "artifacts/api-server/src/services/automation.ts":
    "1e615fe60b70c65529d0b1c61e707b073d29409d0255decf70e0313decf901c1",
  "artifacts/api-server/src/services/durable-execution.ts":
    "4422c1a400f4b404340c4795cf24ae3c9405eaa83761d359528bd9470ad09bc4",
  "artifacts/api-server/src/services/reactivation.ts":
    "972a2a3ee396aa81811fdad6e2ef664ccede6dad2ddeb448b2ac1c6d0ded9327",
  "artifacts/api-server/src/services/audit.ts":
    "f3015444d83930011e6cc923a45d965501830f33f9826ec82b7a3629e2990738",
  "artifacts/api-server/src/services/outbound-hold.ts":
    "dc4bdaa0a4be3b3fc551e42595e28973778b9d46b910def99d6af5e64403f8e8",
  "artifacts/api-server/src/services/scheduler-runtime.ts":
    "83e1e5562d7bf09777db3283f669d7d0a55b393956648a674ba3f493098a29e1",
  "lib/db/src/index.ts":
    "fc285bc83108137ba57c4c2774a35053e3c25fda1292c3d7a16a57d43dd9679c",
  "lib/db/src/schema/automations.ts":
    "6987bd462afed4f34cf10d124f41c8b013c3815ec1bf85e18aa448633858facb",
  "lib/db/src/schema/crm-tasks.ts":
    "390f0765acbeafc9d404e892d48df665442392f7ef5563e7b0f50ef00ba15b5c",
  "lib/db/src/schema/revenue-workspace.ts":
    "91170ea70914b2303cb901b5461237d35205d2a87a92e37fef83a7f05c744a25",
};

export function crashIdentity(nonce) {
  ensure(/^[a-f0-9]{32}$/.test(nonce || ""), "pilot_crash_nonce_invalid");
  const id = (part) => {
    const h = digest(`growthos-pilot-crash-v1:${nonce}:${part}`);
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
  };
  return {
    nonce,
    org: fixtureIds(SLUGS[0]).organization,
    first: id("interrupted-action"),
    second: id("resumed-action"),
    firstTask: id("interrupted-task"),
    titles: [
      `SYNTHETIC CRASH DRILL ${nonce}: interrupted`,
      `SYNTHETIC CRASH DRILL ${nonce}: resumed`,
    ],
    marker: `pilot.synthetic_crash.${nonce}`,
  };
}

export function crashConfiguration(env = process.env) {
  ensure(
    env.FLY_APP_NAME === "mogulforge-growthos-staging" &&
      env.APP_ORIGIN === "https://mogulforge-growthos-staging.fly.dev" &&
      env.AUTO_MIGRATE === "false" &&
      env.SCHEDULER_AUTOSTART === "false" &&
      env.GROWTHOS_OUTBOUND_HOLD === "true" &&
      env.STAGING_OUTBOUND_APPROVED === "false" &&
      env.STAGING_SCHEMA_PUSH_APPROVED === "false" &&
      env.OBJECT_STORAGE_PROVIDER === "postgres" &&
      !env.RESTORE_DRILL_ONLY &&
      env.PILOT_CRASH_DRILL_APPROVED === "true" &&
      env.PILOT_CRASH_MAIN_APP_STOPPED === "true" &&
      env.PILOT_CRASH_ZERO_PUBLIC_SERVICES === "true",
    "pilot_crash_identity_or_holds_missing",
  );
  ensure(
    env.RESTORE_DRILL_RELEASE_SHA === RELEASE_SHA &&
      env.RESTORE_DRILL_IMAGE_REF === IMAGE_REF,
    "pilot_crash_release_mismatch",
  );
  ensure(
    ![
      "PGHOST",
      "PGDATABASE",
      "PGUSER",
      "PGSERVICE",
      "PGSERVICEFILE",
      "PGOPTIONS",
      "PGPORT",
      "PGPASSWORD",
      "NODE_OPTIONS",
    ].some((key) => env[key]),
    "pilot_crash_connection_override_forbidden",
  );
  let url;
  try {
    url = new URL(env.DATABASE_URL);
  } catch {
    fail("pilot_crash_database_url_invalid");
  }
  ensure(
    ["postgres:", "postgresql:"].includes(url.protocol) &&
      url.hostname === SOURCE.host &&
      decodeURIComponent(url.pathname.slice(1)) === SOURCE.database &&
      decodeURIComponent(url.username) === SOURCE.login &&
      Boolean(url.password) &&
      (!url.port || url.port === "5432") &&
      !url.hash &&
      [...url.searchParams].length <= 1 &&
      [...url.searchParams].every(
        ([key, value]) => key === "sslmode" && value === "require",
      ),
    "pilot_crash_database_target_mismatch",
  );
  return crashIdentity(env.PILOT_CRASH_RUN_NONCE);
}

export async function attestCrashSources(
  root = ROOT,
  env = process.env,
  read = readFile,
) {
  const release = await attestRelease(root, env, read, CRASH_SOURCE_HASHES);
  ensure(
    (
      await read(resolve(root, "scripts/pilot-crash-runtime.ts"), "utf8")
    ).replace(/\r\n/g, "\n") === HELPER,
    "pilot_crash_helper_mismatch",
  );
  return release;
}

export function crashFailure(
  error,
  phase = "unknown",
  ids,
  recordsMayExist = false,
) {
  let sqlstate = null;
  for (
    let depth = 0, current = error;
    current && depth < 4;
    depth++, current = current.cause
  )
    if (SQLSTATES.has(current.code)) {
      sqlstate = current.code;
      break;
    }
  const result = {
    check: "pilot_crash_drill",
    ok: false,
    phase: PHASES.has(phase) ? phase : "unknown",
    error: /^pilot_crash_[a-z_]+$/.test(error?.message || "")
      ? error.message
      : "pilot_crash_operation_failed",
    sqlstate,
    recordsMayExist,
    ...(ids
      ? {
          nonce: ids.nonce,
          organizationId: ids.org,
          actionIds: [ids.first, ids.second],
        }
      : {}),
  };
  if (error?.workerDiagnostic)
    result.worker = safeWorkerDiagnostic(error.workerDiagnostic);
  return result;
}

function safeWorkerDiagnostic(value) {
  return {
    phase: PHASES.has(value?.phase) ? value.phase : "unknown",
    error: /^pilot_crash_[a-z_]+$/.test(value?.error || "")
      ? value.error
      : "pilot_crash_worker_failed",
    sqlstate: SQLSTATES.has(value?.sqlstate) ? value.sqlstate : null,
  };
}

export function installCrashNetworkDeny() {
  const previous = [
    globalThis.fetch,
    http.request,
    http.get,
    https.request,
    https.get,
  ];
  let attempts = 0;
  const deny = () => {
    attempts = Math.min(attempts + 1, 100000);
    fail("pilot_crash_http_forbidden");
  };
  globalThis.fetch = deny;
  http.request = deny;
  http.get = deny;
  https.request = deny;
  https.get = deny;
  syncBuiltinESMExports();
  return {
    get attempts() {
      return attempts;
    },
    restore() {
      [globalThis.fetch, http.request, http.get, https.request, https.get] =
        previous;
      syncBuiltinESMExports();
    },
  };
}

const safetySql = `SELECT
 (SELECT count(*) FROM reactivation_campaigns) +
 (SELECT count(*) FROM webhook_deliveries) +
 (SELECT count(*) FROM webhook_endpoints WHERE is_active) +
 (SELECT count(*) FROM playbook_enrollments WHERE status IN ('active','paused')) +
 (SELECT count(*) FROM appointments) + (SELECT count(*) FROM conversations) +
 (SELECT count(*) FROM api_keys WHERE is_active AND revoked_at IS NULL) +
 (SELECT count(*) FROM service_obligations WHERE status = 'active') +
 (SELECT count(*) FROM bie_action_proposals WHERE status <> 'rejected') +
 (SELECT count(*) FROM gmail_connections WHERE revoked_at IS NULL) +
 (SELECT count(*) FROM twilio_client_bindings) +
 (SELECT count(*) FROM contacts WHERE phone IS NOT NULL OR email IS NULL OR email NOT LIKE '%.invalid'
   OR NOT do_not_contact OR NOT do_not_contact_email OR NOT do_not_contact_sms) +
 (SELECT count(*) FROM users WHERE email IS NULL OR email NOT LIKE '%.invalid' OR password_hash IS NOT NULL OR is_platform_admin) +
 (SELECT count(*) FROM org_settings WHERE fallback_notification_inbox IS NOT NULL OR customer_email_sender_user_id IS NOT NULL OR google_reviews IS NOT NULL) +
 (SELECT count(*) FROM automations WHERE is_active AND
   (seed_key IS DISTINCT FROM 'default.assessment_abandoned_followup' OR event IS DISTINCT FROM 'assessment.abandoned'))
 AS unsafe_count`;

function actionData(ids, index) {
  return {
    action: { type: "create_task", params: { title: ids.titles[index] } },
    context: { event: ids.marker },
  };
}
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, val]) => `${JSON.stringify(key)}:${canonical(val)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

export async function crashPreflight(client, ids, prepared = false) {
  const identity = (
    await client.query(
      "SELECT current_database() AS database, session_user AS login, current_user AS role, pg_backend_pid() AS pid",
    )
  ).rows[0];
  ensure(
    identity?.database === SOURCE.database &&
      identity.login === SOURCE.login &&
      identity.role === SOURCE.login &&
      Number.isInteger(identity.pid),
    "pilot_crash_session_identity_mismatch",
  );
  const orgs = (
    await client.query("SELECT id,slug,name FROM organizations ORDER BY slug")
  ).rows;
  ensure(
    orgs.length === 2 &&
      orgs.every(
        (row, i) =>
          row.slug === SLUGS[i] &&
          row.id === fixtureIds(SLUGS[i]).organization &&
          row.name === `SYNTHETIC RESTORE ONLY — ${SLUGS[i]}`,
      ),
    "pilot_crash_nonfixture_organizations",
  );
  ensure(
    Number((await client.query(safetySql)).rows[0]?.unsafe_count) === 0,
    "pilot_crash_contactable_or_queued_work",
  );
  const actions = (
    await client.query("SELECT * FROM scheduled_actions ORDER BY run_at,id")
  ).rows;
  if (!prepared)
    ensure(actions.length === 0, "pilot_crash_existing_actions_refused");
  else {
    ensure(actions.length === 2, "pilot_crash_unexpected_action_count");
    for (const [index, actionId] of [ids.first, ids.second].entries()) {
      const row = actions.find((item) => item.id === actionId);
      const data = actionData(ids, index);
      ensure(
        row?.organization_id === ids.org &&
          row.automation_id === null &&
          canonical(row.action) === canonical(data.action) &&
          canonical(row.context) === canonical(data.context),
        "pilot_crash_action_changed",
      );
    }
  }
  const receipts = (
    await client.query(
      "SELECT organization_id,action_key FROM revenue_executions WHERE state <> 'blocked'",
    )
  ).rows;
  ensure(
    receipts.every(
      (row) =>
        prepared &&
        row.organization_id === ids.org &&
        [ids.first, ids.second].some(
          (id) => row.action_key === `scheduled:${id}`,
        ),
    ),
    "pilot_crash_existing_receipts_refused",
  );
  ensure(
    Number(
      (
        await client.query(
          "SELECT count(*) AS count FROM scheduler_runtime WHERE state = 'running'",
        )
      ).rows[0]?.count,
    ) === 0,
    "pilot_crash_scheduler_running",
  );
  return { pid: identity.pid };
}

export async function seedCrashActions(client, ids) {
  await client.query("BEGIN");
  try {
    // Any retry after a prior insert, including an uncertain COMMIT, stops here.
    await crashPreflight(client, ids, false);
    ensure(
      Number(
        (
          await client.query(
            "SELECT count(*) AS count FROM revenue_executions WHERE action_key=ANY($1::text[])",
            [[ids.first, ids.second].map((id) => `scheduled:${id}`)],
          )
        ).rows[0]?.count,
      ) === 0,
      "pilot_crash_existing_receipt_identity",
    );
    ensure(
      Number(
        (
          await client.query(
            "SELECT count(*) AS count FROM crm_tasks WHERE title = ANY($1::text[]) OR id = $2",
            [ids.titles, ids.firstTask],
          )
        ).rows[0]?.count,
      ) === 0,
      "pilot_crash_existing_effect_refused",
    );
    for (const [index, actionId] of [ids.first, ids.second].entries()) {
      const { action, context } = actionData(ids, index);
      await client.query(
        "INSERT INTO scheduled_actions(id,organization_id,action,context,run_at) VALUES($1,$2,$3::jsonb,$4::jsonb,$5)",
        [
          actionId,
          ids.org,
          JSON.stringify(action),
          JSON.stringify(context),
          new Date(index * 1000),
        ],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  }
}

export async function inspectCrashRecords(client, ids, expected) {
  const actions = (
    await client.query(
      "SELECT id,status,attempts FROM scheduled_actions WHERE organization_id=$1 AND id=ANY($2::uuid[])",
      [ids.org, [ids.first, ids.second]],
    )
  ).rows;
  const tasks = (
    await client.query(
      "SELECT id,title,lead_id,contact_id,assigned_user_id,source_event FROM crm_tasks WHERE organization_id=$1 AND (title=ANY($2::text[]) OR id=$3)",
      [ids.org, ids.titles, ids.firstTask],
    )
  ).rows;
  const receipts = (
    await client.query(
      "SELECT id,action_key,state,kind,fingerprint,completed_at,expires_at FROM revenue_executions WHERE organization_id=$1 AND action_key=ANY($2::text[])",
      [ids.org, [ids.first, ids.second].map((id) => `scheduled:${id}`)],
    )
  ).rows;
  const first = receipts.find(
    (row) => row.action_key === `scheduled:${ids.first}`,
  );
  const second = receipts.find(
    (row) => row.action_key === `scheduled:${ids.second}`,
  );
  ensure(
    first &&
      first.kind === "create_task" &&
      first.fingerprint === digest(canonical(actionData(ids, 0))),
    "pilot_crash_receipt_mismatch",
  );
  ensure(
    tasks.every(
      (row) =>
        !row.lead_id &&
        !row.contact_id &&
        !row.assigned_user_id &&
        row.source_event === ids.marker,
    ),
    "pilot_crash_task_links_forbidden",
  );
  ensure(
    tasks.filter((row) => row.title === ids.titles[0]).length === 1 &&
      tasks.some((row) => row.id === ids.firstTask),
    "pilot_crash_first_effect_count",
  );
  const a = actions.find((row) => row.id === ids.first),
    b = actions.find((row) => row.id === ids.second);
  if (expected === "interrupted") {
    ensure(
      tasks.length === 1 &&
        receipts.length === 1 &&
        first.state === "processing" &&
        first.completed_at === null &&
        a?.status === "pending" &&
        a.attempts === 1 &&
        b?.status === "pending" &&
        b.attempts === 0,
      "pilot_crash_cut_point_invalid",
    );
  } else {
    ensure(
      expected === "complete" &&
        tasks.length === 2 &&
        tasks.filter((row) => row.title === ids.titles[1]).length === 1 &&
        receipts.length === 2 &&
        first.state === "indeterminate" &&
        second?.state === "succeeded" &&
        second.fingerprint === digest(canonical(actionData(ids, 1))) &&
        a?.status === "failed" &&
        a.attempts === 1 &&
        b?.status === "done" &&
        b.attempts === 1,
      "pilot_crash_restart_acceptance_failed",
    );
    const events = (
      await client.query(
        "SELECT execution_id,state FROM revenue_execution_events WHERE organization_id=$1 AND execution_id=ANY($2::uuid[])",
        [ids.org, [first.id, second.id]],
      )
    ).rows;
    ensure(
      events.length === 4 &&
        [first, second].every((receipt) => {
          const states = events
            .filter((row) => row.execution_id === receipt.id)
            .map((row) => row.state)
            .sort();
          return (
            canonical(states) ===
            canonical(["processing", receipt.state].sort())
          );
        }),
      "pilot_crash_receipt_events_invalid",
    );
  }
  return {
    firstReceiptId: first.id,
    taskCount: tasks.length,
    receiptCount: receipts.length,
  };
}

export async function advanceSyntheticClock(client, ids, receiptId) {
  await client.query("BEGIN");
  try {
    const changed = await client.query(
      "UPDATE revenue_executions SET expires_at=$1 WHERE id=$2 AND organization_id=$3 AND action_key=$4 AND state='processing' AND completed_at IS NULL RETURNING id",
      [new Date(0), receiptId, ids.org, `scheduled:${ids.first}`],
    );
    ensure(changed.rows.length === 1, "pilot_crash_clock_ownership_changed");
    await client.query(
      "INSERT INTO audit_events(organization_id,action,entity_type,entity_id,metadata) VALUES($1,'pilot.synthetic_crash_clock_advanced','revenue_execution',$2,$3::jsonb)",
      [
        ids.org,
        receiptId,
        JSON.stringify({
          nonce: ids.nonce,
          syntheticClock: true,
          onlyOwnedReceipt: true,
          realElapsedWindow: false,
        }),
      ],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  }
}

export function crashWorkerEnvironment(parent, ids, mode, capability) {
  ensure(
    ["interrupt", "resume"].includes(mode),
    "pilot_crash_worker_mode_invalid",
  );
  const env = Object.fromEntries(
    Object.entries(parent).filter(([key]) =>
      /^(PATH|SystemRoot|WINDIR|TEMP|TMP|PATHEXT|COMSPEC|LANG|TZ)$/i.test(key),
    ),
  );
  for (const key of [
    "FLY_APP_NAME",
    "APP_ORIGIN",
    "DATABASE_URL",
    "RESTORE_DRILL_RELEASE_SHA",
    "RESTORE_DRILL_IMAGE_REF",
    "RESTORE_DRILL_EXPECTED_BUNDLE_SHA256",
  ])
    if (parent[key]) env[key] = parent[key];
  return {
    ...env,
    NODE_ENV: "production",
    LOG_LEVEL: "silent",
    AUTO_MIGRATE: "false",
    SCHEDULER_AUTOSTART: "false",
    GROWTHOS_OUTBOUND_HOLD: "true",
    STAGING_OUTBOUND_APPROVED: "false",
    STAGING_SCHEMA_PUSH_APPROVED: "false",
    OBJECT_STORAGE_PROVIDER: "postgres",
    PILOT_CRASH_DRILL_APPROVED: "true",
    PILOT_CRASH_MAIN_APP_STOPPED: parent.PILOT_CRASH_MAIN_APP_STOPPED,
    PILOT_CRASH_ZERO_PUBLIC_SERVICES: parent.PILOT_CRASH_ZERO_PUBLIC_SERVICES,
    PILOT_CRASH_RUN_NONCE: ids.nonce,
    PILOT_CRASH_WORKER_MODE: mode,
    PILOT_CRASH_PARENT_PID: String(process.pid),
    PILOT_CRASH_CAPABILITY: capability,
  };
}

function configurePool(pool) {
  Object.assign(pool.options, {
    max: 3,
    connectionTimeoutMillis: 5000,
    query_timeout: 10000,
  });
  delete pool.options.statement_timeout;
  pool.options.verify = (client, done) =>
    client.query("SET statement_timeout='8s'").then(() => done(), done);
  pool.on("error", () => {});
}

export async function loadCrashRuntime(root = ROOT) {
  // Match the existing loopback crash test's CJS bundle boundary. Direct ESM
  // importing automation currently trips over Twilio's CJS named exports.
  // This compiles only a disposable helper from already-attested image source.
  const api = resolve(root, "artifacts/api-server");
  const require = createRequire(resolve(api, "package.json"));
  const cache = resolve(api, "node_modules/.cache");
  await mkdir(cache, { recursive: true });
  const folder = await mkdtemp(resolve(cache, "pilot-crash-"));
  const output = resolve(folder, "runtime.cjs");
  const removeGenerated = async () => {
    // Only the one generated file and then its empty mkdtemp-owned directory.
    await unlink(output).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
    await rmdir(folder);
  };
  try {
    const { build } = require("esbuild");
    await build({
      entryPoints: [resolve(root, "scripts/pilot-crash-runtime.ts")],
      outfile: output,
      platform: "node",
      format: "cjs",
      bundle: true,
      packages: "external",
      logLevel: "silent",
      plugins: [
        {
          name: "bundle-workspace-source",
          setup(builder) {
            builder.onResolve(
              { filter: /^(@workspace\/|drizzle-zod$)/ },
              (args) => ({
                path: require.resolve(args.path, { paths: [args.resolveDir] }),
              }),
            );
          },
        },
      ],
    });
    const runtime = require(output);
    configurePool(runtime.pool);
    return {
      ...runtime,
      async dispose() {
        try {
          await runtime.pool.end();
        } finally {
          delete require.cache[output];
          await removeGenerated();
        }
      },
    };
  } catch (error) {
    await removeGenerated().catch(() => {});
    throw error;
  }
}

export async function executeCrashPhase(runtime, ids, mode, notify, hold) {
  await crashPreflight(runtime.pool, ids, true);
  if (mode === "interrupt") {
    const data = actionData(ids, 0);
    const result = await runtime.runDurableAction({
      organizationId: ids.org,
      actionKey: `scheduled:${ids.first}`,
      kind: "create_task",
      payload: data,
      execute: async () => {
        const claimed = await runtime.pool.query(
          "UPDATE scheduled_actions SET attempts=attempts+1 WHERE id=$1 AND organization_id=$2 AND status='pending' AND attempts=0 RETURNING id",
          [ids.first, ids.org],
        );
        ensure(claimed.rows.length === 1, "pilot_crash_first_action_changed");
        // Same synthetic effect boundary as the existing loopback crash fixture.
        // This first INSERT is NOT a claim that the private action dispatcher ran.
        await runtime.pool.query(
          "INSERT INTO crm_tasks(id,organization_id,title,source_event,description) VALUES($1,$2,$3,$4,$5)",
          [
            ids.firstTask,
            ids.org,
            ids.titles[0],
            ids.marker,
            "Synthetic crash acceptance effect; no contact, lead, assignee or provider.",
          ],
        );
        await runtime.pool.query(
          "INSERT INTO audit_events(organization_id,action,entity_type,entity_id,metadata) VALUES($1,'pilot.synthetic_crash_effect_committed','scheduled_action',$2,$3::jsonb)",
          [
            ids.org,
            ids.first,
            JSON.stringify({
              nonce: ids.nonce,
              syntheticEffect: true,
              providerCalled: false,
            }),
          ],
        );
        notify("effect_committed");
        await hold();
        fail("pilot_crash_interrupt_must_be_killed");
      },
    });
    ensure(
      result.state === "processing",
      "pilot_crash_unexpected_effect_return",
    );
    fail("pilot_crash_worker_was_not_killed");
  }
  ensure(mode === "resume", "pilot_crash_worker_mode_invalid");
  const observed = [];
  await runtime.processScheduledWork(ids.org, async (stage, state) => {
    ensure(
      ["scheduled-actions", "reactivation-drain"].includes(stage) &&
        ["running", "succeeded"].includes(state),
      "pilot_crash_unexpected_scheduler_stage",
    );
    observed.push(`${stage}:${state}`);
  });
  ensure(
    canonical(observed) ===
      canonical([
        "scheduled-actions:running",
        "scheduled-actions:succeeded",
        "reactivation-drain:running",
        "reactivation-drain:succeeded",
      ]),
    "pilot_crash_scoped_stages_incomplete",
  );
  await inspectCrashRecords(runtime.pool, ids, "complete");
  const health = await runtime.getSchedulerHealth();
  ensure(
    health.queue.failed >= 1 && health.executionsNeedingReview >= 1,
    "pilot_crash_operator_health_missing",
  );
  notify("resumed");
}

async function workerMain(env = process.env, root = ROOT) {
  const ids = crashConfiguration(env);
  ensure(
    process.send &&
      String(process.ppid) === env.PILOT_CRASH_PARENT_PID &&
      /^[a-f0-9]{64}$/.test(env.PILOT_CRASH_CAPABILITY || ""),
    "pilot_crash_worker_parent_required",
  );
  const watchdog = setTimeout(() => process.exit(74), 40000);
  let runtime,
    network,
    phase = "worker_import";
  try {
    await new Promise((done, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("pilot_crash_parent_handshake_timeout")),
        5000,
      );
      process.once("message", (message) => {
        clearTimeout(timeout);
        message?.type === "start" &&
        message.capability === env.PILOT_CRASH_CAPABILITY
          ? done()
          : reject(new Error("pilot_crash_parent_handshake_invalid"));
      });
      process.send({ phase: "ready" });
    });
    await attestCrashSources(root, env);
    network = installCrashNetworkDeny();
    runtime = await loadCrashRuntime(root);
    phase =
      env.PILOT_CRASH_WORKER_MODE === "resume"
        ? "worker_resume"
        : "worker_effect";
    await executeCrashPhase(
      runtime,
      ids,
      env.PILOT_CRASH_WORKER_MODE,
      (phase) => {
        ensure(network.attempts === 0, "pilot_crash_http_attempt_detected");
        process.send({ phase, blockedHttpAttempts: network.attempts });
      },
      () => new Promise(() => {}),
    );
  } catch (error) {
    error.crashPhase = phase;
    throw error;
  } finally {
    if (runtime) await runtime.dispose();
    network?.restore();
    clearTimeout(watchdog);
    process.disconnect?.();
  }
}

export function startOwnedCrashWorker(
  env,
  ids,
  mode,
  root = ROOT,
  { forkProcess = fork } = {},
) {
  const capability = randomBytes(32).toString("hex");
  const child = forkProcess(
    resolve(root, "scripts/pilot-crash-drill.mjs"),
    ["--worker"],
    {
      cwd: resolve(root, "artifacts/api-server"),
      env: crashWorkerEnvironment(env, ids, mode, capability),
      execArgv: [],
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      windowsHide: true,
    },
  );
  child.stdout?.resume();
  child.stderr?.resume();
  const phases = new Map();
  const listeners = new Set();
  let workerDiagnostic;
  let closed = false,
    code = null,
    signal = null;
  const complete = new Promise((done) =>
    child.once("close", (value, reason) => {
      closed = true;
      code = value;
      signal = reason;
      done();
      for (const notify of listeners) notify();
    }),
  );
  child.on("error", () => {
    for (const notify of listeners) notify();
  });
  child.on("message", (message) => {
    if (message?.phase === "ready") child.send({ type: "start", capability });
    if (
      ["effect_committed", "resumed"].includes(message?.phase) &&
      message.blockedHttpAttempts === 0
    )
      phases.set(message.phase, { blockedHttpAttempts: 0 });
    if (message?.phase === "failed") {
      phases.set("failed", true);
      workerDiagnostic = safeWorkerDiagnostic(message.diagnostic);
    }
    for (const notify of listeners) notify();
  });
  const wait = (phase, ms = 25000) =>
    new Promise((done, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("pilot_crash_worker_timeout"));
      }, ms);
      const cleanup = () => {
        clearTimeout(timer);
        listeners.delete(check);
      };
      const check = () => {
        if (phases.has(phase)) {
          cleanup();
          done(phases.get(phase));
        } else if (closed || phases.has("failed")) {
          cleanup();
          const error = new Error("pilot_crash_worker_failed");
          if (workerDiagnostic) error.workerDiagnostic = workerDiagnostic;
          reject(error);
        }
      };
      listeners.add(check);
      check();
    });
  return {
    wait,
    async kill() {
      if (!closed) child.kill("SIGKILL");
      await bounded(complete, 10000);
      return { code, signal };
    },
    async success() {
      await bounded(complete, 10000);
      ensure(code === 0 && !signal, "pilot_crash_replacement_exit_failed");
    },
  };
}

function bounded(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("pilot_crash_timeout")), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

export async function runCrashDrill({
  env = process.env,
  root = ROOT,
  attest = attestCrashSources,
  makeClient,
  startWorker = startOwnedCrashWorker,
  emit = console.log,
} = {}) {
  let phase = "configuration",
    ids,
    client,
    recordsMayExist = false,
    release,
    evidence;
  const children = [],
    locked = [];
  let interlockLost = false;
  const assertInterlock = () =>
    ensure(!interlockLost, "pilot_crash_interlock_lost");
  try {
    ids = crashConfiguration(env);
    phase = "attestation";
    release = await attest(root, env);
    phase = "connect";
    const require = createRequire(
      resolve(root, "artifacts/api-server/package.json"),
    );
    client = makeClient
      ? makeClient()
      : new (require("pg").Client)({
          connectionString: env.DATABASE_URL,
          connectionTimeoutMillis: 5000,
          query_timeout: 10000,
        });
    client.on?.("error", () => {
      interlockLost = true;
      // Only owned child handles can be killed; losing the guard session
      // immediately stops effects even if the supervisor is waiting on IPC.
      for (const child of children) void child.kill().catch(() => {});
    });
    await client.connect();
    await client.query("SET statement_timeout='8s'");
    phase = "locks";
    for (const lock of LOCKS) {
      ensure(
        (
          await client.query(
            "SELECT pg_try_advisory_lock(hashtext($1)) AS acquired",
            [lock],
          )
        ).rows[0]?.acquired === true,
        "pilot_crash_competing_worker",
      );
      locked.push(lock);
    }
    phase = "preflight";
    const identity = await crashPreflight(client, ids);
    const baseline = (
      await client.query(
        "SELECT md5(coalesce(string_agg(to_jsonb(r)::text, ',' ORDER BY name),'')) AS digest FROM scheduler_runtime r",
      )
    ).rows[0].digest;
    phase = "seed";
    assertInterlock();
    recordsMayExist = true;
    await seedCrashActions(client, ids);
    phase = "interrupt";
    assertInterlock();
    const first = startWorker(env, ids, "interrupt", root);
    children.push(first);
    ensure(
      (await first.wait("effect_committed")).blockedHttpAttempts === 0,
      "pilot_crash_http_attempt_detected",
    );
    assertInterlock();
    phase = "committed_effect";
    const held = await inspectCrashRecords(client, ids, "interrupted");
    phase = "kill_owned_child";
    const exit = await first.kill();
    ensure(exit.signal === "SIGKILL", "pilot_crash_forced_exit_unverified");
    await inspectCrashRecords(client, ids, "interrupted");
    phase = "synthetic_clock";
    assertInterlock();
    await advanceSyntheticClock(client, ids, held.firstReceiptId);
    phase = "restart";
    assertInterlock();
    const replacement = startWorker(env, ids, "resume", root);
    children.push(replacement);
    ensure(
      (await replacement.wait("resumed")).blockedHttpAttempts === 0,
      "pilot_crash_http_attempt_detected",
    );
    assertInterlock();
    await replacement.success();
    phase = "final_acceptance";
    const result = await inspectCrashRecords(client, ids, "complete");
    ensure(
      (await crashPreflight(client, ids, true)).pid === identity.pid,
      "pilot_crash_session_backend_changed",
    );
    ensure(
      (
        await client.query(
          "SELECT md5(coalesce(string_agg(to_jsonb(r)::text, ',' ORDER BY name),'')) AS digest FROM scheduler_runtime r",
        )
      ).rows[0].digest === baseline,
      "pilot_crash_scheduler_runtime_changed",
    );
    assertInterlock();
    evidence = {
      check: "pilot_crash_drill",
      ok: true,
      ...release,
      nonce: ids.nonce,
      organizationId: ids.org,
      actionIds: [ids.first, ids.second],
      taskCount: result.taskCount,
      receiptCount: result.receiptCount,
      committedEffectWitnessedBeforeKill: true,
      ownedChildKilled: true,
      actualDurableOwnership: true,
      actualScopedSchedulerRestart: true,
      firstEffectIsSyntheticInsert: true,
      actualFirstActionDispatcherVerified: false,
      syntheticClockAdvancedOnlyFirstReceipt: true,
      actualFifteenMinuteWaitVerified: false,
      firstReceiptState: "indeterminate",
      firstActionState: "failed",
      secondActionState: "done",
      duplicateEffects: 0,
      operatorHealthVisible: true,
      recordsRetained: true,
      normalSchedulerRuntimeUnchanged: true,
      providerCalled: false,
      providerHttpDeniedBeforeImport: true,
      blockedHttpAttempts: 0,
      mainAppStoppedOperatorAttestation: true,
      zeroPublicServicesOperatorAttestation: true,
      publicAppStarted: false,
    };
  } catch (error) {
    evidence = crashFailure(
      interlockLost ? new Error("pilot_crash_interlock_lost") : error,
      phase,
      ids,
      recordsMayExist,
    );
  } finally {
    let cleanupError;
    const clean = async (action) => {
      try {
        await action();
      } catch (error) {
        cleanupError ??= error;
      }
    };
    for (const child of children) await clean(() => child.kill());
    for (const lock of locked.reverse())
      await clean(async () => {
        const result = await client.query(
          "SELECT pg_advisory_unlock(hashtext($1)) AS released",
          [lock],
        );
        ensure(
          result.rows[0]?.released === true,
          "pilot_crash_lock_release_unverified",
        );
      });
    if (client) await clean(() => bounded(client.end(), 10000));
    if (interlockLost && !cleanupError)
      evidence = crashFailure(
        new Error("pilot_crash_interlock_lost"),
        phase,
        ids,
        recordsMayExist,
      );
    if (cleanupError)
      evidence = crashFailure(cleanupError, "cleanup", ids, recordsMayExist);
  }
  emit(JSON.stringify(evidence, null, 2));
  return evidence;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  if (process.argv.length === 3 && process.argv[2] === "--worker") {
    workerMain().catch((error) => {
      process.send?.({
        phase: "failed",
        diagnostic: crashFailure(error, error.crashPhase || "worker_effect"),
      });
      process.exit(1);
    });
  } else if (process.argv.length !== 2) {
    console.error(
      JSON.stringify(
        crashFailure(
          new Error("pilot_crash_arguments_forbidden"),
          "configuration",
        ),
        null,
        2,
      ),
    );
    process.exitCode = 1;
  } else
    runCrashDrill().then((evidence) => {
      if (!evidence.ok) process.exitCode = 1;
    });
}
