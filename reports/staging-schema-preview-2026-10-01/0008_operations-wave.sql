-- REVIEW ONLY. Operations wave after 0007 at 602131d1b0311ea5933633fedc2c25b5af218238. Not hosted schema approval.
-- The only relaxed column is staff_push_deliveries.lead_id, guarded by staff_push_target_valid.
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_org_id_uq" UNIQUE("organization_id","id");
ALTER TABLE "invoices" ADD CONSTRAINT "invoice_org_id" UNIQUE("organization_id","id");
ALTER TABLE "leads" ADD CONSTRAINT "leads_org_id_uq" UNIQUE("organization_id","id");
ALTER TABLE "service_obligations" ADD CONSTRAINT "service_obligations_org_id_uq" UNIQUE("organization_id","id");
ALTER TABLE "staff_push_subscriptions" ADD CONSTRAINT "staff_push_subscription_org_id_uq" UNIQUE("organization_id","id");
ALTER TABLE "value_entries" ADD CONSTRAINT "value_entry_org_id_uq" UNIQUE("organization_id","id");
CREATE TABLE "financial_migration_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"review_id" uuid NOT NULL,
	"source_system" text NOT NULL,
	"source_account" text NOT NULL,
	"entity_type" text NOT NULL,
	"external_id" text NOT NULL,
	"digest" text NOT NULL,
	"invoice_id" uuid,
	"value_entry_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "financial_item_target_valid" CHECK (("financial_migration_items"."entity_type" = 'invoice' and "financial_migration_items"."invoice_id" is not null and "financial_migration_items"."value_entry_id" is null) or ("financial_migration_items"."entity_type" = 'receipt' and "financial_migration_items"."invoice_id" is null and "financial_migration_items"."value_entry_id" is not null))
);
CREATE TABLE "financial_migration_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"actor_user_id" varchar NOT NULL,
	"raw_sha256" text NOT NULL,
	"digest" text NOT NULL,
	"context_digest" text NOT NULL,
	"payload" jsonb NOT NULL,
	"state" text DEFAULT 'review' NOT NULL,
	"result" jsonb,
	"expires_at" timestamp with time zone NOT NULL,
	"committed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "financial_review_org_id" UNIQUE("organization_id","id"),
	CONSTRAINT "financial_review_state_valid" CHECK ("financial_migration_reviews"."state" in ('review', 'committed')),
	CONSTRAINT "financial_review_commit_present" CHECK (("financial_migration_reviews"."state" = 'review' and "financial_migration_reviews"."result" is null and "financial_migration_reviews"."committed_at" is null) or ("financial_migration_reviews"."state" = 'committed' and "financial_migration_reviews"."result" is not null and "financial_migration_reviews"."committed_at" is not null))
);
CREATE TABLE "service_watch_cases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"service_obligation_id" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"state" text DEFAULT 'clear' NOT NULL,
	"reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"observed_fingerprint" text DEFAULT '' NOT NULL,
	"episode" integer DEFAULT 0 NOT NULL,
	"assigned_user_id" varchar,
	"acknowledged_by_user_id" varchar,
	"acknowledged_at" timestamp with time zone,
	"next_action" text,
	"next_action_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"notice_revision" integer DEFAULT 0 NOT NULL,
	"last_evaluated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "service_watch_org_id_uq" UNIQUE("organization_id","id")
);
CREATE TABLE "source_adoptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"lead_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"state" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	"source_as_of" timestamp with time zone NOT NULL,
	"cutover_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"evidence" text NOT NULL,
	"approved_by_user_id" varchar NOT NULL,
	"approved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_adoption_org_id_uq" UNIQUE("organization_id","id")
);
CREATE TABLE "source_outreach_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"state" text DEFAULT 'draft' NOT NULL,
	"settings" jsonb NOT NULL,
	"payload_sha256" text NOT NULL,
	"created_by_user_id" varchar NOT NULL,
	"approved_by_user_id" varchar,
	"approved_at" timestamp with time zone,
	"preview_expires_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_outreach_batch_org_id_uq" UNIQUE("organization_id","id")
);
CREATE TABLE "source_outreach_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"lead_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"adoption_id" uuid NOT NULL,
	"recipient" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	"claimed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_outreach_item_org_id_uq" UNIQUE("organization_id","id")
);
ALTER TABLE "staff_push_deliveries" ALTER COLUMN "lead_id" DROP NOT NULL;
ALTER TABLE "invoices" ADD COLUMN "balance_basis" text DEFAULT 'full_history' NOT NULL;
ALTER TABLE "invoices" ADD COLUMN "opening_receivable_cents" integer;
ALTER TABLE "invoices" ADD COLUMN "opening_as_of" timestamp with time zone;
ALTER TABLE "invoices" ADD COLUMN "historical_source" jsonb;
ALTER TABLE "staff_push_deliveries" ADD COLUMN "service_obligation_id" uuid;
ALTER TABLE "staff_push_deliveries" ADD COLUMN "service_watch_case_id" uuid;
ALTER TABLE "staff_push_deliveries" ADD COLUMN "service_notice_revision" integer;
ALTER TABLE "staff_push_deliveries" ADD COLUMN "service_owner_id" varchar;
ALTER TABLE "staff_push_deliveries" ADD COLUMN "event_key" text;
ALTER TABLE "financial_migration_items" ADD CONSTRAINT "financial_migration_items_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "financial_migration_items" ADD CONSTRAINT "financial_migration_items_review_id_financial_migration_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."financial_migration_reviews"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "financial_migration_items" ADD CONSTRAINT "financial_migration_items_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "financial_migration_items" ADD CONSTRAINT "financial_migration_items_value_entry_id_value_entries_id_fk" FOREIGN KEY ("value_entry_id") REFERENCES "public"."value_entries"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "financial_migration_items" ADD CONSTRAINT "financial_item_review_tenant" FOREIGN KEY ("organization_id","review_id") REFERENCES "public"."financial_migration_reviews"("organization_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "financial_migration_items" ADD CONSTRAINT "financial_item_invoice_tenant" FOREIGN KEY ("organization_id","invoice_id") REFERENCES "public"."invoices"("organization_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "financial_migration_items" ADD CONSTRAINT "financial_item_value_tenant" FOREIGN KEY ("organization_id","value_entry_id") REFERENCES "public"."value_entries"("organization_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "financial_migration_reviews" ADD CONSTRAINT "financial_migration_reviews_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "financial_migration_reviews" ADD CONSTRAINT "financial_migration_reviews_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "financial_migration_reviews" ADD CONSTRAINT "financial_review_actor_tenant" FOREIGN KEY ("organization_id","actor_user_id") REFERENCES "public"."users"("organization_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "service_watch_cases" ADD CONSTRAINT "service_watch_cases_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "service_watch_cases" ADD CONSTRAINT "service_watch_obligation_fk" FOREIGN KEY ("organization_id","service_obligation_id") REFERENCES "public"."service_obligations"("organization_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "service_watch_cases" ADD CONSTRAINT "service_watch_assignee_fk" FOREIGN KEY ("organization_id","assigned_user_id") REFERENCES "public"."users"("organization_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "service_watch_cases" ADD CONSTRAINT "service_watch_acknowledger_fk" FOREIGN KEY ("organization_id","acknowledged_by_user_id") REFERENCES "public"."users"("organization_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "source_adoptions" ADD CONSTRAINT "source_adoptions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "source_adoptions" ADD CONSTRAINT "source_adoption_lead_fk" FOREIGN KEY ("organization_id","lead_id") REFERENCES "public"."leads"("organization_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "source_adoptions" ADD CONSTRAINT "source_adoption_contact_fk" FOREIGN KEY ("organization_id","contact_id") REFERENCES "public"."contacts"("organization_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "source_adoptions" ADD CONSTRAINT "source_adoption_actor_fk" FOREIGN KEY ("organization_id","approved_by_user_id") REFERENCES "public"."users"("organization_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "source_outreach_batches" ADD CONSTRAINT "source_outreach_batches_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "source_outreach_batches" ADD CONSTRAINT "source_outreach_batch_creator_fk" FOREIGN KEY ("organization_id","created_by_user_id") REFERENCES "public"."users"("organization_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "source_outreach_batches" ADD CONSTRAINT "source_outreach_batch_approver_fk" FOREIGN KEY ("organization_id","approved_by_user_id") REFERENCES "public"."users"("organization_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "source_outreach_items" ADD CONSTRAINT "source_outreach_items_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "source_outreach_items" ADD CONSTRAINT "source_outreach_item_batch_fk" FOREIGN KEY ("organization_id","batch_id") REFERENCES "public"."source_outreach_batches"("organization_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "source_outreach_items" ADD CONSTRAINT "source_outreach_item_lead_fk" FOREIGN KEY ("organization_id","lead_id") REFERENCES "public"."leads"("organization_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "source_outreach_items" ADD CONSTRAINT "source_outreach_item_contact_fk" FOREIGN KEY ("organization_id","contact_id") REFERENCES "public"."contacts"("organization_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "source_outreach_items" ADD CONSTRAINT "source_outreach_item_adoption_fk" FOREIGN KEY ("organization_id","adoption_id") REFERENCES "public"."source_adoptions"("organization_id","id") ON DELETE no action ON UPDATE no action;
CREATE UNIQUE INDEX "financial_item_source_unique" ON "financial_migration_items" USING btree ("organization_id","source_system","source_account","entity_type","external_id");
CREATE INDEX "financial_review_org_created" ON "financial_migration_reviews" USING btree ("organization_id","created_at");
CREATE UNIQUE INDEX "service_watch_org_obligation_uq" ON "service_watch_cases" USING btree ("organization_id","service_obligation_id");
CREATE INDEX "service_watch_rotation_idx" ON "service_watch_cases" USING btree ("last_evaluated_at","id");
CREATE INDEX "service_watch_org_state_idx" ON "service_watch_cases" USING btree ("organization_id","state","updated_at");
CREATE UNIQUE INDEX "source_adoption_org_lead_uq" ON "source_adoptions" USING btree ("organization_id","lead_id");
CREATE UNIQUE INDEX "source_outreach_item_batch_lead_uq" ON "source_outreach_items" USING btree ("batch_id","lead_id");
CREATE UNIQUE INDEX "source_outreach_owned_lead_uq" ON "source_outreach_items" USING btree ("organization_id","lead_id") WHERE "source_outreach_items"."claimed_at" is not null;
CREATE UNIQUE INDEX "source_outreach_owned_recipient_uq" ON "source_outreach_items" USING btree ("organization_id","recipient") WHERE "source_outreach_items"."claimed_at" is not null;
ALTER TABLE "staff_push_deliveries" ADD CONSTRAINT "staff_push_lead_tenant_fk" FOREIGN KEY ("organization_id","lead_id") REFERENCES "public"."leads"("organization_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "staff_push_deliveries" ADD CONSTRAINT "staff_push_device_tenant_fk" FOREIGN KEY ("organization_id","subscription_id") REFERENCES "public"."staff_push_subscriptions"("organization_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "staff_push_deliveries" ADD CONSTRAINT "staff_push_service_tenant_fk" FOREIGN KEY ("organization_id","service_obligation_id") REFERENCES "public"."service_obligations"("organization_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "staff_push_deliveries" ADD CONSTRAINT "staff_push_watch_tenant_fk" FOREIGN KEY ("organization_id","service_watch_case_id") REFERENCES "public"."service_watch_cases"("organization_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "staff_push_deliveries" ADD CONSTRAINT "staff_push_service_owner_fk" FOREIGN KEY ("organization_id","service_owner_id") REFERENCES "public"."users"("organization_id","id") ON DELETE no action ON UPDATE no action;
CREATE UNIQUE INDEX "staff_push_event_device_uq" ON "staff_push_deliveries" USING btree ("organization_id","event_key","subscription_id");
ALTER TABLE "invoices" ADD CONSTRAINT "invoice_balance_basis_valid" CHECK (("invoices"."balance_basis" = 'full_history' and "invoices"."opening_receivable_cents" is null and "invoices"."opening_as_of" is null) or ("invoices"."balance_basis" = 'opening_receivable' and "invoices"."opening_receivable_cents" is not null and "invoices"."opening_receivable_cents" >= 0 and "invoices"."opening_receivable_cents" <= 1000000000 and "invoices"."opening_as_of" is not null and "invoices"."historical_source" is not null));
ALTER TABLE "staff_push_deliveries" ADD CONSTRAINT "staff_push_target_valid" CHECK (("staff_push_deliveries"."lead_id" is not null and "staff_push_deliveries"."service_obligation_id" is null and "staff_push_deliveries"."service_watch_case_id" is null and "staff_push_deliveries"."service_notice_revision" is null and "staff_push_deliveries"."service_owner_id" is null and "staff_push_deliveries"."event_key" is null) or ("staff_push_deliveries"."lead_id" is null and "staff_push_deliveries"."service_obligation_id" is not null and "staff_push_deliveries"."service_watch_case_id" is not null and "staff_push_deliveries"."service_notice_revision" > 0 and "staff_push_deliveries"."service_notice_revision" is not null and "staff_push_deliveries"."service_owner_id" is not null and "staff_push_deliveries"."event_key" = 'service-watch:' || "staff_push_deliveries"."service_watch_case_id"::text || ':' || "staff_push_deliveries"."service_notice_revision"::text and "staff_push_deliveries"."event_key" is not null));
