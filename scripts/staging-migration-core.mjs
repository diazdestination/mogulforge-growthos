/** Import-safe migration mechanism. No transport, credentials, application,
 * filesystem, provider API or hosted entrypoint. Caller owns admission,
 * durable one-attempt journal, connection deadlines and fresh Reader capture. */
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { collectSchemaCatalog, catalogDigest } from '../reports/release-preparation-2026-10-09/schema-catalog.mjs';
import { PRIVILEGE_QUERIES } from './staging-observation-core.mjs';
import { validateSqlManifest, verifySqlBlob } from './staging-observation-fixtures.mjs';

const MANIFEST_SHA = 'bae0480809fbec16bc66e623c47c0a1fcc07b13d2821af2c689ee1d46559c066';
const CATALOG95_SHA = '170670b17dfd2b4cbf2b5bc95b4642657294f2e67c92289ea60e9d8058f590c3';
const CATALOG142_SHA = '24f33349b2cb443443ce3d670463b98de4aa31cb8b3589396da7c43df1f37b52';
const plans = new WeakSet();
const usedClients = new WeakSet();
const sha = value => createHash('sha256').update(value).digest('hex');
const fail = code => { throw Object.assign(new Error(code), { safeCode: code }); };
const check = (condition, code) => { if (!condition) fail(code); };
const equal = (a, b, code) => check(isDeepStrictEqual(a, b), code);
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const q = value => { check(typeof value === 'string' && /^[a-z_][a-z0-9_]*$/.test(value), 'migration_identifier_invalid'); return `"${value}"`; };

export const LEGACY_DEFAULTS = freeze({
  organizations: { entitlements: null },
  leads: { import_source_key: null, external_opportunity_id: null, imported_history: null },
  lead_imports: { updated: 0, conflicts: 0, source_key: null, snapshot_as_of: null },
  service_obligations: { recurrence: null, predecessor_obligation_id: null, occurrence_index: 0, coverage_starts_on: null, coverage_ends_on: null, coverage_evidence: null, completion_note: null },
  staff_push_deliveries: { service_obligation_id: null, service_watch_case_id: null, service_notice_revision: null, service_owner_id: null, event_key: null },
  estimates: { customer_work_id: null, work_version: null }, projects: { customer_work_id: null, work_version: null },
  value_entries: { customer_work_id: null, refund_of_value_entry_id: null },
});
const relaxed = new Set(['estimates.lead_id', 'staff_push_deliveries.lead_id', 'projects.lead_id', 'value_entries.lead_id']);
const IDENTITY_SQL = `SELECT current_database() AS database, session_user::text AS login, current_user::text AS role,
  current_setting('server_version_num')::int AS version, pg_backend_pid() AS pid,
  current_setting('transaction_isolation') AS isolation, current_setting('transaction_read_only') AS read_only`;
const TABLE_ACL_SQL = `SELECT c.relname AS name,owner.rolname AS owner,COALESCE(c.relacl::text,'DEFAULT') AS acl
  FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
  JOIN pg_catalog.pg_roles owner ON owner.oid=c.relowner WHERE n.nspname='public' AND c.relkind='r' ORDER BY c.relname`;

export function prepareMigration({ manifestBytes, sqlBuffers, catalog95, catalog142 }) {
  check(Buffer.isBuffer(manifestBytes) && sha(manifestBytes) === MANIFEST_SHA, 'migration_manifest_drift');
  const entries = validateSqlManifest(JSON.parse(manifestBytes.toString('utf8'))).slice(3);
  check(Array.isArray(sqlBuffers) && sqlBuffers.length === 16, 'migration_sql_count');
  check(catalogDigest(catalog95, { physical: true }) === CATALOG95_SHA && catalogDigest(catalog142, { physical: true }) === CATALOG142_SHA, 'migration_catalog_drift');
  const plan = freeze({ sourceCommit: '7091af816715cfd437925eb0af82fb47d3411e34',
    catalog95: structuredClone(catalog95), catalog142: structuredClone(catalog142),
    steps: entries.map((entry, index) => ({ ...entry, sql: verifySqlBlob(entry, sqlBuffers[index]) })),
  });
  plans.add(plan);
  return plan;
}

function identityMatches(row, login, role) {
  return row?.database === 'growthos_staging' && row.login === login && row.role === role &&
    Number.isInteger(row.version) && row.version >= 160000 && row.version < 170000 && Number.isInteger(row.pid) && row.pid > 0;
}

/** Already inside caller-owned transaction. Returns metadata/counts/digests,
 * never original row values. Original projection is identical at95 and142. */
export async function captureMigrationState(client, plan) {
  check(plans.has(plan), 'migration_plan_required');
  const catalog = await collectSchemaCatalog(client);
  const digest = catalogDigest(catalog, { physical: true });
  check([CATALOG95_SHA, CATALOG142_SHA].includes(digest), 'migration_unrecognized_catalog');
  const identity = (await client.query(IDENTITY_SQL)).rows[0];
  const fingerprints = [];
  let totalRows = 0, totalBytes = 0;
  for (const table of plan.catalog95.tables) {
    const columns = plan.catalog95.columns.filter(c => c.table_name === table.name).sort((a,b) => a.ordinal-b.ordinal);
    const projection = `(SELECT ${columns.map(c => q(c.name)).join(',')} FROM public.${q(table.name)}) AS original`;
    const size = (await client.query(`SELECT count(*)::text AS rows,COALESCE(sum(octet_length(row_to_json(original)::text)),0)::text AS bytes FROM ${projection}`)).rows[0];
    check(size && /^\d{1,12}$/.test(size.rows) && /^\d{1,12}$/.test(size.bytes), 'migration_fingerprint_shape');
    const rows = Number(size.rows), bytes = Number(size.bytes);
    totalRows += rows; totalBytes += bytes;
    check(rows <= 1000000 && bytes <= 268435456 && totalRows <= 5000000 && totalBytes <= 536870912, 'migration_data_bound');
    const hashed = (await client.query(`SELECT count(*)::text AS rows,md5(COALESCE(string_agg(h,'' ORDER BY h COLLATE "C"),'')) AS digest FROM (SELECT md5(row_to_json(original)::text) AS h FROM ${projection}) AS hashes`)).rows[0];
    check(hashed?.rows === size.rows && /^[a-f0-9]{32}$/.test(hashed?.digest ?? ''), 'migration_fingerprint_shape');
    fingerprints.push({ table: table.name, rows, bytes, digest: hashed.digest });
  }
  const privileges = {};
  for (const [name, sql] of Object.entries(PRIVILEGE_QUERIES)) {
    const rows = (await client.query(sql)).rows;
    check(Array.isArray(rows) && rows.length <= 20000 && Buffer.byteLength(JSON.stringify(rows)) <= 8000000, 'migration_metadata_bound');
    privileges[name] = rows;
  }
  const tableAcl = (await client.query(TABLE_ACL_SQL)).rows;
  const defaults = [], newTables = [];
  if (digest === CATALOG142_SHA) {
    for (const [table, fields] of Object.entries(LEGACY_DEFAULTS)) {
      for (const [column, value] of Object.entries(fields)) {
        const count = (await client.query(`SELECT count(*)::text AS mismatches FROM public.${q(table)} WHERE to_jsonb(${q(column)}) IS DISTINCT FROM $1::jsonb`, [value === null ? null : JSON.stringify(value)])).rows[0]?.mismatches;
        check(count === '0', 'migration_legacy_default_changed');
        defaults.push(`${table}.${column}`);
      }
    }
    for (const table of plan.catalog142.tables.filter(t => !plan.catalog95.tables.some(old => old.name === t.name))) {
      const count = (await client.query(`SELECT count(*)::text AS rows FROM public.${q(table.name)}`)).rows[0]?.rows;
      check(count === '0', 'migration_new_table_not_empty');
      newTables.push(table.name);
    }
  }
  return { identity, catalog, fingerprints, privileges, tableAcl, defaults, newTables };
}

export function assertMigrationPreserved(before, after, plan) {
  check(plans.has(plan), 'migration_plan_required');
  check(catalogDigest(before.catalog, { physical: true }) === CATALOG95_SHA && catalogDigest(after.catalog, { physical: true }) === CATALOG142_SHA, 'migration_catalog_drift');
  equal(after.fingerprints, before.fingerprints, 'migration_original_data_changed');
  // Exact142 digest binds all added definitions and all intermediate relaxations.
  // Retained original physical ordinals are checked independently here.
  for (const old of before.catalog.columns) {
    const actual = after.catalog.columns.find(c => c.table_name === old.table_name && c.name === old.name);
    equal(actual, relaxed.has(`${old.table_name}.${old.name}`) ? { ...old, nullable: true } : old, 'migration_original_column_changed');
  }
  check(after.defaults.length === 26 && after.newTables.length === 47, 'migration_preservation_coverage');
  const originalTables = new Set(before.catalog.tables.map(t => t.name));
  const originalColumns = new Set(before.catalog.columns.map(c => `${c.table_name}.${c.name}`));
  equal(after.tableAcl.filter(t => originalTables.has(t.name)), before.tableAcl, 'migration_original_acl_changed');
  check(after.tableAcl.length === 142 && after.tableAcl.every(t => t.owner === 'schema_admin'), 'migration_owner_changed');
  check(after.tableAcl.filter(t => !originalTables.has(t.name)).every(t => t.acl === 'DEFAULT'), 'migration_new_acl_unreviewed');
  for (const [section, rows] of Object.entries(before.privileges)) {
    const actual = after.privileges[section];
    const retained = section === 'tables' ? actual.filter(r => originalTables.has(r.name)) :
      section === 'columns' ? actual.filter(r => originalColumns.has(`${r.table_name}.${r.name}`)) : actual;
    equal(retained, rows, 'migration_privilege_policy_changed');
  }
  const principals = ['growthos-restore-reader', 'growthos-staging-live'];
  for (const [index, principal] of principals.entries()) {
    const tables = after.privileges.tables.filter(t => t.principal === principal);
    check(tables.length === 142 && new Set(tables.map(t => t.name)).size === 142 && tables.every(t => t.select === true && t.insert === Boolean(index) && t.update === Boolean(index) && t.delete === Boolean(index) && t.truncate === false && t.references === false && t.trigger === false), 'migration_table_access_mismatch');
    const columns = after.privileges.columns.filter(c => c.principal === principal);
    check(columns.length === after.catalog.columns.length && new Set(columns.map(c => `${c.table_name}.${c.name}`)).size === columns.length && columns.every(c => c.select === true && c.insert === Boolean(index) && c.update === Boolean(index) && c.references === false), 'migration_column_access_mismatch');
  }
  return { originalTables: 95, newTablesEmpty: 47, defaultsVerified: 26, privilegeTableEntries: 284 };
}

/** Mechanism only. The caller must pin expectedBefore to a fresh reviewed
 * read-only snapshot and must durably reserve an attempt before calling this.
 * persist must acknowledge durable writes; rejection stops before SQL dispatch.
 * Returning committed is not final release PASS; independent Reader is required. */
export async function executeMigration(client, { plan, expectedBefore, persist, outcome = 'rollback', operationMs = 180000 } = {}) {
  check(plans.has(plan) && typeof client?.query === 'function' && typeof persist === 'function', 'migration_arguments');
  check(['rollback','commit'].includes(outcome) && Number.isInteger(operationMs) && operationMs >= 1000 && operationMs <= 180000, 'migration_limits');
  check(!usedClients.has(client), 'migration_attempt_already_used');
  check(catalogDigest(expectedBefore?.catalog, { physical: true }) === CATALOG95_SHA, 'migration_expected_baseline_required');
  usedClients.add(client);
  const result = { status: 'failed', commitDispatched: false, commitAcknowledged: false, rollbackAcknowledged: false, stepsAcknowledged: 0, requiresFreshReader: false };
  let began = false;
  const deadline = Date.now() + operationMs;
  const query = async (...args) => {
    check(Date.now() < deadline, 'migration_deadline');
    let timer;
    try {
      return await Promise.race([client.query(...args), new Promise((_, reject) => {
        timer = setTimeout(() => { client.connection?.stream?.destroy(); reject(Object.assign(new Error('migration_query_timeout'), { safeCode: 'migration_query_timeout' })); }, Math.max(1, Math.min(20000, deadline-Date.now())));
      })]);
    } finally { clearTimeout(timer); }
  };
  const view = { query };
  const journal = async (event, cleanup = false) => {
    const remaining = cleanup ? 5000 : deadline-Date.now();
    check(remaining > 0, 'migration_deadline');
    let timer;
    try {
      await Promise.race([Promise.resolve().then(() => persist(event)),new Promise((_,reject)=>{
        timer=setTimeout(()=>{client.connection?.stream?.destroy();reject(Object.assign(new Error('migration_journal_timeout'),{safeCode:'migration_journal_timeout'}));},Math.min(5000,remaining));
      })]);
    } finally { clearTimeout(timer); }
  };
  try {
    const initial = (await query(IDENTITY_SQL)).rows[0];
    // Fly can select schema_admin as the login's initial effective role.
    // Keep the login fixed and admit only these two reviewed starting roles.
    // Booleans explain a refusal without persisting unexpected identity values.
    result.initialIdentityChecks = {
      database: initial?.database === 'growthos_staging',
      login: initial?.login === 'fly-user',
      role: ['fly-user', 'schema_admin'].includes(initial?.role),
      version: Number.isInteger(initial?.version) && initial.version >= 160000 && initial.version < 170000,
      pid: Number.isInteger(initial?.pid) && initial.pid > 0,
    };
    check(Object.values(result.initialIdentityChecks).every(value => value === true), 'migration_identity');
    await journal({ phase: 'begin-intent' });
    // Mark dispatched before awaiting: a lost BEGIN response still gets cleanup.
    began = true;
    check((await query('BEGIN ISOLATION LEVEL REPEATABLE READ')).command === 'BEGIN', 'migration_begin_unacknowledged');
    await query("SET LOCAL statement_timeout='15000ms'; SET LOCAL lock_timeout='3000ms'; SET LOCAL idle_in_transaction_session_timeout='20000ms'; SET LOCAL search_path=public,pg_catalog; SET LOCAL timezone='UTC'; SET LOCAL datestyle='ISO, YMD'; SET LOCAL intervalstyle='postgres'; SET LOCAL extra_float_digits=3; SET LOCAL bytea_output='hex'; SET LOCAL row_security=off; SET LOCAL ROLE schema_admin");
    await journal({ phase: 'begin-ack', pid: initial.pid });
    // Serializes DML and DDL over all originals before taking the data baseline.
    // LOCK precedes the first SELECT in REPEATABLE READ, so snapshot acquisition
    // cannot miss a writer that committed while the lock was being acquired.
    await query(`LOCK TABLE ${plan.catalog95.tables.map(t => `public.${q(t.name)}`).sort().join(',')} IN ACCESS EXCLUSIVE MODE`);
    const identity = (await query(IDENTITY_SQL)).rows[0];
    check(identityMatches(identity, 'fly-user', 'schema_admin') && identity.pid === initial.pid && identity.isolation === 'repeatable read' && identity.read_only === 'off', 'migration_schema_owner_identity');
    const before = await captureMigrationState(view, plan);
    for (const key of ['catalog','fingerprints','privileges','tableAcl']) equal(before[key], expectedBefore[key], 'migration_baseline_drift');
    for (const step of plan.steps) {
      await journal({ phase: 'step-intent', path: step.path, sha256: step.gitObjectSha256 });
      await query(step.sql);
      result.stepsAcknowledged++;
      await journal({ phase: 'step-ack', path: step.path });
    }
    const after = await captureMigrationState(view, plan);
    result.proof = assertMigrationPreserved(before, after, plan);
    result.before = before; result.after = after;
    await journal({ phase: 'precommit-verified', proof: result.proof });
    await journal({ phase: `${outcome}-intent` });
    if (outcome === 'commit') {
      result.commitDispatched = true;
      const committed = await query('COMMIT');
      check(committed.command === 'COMMIT', 'migration_commit_unacknowledged');
      result.commitAcknowledged = true; began = false; result.requiresFreshReader = true;
      await journal({ phase: 'commit-ack' });
      result.status = 'committed-awaiting-reader';
    } else {
      check((await query('ROLLBACK')).command === 'ROLLBACK', 'migration_rollback_unacknowledged');
      result.rollbackAcknowledged = true; began = false;
      await journal({ phase: 'rollback-ack' }); result.status = 'rehearsed-rolled-back';
    }
  } catch (error) {
    result.errorCode = /^migration_[a-z_]+$/.test(error?.safeCode ?? '') ? error.safeCode : 'migration_database_or_journal_failure';
    if (result.commitDispatched) { result.status = result.commitAcknowledged ? 'committed-journal-unconfirmed' : 'commit-unknown'; result.requiresFreshReader = true; }
    else if (began) {
      // Separate bounded cleanup, including after an operation deadline.
      let timer;
      try {
        const rolled = await Promise.race([client.query('ROLLBACK'), new Promise((_, reject) => { timer=setTimeout(() => { client.connection?.stream?.destroy(); reject(new Error('cleanup')); },5000); })]);
        result.rollbackAcknowledged = rolled.command === 'ROLLBACK';
        if (result.rollbackAcknowledged) await journal({ phase: 'rollback-ack', afterFailure: true }, true);
      } catch { result.cleanupUnconfirmed = true; } finally { clearTimeout(timer); }
    }
  }
  return result;
}

export function verifyCommittedMigration(result, reader, plan) {
  check(result?.commitAcknowledged === true && result.status === 'committed-awaiting-reader', 'migration_commit_not_accepted');
  check(identityMatches(reader?.identity, 'growthos-restore-reader', 'growthos-restore-reader') && reader.identity.pid !== result.after.identity.pid && reader.identity.read_only === 'on' && reader.identity.isolation === 'repeatable read', 'migration_fresh_reader_required');
  assertMigrationPreserved(result.before, reader, plan);
  for (const key of ['catalog','fingerprints','privileges','tableAcl','defaults','newTables']) equal(reader[key], result.after[key], 'migration_reader_result_changed');
  return { status: 'verified', ...result.proof, freshReaderVerified: true };
}
