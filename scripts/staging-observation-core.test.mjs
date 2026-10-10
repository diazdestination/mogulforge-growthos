import { it as test } from 'vitest';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { observeStaging, PRIVILEGE_QUERIES } from './staging-observation-core.mjs';
import { CATALOG_QUERIES } from '../reports/release-preparation-2026-10-09/schema-catalog.mjs';

const expectedCatalogs = Object.fromEntries(await Promise.all(['95','141','142'].map(async (count) => [count, JSON.parse(await readFile(new URL(`../reports/staging-observation-2026-10-10/fixtures/catalog-${count}.json`, import.meta.url), 'utf8'))])));
const principals = ['growthos-restore-reader','growthos-staging-live'];
const identity = { database: 'growthos_staging', login: principals[0], role: principals[0], server_version_num: '160013', read_only: 'on', isolation: 'repeatable read', row_security: 'off', statement_timeout: '15s', lock_timeout: '2s', idle_timeout: '20s', sql_tls: false };

function privilegeRows(catalog) {
  return {
    roles: principals.map((principal) => ({ principal, name: principal, superuser: false, inherit: true, create_role: false, create_database: false, login: true, replication: false, bypass_rls: false, member: true, usable: true, can_set: true })),
    memberships: [],
    tables: principals.flatMap((principal) => catalog.tables.map((table) => ({ principal, name: table.name, owner: 'fly-user', select: true, insert: principal === principals[1], update: principal === principals[1], delete: principal === principals[1], truncate: false, references: false, trigger: false }))),
    columns: principals.flatMap((principal) => catalog.columns.map((column) => ({ principal, table_name: column.table_name, name: column.name, select: true, insert: principal === principals[1], update: principal === principals[1], references: false }))),
    namespaces: principals.map((principal) => ({ principal, name: 'public', owner: 'fly-user', usage: true, create: false })),
    database: principals.map((principal) => ({ principal, name: 'growthos_staging', owner: 'fly-user', connect: true, create: false, temporary: false })),
    sequences: [], functions: [], publicGrants: [], defaultGrants: [],
  };
}

function fake({ count = '95', changeCatalog, changePrivileges, changeIdentity, intercept } = {}) {
  const catalog = structuredClone(expectedCatalogs[count]);
  changeCatalog?.(catalog);
  const privileges = privilegeRows(catalog);
  changePrivileges?.(privileges);
  const actualIdentity = { ...identity };
  changeIdentity?.(actualIdentity);
  const calls = [];
  const client = { async query(config) {
    calls.push(config);
    const text = config.text.replace(/ LIMIT [0-9]+$/, '');
    const replacement = intercept?.(text, calls);
    if (replacement !== undefined) return replacement;
    if (text.startsWith('BEGIN')) return [{ command: 'BEGIN', rows: [] }];
    if (text === 'ROLLBACK') return { command: 'ROLLBACK', rows: [] };
    if (text.startsWith('SELECT current_database()')) return { rows: [actualIdentity] };
    for (const [section, sql] of Object.entries(CATALOG_QUERIES)) if (text === sql) return { rows: catalog[section] };
    if (text.startsWith('SELECT n.nspname AS schema,c.relname AS name,c.relkind')) return { rows: catalog.tables.map((table) => ({ schema: table.schema, name: table.name, kind: table.kind, is_partition: table.is_partition, row_security: table.row_security, extension_owned: false, extension_name: null, extension_version: null, inherited: false })) };
    for (const [section, sql] of Object.entries(PRIVILEGE_QUERIES)) if (text === sql) return { rows: privileges[section] };
    if (text.startsWith('SELECT count(*)::text AS row_count,COALESCE(sum')) return { rows: [{ row_count: '2', payload_bytes: '500' }] };
    if (text.startsWith('SELECT count(*)::text AS row_count,md5')) return { rows: [{ row_count: '2', digest: 'a'.repeat(32) }] };
    throw new Error('unexpected_test_query');
  } };
  return { client, calls, catalog };
}

test('recognizes each complete source catalog and fingerprints every public table in one protected snapshot', async () => {
  for (const count of ['95','141','142']) {
    const { client, calls, catalog } = fake({ count });
    const result = await observeStaging(client, { expectedCatalogs });
    assert.equal(result.status, 'observed');
    assert.equal(result.catalog.classification, count);
    assert.equal(result.catalog.physicalMatch, true);
    assert.equal(result.fingerprintSummary.complete, true);
    assert.deepEqual(result.fingerprints.map((row) => row.table), catalog.tables.map((table) => table.name));
    assert.equal(result.fingerprintSummary.rows, Number(count) * 2);
    assert.equal(result.transaction.rollbackAcknowledged, true);
    assert.match(calls[0].text, /^BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;/);
    assert.match(calls[0].text, /SET LOCAL row_security = off/);
    assert.equal(calls.at(-1).text, 'ROLLBACK');
    assert.ok(calls.every((call) => Number.isInteger(call.query_timeout) && call.query_timeout > 0));
    assert.equal(result.scope.releaseAuthorized, false);
    assert.equal(result.scope.recoveryVerified, false);
  }
});

test('same-count changed default stays unknown and does not fingerprint an unrecognized domain', async () => {
  const { client, calls } = fake({ changeCatalog(catalog) { catalog.columns[0].default_expression = "'unexpected secret-bearing default'::text"; } });
  const result = await observeStaging(client, { expectedCatalogs });
  assert.equal(result.status, 'unresolved');
  assert.equal(result.catalog.tables, 95);
  assert.equal(result.catalog.classification, 'unknown');
  assert.ok(result.unresolved.includes('catalog_not_recognized'));
  assert.equal(result.fingerprintSummary.complete, false);
  assert.equal(JSON.stringify(result).includes('unexpected secret-bearing default'), false);
  assert.equal(result.catalog.metadata, undefined);
  assert.ok(result.catalog.comparison.find((row) => row.version === '95').changedFields.includes('default_expression'));
  assert.equal(calls.filter((call) => call.text.startsWith('SELECT count(*)')).length, 0);
  assert.equal(result.transaction.rollbackAcknowledged, true);
});

test('physical ordinal change is separately unresolved even when logical schema matches', async () => {
  const { client } = fake({ changeCatalog(catalog) { catalog.columns[0].ordinal += 100; } });
  const result = await observeStaging(client, { expectedCatalogs });
  assert.equal(result.status, 'unresolved');
  assert.equal(result.catalog.classification, '95');
  assert.equal(result.catalog.physicalMatch, false);
  assert.ok(result.unresolved.includes('physical_catalog_difference'));
});

test('rejects session identity, server version and read-only failures before application data reads', async () => {
  for (const [field, value, errorCode] of [['database','production','session_identity_mismatch'], ['login','fly-user','session_identity_mismatch'], ['role','fly-user','session_identity_mismatch'], ['server_version_num','180000','postgres_version_mismatch'], ['read_only','off','transaction_protection_invalid'], ['row_security','on','transaction_protection_invalid'], ['isolation','read committed','transaction_protection_invalid']]) {
    const { client, calls } = fake({ changeIdentity(actual) { actual[field] = value; } });
    const result = await observeStaging(client, { expectedCatalogs });
    assert.equal(result.status, 'failed');
    assert.equal(result.errorCode, errorCode);
    assert.equal(result.transaction.rollbackAcknowledged, true);
    assert.equal(calls.length, 3);
    assert.equal(result.identity, undefined);
  }
});

test('RLS and unsupported objects do not become complete protected-data evidence', async () => {
  const { client } = fake({ intercept(text) {
    if (text.startsWith('SELECT n.nspname AS schema,c.relname AS name,c.relkind')) return { rows: [
      ...expectedCatalogs['95'].tables.map((table) => ({ schema: 'public', name: table.name, kind: 'r', is_partition: false, row_security: table.name === expectedCatalogs['95'].tables[0].name, extension_owned: false, extension_name: null, extension_version: null, inherited: false })),
      { schema: 'legacy', name: 'unreviewed_data', kind: 'f', is_partition: false, row_security: false, extension_owned: false, extension_name: null, extension_version: null, inherited: false },
    ] };
  } });
  const result = await observeStaging(client, { expectedCatalogs });
  assert.equal(result.status, 'unresolved');
  assert.ok(result.unresolved.includes('unsupported_database_objects'));
  assert.ok(result.unresolved.includes('row_security_requires_separate_proof'));
  assert.equal(result.fingerprintSummary.complete, false);
});

test('extension-owned public view remains excluded and unresolved while recognized application tables are completely fingerprinted', async () => {
  const { client, calls } = fake({ intercept(text) {
    if (text.startsWith('SELECT n.nspname AS schema,c.relname AS name,c.relkind')) return { rows: [
      ...expectedCatalogs['95'].tables.map((table) => ({ schema: 'public', name: table.name, kind: 'r', is_partition: false, row_security: false, extension_owned: false, extension_name: null, extension_version: null, inherited: false })),
      { schema: 'public', name: 'pg_stat_monitor', kind: 'v', is_partition: false, row_security: false, extension_owned: true, extension_name: 'pg_stat_monitor', extension_version: '2.1', inherited: false },
    ] };
  } });
  const receipt = await observeStaging(client, { expectedCatalogs });
  assert.equal(receipt.status, 'unresolved');
  assert.ok(receipt.unresolved.includes('unsupported_database_objects'));
  assert.equal(receipt.unresolved.includes('application_fingerprint_scope_blocked'), false);
  assert.equal(receipt.fingerprintSummary.complete, true);
  assert.equal(receipt.fingerprintSummary.tables, 95);
  assert.equal(receipt.scope.fingerprintScope, 'recognized_public_application_tables');
  assert.equal(receipt.scope.fullClusterDataCoverage, false);
  assert.deepEqual(receipt.scope.excludedExtensionViews, [{ schema: 'public', name: 'pg_stat_monitor', kind: 'v', extension_name: 'pg_stat_monitor', extension_version: '2.1' }]);
  assert.equal(calls.some((call) => call.text.includes('FROM "public"."pg_stat_monitor"')), false);
  assert.equal(receipt.transaction.rollbackAcknowledged, true);
});

test('unowned views and extension base, materialized or foreign relations still block application fingerprints', async () => {
  for (const [kind, extensionOwned] of [['v',false], ['r',true], ['m',true], ['f',true]]) {
    const { client, calls } = fake({ intercept(text) {
      if (text.startsWith('SELECT n.nspname AS schema,c.relname AS name,c.relkind')) return { rows: [
        ...expectedCatalogs['95'].tables.map((table) => ({ schema: 'public', name: table.name, kind: 'r', is_partition: false, row_security: false, extension_owned: false, extension_name: null, extension_version: null, inherited: false })),
        { schema: 'public', name: 'unreviewed_relation', kind, is_partition: false, row_security: false, extension_owned: extensionOwned, extension_name: extensionOwned ? 'extension' : null, extension_version: extensionOwned ? '1.0' : null, inherited: false },
      ] };
    } });
    const receipt = await observeStaging(client, { expectedCatalogs });
    assert.equal(receipt.status, 'unresolved');
    assert.ok(receipt.unresolved.includes('application_fingerprint_scope_blocked'));
    assert.equal(receipt.fingerprintSummary.complete, false);
    assert.equal(calls.filter((call) => call.text.startsWith('SELECT count(*)')).length, 0);
  }
});

test('inherited escalation, column write and PUBLIC grants remain explicit even in READ ONLY transaction', async () => {
  const { client } = fake({ changePrivileges(privileges) {
    privileges.roles.push({ ...privileges.roles[0], name: 'inherited_admin', login: false, superuser: true });
    privileges.columns[0].update = true;
    privileges.publicGrants.push({ kind: 'column', name: 'contacts', sub_name: 'email', privilege_type: 'UPDATE', is_grantable: false });
  } });
  const result = await observeStaging(client, { expectedCatalogs });
  assert.equal(result.status, 'unresolved');
  assert.ok(result.unresolved.includes('reader_elevated_role'));
  assert.ok(result.unresolved.includes('reader_has_write_privileges'));
  assert.ok(result.unresolved.includes('public_has_write_privileges'));
  assert.equal(result.scope.applicationPermissionPolicyVerified, false);
});

test('missing column privilege coverage and malformed privilege booleans cannot pass', async () => {
  const incomplete = fake({ changePrivileges(privileges) { privileges.columns.pop(); } });
  const receipt = await observeStaging(incomplete.client, { expectedCatalogs });
  assert.equal(receipt.status, 'unresolved');
  assert.ok(receipt.unresolved.includes('privilege_evidence_incomplete'));
  const malformed = fake({ changePrivileges(privileges) { privileges.tables[0].select = 'true'; } });
  const failure = await observeStaging(malformed.client, { expectedCatalogs });
  assert.equal(failure.errorCode, 'privilege_shape_invalid');
  assert.equal(failure.transaction.rollbackAcknowledged, true);
});

test('SET-only ordinary roles, reachable ownership and default grants stay unresolved without role mutation', async () => {
  const { client, calls } = fake({ changePrivileges(privileges) {
    privileges.roles.push({ ...privileges.roles[0], name: 'set_only_owner', login: false, usable: false, can_set: true });
    privileges.functions.push({ principal: principals[0], name: 'owned_function', arguments: '', owner: 'set_only_owner', volatility: 'v', security_definer: true, execute: true, return_type: 'event_trigger', returns_set: false, language: 'c', extension_name: 'pgaudit', extension_version: '16.0' });
    privileges.defaultGrants.push({ owner: 'fly-user', schema: 'public', object_type: 'r', grantee: principals[0], privilege_type: 'SELECT', is_grantable: false });
  } });
  const receipt = await observeStaging(client, { expectedCatalogs });
  assert.equal(receipt.status, 'unresolved');
  for (const finding of ['reader_set_role_paths_unassessed','reader_has_ownership_powers','default_grant_policy_unassessed','reader_security_definer_functions_unassessed']) assert.ok(receipt.unresolved.includes(finding));
  assert.equal(receipt.fingerprintSummary.complete, true);
  assert.equal(receipt.privileges.functions[0].return_type, 'event_trigger');
  assert.equal(receipt.privileges.functions[0].extension_name, 'pgaudit');
  assert.equal(calls.some((call) => /SET ROLE|GRANT|ALTER ROLE/.test(call.text)), false);
  assert.equal(receipt.transaction.rollbackAcknowledged, true);
});

test('row and byte bounds fail before aggregation instead of returning a prefix digest', async () => {
  for (const limits of [{ tableRows: 1 }, { tableBytes: 499 }, { totalRows: 1 }, { totalBytes: 499 }]) {
    const { client, calls } = fake();
    const result = await observeStaging(client, { expectedCatalogs, limits });
    assert.equal(result.status, 'failed');
    assert.equal(result.errorCode, 'fingerprint_bounds_exceeded');
    assert.equal(result.fingerprints.length, 0);
    assert.equal(calls.filter((call) => call.text.startsWith('SELECT count(*)::text AS row_count,md5')).length, 0);
    assert.equal(result.transaction.rollbackAcknowledged, true);
  }
});

test('fingerprint count disagreement and duplicate catalog keys fail closed', async () => {
  const mismatch = fake({ intercept(text) { if (text.startsWith('SELECT count(*)::text AS row_count,md5')) return { rows: [{ row_count: '1', digest: 'b'.repeat(32) }] }; } });
  assert.equal((await observeStaging(mismatch.client, { expectedCatalogs })).errorCode, 'fingerprint_shape_invalid');
  const duplicate = fake({ changeCatalog(catalog) { catalog.columns.push({ ...catalog.columns[0] }); } });
  const result = await observeStaging(duplicate.client, { expectedCatalogs });
  assert.equal(result.errorCode, 'catalog_duplicate_key');
  assert.equal(result.transaction.rollbackAcknowledged, true);
});

test('provider exceptions are reduced to fixed codes without message/detail/cause leakage', async () => {
  const marker = 'postgresql://secret-user:secret-password@private.example/customer-row';
  for (const [code, expected] of [['42501','database_permission_denied'], ['XX000','database_observation_failed']]) {
    const { client } = fake({ intercept(text) { if (text.startsWith('SELECT current_database()')) throw Object.assign(new Error(marker), { code, detail: marker, cause: marker }); } });
    const result = await observeStaging(client, { expectedCatalogs });
    assert.equal(result.errorCode, expected);
    assert.equal(JSON.stringify(result).includes(marker), false);
    assert.equal(result.transaction.rollbackAcknowledged, true);
  }
});

test('failed or timed-out BEGIN still attempts rollback and missing rollback acknowledgment fails', async () => {
  const brokenBegin = fake({ intercept(text) { if (text.startsWith('BEGIN')) throw new Error('private'); } });
  const beginReceipt = await observeStaging(brokenBegin.client, { expectedCatalogs });
  assert.equal(beginReceipt.status, 'failed');
  assert.equal(brokenBegin.calls.at(-1).text, 'ROLLBACK');
  assert.equal(beginReceipt.transaction.rollbackAcknowledged, true);
  const stalled = fake({ intercept(text) { if (text.startsWith('BEGIN') || text === 'ROLLBACK') return new Promise(() => {}); } });
  const timeoutReceipt = await observeStaging(stalled.client, { expectedCatalogs, limits: { queryMs: 5, cleanupMs: 5 } });
  assert.equal(timeoutReceipt.status, 'failed');
  assert.equal(timeoutReceipt.errorCode, 'query_deadline_exceeded');
  assert.equal(timeoutReceipt.transaction.rollbackAcknowledged, false);
  assert.ok(timeoutReceipt.unresolved.includes('rollback_not_acknowledged'));
  const noAck = fake({ intercept(text) { if (text === 'ROLLBACK') return { command: 'COMMIT', rows: [] }; } });
  const ackReceipt = await observeStaging(noAck.client, { expectedCatalogs });
  assert.equal(ackReceipt.errorCode, 'rollback_not_acknowledged');
});

test('invalid or expanded limits and incomplete fixtures issue no database command', async () => {
  for (const options of [{ expectedCatalogs: { '95': expectedCatalogs['95'] } }, { expectedCatalogs, limits: { operationMs: 999999999 } }, { expectedCatalogs, limits: { arbitrary: 1 } }]) {
    const { client, calls } = fake();
    const receipt = await observeStaging(client, options);
    assert.equal(receipt.status, 'failed');
    assert.equal(calls.length, 0);
  }
});
