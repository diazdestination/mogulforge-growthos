/** Offline additive delta against the verified contractor-operations base. */
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { writeFile, unlink } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { tsImport } from "tsx/esm/api";

const base = "48c3491c75ea31abf347deee59f8faf17d63136a";
const requireDb = createRequire(
  new URL("../lib/db/package.json", import.meta.url),
);
const { generateDrizzleJson, generateMigration } = requireDb("drizzle-kit/api");
const schema = await tsImport("../lib/db/src/schema/index.ts", import.meta.url);
const added = [
  "invoicesTable",
  "invoiceSequencesTable",
  "invoiceOperationsTable",
  "invoiceReceiptAllocationsTable",
];
if (added.some((name) => !schema[name]))
  throw new Error("native_schema_missing");
// Load the historical service schema beside its normal relative dependencies.
// This is one exclusively created temporary source file, never another checkout.
const baselineUrl = new URL(
  "../lib/db/src/schema/.native-service-baseline.ts",
  import.meta.url,
);
const baselineText = execFileSync(
  "git",
  ["show", `${base}:lib/db/src/schema/service-obligations.ts`],
  {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    encoding: "utf8",
    windowsHide: true,
  },
);
await writeFile(baselineUrl, baselineText, { flag: "wx" });
try {
  const historical = await tsImport(baselineUrl.href, import.meta.url);
  const before = Object.fromEntries(
    Object.entries(schema).filter(([name]) => !added.includes(name)),
  );
  before.serviceObligationsTable = historical.serviceObligationsTable;
  const statements = await generateMigration(
    generateDrizzleJson(before),
    generateDrizzleJson(schema),
  );
  if (
    !statements.length ||
    statements.some(
      (sql) =>
        /^\s*(?:DROP|TRUNCATE|DELETE|UPDATE)\b/i.test(sql) ||
        /^\s*ALTER\b[\s\S]*\bDROP\b/i.test(sql),
    )
  )
    throw new Error("native_schema_not_additive");
  await writeFile(
    new URL(
      "../reports/staging-schema-preview-2026-10-01/0006_native-contractor-day.sql",
      import.meta.url,
    ),
    `-- REVIEW ONLY. Additive native contractor day after 0005 at ${base}. Not production approval.\n${statements.join(";\n")};\n`,
  );
  console.log(
    JSON.stringify({
      generated: "0006_native-contractor-day.sql",
      base,
      statements: statements.length,
      databaseOpened: false,
    }),
  );
} finally {
  await unlink(baselineUrl);
}
