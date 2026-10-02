/** Generate only the two additive contractor-operation tables. Never opens a database. */
import { createRequire } from 'node:module';
import { writeFile } from 'node:fs/promises';
import { tsImport } from 'tsx/esm/api';

const requireDb = createRequire(new URL('../lib/db/package.json', import.meta.url));
const { generateDrizzleJson, generateMigration } = requireDb('drizzle-kit/api');
const schema = await tsImport('../lib/db/src/schema/index.ts', import.meta.url);
const added = ['staffInvitationsTable', 'emailResponseReviewsTable'];
if (added.some((name) => !schema[name])) throw new Error('contractor_schema_missing');
const before = Object.fromEntries(Object.entries(schema).filter(([name]) => !added.includes(name)));
const statements = await generateMigration(generateDrizzleJson(before), generateDrizzleJson(schema));
if (statements.some((sql) => /^\s*(?:DROP|TRUNCATE|DELETE|UPDATE)\b/i.test(sql) || /^\s*ALTER\b[\s\S]*\bDROP\b/i.test(sql))) throw new Error('contractor_schema_not_additive');
await writeFile(new URL('../reports/staging-schema-preview-2026-10-01/0005_contractor-operations.sql', import.meta.url),
  '-- REVIEW ONLY. Additive contractor operations delta after 0004. Not production approval.\n' + statements.join(';\n') + ';\n');
console.log(JSON.stringify({ generated: '0005_contractor-operations.sql', statements: statements.length, databaseOpened: false }));
