-- REVIEW ONLY. Additive native contractor day after 0005 at 48c3491c75ea31abf347deee59f8faf17d63136a. Not production approval.
CREATE TABLE "invoice_operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"fingerprint" text NOT NULL,
	"action" text NOT NULL,
	"version" integer NOT NULL,
	"actor_user_id" varchar NOT NULL,
	"reason" text,
	"result_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
;
CREATE TABLE "invoice_receipt_allocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"value_entry_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"reverses_allocation_id" uuid,
	"actor_user_id" varchar NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoice_allocation_amount_positive" CHECK ("invoice_receipt_allocations"."amount_cents" > 0 and "invoice_receipt_allocations"."amount_cents" <= 1000000000),
	CONSTRAINT "invoice_allocation_kind_valid" CHECK ("invoice_receipt_allocations"."kind" in ('payment', 'refund', 'reversal')),
	CONSTRAINT "invoice_allocation_reversal_link" CHECK (("invoice_receipt_allocations"."kind" = 'reversal' and "invoice_receipt_allocations"."reverses_allocation_id" is not null and "invoice_receipt_allocations"."reason" is not null) or ("invoice_receipt_allocations"."kind" in ('payment', 'refund') and "invoice_receipt_allocations"."reverses_allocation_id" is null))
);
;
CREATE TABLE "invoice_sequences" (
	"organization_id" uuid PRIMARY KEY NOT NULL,
	"next_number" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "invoice_sequence_positive" CHECK ("invoice_sequences"."next_number" > 0)
);
;
CREATE TABLE "invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"lead_id" uuid NOT NULL,
	"project_id" uuid,
	"estimate_id" uuid,
	"status" text DEFAULT 'draft' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"invoice_number" text,
	"draft_document" jsonb NOT NULL,
	"issued_document" jsonb,
	"issued_document_sha256" text,
	"issued_at" timestamp with time zone,
	"voided_at" timestamp with time zone,
	"void_reason" text,
	"created_by_user_id" varchar NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoice_state_valid" CHECK ("invoices"."status" in ('draft', 'issued', 'void')),
	CONSTRAINT "invoice_version_positive" CHECK ("invoices"."version" > 0),
	CONSTRAINT "invoice_issued_snapshot_present" CHECK ("invoices"."status" <> 'issued' or ("invoices"."invoice_number" is not null and "invoices"."issued_document" is not null and "invoices"."issued_document_sha256" is not null and "invoices"."issued_at" is not null)),
	CONSTRAINT "invoice_void_reason_present" CHECK ("invoices"."status" <> 'void' or ("invoices"."void_reason" is not null and "invoices"."voided_at" is not null))
);
;
ALTER TABLE "service_obligations" ADD COLUMN "recurrence" jsonb;;
ALTER TABLE "service_obligations" ADD COLUMN "predecessor_obligation_id" uuid;;
ALTER TABLE "service_obligations" ADD COLUMN "occurrence_index" integer DEFAULT 0 NOT NULL;;
ALTER TABLE "service_obligations" ADD COLUMN "coverage_starts_on" text;;
ALTER TABLE "service_obligations" ADD COLUMN "coverage_ends_on" text;;
ALTER TABLE "service_obligations" ADD COLUMN "coverage_evidence" text;;
ALTER TABLE "service_obligations" ADD COLUMN "completion_note" text;;
ALTER TABLE "invoice_operations" ADD CONSTRAINT "invoice_operations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;;
ALTER TABLE "invoice_operations" ADD CONSTRAINT "invoice_operations_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;;
ALTER TABLE "invoice_operations" ADD CONSTRAINT "invoice_operations_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;;
ALTER TABLE "invoice_receipt_allocations" ADD CONSTRAINT "invoice_receipt_allocations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;;
ALTER TABLE "invoice_receipt_allocations" ADD CONSTRAINT "invoice_receipt_allocations_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;;
ALTER TABLE "invoice_receipt_allocations" ADD CONSTRAINT "invoice_receipt_allocations_value_entry_id_value_entries_id_fk" FOREIGN KEY ("value_entry_id") REFERENCES "public"."value_entries"("id") ON DELETE no action ON UPDATE no action;;
ALTER TABLE "invoice_receipt_allocations" ADD CONSTRAINT "invoice_receipt_allocations_reverses_allocation_id_invoice_receipt_allocations_id_fk" FOREIGN KEY ("reverses_allocation_id") REFERENCES "public"."invoice_receipt_allocations"("id") ON DELETE no action ON UPDATE no action;;
ALTER TABLE "invoice_receipt_allocations" ADD CONSTRAINT "invoice_receipt_allocations_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;;
ALTER TABLE "invoice_sequences" ADD CONSTRAINT "invoice_sequences_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;;
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;;
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE no action ON UPDATE no action;;
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;;
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_estimate_id_estimates_id_fk" FOREIGN KEY ("estimate_id") REFERENCES "public"."estimates"("id") ON DELETE no action ON UPDATE no action;;
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;;
CREATE UNIQUE INDEX "invoice_operation_org_request_unique" ON "invoice_operations" USING btree ("organization_id","request_id");;
CREATE INDEX "invoice_operations_org_invoice" ON "invoice_operations" USING btree ("organization_id","invoice_id","created_at");;
CREATE UNIQUE INDEX "invoice_allocation_reversal_unique" ON "invoice_receipt_allocations" USING btree ("reverses_allocation_id");;
CREATE INDEX "invoice_allocations_org_invoice" ON "invoice_receipt_allocations" USING btree ("organization_id","invoice_id");;
CREATE INDEX "invoice_allocations_org_value_entry" ON "invoice_receipt_allocations" USING btree ("organization_id","value_entry_id");;
CREATE UNIQUE INDEX "invoice_org_number_unique" ON "invoices" USING btree ("organization_id","invoice_number");;
CREATE INDEX "invoices_org_status_created" ON "invoices" USING btree ("organization_id","status","created_at");;
CREATE INDEX "invoices_org_lead" ON "invoices" USING btree ("organization_id","lead_id");;
CREATE INDEX "invoices_org_project" ON "invoices" USING btree ("organization_id","project_id");;
ALTER TABLE "service_obligations" ADD CONSTRAINT "service_obligations_predecessor_obligation_id_service_obligations_id_fk" FOREIGN KEY ("predecessor_obligation_id") REFERENCES "public"."service_obligations"("id") ON DELETE no action ON UPDATE no action;;
CREATE UNIQUE INDEX "service_obligations_predecessor_uq" ON "service_obligations" USING btree ("predecessor_obligation_id");;
