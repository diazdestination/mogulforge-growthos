/** Offline review-only delta from the exact green operations release. No DB URL. */
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tsImport } from 'tsx/esm/api';

const base = 'c01bea06d5175b1d450462653aca5ed0c6246c60';
const root = fileURLToPath(new URL('../', import.meta.url));
const schemaRoot = resolve(root, 'lib/db/src/schema');
const requireDb = createRequire(new URL('../lib/db/package.json', import.meta.url));
const { generateDrizzleJson, generateMigration } = requireDb('drizzle-kit/api');
const temporary = await mkdtemp(join(schemaRoot, '.launch-baseline-'));
if (dirname(temporary) !== schemaRoot || !basename(temporary).startsWith('.launch-baseline-'))
  throw new Error('launch_schema_temporary_path_invalid');
try {
  const files = execFileSync('git', ['ls-tree', '-r', '--name-only', base, 'lib/db/src/schema'], {
    cwd: root, encoding: 'utf8', windowsHide: true,
  }).trim().split(/\r?\n/);
  if (!files.length || files.some(file => !/^lib\/db\/src\/schema\/[a-z0-9-]+\.ts$/.test(file)))
    throw new Error('launch_schema_baseline_paths_invalid');
  for (const file of files) {
    const source = execFileSync('git', ['show', `${base}:${file}`], {
      cwd: root, encoding: 'utf8', windowsHide: true,
    });
    await writeFile(join(temporary, basename(file)), source, { flag: 'wx' });
  }
  const before = generateDrizzleJson(await tsImport(pathToFileURL(join(temporary, 'index.ts')).href, import.meta.url));
  const after = generateDrizzleJson(await tsImport('../lib/db/src/schema/index.ts', import.meta.url));
  const statements = await generateMigration(before, after);
  if (!statements.length || statements.some(statement =>
    /^\s*(?:DROP|TRUNCATE|DELETE|UPDATE)\b/i.test(statement) ||
    /^\s*ALTER\b[\s\S]*\bDROP\b/i.test(statement)))
    throw new Error('launch_schema_unreviewed_destructive_delta');
  // PostgreSQL requires an existing UNIQUE constraint before a dependent
  // composite FK; order all added parent keys before the new FK statements.
  const parentKey = statement => /^ALTER TABLE "[a-z_]+" ADD CONSTRAINT "[a-z_]+" UNIQUE/i.test(statement.trim());
  const ordered = [...statements.filter(parentKey), ...statements.filter(statement => !parentKey(statement))];
  const createdTables = Object.keys(after.tables).filter(name => !before.tables[name]);
  await writeFile(new URL('../reports/staging-schema-preview-2026-10-01/0009_launch-communications.sql', import.meta.url),
    `-- REVIEW ONLY. Launch communications after 0008 at ${base}. No hosted approval.\n${ordered.map(statement => statement.trim().replace(/;+$/, '')).join(';\n')};\n`);
  console.log(JSON.stringify({ generated: '0009_launch-communications.sql', base,
    statements: statements.length, newTables: createdTables.length,
    expectedTables: Object.keys(after.tables).length, databaseOpened: false }));
} finally {
  // This path is the newly created, verified child above, never a workspace root.
  await rm(temporary, { recursive: true, force: true });
}
