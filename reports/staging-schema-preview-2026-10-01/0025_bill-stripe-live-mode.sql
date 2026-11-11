-- REVIEW ONLY. After 0024; applied by drizzle-kit push on a fresh database.
-- BILL live mode: additive columns with defaults (existing rows read as test mode),
-- one unique index widened to (organization, mode) and two mode checks; no DML or backfill.
-- All 150 table definitions keep their rows.
ALTER TABLE "stripe_connect_accounts" ADD COLUMN "mode" text DEFAULT 'test' NOT NULL;
ALTER TABLE "stripe_connect_accounts" ADD COLUMN "requirements" jsonb;
ALTER TABLE "invoice_payment_links" ADD COLUMN "mode" text DEFAULT 'test' NOT NULL;
ALTER TABLE "invoice_payment_links" ADD COLUMN "review_flags" jsonb DEFAULT '[]'::jsonb NOT NULL;
DROP INDEX "stripe_connect_accounts_org_uniq";
CREATE UNIQUE INDEX "stripe_connect_accounts_org_mode_uniq" ON "stripe_connect_accounts" USING btree ("organization_id","mode");
ALTER TABLE "stripe_connect_accounts" ADD CONSTRAINT "stripe_connect_accounts_mode_ck" CHECK ("stripe_connect_accounts"."mode" in ('test', 'live'));
ALTER TABLE "invoice_payment_links" ADD CONSTRAINT "invoice_payment_links_mode_ck" CHECK ("invoice_payment_links"."mode" in ('test', 'live'));
