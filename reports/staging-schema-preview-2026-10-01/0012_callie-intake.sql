-- REVIEW ONLY. CALLIE intake after 0011 at fa7c82757f3ec07d05ef1a8ace2739bec5b491c5. No hosted approval.
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_org_id_uq" UNIQUE("organization_id","id");
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_event_org_actor_uq" UNIQUE("organization_id","id","actor_user_id");
ALTER TABLE "revenue_executions" ADD CONSTRAINT "revenue_execution_operation_uq" UNIQUE("organization_id","id","action_key");
ALTER TABLE "twilio_client_bindings" ADD CONSTRAINT "twilio_client_binding_org_id_uq" UNIQUE("organization_id","id");
ALTER TABLE "twilio_inbound_events" ADD CONSTRAINT "twilio_inbound_event_org_sid_uq" UNIQUE("organization_id","message_sid");
CREATE TABLE "callie_ack_dispatches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"intake_id" uuid NOT NULL,
	"call_id" uuid NOT NULL,
	"policy_revision_id" uuid NOT NULL,
	"trigger_message_sid" text NOT NULL,
	"receipt_id" uuid NOT NULL,
	"operation_key" text NOT NULL,
	"payload_hash" text NOT NULL,
	"account_sid" text NOT NULL,
	"from_phone" text NOT NULL,
	"to_phone" text NOT NULL,
	"messaging_service_sid" text NOT NULL,
	"body_hash" text NOT NULL,
	"status" text DEFAULT 'dispatching' NOT NULL,
	"provider_sid" text,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "callie_ack_org_id_uq" UNIQUE("organization_id","id"),
	CONSTRAINT "callie_ack_key_ck" CHECK ("callie_ack_dispatches"."operation_key" = 'missed-call-care:' || "callie_ack_dispatches"."call_id"::text || ':sms:v1'),
	CONSTRAINT "callie_ack_hash_ck" CHECK ("callie_ack_dispatches"."payload_hash" ~ '^[a-f0-9]{64}$' and "callie_ack_dispatches"."body_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "callie_ack_status_ck" CHECK ("callie_ack_dispatches"."status" in ('dispatching','accepted','queued','sending','sent','delivered','undelivered','failed','cancelled','rate_limited','uncertain'))
);
CREATE TABLE "callie_intakes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"call_id" uuid NOT NULL,
	"policy_revision_id" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"state" text DEFAULT 'admitted' NOT NULL,
	"stage" text DEFAULT 'admitted' NOT NULL,
	"binding_id" uuid NOT NULL,
	"account_sid" text NOT NULL,
	"provider_call_sid" text NOT NULL,
	"from_phone" text NOT NULL,
	"called_number" text NOT NULL,
	"owner_user_id" varchar NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"ack_due_at" timestamp with time zone,
	"service_intent" text,
	"request_intent" text,
	"callback_window" text,
	"step_receipts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"challenge_hash" text,
	"challenge_encrypted" text,
	"challenge_expires_at" timestamp with time zone,
	"trigger_message_sid" text,
	"trigger_account_sid" text,
	"trigger_from" text,
	"trigger_to" text,
	"trigger_payload_hash" text,
	"confirmed_at" timestamp with time zone,
	"grant_expires_at" timestamp with time zone,
	"reason" text DEFAULT 'awaiting_dial_outcome' NOT NULL,
	"appointment_id" uuid,
	"office_request_id" uuid,
	"office_payload_hash" text,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "callie_intake_org_id_uq" UNIQUE("organization_id","id"),
	CONSTRAINT "callie_intake_grant_uq" UNIQUE("organization_id","id","call_id","policy_revision_id","trigger_message_sid"),
	CONSTRAINT "callie_intake_version_ck" CHECK ("callie_intakes"."version" > 0),
	CONSTRAINT "callie_intake_state_ck" CHECK ("callie_intakes"."state" in ('admitted','collecting','awaiting_sms','confirmed','deferred','dispatching','accepted','blocked','indeterminate','resolved','cancelled','booked') and "callie_intakes"."stage" in ('admitted','service','request','window','consent','complete')),
	CONSTRAINT "callie_intake_choice_ck" CHECK (("callie_intakes"."service_intent" is null or "callie_intakes"."service_intent" in ('repair','replacement','maintenance','other')) and ("callie_intakes"."request_intent" is null or "callie_intakes"."request_intent" in ('callback','visit')) and ("callie_intakes"."callback_window" is null or "callie_intakes"."callback_window" in ('morning','afternoon','any'))),
	CONSTRAINT "callie_intake_steps_ck" CHECK (jsonb_typeof("callie_intakes"."step_receipts") = 'array' and jsonb_array_length("callie_intakes"."step_receipts") <= 5),
	CONSTRAINT "callie_intake_trigger_ck" CHECK (("callie_intakes"."trigger_message_sid" is null and "callie_intakes"."trigger_account_sid" is null and "callie_intakes"."trigger_from" is null and "callie_intakes"."trigger_to" is null and "callie_intakes"."trigger_payload_hash" is null and "callie_intakes"."confirmed_at" is null and "callie_intakes"."grant_expires_at" is null) or ("callie_intakes"."trigger_message_sid" is not null and "callie_intakes"."trigger_account_sid" is not null and "callie_intakes"."trigger_from" is not null and "callie_intakes"."trigger_to" is not null and "callie_intakes"."trigger_payload_hash" is not null and "callie_intakes"."confirmed_at" is not null and "callie_intakes"."grant_expires_at" is not null and "callie_intakes"."trigger_account_sid" = "callie_intakes"."account_sid" and "callie_intakes"."trigger_from" = "callie_intakes"."from_phone" and "callie_intakes"."trigger_to" = "callie_intakes"."called_number" and "callie_intakes"."trigger_payload_hash" ~ '^[a-f0-9]{64}$' and "callie_intakes"."grant_expires_at" > "callie_intakes"."confirmed_at")),
	CONSTRAINT "callie_intake_challenge_ck" CHECK (("callie_intakes"."challenge_hash" is null and "callie_intakes"."challenge_encrypted" is null and "callie_intakes"."challenge_expires_at" is null) or ("callie_intakes"."challenge_hash" is not null and "callie_intakes"."challenge_encrypted" is not null and "callie_intakes"."challenge_expires_at" is not null and "callie_intakes"."challenge_hash" ~ '^[a-f0-9]{64}$')),
	CONSTRAINT "callie_intake_grant_state_ck" CHECK ("callie_intakes"."state" not in ('confirmed','deferred','dispatching','accepted','indeterminate') or ("callie_intakes"."trigger_message_sid" is not null and "callie_intakes"."stage" = 'complete')),
	CONSTRAINT "callie_intake_booking_ck" CHECK ((("callie_intakes"."office_request_id" is null and "callie_intakes"."office_payload_hash" is null and "callie_intakes"."appointment_id" is null) or ("callie_intakes"."office_request_id" is not null and "callie_intakes"."office_payload_hash" is not null and "callie_intakes"."office_payload_hash" ~ '^[a-f0-9]{64}$')) and (("callie_intakes"."state" = 'booked' and "callie_intakes"."appointment_id" is not null and "callie_intakes"."office_request_id" is not null) or ("callie_intakes"."state" <> 'booked' and "callie_intakes"."appointment_id" is null)))
);
CREATE TABLE "callie_policy_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"snapshot" jsonb NOT NULL,
	"review_id" uuid NOT NULL,
	"review_payload_hash" text NOT NULL,
	"approved_by_user_id" varchar NOT NULL,
	"approved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "callie_policy_org_id_uq" UNIQUE("organization_id","id"),
	CONSTRAINT "callie_policy_version_ck" CHECK ("callie_policy_revisions"."version" > 0),
	CONSTRAINT "callie_policy_hash_ck" CHECK ("callie_policy_revisions"."review_payload_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "callie_policy_enabled_ck" CHECK (coalesce(jsonb_typeof("callie_policy_revisions"."snapshot"->'enabled') = 'boolean' and ("callie_policy_revisions"."snapshot"->>'enabled')::boolean = "callie_policy_revisions"."enabled", false))
);
ALTER TABLE "callie_ack_dispatches" ADD CONSTRAINT "callie_ack_dispatches_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "callie_ack_dispatches" ADD CONSTRAINT "callie_ack_grant_fk" FOREIGN KEY ("organization_id","intake_id","call_id","policy_revision_id","trigger_message_sid") REFERENCES "public"."callie_intakes"("organization_id","id","call_id","policy_revision_id","trigger_message_sid") ON DELETE no action ON UPDATE no action;
ALTER TABLE "callie_ack_dispatches" ADD CONSTRAINT "callie_ack_receipt_fk" FOREIGN KEY ("organization_id","receipt_id","operation_key") REFERENCES "public"."revenue_executions"("organization_id","id","action_key") ON DELETE no action ON UPDATE no action;
ALTER TABLE "callie_intakes" ADD CONSTRAINT "callie_intakes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "callie_intakes" ADD CONSTRAINT "callie_intake_call_fk" FOREIGN KEY ("organization_id","call_id") REFERENCES "public"."twilio_calls"("organization_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "callie_intakes" ADD CONSTRAINT "callie_intake_policy_fk" FOREIGN KEY ("organization_id","policy_revision_id") REFERENCES "public"."callie_policy_revisions"("organization_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "callie_intakes" ADD CONSTRAINT "callie_intake_binding_fk" FOREIGN KEY ("organization_id","binding_id") REFERENCES "public"."twilio_client_bindings"("organization_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "callie_intakes" ADD CONSTRAINT "callie_intake_owner_fk" FOREIGN KEY ("organization_id","owner_user_id") REFERENCES "public"."users"("organization_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "callie_intakes" ADD CONSTRAINT "callie_intake_trigger_fk" FOREIGN KEY ("organization_id","trigger_message_sid") REFERENCES "public"."twilio_inbound_events"("organization_id","message_sid") ON DELETE no action ON UPDATE no action;
ALTER TABLE "callie_intakes" ADD CONSTRAINT "callie_intake_appointment_fk" FOREIGN KEY ("organization_id","appointment_id") REFERENCES "public"."appointments"("organization_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "callie_policy_revisions" ADD CONSTRAINT "callie_policy_revisions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "callie_policy_revisions" ADD CONSTRAINT "callie_policy_actor_fk" FOREIGN KEY ("organization_id","approved_by_user_id") REFERENCES "public"."users"("organization_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "callie_policy_revisions" ADD CONSTRAINT "callie_policy_review_fk" FOREIGN KEY ("organization_id","review_id","approved_by_user_id") REFERENCES "public"."audit_events"("organization_id","id","actor_user_id") ON DELETE no action ON UPDATE no action;
CREATE UNIQUE INDEX "callie_ack_intake_uq" ON "callie_ack_dispatches" USING btree ("organization_id","intake_id");
CREATE UNIQUE INDEX "callie_ack_operation_uq" ON "callie_ack_dispatches" USING btree ("organization_id","operation_key");
CREATE UNIQUE INDEX "callie_ack_sid_uq" ON "callie_ack_dispatches" USING btree ("provider_sid");
CREATE UNIQUE INDEX "callie_intake_call_uq" ON "callie_intakes" USING btree ("call_id");
CREATE UNIQUE INDEX "callie_intake_trigger_uq" ON "callie_intakes" USING btree ("trigger_message_sid");
CREATE UNIQUE INDEX "callie_intake_challenge_uq" ON "callie_intakes" USING btree ("organization_id","from_phone","challenge_hash");
CREATE INDEX "callie_intake_worklist_idx" ON "callie_intakes" USING btree ("organization_id","state","due_at");
CREATE UNIQUE INDEX "callie_policy_org_version_uq" ON "callie_policy_revisions" USING btree ("organization_id","version");
CREATE UNIQUE INDEX "callie_policy_review_uq" ON "callie_policy_revisions" USING btree ("organization_id","review_id");
