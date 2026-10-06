-- REVIEW ONLY. CALLIE conversation after0014 at afcb72a810a55ea32c42adb2f342477bb0e7299f. No hosted approval.
-- Only the finite callie_intake_state_ck is replaced; all legacy states remain.
ALTER TABLE "callie_intakes" ADD COLUMN "mode" text DEFAULT 'keypad' NOT NULL;
ALTER TABLE "callie_intakes" ADD CONSTRAINT "callie_intake_reception_parent_uq" UNIQUE("organization_id","id","call_id","policy_revision_id","mode");
CREATE TABLE "callie_reception_bindings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"agent_id" text NOT NULL,
	"agent_version_id" text NOT NULL,
	"branch_id" text,
	"environment" text NOT NULL,
	"credential_key" text NOT NULL,
	"configuration_sha256" text NOT NULL,
	"updated_by_user_id" varchar NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "callie_reception_binding_org_id_uq" UNIQUE("organization_id","id"),
	CONSTRAINT "callie_reception_binding_version_ck" CHECK ("callie_reception_bindings"."version" > 0),
	CONSTRAINT "callie_reception_binding_identity_ck" CHECK ("callie_reception_bindings"."agent_id" ~ '^[A-Za-z0-9_-]{1,128}$' and "callie_reception_bindings"."agent_version_id" ~ '^[A-Za-z0-9_-]{1,128}$' and ("callie_reception_bindings"."branch_id" is null or "callie_reception_bindings"."branch_id" ~ '^[A-Za-z0-9_-]{1,128}$') and "callie_reception_bindings"."environment" in ('production','staging') and "callie_reception_bindings"."credential_key" ~ '^[A-Z][A-Z0-9_]{0,59}$' and "callie_reception_bindings"."configuration_sha256" ~ '^[a-f0-9]{64}$')
);
CREATE TABLE "callie_reception_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"event_key" text NOT NULL,
	"kind" text NOT NULL,
	"payload_hash" text NOT NULL,
	"content_encrypted" text,
	"content_expires_at" timestamp with time zone NOT NULL,
	"content_purged_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "callie_reception_event_org_id_uq" UNIQUE("organization_id","id"),
	CONSTRAINT "callie_reception_event_key_ck" CHECK (length("callie_reception_events"."event_key") between 1 and 200 and "callie_reception_events"."payload_hash" ~ '^[a-f0-9]{64}$' and "callie_reception_events"."kind" in ('initialize','save_facts','request_handoff','post_call','transfer_status')),
	CONSTRAINT "callie_reception_event_content_ck" CHECK ("callie_reception_events"."content_encrypted" is null or length("callie_reception_events"."content_encrypted") <= 16000)
);
CREATE TABLE "callie_reception_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"intake_id" uuid NOT NULL,
	"call_id" uuid NOT NULL,
	"policy_revision_id" uuid NOT NULL,
	"intake_mode" text DEFAULT 'conversation' NOT NULL,
	"reception_binding_id" uuid NOT NULL,
	"state" text DEFAULT 'admitted' NOT NULL,
	"reason" text DEFAULT 'awaiting_dial_outcome' NOT NULL,
	"agent_id" text NOT NULL,
	"agent_version_id" text NOT NULL,
	"environment" text NOT NULL,
	"conversation_id" text,
	"conversation_bound_at" timestamp with time zone,
	"capability_hash" text,
	"capability_expires_at" timestamp with time zone,
	"registration_receipt_id" uuid,
	"registration_key" text,
	"registration_accepted_at" timestamp with time zone,
	"dispatch_started_at" timestamp with time zone,
	"tools_used" integer DEFAULT 0 NOT NULL,
	"facts_encrypted" text,
	"summary_encrypted" text,
	"content_expires_at" timestamp with time zone NOT NULL,
	"content_purged_at" timestamp with time zone,
	"conversation_outcome" text DEFAULT 'pending' NOT NULL,
	"ended_at" timestamp with time zone,
	"transfer_receipt_id" uuid,
	"transfer_key" text,
	"transfer_state" text DEFAULT 'not_requested' NOT NULL,
	"transfer_target" text,
	"transfer_requested_at" timestamp with time zone,
	"transfer_dispatch_started_at" timestamp with time zone,
	"transfer_accepted_at" timestamp with time zone,
	"transfer_child_call_sid" text,
	"transfer_completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "callie_reception_session_org_id_uq" UNIQUE("organization_id","id"),
	CONSTRAINT "callie_reception_session_state_ck" CHECK ("callie_reception_sessions"."intake_mode" = 'conversation' and "callie_reception_sessions"."state" in ('admitted','registering','registered','active','completed','interrupted','blocked','indeterminate','expired') and "callie_reception_sessions"."conversation_outcome" in ('pending','completed','interrupted','empty','unknown') and "callie_reception_sessions"."transfer_state" in ('not_requested','claiming','redirect_accepted','ringing','phone_answered','not_answered','failed','indeterminate','blocked')),
	CONSTRAINT "callie_reception_session_identity_ck" CHECK ("callie_reception_sessions"."agent_id" ~ '^[A-Za-z0-9_-]{1,128}$' and "callie_reception_sessions"."agent_version_id" ~ '^[A-Za-z0-9_-]{1,128}$' and "callie_reception_sessions"."environment" in ('production','staging') and ("callie_reception_sessions"."conversation_id" is null or "callie_reception_sessions"."conversation_id" ~ '^[A-Za-z0-9_-]{1,128}$') and (("callie_reception_sessions"."conversation_id" is null) = ("callie_reception_sessions"."conversation_bound_at" is null))),
	CONSTRAINT "callie_reception_session_capability_ck" CHECK (("callie_reception_sessions"."capability_hash" is null and "callie_reception_sessions"."capability_expires_at" is null) or ("callie_reception_sessions"."capability_hash" is not null and "callie_reception_sessions"."capability_hash" ~ '^[a-f0-9]{64}$' and "callie_reception_sessions"."capability_expires_at" is not null)),
	CONSTRAINT "callie_reception_session_key_ck" CHECK ((("callie_reception_sessions"."registration_receipt_id" is null and "callie_reception_sessions"."registration_key" is null) or ("callie_reception_sessions"."registration_receipt_id" is not null and "callie_reception_sessions"."registration_key" is not null and "callie_reception_sessions"."registration_key" = 'callie:' || "callie_reception_sessions"."call_id"::text || ':conversation:v1')) and (("callie_reception_sessions"."transfer_receipt_id" is null and "callie_reception_sessions"."transfer_key" is null) or ("callie_reception_sessions"."transfer_receipt_id" is not null and "callie_reception_sessions"."transfer_key" is not null and "callie_reception_sessions"."transfer_key" = 'callie:' || "callie_reception_sessions"."call_id"::text || ':human-transfer:v1'))),
	CONSTRAINT "callie_reception_session_bounded_ck" CHECK ("callie_reception_sessions"."tools_used" between 0 and 12 and ("callie_reception_sessions"."facts_encrypted" is null or length("callie_reception_sessions"."facts_encrypted") <= 12000) and ("callie_reception_sessions"."summary_encrypted" is null or length("callie_reception_sessions"."summary_encrypted") <= 10000)),
	CONSTRAINT "callie_reception_session_transfer_ck" CHECK (("callie_reception_sessions"."transfer_target" is null or "callie_reception_sessions"."transfer_target" ~ '^[+]1[2-9][0-9]{9}$') and ("callie_reception_sessions"."transfer_child_call_sid" is null or "callie_reception_sessions"."transfer_child_call_sid" ~ '^CA[a-fA-F0-9]{32}$') and ("callie_reception_sessions"."transfer_state" = 'not_requested' or ("callie_reception_sessions"."transfer_receipt_id" is not null and "callie_reception_sessions"."transfer_target" is not null and "callie_reception_sessions"."transfer_requested_at" is not null)))
);
ALTER TABLE "callie_intakes" DROP CONSTRAINT "callie_intake_state_ck";
ALTER TABLE "callie_reception_bindings" ADD CONSTRAINT "callie_reception_bindings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "callie_reception_bindings" ADD CONSTRAINT "callie_reception_binding_actor_fk" FOREIGN KEY ("organization_id","updated_by_user_id") REFERENCES "public"."users"("organization_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "callie_reception_events" ADD CONSTRAINT "callie_reception_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "callie_reception_events" ADD CONSTRAINT "callie_reception_event_session_fk" FOREIGN KEY ("organization_id","session_id") REFERENCES "public"."callie_reception_sessions"("organization_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "callie_reception_sessions" ADD CONSTRAINT "callie_reception_sessions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "callie_reception_sessions" ADD CONSTRAINT "callie_reception_session_intake_fk" FOREIGN KEY ("organization_id","intake_id","call_id","policy_revision_id","intake_mode") REFERENCES "public"."callie_intakes"("organization_id","id","call_id","policy_revision_id","mode") ON DELETE no action ON UPDATE no action;
ALTER TABLE "callie_reception_sessions" ADD CONSTRAINT "callie_reception_session_policy_fk" FOREIGN KEY ("organization_id","policy_revision_id") REFERENCES "public"."callie_policy_revisions"("organization_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "callie_reception_sessions" ADD CONSTRAINT "callie_reception_session_binding_fk" FOREIGN KEY ("organization_id","reception_binding_id") REFERENCES "public"."callie_reception_bindings"("organization_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "callie_reception_sessions" ADD CONSTRAINT "callie_reception_session_registration_fk" FOREIGN KEY ("organization_id","registration_receipt_id","registration_key") REFERENCES "public"."revenue_executions"("organization_id","id","action_key") ON DELETE no action ON UPDATE no action;
ALTER TABLE "callie_reception_sessions" ADD CONSTRAINT "callie_reception_session_transfer_fk" FOREIGN KEY ("organization_id","transfer_receipt_id","transfer_key") REFERENCES "public"."revenue_executions"("organization_id","id","action_key") ON DELETE no action ON UPDATE no action;
CREATE UNIQUE INDEX "callie_reception_binding_org_uq" ON "callie_reception_bindings" USING btree ("organization_id");
CREATE UNIQUE INDEX "callie_reception_binding_agent_uq" ON "callie_reception_bindings" USING btree ("agent_id","environment");
CREATE UNIQUE INDEX "callie_reception_event_original_uq" ON "callie_reception_events" USING btree ("organization_id","session_id","event_key");
CREATE INDEX "callie_reception_event_retention_idx" ON "callie_reception_events" USING btree ("content_expires_at");
CREATE UNIQUE INDEX "callie_reception_session_intake_uq" ON "callie_reception_sessions" USING btree ("organization_id","intake_id");
CREATE UNIQUE INDEX "callie_reception_session_call_uq" ON "callie_reception_sessions" USING btree ("call_id");
CREATE UNIQUE INDEX "callie_reception_session_conversation_uq" ON "callie_reception_sessions" USING btree ("conversation_id");
CREATE UNIQUE INDEX "callie_reception_session_child_uq" ON "callie_reception_sessions" USING btree ("transfer_child_call_sid");
CREATE INDEX "callie_reception_session_retention_idx" ON "callie_reception_sessions" USING btree ("content_expires_at");
ALTER TABLE "callie_intakes" ADD CONSTRAINT "callie_intake_mode_ck" CHECK ("callie_intakes"."mode" in ('keypad','conversation') and ("callie_intakes"."mode" <> 'conversation' or ("callie_intakes"."state" in ('admitted','office_pending','blocked','resolved','cancelled','booked') and "callie_intakes"."stage" in ('admitted','complete') and jsonb_array_length("callie_intakes"."step_receipts") = 0 and "callie_intakes"."challenge_hash" is null and "callie_intakes"."trigger_message_sid" is null)) and ("callie_intakes"."state" <> 'office_pending' or "callie_intakes"."mode" = 'conversation'));
ALTER TABLE "callie_intakes" ADD CONSTRAINT "callie_intake_state_ck" CHECK ("callie_intakes"."state" in ('admitted','collecting','awaiting_sms','confirmed','deferred','dispatching','accepted','blocked','indeterminate','office_pending','resolved','cancelled','booked') and "callie_intakes"."stage" in ('admitted','service','request','window','consent','complete'));
