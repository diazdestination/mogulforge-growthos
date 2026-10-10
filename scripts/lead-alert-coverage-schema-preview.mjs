/** Offline additive review against PR28. Never reads env or accepts a database URL. */
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tsImport } from "tsx/esm/api";

const base = "a0eb25dcc69291130a46a5478acf44f62d303e9f";
const root = fileURLToPath(new URL("../", import.meta.url));
const schemaRoot = resolve(root, "lib/db/src/schema");
const requireDb = createRequire(
  new URL("../lib/db/package.json", import.meta.url),
);
const { generateDrizzleJson, generateMigration } = requireDb("drizzle-kit/api");
const temporary = await mkdtemp(join(schemaRoot, ".lead-alert-baseline-"));
if (
  dirname(temporary) !== schemaRoot ||
  !basename(temporary).startsWith(".lead-alert-baseline-")
)
  throw new Error("lead_alert_temporary_path_invalid");
try {
  const files = execFileSync(
    "git",
    ["ls-tree", "-r", "--name-only", base, "lib/db/src/schema"],
    { cwd: root, encoding: "utf8", windowsHide: true },
  )
    .trim()
    .split(/\r?\n/);
  if (
    !files.length ||
    files.some((file) => !/^lib\/db\/src\/schema\/[a-z0-9-]+\.ts$/.test(file))
  )
    throw new Error("lead_alert_baseline_paths_invalid");
  for (const file of files) {
    await writeFile(
      join(temporary, basename(file)),
      execFileSync("git", ["show", `${base}:${file}`], {
        cwd: root,
        encoding: "utf8",
        windowsHide: true,
      }),
      { flag: "wx" },
    );
  }
  const before = generateDrizzleJson(
    await tsImport(
      pathToFileURL(join(temporary, "index.ts")).href,
      import.meta.url,
    ),
  );
  const after = generateDrizzleJson(
    await tsImport("../lib/db/src/schema/index.ts", import.meta.url),
  );
  const created = Object.keys(after.tables).filter(
    (name) => !before.tables[name],
  );
  if (
    Object.keys(before.tables).length !== 141 ||
    Object.keys(after.tables).length !== 142 ||
    created.length !== 1 ||
    created[0] !== "public.staff_lead_alert_coverage"
  )
    throw new Error("lead_alert_unreviewed_tables");
  for (const [name, table] of Object.entries(before.tables)) {
    if (JSON.stringify(table) !== JSON.stringify(after.tables[name]))
      throw new Error(`lead_alert_existing_table_changed:${name}`);
  }
  const statements = await generateMigration(before, after);
  if (
    !statements.length ||
    statements.some(
      (statement) =>
        !/^(?:CREATE TABLE|ALTER TABLE) "staff_lead_alert_coverage"(?:\s|$)/.test(
          statement.trim(),
        ) || /\b(?:DROP|TRUNCATE)\b/i.test(statement),
    )
  )
    throw new Error("lead_alert_unreviewed_sql");
  await writeFile(
    new URL(
      "../reports/staging-schema-preview-2026-10-01/0018_lead-alert-coverage.sql",
      import.meta.url,
    ),
    `-- REVIEW ONLY. After 0017; baseline ${base}. No hosted/schema approval.\n` +
      "-- One immutable application admission snapshot; no historical DML or backfill.\n" +
      "-- All 141 prior table definitions are unchanged. Current source totals 142.\n" +
      `${statements.map((statement) => statement.trim().replace(/;+$/, "")).join(";\n")};\n`,
  );
  console.log(
    JSON.stringify({
      generated: "0018_lead-alert-coverage.sql",
      base,
      previousTables: 141,
      expectedTables: 142,
      statements: statements.length,
      oldDefinitionsUnchanged: true,
      historicalDml: false,
      databaseOpened: false,
    }),
  );
} finally {
  // The validated exact newly-created schema child only; never an existing tree.
  await rm(temporary, { recursive: true, force: true });
}
