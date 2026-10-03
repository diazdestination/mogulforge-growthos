-- REVIEW ONLY. Finite source nurture after 0013 at 110f14563dc5d581fd4550e8410d947b39141c36. No hosted approval.
ALTER TABLE "properties" ADD CONSTRAINT "properties_org_id_uq" UNIQUE("organization_id","id");
CREATE TABLE "contact_touch_reservations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"logical_key" text NOT NULL,
	"contact_id" uuid NOT NULL,
	"address" text NOT NULL,
	"channel" text NOT NULL,
	"source_kind" text NOT NULL,
	"payload_hash" text NOT NULL,
	"reserved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"dispatch_started_at" timestamp with time zone,
	"accepted_at" timestamp with time zone,
	CONSTRAINT "contact_touch_org_id_uq" UNIQUE("organization_id","id"),
	CONSTRAINT "contact_touch_logical_key_uq" UNIQUE("organization_id","logical_key"),
	CONSTRAINT "contact_touch_kind_ck" CHECK ("contact_touch_reservations"."channel" in ('email','sms') and "contact_touch_reservations"."source_kind" in ('bie','source','nurture','service','playbook','automation')),
	CONSTRAINT "contact_touch_hash_ck" CHECK ("contact_touch_reservations"."payload_hash" ~ '^[0-9a-f]{64}$')
);
CREATE TABLE "mailbox_sync_cycles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"connector_id" uuid NOT NULL,
	"connector_version" integer NOT NULL,
	"sequence" integer NOT NULL,
	"fresh_boundary" boolean DEFAULT true NOT NULL,
	"nurture_monitoring_version" integer NOT NULL,
	"nurture_monitoring_approved_at" timestamp with time zone NOT NULL,
	"state" text DEFAULT 'scanning' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_completed_at" timestamp with time zone,
	"inbox_completed_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"error_code" text,
	CONSTRAINT "mailbox_sync_cycle_org_id_uq" UNIQUE("organization_id","id"),
	CONSTRAINT "mailbox_sync_cycle_sequence_uq" UNIQUE("organization_id","connector_id","connector_version","sequence"),
	CONSTRAINT "mailbox_sync_cycle_boundary_ck" CHECK ("mailbox_sync_cycles"."state" <> 'complete' or "mailbox_sync_cycles"."fresh_boundary"),
	CONSTRAINT "mailbox_sync_cycle_shape_ck" CHECK ("mailbox_sync_cycles"."sequence" > 0 and "mailbox_sync_cycles"."connector_version" > 0 and "mailbox_sync_cycles"."nurture_monitoring_version" > 0 and "mailbox_sync_cycles"."started_at" >= "mailbox_sync_cycles"."nurture_monitoring_approved_at" and "mailbox_sync_cycles"."state" in ('scanning','complete','failed') and ("mailbox_sync_cycles"."sent_completed_at" is null or "mailbox_sync_cycles"."sent_completed_at" >= "mailbox_sync_cycles"."started_at") and ("mailbox_sync_cycles"."inbox_completed_at" is null or ("mailbox_sync_cycles"."sent_completed_at" is not null and "mailbox_sync_cycles"."inbox_completed_at" >= "mailbox_sync_cycles"."sent_completed_at")) and (("mailbox_sync_cycles"."state" = 'complete' and "mailbox_sync_cycles"."completed_at" is not null and "mailbox_sync_cycles"."sent_completed_at" is not null and "mailbox_sync_cycles"."inbox_completed_at" is not null and "mailbox_sync_cycles"."completed_at" >= "mailbox_sync_cycles"."inbox_completed_at" and "mailbox_sync_cycles"."failed_at" is null and "mailbox_sync_cycles"."error_code" is null) or ("mailbox_sync_cycles"."state" = 'scanning' and "mailbox_sync_cycles"."completed_at" is null and "mailbox_sync_cycles"."failed_at" is null and "mailbox_sync_cycles"."error_code" is null) or ("mailbox_sync_cycles"."state" = 'failed' and "mailbox_sync_cycles"."completed_at" is null and "mailbox_sync_cycles"."failed_at" is not null and "mailbox_sync_cycles"."failed_at" >= "mailbox_sync_cycles"."started_at" and "mailbox_sync_cycles"."error_code" is not null)))
);
CREATE TABLE "source_nurture_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"lead_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"property_id" uuid,
	"owner_user_id" varchar NOT NULL,
	"adoption_id" uuid NOT NULL,
	"recipient" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	"admitted_at" timestamp with time zone,
	"stopped_at" timestamp with time zone,
	"stop_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_nurture_item_org_id_uq" UNIQUE("organization_id","id"),
	CONSTRAINT "source_nurture_item_context_uq" UNIQUE("organization_id","id","plan_id","lead_id","contact_id"),
	CONSTRAINT "source_nurture_item_plan_lead_uq" UNIQUE("plan_id","lead_id"),
	CONSTRAINT "source_nurture_item_plan_address_uq" UNIQUE("plan_id","recipient"),
	CONSTRAINT "source_nurture_address_ck" CHECK ("source_nurture_items"."recipient" = lower(btrim("source_nurture_items"."recipient")) and length("source_nurture_items"."recipient") > 3)
);
CREATE TABLE "source_nurture_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"state" text DEFAULT 'draft' NOT NULL,
	"settings" jsonb NOT NULL,
	"payload_sha256" text NOT NULL,
	"review_id" uuid NOT NULL,
	"created_by_user_id" varchar NOT NULL,
	"approved_by_user_id" varchar,
	"approved_at" timestamp with time zone,
	"preview_expires_at" timestamp with time zone NOT NULL,
	"start_not_before" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"start_request_id" uuid,
	"start_payload_hash" text,
	"started_at" timestamp with time zone,
	"stop_request_id" uuid,
	"stop_payload_hash" text,
	"stopped_at" timestamp with time zone,
	"stop_reason" text,
	"next_check_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_checked_at" timestamp with time zone,
	"last_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_nurture_plan_org_id_uq" UNIQUE("organization_id","id"),
	CONSTRAINT "source_nurture_plan_review_uq" UNIQUE("organization_id","review_id"),
	CONSTRAINT "source_nurture_plan_state_ck" CHECK ("source_nurture_plans"."state" in ('draft','approved','running','stopped','finished','expired') and "source_nurture_plans"."version" > 0),
	CONSTRAINT "source_nurture_plan_dates_ck" CHECK ("source_nurture_plans"."start_not_before" < "source_nurture_plans"."expires_at" and "source_nurture_plans"."expires_at" <= "source_nurture_plans"."created_at" + interval '14 days'),
	CONSTRAINT "source_nurture_plan_start_ck" CHECK (("source_nurture_plans"."started_at" is null and "source_nurture_plans"."start_request_id" is null and "source_nurture_plans"."start_payload_hash" is null) or ("source_nurture_plans"."started_at" is not null and "source_nurture_plans"."start_request_id" is not null and "source_nurture_plans"."start_payload_hash" is not null))
);
CREATE TABLE "source_nurture_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"lead_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"step_index" integer NOT NULL,
	"predecessor_id" uuid,
	"scheduled_action_id" uuid,
	"subject" text NOT NULL,
	"body" text NOT NULL,
	"message_hash" text NOT NULL,
	"not_before" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"claimed_at" timestamp with time zone,
	"accepted_at" timestamp with time zone,
	"acceptance_audit_id" uuid,
	"cancelled_at" timestamp with time zone,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_nurture_step_org_id_uq" UNIQUE("organization_id","id"),
	CONSTRAINT "source_nurture_step_parent_context_uq" UNIQUE("organization_id","id","lead_id","contact_id"),
	CONSTRAINT "source_nurture_step_item_context_uq" UNIQUE("organization_id","item_id","id"),
	CONSTRAINT "source_nurture_step_index_uq" UNIQUE("item_id","step_index"),
	CONSTRAINT "source_nurture_step_action_uq" UNIQUE("organization_id","scheduled_action_id"),
	CONSTRAINT "source_nurture_step_number_ck" CHECK (("source_nurture_steps"."step_index" = 1 and "source_nurture_steps"."predecessor_id" is null) or ("source_nurture_steps"."step_index" = 2 and "source_nurture_steps"."predecessor_id" is not null and "source_nurture_steps"."predecessor_id" <> "source_nurture_steps"."id")),
	CONSTRAINT "source_nurture_step_acceptance_ck" CHECK (("source_nurture_steps"."accepted_at" is null and "source_nurture_steps"."acceptance_audit_id" is null) or ("source_nurture_steps"."accepted_at" is not null and "source_nurture_steps"."acceptance_audit_id" is not null and "source_nurture_steps"."claimed_at" is not null))
);
ALTER TABLE "mailbox_communication_parents" ADD COLUMN "source_nurture_step_id" uuid;
ALTER TABLE "mailbox_connectors" ADD COLUMN "nurture_monitoring_enabled" boolean DEFAULT false NOT NULL;
ALTER TABLE "mailbox_connectors" ADD COLUMN "nurture_monitoring_version" integer DEFAULT 0 NOT NULL;
ALTER TABLE "mailbox_connectors" ADD COLUMN "nurture_monitoring_approved_at" timestamp with time zone;
ALTER TABLE "mailbox_connectors" ADD COLUMN "nurture_monitoring_changed_at" timestamp with time zone;
ALTER TABLE "contact_touch_reservations" ADD CONSTRAINT "contact_touch_reservations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "contact_touch_reservations" ADD CONSTRAINT "contact_touch_contact_fk" FOREIGN KEY ("organization_id","contact_id") REFERENCES "public"."contacts"("organization_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "mailbox_sync_cycles" ADD CONSTRAINT "mailbox_sync_cycles_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "mailbox_sync_cycles" ADD CONSTRAINT "mailbox_sync_cycle_connector_fk" FOREIGN KEY ("organization_id","connector_id") REFERENCES "public"."mailbox_connectors"("organization_id","id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "source_nurture_items" ADD CONSTRAINT "source_nurture_items_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "source_nurture_items" ADD CONSTRAINT "source_nurture_item_plan_fk" FOREIGN KEY ("organization_id","plan_id") REFERENCES "public"."source_nurture_plans"("organization_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "source_nurture_items" ADD CONSTRAINT "source_nurture_item_lead_fk" FOREIGN KEY ("organization_id","lead_id") REFERENCES "public"."leads"("organization_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "source_nurture_items" ADD CONSTRAINT "source_nurture_item_contact_fk" FOREIGN KEY ("organization_id","contact_id") REFERENCES "public"."contacts"("organization_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "source_nurture_items" ADD CONSTRAINT "source_nurture_item_property_fk" FOREIGN KEY ("organization_id","property_id") REFERENCES "public"."properties"("organization_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "source_nurture_items" ADD CONSTRAINT "source_nurture_item_owner_fk" FOREIGN KEY ("organization_id","owner_user_id") REFERENCES "public"."users"("organization_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "source_nurture_items" ADD CONSTRAINT "source_nurture_item_adoption_fk" FOREIGN KEY ("organization_id","adoption_id") REFERENCES "public"."source_adoptions"("organization_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "source_nurture_plans" ADD CONSTRAINT "source_nurture_plans_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "source_nurture_plans" ADD CONSTRAINT "source_nurture_creator_fk" FOREIGN KEY ("organization_id","created_by_user_id") REFERENCES "public"."users"("organization_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "source_nurture_plans" ADD CONSTRAINT "source_nurture_approver_fk" FOREIGN KEY ("organization_id","approved_by_user_id") REFERENCES "public"."users"("organization_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "source_nurture_plans" ADD CONSTRAINT "source_nurture_review_fk" FOREIGN KEY ("organization_id","review_id") REFERENCES "public"."audit_events"("organization_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "source_nurture_steps" ADD CONSTRAINT "source_nurture_steps_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "source_nurture_steps" ADD CONSTRAINT "source_nurture_step_item_fk" FOREIGN KEY ("organization_id","item_id","plan_id","lead_id","contact_id") REFERENCES "public"."source_nurture_items"("organization_id","id","plan_id","lead_id","contact_id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "source_nurture_steps" ADD CONSTRAINT "source_nurture_step_previous_fk" FOREIGN KEY ("organization_id","item_id","predecessor_id") REFERENCES "public"."source_nurture_steps"("organization_id","item_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "source_nurture_steps" ADD CONSTRAINT "source_nurture_step_action_fk" FOREIGN KEY ("organization_id","scheduled_action_id") REFERENCES "public"."scheduled_actions"("organization_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "source_nurture_steps" ADD CONSTRAINT "source_nurture_acceptance_fk" FOREIGN KEY ("organization_id","acceptance_audit_id") REFERENCES "public"."audit_events"("organization_id","id") ON DELETE no action ON UPDATE no action;
CREATE INDEX "contact_touch_window_idx" ON "contact_touch_reservations" USING btree ("organization_id","contact_id","reserved_at");
CREATE UNIQUE INDEX "mailbox_sync_cycle_active_uq" ON "mailbox_sync_cycles" USING btree ("organization_id","connector_id","connector_version") WHERE "mailbox_sync_cycles"."state" = 'scanning';
CREATE INDEX "mailbox_sync_cycle_latest_idx" ON "mailbox_sync_cycles" USING btree ("organization_id","connector_id","connector_version","sequence");
CREATE UNIQUE INDEX "source_nurture_owned_lead_uq" ON "source_nurture_items" USING btree ("organization_id","lead_id") WHERE "source_nurture_items"."admitted_at" is not null;
CREATE UNIQUE INDEX "source_nurture_owned_address_uq" ON "source_nurture_items" USING btree ("organization_id","recipient") WHERE "source_nurture_items"."admitted_at" is not null;
CREATE UNIQUE INDEX "source_nurture_start_request_uq" ON "source_nurture_plans" USING btree ("organization_id","start_request_id");
CREATE UNIQUE INDEX "source_nurture_stop_request_uq" ON "source_nurture_plans" USING btree ("organization_id","stop_request_id");
CREATE INDEX "source_nurture_plan_check_idx" ON "source_nurture_plans" USING btree ("state","next_check_at");
ALTER TABLE "mailbox_communication_parents" ADD CONSTRAINT "mailbox_parent_nurture_step_fk" FOREIGN KEY ("organization_id","source_nurture_step_id","lead_id","contact_id") REFERENCES "public"."source_nurture_steps"("organization_id","id","lead_id","contact_id") ON DELETE no action ON UPDATE no action;
CREATE UNIQUE INDEX "mailbox_parent_nurture_step_uq" ON "mailbox_communication_parents" USING btree ("organization_id","source_nurture_step_id") WHERE "mailbox_communication_parents"."source_nurture_step_id" is not null;
ALTER TABLE "mailbox_communication_parents" ADD CONSTRAINT "mailbox_parent_nurture_context_ck" CHECK (("mailbox_communication_parents"."source_nurture_step_id" is null and coalesce("mailbox_communication_parents"."context_snapshot"->>'kind','') <> 'source_nurture_email') or ("mailbox_communication_parents"."source_nurture_step_id" is not null and "mailbox_communication_parents"."lead_id" is not null and "mailbox_communication_parents"."service_obligation_id" is null and coalesce("mailbox_communication_parents"."context_snapshot"->>'kind' = 'source_nurture_email' and "mailbox_communication_parents"."context_snapshot"->>'version' = '1' and "mailbox_communication_parents"."context_snapshot"->>'stepId' = "mailbox_communication_parents"."source_nurture_step_id"::text and "mailbox_communication_parents"."context_snapshot"->>'leadId' = "mailbox_communication_parents"."lead_id"::text and "mailbox_communication_parents"."context_snapshot"->>'contactId' = "mailbox_communication_parents"."contact_id"::text and "mailbox_communication_parents"."context_snapshot"->>'stepIndex' in ('1','2') and "mailbox_communication_parents"."context_snapshot"->>'planFingerprint' ~ '^[a-f0-9]{64}$' and "mailbox_communication_parents"."action_key" = 'scheduled:' || ("mailbox_communication_parents"."context_snapshot"->>'scheduledActionId'),false)));
ALTER TABLE "mailbox_connectors" ADD CONSTRAINT "mailbox_connector_nurture_monitoring_ck" CHECK ("mailbox_connectors"."nurture_monitoring_version" >= 0 and (not "mailbox_connectors"."nurture_monitoring_enabled" or ("mailbox_connectors"."nurture_monitoring_version" > 0 and "mailbox_connectors"."nurture_monitoring_approved_at" is not null and "mailbox_connectors"."nurture_monitoring_changed_at" is not null)));
