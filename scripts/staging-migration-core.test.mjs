import { it as test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { prepareMigration, captureMigrationState, executeMigration, verifyCommittedMigration } from './staging-migration-core.mjs';
import { CATALOG_QUERIES } from '../reports/release-preparation-2026-10-09/schema-catalog.mjs';
import { PRIVILEGE_QUERIES } from './staging-observation-core.mjs';

// Canonical LF bytes are authenticated by the core's pinned manifest/SQL hashes.
// Reading checkout files also works in shallow CI clones without ancestor objects.
const canonicalBytes = path => Buffer.from(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8').replaceAll('\r\n', '\n'));
const manifestBytes = canonicalBytes('reports/release-preparation-2026-10-09/source-manifest.json');
const manifest = JSON.parse(manifestBytes);
const sqlBuffers = manifest.sqlFiles.slice(3).map(entry => canonicalBytes(entry.path));
const catalog95 = JSON.parse(canonicalBytes('reports/staging-observation-2026-10-10/fixtures/catalog-95.json'));
const catalog142 = JSON.parse(canonicalBytes('reports/staging-observation-2026-10-10/fixtures/catalog-142.json'));
const prepare = overrides => prepareMigration({ manifestBytes, sqlBuffers, catalog95, catalog142, ...overrides });
const principals = ['growthos-restore-reader', 'growthos-staging-live'];
function privilegeRows(catalog) {
  return {
    roles: principals.map(principal => ({ principal, name: principal, superuser: false, inherit: true, create_role: false,
      create_database: false, login: true, replication: false, bypass_rls: false, member: true, usable: true, can_set: true })),
    memberships: [],
    tables: principals.flatMap((principal, index) => catalog.tables.map(table => ({ principal, name: table.name, owner: 'schema_admin',
      select: true, insert: Boolean(index), update: Boolean(index), delete: Boolean(index), truncate: false, references: false, trigger: false }))),
    columns: principals.flatMap((principal, index) => catalog.columns.map(column => ({ principal, table_name: column.table_name,
      name: column.name, select: true, insert: Boolean(index), update: Boolean(index), references: false }))),
    namespaces: principals.map(principal => ({ principal, name: 'public', owner: 'schema_admin', usage: true, create: false })),
    database: principals.map(principal => ({ principal, name: 'growthos_staging', owner: 'postgres', connect: true, create: false, temporary: false })),
    sequences: [], functions: [], publicGrants: [], defaultGrants: [],
  };
}
function fake(plan, { identityPatch, initialRole = 'fly-user', loseBegin = false, loseCommit = false, thirdRoleNewAcl = false } = {}) {
  const state = { count: 95, role: initialRole, began: false, committed: false, destroyed: false }; const calls = [];
  const client = { connection: { stream: { destroy() { state.destroyed = true; } } }, async query(text) {
    calls.push(text);
    if (text.startsWith('SELECT current_database()')) return { rows: [{ database: 'growthos_staging', login: 'fly-user',
      role: state.role, version: 160015, pid: 1234, isolation: state.began ? 'repeatable read' : 'read committed', read_only: 'off', ...identityPatch }] };
    if (text.startsWith('BEGIN')) { state.began = true; if (loseBegin) throw new Error('credential-containing raw error'); return { command: 'BEGIN' }; }
    if (text.startsWith('SET LOCAL')) { state.role = 'schema_admin'; return { command: 'SET' }; }
    if (text.startsWith('LOCK TABLE')) return { command: 'LOCK' };
    if (text === 'ROLLBACK') { state.began = false; state.role = initialRole; state.count = 95; return { command: 'ROLLBACK' }; }
    if (text === 'COMMIT') { state.began = false; state.role = initialRole; state.committed = true;
      if (loseCommit) throw new Error('credential-containing raw error'); return { command: 'COMMIT' }; }
    const step = plan.steps.findIndex(value => value.sql === text);
    if (step >= 0) { if (step === 15) state.count = 142; return { command: 'ALTER' }; }
    const catalog = state.count === 95 ? catalog95 : catalog142;
    for (const [section, sql] of Object.entries(CATALOG_QUERIES)) if (text === sql) return { rows: structuredClone(catalog[section]) };
    for (const [section, sql] of Object.entries(PRIVILEGE_QUERIES)) if (text === sql) return { rows: privilegeRows(catalog)[section] };
    if (text.startsWith('SELECT c.relname AS name,owner.rolname AS owner,COALESCE')) return { rows: catalog.tables.map(table => ({ name: table.name, owner: 'schema_admin',
      acl: thirdRoleNewAcl && !catalog95.tables.some(original => original.name === table.name) ? '{unexpected_role=r/schema_admin}' : 'DEFAULT' })) };
    if (text.startsWith('SELECT count(*)::text AS rows,COALESCE(sum')) return { rows: [{ rows: '0', bytes: '0' }] };
    if (text.startsWith('SELECT count(*)::text AS rows,md5')) return { rows: [{ rows: '0', digest: 'd41d8cd98f00b204e9800998ecf8427e' }] };
    if (text.startsWith('SELECT count(*)::text AS mismatches')) return { rows: [{ mismatches: '0' }] };
    if (text.startsWith('SELECT count(*)::text AS rows FROM')) return { rows: [{ rows: '0' }] };
    throw new Error('unexpected_test_query');
  } };
  return { client, calls, state };
}
async function fixture(options) {
  const plan = prepare(); const target = fake(plan, options);
  const expectedBefore = await captureMigrationState(fake(plan).client, plan);
  return { plan, expectedBefore, ...target };
}

test('pins manifest, every SQL byte and exact physical catalogs before preparing immutable plan', () => {
  const plan = prepare(); assert.equal(plan.steps.length, 16); assert.ok(Object.isFrozen(plan.steps[0]));
  assert.throws(() => prepare({ manifestBytes: Buffer.concat([manifestBytes, Buffer.from('\n')]) }), /migration_manifest_drift/);
  const changed = sqlBuffers.map(bytes => Buffer.from(bytes)); changed[15][0] ^= 1;
  assert.throws(() => prepare({ sqlBuffers: changed }), /fixture_sql_blob_mismatch/);
  assert.throws(() => prepare({ sqlBuffers: sqlBuffers.slice(1) }), /migration_sql_count/);
  const drifted = structuredClone(catalog95); drifted.columns[0].ordinal++;
  assert.throws(() => prepare({ catalog95: drifted }), /migration_catalog_drift/);
});

test('rejects an unregistered copied plan without issuing queries', async () => {
  const f = await fixture(); f.calls.length = 0;
  await assert.rejects(executeMigration(f.client, { plan: { ...f.plan }, expectedBefore: f.expectedBefore, persist: async () => {} }), /migration_arguments/);
  assert.equal(f.calls.length, 0);
});

test('wrong current database cannot dispatch BEGIN or DDL', async () => {
  const f = await fixture({ identityPatch: { database: 'wrong_database' } });
  const result = await executeMigration(f.client, { plan: f.plan, expectedBefore: f.expectedBefore, persist: async () => {} });
  assert.equal(result.status, 'failed'); assert.equal(result.errorCode, 'migration_identity');
  assert.equal(f.calls.some(sql => sql.startsWith('BEGIN')), false); assert.equal(result.stepsAcknowledged, 0);
  assert.deepEqual(result.initialIdentityChecks, { database: false, login: true, role: true, version: true, pid: true });
  assert.equal(JSON.stringify(result).includes('wrong_database'), false);
});

test('fly-user login accepts only the two approved initial role configurations and keeps explicit transaction role selection', async () => {
  for (const initialRole of ['fly-user', 'schema_admin']) {
    const f = await fixture({ initialRole });
    const result = await executeMigration(f.client, { plan: f.plan, expectedBefore: f.expectedBefore, persist: async () => {} });
    assert.equal(result.status, 'rehearsed-rolled-back'); assert.equal(result.rollbackAcknowledged, true);
    assert.deepEqual(result.initialIdentityChecks, { database: true, login: true, role: true, version: true, pid: true });
    assert.ok(f.calls.some(sql => sql.startsWith('SET LOCAL') && sql.includes('SET LOCAL ROLE schema_admin')));
    assert.equal(result.before.identity.login, 'fly-user'); assert.equal(result.before.identity.role, 'schema_admin');
    assert.equal(result.before.identity.pid, 1234); assert.equal(f.state.role, initialRole);
  }
});

test('wrong initial login, role, version or PID is refused before BEGIN and exposes only bounded check booleans', async () => {
  const invalid = [
    ['login', 'unexpected-secret-login'], ['role', 'unexpected-secret-role'],
    ['version', '160015'], ['version', 150015], ['version', 170000], ['version', null],
    ['pid', 0], ['pid', -1], ['pid', 12.5], ['pid', '1234'], ['pid', null],
  ];
  for (const [field, value] of invalid) {
    const f = await fixture({ identityPatch: { [field]: value } }); let journals = 0;
    const result = await executeMigration(f.client, { plan: f.plan, expectedBefore: f.expectedBefore, persist: async () => { journals++; } });
    assert.equal(result.status, 'failed'); assert.equal(result.errorCode, 'migration_identity');
    assert.equal(result.stepsAcknowledged, 0); assert.equal(result.commitDispatched, false); assert.equal(journals, 0);
    assert.equal(f.calls.length, 1); assert.equal(f.calls.some(sql => sql.startsWith('BEGIN')), false);
    const expected = { database: true, login: true, role: true, version: true, pid: true }; expected[field] = false;
    assert.deepEqual(result.initialIdentityChecks, expected);
    assert.equal(JSON.stringify(result).includes('unexpected-secret'), false);
  }
});

test('begin intent journal rejection prevents BEGIN; lost BEGIN response requests rollback', async () => {
  const before = await fixture();
  const rejected = await executeMigration(before.client, { plan: before.plan, expectedBefore: before.expectedBefore, persist: async () => { throw new Error('journal unavailable'); } });
  assert.equal(rejected.status, 'failed'); assert.equal(before.calls.some(sql => sql.startsWith('BEGIN')), false);
  const lost = await fixture({ loseBegin: true });
  const recovered = await executeMigration(lost.client, { plan: lost.plan, expectedBefore: lost.expectedBefore, persist: async () => {} });
  assert.equal(recovered.status, 'failed'); assert.equal(recovered.rollbackAcknowledged, true);
  assert.equal(JSON.stringify(recovered).includes('credential-containing'), false);
});

test('step intent journal failure stops before that SQL and rolls back acknowledged earlier steps', async () => {
  const f = await fixture(); let intents = 0;
  const result = await executeMigration(f.client, { plan: f.plan, expectedBefore: f.expectedBefore,
    persist: async event => { if (event.phase === 'step-intent' && ++intents === 4) throw new Error('journal unavailable'); } });
  assert.equal(result.stepsAcknowledged, 3); assert.equal(result.rollbackAcknowledged, true);
  assert.equal(f.calls.includes(f.plan.steps[3].sql), false); assert.equal(result.commitDispatched, false);
});

test('rollback rehearsal accepts all empty originals and proves47/26/284 coverage', async () => {
  const f = await fixture();
  const result = await executeMigration(f.client, { plan: f.plan, expectedBefore: f.expectedBefore, persist: async () => {} });
  assert.equal(result.status, 'rehearsed-rolled-back'); assert.equal(result.rollbackAcknowledged, true);
  assert.deepEqual(result.proof, { originalTables: 95, newTablesEmpty: 47, defaultsVerified: 26, privilegeTableEntries: 284 });
});

test('lost COMMIT acknowledgment is unknown and never retried or followed by rollback', async () => {
  const f = await fixture({ loseCommit: true });
  const result = await executeMigration(f.client, { plan: f.plan, expectedBefore: f.expectedBefore, persist: async () => {}, outcome: 'commit' });
  assert.equal(result.status, 'commit-unknown'); assert.equal(result.commitDispatched, true); assert.equal(result.commitAcknowledged, false);
  assert.equal(result.requiresFreshReader, true); assert.equal(f.state.committed, true); assert.equal(f.calls.includes('ROLLBACK'), false);
  assert.equal(f.calls.filter(sql => sql === 'COMMIT').length, 1);
  await assert.rejects(executeMigration(f.client, { plan: f.plan, expectedBefore: f.expectedBefore, persist: async () => {}, outcome: 'commit' }), /migration_attempt_already_used/);
  assert.equal(JSON.stringify(result).includes('credential-containing'), false);
});

test('failed durable commit acknowledgment journal cannot be promoted to verified success', async () => {
  const f = await fixture();
  const result = await executeMigration(f.client, { plan: f.plan, expectedBefore: f.expectedBefore, outcome: 'commit',
    persist: async event => { if (event.phase === 'commit-ack') throw new Error('journal unavailable'); } });
  assert.equal(result.status, 'committed-journal-unconfirmed'); assert.equal(result.commitAcknowledged, true); assert.equal(result.requiresFreshReader, true);
  assert.throws(() => verifyCommittedMigration(result, result.after, f.plan), /migration_commit_not_accepted/);
});

test('acknowledged COMMIT requires a different Reader backend and exact postcommit recapture', async () => {
  const f = await fixture();
  const result = await executeMigration(f.client, { plan: f.plan, expectedBefore: f.expectedBefore, persist: async () => {}, outcome: 'commit' });
  assert.equal(result.status, 'committed-awaiting-reader');
  assert.throws(() => verifyCommittedMigration(result, result.after, f.plan), /migration_fresh_reader_required/);
  const reader = structuredClone(result.after);
  reader.identity = { ...reader.identity, login: principals[0], role: principals[0], pid: 9999, read_only: 'on', isolation: 'repeatable read' };
  assert.equal(verifyCommittedMigration(result, reader, f.plan).status, 'verified');
  reader.fingerprints[0].digest = 'a'.repeat(32);
  assert.throws(() => verifyCommittedMigration(result, reader, f.plan), /migration_original_data_changed/);
});

test('third-role grants on new tables prevent COMMIT even with complete Reader/Writer access', async () => {
  const f = await fixture({ thirdRoleNewAcl: true });
  const result = await executeMigration(f.client, { plan: f.plan, expectedBefore: f.expectedBefore, persist: async () => {}, outcome: 'commit' });
  assert.equal(result.status, 'failed'); assert.equal(result.rollbackAcknowledged, true);
  assert.equal(result.commitDispatched, false); assert.equal(result.stepsAcknowledged, 16);
  assert.match(result.errorCode, /^migration_.*acl/);
});

test('hanging journal is bounded by the operation deadline, destroys transport, and never dispatches BEGIN', async () => {
  const f = await fixture(); const start = Date.now();
  const result = await executeMigration(f.client, { plan: f.plan, expectedBefore: f.expectedBefore,
    operationMs: 1000, persist: async () => new Promise(() => {}) });
  assert.equal(result.status, 'failed'); assert.equal(result.commitDispatched, false);
  assert.equal(f.state.destroyed, true); assert.equal(f.calls.some(sql => sql.startsWith('BEGIN')), false);
  assert.match(result.errorCode, /^migration_.*(?:journal|deadline)/);
  assert.ok(Date.now() - start < 3500);
});

test('hanging commit acknowledgment journal retains committed uncertainty without repeating COMMIT', async () => {
  const f = await fixture(); const start = Date.now();
  const result = await executeMigration(f.client, { plan: f.plan, expectedBefore: f.expectedBefore, outcome: 'commit', operationMs: 1500,
    persist: async event => event.phase === 'commit-ack' ? new Promise(() => {}) : undefined });
  assert.equal(result.status, 'committed-journal-unconfirmed'); assert.equal(result.commitAcknowledged, true);
  assert.equal(result.requiresFreshReader, true); assert.equal(f.state.destroyed, true);
  assert.equal(f.calls.filter(sql => sql === 'COMMIT').length, 1); assert.equal(f.calls.includes('ROLLBACK'), false);
  assert.throws(() => verifyCommittedMigration(result, result.after, f.plan), /migration_commit_not_accepted/);
  assert.ok(Date.now() - start < 3500);
});
