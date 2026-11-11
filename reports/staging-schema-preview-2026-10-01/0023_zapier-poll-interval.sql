-- REVIEW ONLY. After 0022; applied by drizzle-kit push on a fresh database.
-- Zapier owned-app flows: one additive column with a default; no DML or backfill.
-- All 149 table definitions keep their rows; existing connections read every 4 hours.
ALTER TABLE "zapier_mcp_connections" ADD COLUMN "poll_interval_minutes" integer DEFAULT 240 NOT NULL;
