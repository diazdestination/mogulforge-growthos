import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import { z } from "zod/v4";
import { CustomerLifecycleError } from "./customer-lifecycle";

type Dataset = { table: string; fields: readonly string[]; computedFields?: readonly string[]; references?: Record<string, string> };
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
  { table: "service_obligations", fields: ["id", "contact_id", "property_id", "appointment_id", "task_id", "kind", "equipment_label", "due_at", "notice_days", "status", "source", "external_ref", "notes", "recurrence", "predecessor_obligation_id", "occurrence_index", "coverage_starts_on", "coverage_ends_on", "coverage_evidence", "completion_note", "completed_at", "created_at", "updated_at"], references: { contact_id: "contacts", property_id: "properties", appointment_id: "appointments", task_id: "crm_tasks", predecessor_obligation_id: "service_obligations" } },
  { table: "activities", fields: ["id", "lead_id", "contact_id", "type", "title", "body", "occurred_at", "created_at"], references: { lead_id: "leads", contact_id: "contacts" } },
  { table: "service_watch_cases", fields: ["id", "service_obligation_id", "version", "state", "reasons", "episode", "acknowledged_at", "next_action", "next_action_at", "resolved_at", "last_evaluated_at", "created_at", "updated_at"], references: { service_obligation_id: "service_obligations" } },
  { table: "consent_records", fields: ["id", "contact_id", "channel", "granted", "disclosure_version", "recorded_at"], references: { contact_id: "contacts" } },
  { table: "suppressions", fields: ["id", "channel", "value", "reason", "created_at"] },
  { table: "value_entries", fields: ["id", "lead_id", "source_reference", "kind", "amount_cents", "occurred_at", "created_at"], references: { lead_id: "leads" } },
  { table: "invoices", fields: ["id", "lead_id", "project_id", "estimate_id", "status", "version", "invoice_number", "draft_document", "issued_document", "issued_document_sha256", "issued_at", "balance_basis", "opening_receivable_cents", "opening_as_of", "historical_source", "voided_at", "void_reason", "created_at", "updated_at"], computedFields: ["exported_issued_document_sha256"], references: { lead_id: "leads", project_id: "projects", estimate_id: "estimates" } },
  { table: "invoice_receipt_allocations", fields: ["id", "invoice_id", "value_entry_id", "kind", "amount_cents", "reverses_allocation_id", "reason", "created_at"], references: { invoice_id: "invoices", value_entry_id: "value_entries", reverses_allocation_id: "invoice_receipt_allocations" } },
  { table: "invoice_operations", fields: ["id", "invoice_id", "action", "version", "reason", "created_at"], references: { invoice_id: "invoices" } },
  { table: "financial_migration_items", fields: ["id", "source_system", "source_account", "entity_type", "external_id", "digest", "invoice_id", "value_entry_id", "created_at"], references: { invoice_id: "invoices", value_entry_id: "value_entries" } },
  { table: "revenue_executions", fields: ["id", "kind", "state", "expires_at", "created_at", "completed_at"] },
  { table: "revenue_execution_events", fields: ["id", "execution_id", "state", "created_at"], references: { execution_id: "revenue_executions" } },
  { table: "stored_objects", fields: ["id", "content_type", "size_bytes", "created_at"] },
] as const;
export const CUSTOMER_EXPORT_EXCLUSIONS = [
  "Credentials, passwords, sessions, identity tokens, API keys and provider/billing configuration are excluded.",
  "Mailbox read credentials/cursors, separate lead-monitoring permissions, provider identities, raw reply content, immutable lead/service parent/receipt/review evidence and platform identity-email delivery records are excluded. They remain in inventory/backups and require a separately reviewed communications/security export; this core export is not a complete mailbox or identity archive. Linked office tasks are included without raw email content.",
  "Opaque activity/import/attribution metadata, provider error details, staff identities and device/IP data are excluded.",
  "Invoice numbering configuration and command retry fingerprints are excluded. Invoice receipt allocations reference value_entries; do not count them as additional cash transactions. An allocation reversal is not a cash refund.",
  "Opening receivables are non-cash balances at a documented cutoff, never payments or collected revenue. Historical invoice source fields and fixed migration identities are included; raw migration reviews/normalized payloads and staff approval identities are excluded.",
  "Invoice issued_document_sha256 verifies the original stored snapshot before export. exported_issued_document_sha256 verifies JSON.stringify of the exported allowlisted document; the two can differ because private fields and key order are normalized.",
  "Media lists include tenant-owned Postgres metadata only; binary photos, unknown/external object ownership and provider copies are excluded.",
  "Website/form submissions, full conversations/mailboxes, knowledge, analytics, automation definitions/queues and other account tables are outside this core export.",
  "Missed-call recovery policies/cases, service-care approval snapshots, and invoice delivery attempts, approval/dispatch audit details and permanent replay-prevention evidence are outside this core export. They remain in the database inventory and backups and require a separately reviewed communications export; provider identities and staff approvals are not copied into customer records.",
  "Source-adoption approvals/revocations, exact outreach batches/items and permanent send reservations remain in inventory/backups; they require a separately reviewed communications export. Service-watch case status and office plans are included, but staff identity and approval history are excluded. Neither an office plan nor a push receipt proves customer contact.",
  "Backups, complete account erasure, retention decisions, billing cancellation and remote credential revocation require a separate operator review.",
] as const;
const lineItems = z.array(z.object({ description: z.string(), quantity: z.number(), unitPriceCents: z.number(), totalCents: z.number() })).max(1000);
// Parse stored JSON through a closed field list. Staff approval IDs and future
// private metadata must not bypass the export's documented exclusion policy.
const invoiceDocument = z.object({
  title: z.string(), currency: z.literal("USD"), issuerName: z.string(), issuerAddress: z.string().nullable(),
  customerName: z.string(), customerAddress: z.string().nullable(), dueDate: z.iso.date().nullable(), notes: z.string().nullable(),
  lineItems: z.array(z.object({ description: z.string(), quantity: z.string(), unitPriceCents: z.number().int(), totalCents: z.number().int() })).max(100),
  subtotalCents: z.number().int(), taxCents: z.number().int(), totalCents: z.number().int(),
});
const recurrence = z.object({ mode: z.literal("calendar_months"), intervalMonths: z.number().int().min(1).max(60), anchorDate: z.iso.date(), endDate: z.iso.date().nullable(), agreementNote: z.string(), approvedAt: z.string() });
const historicalSource = z.object({ sourceSystem: z.string(), sourceAccount: z.string(), externalId: z.string(), cutoffAt: z.string(), recordSha256: z.string().regex(/^[a-f0-9]{64}$/) });
const watchReasons = z.array(z.enum(["reminder_needs_review", "no_response_recorded", "reminder_blocked", "send_unknown", "visit_cancelled", "visit_no_show", "service_overdue", "response_needs_action", "next_action_overdue", "owner_required", "source_review_required", "reply_received_review"])).max(12);
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
          const links = Object.entries(definition.references ?? {});
          let rows = result.rows.filter((row) => links.every(([column, parent]) => parent === definition.table || row[column] === null || included.get(parent)?.has(row[column])));
          // Same-table chains can arrive in any UUID sort order. Repeatedly
          // remove links to excluded ancestors rather than losing valid
          // reversals/recurrences or retaining a foreign parent's identifier.
          const selfLinks = links.filter(([, parent]) => parent === definition.table);
          if (selfLinks.length) {
            let changed: boolean;
            do {
              const ownIds = new Set(rows.map(row => row.id));
              const valid = rows.filter(row => selfLinks.every(([column]) => row[column] === null || ownIds.has(row[column])));
              changed = valid.length !== rows.length; rows = valid;
            } while (changed);
          }
          if (definition.table === "estimates") for (const row of rows) row.line_items = lineItems.parse(row.line_items);
          if (definition.table === "invoices") for (const row of rows) {
            row.historical_source = row.historical_source === null ? null : historicalSource.parse(row.historical_source);
            if (row.issued_document !== null) {
              const storedHash = createHash("sha256").update(JSON.stringify(row.issued_document)).digest("hex");
              if (row.issued_document_sha256 !== storedHash) throw unavailable();
            } else if (row.issued_document_sha256 !== null || row.issued_at !== null) throw unavailable();
            row.draft_document = invoiceDocument.parse(row.draft_document);
            row.issued_document = row.issued_document === null ? null : invoiceDocument.parse(row.issued_document);
            row.exported_issued_document_sha256 = row.issued_document === null ? null : createHash("sha256").update(JSON.stringify(row.issued_document)).digest("hex");
          }
          if (definition.table === "service_obligations") for (const row of rows) row.recurrence = row.recurrence === null ? null : recurrence.parse(row.recurrence);
          if (definition.table === "service_watch_cases") for (const row of rows) row.reasons = watchReasons.parse(row.reasons);
          bytes += Buffer.byteLength(JSON.stringify(rows));
          if (bytes > maxBytes) throw new CustomerLifecycleError(413, "customer_export_limit", "This company exceeds the core export size. Ask your GrowthOS operator for an expanded export. No partial file was produced.");
          data[definition.table] = rows;
          included.set(definition.table, new Set(rows.map((row) => row.id)));
          coverage.push({ table: definition.table, fields: [...definition.fields, ...(definition.computedFields ?? [])], count: rows.length, withheldInvalidLinks: result.rows.length - rows.length });
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
