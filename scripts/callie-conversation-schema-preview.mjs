/** Offline review against accepted PR23. Never opens a database or provider. */
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tsImport } from 'tsx/esm/api';

const base = 'afcb72a810a55ea32c42adb2f342477bb0e7299f';
const root = fileURLToPath(new URL('../', import.meta.url));
const schemaRoot = resolve(root, 'lib/db/src/schema');
const requireDb = createRequire(new URL('../lib/db/package.json', import.meta.url));
const { generateDrizzleJson, generateMigration } = requireDb('drizzle-kit/api');
const temporary = await mkdtemp(join(schemaRoot, '.callie-conversation-baseline-'));
if (dirname(temporary) !== schemaRoot || !basename(temporary).startsWith('.callie-conversation-baseline-'))
  throw new Error('callie_conversation_schema_temporary_path_invalid');
try {
  const files = execFileSync('git', ['ls-tree', '-r', '--name-only', base, 'lib/db/src/schema'], {
    cwd: root, encoding: 'utf8', windowsHide: true,
  }).trim().split(/\r?\n/);
  if (!files.length || files.some(file => !/^lib\/db\/src\/schema\/[a-z0-9-]+\.ts$/.test(file)))
    throw new Error('callie_conversation_schema_baseline_paths_invalid');
  for (const file of files) {
    const source = execFileSync('git', ['show', `${base}:${file}`], { cwd: root, encoding: 'utf8', windowsHide: true });
    await writeFile(join(temporary, basename(file)), source, { flag: 'wx' });
  }
  const before = generateDrizzleJson(await tsImport(pathToFileURL(join(temporary, 'index.ts')).href, import.meta.url));
  const after = generateDrizzleJson(await tsImport('../lib/db/src/schema/index.ts', import.meta.url));
  const statements = await generateMigration(before, after);
  const stateDrop = /^ALTER TABLE "callie_intakes" DROP CONSTRAINT "callie_intake_state_ck";?$/;
  const drops = statements.filter(statement => stateDrop.test(statement.trim()));
  const stateChecks = statements.filter(statement => /^ALTER TABLE "callie_intakes" ADD CONSTRAINT "callie_intake_state_ck" CHECK\s*\(/.test(statement.trim()));
  if (drops.length !== 1 || stateChecks.length !== 1)
    throw new Error('callie_conversation_state_check_pair_invalid');
  // This sole replacement extends the finite state list for office_pending.
  // Every old state/stage literal remains; root must also review the generated
  // condition and all tenant keys before source release selection.
  const originalCheck = before.tables['public.callie_intakes'].checkConstraints.callie_intake_state_ck.value;
  const originalLiterals = [...originalCheck.matchAll(/'([^']+)'/g)].map(match => match[1]);
  if (originalLiterals.some(value => !stateChecks[0].includes(`'${value}'`)) || !stateChecks[0].includes("'office_pending'"))
    throw new Error('callie_conversation_legacy_states_removed');
  if (!statements.length || statements.some(statement => {
    const value = statement.trim();
    if (stateDrop.test(value)) return false;
    return /^(?:DROP|TRUNCATE|DELETE|UPDATE)\b/i.test(value) || /^ALTER\b[\s\S]*\bDROP\b/i.test(value);
  })) throw new Error('callie_conversation_schema_unreviewed_destructive_delta');
  const createdTables = Object.keys(after.tables).filter(name => !before.tables[name]).sort();
  const allowed = ['public.callie_reception_bindings', 'public.callie_reception_events', 'public.callie_reception_sessions'];
  if (JSON.stringify(createdTables) !== JSON.stringify(allowed) || Object.keys(before.tables).length !== 130 || Object.keys(after.tables).length !== 133)
    throw new Error('callie_conversation_schema_unreviewed_tables');
  const parentKey = statement => /^ALTER TABLE "[a-z_]+" ADD CONSTRAINT "[a-z_]+" UNIQUE/i.test(statement.trim());
  // The new composite parent key includes the new mode column. Add reviewed
  // old-table columns before lifting parent keys ahead of child foreign keys.
  const parentColumn = statement => /^ALTER TABLE "callie_intakes" ADD COLUMN "mode"\s/.test(statement.trim());
  const modeColumns = statements.filter(parentColumn);
  if (modeColumns.length !== 1 || !/^ALTER TABLE "callie_intakes" ADD COLUMN "mode" text DEFAULT 'keypad' NOT NULL;?$/.test(modeColumns[0].trim()))
    throw new Error('callie_conversation_mode_default_invalid');
  const ordered = [
    ...statements.filter(parentColumn),
    ...statements.filter(parentKey),
    ...statements.filter(statement => !parentColumn(statement) && !parentKey(statement)),
  ];
  await writeFile(new URL('../reports/staging-schema-preview-2026-10-01/0015_callie-conversation.sql', import.meta.url),
    `-- REVIEW ONLY. CALLIE conversation after0014 at ${base}. No hosted approval.\n-- Only the finite callie_intake_state_ck is replaced; all legacy states remain.\n${ordered.map(statement => statement.trim().replace(/;+$/, '')).join(';\n')};\n`);
  console.log(JSON.stringify({ generated: '0015_callie-conversation.sql', base,
    statements: statements.length, newTables: createdTables.length, expectedTables: 133,
    reviewedCheckReplacements: ['callie_intake_state_ck'], databaseOpened: false }));
} finally {
  // Only this exact newly created, resolved temporary child is removed.
  await rm(temporary, { recursive: true, force: true });
}
