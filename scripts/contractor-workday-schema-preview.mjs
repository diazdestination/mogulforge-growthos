/** Offline additive review against accepted PR24; never opens a DB/provider. */
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tsImport } from 'tsx/esm/api';

const base = '3f1f1b54f8436303d66e53083f62155431e9adef';
const root = fileURLToPath(new URL('../', import.meta.url));
const schemaRoot = resolve(root, 'lib/db/src/schema');
const requireDb = createRequire(new URL('../lib/db/package.json', import.meta.url));
const { generateDrizzleJson, generateMigration } = requireDb('drizzle-kit/api');
const temporary = await mkdtemp(join(schemaRoot, '.contractor-workday-baseline-'));
if (dirname(temporary) !== schemaRoot || !basename(temporary).startsWith('.contractor-workday-baseline-'))
  throw new Error('workday_schema_temporary_path_invalid');
try {
  const files = execFileSync('git', ['ls-tree', '-r', '--name-only', base, 'lib/db/src/schema'], {
    cwd: root, encoding: 'utf8', windowsHide: true,
  }).trim().split(/\r?\n/);
  if (!files.length || files.some(file => !/^lib\/db\/src\/schema\/[a-z0-9-]+\.ts$/.test(file)))
    throw new Error('workday_schema_baseline_paths_invalid');
  for (const file of files) {
    const source = execFileSync('git', ['show', `${base}:${file}`], { cwd: root, encoding: 'utf8', windowsHide: true });
    await writeFile(join(temporary, basename(file)), source, { flag: 'wx' });
  }
  const before = generateDrizzleJson(await tsImport(pathToFileURL(join(temporary, 'index.ts')).href, import.meta.url));
  const after = generateDrizzleJson(await tsImport('../lib/db/src/schema/index.ts', import.meta.url));
  const statements = await generateMigration(before, after);
  if (!statements.length || statements.some(statement => /^(?:DROP|TRUNCATE|DELETE|UPDATE)\b/i.test(statement.trim()) || /^ALTER\b[\s\S]*\bDROP\b/i.test(statement.trim())))
    throw new Error('workday_schema_unreviewed_destructive_delta');
  const createdTables = Object.keys(after.tables).filter(name => !before.tables[name]).sort();
  const allowed = ['public.appointment_work_completions', 'public.appointment_work_entries', 'public.appointment_work_photos',
    'public.property_assets', 'public.work_checklist_revisions', 'public.work_checklist_templates'];
  if (JSON.stringify(createdTables) !== JSON.stringify(allowed) || Object.keys(before.tables).length !== 133 || Object.keys(after.tables).length !== 139)
    throw new Error('workday_schema_unreviewed_tables');
  const parentKey = statement => /^ALTER TABLE "stored_objects" ADD CONSTRAINT "stored_objects_org_id_uq" UNIQUE\("organization_id","id"\);?$/.test(statement.trim());
  const oldTableChanges = statements.filter(statement => /^ALTER TABLE\s/.test(statement.trim()) && !createdTables.some(table => statement.trim().startsWith(`ALTER TABLE "${table.slice(7)}"`)));
  if (oldTableChanges.length !== 1 || !parentKey(oldTableChanges[0]))
    throw new Error('workday_schema_unreviewed_old_table_change');
  const ordered = [...statements.filter(parentKey), ...statements.filter(statement => !parentKey(statement))];
  await writeFile(new URL('../reports/staging-schema-preview-2026-10-01/0016_contractor-workday.sql', import.meta.url),
    `-- REVIEW ONLY. Contractor workday after0015 at ${base}. No hosted approval.\n-- Six new tables and one stored-object tenant parent key; no historical backfill.\n${ordered.map(statement => statement.trim().replace(/;+$/, '')).join(';\n')};\n`);
  console.log(JSON.stringify({ generated: '0016_contractor-workday.sql', base, statements: statements.length,
    newTables: createdTables.length, expectedTables: 139, databaseOpened: false, destructiveChanges: false }));
} finally {
  // Remove only this exact newly created, resolved temporary child.
  await rm(temporary, { recursive: true, force: true });
}
