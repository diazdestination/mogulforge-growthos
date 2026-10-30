-- REVIEW ONLY. After 0021; applied by drizzle-kit push on a fresh database.
-- BILL card & bank collection (Stripe Connect): two additive tables; no DML or backfill.
-- All 147 prior table definitions are unchanged. Current source totals 149.
CREATE TABLE "invoice_payment_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"invoice_version" integer NOT NULL,
	"amount_cents" integer NOT NULL,
	"stripe_account_id" text NOT NULL,
	"checkout_session_id" text,
	"checkout_url" text,
	"payment_intent_id" text,
	"state" text DEFAULT 'open' NOT NULL,
	"detail" text DEFAULT '' NOT NULL,
	"created_by_user_id" varchar NOT NULL,
	"recorded_value_entry_id" uuid,
	"expires_at" timestamp with time zone,
	"paid_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoice_payment_links_amount_ck" CHECK ("invoice_payment_links"."amount_cents" between 50 and 100000000)
);
CREATE TABLE "stripe_connect_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"stripe_account_id" text NOT NULL,
	"charges_enabled" boolean DEFAULT false NOT NULL,
	"payouts_enabled" boolean DEFAULT false NOT NULL,
	"details_submitted" boolean DEFAULT false NOT NULL,
	"connected_by_user_id" varchar,
	"last_synced_at" timestamp with time zone,
	"disconnected_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
ALTER TABLE "invoice_payment_links" ADD CONSTRAINT "invoice_payment_links_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "invoice_payment_links" ADD CONSTRAINT "invoice_payment_links_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "invoice_payment_links" ADD CONSTRAINT "invoice_payment_links_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "stripe_connect_accounts" ADD CONSTRAINT "stripe_connect_accounts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "stripe_connect_accounts" ADD CONSTRAINT "stripe_connect_accounts_connected_by_user_id_users_id_fk" FOREIGN KEY ("connected_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
CREATE UNIQUE INDEX "invoice_payment_links_session_uniq" ON "invoice_payment_links" USING btree ("checkout_session_id");
CREATE INDEX "invoice_payment_links_org_invoice_idx" ON "invoice_payment_links" USING btree ("organization_id","invoice_id");
CREATE UNIQUE INDEX "stripe_connect_accounts_org_uniq" ON "stripe_connect_accounts" USING btree ("organization_id");
CREATE UNIQUE INDEX "stripe_connect_accounts_account_uniq" ON "stripe_connect_accounts" USING btree ("stripe_account_id");
