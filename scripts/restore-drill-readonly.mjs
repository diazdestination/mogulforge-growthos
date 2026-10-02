import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { restoreClient } from "./restore-drill-connection.mjs";

const STAGING_CLUSTER = "zp2wjrejd2zodn4q";
const PRODUCTION_CLUSTER = "kzpwm0j18eg04nv3";
const STAGING_DATABASE = "growthos_staging";
const LOGICAL_RESTORE_DATABASE = "growthos_restore_drill";

// Every table is scoped to the synthetic organization. No names, addresses,
// tokens, message content or media leave PostgreSQL; only counts and digests do.
export const RESTORE_TABLES = [
  "users",
  "contacts",
  "properties",
  "leads",
  "estimates",
  "crm_tasks",
  "bie_action_proposals",
  "revenue_executions",
  "revenue_execution_events",
  "decision_rooms",
  "value_entries",
  "audit_events",
  "projects",
  "project_stories",
  "stored_objects",
  "activities",
  "gmail_connections",
  "webhook_endpoints",
  "service_obligations",
];

// These make an otherwise empty backup fail the drill instead of producing a
// reassuring but meaningless green fingerprint.
export const REQUIRED_FIXTURE_TABLES = [
  "users",
  "contacts",
  "properties",
  "leads",
  "bie_action_proposals",
  "audit_events",
  "projects",
  "project_stories",
  "stored_objects",
  "activities",
  "gmail_connections",
  "estimates",
  "crm_tasks",
  "revenue_executions",
  "revenue_execution_events",
  "decision_rooms",
  "value_entries",
  "service_obligations",
];

function fail(label) {
  throw new Error(label);
}

/** Parse only a deliberately isolated target. The connection URL is never returned. */
export function parseRestoreDrillTarget(env = process.env) {
  const mode = env.RESTORE_DRILL_MODE;
  if (!["source", "logical", "managed"].includes(mode))
    fail("restore_mode_invalid");
  if (!env.RESTORE_DRILL_DATABASE_URL) fail("restore_url_missing");
  let url;
  try {
    url = new URL(env.RESTORE_DRILL_DATABASE_URL);
  } catch {
    fail("restore_url_invalid");
  }
  const match = /^pgbouncer\.([a-z0-9]+)\.flympg\.net$/.exec(url.hostname);
  const database = decodeURIComponent(url.pathname.slice(1));
  const login = decodeURIComponent(url.username);
  const slug = env.RESTORE_DRILL_SYNTHETIC_SLUG;
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    [...url.searchParams].some(
      ([key, value]) => key !== "sslmode" || value !== "require",
    ) ||
    url.hash ||
    (url.port && url.port !== "5432") ||
    !match ||
    !/^[a-z][a-z0-9_-]{2,62}$/.test(database) ||
    !/^[a-z][a-z0-9_-]{2,62}$/.test(login) ||
    !/^restore-drill-[a-z0-9-]{3,50}$/.test(slug || "")
  )
    fail("restore_target_invalid");
  const clusterId = match[1];
  if (clusterId === PRODUCTION_CLUSTER)
    fail("restore_production_target_forbidden");
  const expectedClusterId = env.RESTORE_DRILL_EXPECTED_CLUSTER_ID;
  if (
    (mode === "managed" && !expectedClusterId) ||
    (expectedClusterId && expectedClusterId !== clusterId)
  )
    fail("restore_cluster_identity_mismatch");
  if (
    (mode === "source" &&
      (clusterId !== STAGING_CLUSTER || database !== STAGING_DATABASE)) ||
    (mode === "logical" &&
      (clusterId !== STAGING_CLUSTER ||
        database !== LOGICAL_RESTORE_DATABASE)) ||
    (mode === "managed" &&
      (clusterId === STAGING_CLUSTER || database !== STAGING_DATABASE))
  )
    fail("restore_target_mismatch");
  if (login !== env.RESTORE_DRILL_EXPECTED_LOGIN || login === "fly-user")
    fail("restore_login_mismatch");
  const expectedFingerprint = env.RESTORE_DRILL_EXPECTED_FINGERPRINT;
  if (mode !== "source" && !/^[a-f0-9]{64}$/.test(expectedFingerprint || ""))
    fail("restore_baseline_missing");
  return {
    mode,
    host: url.hostname,
    clusterId,
    database,
    login,
    syntheticSlug: slug,
    expectedFingerprint: expectedFingerprint || null,
  };
}

export function fingerprintRestoreRows(slug, rows) {
  return createHash("sha256")
    .update(JSON.stringify({ slug, rows }))
    .digest("hex");
}

/** Run in one read-only transaction. The caller supplies a test double in unit tests. */
export async function runRestoreDrillReadOnly(
  env = process.env,
  { createClient, emit = console.log } = {},
) {
  const target = parseRestoreDrillTarget(env);
  const connection = await restoreClient(env, target, { createClient });
  const { client } = connection;
  let inTransaction = false;
  try {
    await client.connect();
    await client.query("BEGIN TRANSACTION READ ONLY");
    inTransaction = true;
    await client.query("SET LOCAL statement_timeout = '15s'");
    await client.query("SET LOCAL TIME ZONE 'UTC'");
    const identity = await client.query(
      "SELECT current_database() AS database, session_user AS login",
    );
    if (
      identity.rows[0]?.database !== target.database ||
      identity.rows[0]?.login !== target.login
    )
      fail("restore_session_identity_mismatch");
    const privilege = await client.query(
      `SELECT (
         has_table_privilege(session_user, 'public.organizations', 'INSERT') OR
         has_table_privilege(session_user, 'public.users', 'UPDATE') OR
         has_table_privilege(session_user, 'public.contacts', 'DELETE') OR
         has_table_privilege(session_user, 'public.leads', 'INSERT') OR
         has_table_privilege(session_user, 'public.projects', 'UPDATE')
       ) AS can_write`,
    );
    if (privilege.rows[0]?.can_write !== false)
      fail("restore_reader_privilege_required");
    const org = await client.query(
      "SELECT id::text AS id FROM organizations WHERE slug = $1",
      [target.syntheticSlug],
    );
    if (org.rows.length !== 1 || !org.rows[0]?.id)
      fail("restore_synthetic_org_missing");
    const rows = {};
    for (const table of RESTORE_TABLES) {
      // `table` comes only from the fixed list above, never from an argument.
      const result = await client.query(
        `SELECT count(*)::int AS total,
                md5(coalesce(string_agg(md5(to_jsonb(t)::text), ',' ORDER BY t.id::text), '')) AS content_digest
           FROM ${table} t WHERE t.organization_id = $1`,
        [org.rows[0].id],
      );
      const total = Number(result.rows[0]?.total);
      const contentDigest = result.rows[0]?.content_digest;
      if (
        !Number.isSafeInteger(total) ||
        total < 0 ||
        !/^[a-f0-9]{32}$/.test(contentDigest || "")
      )
        fail("restore_table_result_invalid");
      rows[table] = { total, contentDigest };
    }
    const missingFixtureTables = REQUIRED_FIXTURE_TABLES.filter(
      (table) => rows[table].total === 0,
    );
    if (missingFixtureTables.length) fail("restore_fixture_incomplete");
    const fingerprint = fingerprintRestoreRows(target.syntheticSlug, rows);
    if (
      target.expectedFingerprint &&
      fingerprint !== target.expectedFingerprint
    )
      fail("restore_fingerprint_mismatch");
    const evidence = {
      check: "restore_drill_readonly",
      mode: target.mode,
      target: {
        host: target.host,
        clusterId: target.clusterId,
        database: target.database,
        login: target.login,
      },
      syntheticSlug: target.syntheticSlug,
      tableCounts: Object.fromEntries(
        Object.entries(rows).map(([table, row]) => [table, row.total]),
      ),
      fingerprint,
      sourceFingerprintMatched: Boolean(target.expectedFingerprint),
      // This utility does not boot the app or decrypt credential records.
      appBootVerified: false,
      credentialDecryptVerified: false,
      managedBackupRestoreVerified:
        target.mode === "managed" ? "not_by_this_check" : false,
    };
    emit(JSON.stringify(evidence));
    return evidence;
  } finally {
    if (inTransaction) await client.query("ROLLBACK").catch(() => {});
    await client.end().catch(() => {});
    await connection.close();
  }
}

const isDirectExecution =
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectExecution) {
  runRestoreDrillReadOnly().catch((error) => {
    // Driver errors can include credentials or host details. Only print fixed
    // internal labels or the PostgreSQL error code, never the error message.
    const label = /^restore_[a-z_]+$/.test(error.message || "")
      ? error.message
      : /^[A-Z0-9]{5}$/.test(error.code || "")
        ? error.code
        : "unknown";
    console.error(`RESTORE_DRILL_READONLY_FAILED:${label}`);
    process.exitCode = 1;
  });
}
