/** Shared helpers for the V1 -> fresh V2 copy and compare tools.
 *
 * The schema route is the reviewed production75 path, reused unchanged:
 *   legacy 75 tables (rebuilt from the live source catalog, physically identical)
 *   -> 19 pinned SQL steps (selected 0000 bridge, 0001..0018)   = 142 tables
 *   -> pinned 0019 saved-scheduling columns                     = 142 tables / 1870 columns
 * SQL bytes are read from Git at their pinned commits and verified by the
 * existing builders (buildProduction75Source / buildScheduling0019Source).
 * No row values are ever logged or returned; only counts and sha256 digests. */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { collectSchemaCatalog, catalogDigest, catalogDifferences } from '../../reports/release-preparation-2026-10-09/schema-catalog.mjs';
import { PINNED_FILES, SOURCE_COMMIT } from '../production75-pins.mjs';
import { buildProduction75Source } from '../production75-source.mjs';
import { deriveProduction75Catalogs, ORIGINAL_DEFAULTS } from '../production75-core.mjs';
import { buildScheduling0019Source, assertScheduling0019Catalogs } from '../production75-scheduling0019.mjs';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const fail = (code, detail) => { throw Object.assign(new Error(code), { safeCode: code, detail }); };
export const check = (ok, code, detail) => { if (!ok) fail(code, detail); };
const sha = v => createHash('sha256').update(v).digest('hex');
export const q = v => { check(typeof v === 'string' && /^[a-z_][a-z0-9_]*$/.test(v), 'v2_identifier_invalid'); return `"${v}"`; };
const literal = v => `'${v.replaceAll("'", "''")}'`;

const SCHEDULING0019 = { commit: '91b7fd2c1fd98d441848e0357954e35c9f65d688',
  path: 'reports/staging-schema-preview-2026-10-01/0019_saved-scheduling-policy.sql' };
// Columns added to pre-existing tables by 0019 (all nullable, no default).
const ADDED_0019 = { appointments: ['scheduling_reservation'], org_settings: ['scheduling_policy'], projects: ['scheduling_reservation'] };

// Every session uses the same text output settings so values canonicalize
// identically on V1 and V2.
export const SESSION_SQL = `SET TimeZone='UTC'; SET DateStyle='ISO, YMD'; SET IntervalStyle='postgres';
  SET extra_float_digits=3; SET bytea_output='hex'; SET search_path=public,pg_catalog; SET row_security=off`;

/** pg Client with default type parsing (catalog queries rely on it); data reads use RAW_TEXT. */
const RAW_TEXT = { getTypeParser: () => value => value };
export async function connect(url, applicationName) {
  check(typeof url === 'string' && url.length > 0, 'v2_database_url_missing');
  const { Client } = createRequire(resolve(root, 'artifacts/api-server/package.json'))('pg');
  const client = new Client({ connectionString: url, application_name: applicationName,
    connectionTimeoutMillis: 15000,
    statement_timeout: 120000, query_timeout: 130000 });
  client.on('error', () => {});
  await client.connect();
  await client.query(SESSION_SQL);
  return client;
}

/** Source is read in one REPEATABLE READ, READ ONLY snapshot; writes are refused by the server. */
export async function beginSourceSnapshot(client) {
  await client.query('SET default_transaction_read_only = on');
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const ro = (await client.query("SELECT current_setting('transaction_read_only') AS v")).rows[0].v;
  check(ro === 'on', 'v2_source_not_read_only');
}

const git = args => execFileSync('git', args, { cwd: root, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
const json = path => JSON.parse(readFileSync(resolve(root, path), 'utf8'));

/** Reviewed SQL steps, exact bytes from Git, hash-checked by the existing builders. */
export function loadReviewedPlan() {
  const files = PINNED_FILES.map(pin => ({ ...pin, bytes: git(['show', `${SOURCE_COMMIT}:${pin.path}`]) }));
  const source = buildProduction75Source(files);
  const s0019 = buildScheduling0019Source({ sourceCommit: SCHEDULING0019.commit, path: SCHEDULING0019.path,
    bytes: git(['show', `${SCHEDULING0019.commit}:${SCHEDULING0019.path}`]) });
  return {
    steps: [...source.steps.map(s => ({ name: s.path, sha256: s.sha256, sql: s.sql })),
      { name: s0019.path, sha256: s0019.sha256, sql: s0019.sql }],
    canonical95: json('reports/staging-observation-2026-10-10/fixtures/catalog-95.json'),
    canonical142: json('reports/staging-observation-2026-10-10/fixtures/catalog-142.json'),
  };
}

/** Same construction as production75-local fixtureSql: enums, tables in ordinal
 * order, non-FK constraints, explicit indexes, and (optionally) FKs last. */
export function legacySchemaSql(catalog, { foreignKeys = true } = {}) {
  const sql = [];
  for (const type of catalog.enums) sql.push(`CREATE TYPE public.${q(type.name)} AS ENUM(${type.labels.map(literal).join(',')});`);
  for (const table of catalog.tables) {
    const columns = catalog.columns.filter(c => c.table_name === table.name).sort((a, b) => a.ordinal - b.ordinal);
    check(columns.every(c => c.identity === '' && c.generated === ''), 'v2_unsupported_identity_or_generated');
    sql.push(`CREATE TABLE public.${q(table.name)}(${columns.map(c => `${q(c.name)} ${c.formatted_type}${c.default_expression !== null ? ' DEFAULT ' + c.default_expression : ''}${c.nullable ? '' : ' NOT NULL'}`).join(',')});`);
  }
  for (const c of catalog.constraints.filter(c => c.kind !== 'f')) sql.push(`ALTER TABLE public.${q(c.table_name)} ADD CONSTRAINT ${q(c.name)} ${c.definition};`);
  const backed = new Set(catalog.constraints.filter(c => ['p', 'u', 'x'].includes(c.kind)).map(c => `${c.table_name}.${c.name}`));
  for (const ix of catalog.indexes.filter(i => !backed.has(`${i.table_name}.${i.name}`))) sql.push(`${ix.definition};`);
  if (foreignKeys) sql.push(...foreignKeySql(catalog));
  return sql.join('\n');
}
export const foreignKeySql = catalog => catalog.constraints.filter(c => c.kind === 'f')
  .map(c => `ALTER TABLE public.${q(c.table_name)} ADD CONSTRAINT ${q(c.name)} ${c.definition};`);

/** Validates the live source as one of the two reviewed physical legacy-75 layouts
 * and returns the expected post-0018 catalog for that exact layout. */
export function expectedCatalogs(source75, plan) {
  const { catalog142 } = deriveProduction75Catalogs(source75, plan.canonical95, plan.canonical142);
  return { catalog142, layout: catalogDigest(source75, { physical: true }) };
}
export function assertFinalCatalog(expected142, actual) {
  try { assertScheduling0019Catalogs({ before: expected142, after: actual }); }
  catch (e) { fail('v2_target_catalog_mismatch', catalogDifferences(actual, expected142).slice(0, 20)); }
}
export function assertCatalogEqual(actual, expected, code) {
  if (!isDeepStrictEqual(actual, expected)) fail(code, catalogDifferences(actual, expected, { physical: true }).slice(0, 20));
}

/** Columns of a table in ordinal order, from a collected catalog. */
export const tableColumns = (catalog, table) => catalog.columns.filter(c => c.table_name === table).sort((a, b) => a.ordinal - b.ordinal);
function orderBy(catalog, table) {
  const pk = catalog.constraints.find(c => c.table_name === table && c.kind === 'p');
  const cols = pk ? pk.columns : tableColumns(catalog, table).map(c => c.name);
  return cols.map(c => `${q(c)}::text COLLATE "C"`).join(',');
}

/** Rows as exact PostgreSQL text values (SQL NULL -> null, distinct from JSON 'null'), deterministic order. */
export async function readRows(client, catalog, table, columns = tableColumns(catalog, table).map(c => c.name)) {
  const result = await client.query({ text: `SELECT ${columns.map(q).join(',')} FROM public.${q(table)} ORDER BY ${orderBy(catalog, table)}`, rowMode: 'array', types: RAW_TEXT });
  return result.rows;
}

/** sha256 over table name, sorted column names, and every row's canonical text values. */
export async function fingerprintTable(client, catalog, table, columnNames) {
  const columns = [...columnNames].sort();
  const hash = createHash('sha256').update(JSON.stringify([table, columns]));
  const rows = await readRows(client, catalog, table, columns);
  for (const row of rows) hash.update('\n' + JSON.stringify(row));
  return { table, rows: rows.length, sha256: hash.digest('hex') };
}

const SEQUENCES_SQL = `SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND c.relkind='S' ORDER BY 1`;
export async function sequenceState(client) {
  const out = [];
  for (const { name } of (await client.query(SEQUENCES_SQL)).rows)
    out.push({ name, ...(await client.query(`SELECT last_value, is_called FROM public.${q(name)}`)).rows[0] });
  return out;
}

/** Source snapshot: catalog, layout validation, per-table fingerprints, sequences. */
export async function captureSource(client, plan) {
  const catalog = await collectSchemaCatalog(client);
  const { catalog142, layout } = expectedCatalogs(catalog, plan);
  const tables = [];
  for (const t of catalog.tables) tables.push(await fingerprintTable(client, catalog, t.name, tableColumns(catalog, t.name).map(c => c.name)));
  const db = (await client.query(`SELECT current_setting('server_version_num') AS version, pg_encoding_to_char(encoding) AS encoding,
    datcollate AS collate, datctype AS ctype FROM pg_database WHERE datname=current_database()`)).rows[0];
  return { catalog, catalog142, layout, tables, sequences: await sequenceState(client), database: db };
}

/** Target verification against a source snapshot. Returns a report; never throws on data mismatch. */
export async function verifyTarget(client, source) {
  const catalog = await collectSchemaCatalog(client);
  const problems = [];
  try { assertFinalCatalog(source.catalog142, catalog); } catch (e) { problems.push({ check: 'catalog', detail: e.detail }); }
  const original = new Set(source.catalog.tables.map(t => t.name));
  const tables = [];
  for (const s of source.tables) {
    const cols = tableColumns(source.catalog, s.table).map(c => c.name);
    const t = catalog.tables.some(x => x.name === s.table) ? await fingerprintTable(client, catalog, s.table, cols) : { rows: null, sha256: null };
    const match = t.rows === s.rows && t.sha256 === s.sha256;
    tables.push({ table: s.table, kind: 'preserved', sourceRows: s.rows, targetRows: t.rows, match });
    if (!match) problems.push({ check: 'table', table: s.table });
  }
  for (const t of catalog.tables.filter(t => !original.has(t.name))) {
    const rows = Number((await client.query(`SELECT count(*) AS n FROM public.${q(t.name)}`)).rows[0].n);
    tables.push({ table: t.name, kind: 'new-empty', sourceRows: null, targetRows: rows, match: rows === 0 });
    if (rows !== 0) problems.push({ check: 'new_table_not_empty', table: t.name });
  }
  // Columns added to pre-existing tables must hold their reviewed default for every row.
  const added = { ...structuredClone(ORIGINAL_DEFAULTS) };
  for (const [table, cols] of Object.entries(ADDED_0019)) for (const c of cols) (added[table] ??= {})[c] = null;
  let addedChecked = 0;
  for (const [table, fields] of Object.entries(added)) for (const [column, value] of Object.entries(fields)) {
    const n = (await client.query(`SELECT count(*) AS n FROM public.${q(table)} WHERE to_jsonb(${q(column)}) IS DISTINCT FROM $1::jsonb`,
      [value === null ? null : JSON.stringify(value)])).rows[0].n;
    addedChecked++;
    if (n !== '0') problems.push({ check: 'added_column_default', table, column });
  }
  const sequences = await sequenceState(client);
  if (!isDeepStrictEqual(sequences, source.sequences)) problems.push({ check: 'sequences' });
  const identity = catalog.columns.filter(c => c.identity !== '' || c.generated !== '').length;
  if (identity !== 0) problems.push({ check: 'identity_columns', count: identity });
  const invalid = (await client.query(`SELECT count(*) AS n FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace
    WHERE n.nspname='public' AND NOT c.convalidated`)).rows[0].n
    + '/' + (await client.query(`SELECT count(*) AS n FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND NOT (i.indisvalid AND i.indisready AND i.indislive)`)).rows[0].n;
  if (invalid !== '0/0') problems.push({ check: 'invalid_constraints_or_indexes', detail: invalid });
  const db = (await client.query(`SELECT current_setting('server_version_num') AS version, pg_encoding_to_char(encoding) AS encoding,
    datcollate AS collate, datctype AS ctype FROM pg_database WHERE datname=current_database()`)).rows[0];
  if (db.encoding !== source.database.encoding) problems.push({ check: 'encoding' });
  const warnings = (db.collate !== source.database.collate || db.ctype !== source.database.ctype) ? ['database_locale_differs'] : [];
  return {
    ok: problems.length === 0, problems, warnings,
    catalog: { tables: catalog.tables.length, columns: catalog.columns.length, constraints: catalog.constraints.length, indexes: catalog.indexes.length },
    tables, addedColumnsChecked: addedChecked, sequences: sequences.length,
    database: { source: source.database, target: db },
  };
}

export const isEmptyTargetSql = `SELECT
  (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname NOT IN ('pg_catalog','information_schema','pg_toast') AND n.nspname NOT LIKE 'pg_temp%' AND n.nspname NOT LIKE 'pg_toast_temp%'
    AND c.relkind IN ('r','p','v','m','S','f')
    AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid='pg_class'::regclass AND d.objid=c.oid AND d.deptype='e')) AS relations,
  (SELECT count(*) FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public' AND t.typtype IN ('e','c','d')
    AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid='pg_type'::regclass AND d.objid=t.oid AND d.deptype='e')
    AND NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.oid=t.typrelid)) AS types`;

export const safeError = e => ({ code: /^v2_[a-z0-9_]+$/.test(e?.safeCode ?? '') ? e.safeCode : (/^(production75|scheduling0019)_[a-z0-9_]+$/.test(e?.safeCode ?? '') ? e.safeCode : 'v2_unexpected_error'),
  ...(e?.detail ? { detail: e.detail } : {}), ...(e?.code && /^[0-9A-Z]{5}$/.test(e.code) ? { sqlstate: e.code } : {}) });
export { sha, catalogDigest };
