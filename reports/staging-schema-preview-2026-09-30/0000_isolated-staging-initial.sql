CREATE TYPE "public"."appointment_status" AS ENUM('scheduled', 'confirmed', 'completed', 'cancelled', 'no_show');--> statement-breakpoint
CREATE TYPE "public"."appointment_type" AS ENUM('inspection', 'estimate_review', 'production', 'final_walkthrough', 'other');--> statement-breakpoint
CREATE TYPE "public"."automation_run_status" AS ENUM('success', 'partial', 'failed', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."consent_channel" AS ENUM('sms', 'email', 'phone');--> statement-breakpoint
CREATE TYPE "public"."conversation_role" AS ENUM('user', 'assistant', 'system');--> statement-breakpoint
CREATE TYPE "public"."conversation_status" AS ENUM('active', 'completed', 'abandoned');--> statement-breakpoint
CREATE TYPE "public"."estimate_status" AS ENUM('draft', 'sent', 'accepted', 'declined');--> statement-breakpoint
CREATE TYPE "public"."lead_status" AS ENUM('new', 'ai_qualified', 'contact_attempted', 'inspection_scheduled', 'inspection_completed', 'estimate_preparing', 'estimate_sent', 'claim_pending', 'follow_up', 'won', 'production_scheduled', 'in_progress', 'final_walkthrough', 'completed', 'review_requested', 'nurture', 'lost');--> statement-breakpoint
CREATE TYPE "public"."message_channel" AS ENUM('email', 'sms');--> statement-breakpoint
CREATE TYPE "public"."project_status" AS ENUM('scheduled', 'in_progress', 'on_hold', 'completed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."scheduled_action_status" AS ENUM('pending', 'done', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."task_status" AS ENUM('open', 'in_progress', 'done', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."urgency" AS ENUM('low', 'normal', 'high', 'emergency');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('owner', 'admin', 'sales_manager', 'sales_rep', 'inspector', 'production', 'office', 'viewer');--> statement-breakpoint
CREATE TYPE "public"."webhook_delivery_status" AS ENUM('pending', 'success', 'failed');--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"timezone" text DEFAULT 'America/New_York' NOT NULL,
	"stripe_customer_id" text,
	"stripe_subscription_id" text,
	"subscription_status" text,
	"plan_tier" text,
	"trial_ends_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"sid" varchar PRIMARY KEY NOT NULL,
	"sess" jsonb NOT NULL,
	"expire" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" varchar,
	"first_name" varchar,
	"last_name" varchar,
	"profile_image_url" varchar,
	"password_hash" varchar,
	"email_verified_at" timestamp with time zone DEFAULT now(),
	"organization_id" uuid,
	"role" "user_role" DEFAULT 'viewer' NOT NULL,
	"is_platform_admin" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "identity_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar NOT NULL,
	"purpose" varchar(32) NOT NULL,
	"token_digest" varchar(64) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "identity_tokens_token_digest_unique" UNIQUE("token_digest")
);
--> statement-breakpoint
CREATE TABLE "contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"first_name" text NOT NULL,
	"last_name" text,
	"email" text,
	"phone" text,
	"preferred_contact_method" text,
	"do_not_contact" boolean DEFAULT false NOT NULL,
	"do_not_contact_email" boolean DEFAULT false NOT NULL,
	"do_not_contact_sms" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "properties" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"contact_id" uuid,
	"address_line_1" text NOT NULL,
	"address_line_2" text,
	"city" text NOT NULL,
	"state" text NOT NULL,
	"postal_code" text NOT NULL,
	"latitude" text,
	"longitude" text,
	"property_type" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "leads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"property_id" uuid,
	"assigned_user_id" varchar,
	"status" "lead_status" DEFAULT 'new' NOT NULL,
	"urgency" "urgency" DEFAULT 'normal' NOT NULL,
	"service_type" text,
	"source" text,
	"source_detail" text,
	"score" integer DEFAULT 0 NOT NULL,
	"score_reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"summary" text,
	"estimated_value_cents" integer,
	"lost_reason" text,
	"won_at" timestamp with time zone,
	"won_revenue_cents" integer,
	"won_attribution" text,
	"first_touch" jsonb,
	"last_touch" jsonb,
	"latest_source" text,
	"campaign" text,
	"landing_page" text,
	"referrer" text,
	"creation_method" text,
	"anonymous_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "engagement_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"lead_id" uuid,
	"kind" text NOT NULL,
	"token" text NOT NULL,
	"click_count" integer DEFAULT 0 NOT NULL,
	"last_clicked_at" timestamp with time zone,
	"submission_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "estimates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"lead_id" uuid NOT NULL,
	"title" text NOT NULL,
	"status" "estimate_status" DEFAULT 'draft' NOT NULL,
	"line_items" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"subtotal_cents" integer DEFAULT 0 NOT NULL,
	"tax_cents" integer DEFAULT 0 NOT NULL,
	"total_cents" integer DEFAULT 0 NOT NULL,
	"notes" text,
	"sent_at" timestamp with time zone,
	"accepted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"lead_id" uuid NOT NULL,
	"estimate_id" uuid,
	"name" text NOT NULL,
	"status" "project_status" DEFAULT 'scheduled' NOT NULL,
	"scheduled_start" timestamp with time zone,
	"scheduled_end" timestamp with time zone,
	"crew_user_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"crew_notes" text,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crm_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"lead_id" uuid,
	"contact_id" uuid,
	"assigned_user_id" varchar,
	"title" text NOT NULL,
	"description" text,
	"source_event" text,
	"status" "task_status" DEFAULT 'open' NOT NULL,
	"priority" "urgency" DEFAULT 'normal' NOT NULL,
	"due_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "appointments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"lead_id" uuid,
	"contact_id" uuid,
	"property_id" uuid,
	"assigned_user_id" varchar,
	"type" "appointment_type" DEFAULT 'inspection' NOT NULL,
	"status" "appointment_status" DEFAULT 'scheduled' NOT NULL,
	"scheduled_start" timestamp with time zone NOT NULL,
	"scheduled_end" timestamp with time zone,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
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
CREATE TABLE "activities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"lead_id" uuid,
	"contact_id" uuid,
	"actor_user_id" varchar,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"body" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "consent_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"channel" "consent_channel" NOT NULL,
	"granted" boolean NOT NULL,
	"disclosure_version" text NOT NULL,
	"source_ip" text,
	"user_agent" text,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL
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
CREATE TABLE "conversation_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"role" "conversation_role" NOT NULL,
	"content" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"lead_id" uuid,
	"contact_id" uuid,
	"channel" text DEFAULT 'web_chat' NOT NULL,
	"status" "conversation_status" DEFAULT 'active' NOT NULL,
	"intent" text,
	"urgency" "urgency",
	"state" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"sales_summary" text,
	"source" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "analytics_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"smart_site_id" uuid,
	"event_id" uuid,
	"schema_version" integer,
	"lead_id" uuid,
	"consent_policy_version" text,
	"payload_hash" text,
	"event_name" text NOT NULL,
	"anonymous_id" text,
	"session_id" text,
	"path" text,
	"referrer" text,
	"source" text,
	"medium" text,
	"campaign" text,
	"service_code" text,
	"surface" text,
	"step" text,
	"properties" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"actor_user_id" varchar,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "org_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"business_profile" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"services" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"service_areas" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"lead_scoring" jsonb,
	"inspection_availability" jsonb,
	"appointment_reminder" jsonb,
	"ai_instructions" text,
	"fallback_notification_inbox" text,
	"google_reviews" jsonb,
	"widget" jsonb,
	"concierge" jsonb,
	"sending_hours" jsonb,
	"playbook_stage_behaviors" jsonb,
	"security_alerts_acknowledged_at" timestamp with time zone,
	"onboarding" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "message_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"channel" "message_channel" NOT NULL,
	"subject" text,
	"body" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "automation_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"automation_id" uuid NOT NULL,
	"event" text NOT NULL,
	"entity_type" text,
	"entity_id" text,
	"status" "automation_run_status" NOT NULL,
	"action_results" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "automations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"seed_key" text,
	"event" text NOT NULL,
	"conditions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"actions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scheduled_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"automation_id" uuid,
	"action" jsonb NOT NULL,
	"context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"run_at" timestamp with time zone NOT NULL,
	"status" "scheduled_action_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "next_action_feedback" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"lead_id" uuid NOT NULL,
	"actor_user_id" varchar,
	"action_type" text NOT NULL,
	"response" text NOT NULL,
	"snoozed_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "playbook_enrollments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"playbook_id" uuid NOT NULL,
	"lead_id" uuid NOT NULL,
	"kind" text DEFAULT 'outreach' NOT NULL,
	"category" text DEFAULT 'acquisition' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"current_step" integer DEFAULT 0 NOT NULL,
	"pause_reason" text,
	"next_run_at" timestamp with time zone,
	"history" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "playbooks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"category" text DEFAULT 'acquisition' NOT NULL,
	"seed_key" text,
	"kind" text DEFAULT 'outreach' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"enrollment_rules" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lead_imports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"file_name" text,
	"total_rows" integer DEFAULT 0 NOT NULL,
	"imported" integer DEFAULT 0 NOT NULL,
	"duplicates" integer DEFAULT 0 NOT NULL,
	"skipped" integer DEFAULT 0 NOT NULL,
	"suppressed" integer DEFAULT 0 NOT NULL,
	"errors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by_user_id" varchar,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reactivation_campaign_leads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"campaign_id" uuid NOT NULL,
	"lead_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"enrollment_id" uuid,
	"previous_lead_status" text,
	"detail" text,
	"enrolled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reactivation_campaigns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"playbook_id" uuid NOT NULL,
	"segment" jsonb NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"rate_per_hour" integer DEFAULT 20 NOT NULL,
	"total_leads" integer DEFAULT 0 NOT NULL,
	"launched_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_by_user_id" varchar,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "playbook_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"playbook_id" uuid,
	"kind" text NOT NULL,
	"step_index" integer,
	"decision" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"explanation" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "playbook_touches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"playbook_id" uuid NOT NULL,
	"enrollment_id" uuid NOT NULL,
	"lead_id" uuid NOT NULL,
	"step_index" integer NOT NULL,
	"variant_key" text DEFAULT 'default' NOT NULL,
	"channel" text NOT NULL,
	"provider" text NOT NULL,
	"sent_hour_utc" integer NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	"provider_message_id" text,
	"delivery" text,
	"delivery_at" timestamp with time zone,
	"replied_at" timestamp with time zone,
	"booked_at" timestamp with time zone,
	"final_outcome" text,
	"final_outcome_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"event" text NOT NULL,
	"payload" jsonb NOT NULL,
	"signature" text NOT NULL,
	"signature_version" text DEFAULT 'v1' NOT NULL,
	"status" "webhook_delivery_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"response_status" integer,
	"last_error" text,
	"delivered_at" timestamp with time zone,
	"next_attempt_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_endpoints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"url" text NOT NULL,
	"secret" text NOT NULL,
	"previous_secret" text,
	"previous_secret_expires_at" timestamp with time zone,
	"events" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lead_tags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"lead_id" uuid NOT NULL,
	"tag_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"color" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "saved_filters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" varchar NOT NULL,
	"name" text NOT NULL,
	"filters" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"prefix" text NOT NULL,
	"key_hash" text NOT NULL,
	"role" "user_role" DEFAULT 'office' NOT NULL,
	"created_by_user_id" varchar NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"expires_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"expiry_reminder_sent_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_keys_key_hash_unique" UNIQUE("key_hash")
);
--> statement-breakpoint
CREATE TABLE "authorized_domains" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"domain" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "installation_checks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"domain" text NOT NULL,
	"status" text NOT NULL,
	"detail" text DEFAULT '' NOT NULL,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "installation_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"public_key" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"revoked_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone,
	"last_seen_version" text,
	"last_seen_host" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "installation_keys_public_key_unique" UNIQUE("public_key")
);
--> statement-breakpoint
CREATE TABLE "form_submissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"form_id" uuid NOT NULL,
	"lead_id" uuid,
	"contact_id" uuid,
	"answers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"attribution" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"dedupe_outcome" text DEFAULT 'new_lead' NOT NULL,
	"source_ip" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "forms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"seed_key" text,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "suppressions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"value" text NOT NULL,
	"reason" text NOT NULL,
	"source" text,
	"detail" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"category" text NOT NULL,
	"title" text NOT NULL,
	"content" text NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "portal_login_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"identifier" text NOT NULL,
	"channel" text NOT NULL,
	"code_hash" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "portal_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"identifier" text NOT NULL,
	"channel" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "portal_sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "rate_limit_counters" (
	"key" text PRIMARY KEY NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"reset_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "assistant_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" varchar NOT NULL,
	"messages" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_idempotency_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"key" text NOT NULL,
	"response_status" integer NOT NULL,
	"response_body" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "capture_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"idempotency_key" text,
	"lead_id" uuid,
	"outcome" text NOT NULL,
	"detail" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "capture_endpoints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"token" text NOT NULL,
	"mapping" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"default_source" text DEFAULT 'external-form' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_received_at" timestamp with time zone,
	"received_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "smart_site_followups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"lead_id" uuid NOT NULL,
	"actor_user_id" varchar NOT NULL,
	"request_id" uuid NOT NULL,
	"payload_hash" text NOT NULL,
	"channel" text NOT NULL,
	"outcome" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "smart_site_onboardings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"actor_user_id" varchar NOT NULL,
	"request_id" uuid NOT NULL,
	"payload_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "smart_site_submissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"payload_hash" text NOT NULL,
	"lead_id" uuid NOT NULL,
	"consent" jsonb NOT NULL,
	"site_received_at" timestamp with time zone,
	"response_due_at" timestamp with time zone,
	"first_attempt_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "smart_sites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"site_key" text NOT NULL,
	"profile" text NOT NULL,
	"source" text NOT NULL,
	"key_hash" text NOT NULL,
	"credential_issued_at" timestamp with time zone,
	"credential_version" integer DEFAULT 1 NOT NULL,
	"credential_checked_at" timestamp with time zone,
	"is_active" boolean DEFAULT false NOT NULL,
	"response_target_minutes" integer DEFAULT 60 NOT NULL,
	"analytics_enabled" boolean DEFAULT false NOT NULL,
	"analytics_retention_days" integer DEFAULT 90 NOT NULL,
	"analytics_policy_version" text DEFAULT 'smart-sites-analytics-v1' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bie_action_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"run_id" uuid,
	"lead_id" uuid NOT NULL,
	"action_type" text NOT NULL,
	"status" text DEFAULT 'proposed' NOT NULL,
	"title" text NOT NULL,
	"rationale" text NOT NULL,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"estimated_value_cents" integer,
	"created_by_user_id" varchar,
	"reviewed_by_user_id" varchar,
	"reviewed_at" timestamp with time zone,
	"executed_at" timestamp with time zone,
	"execution_detail" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bie_agent_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"trigger" text DEFAULT 'manual' NOT NULL,
	"initiated_by_user_id" varchar,
	"summary" text,
	"result" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "bie_autopilot_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"policy" jsonb DEFAULT '{"enabled":false,"allowedActions":[],"dailyEmailCap":20}'::jsonb NOT NULL,
	"updated_by_user_id" varchar,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bie_connected_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"source" text NOT NULL,
	"status" text DEFAULT 'not_connected' NOT NULL,
	"account_label" text,
	"granted_scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_synced_at" timestamp with time zone,
	"last_error" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "claim_canonical_graphs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"status" text NOT NULL,
	"source_kind" text NOT NULL,
	"source_reference" text NOT NULL,
	"ruleset_version" text NOT NULL,
	"graph" jsonb NOT NULL,
	"graph_hash" text NOT NULL,
	"invariant_report" jsonb NOT NULL,
	"created_by_user_id" varchar,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "claim_cases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"lead_id" uuid,
	"property_id" uuid,
	"title" text NOT NULL,
	"loss_type" text,
	"loss_date" timestamp with time zone,
	"description" text,
	"status" text DEFAULT 'open' NOT NULL,
	"created_by_user_id" varchar,
	"updated_by_user_id" varchar,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "claim_certificates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"executive_summary" text NOT NULL,
	"findings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"conflicts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"gaps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"limitations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"recommended_next_steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"content_hash" text NOT NULL,
	"integrity_version" text DEFAULT '' NOT NULL,
	"integrity_manifest" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"integrity_hash" text DEFAULT '' NOT NULL,
	"model_details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by_user_id" varchar,
	"issued_by_user_id" varchar,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"issued_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "claim_evidence_artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"filename" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"sha256" text NOT NULL,
	"blob" "bytea",
	"redacted_text" text,
	"source_label" text,
	"ai_use_approved_at" timestamp with time zone,
	"ai_use_approved_by_user_id" varchar,
	"created_by_user_id" varchar,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "claim_evidence_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"model" text NOT NULL,
	"prompt_version" text NOT NULL,
	"trace_id" text,
	"manifest" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"manifest_hash" text DEFAULT '' NOT NULL,
	"usage" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" text,
	"initiated_by_user_id" varchar,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "claim_execution_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"route_packet_id" uuid NOT NULL,
	"attempt" integer NOT NULL,
	"state" text DEFAULT 'prepared' NOT NULL,
	"receipt" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"receipt_hash" text DEFAULT '' NOT NULL,
	"target_evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "claim_loss_corroborations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"canonical_graph_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"status" text DEFAULT 'computed' NOT NULL,
	"calculation_version" text NOT NULL,
	"source_manifest" jsonb NOT NULL,
	"source_manifest_hash" text NOT NULL,
	"assessment" jsonb NOT NULL,
	"assessment_hash" text NOT NULL,
	"created_by_user_id" varchar,
	"reviewed_by_user_id" varchar,
	"reviewed_at" timestamp with time zone,
	"review_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "claim_observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"artifact_id" uuid,
	"category" text NOT NULL,
	"statement" text NOT NULL,
	"locator" text,
	"basis" text,
	"confidence" integer NOT NULL,
	"needs_human_review" boolean DEFAULT true NOT NULL,
	"status" text DEFAULT 'ai_draft' NOT NULL,
	"reviewed_by_user_id" varchar,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "claim_route_packets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"certificate_id" uuid NOT NULL,
	"corroboration_id" uuid,
	"version" integer NOT NULL,
	"status" text DEFAULT 'ready' NOT NULL,
	"target" text NOT NULL,
	"operation" text NOT NULL,
	"adapter_name" text NOT NULL,
	"adapter_version" text NOT NULL,
	"adapter_fingerprint" text NOT NULL,
	"certificate_integrity_hash" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"packet" jsonb NOT NULL,
	"packet_hash" text NOT NULL,
	"side_effect_budget" jsonb NOT NULL,
	"created_by_user_id" varchar,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stored_objects" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid,
	"data" "bytea" NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gmail_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" varchar NOT NULL,
	"email" text NOT NULL,
	"encrypted_refresh_token" text,
	"granted_scopes" text[] DEFAULT '{}' NOT NULL,
	"connected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"last_error_at" timestamp with time zone,
	"last_error_code" text,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "google_integration_modules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" varchar NOT NULL,
	"module" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"enabled_at" timestamp with time zone,
	"disabled_at" timestamp with time zone,
	"last_synced_at" timestamp with time zone,
	"last_cursor" text,
	"last_error_at" timestamp with time zone,
	"last_error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" varchar NOT NULL,
	"provider" text NOT NULL,
	"module" text DEFAULT 'gmail_send' NOT NULL,
	"requested_scopes" text[] DEFAULT '{}' NOT NULL,
	"state_hash" text NOT NULL,
	"encrypted_code_verifier" text NOT NULL,
	"return_path" text DEFAULT '/settings' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_intelligence_facts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'needs_review' NOT NULL,
	"statement" text NOT NULL,
	"evidence_excerpt" text NOT NULL,
	"confidence" integer NOT NULL,
	"extractor_version" text DEFAULT 'deterministic-v1' NOT NULL,
	"reviewed_by_user_id" varchar,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_intelligence_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"external_message_id" text NOT NULL,
	"content_sha256" text NOT NULL,
	"forwarded_by" text NOT NULL,
	"from_email" text NOT NULL,
	"to_emails" text[] DEFAULT '{}' NOT NULL,
	"redacted_subject" text NOT NULL,
	"encrypted_raw_text" text,
	"status" text DEFAULT 'processed' NOT NULL,
	"sent_at" timestamp with time zone,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"raw_expires_at" timestamp with time zone NOT NULL,
	"raw_purged_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_intelligence_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"intake_alias" text NOT NULL,
	"display_name" text DEFAULT 'Email Intelligence Inbox' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"allowed_forwarders" text[] DEFAULT '{}' NOT NULL,
	"retention_days" integer DEFAULT 7 NOT NULL,
	"attachments_enabled" boolean DEFAULT false NOT NULL,
	"last_received_at" timestamp with time zone,
	"last_error_at" timestamp with time zone,
	"last_error_code" text,
	"created_by_user_id" varchar,
	"updated_by_user_id" varchar,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
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
ALTER TABLE "users" ADD CONSTRAINT "users_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_tokens" ADD CONSTRAINT "identity_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "properties" ADD CONSTRAINT "properties_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "properties" ADD CONSTRAINT "properties_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_assigned_user_id_users_id_fk" FOREIGN KEY ("assigned_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engagement_links" ADD CONSTRAINT "engagement_links_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engagement_links" ADD CONSTRAINT "engagement_links_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engagement_links" ADD CONSTRAINT "engagement_links_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "estimates" ADD CONSTRAINT "estimates_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "estimates" ADD CONSTRAINT "estimates_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_estimate_id_estimates_id_fk" FOREIGN KEY ("estimate_id") REFERENCES "public"."estimates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_tasks" ADD CONSTRAINT "crm_tasks_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_tasks" ADD CONSTRAINT "crm_tasks_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_tasks" ADD CONSTRAINT "crm_tasks_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_tasks" ADD CONSTRAINT "crm_tasks_assigned_user_id_users_id_fk" FOREIGN KEY ("assigned_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_assigned_user_id_users_id_fk" FOREIGN KEY ("assigned_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_obligations" ADD CONSTRAINT "service_obligations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_obligations" ADD CONSTRAINT "service_obligations_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_obligations" ADD CONSTRAINT "service_obligations_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_obligations" ADD CONSTRAINT "service_obligations_appointment_id_appointments_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_obligations" ADD CONSTRAINT "service_obligations_task_id_crm_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."crm_tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activities" ADD CONSTRAINT "activities_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activities" ADD CONSTRAINT "activities_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activities" ADD CONSTRAINT "activities_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activities" ADD CONSTRAINT "activities_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_records" ADD CONSTRAINT "consent_records_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_records" ADD CONSTRAINT "consent_records_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
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
ALTER TABLE "conversation_messages" ADD CONSTRAINT "conversation_messages_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_messages" ADD CONSTRAINT "conversation_messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analytics_events" ADD CONSTRAINT "analytics_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analytics_events" ADD CONSTRAINT "analytics_events_smart_site_id_smart_sites_id_fk" FOREIGN KEY ("smart_site_id") REFERENCES "public"."smart_sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analytics_events" ADD CONSTRAINT "analytics_events_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_settings" ADD CONSTRAINT "org_settings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_templates" ADD CONSTRAINT "message_templates_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_automation_id_automations_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."automations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automations" ADD CONSTRAINT "automations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_actions" ADD CONSTRAINT "scheduled_actions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_actions" ADD CONSTRAINT "scheduled_actions_automation_id_automations_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."automations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "next_action_feedback" ADD CONSTRAINT "next_action_feedback_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "next_action_feedback" ADD CONSTRAINT "next_action_feedback_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "next_action_feedback" ADD CONSTRAINT "next_action_feedback_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playbook_enrollments" ADD CONSTRAINT "playbook_enrollments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playbook_enrollments" ADD CONSTRAINT "playbook_enrollments_playbook_id_playbooks_id_fk" FOREIGN KEY ("playbook_id") REFERENCES "public"."playbooks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playbook_enrollments" ADD CONSTRAINT "playbook_enrollments_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playbooks" ADD CONSTRAINT "playbooks_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_imports" ADD CONSTRAINT "lead_imports_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_imports" ADD CONSTRAINT "lead_imports_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reactivation_campaign_leads" ADD CONSTRAINT "reactivation_campaign_leads_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reactivation_campaign_leads" ADD CONSTRAINT "reactivation_campaign_leads_campaign_id_reactivation_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."reactivation_campaigns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reactivation_campaign_leads" ADD CONSTRAINT "reactivation_campaign_leads_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reactivation_campaign_leads" ADD CONSTRAINT "reactivation_campaign_leads_enrollment_id_playbook_enrollments_id_fk" FOREIGN KEY ("enrollment_id") REFERENCES "public"."playbook_enrollments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reactivation_campaigns" ADD CONSTRAINT "reactivation_campaigns_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reactivation_campaigns" ADD CONSTRAINT "reactivation_campaigns_playbook_id_playbooks_id_fk" FOREIGN KEY ("playbook_id") REFERENCES "public"."playbooks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reactivation_campaigns" ADD CONSTRAINT "reactivation_campaigns_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playbook_decisions" ADD CONSTRAINT "playbook_decisions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playbook_decisions" ADD CONSTRAINT "playbook_decisions_playbook_id_playbooks_id_fk" FOREIGN KEY ("playbook_id") REFERENCES "public"."playbooks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playbook_touches" ADD CONSTRAINT "playbook_touches_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playbook_touches" ADD CONSTRAINT "playbook_touches_playbook_id_playbooks_id_fk" FOREIGN KEY ("playbook_id") REFERENCES "public"."playbooks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playbook_touches" ADD CONSTRAINT "playbook_touches_enrollment_id_playbook_enrollments_id_fk" FOREIGN KEY ("enrollment_id") REFERENCES "public"."playbook_enrollments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playbook_touches" ADD CONSTRAINT "playbook_touches_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_endpoint_id_webhook_endpoints_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "public"."webhook_endpoints"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_tags" ADD CONSTRAINT "lead_tags_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_tags" ADD CONSTRAINT "lead_tags_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_tags" ADD CONSTRAINT "lead_tags_tag_id_tags_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."tags"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tags" ADD CONSTRAINT "tags_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_filters" ADD CONSTRAINT "saved_filters_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_filters" ADD CONSTRAINT "saved_filters_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "authorized_domains" ADD CONSTRAINT "authorized_domains_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "installation_checks" ADD CONSTRAINT "installation_checks_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "installation_keys" ADD CONSTRAINT "installation_keys_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_submissions" ADD CONSTRAINT "form_submissions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_submissions" ADD CONSTRAINT "form_submissions_form_id_forms_id_fk" FOREIGN KEY ("form_id") REFERENCES "public"."forms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_submissions" ADD CONSTRAINT "form_submissions_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_submissions" ADD CONSTRAINT "form_submissions_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forms" ADD CONSTRAINT "forms_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suppressions" ADD CONSTRAINT "suppressions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_entries" ADD CONSTRAINT "knowledge_entries_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_login_codes" ADD CONSTRAINT "portal_login_codes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_sessions" ADD CONSTRAINT "portal_sessions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_history" ADD CONSTRAINT "assistant_history_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_history" ADD CONSTRAINT "assistant_history_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_idempotency_keys" ADD CONSTRAINT "api_idempotency_keys_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capture_deliveries" ADD CONSTRAINT "capture_deliveries_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capture_deliveries" ADD CONSTRAINT "capture_deliveries_endpoint_id_capture_endpoints_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "public"."capture_endpoints"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capture_deliveries" ADD CONSTRAINT "capture_deliveries_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capture_endpoints" ADD CONSTRAINT "capture_endpoints_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "smart_site_followups" ADD CONSTRAINT "smart_site_followups_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "smart_site_followups" ADD CONSTRAINT "smart_site_followups_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "smart_site_followups" ADD CONSTRAINT "smart_site_followups_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "smart_site_onboardings" ADD CONSTRAINT "smart_site_onboardings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "smart_site_onboardings" ADD CONSTRAINT "smart_site_onboardings_site_id_smart_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."smart_sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "smart_site_onboardings" ADD CONSTRAINT "smart_site_onboardings_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "smart_site_submissions" ADD CONSTRAINT "smart_site_submissions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "smart_site_submissions" ADD CONSTRAINT "smart_site_submissions_site_id_smart_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."smart_sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "smart_site_submissions" ADD CONSTRAINT "smart_site_submissions_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "smart_sites" ADD CONSTRAINT "smart_sites_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bie_action_proposals" ADD CONSTRAINT "bie_action_proposals_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bie_action_proposals" ADD CONSTRAINT "bie_action_proposals_run_id_bie_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."bie_agent_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bie_action_proposals" ADD CONSTRAINT "bie_action_proposals_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bie_action_proposals" ADD CONSTRAINT "bie_action_proposals_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bie_action_proposals" ADD CONSTRAINT "bie_action_proposals_reviewed_by_user_id_users_id_fk" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bie_agent_runs" ADD CONSTRAINT "bie_agent_runs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bie_agent_runs" ADD CONSTRAINT "bie_agent_runs_initiated_by_user_id_users_id_fk" FOREIGN KEY ("initiated_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bie_autopilot_policies" ADD CONSTRAINT "bie_autopilot_policies_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bie_autopilot_policies" ADD CONSTRAINT "bie_autopilot_policies_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bie_connected_sources" ADD CONSTRAINT "bie_connected_sources_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_canonical_graphs" ADD CONSTRAINT "claim_canonical_graphs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_canonical_graphs" ADD CONSTRAINT "claim_canonical_graphs_case_id_claim_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."claim_cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_canonical_graphs" ADD CONSTRAINT "claim_canonical_graphs_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_cases" ADD CONSTRAINT "claim_cases_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_cases" ADD CONSTRAINT "claim_cases_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_cases" ADD CONSTRAINT "claim_cases_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_cases" ADD CONSTRAINT "claim_cases_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_cases" ADD CONSTRAINT "claim_cases_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_certificates" ADD CONSTRAINT "claim_certificates_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_certificates" ADD CONSTRAINT "claim_certificates_case_id_claim_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."claim_cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_certificates" ADD CONSTRAINT "claim_certificates_run_id_claim_evidence_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."claim_evidence_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_certificates" ADD CONSTRAINT "claim_certificates_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_certificates" ADD CONSTRAINT "claim_certificates_issued_by_user_id_users_id_fk" FOREIGN KEY ("issued_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_evidence_artifacts" ADD CONSTRAINT "claim_evidence_artifacts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_evidence_artifacts" ADD CONSTRAINT "claim_evidence_artifacts_case_id_claim_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."claim_cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_evidence_artifacts" ADD CONSTRAINT "claim_evidence_artifacts_ai_use_approved_by_user_id_users_id_fk" FOREIGN KEY ("ai_use_approved_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_evidence_artifacts" ADD CONSTRAINT "claim_evidence_artifacts_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_evidence_runs" ADD CONSTRAINT "claim_evidence_runs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_evidence_runs" ADD CONSTRAINT "claim_evidence_runs_case_id_claim_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."claim_cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_evidence_runs" ADD CONSTRAINT "claim_evidence_runs_initiated_by_user_id_users_id_fk" FOREIGN KEY ("initiated_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_execution_receipts" ADD CONSTRAINT "claim_execution_receipts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_execution_receipts" ADD CONSTRAINT "claim_execution_receipts_case_id_claim_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."claim_cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_execution_receipts" ADD CONSTRAINT "claim_execution_receipts_route_packet_id_claim_route_packets_id_fk" FOREIGN KEY ("route_packet_id") REFERENCES "public"."claim_route_packets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_loss_corroborations" ADD CONSTRAINT "claim_loss_corroborations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_loss_corroborations" ADD CONSTRAINT "claim_loss_corroborations_case_id_claim_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."claim_cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_loss_corroborations" ADD CONSTRAINT "claim_loss_corroborations_canonical_graph_id_claim_canonical_graphs_id_fk" FOREIGN KEY ("canonical_graph_id") REFERENCES "public"."claim_canonical_graphs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_loss_corroborations" ADD CONSTRAINT "claim_loss_corroborations_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_loss_corroborations" ADD CONSTRAINT "claim_loss_corroborations_reviewed_by_user_id_users_id_fk" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_observations" ADD CONSTRAINT "claim_observations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_observations" ADD CONSTRAINT "claim_observations_case_id_claim_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."claim_cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_observations" ADD CONSTRAINT "claim_observations_run_id_claim_evidence_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."claim_evidence_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_observations" ADD CONSTRAINT "claim_observations_artifact_id_claim_evidence_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."claim_evidence_artifacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_observations" ADD CONSTRAINT "claim_observations_reviewed_by_user_id_users_id_fk" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_route_packets" ADD CONSTRAINT "claim_route_packets_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_route_packets" ADD CONSTRAINT "claim_route_packets_case_id_claim_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."claim_cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_route_packets" ADD CONSTRAINT "claim_route_packets_certificate_id_claim_certificates_id_fk" FOREIGN KEY ("certificate_id") REFERENCES "public"."claim_certificates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_route_packets" ADD CONSTRAINT "claim_route_packets_corroboration_id_claim_loss_corroborations_id_fk" FOREIGN KEY ("corroboration_id") REFERENCES "public"."claim_loss_corroborations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_route_packets" ADD CONSTRAINT "claim_route_packets_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stored_objects" ADD CONSTRAINT "stored_objects_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gmail_connections" ADD CONSTRAINT "gmail_connections_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gmail_connections" ADD CONSTRAINT "gmail_connections_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "google_integration_modules" ADD CONSTRAINT "google_integration_modules_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "google_integration_modules" ADD CONSTRAINT "google_integration_modules_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_transactions" ADD CONSTRAINT "oauth_transactions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_transactions" ADD CONSTRAINT "oauth_transactions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_intelligence_facts" ADD CONSTRAINT "email_intelligence_facts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_intelligence_facts" ADD CONSTRAINT "email_intelligence_facts_source_id_email_intelligence_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."email_intelligence_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_intelligence_facts" ADD CONSTRAINT "email_intelligence_facts_message_id_email_intelligence_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."email_intelligence_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_intelligence_facts" ADD CONSTRAINT "email_intelligence_facts_reviewed_by_user_id_users_id_fk" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_intelligence_messages" ADD CONSTRAINT "email_intelligence_messages_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_intelligence_messages" ADD CONSTRAINT "email_intelligence_messages_source_id_email_intelligence_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."email_intelligence_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_intelligence_sources" ADD CONSTRAINT "email_intelligence_sources_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_intelligence_sources" ADD CONSTRAINT "email_intelligence_sources_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_intelligence_sources" ADD CONSTRAINT "email_intelligence_sources_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
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
CREATE UNIQUE INDEX "organizations_slug_idx" ON "organizations" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "IDX_session_expire" ON "sessions" USING btree ("expire");--> statement-breakpoint
CREATE INDEX "identity_tokens_user_purpose_idx" ON "identity_tokens" USING btree ("user_id","purpose");--> statement-breakpoint
CREATE INDEX "identity_tokens_expires_idx" ON "identity_tokens" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "contacts_org_phone_idx" ON "contacts" USING btree ("organization_id","phone");--> statement-breakpoint
CREATE INDEX "contacts_org_email_idx" ON "contacts" USING btree ("organization_id","email");--> statement-breakpoint
CREATE INDEX "properties_org_address_idx" ON "properties" USING btree ("organization_id","address_line_1","postal_code");--> statement-breakpoint
CREATE INDEX "leads_org_status_idx" ON "leads" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "leads_org_assigned_idx" ON "leads" USING btree ("organization_id","assigned_user_id");--> statement-breakpoint
CREATE INDEX "leads_org_anon_idx" ON "leads" USING btree ("organization_id","anonymous_id");--> statement-breakpoint
CREATE UNIQUE INDEX "engagement_links_token_idx" ON "engagement_links" USING btree ("token");--> statement-breakpoint
CREATE UNIQUE INDEX "engagement_links_contact_kind_idx" ON "engagement_links" USING btree ("contact_id","kind");--> statement-breakpoint
CREATE INDEX "engagement_links_org_idx" ON "engagement_links" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "estimates_org_status_idx" ON "estimates" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "estimates_org_lead_idx" ON "estimates" USING btree ("organization_id","lead_id");--> statement-breakpoint
CREATE INDEX "projects_org_status_idx" ON "projects" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "projects_org_lead_idx" ON "projects" USING btree ("organization_id","lead_id");--> statement-breakpoint
CREATE UNIQUE INDEX "projects_estimate_unique_idx" ON "projects" USING btree ("estimate_id") WHERE "projects"."estimate_id" is not null;--> statement-breakpoint
CREATE INDEX "crm_tasks_org_status_idx" ON "crm_tasks" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "crm_tasks_org_assigned_idx" ON "crm_tasks" USING btree ("organization_id","assigned_user_id");--> statement-breakpoint
CREATE INDEX "appointments_org_start_idx" ON "appointments" USING btree ("organization_id","scheduled_start");--> statement-breakpoint
CREATE INDEX "appointments_org_assigned_idx" ON "appointments" USING btree ("organization_id","assigned_user_id");--> statement-breakpoint
CREATE INDEX "service_obligations_org_due_idx" ON "service_obligations" USING btree ("organization_id","status","due_at");--> statement-breakpoint
CREATE UNIQUE INDEX "service_obligations_org_external_uq" ON "service_obligations" USING btree ("organization_id","source","external_ref") WHERE "service_obligations"."external_ref" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "service_obligations_task_uq" ON "service_obligations" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "activities_org_lead_idx" ON "activities" USING btree ("organization_id","lead_id","occurred_at");--> statement-breakpoint
CREATE INDEX "consent_org_contact_idx" ON "consent_records" USING btree ("organization_id","contact_id");--> statement-breakpoint
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
CREATE INDEX "conversation_messages_conv_idx" ON "conversation_messages" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "conversations_org_lead_idx" ON "conversations" USING btree ("organization_id","lead_id");--> statement-breakpoint
CREATE INDEX "conversations_org_status_idx" ON "conversations" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "analytics_org_event_idx" ON "analytics_events" USING btree ("organization_id","event_name","occurred_at");--> statement-breakpoint
CREATE INDEX "analytics_org_anon_idx" ON "analytics_events" USING btree ("organization_id","anonymous_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "analytics_smart_site_event_uq" ON "analytics_events" USING btree ("smart_site_id","event_id");--> statement-breakpoint
CREATE INDEX "analytics_smart_site_time_idx" ON "analytics_events" USING btree ("smart_site_id","occurred_at");--> statement-breakpoint
CREATE INDEX "analytics_org_lead_idx" ON "analytics_events" USING btree ("organization_id","lead_id");--> statement-breakpoint
CREATE INDEX "audit_events_org_created_idx" ON "audit_events" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "org_settings_org_idx" ON "org_settings" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "message_templates_org_name_idx" ON "message_templates" USING btree ("organization_id","name");--> statement-breakpoint
CREATE INDEX "automation_runs_org_created_idx" ON "automation_runs" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "automations_org_event_idx" ON "automations" USING btree ("organization_id","event");--> statement-breakpoint
CREATE UNIQUE INDEX "automations_org_seed_key_idx" ON "automations" USING btree ("organization_id","seed_key") WHERE "automations"."seed_key" is not null;--> statement-breakpoint
CREATE INDEX "scheduled_actions_status_run_idx" ON "scheduled_actions" USING btree ("status","run_at");--> statement-breakpoint
CREATE INDEX "next_action_feedback_org_lead_idx" ON "next_action_feedback" USING btree ("organization_id","lead_id");--> statement-breakpoint
CREATE INDEX "playbook_enrollments_org_lead_idx" ON "playbook_enrollments" USING btree ("organization_id","lead_id");--> statement-breakpoint
CREATE UNIQUE INDEX "playbook_enrollments_lead_active_idx" ON "playbook_enrollments" USING btree ("lead_id","category") WHERE "playbook_enrollments"."status" in ('active', 'paused') and "playbook_enrollments"."kind" = 'outreach';--> statement-breakpoint
CREATE UNIQUE INDEX "playbook_enrollments_lead_playbook_active_idx" ON "playbook_enrollments" USING btree ("lead_id","playbook_id") WHERE "playbook_enrollments"."status" in ('active', 'paused');--> statement-breakpoint
CREATE INDEX "playbooks_org_idx" ON "playbooks" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "playbooks_org_seed_key_idx" ON "playbooks" USING btree ("organization_id","seed_key") WHERE "playbooks"."seed_key" is not null;--> statement-breakpoint
CREATE INDEX "lead_imports_org_idx" ON "lead_imports" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "reactivation_campaign_leads_unique_idx" ON "reactivation_campaign_leads" USING btree ("campaign_id","lead_id");--> statement-breakpoint
CREATE INDEX "reactivation_campaign_leads_status_idx" ON "reactivation_campaign_leads" USING btree ("campaign_id","status");--> statement-breakpoint
CREATE INDEX "reactivation_campaigns_org_idx" ON "reactivation_campaigns" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "playbook_decisions_org_created_idx" ON "playbook_decisions" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "playbook_touches_org_pb_step_variant_idx" ON "playbook_touches" USING btree ("organization_id","playbook_id","step_index","variant_key");--> statement-breakpoint
CREATE INDEX "playbook_touches_org_lead_idx" ON "playbook_touches" USING btree ("organization_id","lead_id");--> statement-breakpoint
CREATE INDEX "playbook_touches_provider_msg_idx" ON "playbook_touches" USING btree ("provider_message_id");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_org_created_idx" ON "webhook_deliveries" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_status_next_idx" ON "webhook_deliveries" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "webhook_endpoints_org_idx" ON "webhook_endpoints" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "lead_tags_lead_tag_idx" ON "lead_tags" USING btree ("lead_id","tag_id");--> statement-breakpoint
CREATE INDEX "lead_tags_org_idx" ON "lead_tags" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tags_org_name_idx" ON "tags" USING btree ("organization_id","name");--> statement-breakpoint
CREATE INDEX "saved_filters_org_user_idx" ON "saved_filters" USING btree ("organization_id","user_id");--> statement-breakpoint
CREATE INDEX "api_keys_org_idx" ON "api_keys" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "authorized_domains_org_domain_idx" ON "authorized_domains" USING btree ("organization_id","domain");--> statement-breakpoint
CREATE UNIQUE INDEX "installation_checks_org_domain_idx" ON "installation_checks" USING btree ("organization_id","domain");--> statement-breakpoint
CREATE INDEX "installation_keys_org_idx" ON "installation_keys" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "installation_keys_org_active_idx" ON "installation_keys" USING btree ("organization_id") WHERE "installation_keys"."is_active" = true;--> statement-breakpoint
CREATE INDEX "form_submissions_org_form_idx" ON "form_submissions" USING btree ("organization_id","form_id");--> statement-breakpoint
CREATE INDEX "form_submissions_org_lead_idx" ON "form_submissions" USING btree ("organization_id","lead_id");--> statement-breakpoint
CREATE UNIQUE INDEX "forms_org_slug_idx" ON "forms" USING btree ("organization_id","slug");--> statement-breakpoint
CREATE UNIQUE INDEX "forms_org_seed_key_idx" ON "forms" USING btree ("organization_id","seed_key") WHERE "forms"."seed_key" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "suppressions_org_channel_value_idx" ON "suppressions" USING btree ("organization_id","channel","value");--> statement-breakpoint
CREATE INDEX "suppressions_org_idx" ON "suppressions" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "knowledge_entries_org_idx" ON "knowledge_entries" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "portal_login_codes_identifier_idx" ON "portal_login_codes" USING btree ("organization_id","identifier");--> statement-breakpoint
CREATE INDEX "portal_sessions_token_idx" ON "portal_sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "assistant_history_org_user_uniq" ON "assistant_history" USING btree ("organization_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "api_idempotency_org_scope_key_uq" ON "api_idempotency_keys" USING btree ("organization_id","scope","key");--> statement-breakpoint
CREATE UNIQUE INDEX "capture_deliveries_idem_uq" ON "capture_deliveries" USING btree ("endpoint_id","idempotency_key") WHERE "capture_deliveries"."idempotency_key" is not null;--> statement-breakpoint
CREATE INDEX "capture_deliveries_org_idx" ON "capture_deliveries" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "capture_endpoints_token_uq" ON "capture_endpoints" USING btree ("token");--> statement-breakpoint
CREATE INDEX "capture_endpoints_org_idx" ON "capture_endpoints" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "smart_site_followups_request_uq" ON "smart_site_followups" USING btree ("organization_id","request_id");--> statement-breakpoint
CREATE INDEX "smart_site_followups_lead_idx" ON "smart_site_followups" USING btree ("organization_id","lead_id");--> statement-breakpoint
CREATE UNIQUE INDEX "smart_site_onboardings_request_uq" ON "smart_site_onboardings" USING btree ("actor_user_id","request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "smart_site_submissions_request_uq" ON "smart_site_submissions" USING btree ("site_id","request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "smart_site_submissions_lead_uq" ON "smart_site_submissions" USING btree ("lead_id");--> statement-breakpoint
CREATE INDEX "smart_site_submissions_org_created_idx" ON "smart_site_submissions" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "smart_sites_org_key_uq" ON "smart_sites" USING btree ("organization_id","site_key");--> statement-breakpoint
CREATE INDEX "bie_action_proposals_org_status_idx" ON "bie_action_proposals" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "bie_action_proposals_org_lead_idx" ON "bie_action_proposals" USING btree ("organization_id","lead_id");--> statement-breakpoint
CREATE INDEX "bie_agent_runs_org_created_idx" ON "bie_agent_runs" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "bie_autopilot_policies_org_uniq" ON "bie_autopilot_policies" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bie_connected_sources_org_source_uniq" ON "bie_connected_sources" USING btree ("organization_id","source");--> statement-breakpoint
CREATE INDEX "bie_connected_sources_org_idx" ON "bie_connected_sources" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "claim_canonical_graphs_case_version_uniq" ON "claim_canonical_graphs" USING btree ("case_id","version");--> statement-breakpoint
CREATE INDEX "claim_canonical_graphs_org_case_idx" ON "claim_canonical_graphs" USING btree ("organization_id","case_id","created_at");--> statement-breakpoint
CREATE INDEX "claim_canonical_graphs_org_source_idx" ON "claim_canonical_graphs" USING btree ("organization_id","source_kind","source_reference");--> statement-breakpoint
CREATE INDEX "claim_cases_org_status_idx" ON "claim_cases" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "claim_cases_org_created_idx" ON "claim_cases" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "claim_certificates_case_version_uniq" ON "claim_certificates" USING btree ("case_id","version");--> statement-breakpoint
CREATE INDEX "claim_certificates_org_case_idx" ON "claim_certificates" USING btree ("organization_id","case_id");--> statement-breakpoint
CREATE UNIQUE INDEX "claim_artifacts_case_sha_uniq" ON "claim_evidence_artifacts" USING btree ("organization_id","case_id","sha256");--> statement-breakpoint
CREATE INDEX "claim_artifacts_org_case_idx" ON "claim_evidence_artifacts" USING btree ("organization_id","case_id");--> statement-breakpoint
CREATE INDEX "claim_evidence_runs_org_case_idx" ON "claim_evidence_runs" USING btree ("organization_id","case_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "claim_execution_receipts_route_attempt_uniq" ON "claim_execution_receipts" USING btree ("route_packet_id","attempt");--> statement-breakpoint
CREATE INDEX "claim_execution_receipts_org_route_idx" ON "claim_execution_receipts" USING btree ("organization_id","route_packet_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "claim_loss_corroborations_case_version_uniq" ON "claim_loss_corroborations" USING btree ("case_id","version");--> statement-breakpoint
CREATE INDEX "claim_loss_corroborations_org_case_idx" ON "claim_loss_corroborations" USING btree ("organization_id","case_id","created_at");--> statement-breakpoint
CREATE INDEX "claim_loss_corroborations_org_graph_idx" ON "claim_loss_corroborations" USING btree ("organization_id","canonical_graph_id");--> statement-breakpoint
CREATE INDEX "claim_observations_org_case_idx" ON "claim_observations" USING btree ("organization_id","case_id");--> statement-breakpoint
CREATE INDEX "claim_observations_org_status_idx" ON "claim_observations" USING btree ("organization_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "claim_route_packets_case_version_uniq" ON "claim_route_packets" USING btree ("case_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "claim_route_packets_org_idempotency_uniq" ON "claim_route_packets" USING btree ("organization_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "claim_route_packets_org_case_idx" ON "claim_route_packets" USING btree ("organization_id","case_id","created_at");--> statement-breakpoint
CREATE INDEX "stored_objects_org_created_idx" ON "stored_objects" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "gmail_connections_org_user_uniq" ON "gmail_connections" USING btree ("organization_id","user_id");--> statement-breakpoint
CREATE INDEX "gmail_connections_org_email_idx" ON "gmail_connections" USING btree ("organization_id","email");--> statement-breakpoint
CREATE UNIQUE INDEX "google_integration_modules_org_user_module_uniq" ON "google_integration_modules" USING btree ("organization_id","user_id","module");--> statement-breakpoint
CREATE INDEX "google_integration_modules_org_enabled_idx" ON "google_integration_modules" USING btree ("organization_id","enabled");--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_transactions_state_hash_uniq" ON "oauth_transactions" USING btree ("state_hash");--> statement-breakpoint
CREATE INDEX "oauth_transactions_expiry_idx" ON "oauth_transactions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "email_intelligence_facts_org_status_idx" ON "email_intelligence_facts" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "email_intelligence_facts_org_message_idx" ON "email_intelligence_facts" USING btree ("organization_id","message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "email_intelligence_messages_source_external_uniq" ON "email_intelligence_messages" USING btree ("source_id","external_message_id");--> statement-breakpoint
CREATE INDEX "email_intelligence_messages_org_received_idx" ON "email_intelligence_messages" USING btree ("organization_id","received_at");--> statement-breakpoint
CREATE INDEX "email_intelligence_messages_raw_expiry_idx" ON "email_intelligence_messages" USING btree ("raw_expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "email_intelligence_sources_org_uniq" ON "email_intelligence_sources" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "email_intelligence_sources_alias_uniq" ON "email_intelligence_sources" USING btree ("intake_alias");--> statement-breakpoint
CREATE UNIQUE INDEX "decision_room_org_lead_version" ON "decision_rooms" USING btree ("organization_id","lead_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "operating_profile_org_version" ON "operating_profiles" USING btree ("organization_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "project_story_org_project_version" ON "project_stories" USING btree ("organization_id","project_id","version");--> statement-breakpoint
CREATE INDEX "revenue_execution_events_org" ON "revenue_execution_events" USING btree ("organization_id","execution_id");--> statement-breakpoint
CREATE UNIQUE INDEX "revenue_execution_org_key" ON "revenue_executions" USING btree ("organization_id","action_key");--> statement-breakpoint
CREATE INDEX "revenue_execution_org_state" ON "revenue_executions" USING btree ("organization_id","state");--> statement-breakpoint
CREATE UNIQUE INDEX "value_entry_org_reference" ON "value_entries" USING btree ("organization_id","source_reference");--> statement-breakpoint
CREATE INDEX "value_entry_org_lead" ON "value_entries" USING btree ("organization_id","lead_id");