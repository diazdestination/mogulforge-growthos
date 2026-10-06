-- REVIEW ONLY. After0016 at bd9df2f2ffc046756759db4703c9c21e744a551e. No hosted/schema approval.
-- Two lineage/command tables; four EXACT lead_id NOT NULL relaxations guarded by XOR.
-- Native/root/refund tenant references and versions; no historical DML/backfill.
-- New native parent UNIQUE constraints precede their composite FKs.
CREATE TABLE "customer_work_commands" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"actor_user_id" varchar NOT NULL,
	"action" text NOT NULL,
	"payload_sha256" text NOT NULL,
	"customer_work_id" uuid NOT NULL,
	"estimate_id" uuid,
	"project_id" uuid,
	"result_version" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_work_command_request_uq" UNIQUE("organization_id","request_id"),
	CONSTRAINT "customer_work_command_target_ck" CHECK (("customer_work_commands"."action" in ('estimate_created','estimate_updated') and "customer_work_commands"."estimate_id" is not null and "customer_work_commands"."project_id" is null) or ("customer_work_commands"."action" in ('project_created','project_updated') and "customer_work_commands"."project_id" is not null and "customer_work_commands"."estimate_id" is null)),
	CONSTRAINT "customer_work_command_value_ck" CHECK ("customer_work_commands"."result_version" > 0 and "customer_work_commands"."payload_sha256" ~ '^[a-f0-9]{64}$')
);
CREATE TABLE "customer_work_roots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"property_id" uuid,
	"created_by_user_id" varchar NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_work_roots_org_id_uq" UNIQUE("organization_id","id")
);
ALTER TABLE "estimates" ALTER COLUMN "lead_id" DROP NOT NULL;
ALTER TABLE "invoices" ALTER COLUMN "lead_id" DROP NOT NULL;
ALTER TABLE "projects" ALTER COLUMN "lead_id" DROP NOT NULL;
ALTER TABLE "value_entries" ALTER COLUMN "lead_id" DROP NOT NULL;
ALTER TABLE "estimates" ADD COLUMN "customer_work_id" uuid;
ALTER TABLE "estimates" ADD COLUMN "work_version" integer;
ALTER TABLE "invoices" ADD COLUMN "customer_work_id" uuid;
ALTER TABLE "projects" ADD COLUMN "customer_work_id" uuid;
ALTER TABLE "projects" ADD COLUMN "work_version" integer;
ALTER TABLE "value_entries" ADD COLUMN "customer_work_id" uuid;
ALTER TABLE "value_entries" ADD COLUMN "refund_of_value_entry_id" uuid;
ALTER TABLE "estimates" ADD CONSTRAINT "estimates_org_work_id_uq" UNIQUE("organization_id","id","customer_work_id");
ALTER TABLE "projects" ADD CONSTRAINT "projects_org_work_id_uq" UNIQUE("organization_id","id","customer_work_id");
ALTER TABLE "value_entries" ADD CONSTRAINT "value_entry_org_work_id_uq" UNIQUE("organization_id","id","customer_work_id");
ALTER TABLE "customer_work_commands" ADD CONSTRAINT "customer_work_command_root_fk" FOREIGN KEY ("organization_id","customer_work_id") REFERENCES "public"."customer_work_roots"("organization_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "customer_work_commands" ADD CONSTRAINT "customer_work_command_actor_fk" FOREIGN KEY ("organization_id","actor_user_id") REFERENCES "public"."users"("organization_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "customer_work_commands" ADD CONSTRAINT "customer_work_command_estimate_fk" FOREIGN KEY ("organization_id","estimate_id","customer_work_id") REFERENCES "public"."estimates"("organization_id","id","customer_work_id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "customer_work_commands" ADD CONSTRAINT "customer_work_command_project_fk" FOREIGN KEY ("organization_id","project_id","customer_work_id") REFERENCES "public"."projects"("organization_id","id","customer_work_id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "customer_work_roots" ADD CONSTRAINT "customer_work_roots_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "customer_work_roots" ADD CONSTRAINT "customer_work_root_contact_fk" FOREIGN KEY ("organization_id","contact_id") REFERENCES "public"."contacts"("organization_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "customer_work_roots" ADD CONSTRAINT "customer_work_root_property_fk" FOREIGN KEY ("organization_id","property_id") REFERENCES "public"."properties"("organization_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "customer_work_roots" ADD CONSTRAINT "customer_work_root_creator_fk" FOREIGN KEY ("organization_id","created_by_user_id") REFERENCES "public"."users"("organization_id","id") ON DELETE no action ON UPDATE no action;
CREATE INDEX "customer_work_commands_root_idx" ON "customer_work_commands" USING btree ("organization_id","customer_work_id");
CREATE INDEX "customer_work_roots_contact_idx" ON "customer_work_roots" USING btree ("organization_id","contact_id","created_at");
CREATE INDEX "customer_work_roots_property_idx" ON "customer_work_roots" USING btree ("organization_id","property_id");
ALTER TABLE "estimates" ADD CONSTRAINT "estimates_customer_work_fk" FOREIGN KEY ("organization_id","customer_work_id") REFERENCES "public"."customer_work_roots"("organization_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_customer_work_fk" FOREIGN KEY ("organization_id","customer_work_id") REFERENCES "public"."customer_work_roots"("organization_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_work_project_fk" FOREIGN KEY ("organization_id","project_id","customer_work_id") REFERENCES "public"."projects"("organization_id","id","customer_work_id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_work_estimate_fk" FOREIGN KEY ("organization_id","estimate_id","customer_work_id") REFERENCES "public"."estimates"("organization_id","id","customer_work_id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "projects" ADD CONSTRAINT "projects_customer_work_fk" FOREIGN KEY ("organization_id","customer_work_id") REFERENCES "public"."customer_work_roots"("organization_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "projects" ADD CONSTRAINT "projects_work_estimate_fk" FOREIGN KEY ("organization_id","estimate_id","customer_work_id") REFERENCES "public"."estimates"("organization_id","id","customer_work_id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "value_entries" ADD CONSTRAINT "value_entries_refund_of_value_entry_id_value_entries_id_fk" FOREIGN KEY ("refund_of_value_entry_id") REFERENCES "public"."value_entries"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "value_entries" ADD CONSTRAINT "value_entry_customer_work_fk" FOREIGN KEY ("organization_id","customer_work_id") REFERENCES "public"."customer_work_roots"("organization_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "value_entries" ADD CONSTRAINT "value_entry_refund_work_fk" FOREIGN KEY ("organization_id","refund_of_value_entry_id","customer_work_id") REFERENCES "public"."value_entries"("organization_id","id","customer_work_id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "value_entries" ADD CONSTRAINT "value_entry_refund_tenant_fk" FOREIGN KEY ("organization_id","refund_of_value_entry_id") REFERENCES "public"."value_entries"("organization_id","id") ON DELETE no action ON UPDATE no action;
CREATE UNIQUE INDEX "estimates_work_root_uq" ON "estimates" USING btree ("customer_work_id") WHERE "estimates"."customer_work_id" is not null;
CREATE INDEX "invoices_org_work_idx" ON "invoices" USING btree ("organization_id","customer_work_id");
CREATE UNIQUE INDEX "projects_work_root_uq" ON "projects" USING btree ("customer_work_id") WHERE "projects"."customer_work_id" is not null;
CREATE INDEX "value_entries_org_work_idx" ON "value_entries" USING btree ("organization_id","customer_work_id");
ALTER TABLE "estimates" ADD CONSTRAINT "estimates_work_scope_ck" CHECK (("estimates"."lead_id" is not null and "estimates"."customer_work_id" is null and "estimates"."work_version" is null) or ("estimates"."lead_id" is null and "estimates"."customer_work_id" is not null and "estimates"."work_version" is not null and "estimates"."work_version" > 0));
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_work_scope_ck" CHECK (("invoices"."lead_id" is not null and "invoices"."customer_work_id" is null) or ("invoices"."lead_id" is null and "invoices"."customer_work_id" is not null));
ALTER TABLE "projects" ADD CONSTRAINT "projects_work_scope_ck" CHECK (("projects"."lead_id" is not null and "projects"."customer_work_id" is null and "projects"."work_version" is null) or ("projects"."lead_id" is null and "projects"."customer_work_id" is not null and "projects"."work_version" is not null and "projects"."work_version" > 0));
ALTER TABLE "value_entries" ADD CONSTRAINT "value_entry_work_scope_ck" CHECK (("value_entries"."lead_id" is not null and "value_entries"."customer_work_id" is null) or ("value_entries"."lead_id" is null and "value_entries"."customer_work_id" is not null));
ALTER TABLE "value_entries" ADD CONSTRAINT "value_entry_work_refund_ck" CHECK (("value_entries"."customer_work_id" is null and "value_entries"."refund_of_value_entry_id" is null) or ("value_entries"."customer_work_id" is not null and (("value_entries"."kind" = 'refund' and "value_entries"."refund_of_value_entry_id" is not null and "value_entries"."refund_of_value_entry_id" <> "value_entries"."id") or ("value_entries"."kind" <> 'refund' and "value_entries"."refund_of_value_entry_id" is null))));
