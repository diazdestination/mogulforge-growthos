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
  // Fly Postgres owns the pg_stat_* monitoring objects. Excluding that family
  // keeps Drizzle focused on application tables while remaining compatible
  // with ordinary PostgreSQL instances that do not install those extensions.
  tablesFilter: ["!pg_stat_*"],
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
});
