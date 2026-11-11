-- REVIEW ONLY. After 0025; applied by drizzle-kit push on a fresh database.
-- CALLIE missed-call text-back: one nullable settings column (registration confirmation and caller window); no DML or backfill.
-- All 150 table definitions keep their rows.
ALTER TABLE "org_settings" ADD COLUMN "callie_text_back" jsonb;
