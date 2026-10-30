-- REVIEW ONLY. After 0020; baseline main@6858bfd. Applied by drizzle-kit push on a fresh database.
-- ESTI price book: one additive table; no historical DML or backfill.
-- All 146 prior table definitions are unchanged. Current source totals 147.
CREATE TABLE "price_book_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"trade" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"unit" text DEFAULT 'ea' NOT NULL,
	"unit_cost_cents" integer DEFAULT 0 NOT NULL,
	"unit_price_cents" integer NOT NULL,
	"target_margin_bps" integer,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by_user_id" varchar,
	"updated_by_user_id" varchar,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "price_book_items_amounts_ck" CHECK ("price_book_items"."unit_cost_cents" >= 0 and "price_book_items"."unit_price_cents" >= 0 and "price_book_items"."unit_price_cents" <= 100000000 and "price_book_items"."unit_cost_cents" <= 100000000),
	CONSTRAINT "price_book_items_margin_ck" CHECK ("price_book_items"."target_margin_bps" is null or ("price_book_items"."target_margin_bps" >= 0 and "price_book_items"."target_margin_bps" < 10000))
);
ALTER TABLE "price_book_items" ADD CONSTRAINT "price_book_items_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "price_book_items" ADD CONSTRAINT "price_book_items_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "price_book_items" ADD CONSTRAINT "price_book_items_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
CREATE UNIQUE INDEX "price_book_items_org_trade_name_uniq" ON "price_book_items" USING btree ("organization_id","trade","name");
CREATE INDEX "price_book_items_org_active_idx" ON "price_book_items" USING btree ("organization_id","is_active");
