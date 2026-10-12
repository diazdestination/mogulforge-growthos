// Runs before every `drizzle-kit push` started through this package's scripts.
// The retrieval schema has a pgvector `vector(1536)` column, so the extension
// must exist before Drizzle creates tables. `IF NOT EXISTS` is a no-op when an
// operator (or the hosted provider) already enabled it, which also lets a
// restricted application role pass this step without CREATE privileges.
//
// This never runs on startup and never targets anything except DATABASE_URL.
// Hosted databases do not use this path: their reviewed SQL starts with the
// same statement and requires a separate enablement approval.
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const REQUIRED = ["vector"];

export async function ensureExtensions(connectionString = process.env.DATABASE_URL) {
  if (!connectionString) throw new Error("DATABASE_URL, ensure the database is provisioned");
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    for (const name of REQUIRED) {
      const { rows } = await client.query("SELECT 1 FROM pg_extension WHERE extname = $1", [name]);
      if (rows.length) continue;
      try {
        await client.query(`CREATE EXTENSION IF NOT EXISTS ${name}`);
      } catch (error) {
        throw new Error(
          `PostgreSQL extension "${name}" is not installed and could not be created (${error.code ?? "unknown"}). ` +
            "Use the pinned pgvector/pgvector:0.8.0-pg16 image locally, or have the database owner run " +
            `CREATE EXTENSION ${name}; on a separately approved hosted database.`,
        );
      }
    }
  } finally {
    await client.end();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  ensureExtensions().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
