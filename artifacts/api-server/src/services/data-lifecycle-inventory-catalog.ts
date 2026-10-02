/**
 * Reviewed database classification only. This is not an export allowlist,
 * deletion order, retention policy, or proof of complete account ownership.
 * Every new table must receive an explicit classification before preview runs.
 */
export const DATA_LIFECYCLE_CATALOG_VERSION = "2026-10-01.inventory-v2";
export const DATA_LIFECYCLE_EXPECTED_TABLES = 97;
export const DATA_LIFECYCLE_ROW_LIMIT = 10_000;

export type InventoryCategory =
  | "account_access" | "crm" | "communications" | "acquisition"
  | "automation" | "intelligence" | "audit" | "configuration"
  | "media" | "shared_runtime";
export type InventoryOwnership = "direct_org" | "indirect_org" | "shared_exception";
export type InventorySelector = "organization_id" | "organization_primary_key" | "user_organization" | "excluded";

export type InventoryCatalogEntry = {
  table: string;
  category: InventoryCategory;
  ownership: InventoryOwnership;
  selector: InventorySelector;
};

const direct = (table: string, category: InventoryCategory): InventoryCatalogEntry =>
  ({ table, category, ownership: "direct_org", selector: "organization_id" });
const excluded = (table: string, category: InventoryCategory): InventoryCatalogEntry =>
  ({ table, category, ownership: "shared_exception", selector: "excluded" });

export const DATA_LIFECYCLE_CATALOG: readonly InventoryCatalogEntry[] = [
  direct("activities", "crm"),
  direct("analytics_events", "intelligence"),
  direct("api_idempotency_keys", "audit"),
  direct("api_keys", "account_access"),
  direct("appointments", "crm"),
  direct("assistant_history", "intelligence"),
  direct("audit_events", "audit"),
  direct("authorized_domains", "configuration"),
  direct("automation_runs", "automation"),
  direct("automations", "automation"),
  direct("bie_action_proposals", "intelligence"),
  direct("bie_agent_runs", "intelligence"),
  direct("bie_autopilot_policies", "configuration"),
  direct("bie_connected_sources", "configuration"),
  direct("billing_checkouts", "configuration"),
  direct("capture_deliveries", "acquisition"),
  direct("capture_endpoints", "acquisition"),
  direct("claim_canonical_graphs", "intelligence"),
  direct("claim_cases", "intelligence"),
  direct("claim_certificates", "intelligence"),
  direct("claim_evidence_artifacts", "media"),
  direct("claim_evidence_runs", "intelligence"),
  direct("claim_execution_receipts", "audit"),
  direct("claim_loss_corroborations", "intelligence"),
  direct("claim_observations", "intelligence"),
  direct("claim_route_packets", "intelligence"),
  direct("consent_records", "communications"),
  direct("contacts", "crm"),
  direct("conversation_messages", "communications"),
  direct("conversations", "communications"),
  direct("crm_tasks", "crm"),
  direct("customer_lifecycle", "configuration"),
  direct("decision_rooms", "intelligence"),
  direct("email_intelligence_facts", "intelligence"),
  direct("email_intelligence_messages", "communications"),
  direct("email_intelligence_sources", "configuration"),
  direct("email_sender_preferences", "configuration"),
  direct("engagement_links", "account_access"),
  direct("estimates", "crm"),
  direct("form_submissions", "acquisition"),
  direct("forms", "acquisition"),
  direct("gmail_connections", "account_access"),
  direct("google_integration_modules", "configuration"),
  { table: "identity_tokens", category: "account_access", ownership: "indirect_org", selector: "user_organization" },
  direct("installation_checks", "configuration"),
  direct("installation_keys", "account_access"),
  direct("knowledge_entries", "intelligence"),
  direct("lead_imports", "acquisition"),
  direct("lead_tags", "crm"),
  direct("leads", "crm"),
  direct("message_templates", "communications"),
  direct("microsoft_connections", "account_access"),
  direct("missed_call_handoffs", "communications"),
  direct("next_action_feedback", "intelligence"),
  direct("oauth_transactions", "account_access"),
  direct("operating_profiles", "configuration"),
  direct("org_settings", "configuration"),
  { table: "organizations", category: "configuration", ownership: "direct_org", selector: "organization_primary_key" },
  direct("playbook_decisions", "intelligence"),
  direct("playbook_enrollments", "automation"),
  direct("playbook_touches", "communications"),
  direct("playbooks", "automation"),
  direct("portal_login_codes", "account_access"),
  direct("portal_sessions", "account_access"),
  direct("project_stories", "crm"),
  direct("projects", "crm"),
  direct("properties", "crm"),
  excluded("rate_limit_counters", "shared_runtime"),
  direct("reactivation_campaign_leads", "automation"),
  direct("reactivation_campaigns", "automation"),
  direct("revenue_execution_events", "audit"),
  direct("revenue_executions", "audit"),
  direct("saved_filters", "configuration"),
  direct("scheduled_actions", "automation"),
  excluded("scheduler_runtime", "shared_runtime"),
  direct("service_obligations", "crm"),
  excluded("sessions", "account_access"),
  direct("smart_site_followups", "acquisition"),
  direct("smart_site_onboardings", "acquisition"),
  direct("smart_site_submissions", "acquisition"),
  direct("smart_sites", "acquisition"),
  direct("staff_push_deliveries", "communications"),
  direct("staff_push_policies", "configuration"),
  direct("staff_push_subscriptions", "account_access"),
  direct("stored_objects", "media"),
  direct("suppressions", "communications"),
  direct("tags", "crm"),
  direct("twilio_calls", "communications"),
  direct("twilio_client_bindings", "configuration"),
  direct("twilio_consent_proofs", "communications"),
  direct("twilio_dispatches", "communications"),
  direct("twilio_enrollments", "automation"),
  direct("twilio_inbound_events", "communications"),
  direct("users", "account_access"),
  direct("value_entries", "crm"),
  direct("webhook_deliveries", "communications"),
  direct("webhook_endpoints", "configuration"),
];

/** Always present, including on an empty tenant. No cross-tenant probes. */
export const DATA_LIFECYCLE_BLOCKERS = [
  { code: "json_text_links_unresolved", detail: "Counts follow organization columns and the reviewed identity-token user join only. JSON/text references and cross-row ownership consistency are not traversed." },
  { code: "global_identity_sessions_unresolved", detail: "Unscoped session JSON and global identities are excluded. User and identity-token counts cover current organization association only, not all identity history." },
  { code: "media_ownership_unresolved", detail: "Only explicitly organization-owned database object rows are counted. Null-owned, externally stored, orphaned or shared media and reference ownership remain unresolved; no object IDs or bytes are read." },
  { code: "restricted_email_content", detail: "Email records are counted without reading or decrypting raw email. Raw-content inclusion and derived-record retention require separate review." },
  { code: "shared_runtime_excluded", detail: "Shared rate-limit counters and scheduler runtime are classified but never counted or read for tenant data." },
  { code: "providers_backups_outside_preview", detail: "Provider copies, mailbox contents, billing systems, logs, archives and backups are not inventoried by this database preview." },
  { code: "retention_revocation_unresolved", detail: "Audit, replay prevention, consent/suppression, account closure and credential revocation need an approved lifecycle design. This preview defines no retention policy." },
  { code: "schema_check_scope", detail: "Schema checks cover relation kinds, columns, types, nullability, primary and foreign keys, and row-level security. Defaults, indexes, triggers and live row relationships are not certified." },
  { code: "lifecycle_not_implemented", detail: "This bounded count preview is not a complete inventory, export, deletion preview or erasure workflow." },
] as const;
