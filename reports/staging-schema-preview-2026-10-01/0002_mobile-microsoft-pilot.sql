-- REVIEW-ONLY additive candidate. Not applied to any hosted environment.
-- Generated from the five new tables; no live connection or schema mutation.
CREATE TABLE "email_sender_preferences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" varchar NOT NULL,
	"provider" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "microsoft_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" varchar NOT NULL,
	"account_id" text NOT NULL,
	"email" text NOT NULL,
	"encrypted_refresh_token" text,
	"granted_scopes" text[] DEFAULT '{}' NOT NULL,
	"connected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"last_error_at" timestamp with time zone,
	"last_error_code" text,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "staff_push_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"lead_id" uuid NOT NULL,
	"subscription_id" uuid NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"claimed_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"provider_status" integer,
	"reason" text
);

CREATE TABLE "staff_push_policies" (
	"organization_id" uuid PRIMARY KEY NOT NULL,
	"policy" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "staff_push_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" varchar NOT NULL,
	"session_id" varchar,
	"endpoint_hash" text NOT NULL,
	"encrypted_subscription" text,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "email_sender_preferences" ADD CONSTRAINT "email_sender_preferences_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "email_sender_preferences" ADD CONSTRAINT "email_sender_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "microsoft_connections" ADD CONSTRAINT "microsoft_connections_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "microsoft_connections" ADD CONSTRAINT "microsoft_connections_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "staff_push_deliveries" ADD CONSTRAINT "staff_push_deliveries_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "staff_push_deliveries" ADD CONSTRAINT "staff_push_deliveries_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "staff_push_deliveries" ADD CONSTRAINT "staff_push_deliveries_subscription_id_staff_push_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."staff_push_subscriptions"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "staff_push_policies" ADD CONSTRAINT "staff_push_policies_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "staff_push_subscriptions" ADD CONSTRAINT "staff_push_subscriptions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "staff_push_subscriptions" ADD CONSTRAINT "staff_push_subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "staff_push_subscriptions" ADD CONSTRAINT "staff_push_subscriptions_session_id_sessions_sid_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("sid") ON DELETE set null ON UPDATE no action;
CREATE UNIQUE INDEX "email_sender_preferences_org_user_uniq" ON "email_sender_preferences" USING btree ("organization_id","user_id");
CREATE UNIQUE INDEX "microsoft_connections_org_user_uniq" ON "microsoft_connections" USING btree ("organization_id","user_id");
CREATE UNIQUE INDEX "staff_push_lead_device_uq" ON "staff_push_deliveries" USING btree ("organization_id","lead_id","subscription_id");
CREATE INDEX "staff_push_due_idx" ON "staff_push_deliveries" USING btree ("state","created_at");
CREATE UNIQUE INDEX "staff_push_endpoint_uq" ON "staff_push_subscriptions" USING btree ("endpoint_hash");
CREATE INDEX "staff_push_member_idx" ON "staff_push_subscriptions" USING btree ("organization_id","user_id");
