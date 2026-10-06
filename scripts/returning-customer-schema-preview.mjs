/** Offline exact-delta review from accepted PR25. Never accepts a DB URL. */
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tsImport } from "tsx/esm/api";

const base = "bd9df2f2ffc046756759db4703c9c21e744a551e";
const root = fileURLToPath(new URL("../", import.meta.url)),
  schemaRoot = resolve(root, "lib/db/src/schema");
const requireDb = createRequire(
  new URL("../lib/db/package.json", import.meta.url),
);
const { generateDrizzleJson, generateMigration } = requireDb("drizzle-kit/api");
const temporary = await mkdtemp(
  join(schemaRoot, ".returning-customer-baseline-"),
);
if (
  dirname(temporary) !== schemaRoot ||
  !basename(temporary).startsWith(".returning-customer-baseline-")
)
  throw new Error("returning_schema_temporary_path_invalid");
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
    throw new Error("returning_schema_baseline_paths_invalid");
  for (const file of files)
    await writeFile(
      join(temporary, basename(file)),
      execFileSync("git", ["show", `${base}:${file}`], {
        cwd: root,
        encoding: "utf8",
        windowsHide: true,
      }),
      { flag: "wx" },
    );
  const before = generateDrizzleJson(
    await tsImport(
      pathToFileURL(join(temporary, "index.ts")).href,
      import.meta.url,
    ),
  );
  const after = generateDrizzleJson(
    await tsImport("../lib/db/src/schema/index.ts", import.meta.url),
  );
  const created = Object.keys(after.tables)
    .filter((name) => !before.tables[name])
    .sort();
  if (
    Object.keys(before.tables).length !== 139 ||
    Object.keys(after.tables).length !== 141 ||
    JSON.stringify(created) !==
      JSON.stringify([
        "public.customer_work_commands",
        "public.customer_work_roots",
      ])
  )
    throw new Error("returning_schema_unreviewed_tables");
  const additions = {
    estimates: ["customer_work_id", "work_version"],
    projects: ["customer_work_id", "work_version"],
    invoices: ["customer_work_id"],
    value_entries: ["customer_work_id", "refund_of_value_entry_id"],
  };
  const changes = [];
  for (const [key, old] of Object.entries(before.tables)) {
    const current = after.tables[key];
    if (!current) throw new Error("returning_schema_old_table_missing");
    for (const [column, shape] of Object.entries(old.columns)) {
      const next = current.columns[column];
      if (!next) throw new Error("returning_schema_old_column_missing");
      const expected = structuredClone(shape);
      if (additions[old.name] && column === "lead_id") {
        expected.notNull = false;
        changes.push(`${old.name}.lead_id`);
      }
      if (JSON.stringify(expected) !== JSON.stringify(next))
        throw new Error(
          `returning_schema_unreviewed_column:${old.name}.${column}`,
        );
    }
    const added = Object.keys(current.columns)
      .filter((column) => !old.columns[column])
      .sort();
    if (
      JSON.stringify(added) !==
      JSON.stringify([...(additions[old.name] ?? [])].sort())
    )
      throw new Error(`returning_schema_unreviewed_additions:${old.name}`);
    for (const field of [
      "foreignKeys",
      "indexes",
      "uniqueConstraints",
      "checkConstraints",
      "policies",
      "compositePrimaryKeys",
    ]) {
      for (const [name, value] of Object.entries(old[field] ?? {}))
        if (JSON.stringify(value) !== JSON.stringify(current[field]?.[name]))
          throw new Error(
            `returning_schema_old_constraint_changed:${old.name}.${name}`,
          );
      if (
        !additions[old.name] &&
        JSON.stringify(old[field] ?? {}) !==
          JSON.stringify(current[field] ?? {})
      )
        throw new Error(
          `returning_schema_other_table_changed:${old.name}.${field}`,
        );
    }
    if (old.isRLSEnabled !== current.isRLSEnabled)
      throw new Error("returning_schema_rls_changed");
  }
  if (changes.length !== 4)
    throw new Error("returning_schema_nullability_count");
  const statements = await generateMigration(before, after);
  const relaxed = (statement) =>
    /^ALTER TABLE "(?:estimates|projects|invoices|value_entries)" ALTER COLUMN "lead_id" DROP NOT NULL;?$/.test(
      statement.trim(),
    );
  if (
    statements.filter(relaxed).length !== 4 ||
    statements.some(
      (statement) =>
        /^(?:DROP|TRUNCATE|DELETE|UPDATE|INSERT)\b/i.test(statement.trim()) ||
        (/^ALTER\b[\s\S]*\bDROP\b/i.test(statement.trim()) &&
          !relaxed(statement)),
    )
  )
    throw new Error("returning_schema_unreviewed_destructive_delta");
  // Existing native parent keys must exist BEFORE the new composite FKs; the
  // generator emits UNIQUE constraints later on an incremental upgrade.
  const preparation = (statement) =>
    /^CREATE TABLE\b/.test(statement.trim()) ||
    relaxed(statement) ||
    /^ALTER TABLE "(?:estimates|projects|invoices|value_entries)" ADD COLUMN\b/.test(
      statement.trim(),
    );
  const parentKey = (statement) =>
    /^ALTER TABLE "(?:estimates|projects|value_entries)" ADD CONSTRAINT "[a-z_]+" UNIQUE\(/.test(
      statement.trim(),
    );
  const ordered = [
    ...statements.filter(preparation),
    ...statements.filter(parentKey),
    ...statements.filter(
      (statement) => !preparation(statement) && !parentKey(statement),
    ),
  ];
  if (
    ordered.length !== statements.length ||
    new Set(ordered).size !== ordered.length
  )
    throw new Error("returning_schema_delta_order_invalid");
  const output = new URL(
    "../reports/staging-schema-preview-2026-10-01/0017_returning-customer-work.sql",
    import.meta.url,
  );
  await writeFile(
    output,
    `-- REVIEW ONLY. After0016 at ${base}. No hosted/schema approval.\n-- Two lineage/command tables; four EXACT lead_id NOT NULL relaxations guarded by XOR.\n-- Native/root/refund tenant references and versions; no historical DML/backfill.\n-- New native parent UNIQUE constraints precede their composite FKs.\n${ordered.map((statement) => statement.trim().replace(/;+$/, "")).join(";\n")};\n`,
  );
  console.log(
    JSON.stringify({
      generated: "0017_returning-customer-work.sql",
      base,
      statements: statements.length,
      newTables: 2,
      expectedTables: 141,
      reviewedNotNullRelaxations: changes.sort(),
      historicalDml: false,
      databaseOpened: false,
    }),
  );
} finally {
  // Only the exact newly-created validated schema child, never an existing tree.
  await rm(temporary, { recursive: true, force: true });
}
