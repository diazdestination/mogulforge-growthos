-- REVIEW ONLY. Launch communications after 0008 at c01bea06d5175b1d450462653aca5ed0c6246c60. No hosted approval.
ALTER TABLE "staff_invitations" ADD CONSTRAINT "staff_invitations_org_id_unique" UNIQUE("organization_id","id");
CREATE TABLE "mailbox_communication_parents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"lead_id" uuid,
	"service_obligation_id" uuid,
	"context_snapshot" jsonb NOT NULL,
	"provider" text NOT NULL,
	"sender_user_id" varchar NOT NULL,
	"connection_id" uuid NOT NULL,
	"connection_revision" text NOT NULL,
	"mailbox_account_id" text NOT NULL,
	"mailbox_email" text NOT NULL,
	"connector_id" uuid NOT NULL,
	"connector_version" integer NOT NULL,
	"policy_version" integer NOT NULL,
	"connector_started_at" text NOT NULL,
	"recipient" text NOT NULL,
	"content_sha256" text NOT NULL,
	"subject_sha256" text NOT NULL,
	"body_sha256" text NOT NULL,
	"correlation_header" text NOT NULL,
	"action_key" text NOT NULL,
	"execution_fingerprint" text NOT NULL,
	"reserved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"dispatch_started_at" timestamp with time zone,
	"accepted_at" timestamp with time zone,
	"observed_at" timestamp with time zone,
	"provider_message_id" text,
	"internet_message_id" text,
	"provider_sent_at" timestamp with time zone,
	CONSTRAINT "mailbox_parent_org_id_uq" UNIQUE("organization_id","id"),
	CONSTRAINT "mailbox_parent_exact_service_uq" UNIQUE("organization_id","id","service_obligation_id","contact_id","connector_id"),
	CONSTRAINT "mailbox_parent_one_context" CHECK (("mailbox_communication_parents"."lead_id" is not null)::int + ("mailbox_communication_parents"."service_obligation_id" is not null)::int = 1),
	CONSTRAINT "mailbox_parent_format_ck" CHECK ("mailbox_communication_parents"."provider" = 'microsoft' and "mailbox_communication_parents"."connector_version" > 0 and "mailbox_communication_parents"."policy_version" = 1 and "mailbox_communication_parents"."correlation_header" ~ '^[a-f0-9]{64}$' and "mailbox_communication_parents"."content_sha256" ~ '^[a-f0-9]{64}$')
);
CREATE TABLE "mailbox_connectors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" varchar NOT NULL,
	"provider" text DEFAULT 'microsoft' NOT NULL,
	"connection_id" uuid NOT NULL,
	"connection_revision" text NOT NULL,
	"mailbox_account_id" text NOT NULL,
	"mailbox_email" text NOT NULL,
	"policy_version" integer DEFAULT 1 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"encrypted_refresh_token" text,
	"granted_scopes" text[] DEFAULT '{}' NOT NULL,
	"encrypted_cursors" text,
	"started_at" timestamp with time zone,
	"lease_token" uuid,
	"lease_expires_at" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"last_checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error_at" timestamp with time zone,
	"last_error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mailbox_connectors_org_id_uq" UNIQUE("organization_id","id"),
	CONSTRAINT "mailbox_connectors_org_user_uq" UNIQUE("organization_id","user_id"),
	CONSTRAINT "mailbox_connector_state_ck" CHECK ("mailbox_connectors"."state" in ('pending','active','disabled','gap','revoked') and "mailbox_connectors"."provider" = 'microsoft' and "mailbox_connectors"."version" > 0 and "mailbox_connectors"."policy_version" = 1),
	CONSTRAINT "mailbox_connector_active_ck" CHECK ("mailbox_connectors"."state" <> 'active' or ("mailbox_connectors"."encrypted_refresh_token" is not null and "mailbox_connectors"."encrypted_cursors" is not null and "mailbox_connectors"."started_at" is not null))
);
CREATE TABLE "mailbox_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"connector_id" uuid NOT NULL,
	"connector_version" integer NOT NULL,
	"folder" text NOT NULL,
	"provider_message_id" text NOT NULL,
	"content_sha256" text NOT NULL,
	"state" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mailbox_receipt_identity_uq" UNIQUE("organization_id","connector_id","folder","provider_message_id"),
	CONSTRAINT "mailbox_receipt_state_ck" CHECK ("mailbox_receipts"."state" in ('processed','ignored','review','pending') and "mailbox_receipts"."folder" in ('inbox','sentitems') and "mailbox_receipts"."connector_version" > 0 and "mailbox_receipts"."attempts" >= 0 and "mailbox_receipts"."content_sha256" ~ '^[a-f0-9]{64}$')
);
CREATE TABLE "mailbox_service_replies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"parent_id" uuid NOT NULL,
	"service_obligation_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"connector_id" uuid NOT NULL,
	"provider_message_id" text NOT NULL,
	"internet_message_id" text NOT NULL,
	"payload_sha256" text NOT NULL,
	"reply_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"state" text DEFAULT 'needs_review' NOT NULL,
	"historical" boolean DEFAULT false NOT NULL,
	"hold_active" boolean DEFAULT false NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"encrypted_text" text,
	"raw_expires_at" timestamp with time zone NOT NULL,
	"raw_purged_at" timestamp with time zone,
	"reviewed_by_user_id" varchar,
	"reviewed_at" timestamp with time zone,
	"review_note" text,
	"review_request_id" uuid,
	"review_fingerprint" text,
	CONSTRAINT "mailbox_reply_state_ck" CHECK ("mailbox_service_replies"."state" in ('needs_review','reviewed','dismissed') and "mailbox_service_replies"."version" > 0 and "mailbox_service_replies"."payload_sha256" ~ '^[a-f0-9]{64}$' and (not "mailbox_service_replies"."historical" or not "mailbox_service_replies"."hold_active"))
);
CREATE TABLE "platform_email_dispatches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"logical_key" text NOT NULL,
	"purpose" text NOT NULL,
	"organization_id" uuid,
	"user_id" varchar,
	"identity_token_id" uuid,
	"invitation_id" uuid,
	"source_record_id" uuid NOT NULL,
	"source_revision" text NOT NULL,
	"recipient_hash" varchar(64) NOT NULL,
	"sender_mailbox" text NOT NULL,
	"provider_context" varchar(64) NOT NULL,
	"fingerprint" varchar(64) NOT NULL,
	"outcome" text DEFAULT 'claimed' NOT NULL,
	"outcome_code" text,
	"provider_message_id" uuid,
	"http_status" integer,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "platform_email_dispatches_logical_key_unique" UNIQUE("logical_key"),
	CONSTRAINT "platform_email_provider_receipt_uq" UNIQUE("provider_context","provider_message_id"),
	CONSTRAINT "platform_email_purpose_valid" CHECK ("platform_email_dispatches"."purpose" in ('email_verification','password_reset','staff_invitation')),
	CONSTRAINT "platform_email_outcome_valid" CHECK ("platform_email_dispatches"."outcome" in ('claimed','accepted','rejected','unknown','not_attempted')),
	CONSTRAINT "platform_email_invitation_bound" CHECK ("platform_email_dispatches"."purpose" <> 'staff_invitation' or ("platform_email_dispatches"."organization_id" is not null and "platform_email_dispatches"."invitation_id" is not null)),
	CONSTRAINT "platform_email_receipt_valid" CHECK (("platform_email_dispatches"."outcome" = 'accepted') = ("platform_email_dispatches"."provider_message_id" is not null)),
	CONSTRAINT "platform_email_http_status_valid" CHECK ("platform_email_dispatches"."http_status" is null or "platform_email_dispatches"."http_status" between 100 and 599)
);
CREATE TABLE "platform_email_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_context" varchar(64) NOT NULL,
	"provider_message_id" uuid NOT NULL,
	"event_id" varchar(200) NOT NULL,
	"payload_hash" varchar(64) NOT NULL,
	"recipient_hash" varchar(64) NOT NULL,
	"sender_mailbox" text NOT NULL,
	"signal" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_email_event_payload_uq" UNIQUE("provider_context","event_id","payload_hash"),
	CONSTRAINT "platform_email_signal_valid" CHECK ("platform_email_events"."signal" in ('sent','delivered','delayed','failed','bounced','complained'))
);
ALTER TABLE "mailbox_communication_parents" ADD CONSTRAINT "mailbox_communication_parents_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "mailbox_communication_parents" ADD CONSTRAINT "mailbox_parent_connector_fk" FOREIGN KEY ("organization_id","connector_id") REFERENCES "public"."mailbox_connectors"("organization_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "mailbox_communication_parents" ADD CONSTRAINT "mailbox_parent_contact_fk" FOREIGN KEY ("organization_id","contact_id") REFERENCES "public"."contacts"("organization_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "mailbox_communication_parents" ADD CONSTRAINT "mailbox_parent_lead_fk" FOREIGN KEY ("organization_id","lead_id") REFERENCES "public"."leads"("organization_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "mailbox_communication_parents" ADD CONSTRAINT "mailbox_parent_service_fk" FOREIGN KEY ("organization_id","service_obligation_id") REFERENCES "public"."service_obligations"("organization_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "mailbox_communication_parents" ADD CONSTRAINT "mailbox_parent_sender_fk" FOREIGN KEY ("organization_id","sender_user_id") REFERENCES "public"."users"("organization_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "mailbox_connectors" ADD CONSTRAINT "mailbox_connectors_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "mailbox_connectors" ADD CONSTRAINT "mailbox_connector_actor_fk" FOREIGN KEY ("organization_id","user_id") REFERENCES "public"."users"("organization_id","id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "mailbox_receipts" ADD CONSTRAINT "mailbox_receipts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "mailbox_receipts" ADD CONSTRAINT "mailbox_receipt_connector_fk" FOREIGN KEY ("organization_id","connector_id") REFERENCES "public"."mailbox_connectors"("organization_id","id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "mailbox_service_replies" ADD CONSTRAINT "mailbox_service_replies_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "mailbox_service_replies" ADD CONSTRAINT "mailbox_reply_exact_parent_fk" FOREIGN KEY ("organization_id","parent_id","service_obligation_id","contact_id","connector_id") REFERENCES "public"."mailbox_communication_parents"("organization_id","id","service_obligation_id","contact_id","connector_id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "mailbox_service_replies" ADD CONSTRAINT "mailbox_reply_connector_fk" FOREIGN KEY ("organization_id","connector_id") REFERENCES "public"."mailbox_connectors"("organization_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "mailbox_service_replies" ADD CONSTRAINT "mailbox_reply_service_fk" FOREIGN KEY ("organization_id","service_obligation_id") REFERENCES "public"."service_obligations"("organization_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "mailbox_service_replies" ADD CONSTRAINT "mailbox_reply_contact_fk" FOREIGN KEY ("organization_id","contact_id") REFERENCES "public"."contacts"("organization_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "mailbox_service_replies" ADD CONSTRAINT "mailbox_reply_reviewer_fk" FOREIGN KEY ("organization_id","reviewed_by_user_id") REFERENCES "public"."users"("organization_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "platform_email_dispatches" ADD CONSTRAINT "platform_email_dispatches_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "platform_email_dispatches" ADD CONSTRAINT "platform_email_dispatches_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "platform_email_dispatches" ADD CONSTRAINT "platform_email_dispatches_identity_token_id_identity_tokens_id_fk" FOREIGN KEY ("identity_token_id") REFERENCES "public"."identity_tokens"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "platform_email_dispatches" ADD CONSTRAINT "platform_email_invitation_org_fk" FOREIGN KEY ("organization_id","invitation_id") REFERENCES "public"."staff_invitations"("organization_id","id") ON DELETE no action ON UPDATE no action;
CREATE UNIQUE INDEX "mailbox_parent_header_uq" ON "mailbox_communication_parents" USING btree ("correlation_header");
CREATE UNIQUE INDEX "mailbox_parent_action_uq" ON "mailbox_communication_parents" USING btree ("organization_id","action_key");
CREATE UNIQUE INDEX "mailbox_parent_service_uq" ON "mailbox_communication_parents" USING btree ("organization_id","service_obligation_id") WHERE "mailbox_communication_parents"."service_obligation_id" is not null;
CREATE UNIQUE INDEX "mailbox_parent_provider_id_uq" ON "mailbox_communication_parents" USING btree ("organization_id","connector_id","provider_message_id") WHERE "mailbox_communication_parents"."provider_message_id" is not null;
CREATE UNIQUE INDEX "mailbox_parent_rfc_id_uq" ON "mailbox_communication_parents" USING btree ("organization_id","connector_id","internet_message_id") WHERE "mailbox_communication_parents"."internet_message_id" is not null;
CREATE INDEX "mailbox_connector_poll_idx" ON "mailbox_connectors" USING btree ("state","last_success_at");
CREATE UNIQUE INDEX "mailbox_reply_provider_id_uq" ON "mailbox_service_replies" USING btree ("organization_id","connector_id","provider_message_id");
CREATE INDEX "mailbox_reply_service_review_idx" ON "mailbox_service_replies" USING btree ("organization_id","service_obligation_id","state","recorded_at");
CREATE INDEX "mailbox_reply_raw_expiry_idx" ON "mailbox_service_replies" USING btree ("raw_expires_at");
CREATE INDEX "platform_email_dispatch_org_idx" ON "platform_email_dispatches" USING btree ("organization_id","claimed_at");
CREATE INDEX "platform_email_dispatch_user_idx" ON "platform_email_dispatches" USING btree ("user_id","claimed_at");
CREATE INDEX "platform_email_event_parent_idx" ON "platform_email_events" USING btree ("provider_context","provider_message_id");
