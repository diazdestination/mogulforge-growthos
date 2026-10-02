/** Offline review-only delta from green customer-care main. Never opens a DB. */
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { writeFile, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { tsImport } from 'tsx/esm/api';

const base = '602131d1b0311ea5933633fedc2c25b5af218238';
const requireDb = createRequire(new URL('../lib/db/package.json', import.meta.url));
const { generateDrizzleJson, generateMigration } = requireDb('drizzle-kit/api');
const schema = await tsImport('../lib/db/src/schema/index.ts', import.meta.url);
const added = ['serviceWatchCasesTable', 'sourceAdoptionsTable', 'sourceOutreachBatchesTable', 'sourceOutreachItemsTable', 'financialMigrationReviewsTable', 'financialMigrationItemsTable'];
if (added.some(name => !schema[name])) throw new Error('operations_wave_schema_missing');
const created = [];
try {
  const before = Object.fromEntries(Object.entries(schema).filter(([name]) => !added.includes(name)));
  for (const [file, exports] of [
    ['contacts', ['contactsTable']], ['leads', ['leadsTable']], ['service-obligations', ['serviceObligationsTable']],
    ['staff-push', ['staffPushPoliciesTable', 'staffPushSubscriptionsTable', 'staffPushDeliveriesTable']],
    ['revenue-workspace', ['valueEntriesTable']], ['invoices', ['invoicesTable']],
  ]) {
    const url = new URL(`../lib/db/src/schema/.operations-wave-${file}-baseline.ts`, import.meta.url);
    const source = execFileSync('git', ['show', `${base}:lib/db/src/schema/${file}.ts`], {
      cwd: fileURLToPath(new URL('../', import.meta.url)), encoding: 'utf8', windowsHide: true,
    });
    await writeFile(url, source, { flag: 'wx' }); created.push(url);
    const historical = await tsImport(url.href, import.meta.url);
    for (const exported of exports) before[exported] = historical[exported];
  }
  const statements = await generateMigration(generateDrizzleJson(before), generateDrizzleJson(schema));
  const typedTargetChange = sql => /^ALTER TABLE "staff_push_deliveries" ALTER COLUMN "lead_id" DROP NOT NULL;?$/.test(sql.trim());
  if (!statements.length || statements.some(sql => /^\s*(?:DROP|TRUNCATE|DELETE|UPDATE)\b/i.test(sql) ||
      (/^\s*ALTER\b[\s\S]*\bDROP\b/i.test(sql) && !typedTargetChange(sql)))) throw new Error('operations_wave_unreviewed_schema_change');
  if (statements.filter(typedTargetChange).length !== 1) throw new Error('operations_wave_typed_push_change_missing');
  // Existing rows stay valid lead targets; an XOR check below requires either a
  // lead or the complete typed service target, never a targetless notification.
  const parentKey = sql => /^ALTER TABLE "(?:contacts|leads|service_obligations|staff_push_subscriptions|value_entries|invoices)" ADD CONSTRAINT "[^"\n]+" UNIQUE/i.test(sql.trim());
  const keys = statements.filter(parentKey);
  if (keys.length !== 6) throw new Error('operations_wave_parent_keys_unreviewed');
  const ordered = [...keys, ...statements.filter(sql => !parentKey(sql))];
  await writeFile(new URL('../reports/staging-schema-preview-2026-10-01/0008_operations-wave.sql', import.meta.url),
    `-- REVIEW ONLY. Operations wave after 0007 at ${base}. Not hosted schema approval.\n-- The only relaxed column is staff_push_deliveries.lead_id, guarded by staff_push_target_valid.\n${ordered.map(sql => sql.trim().replace(/;+$/, '')).join(';\n')};\n`);
  console.log(JSON.stringify({ generated: '0008_operations-wave.sql', base, statements: statements.length, newTables: added.length, databaseOpened: false }));
} finally {
  for (const url of created.reverse()) await unlink(url);
}
