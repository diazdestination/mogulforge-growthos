/** Offline additive preview against the exact integrated CALLIE release. */
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tsImport } from 'tsx/esm/api';

const base = 'f91e1c31413a4b5307ca334c04773e3c0e5bef84';
const root = fileURLToPath(new URL('../', import.meta.url));
const schemaRoot = resolve(root, 'lib/db/src/schema');
const requireDb = createRequire(new URL('../lib/db/package.json', import.meta.url));
const { generateDrizzleJson, generateMigration } = requireDb('drizzle-kit/api');
const temporary = await mkdtemp(join(schemaRoot, '.standing-baseline-'));
if (dirname(temporary) !== schemaRoot || !basename(temporary).startsWith('.standing-baseline-'))
  throw new Error('standing_schema_temporary_path_invalid');
try {
  const files = execFileSync('git', ['ls-tree', '-r', '--name-only', base, 'lib/db/src/schema'], {
    cwd: root, encoding: 'utf8', windowsHide: true,
  }).trim().split(/\r?\n/);
  if (!files.length || files.some(file => !/^lib\/db\/src\/schema\/[a-z0-9-]+\.ts$/.test(file)))
    throw new Error('standing_schema_baseline_paths_invalid');
  for (const file of files) {
    const source = execFileSync('git', ['show', `${base}:${file}`], { cwd: root, encoding: 'utf8', windowsHide: true });
    await writeFile(join(temporary, basename(file)), source, { flag: 'wx' });
  }
  const before = generateDrizzleJson(await tsImport(pathToFileURL(join(temporary, 'index.ts')).href, import.meta.url));
  const after = generateDrizzleJson(await tsImport('../lib/db/src/schema/index.ts', import.meta.url));
  const statements = await generateMigration(before, after);
  if (!statements.length || statements.some(statement =>
    /^\s*(?:DROP|TRUNCATE|DELETE|UPDATE)\b/i.test(statement) || /^\s*ALTER\b[\s\S]*\bDROP\b/i.test(statement)))
    throw new Error('standing_schema_unreviewed_destructive_delta');
  const parentKey = statement => /^ALTER TABLE "[a-z_]+" ADD CONSTRAINT "[a-z_]+" UNIQUE/i.test(statement.trim());
  const ordered = [...statements.filter(parentKey), ...statements.filter(statement => !parentKey(statement))];
  const createdTables = Object.keys(after.tables).filter(name => !before.tables[name]).sort();
  const allowed = ['public.service_sms_parents', 'public.service_sms_replies', 'public.service_standing_enrollments', 'public.service_standing_policy_revisions'];
  if (JSON.stringify(createdTables) !== JSON.stringify(allowed) || Object.keys(after.tables).length !== 125)
    throw new Error('standing_schema_unreviewed_tables');
  await writeFile(new URL('../reports/staging-schema-preview-2026-10-01/0013_standing-service.sql', import.meta.url),
    `-- REVIEW ONLY. Standing service reminders after 0012 at ${base}. No hosted approval.\n${ordered.map(statement => statement.trim().replace(/;+$/, '')).join(';\n')};\n`);
  console.log(JSON.stringify({ generated: '0013_standing-service.sql', base, statements: statements.length,
    newTables: createdTables.length, expectedTables: Object.keys(after.tables).length, databaseOpened: false }));
} finally {
  // Only this newly created, resolved and validated temporary child is removed.
  await rm(temporary, { recursive: true, force: true });
}
