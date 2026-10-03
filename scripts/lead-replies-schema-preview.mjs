/** Offline review-only delta from the exact green launch-communications release. */
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tsImport } from 'tsx/esm/api';

const base = 'c2d999b0c32e349e3f70cf6c642782d1c603b582';
const root = fileURLToPath(new URL('../', import.meta.url));
const schemaRoot = resolve(root, 'lib/db/src/schema');
const requireDb = createRequire(new URL('../lib/db/package.json', import.meta.url));
const { generateDrizzleJson, generateMigration } = requireDb('drizzle-kit/api');
const temporary = await mkdtemp(join(schemaRoot, '.lead-replies-baseline-'));
if (dirname(temporary) !== schemaRoot || !basename(temporary).startsWith('.lead-replies-baseline-'))
  throw new Error('lead_replies_schema_temporary_path_invalid');
try {
  const files = execFileSync('git', ['ls-tree', '-r', '--name-only', base, 'lib/db/src/schema'], {
    cwd: root, encoding: 'utf8', windowsHide: true,
  }).trim().split(/\r?\n/);
  if (!files.length || files.some(file => !/^lib\/db\/src\/schema\/[a-z0-9-]+\.ts$/.test(file)))
    throw new Error('lead_replies_schema_baseline_paths_invalid');
  for (const file of files) {
    const source = execFileSync('git', ['show', `${base}:${file}`], {
      cwd: root, encoding: 'utf8', windowsHide: true,
    });
    await writeFile(join(temporary, basename(file)), source, { flag: 'wx' });
  }
  const before = generateDrizzleJson(await tsImport(pathToFileURL(join(temporary, 'index.ts')).href, import.meta.url));
  const after = generateDrizzleJson(await tsImport('../lib/db/src/schema/index.ts', import.meta.url));
  const statements = await generateMigration(before, after);
  // This one relaxation represents typed mailbox provenance instead of a fake
  // legacy intake source. A new XOR CHECK and exact-parent composite FK govern
  // the new rows. No other DROP (including a constraint) is implicitly approved.
  const reviewedNullableSource = statement =>
    /^ALTER TABLE "email_response_reviews" ALTER COLUMN "source_id" DROP NOT NULL;?$/.test(statement.trim());
  if (!statements.length || statements.some(statement =>
    /^\s*(?:DROP|TRUNCATE|DELETE|UPDATE)\b/i.test(statement) ||
    (/^\s*ALTER\b[\s\S]*\bDROP\b/i.test(statement) && !reviewedNullableSource(statement))))
    throw new Error('lead_replies_schema_unreviewed_destructive_delta');
  const parentKey = statement => /^ALTER TABLE "[a-z_]+" ADD CONSTRAINT "[a-z_]+" UNIQUE/i.test(statement.trim());
  const ordered = [...statements.filter(parentKey), ...statements.filter(statement => !parentKey(statement))];
  const createdTables = Object.keys(after.tables).filter(name => !before.tables[name]);
  await writeFile(new URL('../reports/staging-schema-preview-2026-10-01/0010_lead-replies.sql', import.meta.url),
    `-- REVIEW ONLY. Lead replies after 0009 at ${base}. No hosted approval.\n${ordered.map(statement => statement.trim().replace(/;+$/, '')).join(';\n')};\n`);
  console.log(JSON.stringify({ generated: '0010_lead-replies.sql', base,
    statements: statements.length, newTables: createdTables.length,
    expectedTables: Object.keys(after.tables).length, nullableSourceReviewed: true, databaseOpened: false }));
} finally {
  // Only the newly created and validated temporary child, never a workspace root.
  await rm(temporary, { recursive: true, force: true });
}
