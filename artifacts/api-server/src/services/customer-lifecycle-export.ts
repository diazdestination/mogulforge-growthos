import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import { z } from "zod/v4";
import { CustomerLifecycleError } from "./customer-lifecycle";

type Dataset = { table: string; fields: readonly string[]; references?: Record<string, string> };
// Explicit columns only. Never export SELECT *, opaque metadata, credential
// stores, identity/session tables, provider configuration or raw email payloads.
export const CUSTOMER_EXPORT_DATASETS: readonly Dataset[] = [
  { table: "contacts", fields: ["id", "first_name", "last_name", "email", "phone", "preferred_contact_method", "do_not_contact", "do_not_contact_email", "do_not_contact_sms", "created_at", "updated_at"] },
  { table: "properties", fields: ["id", "contact_id", "address_line_1", "address_line_2", "city", "state", "postal_code", "property_type", "created_at", "updated_at"], references: { contact_id: "contacts" } },
  { table: "leads", fields: ["id", "contact_id", "property_id", "status", "urgency", "service_type", "source", "summary", "estimated_value_cents", "lost_reason", "won_at", "won_revenue_cents", "won_attribution", "creation_method", "import_source_key", "external_opportunity_id", "created_at", "updated_at"], references: { contact_id: "contacts", property_id: "properties" } },
  { table: "estimates", fields: ["id", "lead_id", "title", "status", "line_items", "subtotal_cents", "tax_cents", "total_cents", "notes", "sent_at", "accepted_at", "created_at", "updated_at"], references: { lead_id: "leads" } },
  { table: "projects", fields: ["id", "lead_id", "estimate_id", "name", "status", "scheduled_start", "scheduled_end", "crew_notes", "completed_at", "created_at", "updated_at"], references: { lead_id: "leads", estimate_id: "estimates" } },
  { table: "crm_tasks", fields: ["id", "lead_id", "contact_id", "title", "description", "source_event", "status", "priority", "due_at", "completed_at", "created_at", "updated_at"], references: { lead_id: "leads", contact_id: "contacts" } },
  { table: "appointments", fields: ["id", "lead_id", "contact_id", "property_id", "type", "status", "scheduled_start", "scheduled_end", "notes", "created_at", "updated_at"], references: { lead_id: "leads", contact_id: "contacts", property_id: "properties" } },
  { table: "activities", fields: ["id", "lead_id", "contact_id", "type", "title", "body", "occurred_at", "created_at"], references: { lead_id: "leads", contact_id: "contacts" } },
  { table: "consent_records", fields: ["id", "contact_id", "channel", "granted", "disclosure_version", "recorded_at"], references: { contact_id: "contacts" } },
  { table: "suppressions", fields: ["id", "channel", "value", "reason", "created_at"] },
  { table: "value_entries", fields: ["id", "lead_id", "source_reference", "kind", "amount_cents", "occurred_at", "created_at"], references: { lead_id: "leads" } },
  { table: "revenue_executions", fields: ["id", "kind", "state", "expires_at", "created_at", "completed_at"] },
  { table: "revenue_execution_events", fields: ["id", "execution_id", "state", "created_at"], references: { execution_id: "revenue_executions" } },
  { table: "stored_objects", fields: ["id", "content_type", "size_bytes", "created_at"] },
] as const;
export const CUSTOMER_EXPORT_EXCLUSIONS = [
  "Credentials, passwords, sessions, identity tokens, API keys and provider/billing configuration are excluded.",
  "Opaque activity/import/attribution metadata, provider error details, staff identities and device/IP data are excluded.",
  "Media lists include tenant-owned Postgres metadata only; binary photos, unknown/external object ownership and provider copies are excluded.",
  "Website/form submissions, full conversations/mailboxes, knowledge, analytics, automation definitions/queues and other account tables are outside this core export.",
  "Backups, complete account erasure, retention decisions, billing cancellation and remote credential revocation require a separate operator review.",
] as const;
const lineItems = z.array(z.object({ description: z.string(), quantity: z.number(), unitPriceCents: z.number(), totalCents: z.number() })).max(1000);
const unavailable = () => new CustomerLifecycleError(503, "customer_export_unavailable", "The export could not be prepared. No data was changed. Try again or ask your GrowthOS operator for help.");
type ExportClient = Pick<pg.Client, "connect" | "query" | "end" | "on">;

/** A bounded consistent snapshot; caps fail the whole request, never truncate. */
export function createCustomerLifecycleExporter({
  createClient = () => new pg.Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 2000, query_timeout: 5500 }),
  maxRows = 2000, maxBytes = 10 * 1024 * 1024,
}: { createClient?: () => ExportClient; maxRows?: number; maxBytes?: number } = {}) {
  let occupied = 0;
  return async (organizationId: string, userId: string) => {
    if (occupied >= 2) throw unavailable();
    occupied++;
    let client: ExportClient;
    try { client = createClient(); } catch { occupied--; throw unavailable(); }
    let expired = false, failed = false;
    client.on("error", () => { failed = true; });
    const query = async (text: string, values: unknown[] = []) => {
      if (expired || failed) throw unavailable();
      const result = await client.query<Record<string, unknown>>({ text, values });
      if (expired || failed) throw unavailable();
      return result;
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([(async () => {
        await client.connect();
        await query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
        await query("SET LOCAL statement_timeout = '5000ms'");
        await query("SET LOCAL lock_timeout = '500ms'");
        await query("SET LOCAL idle_in_transaction_session_timeout = '10000ms'");
        const actor = await query("SELECT id FROM public.users WHERE id = $2 AND organization_id = $1 AND is_active = true AND role IN ('owner', 'admin')", [organizationId, userId]);
        if (actor.rows.length !== 1) throw new CustomerLifecycleError(403, "lifecycle_manager_required", "An active company owner or administrator is required.");
        const org = await query("SELECT id, name, slug, created_at FROM public.organizations WHERE id = $1", [organizationId]);
        if (org.rows.length !== 1) throw unavailable();
        const data: Record<string, Record<string, unknown>[]> = {};
        const included = new Map<string, Set<unknown>>();
        const coverage: Array<{ table: string; fields: readonly string[]; count: number; withheldInvalidLinks: number }> = [];
        let bytes = 0;
        for (const definition of CUSTOMER_EXPORT_DATASETS) {
          // All SQL identifiers are the fixed reviewed list above, never input.
          const result = await query(`SELECT ${definition.fields.map((field) => `"${field}"`).join(", ")} FROM public."${definition.table}" WHERE organization_id = $1 ORDER BY id LIMIT $2`, [organizationId, maxRows + 1]);
          if (result.rows.length > maxRows) throw new CustomerLifecycleError(413, "customer_export_limit", "This company exceeds the core export limit. Ask your GrowthOS operator for an expanded export. No partial file was produced.");
          const rows = result.rows.filter((row) => Object.entries(definition.references ?? {}).every(([column, parent]) => row[column] === null || included.get(parent)?.has(row[column])));
          if (definition.table === "estimates") for (const row of rows) row.line_items = lineItems.parse(row.line_items);
          bytes += Buffer.byteLength(JSON.stringify(rows));
          if (bytes > maxBytes) throw new CustomerLifecycleError(413, "customer_export_limit", "This company exceeds the core export size. Ask your GrowthOS operator for an expanded export. No partial file was produced.");
          data[definition.table] = rows;
          included.set(definition.table, new Set(rows.map((row) => row.id)));
          coverage.push({ table: definition.table, fields: definition.fields, count: rows.length, withheldInvalidLinks: result.rows.length - rows.length });
        }
        await query("ROLLBACK");
        const snapshot = { organization: org.rows[0], data, coverage };
        // Revalidate against current state on this same bounded connection, outside
        // the earlier snapshot. Keep the actor stable through the audit commit.
        await query("BEGIN");
        await query("SET LOCAL statement_timeout = '5000ms'");
        await query("SET LOCAL lock_timeout = '500ms'");
        await query("SET LOCAL idle_in_transaction_session_timeout = '10000ms'");
        const currentActor = await query("SELECT id FROM public.users WHERE id = $2 AND organization_id = $1 AND is_active = true AND role IN ('owner', 'admin') FOR SHARE", [organizationId, userId]);
        if (currentActor.rows.length !== 1) throw new CustomerLifecycleError(403, "lifecycle_manager_required", "An active company owner or administrator is required.");
        const exportId = randomUUID();
        const result = {
          format: "growthos-core-customer-export", version: 1, exportId, generatedAt: new Date().toISOString(),
          organization: snapshot.organization,
          manifest: { scope: "core_customer_records", completeAccountExport: false, deletionPerformed: false,
            rowsPerTableLimit: maxRows, byteLimit: maxBytes, tables: snapshot.coverage,
            exclusions: CUSTOMER_EXPORT_EXCLUSIONS, dataSha256: createHash("sha256").update(JSON.stringify(snapshot.data)).digest("hex"),
            followUp: "Ask your GrowthOS operator to review excluded categories, withheld relationships and any expanded export requirements." },
          data: snapshot.data,
        };
        if (Buffer.byteLength(JSON.stringify(result)) > maxBytes) throw new CustomerLifecycleError(413, "customer_export_limit", "The core export exceeds its size limit. Ask your GrowthOS operator for an expanded export.");
        const metadata = { exportId, scope: result.manifest.scope, dataSha256: result.manifest.dataSha256, counts: snapshot.coverage.map(({ table, count, withheldInvalidLinks }) => ({ table, count, withheldInvalidLinks })), deliveryConfirmed: false };
        await query("INSERT INTO public.audit_events (organization_id, actor_user_id, action, entity_type, entity_id, metadata) VALUES ($1, $2, 'customer_lifecycle.export_prepared', 'organization', $1, $3::jsonb)", [organizationId, userId, JSON.stringify(metadata)]);
        await query("COMMIT");
        return result;
      })(), new Promise<never>((_, reject) => { timer = setTimeout(() => { expired = true; reject(unavailable()); }, 20_000); })]);
    } catch (error) {
      if (error instanceof CustomerLifecycleError) throw error;
      throw unavailable();
    } finally {
      clearTimeout(timer); expired = true;
      // Failed cleanup retains the slot until closing succeeds, bounding clients.
      let closeTimer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([client.end().then(() => { occupied--; }), new Promise<void>((resolve) => { closeTimer = setTimeout(resolve, 500); })]); }
      catch { /* Keep slot occupied; never create unlimited replacements. */ }
      finally { clearTimeout(closeTimer); }
    }
  };
}
export const exportCustomerLifecycle = createCustomerLifecycleExporter();
