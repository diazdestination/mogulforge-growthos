-- REVIEW ONLY. Standing service reminders after 0012 at f91e1c31413a4b5307ca334c04773e3c0e5bef84. No hosted approval.
ALTER TABLE "scheduled_actions" ADD CONSTRAINT "scheduled_action_org_id_uq" UNIQUE("organization_id","id");
ALTER TABLE "twilio_dispatches" ADD CONSTRAINT "twilio_dispatch_org_id_uq" UNIQUE("organization_id","id");
ALTER TABLE "twilio_dispatches" ADD CONSTRAINT "twilio_dispatch_exact_service_uq" UNIQUE("organization_id","id","idempotency_key","account_sid","phone");
CREATE TABLE "service_sms_parents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"service_obligation_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"binding_id" uuid NOT NULL,
	"approval_id" uuid NOT NULL,
	"scheduled_action_id" uuid NOT NULL,
	"action_key" text NOT NULL,
	"execution_id" uuid NOT NULL,
	"execution_fingerprint" text NOT NULL,
	"authorization_fingerprint" text NOT NULL,
	"context_snapshot" jsonb NOT NULL,
	"reference" text NOT NULL,
	"template_version" integer DEFAULT 1 NOT NULL,
	"account_sid" text NOT NULL,
	"sender" text NOT NULL,
	"recipient" text NOT NULL,
	"messaging_service_sid" text NOT NULL,
	"disclosure_version" text NOT NULL,
	"binding_fingerprint" text NOT NULL,
	"body_sha256" text NOT NULL,
	"operation_key" text NOT NULL,
	"dispatch_id" uuid,
	"dispatch_payload_hash" text,
	"reserved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"dispatch_started_at" timestamp with time zone,
	CONSTRAINT "service_sms_parent_org_id_uq" UNIQUE("organization_id","id"),
	CONSTRAINT "service_sms_parent_exact_uq" UNIQUE("organization_id","id","service_obligation_id","contact_id","binding_id","account_sid","recipient","sender"),
	CONSTRAINT "service_sms_parent_occurrence_uq" UNIQUE("organization_id","service_obligation_id"),
	CONSTRAINT "service_sms_parent_action_uq" UNIQUE("organization_id","action_key"),
	CONSTRAINT "service_sms_parent_reference_uq" UNIQUE("organization_id","reference"),
	CONSTRAINT "service_sms_parent_format_ck" CHECK ("service_sms_parents"."template_version" = 1 and "service_sms_parents"."reference" ~ '^[a-f0-9]{16}$' and "service_sms_parents"."account_sid" ~ '^AC[a-fA-F0-9]{32}$' and "service_sms_parents"."messaging_service_sid" ~ '^MG[a-fA-F0-9]{32}$' and "service_sms_parents"."sender" ~ '^\+1[2-9][0-9]{9}$' and "service_sms_parents"."recipient" ~ '^\+1[2-9][0-9]{9}$' and "service_sms_parents"."execution_fingerprint" ~ '^[a-f0-9]{64}$' and "service_sms_parents"."authorization_fingerprint" ~ '^[a-f0-9]{64}$' and "service_sms_parents"."binding_fingerprint" ~ '^[a-f0-9]{64}$' and "service_sms_parents"."body_sha256" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "service_sms_parent_dispatch_ck" CHECK (("service_sms_parents"."dispatch_started_at" is null and "service_sms_parents"."dispatch_id" is null and "service_sms_parents"."dispatch_payload_hash" is null) or ("service_sms_parents"."dispatch_started_at" is not null and "service_sms_parents"."dispatch_id" is not null and "service_sms_parents"."dispatch_payload_hash" is not null and "service_sms_parents"."dispatch_payload_hash" ~ '^[a-f0-9]{64}$')),
	CONSTRAINT "service_sms_parent_keys_ck" CHECK ("service_sms_parents"."action_key" = 'scheduled:' || "service_sms_parents"."scheduled_action_id"::text and "service_sms_parents"."operation_key" = 'service-care:' || "service_sms_parents"."service_obligation_id"::text)
);
CREATE TABLE "service_sms_replies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"binding_id" uuid NOT NULL,
	"message_sid" text NOT NULL,
	"account_sid" text NOT NULL,
	"from_number" text NOT NULL,
	"to_number" text NOT NULL,
	"messaging_service_sid" text,
	"payload_sha256" text NOT NULL,
	"body_sha256" text NOT NULL,
	"parent_id" uuid,
	"service_obligation_id" uuid,
	"contact_id" uuid,
	"correlation" text NOT NULL,
	"reason" text NOT NULL,
	"candidate_parent_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"candidate_count" integer NOT NULL,
	"candidates_truncated" boolean DEFAULT false NOT NULL,
	"historical" boolean DEFAULT false NOT NULL,
	"hold_active" boolean DEFAULT true NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"state" text DEFAULT 'needs_review' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"encrypted_text" text,
	"raw_expires_at" timestamp with time zone NOT NULL,
	"raw_purged_at" timestamp with time zone,
	"reviewed_by_user_id" varchar,
	"reviewed_at" timestamp with time zone,
	"review_note" text,
	"review_request_id" uuid,
	"review_fingerprint" text,
	CONSTRAINT "service_sms_reply_org_id_uq" UNIQUE("organization_id","id"),
	CONSTRAINT "service_sms_reply_message_uq" UNIQUE("organization_id","message_sid"),
	CONSTRAINT "service_sms_reply_correlation_ck" CHECK (("service_sms_replies"."correlation" = 'exact_reference' and "service_sms_replies"."parent_id" is not null and "service_sms_replies"."service_obligation_id" is not null and "service_sms_replies"."contact_id" is not null) or ("service_sms_replies"."correlation" = 'ambiguous' and "service_sms_replies"."parent_id" is null and "service_sms_replies"."service_obligation_id" is null and "service_sms_replies"."contact_id" is null and not "service_sms_replies"."historical")),
	CONSTRAINT "service_sms_reply_format_ck" CHECK ("service_sms_replies"."message_sid" ~ '^SM[a-fA-F0-9]{32}$' and "service_sms_replies"."account_sid" ~ '^AC[a-fA-F0-9]{32}$' and "service_sms_replies"."from_number" ~ '^\+1[2-9][0-9]{9}$' and "service_sms_replies"."to_number" ~ '^\+1[2-9][0-9]{9}$' and "service_sms_replies"."payload_sha256" ~ '^[a-f0-9]{64}$' and "service_sms_replies"."body_sha256" ~ '^[a-f0-9]{64}$' and "service_sms_replies"."candidate_count" >= 0 and jsonb_typeof("service_sms_replies"."candidate_parent_ids") = 'array'),
	CONSTRAINT "service_sms_reply_state_ck" CHECK ("service_sms_replies"."state" in ('needs_review','reviewed','dismissed') and "service_sms_replies"."version" > 0 and (not "service_sms_replies"."historical" or not "service_sms_replies"."hold_active") and ("service_sms_replies"."state" != 'dismissed' or not "service_sms_replies"."hold_active"))
);
CREATE TABLE "service_standing_enrollments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"series_root_obligation_id" uuid NOT NULL,
	"anchor_obligation_id" uuid NOT NULL,
	"created_by_user_id" varchar NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"next_check_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_checked_at" timestamp with time zone,
	"last_result_code" text,
	"last_materialized_obligation_id" uuid,
	CONSTRAINT "service_standing_enrollment_org_id_uq" UNIQUE("organization_id","id")
);
CREATE TABLE "service_standing_policy_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"enrollment_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"owner_user_id" varchar NOT NULL,
	"snapshot" jsonb NOT NULL,
	"review_id" uuid NOT NULL,
	"review_payload_hash" text NOT NULL,
	"approved_by_user_id" varchar NOT NULL,
	"approved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "service_standing_revision_org_id_uq" UNIQUE("organization_id","id"),
	CONSTRAINT "service_standing_revision_exact_uq" UNIQUE("organization_id","id","enrollment_id","version"),
	CONSTRAINT "service_standing_revision_version_ck" CHECK ("service_standing_policy_revisions"."version" > 0),
	CONSTRAINT "service_standing_revision_hash_ck" CHECK ("service_standing_policy_revisions"."review_payload_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "service_standing_revision_enabled_ck" CHECK (coalesce(jsonb_typeof("service_standing_policy_revisions"."snapshot"->'settings'->'enabled') = 'boolean' and ("service_standing_policy_revisions"."snapshot"->'settings'->>'enabled')::boolean = "service_standing_policy_revisions"."enabled", false))
);
ALTER TABLE "service_sms_parents" ADD CONSTRAINT "service_sms_parents_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "service_sms_parents" ADD CONSTRAINT "service_sms_parent_service_fk" FOREIGN KEY ("organization_id","service_obligation_id") REFERENCES "public"."service_obligations"("organization_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "service_sms_parents" ADD CONSTRAINT "service_sms_parent_contact_fk" FOREIGN KEY ("organization_id","contact_id") REFERENCES "public"."contacts"("organization_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "service_sms_parents" ADD CONSTRAINT "service_sms_parent_binding_fk" FOREIGN KEY ("organization_id","binding_id") REFERENCES "public"."twilio_client_bindings"("organization_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "service_sms_parents" ADD CONSTRAINT "service_sms_parent_approval_fk" FOREIGN KEY ("organization_id","approval_id") REFERENCES "public"."audit_events"("organization_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "service_sms_parents" ADD CONSTRAINT "service_sms_parent_scheduled_fk" FOREIGN KEY ("organization_id","scheduled_action_id") REFERENCES "public"."scheduled_actions"("organization_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "service_sms_parents" ADD CONSTRAINT "service_sms_parent_execution_fk" FOREIGN KEY ("organization_id","execution_id","action_key","execution_fingerprint") REFERENCES "public"."revenue_executions"("organization_id","id","action_key","fingerprint") ON DELETE no action ON UPDATE no action;
ALTER TABLE "service_sms_parents" ADD CONSTRAINT "service_sms_parent_dispatch_fk" FOREIGN KEY ("organization_id","dispatch_id","operation_key","account_sid","recipient") REFERENCES "public"."twilio_dispatches"("organization_id","id","idempotency_key","account_sid","phone") ON DELETE no action ON UPDATE no action;
ALTER TABLE "service_sms_replies" ADD CONSTRAINT "service_sms_replies_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "service_sms_replies" ADD CONSTRAINT "service_sms_reply_inbound_fk" FOREIGN KEY ("organization_id","message_sid") REFERENCES "public"."twilio_inbound_events"("organization_id","message_sid") ON DELETE no action ON UPDATE no action;
ALTER TABLE "service_sms_replies" ADD CONSTRAINT "service_sms_reply_binding_fk" FOREIGN KEY ("organization_id","binding_id") REFERENCES "public"."twilio_client_bindings"("organization_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "service_sms_replies" ADD CONSTRAINT "service_sms_reply_exact_parent_fk" FOREIGN KEY ("organization_id","parent_id","service_obligation_id","contact_id","binding_id","account_sid","from_number","to_number") REFERENCES "public"."service_sms_parents"("organization_id","id","service_obligation_id","contact_id","binding_id","account_sid","recipient","sender") ON DELETE no action ON UPDATE no action;
ALTER TABLE "service_sms_replies" ADD CONSTRAINT "service_sms_reply_reviewer_fk" FOREIGN KEY ("organization_id","reviewed_by_user_id") REFERENCES "public"."users"("organization_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "service_standing_enrollments" ADD CONSTRAINT "service_standing_enrollments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "service_standing_enrollments" ADD CONSTRAINT "service_standing_root_fk" FOREIGN KEY ("organization_id","series_root_obligation_id") REFERENCES "public"."service_obligations"("organization_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "service_standing_enrollments" ADD CONSTRAINT "service_standing_anchor_fk" FOREIGN KEY ("organization_id","anchor_obligation_id") REFERENCES "public"."service_obligations"("organization_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "service_standing_enrollments" ADD CONSTRAINT "service_standing_last_occurrence_fk" FOREIGN KEY ("organization_id","last_materialized_obligation_id") REFERENCES "public"."service_obligations"("organization_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "service_standing_enrollments" ADD CONSTRAINT "service_standing_creator_fk" FOREIGN KEY ("organization_id","created_by_user_id") REFERENCES "public"."users"("organization_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "service_standing_policy_revisions" ADD CONSTRAINT "service_standing_policy_revisions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "service_standing_policy_revisions" ADD CONSTRAINT "service_standing_revision_enrollment_fk" FOREIGN KEY ("organization_id","enrollment_id") REFERENCES "public"."service_standing_enrollments"("organization_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "service_standing_policy_revisions" ADD CONSTRAINT "service_standing_revision_owner_fk" FOREIGN KEY ("organization_id","owner_user_id") REFERENCES "public"."users"("organization_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "service_standing_policy_revisions" ADD CONSTRAINT "service_standing_revision_actor_fk" FOREIGN KEY ("organization_id","approved_by_user_id") REFERENCES "public"."users"("organization_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "service_standing_policy_revisions" ADD CONSTRAINT "service_standing_revision_review_fk" FOREIGN KEY ("organization_id","review_id","approved_by_user_id") REFERENCES "public"."audit_events"("organization_id","id","actor_user_id") ON DELETE no action ON UPDATE no action;
CREATE UNIQUE INDEX "service_sms_parent_dispatch_uq" ON "service_sms_parents" USING btree ("organization_id","dispatch_id") WHERE "service_sms_parents"."dispatch_id" is not null;
CREATE INDEX "service_sms_parent_phone_idx" ON "service_sms_parents" USING btree ("organization_id","account_sid","sender","recipient");
CREATE INDEX "service_sms_reply_service_idx" ON "service_sms_replies" USING btree ("organization_id","service_obligation_id","state","recorded_at");
CREATE INDEX "service_sms_reply_phone_hold_idx" ON "service_sms_replies" USING btree ("organization_id","from_number","hold_active");
CREATE INDEX "service_sms_reply_raw_expiry_idx" ON "service_sms_replies" USING btree ("raw_expires_at");
CREATE UNIQUE INDEX "service_standing_enrollment_root_uq" ON "service_standing_enrollments" USING btree ("organization_id","series_root_obligation_id");
CREATE INDEX "service_standing_enrollment_check_idx" ON "service_standing_enrollments" USING btree ("next_check_at","organization_id");
CREATE UNIQUE INDEX "service_standing_revision_version_uq" ON "service_standing_policy_revisions" USING btree ("organization_id","enrollment_id","version");
CREATE UNIQUE INDEX "service_standing_revision_review_uq" ON "service_standing_policy_revisions" USING btree ("organization_id","review_id");
