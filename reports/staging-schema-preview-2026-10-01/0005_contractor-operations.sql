-- REVIEW ONLY. Additive contractor operations delta after 0004. Not production approval.
CREATE TABLE "email_response_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"message_id" uuid,
	"external_message_id" text NOT NULL,
	"payload_sha256" text NOT NULL,
	"state" text DEFAULT 'needs_review' NOT NULL,
	"reason" text NOT NULL,
	"lead_id" uuid,
	"contact_id" uuid,
	"outbound_activity_id" uuid,
	"reply_at" timestamp with time zone,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"hold_active" boolean DEFAULT false NOT NULL,
	"reviewed_by_user_id" varchar,
	"reviewed_at" timestamp with time zone,
	"review_note" text,
	"effect_summary" jsonb,
	"released_by_user_id" varchar,
	"released_at" timestamp with time zone,
	"release_note" text
);
;
CREATE TABLE "staff_invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"payload_hash" text NOT NULL,
	"pending_user_id" varchar NOT NULL,
	"email" text NOT NULL,
	"role" "user_role" NOT NULL,
	"token_revision" uuid DEFAULT gen_random_uuid() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"delivery_state" text DEFAULT 'sending' NOT NULL,
	"delivery_attempted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_by_user_id" varchar NOT NULL,
	"accepted_user_id" varchar,
	"accepted_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "staff_invitations_state_valid" CHECK ("staff_invitations"."state" in ('pending', 'accepted', 'revoked')),
	CONSTRAINT "staff_invitations_delivery_valid" CHECK ("staff_invitations"."delivery_state" in ('sending', 'sent', 'unconfirmed')),
	CONSTRAINT "staff_invitations_version_valid" CHECK ("staff_invitations"."version" > 0)
);
;
ALTER TABLE "email_response_reviews" ADD CONSTRAINT "email_response_reviews_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;;
ALTER TABLE "email_response_reviews" ADD CONSTRAINT "email_response_reviews_source_id_email_intelligence_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."email_intelligence_sources"("id") ON DELETE no action ON UPDATE no action;;
ALTER TABLE "email_response_reviews" ADD CONSTRAINT "email_response_reviews_message_id_email_intelligence_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."email_intelligence_messages"("id") ON DELETE set null ON UPDATE no action;;
ALTER TABLE "email_response_reviews" ADD CONSTRAINT "email_response_reviews_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE no action ON UPDATE no action;;
ALTER TABLE "email_response_reviews" ADD CONSTRAINT "email_response_reviews_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;;
ALTER TABLE "email_response_reviews" ADD CONSTRAINT "email_response_reviews_outbound_activity_id_activities_id_fk" FOREIGN KEY ("outbound_activity_id") REFERENCES "public"."activities"("id") ON DELETE set null ON UPDATE no action;;
ALTER TABLE "email_response_reviews" ADD CONSTRAINT "email_response_reviews_reviewed_by_user_id_users_id_fk" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;;
ALTER TABLE "email_response_reviews" ADD CONSTRAINT "email_response_reviews_released_by_user_id_users_id_fk" FOREIGN KEY ("released_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;;
ALTER TABLE "staff_invitations" ADD CONSTRAINT "staff_invitations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;;
ALTER TABLE "staff_invitations" ADD CONSTRAINT "staff_invitations_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;;
ALTER TABLE "staff_invitations" ADD CONSTRAINT "staff_invitations_accepted_user_id_users_id_fk" FOREIGN KEY ("accepted_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;;
CREATE UNIQUE INDEX "email_response_source_external_uniq" ON "email_response_reviews" USING btree ("source_id","external_message_id");;
CREATE INDEX "email_response_org_review_idx" ON "email_response_reviews" USING btree ("organization_id","state","received_at");;
CREATE INDEX "email_response_org_lead_hold_idx" ON "email_response_reviews" USING btree ("organization_id","lead_id","hold_active");;
CREATE UNIQUE INDEX "staff_invitations_request_idx" ON "staff_invitations" USING btree ("organization_id","request_id");;
CREATE UNIQUE INDEX "staff_invitations_pending_user_idx" ON "staff_invitations" USING btree ("pending_user_id");;
CREATE INDEX "staff_invitations_org_idx" ON "staff_invitations" USING btree ("organization_id");;
