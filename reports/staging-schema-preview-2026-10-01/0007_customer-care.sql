-- REVIEW ONLY. Additive customer care after 0006 at ae6b6e4f5a1d4203f40a8b494a6990518cf8b188. Not hosted schema approval.
ALTER TABLE "twilio_calls" ADD CONSTRAINT "twilio_calls_org_id_uq" UNIQUE("organization_id","id");
ALTER TABLE "users" ADD CONSTRAINT "users_org_id_uq" UNIQUE("organization_id","id");
CREATE TABLE "missed_call_care_cases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"call_id" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"state" text DEFAULT 'needs_review' NOT NULL,
	"approved_snapshot" jsonb,
	"approved_by_user_id" varchar,
	"approved_at" timestamp with time zone,
	"owner_user_id" varchar,
	"due_at" timestamp with time zone NOT NULL,
	"reason" text DEFAULT 'staff_review_required' NOT NULL,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE "missed_call_care_policies" (
	"organization_id" uuid PRIMARY KEY NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"timezone" text NOT NULL,
	"days" jsonb NOT NULL,
	"opens_at" text NOT NULL,
	"closes_at" text NOT NULL,
	"business_hours_owner_id" varchar,
	"after_hours_owner_id" varchar,
	"response_minutes" integer DEFAULT 30 NOT NULL,
	"approved_by_user_id" varchar NOT NULL,
	"approved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
ALTER TABLE "missed_call_care_cases" ADD CONSTRAINT "missed_call_care_cases_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "missed_call_care_cases" ADD CONSTRAINT "missed_care_case_call_fk" FOREIGN KEY ("organization_id","call_id") REFERENCES "public"."twilio_calls"("organization_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "missed_call_care_cases" ADD CONSTRAINT "missed_care_case_owner_fk" FOREIGN KEY ("organization_id","owner_user_id") REFERENCES "public"."users"("organization_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "missed_call_care_cases" ADD CONSTRAINT "missed_care_case_approver_fk" FOREIGN KEY ("organization_id","approved_by_user_id") REFERENCES "public"."users"("organization_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "missed_call_care_policies" ADD CONSTRAINT "missed_call_care_policies_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "missed_call_care_policies" ADD CONSTRAINT "missed_care_policy_day_owner_fk" FOREIGN KEY ("organization_id","business_hours_owner_id") REFERENCES "public"."users"("organization_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "missed_call_care_policies" ADD CONSTRAINT "missed_care_policy_after_owner_fk" FOREIGN KEY ("organization_id","after_hours_owner_id") REFERENCES "public"."users"("organization_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "missed_call_care_policies" ADD CONSTRAINT "missed_care_policy_approver_fk" FOREIGN KEY ("organization_id","approved_by_user_id") REFERENCES "public"."users"("organization_id","id") ON DELETE no action ON UPDATE no action;
CREATE UNIQUE INDEX "missed_care_case_call_uq" ON "missed_call_care_cases" USING btree ("call_id");
CREATE UNIQUE INDEX "missed_care_case_org_call_uq" ON "missed_call_care_cases" USING btree ("organization_id","call_id");
CREATE INDEX "missed_care_case_due_idx" ON "missed_call_care_cases" USING btree ("state","due_at");
