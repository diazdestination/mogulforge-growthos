-- REVIEW ONLY. After 0019; baseline main@92bc8328825032579bbbbbd959231aadec8dad56. No hosted/schema approval.
-- Zapier Connected Apps: four additive tables; no historical DML or backfill.
-- All 142 prior table definitions are unchanged. Current source totals 146.
CREATE TABLE "zapier_action_executions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"specialist_id" text NOT NULL,
	"capability" text NOT NULL,
	"direction" text NOT NULL,
	"zapier_app" text NOT NULL,
	"zapier_action" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_digest" text NOT NULL,
	"request_summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"response_digest" text,
	"result_summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"state" text NOT NULL,
	"detail" text DEFAULT '' NOT NULL,
	"error_code" text,
	"estimated_tasks" integer DEFAULT 2 NOT NULL,
	"linked_entity_type" text,
	"linked_entity_id" uuid,
	"requested_by_user_id" varchar,
	"approved_by_user_id" varchar,
	"approved_at" timestamp with time zone,
	"durable_execution_id" uuid,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE "zapier_capability_bindings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"capability" text NOT NULL,
	"specialist_id" text NOT NULL,
	"direction" text NOT NULL,
	"zapier_app" text NOT NULL,
	"zapier_app_name" text NOT NULL,
	"zapier_action" text NOT NULL,
	"zapier_action_name" text NOT NULL,
	"zapier_connection_id" text,
	"binding_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"bound_by_user_id" varchar,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE "zapier_mcp_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"connected_by_user_id" varchar,
	"encrypted_server_url" text NOT NULL,
	"server_url_fingerprint" text NOT NULL,
	"server_host" text NOT NULL,
	"server_mode" text DEFAULT 'unknown' NOT NULL,
	"tool_count" integer,
	"last_tools_refreshed_at" timestamp with time zone,
	"connected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"last_error_at" timestamp with time zone,
	"last_error_code" text,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE "zapier_specialist_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"capability" text NOT NULL,
	"specialist_id" text NOT NULL,
	"mode" text DEFAULT 'approve' NOT NULL,
	"daily_budget" integer DEFAULT 25 NOT NULL,
	"updated_by_user_id" varchar,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
ALTER TABLE "zapier_action_executions" ADD CONSTRAINT "zapier_action_executions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "zapier_action_executions" ADD CONSTRAINT "zapier_action_executions_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "zapier_action_executions" ADD CONSTRAINT "zapier_action_executions_approved_by_user_id_users_id_fk" FOREIGN KEY ("approved_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "zapier_capability_bindings" ADD CONSTRAINT "zapier_capability_bindings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "zapier_capability_bindings" ADD CONSTRAINT "zapier_capability_bindings_bound_by_user_id_users_id_fk" FOREIGN KEY ("bound_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "zapier_mcp_connections" ADD CONSTRAINT "zapier_mcp_connections_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "zapier_mcp_connections" ADD CONSTRAINT "zapier_mcp_connections_connected_by_user_id_users_id_fk" FOREIGN KEY ("connected_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "zapier_specialist_policies" ADD CONSTRAINT "zapier_specialist_policies_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "zapier_specialist_policies" ADD CONSTRAINT "zapier_specialist_policies_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
CREATE UNIQUE INDEX "zapier_action_executions_org_idempotency_uniq" ON "zapier_action_executions" USING btree ("organization_id","idempotency_key");
CREATE INDEX "zapier_action_executions_org_state_idx" ON "zapier_action_executions" USING btree ("organization_id","state");
CREATE INDEX "zapier_action_executions_org_capability_created_idx" ON "zapier_action_executions" USING btree ("organization_id","capability","created_at");
CREATE UNIQUE INDEX "zapier_capability_bindings_org_capability_uniq" ON "zapier_capability_bindings" USING btree ("organization_id","capability");
CREATE UNIQUE INDEX "zapier_mcp_connections_org_uniq" ON "zapier_mcp_connections" USING btree ("organization_id");
CREATE INDEX "zapier_mcp_connections_fingerprint_idx" ON "zapier_mcp_connections" USING btree ("server_url_fingerprint");
CREATE UNIQUE INDEX "zapier_specialist_policies_org_capability_uniq" ON "zapier_specialist_policies" USING btree ("organization_id","capability");
