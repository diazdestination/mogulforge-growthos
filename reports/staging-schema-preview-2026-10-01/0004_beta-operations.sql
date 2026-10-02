-- Review-only additive delta after PR #8. Generated from the current Drizzle schema.

-- Apply only through the approved release-schema process; retain history on rollback.

CREATE TABLE "customer_lifecycle" (
	"organization_id" uuid PRIMARY KEY NOT NULL,
	"state" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"reason" text NOT NULL,
	"request_id" uuid,
	"requested_at" timestamp with time zone,
	"updated_by_user_id" varchar,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_lifecycle_state_valid" CHECK ("customer_lifecycle"."state" IN ('active', 'paused', 'offboarding_requested')),
	CONSTRAINT "customer_lifecycle_version_positive" CHECK ("customer_lifecycle"."version" > 0)
);

CREATE TABLE "billing_checkouts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"intent" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"replaces_subscription_id" text,
	"completed_subscription_id" text,
	"price_id" text NOT NULL,
	"plan_id" text NOT NULL,
	"success_url" text NOT NULL,
	"cancel_url" text NOT NULL,
	"trial_days" integer DEFAULT 0 NOT NULL,
	"provider_configuration_hash" text NOT NULL,
	"customer_id" text,
	"customer_attempted_at" timestamp with time zone,
	"session_id" text,
	"session_attempted_at" timestamp with time zone,
	"session_expires_at" timestamp with time zone,
	"lease_token" uuid,
	"lease_expires_at" timestamp with time zone,
	"recovery_reason" text,
	"authorized_by_user_id" varchar,
	"authorization_reason" text,
	"authorization_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_checkouts_state_valid" CHECK ("billing_checkouts"."state" in ('pending', 'open', 'reconcile', 'completed', 'expired')),
	CONSTRAINT "billing_checkouts_intent_valid" CHECK ("billing_checkouts"."intent" in ('initial', 'replacement')),
	CONSTRAINT "billing_checkouts_trial_valid" CHECK ("billing_checkouts"."trial_days" >= 0 and "billing_checkouts"."trial_days" <= 730),
	CONSTRAINT "billing_checkouts_replacement_authorized" CHECK ("billing_checkouts"."intent" = 'initial' or ("billing_checkouts"."replaces_subscription_id" is not null and "billing_checkouts"."authorized_by_user_id" is not null and "billing_checkouts"."authorization_reason" is not null and "billing_checkouts"."authorization_expires_at" is not null))
);

ALTER TABLE "customer_lifecycle" ADD CONSTRAINT "customer_lifecycle_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;

ALTER TABLE "customer_lifecycle" ADD CONSTRAINT "customer_lifecycle_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;

ALTER TABLE "billing_checkouts" ADD CONSTRAINT "billing_checkouts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;

ALTER TABLE "billing_checkouts" ADD CONSTRAINT "billing_checkouts_authorized_by_user_id_users_id_fk" FOREIGN KEY ("authorized_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;

CREATE UNIQUE INDEX "billing_checkouts_current_org_idx" ON "billing_checkouts" USING btree ("organization_id") WHERE "billing_checkouts"."state" in ('pending', 'open', 'reconcile');

CREATE UNIQUE INDEX "billing_checkouts_session_idx" ON "billing_checkouts" USING btree ("session_id");

CREATE INDEX "billing_checkouts_org_idx" ON "billing_checkouts" USING btree ("organization_id");
