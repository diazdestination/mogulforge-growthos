-- REVIEW ONLY. Contractor workday after0015 at 3f1f1b54f8436303d66e53083f62155431e9adef. No hosted approval.
-- Six new tables and one stored-object tenant parent key; no historical backfill.
ALTER TABLE "stored_objects" ADD CONSTRAINT "stored_objects_org_id_uq" UNIQUE("organization_id","id");
CREATE TABLE "appointment_work_completions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"appointment_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"property_id" uuid,
	"original_completion_id" uuid,
	"request_id" uuid NOT NULL,
	"payload_sha256" text NOT NULL,
	"actor_user_id" varchar NOT NULL,
	"snapshot" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "appointment_work_completions_org_id_uq" UNIQUE("organization_id","id"),
	CONSTRAINT "appointment_work_completions_visit_uq" UNIQUE("organization_id","id","appointment_id"),
	CONSTRAINT "appointment_work_completions_request_uq" UNIQUE("organization_id","request_id"),
	CONSTRAINT "appointment_work_completions_shape_ck" CHECK ("appointment_work_completions"."payload_sha256" ~ '^[a-f0-9]{64}$' AND jsonb_typeof("appointment_work_completions"."snapshot")='object' AND ("appointment_work_completions"."original_completion_id" IS NULL OR "appointment_work_completions"."original_completion_id"<>"appointment_work_completions"."id"))
);
CREATE TABLE "appointment_work_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"appointment_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"property_id" uuid,
	"asset_id" uuid,
	"service_obligation_id" uuid,
	"checklist_revision_id" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"state" text DEFAULT 'draft' NOT NULL,
	"parent_snapshot" jsonb NOT NULL,
	"asset_snapshot" jsonb,
	"answers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"completion_id" uuid,
	"created_by_user_id" varchar NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "appointment_work_entries_org_id_uq" UNIQUE("organization_id","id"),
	CONSTRAINT "appointment_work_entries_visit_uq" UNIQUE("organization_id","id","appointment_id"),
	CONSTRAINT "appointment_work_entries_state_ck" CHECK ("appointment_work_entries"."version">0 AND "appointment_work_entries"."state" IN ('draft','cancelled','finalized') AND (("appointment_work_entries"."state"='finalized' AND "appointment_work_entries"."completion_id" IS NOT NULL) OR ("appointment_work_entries"."state"<>'finalized' AND "appointment_work_entries"."completion_id" IS NULL)) AND (("appointment_work_entries"."asset_id" IS NULL AND "appointment_work_entries"."asset_snapshot" IS NULL) OR ("appointment_work_entries"."asset_id" IS NOT NULL AND "appointment_work_entries"."property_id" IS NOT NULL AND "appointment_work_entries"."asset_snapshot" IS NOT NULL)) AND jsonb_typeof("appointment_work_entries"."answers")='array' AND jsonb_array_length("appointment_work_entries"."answers")<=50)
);
CREATE TABLE "appointment_work_photos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"appointment_id" uuid NOT NULL,
	"entry_id" uuid NOT NULL,
	"reserved_object_id" uuid NOT NULL,
	"object_id" uuid,
	"request_id" uuid NOT NULL,
	"payload_sha256" text NOT NULL,
	"state" text DEFAULT 'reserved' NOT NULL,
	"item_key" text,
	"caption" text DEFAULT '' NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"object_sha256" text,
	"created_by_user_id" varchar NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"attached_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "appointment_work_photos_org_id_uq" UNIQUE("organization_id","id"),
	CONSTRAINT "appointment_work_photos_request_uq" UNIQUE("organization_id","request_id"),
	CONSTRAINT "appointment_work_photos_object_uq" UNIQUE("reserved_object_id"),
	CONSTRAINT "appointment_work_photos_shape_ck" CHECK ("appointment_work_photos"."state" IN ('reserved','attached','expired') AND "appointment_work_photos"."size_bytes">0 AND "appointment_work_photos"."size_bytes"<=10485760 AND "appointment_work_photos"."content_type" IN ('image/jpeg','image/png','image/webp') AND "appointment_work_photos"."payload_sha256" ~ '^[a-f0-9]{64}$' AND (("appointment_work_photos"."state"='attached' AND "appointment_work_photos"."object_id" IS NOT NULL AND "appointment_work_photos"."object_id"="appointment_work_photos"."reserved_object_id" AND "appointment_work_photos"."attached_at" IS NOT NULL AND "appointment_work_photos"."object_sha256" IS NOT NULL AND "appointment_work_photos"."object_sha256" ~ '^[a-f0-9]{64}$') OR ("appointment_work_photos"."state"<>'attached' AND "appointment_work_photos"."object_id" IS NULL AND "appointment_work_photos"."attached_at" IS NULL AND "appointment_work_photos"."object_sha256" IS NULL)))
);
CREATE TABLE "property_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"facts" jsonb NOT NULL,
	"created_by_user_id" varchar NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "property_assets_org_id_uq" UNIQUE("organization_id","id"),
	CONSTRAINT "property_assets_scope_uq" UNIQUE("organization_id","id","contact_id","property_id"),
	CONSTRAINT "property_assets_state_ck" CHECK ("property_assets"."version">0 AND "property_assets"."status" IN ('active','retired') AND jsonb_typeof("property_assets"."facts")='object')
);
CREATE TABLE "work_checklist_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"template_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"definition" jsonb NOT NULL,
	"definition_sha256" text NOT NULL,
	"baseline_id" text,
	"baseline_version" integer,
	"created_by_user_id" varchar NOT NULL,
	"reviewed_by_user_id" varchar,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "work_checklist_revisions_org_id_uq" UNIQUE("organization_id","id"),
	CONSTRAINT "work_checklist_revisions_number_uq" UNIQUE("organization_id","template_id","version"),
	CONSTRAINT "work_checklist_revisions_shape_ck" CHECK ("work_checklist_revisions"."version">0 AND "work_checklist_revisions"."definition_sha256" ~ '^[a-f0-9]{64}$' AND jsonb_typeof("work_checklist_revisions"."definition")='object' AND (("work_checklist_revisions"."reviewed_at" IS NULL AND "work_checklist_revisions"."reviewed_by_user_id" IS NULL) OR ("work_checklist_revisions"."reviewed_at" IS NOT NULL AND "work_checklist_revisions"."reviewed_by_user_id" IS NOT NULL)) AND (("work_checklist_revisions"."baseline_id" IS NULL AND "work_checklist_revisions"."baseline_version" IS NULL) OR ("work_checklist_revisions"."baseline_id" IS NOT NULL AND "work_checklist_revisions"."baseline_version" IS NOT NULL AND "work_checklist_revisions"."baseline_version">0)))
);
CREATE TABLE "work_checklist_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"created_by_user_id" varchar NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "work_checklist_templates_org_id_uq" UNIQUE("organization_id","id"),
	CONSTRAINT "work_checklist_templates_state_ck" CHECK ("work_checklist_templates"."version">0 AND "work_checklist_templates"."status" IN ('draft','reviewed','retired'))
);
ALTER TABLE "appointment_work_completions" ADD CONSTRAINT "appointment_work_completions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "appointment_work_completions" ADD CONSTRAINT "appointment_work_completions_original_completion_id_appointment_work_completions_id_fk" FOREIGN KEY ("original_completion_id") REFERENCES "public"."appointment_work_completions"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "appointment_work_completions" ADD CONSTRAINT "appointment_work_completions_appointment_fk" FOREIGN KEY ("organization_id","appointment_id") REFERENCES "public"."appointments"("organization_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "appointment_work_completions" ADD CONSTRAINT "appointment_work_completions_contact_fk" FOREIGN KEY ("organization_id","contact_id") REFERENCES "public"."contacts"("organization_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "appointment_work_completions" ADD CONSTRAINT "appointment_work_completions_property_fk" FOREIGN KEY ("organization_id","property_id") REFERENCES "public"."properties"("organization_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "appointment_work_completions" ADD CONSTRAINT "appointment_work_completions_actor_fk" FOREIGN KEY ("organization_id","actor_user_id") REFERENCES "public"."users"("organization_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "appointment_work_completions" ADD CONSTRAINT "appointment_work_completions_original_fk" FOREIGN KEY ("organization_id","original_completion_id","appointment_id") REFERENCES "public"."appointment_work_completions"("organization_id","id","appointment_id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "appointment_work_entries" ADD CONSTRAINT "appointment_work_entries_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "appointment_work_entries" ADD CONSTRAINT "appointment_work_entries_appointment_fk" FOREIGN KEY ("organization_id","appointment_id") REFERENCES "public"."appointments"("organization_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "appointment_work_entries" ADD CONSTRAINT "appointment_work_entries_contact_fk" FOREIGN KEY ("organization_id","contact_id") REFERENCES "public"."contacts"("organization_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "appointment_work_entries" ADD CONSTRAINT "appointment_work_entries_property_fk" FOREIGN KEY ("organization_id","property_id") REFERENCES "public"."properties"("organization_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "appointment_work_entries" ADD CONSTRAINT "appointment_work_entries_asset_fk" FOREIGN KEY ("organization_id","asset_id","contact_id","property_id") REFERENCES "public"."property_assets"("organization_id","id","contact_id","property_id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "appointment_work_entries" ADD CONSTRAINT "appointment_work_entries_service_fk" FOREIGN KEY ("organization_id","service_obligation_id") REFERENCES "public"."service_obligations"("organization_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "appointment_work_entries" ADD CONSTRAINT "appointment_work_entries_revision_fk" FOREIGN KEY ("organization_id","checklist_revision_id") REFERENCES "public"."work_checklist_revisions"("organization_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "appointment_work_entries" ADD CONSTRAINT "appointment_work_entries_completion_fk" FOREIGN KEY ("organization_id","completion_id","appointment_id") REFERENCES "public"."appointment_work_completions"("organization_id","id","appointment_id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "appointment_work_entries" ADD CONSTRAINT "appointment_work_entries_actor_fk" FOREIGN KEY ("organization_id","created_by_user_id") REFERENCES "public"."users"("organization_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "appointment_work_photos" ADD CONSTRAINT "appointment_work_photos_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "appointment_work_photos" ADD CONSTRAINT "appointment_work_photos_entry_fk" FOREIGN KEY ("organization_id","entry_id","appointment_id") REFERENCES "public"."appointment_work_entries"("organization_id","id","appointment_id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "appointment_work_photos" ADD CONSTRAINT "appointment_work_photos_object_fk" FOREIGN KEY ("organization_id","object_id") REFERENCES "public"."stored_objects"("organization_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "appointment_work_photos" ADD CONSTRAINT "appointment_work_photos_actor_fk" FOREIGN KEY ("organization_id","created_by_user_id") REFERENCES "public"."users"("organization_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "property_assets" ADD CONSTRAINT "property_assets_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "property_assets" ADD CONSTRAINT "property_assets_contact_fk" FOREIGN KEY ("organization_id","contact_id") REFERENCES "public"."contacts"("organization_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "property_assets" ADD CONSTRAINT "property_assets_property_fk" FOREIGN KEY ("organization_id","property_id") REFERENCES "public"."properties"("organization_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "property_assets" ADD CONSTRAINT "property_assets_actor_fk" FOREIGN KEY ("organization_id","created_by_user_id") REFERENCES "public"."users"("organization_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "work_checklist_revisions" ADD CONSTRAINT "work_checklist_revisions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "work_checklist_revisions" ADD CONSTRAINT "work_checklist_revisions_template_fk" FOREIGN KEY ("organization_id","template_id") REFERENCES "public"."work_checklist_templates"("organization_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "work_checklist_revisions" ADD CONSTRAINT "work_checklist_revisions_creator_fk" FOREIGN KEY ("organization_id","created_by_user_id") REFERENCES "public"."users"("organization_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "work_checklist_revisions" ADD CONSTRAINT "work_checklist_revisions_reviewer_fk" FOREIGN KEY ("organization_id","reviewed_by_user_id") REFERENCES "public"."users"("organization_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "work_checklist_templates" ADD CONSTRAINT "work_checklist_templates_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "work_checklist_templates" ADD CONSTRAINT "work_checklist_templates_actor_fk" FOREIGN KEY ("organization_id","created_by_user_id") REFERENCES "public"."users"("organization_id","id") ON DELETE no action ON UPDATE no action;
CREATE UNIQUE INDEX "appointment_work_completions_original_uq" ON "appointment_work_completions" USING btree ("organization_id","appointment_id") WHERE "appointment_work_completions"."original_completion_id" IS NULL;
CREATE INDEX "appointment_work_entries_visit_idx" ON "appointment_work_entries" USING btree ("organization_id","appointment_id");
CREATE INDEX "property_assets_customer_page_idx" ON "property_assets" USING btree ("organization_id","contact_id","created_at","id");
