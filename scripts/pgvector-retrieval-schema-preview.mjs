/** Offline additive review against 87adc3e. Never reads env or accepts a database URL. */
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tsImport } from "tsx/esm/api";

const base = "87adc3eb21599e84aedcf3a9719b9e996f84f8e0";
const root = fileURLToPath(new URL("../", import.meta.url));
const schemaRoot = resolve(root, "lib/db/src/schema");
const requireDb = createRequire(new URL("../lib/db/package.json", import.meta.url));
const { generateDrizzleJson, generateMigration } = requireDb("drizzle-kit/api");
const expectedNew = ["public.customer_memories", "public.retrieval_chunks"];
const resolvedBase = execFileSync("git", ["rev-parse", `${base.slice(0, 7)}^{commit}`], { cwd: root, encoding: "utf8", windowsHide: true }).trim();
if (resolvedBase !== base) throw new Error("pgvector_retrieval_baseline_mismatch");
const temporary = await mkdtemp(join(schemaRoot, ".pgvector-retrieval-baseline-"));
if (dirname(temporary) !== schemaRoot || !basename(temporary).startsWith(".pgvector-retrieval-baseline-"))
  throw new Error("pgvector_retrieval_temporary_path_invalid");
try {
  const files = execFileSync("git", ["ls-tree", "-r", "--name-only", base, "lib/db/src/schema"], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
  })
    .trim()
    .split(/\r?\n/);
  if (!files.length || files.some((file) => !/^lib\/db\/src\/schema\/[a-z0-9-]+\.ts$/.test(file)))
    throw new Error("pgvector_retrieval_baseline_paths_invalid");
  for (const file of files) {
    await writeFile(
      join(temporary, basename(file)),
      execFileSync("git", ["show", `${base}:${file}`], { cwd: root, encoding: "utf8", windowsHide: true }),
      { flag: "wx" },
    );
  }
  const before = generateDrizzleJson(await tsImport(pathToFileURL(join(temporary, "index.ts")).href, import.meta.url));
  const after = generateDrizzleJson(await tsImport("../lib/db/src/schema/index.ts", import.meta.url));
  const created = Object.keys(after.tables).filter((name) => !before.tables[name]).sort();
  if (
    Object.keys(before.tables).length !== 142 ||
    Object.keys(after.tables).length !== 144 ||
    JSON.stringify(created) !== JSON.stringify(expectedNew)
  )
    throw new Error("pgvector_retrieval_unreviewed_tables");
  for (const [name, table] of Object.entries(before.tables)) {
    if (JSON.stringify(table) !== JSON.stringify(after.tables[name]))
      throw new Error(`pgvector_retrieval_existing_table_changed:${name}`);
  }
  const statements = await generateMigration(before, after);
  if (
    !statements.length ||
    statements.some(
      (statement) =>
        !/^(?:CREATE TABLE|ALTER TABLE|CREATE INDEX) (?:IF NOT EXISTS )?"(?:retrieval_chunks|customer_memories|retrieval_chunks_[a-z_]+|customer_memories_[a-z_]+)"(?:\s|$)/.test(
          statement.trim(),
        ) || /\b(?:DROP|TRUNCATE)\b/i.test(statement),
    )
  )
    throw new Error("pgvector_retrieval_unreviewed_sql");
  await writeFile(
    new URL("../reports/staging-schema-preview-2026-10-01/0019_pgvector-retrieval.sql", import.meta.url),
    `-- REVIEW ONLY. After 0018; baseline ${base}. No hosted/schema approval.\n` +
      "-- Requires the pgvector extension. Enabling it on a hosted database is a separate owner/provider approval.\n" +
      "-- Two additive tables: derived retrieval chunks (rebuildable) and staff-authored customer memories. No DML or backfill.\n" +
      "-- All 142 prior table definitions are unchanged. Current source totals 144.\n" +
      "CREATE EXTENSION IF NOT EXISTS vector;\n" +
      `${statements.map((statement) => statement.trim().replace(/;+$/, "")).join(";\n")};\n`,
  );
  console.log(
    JSON.stringify({
      generated: "0019_pgvector-retrieval.sql",
      base,
      previousTables: 142,
      expectedTables: 144,
      statements: statements.length + 1,
      oldDefinitionsUnchanged: true,
      historicalDml: false,
      databaseOpened: false,
    }),
  );
} finally {
  // The validated exact newly-created schema child only; never an existing tree.
  await rm(temporary, { recursive: true, force: true });
}
