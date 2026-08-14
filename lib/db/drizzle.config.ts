import { defineConfig } from "drizzle-kit";
import path from "path";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL, ensure the database is provisioned");
}

export default defineConfig({
  // Use forward slashes even on Windows: drizzle-kit globs this path, and
  // backslashes are glob escape chars (would match nothing on Win32).
  schema: path.join(__dirname, "./src/schema/index.ts").replace(/\\/g, "/"),
  dialect: "postgresql",
  // Fly Postgres installs pg_stat_monitor and owns the views it creates.
  // Without this filter, drizzle-kit push attempts to manage those provider
  // objects and aborts before it can reconcile GrowthOS application tables.
  extensionsFilters: ["pg_stat_monitor"],
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
});
