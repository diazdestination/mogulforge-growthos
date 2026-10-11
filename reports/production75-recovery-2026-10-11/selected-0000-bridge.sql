
CREATE TABLE "service_obligations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"property_id" uuid,
	"appointment_id" uuid,
	"task_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"equipment_label" text NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"notice_days" integer DEFAULT 30 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"external_ref" text,
	"notes" text,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "missed_call_handoffs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"call_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"contact_id" uuid,
	"lead_id" uuid,
	"review_request_id" uuid,
	"review_payload_hash" text,
	"reviewed_by_user_id" text,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "twilio_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"contact_id" uuid,
	"request_key" text NOT NULL,
	"direction" text NOT NULL,
	"phone" text NOT NULL,
	"staff_phone" text NOT NULL,
	"account_sid" text NOT NULL,
	"provider_sid" text,
	"status" text DEFAULT 'dispatching' NOT NULL,
	"dial_status" text,
	"bridge_started" boolean DEFAULT false NOT NULL,
	"authorization_source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "twilio_client_bindings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"account_sid" text NOT NULL,
	"phone_number" text NOT NULL,
	"messaging_service_sid" text,
	"api_key_sid" text,
	"auth_token_secret_ref" text NOT NULL,
	"api_key_secret_ref" text,
	"public_origin" text NOT NULL,
	"business_name" text NOT NULL,
	"staff_phone" text,
	"sms_disclosure_version" text,
	"public_enrollment_token" text,
	"daily_sms_limit" integer DEFAULT 0 NOT NULL,
	"daily_call_limit" integer DEFAULT 0 NOT NULL,
	"launch_approved" boolean DEFAULT false NOT NULL,
	"sms_enabled" boolean DEFAULT false NOT NULL,
	"registration_approved" boolean DEFAULT false NOT NULL,
	"advanced_opt_out" boolean DEFAULT false NOT NULL,
	"voice_enabled" boolean DEFAULT false NOT NULL,
	"voice_approved" boolean DEFAULT false NOT NULL,
	"geo_permissions_reviewed" boolean DEFAULT false NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "twilio_consent_proofs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"phone" text NOT NULL,
	"purpose" text NOT NULL,
	"granted" boolean NOT NULL,
	"disclosure_version" text NOT NULL,
	"source" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "twilio_dispatches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"payload_hash" text NOT NULL,
	"phone" text NOT NULL,
	"purpose" text NOT NULL,
	"account_sid" text NOT NULL,
	"provider_sid" text,
	"status" text DEFAULT 'dispatching' NOT NULL,
	"error_code" text,
	"attempts" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "twilio_enrollments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"phone" text NOT NULL,
	"challenge_hash" text NOT NULL,
	"disclosure_version" text NOT NULL,
	"customer_care" boolean NOT NULL,
	"appointments" boolean NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "twilio_inbound_events" (
	"message_sid" text PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"phone" text NOT NULL,
	"event_type" text NOT NULL,
	"body" text,
	"contact_id" uuid,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "decision_rooms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"lead_id" uuid NOT NULL,
	"estimate_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"title" text NOT NULL,
	"scope" text NOT NULL,
	"options" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"warranty" text NOT NULL,
	"source_reference" text NOT NULL,
	"estimate_total_cents" integer NOT NULL,
	"estimate_updated_at" timestamp with time zone NOT NULL,
	"approved_by_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "operating_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"content" jsonb NOT NULL,
	"approved_by_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_stories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"title" text NOT NULL,
	"service_area" text NOT NULL,
	"body" text NOT NULL,
	"source_reference" text NOT NULL,
	"source_updated_at" timestamp with time zone NOT NULL,
	"state" text DEFAULT 'draft' NOT NULL,
	"approved_by_user_id" text,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "revenue_execution_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"execution_id" uuid NOT NULL,
	"state" text NOT NULL,
	"detail" text NOT NULL,
	"actor_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "revenue_executions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"action_key" text NOT NULL,
	"fingerprint" text NOT NULL,
	"kind" text NOT NULL,
	"state" text DEFAULT 'processing' NOT NULL,
	"detail" text,
	"actor_user_id" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "value_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"lead_id" uuid NOT NULL,
	"source_reference" text NOT NULL,
	"kind" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"recorded_by_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scheduler_runtime" (
	"name" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"state" text NOT NULL,
	"interval_ms" integer NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"heartbeat_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"current_stage" text,
	"failed_stages" jsonb DEFAULT '[]'::jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "service_obligations" ADD CONSTRAINT "service_obligations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_obligations" ADD CONSTRAINT "service_obligations_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_obligations" ADD CONSTRAINT "service_obligations_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_obligations" ADD CONSTRAINT "service_obligations_appointment_id_appointments_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_obligations" ADD CONSTRAINT "service_obligations_task_id_crm_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."crm_tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "missed_call_handoffs" ADD CONSTRAINT "missed_call_handoffs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "missed_call_handoffs" ADD CONSTRAINT "missed_call_handoffs_call_id_twilio_calls_id_fk" FOREIGN KEY ("call_id") REFERENCES "public"."twilio_calls"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "missed_call_handoffs" ADD CONSTRAINT "missed_call_handoffs_task_id_crm_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."crm_tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "missed_call_handoffs" ADD CONSTRAINT "missed_call_handoffs_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "missed_call_handoffs" ADD CONSTRAINT "missed_call_handoffs_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "missed_call_handoffs" ADD CONSTRAINT "missed_call_handoffs_reviewed_by_user_id_users_id_fk" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "twilio_calls" ADD CONSTRAINT "twilio_calls_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "twilio_calls" ADD CONSTRAINT "twilio_calls_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "twilio_client_bindings" ADD CONSTRAINT "twilio_client_bindings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "twilio_consent_proofs" ADD CONSTRAINT "twilio_consent_proofs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "twilio_consent_proofs" ADD CONSTRAINT "twilio_consent_proofs_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "twilio_dispatches" ADD CONSTRAINT "twilio_dispatches_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "twilio_dispatches" ADD CONSTRAINT "twilio_dispatches_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "twilio_enrollments" ADD CONSTRAINT "twilio_enrollments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "twilio_inbound_events" ADD CONSTRAINT "twilio_inbound_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "twilio_inbound_events" ADD CONSTRAINT "twilio_inbound_events_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_rooms" ADD CONSTRAINT "decision_rooms_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_rooms" ADD CONSTRAINT "decision_rooms_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_rooms" ADD CONSTRAINT "decision_rooms_estimate_id_estimates_id_fk" FOREIGN KEY ("estimate_id") REFERENCES "public"."estimates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operating_profiles" ADD CONSTRAINT "operating_profiles_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_stories" ADD CONSTRAINT "project_stories_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_stories" ADD CONSTRAINT "project_stories_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revenue_execution_events" ADD CONSTRAINT "revenue_execution_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revenue_execution_events" ADD CONSTRAINT "revenue_execution_events_execution_id_revenue_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "public"."revenue_executions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revenue_executions" ADD CONSTRAINT "revenue_executions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "value_entries" ADD CONSTRAINT "value_entries_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "value_entries" ADD CONSTRAINT "value_entries_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "service_obligations_org_due_idx" ON "service_obligations" USING btree ("organization_id","status","due_at");--> statement-breakpoint
CREATE UNIQUE INDEX "service_obligations_org_external_uq" ON "service_obligations" USING btree ("organization_id","source","external_ref") WHERE "service_obligations"."external_ref" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "service_obligations_task_uq" ON "service_obligations" USING btree ("task_id");--> statement-breakpoint
CREATE UNIQUE INDEX "missed_call_handoffs_call_uq" ON "missed_call_handoffs" USING btree ("call_id");--> statement-breakpoint
CREATE UNIQUE INDEX "twilio_call_request" ON "twilio_calls" USING btree ("organization_id","request_key");--> statement-breakpoint
CREATE UNIQUE INDEX "twilio_call_sid" ON "twilio_calls" USING btree ("provider_sid");--> statement-breakpoint
CREATE UNIQUE INDEX "twilio_client_binding_org_uq" ON "twilio_client_bindings" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "twilio_client_binding_account_uq" ON "twilio_client_bindings" USING btree ("account_sid");--> statement-breakpoint
CREATE UNIQUE INDEX "twilio_client_binding_phone_uq" ON "twilio_client_bindings" USING btree ("phone_number");--> statement-breakpoint
CREATE UNIQUE INDEX "twilio_client_binding_program_uq" ON "twilio_client_bindings" USING btree ("public_enrollment_token");--> statement-breakpoint
CREATE UNIQUE INDEX "twilio_dispatch_key" ON "twilio_dispatches" USING btree ("organization_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "twilio_dispatch_sid" ON "twilio_dispatches" USING btree ("provider_sid");--> statement-breakpoint
CREATE UNIQUE INDEX "twilio_enrollment_phone" ON "twilio_enrollments" USING btree ("organization_id","phone");--> statement-breakpoint
CREATE UNIQUE INDEX "decision_room_org_lead_version" ON "decision_rooms" USING btree ("organization_id","lead_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "operating_profile_org_version" ON "operating_profiles" USING btree ("organization_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "project_story_org_project_version" ON "project_stories" USING btree ("organization_id","project_id","version");--> statement-breakpoint
CREATE INDEX "revenue_execution_events_org" ON "revenue_execution_events" USING btree ("organization_id","execution_id");--> statement-breakpoint
CREATE UNIQUE INDEX "revenue_execution_org_key" ON "revenue_executions" USING btree ("organization_id","action_key");--> statement-breakpoint
CREATE INDEX "revenue_execution_org_state" ON "revenue_executions" USING btree ("organization_id","state");--> statement-breakpoint
CREATE UNIQUE INDEX "value_entry_org_reference" ON "value_entries" USING btree ("organization_id","source_reference");--> statement-breakpoint
CREATE INDEX "value_entry_org_lead" ON "value_entries" USING btree ("organization_id","lead_id");