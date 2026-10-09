// New inert local fixture helper. Text-selected provenance: Oct6 offline-staging-rehearsal.
// No old workflow/guard/approval/entrypoint import. Caller supplies owned pg connection.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {basename,join} from 'node:path';
import vm from 'node:vm';
import {collectSchemaCatalog,assertCatalogEquivalent} from './schema-catalog.mjs';
const freeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};
const ROOT='C:/Users/diazd/dev/projects/mogulforge-integrated-specialists-20261009';
const requireDb=createRequire(join(ROOT,'lib/db/package.json')),requireRoot=createRequire(join(ROOT,'package.json'));
const sha=x=>createHash('sha256').update(x).digest('hex'),DAY='2026-10-06T12:00:00.000Z';
const q=value=>{assert.match(value,/^[a-z_][a-z0-9_]*$/);return `"${value}"`;};
function syntheticId(lane,entity){const v=sha(`LOCAL-ONLY-95-142:${lane}:${entity}`);return `${v.slice(0,8)}-${v.slice(8,12)}-4${v.slice(13,16)}-a${v.slice(17,20)}-${v.slice(20,32)}`;}
export const RELAXATIONS = Object.freeze([
  ['0008', 'staff_push_deliveries', 'lead_id'], ['0010', 'email_response_reviews', 'source_id'],
  ['0017', 'estimates', 'lead_id'], ['0017', 'invoices', 'lead_id'], ['0017', 'projects', 'lead_id'], ['0017', 'value_entries', 'lead_id'],
]);
const TABLE_COUNTS = [89, 90, 95, 95, 97, 99, 103, 105, 111, 117, 117, 118, 121, 125, 130, 133, 139, 141];
// Baseline95 additions are finite and separate from defaults in tables created
// later in the chain. New tables must stay empty throughout preservation proof.
export const LEGACY_DEFAULTS = Object.freeze({
  organizations: { entitlements: null },
  leads: { import_source_key: null, external_opportunity_id: null, imported_history: null },
  lead_imports: { updated: 0, conflicts: 0, source_key: null, snapshot_as_of: null },
  service_obligations: { recurrence: null, predecessor_obligation_id: null, occurrence_index: 0, coverage_starts_on: null, coverage_ends_on: null, coverage_evidence: null, completion_note: null },
  staff_push_deliveries: { service_obligation_id: null, service_watch_case_id: null, service_notice_revision: null, service_owner_id: null, event_key: null },
  estimates: { customer_work_id: null, work_version: null }, projects: { customer_work_id: null, work_version: null },
  value_entries: { customer_work_id: null, refund_of_value_entry_id: null },
});

function loadPureSchema(verified) {
  const ts = requireRoot('typescript');
  const cache = new Map(), context = vm.createContext(Object.create(null));
  const allowed = new Set(['drizzle-orm', 'drizzle-orm/pg-core', 'drizzle-zod', 'zod/v4']);
  const load = path => {
    if (cache.has(path)) return cache.get(path).exports;
    assert(verified.manifest.schemaFiles.some(x => x.path === path), 'schema_module_not_reviewed');
    const source = verified.sources.get(path);
    const parsed = ts.createSourceFile(path, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
    const scan = node => {
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || node.expression.getText(parsed) === 'require')) throw new Error('schema_dynamic_import_forbidden');
      if (ts.isIdentifier(node) && ['process', 'global', 'globalThis', 'fetch', 'eval', 'Function'].includes(node.text)) throw new Error('schema_ambient_authority_forbidden');
      ts.forEachChild(node, scan);
    }; scan(parsed);
    const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }, fileName: path, reportDiagnostics: true });
    assert(!output.diagnostics?.some(x => x.category === ts.DiagnosticCategory.Error), 'schema_transpile_failed');
    const module = { exports: {} }; cache.set(path, module);
    const localRequire = request => {
      if (allowed.has(request)) return requireDb(request);
      assert.match(request, /^\.\/[a-z0-9-]+$/, 'schema_import_outside_closed_set');
      return load(`lib/db/src/schema/${request.slice(2)}.ts`);
    };
    const wrapper = new vm.Script(`(function(exports, require, module) {\n${output.outputText}\n})`, { filename: path }).runInContext(context, { timeout: 5000 });
    wrapper(module.exports, localRequire, module);
    return module.exports;
  };
  return load('lib/db/src/schema/index.ts');
}

async function insert(db, table, row) {
  const keys = Object.keys(row);
  await db.query(`INSERT INTO public.${q(table)} (${keys.map(q).join(',')}) VALUES (${keys.map((_, n) => `$${n + 1}`).join(',')})`, Object.values(row));
}

async function seedBaseline(db) {
  // All names, IDs and fake ciphertext are solely local synthetic sentinels.
  // No actual contact, credential, signed token, endpoint or provider binding.
  for (const lane of ['a', 'b']) {
    const id = entity => syntheticId(lane, entity), org = id('org'), user = id('user'), contact = id('contact');
    const shared = { organization_id: org }, times = { created_at: DAY, updated_at: DAY };
    await insert(db, 'organizations', { id: org, name: `SYNTHETIC OFFLINE ${lane}`, slug: `offline-schema-${lane}`, timezone: 'America/New_York', ...times });
    await insert(db, 'users', { id: user, ...shared, email: `inactive-${lane}@example.invalid`, role: 'owner', is_active: false, ...times });
    await insert(db, 'contacts', { id: contact, ...shared, first_name: 'Synthetic', last_name: lane, email: `never-contact-${lane}@example.invalid`, phone: null, do_not_contact: true, do_not_contact_email: true, do_not_contact_sms: true, ...times });
    await insert(db, 'properties', { id: id('property'), ...shared, contact_id: contact, address_line_1: 'OFFLINE SYNTHETIC SITE', city: 'Not a real city', state: 'ZZ', postal_code: '00000', ...times });
    for (const item of ['one', 'two']) {
      await insert(db, 'leads', { id: id(`lead-${item}`), ...shared, contact_id: contact, property_id: id('property'), status: 'nurture', source: 'synthetic-offline', summary: `Keep ${lane}/${item}`, score_reasons: JSON.stringify([{ synthetic: true, item }]), ...times });
      await insert(db, 'crm_tasks', { id: id(`task-${item}`), ...shared, lead_id: id(`lead-${item}`), contact_id: contact, title: 'SYNTHETIC cancelled work', description: 'Original office note must remain byte-identical', status: 'cancelled', due_at: DAY, ...times });
      await insert(db, 'service_obligations', { id: id(`service-${item}`), ...shared, contact_id: contact, property_id: id('property'), task_id: id(`task-${item}`), kind: 'maintenance', equipment_label: `SYNTHETIC ${item}`, due_at: DAY, status: 'cancelled', source: 'synthetic-offline', external_ref: `offline-${lane}-${item}`, notes: 'No actual equipment or warranty assertion', ...times });
    }
    await insert(db, 'lead_imports', { id: id('import'), ...shared, file_name: 'synthetic.csv', total_rows: 4, imported: 2, duplicates: 1, skipped: 1, errors: JSON.stringify([{ row: 4, reason: 'synthetic' }]), created_by_user_id: user, created_at: DAY });
    await insert(db, 'sessions', { sid: `synthetic-expired-${lane}`, sess: JSON.stringify({ syntheticOnly: true }), expire: DAY });
    await insert(db, 'email_sender_preferences', { id: id('sender'), ...shared, user_id: user, provider: 'microsoft', updated_at: DAY });
    await insert(db, 'microsoft_connections', { id: id('microsoft'), ...shared, user_id: user, account_id: `synthetic-${lane}`, email: `revoked-${lane}@example.invalid`, encrypted_refresh_token: `NOT-A-CREDENTIAL:synthetic-ciphertext-${lane}`, revoked_at: DAY, ...times });
    await insert(db, 'staff_push_policies', { ...shared, policy: JSON.stringify({ enabled: false, syntheticOnly: true }), updated_at: DAY });
    await insert(db, 'staff_push_subscriptions', { id: id('push-subscription'), ...shared, user_id: user, session_id: `synthetic-expired-${lane}`, endpoint_hash: sha(`not-an-endpoint-${lane}`), encrypted_subscription: null, expires_at: DAY, revoked_at: DAY, created_at: DAY });
    await insert(db, 'staff_push_deliveries', { id: id('push-delivery'), ...shared, lead_id: id('lead-one'), subscription_id: id('push-subscription'), state: 'skipped', reason: 'synthetic_only', created_at: DAY, expires_at: DAY, completed_at: DAY });
    await insert(db, 'estimates', { id: id('estimate'), ...shared, lead_id: id('lead-one'), title: 'SYNTHETIC old estimate', status: 'draft', notes: 'Preserve exact legacy money lineage', subtotal_cents: 4321, total_cents: 4321, ...times });
    await insert(db, 'projects', { id: id('project'), ...shared, lead_id: id('lead-one'), estimate_id: id('estimate'), name: 'SYNTHETIC old job', status: 'scheduled', crew_notes: 'Preserve exact crew note', ...times });
    await insert(db, 'value_entries', { id: id('payment'), ...shared, lead_id: id('lead-one'), source_reference: `synthetic-payment-${lane}`, kind: 'payment', amount_cents: 1234, occurred_at: DAY, recorded_by_user_id: user, created_at: DAY });
    await insert(db, 'stored_objects', { id: id('object'), ...shared, data: Buffer.from([0, 255, 1, 127, 13, 10, 0]), content_type: 'application/octet-stream', size_bytes: 7, metadata: JSON.stringify({ syntheticOnly: true, private: true }), created_at: DAY });
    await insert(db, 'revenue_executions', { id: id('receipt'), ...shared, action_key: `offline-original:${lane}:v1`, fingerprint: sha(`original-unknown-${lane}`), kind: 'synthetic_original_only', state: 'indeterminate', detail: 'Synthetic uncertain receipt: must not be rearmed', actor_user_id: user, expires_at: DAY, created_at: DAY });
  }
}

async function baselineProjection(db, catalog) {
  const rows = {};
  for (const { name } of catalog.tables) {
    const columns = catalog.columns.filter(x => x.table_name === name).sort((a, b) => a.ordinal - b.ordinal).map(x => x.name);
    // Explicit ORIGINAL columns; duplicate rows retained; no changing SELECT *.
    rows[name] = (await db.query(`SELECT to_jsonb(p)::text AS row FROM (SELECT ${columns.map(q).join(',')} FROM public.${q(name)}) p ORDER BY to_jsonb(p)::text`)).rows.map(x => x.row);
  }
  return rows;
}
async function assertPreserved(db, baseline, before) { assert.deepEqual(await baselineProjection(db, baseline), before, 'baseline_rows_changed'); }

export function assertRetainedMetadata(before, after, delta, reviewedCallieCheck = null) {
  const allowed = RELAXATIONS.filter(([step]) => delta === null || step === delta).map(([, table, column]) => `${table}.${column}`);
  for (const section of ['tables', 'columns', 'constraints', 'indexes', 'enums', 'triggers', 'policies']) {
    for (const old of before[section]) {
      const row = after[section].find(x => x.name === old.name && x.table_name === old.table_name && x.schema === old.schema);
      // PostgreSQL18 materializes NOT NULL as a redundant constraint. Only the
      // exact allowed column's matching NOT NULL may disappear with attnotnull.
      if (section === 'constraints' && old.kind === 'n' && old.columns.length === 1 && allowed.includes(`${old.table_name}.${old.columns[0]}`)) {
        assert.equal(row, undefined, 'relaxed_not_null_constraint_retained'); continue;
      }
      if (section === 'constraints' && delta === '0015' && old.table_name === 'callie_intakes' && old.name === 'callie_intake_state_ck') {
        assert(reviewedCallieCheck, 'reviewed_callie_check_required');
        assert.deepEqual(row, reviewedCallieCheck, 'reviewed_callie_check_drift'); continue;
      }
      let expected = old;
      if (section === 'columns' && allowed.includes(`${old.table_name}.${old.name}`)) expected = { ...old, nullable: true };
      assert.deepEqual(row, expected, `retained_metadata_changed:${section}:${old.table_name ?? ''}.${old.name}`);
    }
  }
  assert(after.constraints.every(x => x.validated), 'unvalidated_constraint');
  assert(after.indexes.every(x => x.is_valid && x.is_ready && x.is_live), 'invalid_index');
}

async function assertLegacyDefaults(db, baseline, target) {
  const original = new Set(baseline.columns.map(x => `${x.table_name}.${x.name}`));
  const originalTables = new Set(baseline.tables.map(x => x.name));
  const added = target.columns.filter(x => originalTables.has(x.table_name) && !original.has(`${x.table_name}.${x.name}`)).map(x => `${x.table_name}.${x.name}`).sort();
  assert.deepEqual(added, Object.entries(LEGACY_DEFAULTS).flatMap(([table, fields]) => Object.keys(fields).map(name => `${table}.${name}`)).sort(), 'unexpected_legacy_added_columns');
  for (const [table, expected] of Object.entries(LEGACY_DEFAULTS)) {
    const rows = (await db.query(`SELECT ${Object.keys(expected).map(q).join(',')} FROM ${q(table)}`)).rows;
    assert(rows.length >= 2, `missing_two_company_default_fixture:${table}`);
    for (const row of rows) assert.deepEqual(row, expected, `legacy_defaults_changed:${table}`);
  }
  const addedTables = target.tables.filter(x => !originalTables.has(x.name)).map(x => x.name);
  assert.equal(addedTables.length, 47);
  for (const name of addedTables) assert.equal((await db.query(`SELECT count(*)::int AS count FROM ${q(name)}`)).rows[0].count, 0, `new_table_not_empty:${name}`);
  return { addedColumns: added.length, newTables: addedTables };
}

async function independentSchema(db, verified) {
  const { generateDrizzleJson, generateMigration } = requireDb('drizzle-kit/api');
  const schema = loadPureSchema(verified);
  const current = generateDrizzleJson(schema); assert.equal(Object.keys(current.tables).length, 142);
  const ddl = await generateMigration(generateDrizzleJson({}), current);
  assert(ddl.length > 0, 'empty_independent_ddl');
  await db.exec('BEGIN');
  try {
    await db.exec("SET LOCAL statement_timeout='30s'; SET LOCAL lock_timeout='5s'");
    for (const sql of ddl) await db.exec(sql);
    const catalog = await collectSchemaCatalog(db); await db.exec('COMMIT');
    return { catalog, ddlSha256: sha(ddl.join(';\n')), statements: ddl.length };
  } catch (error) { await db.exec('ROLLBACK'); throw error; }
}

async function exactReviewedCallieCheck(db, sql, expectedCatalog) {
  const matches = sql.match(/ALTER TABLE "callie_intakes" ADD CONSTRAINT "callie_intake_state_ck" CHECK [^;]+;/g) ?? [];
  assert.equal(matches.length, 1, 'reviewed_callie_replacement_not_unique');
  await db.exec('BEGIN');
  try {
    await db.exec('ALTER TABLE callie_intakes DROP CONSTRAINT callie_intake_state_ck');
    await db.exec(matches[0]);
    const actual = await collectSchemaCatalog(db);
    // The exact pinned0015 statement must independently match the pure current
    // schema's full catalog, not merely be another validated same-name CHECK.
    assertCatalogEquivalent(actual, expectedCatalog, { physical: true });
    return actual.constraints.find(x => x.table_name === 'callie_intakes' && x.name === 'callie_intake_state_ck');
  } finally { await db.exec('ROLLBACK'); }
}


export {seedBaseline,baselineProjection,assertPreserved,assertLegacyDefaults,independentSchema,exactReviewedCallieCheck};
