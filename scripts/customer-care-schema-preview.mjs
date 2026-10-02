/** Offline additive customer-care delta. Never opens a database. */
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { writeFile, unlink } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { tsImport } from "tsx/esm/api";

const base = "ae6b6e4f5a1d4203f40a8b494a6990518cf8b188";
const requireDb = createRequire(new URL("../lib/db/package.json", import.meta.url));
const { generateDrizzleJson, generateMigration } = requireDb("drizzle-kit/api");
const schema = await tsImport("../lib/db/src/schema/index.ts", import.meta.url);
const added = ["missedCallCarePoliciesTable", "missedCallCareCasesTable"];
if (added.some((name) => !schema[name])) throw new Error("customer_care_schema_missing");
const created = [];
try {
  const before = Object.fromEntries(Object.entries(schema).filter(([name]) => !added.includes(name)));
  for (const [file, exported] of [["auth", "usersTable"], ["twilio", "twilioCallsTable"]]) {
    const url = new URL(`../lib/db/src/schema/.customer-care-${file}-baseline.ts`, import.meta.url);
    const source = execFileSync("git", ["show", `${base}:lib/db/src/schema/${file}.ts`], {
      cwd: fileURLToPath(new URL("../", import.meta.url)), encoding: "utf8", windowsHide: true,
    });
    await writeFile(url, source, { flag: "wx" });
    created.push(url);
    const historical = await tsImport(url.href, import.meta.url);
    before[exported] = historical[exported];
  }
  const statements = await generateMigration(generateDrizzleJson(before), generateDrizzleJson(schema));
  if (!statements.length || statements.some((sql) =>
    /^\s*(?:DROP|TRUNCATE|DELETE|UPDATE)\b/i.test(sql) || /^\s*ALTER\b[\s\S]*\bDROP\b/i.test(sql)))
    throw new Error("customer_care_schema_not_additive");
  // Drizzle emits new-table FKs before unique constraints on existing parents.
  // PostgreSQL needs those parent keys first; ordering changes no statement.
  const parentKey = (sql) => /^ALTER TABLE "(?:users|twilio_calls)" ADD CONSTRAINT "(?:users|twilio_calls)_org_id_uq" UNIQUE/i.test(sql.trim());
  const keys = statements.filter(parentKey);
  if (keys.length !== 2) throw new Error("customer_care_parent_keys_unreviewed");
  const ordered = [...keys, ...statements.filter((sql) => !parentKey(sql))];
  await writeFile(new URL("../reports/staging-schema-preview-2026-10-01/0007_customer-care.sql", import.meta.url),
    `-- REVIEW ONLY. Additive customer care after 0006 at ${base}. Not hosted schema approval.\n${ordered.map((sql) => sql.trim().replace(/;+$/, "")).join(";\n")};\n`);
  console.log(JSON.stringify({ generated: "0007_customer-care.sql", base, statements: statements.length, databaseOpened: false }));
} finally {
  for (const url of created.reverse()) await unlink(url);
}
