-- REVIEW ONLY. After 0017; baseline a0eb25dcc69291130a46a5478acf44f62d303e9f. No hosted/schema approval.
-- One immutable application admission snapshot; no historical DML or backfill.
-- All 141 prior table definitions are unchanged. Current source totals 142.
CREATE TABLE "staff_lead_alert_coverage" (
	"organization_id" uuid NOT NULL,
	"lead_id" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" text NOT NULL,
	"policy_fingerprint" text,
	"recipients" jsonb NOT NULL,
	CONSTRAINT "staff_lead_alert_coverage_pk" PRIMARY KEY("organization_id","lead_id"),
	CONSTRAINT "staff_lead_alert_coverage_version" CHECK ("staff_lead_alert_coverage"."version" = 1),
	CONSTRAINT "staff_lead_alert_coverage_status" CHECK ("staff_lead_alert_coverage"."status" in ('evaluated', 'policy_unavailable', 'policy_disabled', 'historical_unknown')),
	CONSTRAINT "staff_lead_alert_coverage_policy_hash" CHECK (("staff_lead_alert_coverage"."status" in ('evaluated', 'policy_disabled') and "staff_lead_alert_coverage"."policy_fingerprint" is not null and "staff_lead_alert_coverage"."policy_fingerprint" ~ '^[a-f0-9]{64}$') or ("staff_lead_alert_coverage"."status" in ('policy_unavailable', 'historical_unknown') and "staff_lead_alert_coverage"."policy_fingerprint" is null)),
	CONSTRAINT "staff_lead_alert_coverage_recipients" CHECK (case when jsonb_typeof("staff_lead_alert_coverage"."recipients") = 'array' then octet_length("staff_lead_alert_coverage"."recipients"::text) <= 16384 and (("staff_lead_alert_coverage"."status" = 'evaluated' and jsonb_array_length("staff_lead_alert_coverage"."recipients") between 1 and 20) or ("staff_lead_alert_coverage"."status" <> 'evaluated' and jsonb_array_length("staff_lead_alert_coverage"."recipients") = 0)) else false end)
);
ALTER TABLE "staff_lead_alert_coverage" ADD CONSTRAINT "staff_lead_alert_coverage_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "staff_lead_alert_coverage" ADD CONSTRAINT "staff_lead_alert_coverage_tenant_fk" FOREIGN KEY ("organization_id","lead_id") REFERENCES "public"."leads"("organization_id","id") ON DELETE cascade ON UPDATE no action;
