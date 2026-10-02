-- REVIEW-ONLY delta from 58ab300. Not applied to a hosted environment.
-- Apply once, inside an approved transaction after backup/restore and target review.
-- Existing rows retain null source history and legacy entitlement behavior.
-- Inspect table size/locking budget before approving the ordinary unique index.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE "organizations" ADD COLUMN "entitlements" jsonb;
ALTER TABLE "leads" ADD COLUMN "import_source_key" text;
ALTER TABLE "leads" ADD COLUMN "external_opportunity_id" text;
ALTER TABLE "leads" ADD COLUMN "imported_history" jsonb;
ALTER TABLE "lead_imports" ADD COLUMN "updated" integer DEFAULT 0 NOT NULL;
ALTER TABLE "lead_imports" ADD COLUMN "conflicts" integer DEFAULT 0 NOT NULL;
ALTER TABLE "lead_imports" ADD COLUMN "source_key" text;
ALTER TABLE "lead_imports" ADD COLUMN "snapshot_as_of" timestamp with time zone;
CREATE UNIQUE INDEX "leads_org_import_opportunity_idx" ON "leads"
  USING btree ("organization_id", "import_source_key", "external_opportunity_id");
