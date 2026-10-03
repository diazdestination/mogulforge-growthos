-- REVIEW ONLY. Invoice delivery attempts after 0010 at 51da543db898f9907a4198fbc0ada880c378900d. No hosted approval.
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_event_org_id_uq" UNIQUE("organization_id","id");
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_event_exact_review_uq" UNIQUE("organization_id","id","actor_user_id","entity_id");
ALTER TABLE "revenue_executions" ADD CONSTRAINT "revenue_execution_exact_uq" UNIQUE("organization_id","id","action_key","fingerprint");
ALTER TABLE "revenue_executions" ADD CONSTRAINT "revenue_execution_exact_actor_uq" UNIQUE("organization_id","id","action_key","fingerprint","actor_user_id");
CREATE TABLE "invoice_delivery_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"intent" text NOT NULL,
	"duplicate_copy_acknowledged" boolean DEFAULT false NOT NULL,
	"execution_id" uuid NOT NULL,
	"action_key" text NOT NULL,
	"execution_fingerprint" text NOT NULL,
	"actor_user_id" varchar NOT NULL,
	"preview_id" uuid NOT NULL,
	"payload_sha256" text NOT NULL,
	"document_sha256" text NOT NULL,
	"invoice_version" integer NOT NULL,
	"review_sha256" text NOT NULL,
	"predecessor_execution_id" uuid,
	"predecessor_action_key" text,
	"predecessor_fingerprint" text,
	"predecessor_proof_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoice_attempt_org_id_uq" UNIQUE("organization_id","id"),
	CONSTRAINT "invoice_attempt_ordinal_ck" CHECK ("invoice_delivery_attempts"."ordinal" between 1 and 5 and "invoice_delivery_attempts"."invoice_version" > 0),
	CONSTRAINT "invoice_attempt_copy_ack_ck" CHECK (("invoice_delivery_attempts"."intent" = 'additional_copy') = "invoice_delivery_attempts"."duplicate_copy_acknowledged"),
	CONSTRAINT "invoice_attempt_hash_ck" CHECK ("invoice_delivery_attempts"."execution_fingerprint" ~ '^[a-f0-9]{64}$' and "invoice_delivery_attempts"."payload_sha256" ~ '^[a-f0-9]{64}$' and "invoice_delivery_attempts"."document_sha256" ~ '^[a-f0-9]{64}$' and "invoice_delivery_attempts"."review_sha256" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "invoice_attempt_key_ck" CHECK ("invoice_delivery_attempts"."action_key" = 'invoice-delivery:' || "invoice_delivery_attempts"."invoice_id"::text || case when "invoice_delivery_attempts"."ordinal" = 1 then '' else ':attempt:' || "invoice_delivery_attempts"."ordinal"::text end),
	CONSTRAINT "invoice_attempt_predecessor_ck" CHECK (("invoice_delivery_attempts"."ordinal" = 1 and "invoice_delivery_attempts"."intent" = 'initial' and "invoice_delivery_attempts"."predecessor_execution_id" is null and "invoice_delivery_attempts"."predecessor_action_key" is null and "invoice_delivery_attempts"."predecessor_fingerprint" is null and "invoice_delivery_attempts"."predecessor_proof_id" is null) or ("invoice_delivery_attempts"."ordinal" > 1 and "invoice_delivery_attempts"."intent" in ('retry_not_dispatched','additional_copy') and "invoice_delivery_attempts"."predecessor_execution_id" is not null and "invoice_delivery_attempts"."predecessor_action_key" is not null and "invoice_delivery_attempts"."predecessor_fingerprint" is not null and "invoice_delivery_attempts"."predecessor_proof_id" is not null and "invoice_delivery_attempts"."predecessor_action_key" = 'invoice-delivery:' || "invoice_delivery_attempts"."invoice_id"::text || case when "invoice_delivery_attempts"."ordinal" = 2 then '' else ':attempt:' || ("invoice_delivery_attempts"."ordinal" - 1)::text end))
);
ALTER TABLE "invoice_delivery_attempts" ADD CONSTRAINT "invoice_attempt_invoice_fk" FOREIGN KEY ("organization_id","invoice_id") REFERENCES "public"."invoices"("organization_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "invoice_delivery_attempts" ADD CONSTRAINT "invoice_attempt_actor_fk" FOREIGN KEY ("organization_id","actor_user_id") REFERENCES "public"."users"("organization_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "invoice_delivery_attempts" ADD CONSTRAINT "invoice_attempt_review_fk" FOREIGN KEY ("organization_id","preview_id","actor_user_id","invoice_id") REFERENCES "public"."audit_events"("organization_id","id","actor_user_id","entity_id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "invoice_delivery_attempts" ADD CONSTRAINT "invoice_attempt_execution_fk" FOREIGN KEY ("organization_id","execution_id","action_key","execution_fingerprint","actor_user_id") REFERENCES "public"."revenue_executions"("organization_id","id","action_key","fingerprint","actor_user_id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "invoice_delivery_attempts" ADD CONSTRAINT "invoice_attempt_predecessor_fk" FOREIGN KEY ("organization_id","predecessor_execution_id","predecessor_action_key","predecessor_fingerprint") REFERENCES "public"."revenue_executions"("organization_id","id","action_key","fingerprint") ON DELETE no action ON UPDATE no action;
ALTER TABLE "invoice_delivery_attempts" ADD CONSTRAINT "invoice_attempt_proof_fk" FOREIGN KEY ("organization_id","predecessor_proof_id") REFERENCES "public"."audit_events"("organization_id","id") ON DELETE no action ON UPDATE no action;
CREATE UNIQUE INDEX "invoice_attempt_ordinal_uq" ON "invoice_delivery_attempts" USING btree ("organization_id","invoice_id","ordinal");
CREATE UNIQUE INDEX "invoice_attempt_execution_uq" ON "invoice_delivery_attempts" USING btree ("organization_id","execution_id");
CREATE UNIQUE INDEX "invoice_attempt_preview_uq" ON "invoice_delivery_attempts" USING btree ("organization_id","preview_id");
CREATE UNIQUE INDEX "invoice_attempt_successor_uq" ON "invoice_delivery_attempts" USING btree ("organization_id","predecessor_execution_id") WHERE "invoice_delivery_attempts"."predecessor_execution_id" is not null;
CREATE INDEX "invoice_attempt_invoice_idx" ON "invoice_delivery_attempts" USING btree ("organization_id","invoice_id");
