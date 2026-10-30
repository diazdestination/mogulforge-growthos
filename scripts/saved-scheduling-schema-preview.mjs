/** Offline review of the approved additive delta. No environment or database access. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tsImport } from 'tsx/esm/api';

const base = '5e4933bb21fd8b14fa37b0d844675975164ef68b';
const root = fileURLToPath(new URL('../', import.meta.url));
const schemaRoot = resolve(root, 'lib/db/src/schema');
const migrationUrl = new URL('../reports/staging-schema-preview-2026-10-01/0019_saved-scheduling-policy.sql', import.meta.url);
const requireDb = createRequire(new URL('../lib/db/package.json', import.meta.url));
const { generateDrizzleJson, generateMigration } = requireDb('drizzle-kit/api');
const additions = [
  ['org_settings', 'scheduling_policy', 'org_settings_scheduling_policy_ck'],
  ['appointments', 'scheduling_reservation', 'appointments_scheduling_reservation_ck'],
  ['projects', 'scheduling_reservation', 'projects_scheduling_reservation_ck'],
];
const SUCCESSOR_0020_TABLES = ['public.price_book_items', 'public.zapier_action_executions', 'public.zapier_capability_bindings', 'public.zapier_mcp_connections', 'public.zapier_specialist_policies'];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function guard(value, code) { if (!value) throw new Error(`scheduling_${code}`); }

export function verifySchedulingDelta(before, after) {
  const identities = Object.keys(before.tables).sort();
  guard(identities.length === 142 && Object.keys(after.tables).length === 142, 'table_count_changed');
  try { assert.deepEqual(Object.keys(after.tables).sort(), identities); }
  catch { throw new Error('scheduling_table_identity_changed'); }
  const retained = structuredClone(after);
  for (const [tableName, columnName, checkName] of additions) {
    const table = retained.tables[`public.${tableName}`];
    guard(table && !before.tables[`public.${tableName}`].columns[columnName] && !before.tables[`public.${tableName}`].checkConstraints[checkName], 'baseline_addition_already_present');
    const column = table.columns[columnName];
    guard(column?.name === columnName && column.type === 'jsonb' && column.notNull === false && column.primaryKey === false, 'column_shape_changed');
    guard(Object.entries(column).filter(([, value]) => value !== undefined).map(([key]) => key).sort().join(',') === 'name,notNull,primaryKey,type', 'column_default_or_extra_changed');
    guard(table.checkConstraints[checkName]?.name === checkName && typeof table.checkConstraints[checkName].value === 'string', 'check_missing');
    delete table.columns[columnName]; delete table.checkConstraints[checkName];
  }
  for (const identity of identities) {
    try { assert.deepEqual(retained.tables[identity], before.tables[identity]); }
    catch { throw new Error(`scheduling_prior_definition_changed:${identity}`); }
  }
  return { previousTables: 142, expectedTables: 142, priorDefinitionsUnchanged: true,
    addedColumns: additions.map(([table, column]) => `${table}.${column}`).sort(),
    addedChecks: additions.map(([, , check]) => check).sort() };
}

function migrationBody(statements) { return `${statements.map(statement => statement.trim().replace(/;+$/, '')).join(';\n')};\n`; }
export function verifyMigrationSql(candidate, generated) {
  const actual = candidate.replace(/\r\n/g, '\n').replace(/^--[^\n]*\n?/gm, '').trim();
  guard(actual === migrationBody(generated).trim(), 'migration_differs_from_source_delta');
  guard(generated.every(statement => /^ALTER TABLE "(?:org_settings|appointments|projects)" ADD (?:COLUMN|CONSTRAINT) /.test(statement.trim())), 'migration_not_additive');
}

export function verifySqlPin(pin, workingCopy, gitBlob) {
  guard(gitBlob.length === pin.gitBlobBytes && sha(gitBlob) === pin.gitBlobSha256, `git_sql_bytes_changed:${pin.path}`);
  // Git may check these text files out as LF or CRLF. Compare exact buffers for
  // the two representations; do not trim, normalize whitespace or accept mixed EOLs.
  const crlf = Buffer.from(gitBlob.toString('utf8').replace(/(?<!\r)\n/g, '\r\n'));
  guard(workingCopy.equals(gitBlob) || workingCopy.equals(crlf), `working_sql_bytes_changed:${pin.path}`);
}

export async function readVerifiedSchedulingPredecessors() {
  const available = spawnSync('git', ['cat-file', '-e', `${base}^{commit}`], { cwd: root, windowsHide: true, stdio: 'pipe' });
  guard(available.status === 0, 'baseline_git_object_missing:use_a_full_history_checkout');
  const pins = JSON.parse(await readFile(new URL('../reports/staging-schema-preview-2026-10-01/saved-scheduling-predecessor-pins.json', import.meta.url), 'utf8'));
  guard(pins.base === base && pins.files.length === 23 && new Set(pins.files.map(pin => pin.path)).size === 23, 'pin_inventory_invalid');
  const canonical = new Map();
  for (const pin of pins.files) {
    guard(/^(?:reports\/[a-z0-9-]+\/|scripts\/)[a-zA-Z0-9_-]+\.sql$/.test(pin.path), 'pin_path_invalid');
    guard(Object.keys(pin).sort().join(',') === 'gitBlobBytes,gitBlobSha256,path' && Number.isSafeInteger(pin.gitBlobBytes) && pin.gitBlobBytes > 0 && /^[a-f0-9]{64}$/.test(pin.gitBlobSha256), 'pin_shape_invalid');
    const bytes = execFileSync('git', ['show', `${base}:${pin.path}`], { cwd: root, windowsHide: true });
    const working = await readFile(resolve(root, pin.path));
    verifySqlPin(pin, working, bytes);
    verifySqlPin(pin, working, execFileSync('git', ['show', `HEAD:${pin.path}`], { cwd: root, windowsHide: true }));
    canonical.set(pin.path, bytes);
  }
  const predecessors = pins.files.filter(pin => /^reports\/staging-schema-preview-2026-(?:09-30|10-01)\/\d{4}_/.test(pin.path));
  guard(predecessors.length === 19 && predecessors.every((pin, index) => basename(pin.path).startsWith(`${String(index).padStart(4, '0')}_`)), 'predecessor_order_invalid');
  return { pins, predecessors, buffers: predecessors.map(pin => canonical.get(pin.path)) };
}

export async function runSchedulingSchemaPreview({ writeMigration = false } = {}) {
  const { pins, predecessors } = await readVerifiedSchedulingPredecessors();
  const temporary = await mkdtemp(join(schemaRoot, '.saved-scheduling-baseline-'));
  guard(dirname(temporary) === schemaRoot && basename(temporary).startsWith('.saved-scheduling-baseline-'), 'temporary_path_invalid');
  try {
    const files = execFileSync('git', ['ls-tree', '-r', '--name-only', base, 'lib/db/src/schema'], { cwd: root, encoding: 'utf8', windowsHide: true }).trim().split(/\r?\n/);
    guard(files.length > 0 && files.every(file => /^lib\/db\/src\/schema\/[a-z0-9-]+\.ts$/.test(file)), 'baseline_paths_invalid');
    for (const file of files) await writeFile(join(temporary, basename(file)), execFileSync('git', ['show', `${base}:${file}`], { cwd: root, windowsHide: true }), { flag: 'wx' });
    const before = generateDrizzleJson(await tsImport(pathToFileURL(join(temporary, 'index.ts')).href, import.meta.url));
    const after = generateDrizzleJson(await tsImport('../lib/db/src/schema/index.ts', import.meta.url));
    // Owner-approved PR73 (reviewed preview 0020) adds exactly four tables after 0019. They are
    // verified by the recovery drill; here they are set aside so the 0019 delta stays exact.
    const successorTables = Object.keys(after.tables).filter(identity => !before.tables[identity]).sort();
    guard(successorTables.join(',') === SUCCESSOR_0020_TABLES.join(','), 'successor_tables_changed');
    for (const identity of SUCCESSOR_0020_TABLES) delete after.tables[identity];
    const delta = verifySchedulingDelta(before, after);
    const statements = await generateMigration(before, after);
    guard(statements.length === 6, 'migration_statement_count');
    const generatedSql = migrationBody(statements);
    if (writeMigration) await writeFile(migrationUrl,
      `-- REVIEW ONLY. After 0018; baseline ${base}. No hosted/schema approval.\n` +
      '-- Three nullable JSONB columns and bounded envelope CHECKs only. No default/backfill.\n' + generatedSql, { flag: 'wx' });
    const migrationBytes = await readFile(migrationUrl);
    verifyMigrationSql(migrationBytes.toString('utf8'), statements);
    return { base, ...delta, successorTables: successorTables.length, statements: statements.length, predecessorFiles: pins.files.length, canonicalPredecessors: predecessors.length,
      pinnedFiles: pins.files, predecessors, migrationSha256: sha(migrationBytes), databaseOpened: false };
  } finally {
    // Remove only this call's validated fresh schema child.
    guard(dirname(temporary) === schemaRoot && basename(temporary).startsWith('.saved-scheduling-baseline-'), 'cleanup_path_invalid');
    await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  guard(process.argv.length <= 3 && (!process.argv[2] || process.argv[2] === '--write'), 'unsupported_argument');
  runSchedulingSchemaPreview({ writeMigration: process.argv[2] === '--write' })
    .then(report => console.log(JSON.stringify(report)))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
