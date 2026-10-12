import {
  activitiesTable,
  appointmentsTable,
  auditEventsTable,
  contactsTable,
  db,
  importedOpportunityHistorySchema,
  leadImportsTable,
  leadsTable,
  playbookEnrollmentsTable,
  playbooksTable,
  reactivationCampaignLeadsTable,
  reactivationCampaignsTable,
  suppressionsTable,
  type LeadImport,
  type ImportedOpportunityHistory,
  type Playbook,
  type ReactivationCampaign,
  type ReactivationSegment,
  type SendingHoursSettings,
} from "@workspace/db";
import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, inArray, notInArray, or, sql } from "drizzle-orm";
import { z } from "zod/v4";

import { recordAudit } from "./audit";
import { OUTREACH_ACTIVE_STATUSES, enrollLead, stopEnrollmentById } from "./playbooks";
import { draftOutreachMessage } from "./providers";
import { normalizeAddress } from "./send-gate";
import { getOrgSettings, getSendingHours } from "./settings";
import { needsSourceVerification, parseSourceAmount, parseSourceDate, SourceHistoryValidationError } from "./source-history";

/**
 * Cold-lead reactivation: CSV lead import, segment building over stale
 * leads, and throttled win-back campaigns that drain a segment snapshot
 * into a playbook at an org-configured rate. Every send still passes the
 * unified pre-send gate inside the playbook engine.
 */

// ---------------------------------------------------------------------------
// CSV parsing (RFC 4180-ish, dependency-free)
// ---------------------------------------------------------------------------

export class CsvParseError extends Error {
  constructor() { super("The CSV contains invalid quoting. No rows were imported."); }
}

export function parseCsv(text: string): string[][] {
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let afterQuote = false;
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (inQuotes) {
      if (c === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
          afterQuote = true;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      if (field !== "" || afterQuote) throw new CsvParseError();
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
      afterQuote = false;
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && source[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      afterQuote = false;
      if (row.some((f) => f.trim() !== "")) rows.push(row);
      row = [];
    } else {
      if (afterQuote) throw new CsvParseError();
      field += c;
    }
  }
  if (inQuotes) throw new CsvParseError();
  row.push(field);
  if (row.some((f) => f.trim() !== "")) rows.push(row);
  return rows;
}

// ---------------------------------------------------------------------------
// Lead import
// ---------------------------------------------------------------------------

/** Fields a CSV column can map to. */
export const IMPORT_FIELDS = [
  "firstName",
  "lastName",
  "email",
  "phone",
  "status",
  "source",
  "serviceType",
  "notes",
  "externalOpportunityId",
  "externalCustomerId",
  "externalEstimateId",
  "originalCreatedAt",
  "sourceUpdatedAt",
  "statusChangedAt",
  "lastContactAt",
  "estimatedValue",
  "currency",
] as const;
export type ImportField = (typeof IMPORT_FIELDS)[number];

const VALID_STATUSES = new Set([
  "new",
  "contact_attempted",
  "inspection_scheduled",
  "inspection_completed",
  "estimate_preparing",
  "estimate_sent",
  "claim_pending",
  "follow_up",
  "won",
  "completed",
  "nurture",
  "lost",
]);

const MAX_IMPORT_ROWS = 10_000;
const MAX_ERROR_SAMPLES = 20;
const MAX_PREVIEW_ERROR_SAMPLES = 200;

const PREVIEW_BUDGET_MS = 45_000;
class DryRunRollback extends Error {}
class PreviewTooSlow extends Error {}
/** What an import would do. Nothing is saved and no import record is created. */
export interface LeadImportPreview {
  dryRun: true;
  fileName: string | null;
  totalRows: number;
  imported: number;
  updated: number;
  duplicates: number;
  conflicts: number;
  skipped: number;
  suppressed: number;
  errors: string[];
  errorsTruncated: boolean;
  sourceKey: string | null;
  snapshotAsOf: string | null;
}

function clean(v: string | undefined, max = 200): string | null {
  const s = (v ?? "").trim();
  return s ? s.slice(0, max) : null;
}

type ImportLeadsResult<P> = P extends { dryRun: true }
  ? LeadImportPreview | { error: string }
  : P extends { dryRun: boolean }
    ? LeadImport | LeadImportPreview | { error: string }
    : LeadImport | { error: string };
export function importLeads<P extends ImportLeadsParams>(organizationId: string, params: P): Promise<ImportLeadsResult<P>>;
export async function importLeads(
  organizationId: string,
  params: ImportLeadsParams,
): Promise<LeadImport | LeadImportPreview | { error: string }> {
  return runLeadImport(organizationId, params);
}
interface ImportLeadsParams {
    csv: string;
    /** Map of import field → 0-based CSV column index. */
    mapping: Partial<Record<ImportField, number>>;
    fileName?: string;
    hasHeader?: boolean;
    defaultStatus?: string;
    defaultSource?: string;
    /** Stable source/account namespace; use the same value on every reimport. */
    sourceKey?: string;
    /** When the source export was captured, not when this upload occurred. */
    snapshotAsOf?: string;
    createdByUserId?: string | null;
    /** Run every row check and match in one transaction, then roll it back. */
    dryRun?: boolean;
    /**
     * "customers" brings in existing customers (e.g. a Housecall Pro customer
     * list) as contacts only: no lead, so no pipeline stage, lead count or
     * nurture. Each created contact gets a provenance audit event.
     */
    mode?: "leads" | "customers";
}
const CUSTOMER_IMPORT_FIELDS = new Set<ImportField>(["firstName", "lastName", "email", "phone", "externalCustomerId"]);
/** Per-contact provenance for customer-mode imports (contacts have no source columns). */
export const CUSTOMER_IMPORTED_ACTION = "customer.imported";
async function runLeadImport(
  organizationId: string,
  params: ImportLeadsParams,
): Promise<LeadImport | LeadImportPreview | { error: string }> {
  let all: string[][];
  try { all = parseCsv(params.csv); }
  catch (error) {
    if (error instanceof CsvParseError) return { error: error.message };
    throw error;
  }
  const rows = params.hasHeader === false ? all : all.slice(1);
  if (rows.length === 0) return { error: "No data rows found in the file" };
  if (rows.length > MAX_IMPORT_ROWS) {
    return { error: `Too many rows (max ${MAX_IMPORT_ROWS})` };
  }
  const m = params.mapping;
  if (!m || typeof m !== "object" || Array.isArray(m) || Object.entries(m).some(([key, value]) =>
    !IMPORT_FIELDS.includes(key as ImportField) || !Number.isInteger(value) || value < 0 || value > 255,
  )) return { error: "Mappings must use supported field names and column numbers from 0 to 255" };
  if (new Set(Object.values(m)).size !== Object.values(m).length) {
    return { error: "Each CSV column can only map to one field" };
  }
  if (params.hasHeader !== false && Object.values(m).some((index) => index >= all[0].length)) {
    return { error: "A mapped column is missing from the CSV header" };
  }
  if (m.firstName === undefined) return { error: "A First name column mapping is required" };
  if (m.email === undefined && m.phone === undefined) {
    return { error: "Map at least an Email or Phone column" };
  }
  const defaultStatus = VALID_STATUSES.has(params.defaultStatus ?? "")
    ? (params.defaultStatus as string)
    : "nurture";
  const source = clean(params.defaultSource, 100) ?? "csv-import";
  const sourceKey = params.sourceKey?.trim() || null;
  if (sourceKey && !/^[a-z0-9][a-z0-9._-]{0,99}$/.test(sourceKey)) {
    return { error: "Source key must use 1–100 lowercase letters, numbers, dots, underscores or hyphens" };
  }
  if (m.externalOpportunityId !== undefined && !sourceKey) {
    return { error: "A stable source key is required when mapping external opportunity IDs" };
  }
  const customers = params.mode === "customers";
  if (customers && Object.keys(m).some((key) => !CUSTOMER_IMPORT_FIELDS.has(key as ImportField))) {
    return { error: "A customer import only uses name, email, phone and customer ID columns" };
  }
  if (customers && m.externalCustomerId !== undefined && !sourceKey) {
    return { error: "A stable source key is required when mapping customer IDs" };
  }
  // Links every contact a customer import creates, for review or later correction.
  const batchId = randomUUID();
  const receivedAt = new Date();
  let snapshotAsOf: string | null;
  try { snapshotAsOf = parseSourceDate(params.snapshotAsOf, "Snapshot date", receivedAt); }
  catch (err) { return { error: err instanceof Error ? err.message : "Invalid snapshot date" }; }

  let imported = 0;
  let updated = 0;
  let duplicates = 0;
  let conflicts = 0;
  let skipped = 0;
  let suppressedCount = 0;
  const errors: string[] = [];
  // A preview is for reviewing every problem row before anything is saved.
  const maxErrors = params.dryRun ? MAX_PREVIEW_ERROR_SAMPLES : MAX_ERROR_SAMPLES;
  type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
  let runRow = <T>(work: (tx: Tx) => Promise<T>): Promise<T> => db.transaction(work);

  // Suppression list snapshot for flagging (send gate re-checks at send time).
  const suppressions = await db
    .select({ channel: suppressionsTable.channel, value: suppressionsTable.value })
    .from(suppressionsTable)
    .where(eq(suppressionsTable.organizationId, organizationId));
  const suppressedSet = new Set(suppressions.map((s) => `${s.channel}:${s.value}`));

  const processRows = async () => {
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowNo = i + (params.hasHeader === false ? 1 : 2);
    if (Object.values(m).some((index) => index >= row.length) ||
        (params.hasHeader !== false && row.length !== all[0].length)) {
      skipped++;
      if (errors.length < maxErrors) errors.push(`Row ${rowNo}: column count does not match the header or mapping; no values were applied`);
      continue;
    }
    const get = (f: ImportField) => (m[f] === undefined ? undefined : row[m[f]!]);
    const firstName = clean(get("firstName"), 100);
    const rawEmail = get("email") ?? "";
    const rawPhone = get("phone") ?? "";
    const email = rawEmail.trim().toLowerCase() || null;
    const phone = rawPhone.trim() || null;
    const phoneDigits = phone ? phone.replace(/\D/g, "") : null;
    // Validate every supplied mapped address before trimming/truncation can hide
    // a malformed value. Keep the source phone format and existing normalization.
    const controls = /[\x00-\x1f\x7f-\x9f]/;
    const emailInvalid = controls.test(rawEmail) || rawEmail.length > 200 || (email !== null && !z.email().safeParse(email).success);
    // Use the bounded formatting/extension policy from customer corrections,
    // also retaining international slash separators, the seven-digit minimum
    // and this import's existing 40-character bound.
    const phoneInvalid = controls.test(rawPhone) || rawPhone.length > 40 || (phone !== null &&
      (!/^(?:\+?[0-9(][0-9 ()./-]*[0-9])(?:\s*(?:x|ext\.?)\s*\d{1,8})?$/i.test(phone) ||
       !phoneDigits || phoneDigits.length < 7 || phoneDigits.length > 23));
    if (emailInvalid || phoneInvalid) {
      skipped++;
      if (errors.length < maxErrors) errors.push(`Row ${rowNo}: ${emailInvalid ? "email must be a valid address of at most 200 characters" : "phone must be a valid number of at most 40 characters"}; no values were applied`);
      continue;
    }

    if (!firstName) {
      skipped++;
      if (errors.length < maxErrors) errors.push(`Row ${rowNo}: missing first name`);
      continue;
    }
    if (!email && (!phoneDigits || phoneDigits.length < 7)) {
      skipped++;
      if (errors.length < maxErrors) {
        errors.push(`Row ${rowNo}: needs a valid email or phone`);
      }
      continue;
    }

    const isSuppressed =
      (email && suppressedSet.has(`email:${normalizeAddress("email", email)}`)) ||
      (phone && suppressedSet.has(`sms:${normalizeAddress("sms", phone)}`));

    try {
      const identity = (field: ImportField): string | null => {
        const value = get(field)?.trim() || null;
        if (value && (value.length > 200 || /[\x00-\x1f\x7f]/.test(value))) {
          throw new SourceHistoryValidationError(`${field} must be a valid ID of at most 200 characters`);
        }
        return value;
      };
      const externalOpportunityId = identity("externalOpportunityId");
      if (m.externalOpportunityId !== undefined && !externalOpportunityId) {
        throw new SourceHistoryValidationError("missing external opportunity ID; row was not converted into a contact-only import");
      }
      const rawStatus = clean(get("status"), 40);
      if (m.status !== undefined && !rawStatus) throw new SourceHistoryValidationError("mapped status is blank; an unknown source stage was not replaced with the default");
      if (rawStatus && !VALID_STATUSES.has(rawStatus)) throw new SourceHistoryValidationError("unknown status; map it to a supported GrowthOS stage first");
      const status = rawStatus ?? defaultStatus;
      const estimatedValueCents = parseSourceAmount(get("estimatedValue"));
      const rawCurrency = clean(get("currency"), 10)?.toUpperCase() ?? null;
      if (rawCurrency && rawCurrency !== "USD") throw new SourceHistoryValidationError("only USD amounts are supported; no currency conversion was performed");
      if (estimatedValueCents !== null && rawCurrency !== "USD") throw new SourceHistoryValidationError("an explicit USD currency column is required with an estimate amount");
      const originalCreatedAt = parseSourceDate(get("originalCreatedAt"), "Original opportunity date", receivedAt);
      const sourceUpdatedAt = parseSourceDate(get("sourceUpdatedAt"), "Source updated date", receivedAt);
      const statusChangedAt = parseSourceDate(get("statusChangedAt"), "Status changed date", receivedAt);
      const lastContactAt = parseSourceDate(get("lastContactAt"), "Last contact date", receivedAt);
      const latestBound = sourceUpdatedAt ?? snapshotAsOf;
      if (sourceUpdatedAt && snapshotAsOf && sourceUpdatedAt > snapshotAsOf) throw new SourceHistoryValidationError("Source updated date is after the snapshot date");
      if (latestBound && [originalCreatedAt, statusChangedAt, lastContactAt].some((date) => date && date > latestBound)) {
        throw new SourceHistoryValidationError("A history date is after the source update or snapshot date");
      }
      if (originalCreatedAt && statusChangedAt && statusChangedAt < originalCreatedAt) throw new SourceHistoryValidationError("Status changed date is before the original opportunity date");
      const applied = {
        status,
        estimatedValueCents,
        serviceType: clean(get("serviceType"), 100),
        summary: clean(get("notes"), 500),
        latestSource: clean(get("source"), 100) ?? source,
      };
      const provenance = {
        originalCreatedAt, sourceUpdatedAt, statusChangedAt, lastContactAt,
        externalCustomerId: identity("externalCustomerId"),
        externalEstimateId: identity("externalEstimateId"),
        currency: rawCurrency as "USD" | null,
      };
      const fingerprint = createHash("sha256").update(JSON.stringify({
        ...provenance, applied, source: clean(get("source"), 100) ?? source,
        // Compare contact identity without retaining raw uploaded contact values in history.
        email, phone: phoneDigits,
      })).digest("hex");
      const appliedFingerprint = createHash("sha256").update(JSON.stringify(applied)).digest("hex");
      const history: ImportedOpportunityHistory = {
        version: 1, kind: "csv_snapshot", ...provenance, appliedFingerprint, fingerprint, snapshotAsOf,
        mappedFields: Object.keys(m).sort(),
        firstImportedAt: receivedAt.toISOString(), lastImportedAt: receivedAt.toISOString(),
      };
      importedOpportunityHistorySchema.parse(history);
      const outcome = await runRow(async (tx) => {
        // Import requests for one tenant serialize contact matching and opportunity creation.
        // The unique index remains the final protection against duplicate source IDs.
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`lead-import:${organizationId}`}))`);
        const matchConds = [];
        if (email) matchConds.push(sql`lower(${contactsTable.email}) = ${email}`);
        if (phoneDigits && phoneDigits.length >= 7) {
          matchConds.push(sql`regexp_replace(coalesce(${contactsTable.phone}, ''), '\\D', '', 'g') = ${phoneDigits}`);
        }
        const contacts = await tx.select().from(contactsTable)
          .where(and(eq(contactsTable.organizationId, organizationId), or(...matchConds))).limit(2);
        if (contacts.length > 1) return { kind: "conflict", reason: "contact details match different people; reconcile before import" } as const;
        const contact = contacts[0];
        if (contact && ((email && contact.email && normalizeAddress("email", contact.email) !== email) ||
            (phone && contact.phone && normalizeAddress("sms", contact.phone) !== normalizeAddress("sms", phone)))) {
          return { kind: "conflict", reason: "a matched person has conflicting contact details; reconcile before linking this opportunity" } as const;
        }
        // A source customer ID is remembered on imported leads and, for customer
        // imports, in customer.imported provenance. Both modes honor both.
        const externalCustomerId = history.externalCustomerId;
        let known: { contactId: string | null }[] = [];
        if (sourceKey && externalCustomerId) {
          known = await tx.selectDistinct({ contactId: auditEventsTable.entityId }).from(auditEventsTable).where(and(
            eq(auditEventsTable.organizationId, organizationId), eq(auditEventsTable.action, CUSTOMER_IMPORTED_ACTION),
            sql`${auditEventsTable.metadata}->>'sourceKey' = ${sourceKey}`,
            sql`${auditEventsTable.metadata}->>'externalCustomerId' = ${externalCustomerId}`,
          )).limit(2);
          if (known.length && (!contact || known.some((k) => k.contactId !== contact.id))) {
            return { kind: "conflict", reason: "this source customer ID was imported before as different contact details; reconcile before import" } as const;
          }
          if (contact) {
            const [linkedElsewhere] = await tx.select({ id: auditEventsTable.id }).from(auditEventsTable).where(and(
              eq(auditEventsTable.organizationId, organizationId), eq(auditEventsTable.action, CUSTOMER_IMPORTED_ACTION),
              eq(auditEventsTable.entityId, contact.id), sql`${auditEventsTable.metadata}->>'sourceKey' = ${sourceKey}`,
              sql`${auditEventsTable.metadata}->>'externalCustomerId' IS NOT NULL`,
              sql`${auditEventsTable.metadata}->>'externalCustomerId' <> ${externalCustomerId}`,
            )).limit(1);
            if (linkedElsewhere) return { kind: "conflict", reason: "these contact details belong to a different source customer ID; reconcile before import" } as const;
          }
        }
        if (customers) {
          if (sourceKey && externalCustomerId) {
            // Imported-lead history for the same source account is also binding.
            const leadLinks = await tx.selectDistinct({ contactId: leadsTable.contactId, id: sql<string>`${leadsTable.importedHistory}->>'externalCustomerId'` }).from(leadsTable).where(and(
              eq(leadsTable.organizationId, organizationId), eq(leadsTable.importSourceKey, sourceKey),
              sql`${leadsTable.importedHistory}->>'externalCustomerId' IS NOT NULL`,
              contact
                ? or(eq(leadsTable.contactId, contact.id), sql`${leadsTable.importedHistory}->>'externalCustomerId' = ${externalCustomerId}`)
                : sql`${leadsTable.importedHistory}->>'externalCustomerId' = ${externalCustomerId}`,
            )).limit(5);
            if (leadLinks.some((link) => link.contactId !== contact?.id || link.id !== externalCustomerId)) {
              return { kind: "conflict", reason: "imported lead history links this customer ID or person differently; reconcile before import" } as const;
            }
          }
          const provenance = (contactId: string, matchedExisting: boolean) => tx.insert(auditEventsTable).values({
            organizationId, actorUserId: params.createdByUserId ?? null, action: CUSTOMER_IMPORTED_ACTION,
            entityType: "contact", entityId: contactId,
            metadata: { batchId, sourceKey, externalCustomerId, snapshotAsOf, fileName: clean(params.fileName, 200), matchedExisting },
          });
          if (contact) {
            // Remember which existing person this source ID is, so a later
            // re-import with changed details is flagged rather than duplicated.
            if (sourceKey && externalCustomerId && !known.length) await provenance(contact.id, true);
            return { kind: "duplicate" } as const;
          }
          const [created] = await tx.insert(contactsTable).values({
            organizationId, firstName, lastName: clean(get("lastName"), 100), email, phone,
          }).returning({ id: contactsTable.id });
          await provenance(created.id, false);
          return { kind: "imported" } as const;
        }
        if (sourceKey && history.externalCustomerId) {
          const knownCustomers = await tx.selectDistinct({ contactId: leadsTable.contactId }).from(leadsTable).where(and(
            eq(leadsTable.organizationId, organizationId), eq(leadsTable.importSourceKey, sourceKey),
            sql`${leadsTable.importedHistory}->>'externalCustomerId' = ${history.externalCustomerId}`,
          )).limit(2);
          if (knownCustomers.length && (!contact || knownCustomers.some((known) => known.contactId !== contact.id))) {
            return { kind: "conflict", reason: "known source customer identity resolves to different or unrecognized contact details" } as const;
          }
        }
        if (contact && sourceKey && history.externalCustomerId) {
          const [contradictoryCustomer] = await tx.select({ id: leadsTable.id }).from(leadsTable).where(and(
            eq(leadsTable.organizationId, organizationId), eq(leadsTable.contactId, contact.id),
            eq(leadsTable.importSourceKey, sourceKey),
            sql`${leadsTable.importedHistory}->>'externalCustomerId' IS NOT NULL`,
            sql`${leadsTable.importedHistory}->>'externalCustomerId' <> ${history.externalCustomerId}`,
          )).limit(1);
          if (contradictoryCustomer) return { kind: "conflict", reason: "source customer ID conflicts with this person's imported history" } as const;
        }
        const [existing] = externalOpportunityId && sourceKey
          ? await tx.select().from(leadsTable).where(and(
              eq(leadsTable.organizationId, organizationId), eq(leadsTable.importSourceKey, sourceKey),
              eq(leadsTable.externalOpportunityId, externalOpportunityId),
            )).for("update")
          : [];
        if (existing) {
          const previous = existing.importedHistory;
          if (!contact || existing.contactId !== contact.id || !previous ||
              (previous.externalCustomerId && previous.externalCustomerId !== history.externalCustomerId)) {
            return { kind: "conflict", reason: "source opportunity has a different or unresolved customer identity" } as const;
          }
          if (previous.fingerprint === fingerprint) return { kind: "duplicate" } as const;
          if (JSON.stringify(previous.mappedFields) !== JSON.stringify(history.mappedFields)) {
            return { kind: "conflict", reason: "mapped fields changed; reconcile before applying a partial source update" } as const;
          }
          if (!sourceUpdatedAt || !previous.sourceUpdatedAt || sourceUpdatedAt <= previous.sourceUpdatedAt) {
            return { kind: "conflict", reason: "changed opportunity needs a strictly newer source updated date; stale or conflicting snapshot was not applied" } as const;
          }
          if (previous.originalCreatedAt && originalCreatedAt !== previous.originalCreatedAt) {
            return { kind: "conflict", reason: "original opportunity date changed; reconcile source identity" } as const;
          }
          if (previous.lastContactAt && (!lastContactAt || lastContactAt < previous.lastContactAt)) {
            return { kind: "conflict", reason: "last contact history would move backward or disappear" } as const;
          }
          if (previous.statusChangedAt && (!statusChangedAt || statusChangedAt < previous.statusChangedAt)) {
            return { kind: "conflict", reason: "status history would move backward or disappear" } as const;
          }
          const currentFingerprint = createHash("sha256").update(JSON.stringify({
            status: existing.status, estimatedValueCents: existing.estimatedValueCents,
            serviceType: existing.serviceType, summary: existing.summary,
            latestSource: existing.latestSource,
          })).digest("hex");
          if (previous.appliedFingerprint !== currentFingerprint) {
            return { kind: "conflict", reason: "GrowthOS values changed after import; reconcile before replacing local work" } as const;
          }
          await tx.update(leadsTable).set({
            ...applied, status: status as typeof leadsTable.$inferSelect.status,
            importedHistory: { ...history, firstImportedAt: previous.firstImportedAt },
          }).where(and(eq(leadsTable.id, existing.id), eq(leadsTable.organizationId, organizationId)));
          return { kind: "updated" } as const;
        }
        // A person is not an opportunity. With an external ID a new job may reuse this contact.
        // Without one, retain conservative legacy matching and make no guessed merge.
        if (!externalOpportunityId && contact) return { kind: "duplicate" } as const;
        const contactId = contact?.id ?? (await tx.insert(contactsTable).values({
          organizationId, firstName, lastName: clean(get("lastName"), 100), email, phone,
        }).returning({ id: contactsTable.id }))[0].id;
        await tx.insert(leadsTable).values({
          organizationId,
          contactId,
          ...applied,
          status: status as typeof leadsTable.$inferSelect.status,
          source: clean(get("source"), 100) ?? source,
          latestSource: clean(get("source"), 100) ?? source,
          creationMethod: "import",
          importSourceKey: sourceKey,
          externalOpportunityId,
          importedHistory: history,
        });
        return { kind: "imported" } as const;
      });
      if (outcome.kind === "conflict") {
        conflicts++;
        if (errors.length < maxErrors) errors.push(`Row ${rowNo}: ${outcome.reason}`);
      } else if (outcome.kind === "duplicate") duplicates++;
      else {
        if (outcome.kind === "updated") updated++;
        else imported++;
        if (isSuppressed) suppressedCount++;
      }
    } catch (err) {
      // A preview must not report an unexpected database failure (such as a
      // lock or time limit) as an ordinary skipped row.
      if (params.dryRun && !(err instanceof SourceHistoryValidationError)) throw err;
      skipped++;
      // Only our validation errors are safe to show; never leak SQL or uploaded values.
      const message = err instanceof SourceHistoryValidationError ? err.message : "failed to save";
      if (errors.length < maxErrors) errors.push(`Row ${rowNo}: ${message}`);
    }
  }
  };

  if (params.dryRun) {
    // Rows run as savepoints of one outer transaction, so later rows see earlier
    // rows of the same file exactly as a real import would; then all of it is undone.
    // The transaction holds this tenant's import lock, so it is bounded.
    const deadline = Date.now() + PREVIEW_BUDGET_MS;
    let tooSlow = false;
    await db
      .transaction(async (outer) => {
        await outer.execute(sql`select set_config('lock_timeout','3000ms',true), set_config('statement_timeout','10000ms',true), set_config('idle_in_transaction_session_timeout','15000ms',true)`);
        runRow = (work) => {
          if (Date.now() > deadline) throw new PreviewTooSlow();
          return outer.transaction(work);
        };
        await processRows();
        throw new DryRunRollback();
      })
      .catch((err) => {
        if (err instanceof DryRunRollback) return;
        const code = (err as { code?: unknown; cause?: { code?: unknown } }).code ?? (err as { cause?: { code?: unknown } }).cause?.code;
        // 55P03 lock_not_available, 57014 query_canceled (statement timeout).
        if (err instanceof PreviewTooSlow || code === "55P03" || code === "57014") { tooSlow = true; return; }
        throw err;
      });
    if (tooSlow) {
      return { error: "The preview could not finish in time (the file is large or another import is running). Nothing was saved. Try again, or split the file and preview each part." };
    }
    return {
      dryRun: true, fileName: clean(params.fileName, 200), totalRows: rows.length,
      imported, updated, duplicates, conflicts, skipped, suppressed: suppressedCount,
      errors, errorsTruncated: errors.length >= maxErrors, sourceKey, snapshotAsOf,
    };
  }
  await processRows();

  const [record] = await db
    .insert(leadImportsTable)
    .values({
      organizationId,
      fileName: clean(params.fileName, 200),
      totalRows: rows.length,
      imported,
      updated,
      duplicates,
      conflicts,
      sourceKey,
      snapshotAsOf: snapshotAsOf ? new Date(snapshotAsOf) : null,
      skipped,
      suppressed: suppressedCount,
      errors,
      createdByUserId: params.createdByUserId ?? null,
    })
    .returning();
  await recordAudit({
    organizationId,
    actorUserId: params.createdByUserId ?? null,
    action: customers ? "customers.imported" : "leads.imported",
    entityType: "lead_import",
    entityId: record.id,
    metadata: { imported, updated, duplicates, conflicts, skipped, sourceKey, snapshotAsOf, ...(customers ? { mode: "customers", batchId } : {}) },
  });
  return record;
}

export async function listImports(organizationId: string): Promise<LeadImport[]> {
  return db
    .select()
    .from(leadImportsTable)
    .where(eq(leadImportsTable.organizationId, organizationId))
    .orderBy(desc(leadImportsTable.createdAt))
    .limit(50);
}

// ---------------------------------------------------------------------------
// Segments
// ---------------------------------------------------------------------------

function sanitizeSegment(input: unknown): ReactivationSegment {
  const raw = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const seg: ReactivationSegment = {};
  if (Array.isArray(raw.statuses)) {
    seg.statuses = raw.statuses
      .filter((s): s is string => typeof s === "string" && VALID_STATUSES.has(s))
      .slice(0, 20);
  }
  if (typeof raw.minAgeDays === "number" && raw.minAgeDays > 0) {
    seg.minAgeDays = Math.min(Math.floor(raw.minAgeDays), 3650);
  }
  if (typeof raw.inactiveDays === "number" && raw.inactiveDays > 0) {
    seg.inactiveDays = Math.min(Math.floor(raw.inactiveDays), 3650);
  }
  if (Array.isArray(raw.sources)) {
    seg.sources = raw.sources
      .filter((s): s is string => typeof s === "string" && s.length <= 100)
      .slice(0, 20);
  }
  return seg;
}

function segmentConditions(organizationId: string, seg: ReactivationSegment) {
  const conds = [eq(leadsTable.organizationId, organizationId)];
  if (seg.statuses && seg.statuses.length > 0) {
    conds.push(
      inArray(leadsTable.status, seg.statuses as (typeof leadsTable.$inferSelect.status)[]),
    );
  }
  if (seg.minAgeDays) {
    const cutoff = new Date(Date.now() - seg.minAgeDays * 86_400_000);
    conds.push(sql`CASE
      WHEN ${leadsTable.importedHistory} IS NOT NULL
        THEN (${leadsTable.importedHistory}->>'originalCreatedAt')::timestamptz
      WHEN ${leadsTable.creationMethod} = 'import' THEN NULL
      ELSE ${leadsTable.createdAt}
    END < ${cutoff}`);
  }
  if (seg.inactiveDays) {
    const cutoff = new Date(Date.now() - seg.inactiveDays * 86_400_000);
    conds.push(
      // Missing imported history is not evidence that the customer has gone quiet.
      sql`CASE
        WHEN ${leadsTable.importedHistory} IS NOT NULL
          THEN coalesce(${leadsTable.importedHistory}->>'lastContactAt', ${leadsTable.importedHistory}->>'originalCreatedAt')::timestamptz
        WHEN ${leadsTable.creationMethod} = 'import' THEN NULL
        ELSE ${leadsTable.createdAt}
      END < ${cutoff}`,
      sql`NOT EXISTS (
        SELECT 1 FROM ${activitiesTable}
        WHERE ${activitiesTable.leadId} = ${leadsTable.id}
          AND ${activitiesTable.organizationId} = ${leadsTable.organizationId}
          AND ${activitiesTable.occurredAt} > ${cutoff}
      )`,
    );
  }
  if (seg.sources && seg.sources.length > 0) {
    conds.push(inArray(leadsTable.source, seg.sources));
  }
  // Leads already in a live sequence are excluded up front.
  conds.push(
    sql`NOT EXISTS (
      SELECT 1 FROM ${playbookEnrollmentsTable}
      WHERE ${playbookEnrollmentsTable.leadId} = ${leadsTable.id}
        AND ${playbookEnrollmentsTable.status} IN ('active','paused')
    )`,
  );
  return conds;
}

export interface SegmentPreview {
  segment: ReactivationSegment;
  count: number;
  sample: {
    id: string;
    contactName: string | null;
    status: string;
    source: string | null;
    createdAt: string;
    originalCreatedAt: string | null;
    sourceSnapshotAsOf: string | null;
    requiresSourceVerification: boolean;
  }[];
}

export async function previewSegment(
  organizationId: string,
  segmentInput: unknown,
): Promise<SegmentPreview> {
  const segment = sanitizeSegment(segmentInput);
  const conds = segmentConditions(organizationId, segment);
  const [{ value: count }] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(leadsTable)
    .where(and(...conds));
  const sample = await db
    .select({
      id: leadsTable.id,
      firstName: contactsTable.firstName,
      lastName: contactsTable.lastName,
      status: leadsTable.status,
      source: leadsTable.source,
      createdAt: leadsTable.createdAt,
      creationMethod: leadsTable.creationMethod,
      importedHistory: leadsTable.importedHistory,
    })
    .from(leadsTable)
    .leftJoin(contactsTable, eq(leadsTable.contactId, contactsTable.id))
    .where(and(...conds))
    .orderBy(desc(leadsTable.createdAt))
    .limit(5);
  return {
    segment,
    count: Number(count),
    sample: sample.map((s) => ({
      id: s.id,
      contactName: [s.firstName, s.lastName].filter(Boolean).join(" ") || null,
      status: s.status,
      source: s.source,
      createdAt: s.createdAt.toISOString(),
      originalCreatedAt: s.importedHistory?.originalCreatedAt ?? (s.creationMethod === "import" ? null : s.createdAt.toISOString()),
      sourceSnapshotAsOf: s.importedHistory?.snapshotAsOf ?? null,
      requiresSourceVerification: s.creationMethod === "import" || s.importedHistory?.kind === "csv_snapshot",
    })),
  };
}

/** Recommended win-back segments with live counts. */
export async function recommendedSegments(organizationId: string) {
  const presets: { key: string; name: string; description: string; segment: ReactivationSegment }[] = [
    {
      key: "never_contacted",
      name: "Never contacted",
      description: "Leads that came in over 30 days ago and never got past first contact.",
      segment: { statuses: ["new", "contact_attempted"], minAgeDays: 30 },
    },
    {
      key: "estimate_no_decision",
      name: "Estimate sent, no decision",
      description: "An estimate went out but the homeowner went quiet for 3+ weeks.",
      segment: { statuses: ["estimate_sent"], inactiveDays: 21 },
    },
    {
      key: "lost",
      name: "Lost to timing or price",
      description: "Marked lost — circumstances change; a friendly check-in can revive them.",
      segment: { statuses: ["lost"], minAgeDays: 60 },
    },
    {
      key: "past_customers",
      name: "Past customers",
      description: "Completed jobs — a maintenance or referral touch keeps you top of mind.",
      segment: { statuses: ["completed", "won"], inactiveDays: 180 },
    },
    {
      key: "gone_quiet",
      name: "Gone quiet",
      description: "Follow-up or nurture leads with no activity in the last 30 days.",
      segment: { statuses: ["follow_up", "nurture"], inactiveDays: 30 },
    },
  ];
  const out = [];
  for (const p of presets) {
    const conds = segmentConditions(organizationId, p.segment);
    const [{ value }] = await db
      .select({ value: sql<number>`count(*)::int` })
      .from(leadsTable)
      .where(and(...conds));
    out.push({ ...p, count: Number(value) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Campaigns
// ---------------------------------------------------------------------------

const MAX_CAMPAIGN_LEADS = 10_000;
const MAX_ENROLL_PER_TICK = 25;

async function getOrgPlaybook(
  organizationId: string,
  playbookId: string,
): Promise<Playbook | null> {
  const [pb] = await db
    .select()
    .from(playbooksTable)
    .where(and(eq(playbooksTable.id, playbookId), eq(playbooksTable.organizationId, organizationId)));
  return pb ?? null;
}

export async function createCampaign(
  organizationId: string,
  params: {
    name: string;
    playbookId: string;
    segment: unknown;
    ratePerHour?: number;
    createdByUserId?: string | null;
  },
): Promise<ReactivationCampaign | { error: string }> {
  const name = clean(params.name, 200);
  if (!name) return { error: "Campaign name is required" };
  const playbook = await getOrgPlaybook(organizationId, params.playbookId);
  if (!playbook) return { error: "Playbook not found" };
  if (playbook.steps.length === 0) return { error: "Playbook has no steps" };
  const rate = Math.min(Math.max(Math.floor(params.ratePerHour ?? 20), 1), 500);
  const [row] = await db
    .insert(reactivationCampaignsTable)
    .values({
      organizationId,
      name,
      playbookId: playbook.id,
      segment: sanitizeSegment(params.segment),
      ratePerHour: rate,
      createdByUserId: params.createdByUserId ?? null,
    })
    .returning();
  return row;
}

export async function launchCampaign(
  organizationId: string,
  campaignId: string,
): Promise<ReactivationCampaign | { error: string }> {
  const campaign = await getCampaignRow(organizationId, campaignId);
  if (!campaign) return { error: "Campaign not found" };
  if (campaign.status !== "draft") return { error: `Campaign is ${campaign.status}` };

  const conds = segmentConditions(organizationId, campaign.segment);
  const leads = await db
    .select({ id: leadsTable.id, status: leadsTable.status })
    .from(leadsTable)
    .where(and(...conds))
    .orderBy(desc(leadsTable.createdAt))
    .limit(MAX_CAMPAIGN_LEADS);
  if (leads.length === 0) return { error: "The segment matches no leads" };

  await db.transaction(async (tx) => {
    for (let i = 0; i < leads.length; i += 500) {
      await tx
        .insert(reactivationCampaignLeadsTable)
        .values(
          leads.slice(i, i + 500).map((l) => ({
            organizationId,
            campaignId,
            leadId: l.id,
            previousLeadStatus: l.status,
          })),
        )
        .onConflictDoNothing();
    }
    await tx
      .update(reactivationCampaignsTable)
      .set({ status: "running", totalLeads: leads.length, launchedAt: new Date() })
      .where(eq(reactivationCampaignsTable.id, campaignId));
  });
  await recordAudit({
    organizationId,
    action: "reactivation.launched",
    entityType: "reactivation_campaign",
    entityId: campaignId,
    metadata: { totalLeads: leads.length, ratePerHour: campaign.ratePerHour },
  });
  return (await getCampaignRow(organizationId, campaignId))!;
}

export async function setCampaignStatus(
  organizationId: string,
  campaignId: string,
  action: "pause" | "resume" | "cancel",
): Promise<ReactivationCampaign | { error: string }> {
  const campaign = await getCampaignRow(organizationId, campaignId);
  if (!campaign) return { error: "Campaign not found" };
  const allowed: Record<string, string[]> = {
    pause: ["running"],
    resume: ["paused"],
    cancel: ["draft", "running", "paused"],
  };
  if (!allowed[action].includes(campaign.status)) {
    return { error: `Cannot ${action} a ${campaign.status} campaign` };
  }
  const next = action === "pause" ? "paused" : action === "resume" ? "running" : "cancelled";
  await db
    .update(reactivationCampaignsTable)
    .set({ status: next, ...(next === "cancelled" ? { completedAt: new Date() } : {}) })
    .where(eq(reactivationCampaignsTable.id, campaignId));

  if (action === "cancel") {
    // Leads not yet enrolled never will be; sequences already running stop.
    await db
      .update(reactivationCampaignLeadsTable)
      .set({ status: "skipped", detail: "campaign cancelled" })
      .where(
        and(
          eq(reactivationCampaignLeadsTable.campaignId, campaignId),
          eq(reactivationCampaignLeadsTable.status, "pending"),
        ),
      );
    const enrolled = await db
      .select({ enrollmentId: reactivationCampaignLeadsTable.enrollmentId })
      .from(reactivationCampaignLeadsTable)
      .where(
        and(
          eq(reactivationCampaignLeadsTable.campaignId, campaignId),
          eq(reactivationCampaignLeadsTable.status, "enrolled"),
        ),
      );
    for (const row of enrolled) {
      if (row.enrollmentId) {
        await stopEnrollmentById(organizationId, row.enrollmentId, "reactivation campaign cancelled");
      }
    }
  }
  await recordAudit({
    organizationId,
    action: `reactivation.${action}`,
    entityType: "reactivation_campaign",
    entityId: campaignId,
  });
  return (await getCampaignRow(organizationId, campaignId))!;
}

async function getCampaignRow(
  organizationId: string,
  campaignId: string,
): Promise<ReactivationCampaign | null> {
  const [row] = await db
    .select()
    .from(reactivationCampaignsTable)
    .where(
      and(
        eq(reactivationCampaignsTable.id, campaignId),
        eq(reactivationCampaignsTable.organizationId, organizationId),
      ),
    );
  return row ?? null;
}

export async function listCampaigns(organizationId: string) {
  const rows = await db
    .select({
      campaign: reactivationCampaignsTable,
      playbookName: playbooksTable.name,
      enrolled: sql<number>`(
        SELECT count(*)::int FROM ${reactivationCampaignLeadsTable}
        WHERE ${reactivationCampaignLeadsTable.campaignId} = ${reactivationCampaignsTable.id}
          AND ${reactivationCampaignLeadsTable.status} = 'enrolled'
      )`,
    })
    .from(reactivationCampaignsTable)
    .leftJoin(playbooksTable, eq(reactivationCampaignsTable.playbookId, playbooksTable.id))
    .where(eq(reactivationCampaignsTable.organizationId, organizationId))
    .orderBy(desc(reactivationCampaignsTable.createdAt))
    .limit(50);
  return rows.map((r) => ({
    ...r.campaign,
    playbookName: r.playbookName,
    enrolledCount: Number(r.enrolled),
  }));
}

// ---------------------------------------------------------------------------
// Throttled drainer (called from the automation scheduler tick)
// ---------------------------------------------------------------------------

/**
 * Enroll due campaign leads at each campaign's configured hourly rate.
 * Target-based pacing: after `t` hours, at most `ceil(t * ratePerHour)`
 * leads have entered the sequence, regardless of tick cadence or restarts.
 */
export async function drainReactivationCampaigns(organizationId?: string): Promise<void> {
  const conds = [eq(reactivationCampaignsTable.status, "running" as const)];
  if (organizationId) {
    conds.push(eq(reactivationCampaignsTable.organizationId, organizationId));
  }
  const running = await db
    .select()
    .from(reactivationCampaignsTable)
    .where(and(...conds));

  for (const campaign of running) {
    try {
      await drainCampaign(campaign);
    } catch (err) {
      console.error(`[reactivation] drain failed for campaign ${campaign.id}:`, err);
    }
  }
}

async function drainCampaign(campaign: ReactivationCampaign): Promise<void> {
  const { customerWorkHeld } = await import("./customer-lifecycle-runtime");
  if (await customerWorkHeld(campaign.organizationId)) return;
  if (!campaign.launchedAt) return;
  const playbook = await getOrgPlaybook(campaign.organizationId, campaign.playbookId);
  if (!playbook) return;
  const sendingHours = await getSendingHours(campaign.organizationId);
  const failedThisTick = new Set<string>();
  // Each lead is its own transaction. The campaign lock serializes pacing,
  // while enrollment, the first scheduled step, lead status, and campaign
  // linkage commit together. A crash rolls back the whole lead and leaves
  // it pending; there is no "enrolled without enrollmentId" window.
  for (let i = 0; i < MAX_ENROLL_PER_TICK; i++) {
    if (await customerWorkHeld(campaign.organizationId)) return;
    let attemptedRowId: string | undefined;
    try {
      const advanced = await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${campaign.id}))`);
        const [current] = await tx
          .select()
          .from(reactivationCampaignsTable)
          .where(eq(reactivationCampaignsTable.id, campaign.id))
          .for("update");
        if (!current || current.status !== "running" || !current.launchedAt) return false;
        const [{ processed }] = await tx
          .select({
            processed: sql<number>`count(*) FILTER (WHERE ${reactivationCampaignLeadsTable.status} <> 'pending')::int`,
          })
          .from(reactivationCampaignLeadsTable)
          .where(eq(reactivationCampaignLeadsTable.campaignId, campaign.id));
        const elapsedHours = (Date.now() - current.launchedAt.getTime()) / 3_600_000;
        const target = Math.min(
          current.totalLeads,
          Math.max(1, Math.ceil(elapsedHours * current.ratePerHour)),
        );
        if (Number(processed) >= target) return false;
        const [row] = await tx
          .select({ id: reactivationCampaignLeadsTable.id, leadId: reactivationCampaignLeadsTable.leadId })
          .from(reactivationCampaignLeadsTable)
          .where(
            and(
              eq(reactivationCampaignLeadsTable.campaignId, campaign.id),
              eq(reactivationCampaignLeadsTable.status, "pending"),
              ...(failedThisTick.size
                ? [notInArray(reactivationCampaignLeadsTable.id, [...failedThisTick])]
                : []),
            ),
          )
          .orderBy(reactivationCampaignLeadsTable.createdAt)
          .limit(1)
          .for("update", { skipLocked: true });
        if (!row) return false;
        attemptedRowId = row.id;
        const outcome = await enrollCampaignLead(campaign, playbook, row.leadId, tx, sendingHours);
        await tx
          .update(reactivationCampaignLeadsTable)
          .set(
            outcome.status === "skipped"
              ? { status: "skipped", detail: outcome.detail, enrollmentId: null }
              : {
                  status: "enrolled",
                  detail: null,
                  enrollmentId: outcome.enrollmentId,
                  enrolledAt: new Date(),
                },
          )
          .where(eq(reactivationCampaignLeadsTable.id, row.id));
        return true;
      });
      if (!advanced) break;
    } catch (err) {
      console.error(`[reactivation] drain failed for campaign ${campaign.id}:`, err);
      if (!attemptedRowId) break;
      failedThisTick.add(attemptedRowId);
      await db
        .update(reactivationCampaignLeadsTable)
        .set({ detail: "enrollment failed; retry next cycle" })
        .where(
          and(
            eq(reactivationCampaignLeadsTable.id, attemptedRowId),
            eq(reactivationCampaignLeadsTable.status, "pending"),
          ),
        );
    }
  }

  // Completed when every snapshot lead has been processed.
  const [{ remaining }] = await db
    .select({
      remaining: sql<number>`count(*) FILTER (WHERE ${reactivationCampaignLeadsTable.status} = 'pending')::int`,
    })
    .from(reactivationCampaignLeadsTable)
    .where(eq(reactivationCampaignLeadsTable.campaignId, campaign.id));
  if (Number(remaining) === 0) {
    await db
      .update(reactivationCampaignsTable)
      .set({ status: "completed", completedAt: new Date() })
      .where(
        and(
          eq(reactivationCampaignsTable.id, campaign.id),
          eq(reactivationCampaignsTable.status, "running"),
        ),
      );
  }
}

async function enrollCampaignLead(
  campaign: ReactivationCampaign,
  playbook: Playbook,
  leadId: string,
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  sendingHours: SendingHoursSettings,
): Promise<{ status: "enrolled"; enrollmentId: string } | { status: "skipped"; detail: string }> {
  const [lead] = await tx
    .select()
    .from(leadsTable)
    .where(and(eq(leadsTable.id, leadId), eq(leadsTable.organizationId, campaign.organizationId)));
  if (!lead) return { status: "skipped", detail: "lead deleted" };
  if (needsSourceVerification(lead)) {
    return { status: "skipped", detail: "source_verification_required: imported history needs current source verification before enrollment" };
  }

  // The playbook engine only sends to outreach-active leads; move cold
  // stages (lost, completed, …) back into nurture so the win-back sequence
  // can run. The original stage is kept on the campaign lead row.
  const enrollment = await enrollLead(campaign.organizationId, lead.id, playbook, {
    transaction: tx,
    skipAudit: true,
    sendingHours,
  });
  if (!enrollment) return { status: "skipped", detail: "already in a live sequence" };
  if (!OUTREACH_ACTIVE_STATUSES.includes(lead.status as never)) {
    await tx
      .update(leadsTable)
      .set({ status: "nurture" })
      .where(eq(leadsTable.id, lead.id));
  }
  return { status: "enrolled", enrollmentId: enrollment.id };
}

// ---------------------------------------------------------------------------
// Preview + reporting
// ---------------------------------------------------------------------------

/** Generate the first-step outreach for a few sample segment leads. */
export async function previewOutreach(
  organizationId: string,
  params: { playbookId: string; segment: unknown },
): Promise<{ samples: { leadId: string; contactName: string | null; channel: string; subject: string | null; body: string }[] } | { error: string }> {
  const playbook = await getOrgPlaybook(organizationId, params.playbookId);
  if (!playbook || playbook.steps.length === 0) return { error: "Playbook not found" };
  const step = playbook.steps[0];
  const conds = segmentConditions(organizationId, sanitizeSegment(params.segment));
  const leads = await db
    .select({
      id: leadsTable.id,
      summary: leadsTable.summary,
      serviceType: leadsTable.serviceType,
      urgency: leadsTable.urgency,
      firstName: contactsTable.firstName,
      lastName: contactsTable.lastName,
    })
    .from(leadsTable)
    .leftJoin(contactsTable, eq(leadsTable.contactId, contactsTable.id))
    .where(and(...conds))
    .orderBy(desc(leadsTable.createdAt))
    .limit(3);
  if (leads.length === 0) return { error: "The segment matches no leads" };

  const settings = await getOrgSettings(organizationId);
  const businessName = settings.businessProfile.businessName ?? "our team";
  const samples = [];
  for (const lead of leads) {
    const draft = await draftOutreachMessage({
      channel: step.channel,
      prompt: step.prompt,
      businessName,
      contactFirstName: lead.firstName ?? "there",
      leadSummary: lead.summary ?? undefined,
      serviceType: lead.serviceType ?? undefined,
      urgency: lead.urgency,
      stepNumber: 1,
      totalSteps: playbook.steps.length,
    });
    samples.push({
      leadId: lead.id,
      contactName: [lead.firstName, lead.lastName].filter(Boolean).join(" ") || null,
      channel: step.channel,
      subject: step.subject ?? null,
      body: draft.body,
    });
  }
  return { samples };
}

export interface CampaignReport {
  campaign: ReactivationCampaign & { playbookName: string | null };
  enrolled: number;
  pending: number;
  skipped: number;
  contacted: number;
  replied: number;
  booked: number;
  recoveredRevenueCents: number;
}

export async function getCampaignReport(
  organizationId: string,
  campaignId: string,
): Promise<CampaignReport | null> {
  const campaign = await getCampaignRow(organizationId, campaignId);
  if (!campaign) return null;
  const [pb] = await db
    .select({ name: playbooksTable.name })
    .from(playbooksTable)
    .where(eq(playbooksTable.id, campaign.playbookId));

  const [counts] = await db
    .select({
      enrolled: sql<number>`count(*) FILTER (WHERE status = 'enrolled')::int`,
      pending: sql<number>`count(*) FILTER (WHERE status = 'pending')::int`,
      skipped: sql<number>`count(*) FILTER (WHERE status = 'skipped')::int`,
    })
    .from(reactivationCampaignLeadsTable)
    .where(eq(reactivationCampaignLeadsTable.campaignId, campaignId));

  // Contacted: enrollments that recorded at least one sent touch.
  const [outcomes] = await db
    .select({
      contacted: sql<number>`count(DISTINCT cl.lead_id) FILTER (
        WHERE EXISTS (
          SELECT 1 FROM jsonb_array_elements(e.history) h
          WHERE h->>'kind' = 'sent'
        )
      )::int`,
      replied: sql<number>`count(DISTINCT cl.lead_id) FILTER (
        WHERE e.pause_reason ILIKE '%repl%'
      )::int`,
    })
    .from(sql`${reactivationCampaignLeadsTable} cl`)
    .leftJoin(sql`${playbookEnrollmentsTable} e`, sql`e.id = cl.enrollment_id`)
    .where(sql`cl.campaign_id = ${campaignId}`);

  const launched = campaign.launchedAt ?? campaign.createdAt;
  const [booked] = await db
    .select({
      value: sql<number>`count(DISTINCT ${appointmentsTable.leadId})::int`,
    })
    .from(appointmentsTable)
    .where(
      and(
        eq(appointmentsTable.organizationId, organizationId),
        sql`${appointmentsTable.leadId} IN (
          SELECT lead_id FROM ${reactivationCampaignLeadsTable}
          WHERE campaign_id = ${campaignId} AND status = 'enrolled'
        )`,
        sql`${appointmentsTable.createdAt} > ${launched}`,
      ),
    );

  const [revenue] = await db
    .select({
      value: sql<number>`coalesce(sum(${leadsTable.estimatedValueCents}), 0)::bigint`,
    })
    .from(leadsTable)
    .where(
      and(
        eq(leadsTable.organizationId, organizationId),
        inArray(leadsTable.status, [
          "won",
          "production_scheduled",
          "in_progress",
          "final_walkthrough",
          "completed",
        ]),
        sql`${leadsTable.id} IN (
          SELECT lead_id FROM ${reactivationCampaignLeadsTable}
          WHERE campaign_id = ${campaignId} AND status = 'enrolled'
        )`,
      ),
    );

  return {
    campaign: { ...campaign, playbookName: pb?.name ?? null },
    enrolled: Number(counts.enrolled),
    pending: Number(counts.pending),
    skipped: Number(counts.skipped),
    contacted: Number(outcomes?.contacted ?? 0),
    replied: Number(outcomes?.replied ?? 0),
    booked: Number(booked?.value ?? 0),
    recoveredRevenueCents: Number(revenue?.value ?? 0),
  };
}
