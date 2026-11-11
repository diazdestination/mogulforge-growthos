-- REVIEW ONLY. After 0022; applied by drizzle-kit push on a fresh database.
-- ESTI customer estimate approval with e-signature: one additive table; no DML or backfill.
-- All 149 prior table definitions are unchanged. Current source totals 150.
CREATE TABLE "estimate_approvals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"estimate_id" uuid NOT NULL,
	"created_by_user_id" varchar NOT NULL,
	"snapshot" jsonb NOT NULL,
	"snapshot_sha256" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by_user_id" varchar,
	"decision" text,
	"decided_at" timestamp with time zone,
	"signer_name" text,
	"signature_data_url" text,
	"signature_sha256" text,
	"consent_text" text,
	"decline_reason" text,
	"signer_ip" text,
	"signer_user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "estimate_approvals_decision_ck" CHECK ("estimate_approvals"."decision" is null or "estimate_approvals"."decision" in ('approved','declined')),
	CONSTRAINT "estimate_approvals_decided_ck" CHECK (("estimate_approvals"."decision" is null and "estimate_approvals"."decided_at" is null) or ("estimate_approvals"."decision" is not null and "estimate_approvals"."decided_at" is not null and "estimate_approvals"."revoked_at" is null)),
	CONSTRAINT "estimate_approvals_signed_ck" CHECK ("estimate_approvals"."decision" is distinct from 'approved' or ("estimate_approvals"."signer_name" is not null and "estimate_approvals"."signature_data_url" is not null and "estimate_approvals"."signature_sha256" is not null and "estimate_approvals"."consent_text" is not null)),
	CONSTRAINT "estimate_approvals_signature_size_ck" CHECK ("estimate_approvals"."signature_data_url" is null or length("estimate_approvals"."signature_data_url") <= 200000)
);
ALTER TABLE "estimate_approvals" ADD CONSTRAINT "estimate_approvals_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "estimate_approvals" ADD CONSTRAINT "estimate_approvals_estimate_id_estimates_id_fk" FOREIGN KEY ("estimate_id") REFERENCES "public"."estimates"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "estimate_approvals" ADD CONSTRAINT "estimate_approvals_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "estimate_approvals" ADD CONSTRAINT "estimate_approvals_revoked_by_user_id_users_id_fk" FOREIGN KEY ("revoked_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
CREATE UNIQUE INDEX "estimate_approvals_token_hash_uq" ON "estimate_approvals" USING btree ("token_hash");
CREATE UNIQUE INDEX "estimate_approvals_open_uq" ON "estimate_approvals" USING btree ("estimate_id") WHERE "estimate_approvals"."revoked_at" is null and "estimate_approvals"."decision" is null;
CREATE INDEX "estimate_approvals_org_estimate_idx" ON "estimate_approvals" USING btree ("organization_id","estimate_id");
