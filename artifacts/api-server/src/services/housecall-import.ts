import { createHash, randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod/v4";
import {
  activitiesTable,
  appointmentsTable,
  auditEventsTable,
  contactsTable,
  customerLifecycleTable,
  db,
  importedOpportunityHistorySchema,
  invoicesTable,
  leadsTable,
  leadTagsTable,
  organizationsTable,
  propertiesTable,
  tagsTable,
  type ImportedOpportunityHistory,
} from "@workspace/db";
import { financialMigrationItemsTable } from "../../../../lib/db/src/schema/financial-migration";
import { recordAudit } from "./audit";
import { lockContractorSchedule } from "./contractor-scheduling";
import { commitFinancialMigration, previewFinancialMigration } from "./financial-migration";
import {
  FinancialMigrationError,
  normalizeFinancialSource,
  type FinancialSource,
} from "./financial-migration-contract";
import { CUSTOMER_IMPORTED_ACTION, CsvParseError, parseCsv, propertyAddressKey } from "./reactivation";

/**
 * "Move from Housecall Pro": jobs report → customer job history (imported
 * opportunities + read-only timeline records, clean future visits as
 * appointments) and its invoice columns → the strict normalized financial
 * migration loader. Staff confirm every column; a preview saves nothing.
 * Nothing here sends, schedules a reminder or moves money.
 */

/** Same key as the customer import, so customer IDs and jobs share one namespace. */
export const HCP_SOURCE_KEY = "housecall-pro";
export const HCP_FINANCIAL_SOURCE = { sourceSystem: "housecall_pro", sourceAccount: "jobs-report" } as const;
export const HCP_JOB_ACTIVITY = "imported_job";
export const MAX_JOB_ROWS = 10_000;
export const MAX_INVOICES_PER_RUN = 2_000;
const INVOICES_PER_REVIEW = 50;
const MAX_LISTED = 200;
const PREVIEW_BUDGET_MS = 45_000;
const COMMIT_BUDGET_MS = 120_000;

export const JOB_FIELDS = [
  "jobId", "jobNumber", "createdAt", "scheduledStart", "scheduledEnd", "completedAt",
  "customerName", "firstName", "lastName", "email", "phone", "homePhone", "customerId",
  "street", "street2", "city", "state", "postalCode",
  "description", "lineItems", "amount", "tax", "paidAmount", "due", "paymentHistory",
  "employees", "status", "invoiceSentAt", "jobTags", "customerTags", "leadSource",
] as const;
export type JobField = (typeof JOB_FIELDS)[number];

export class HousecallImportError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
class RowError extends Error {}
class DryRunRollback extends Error {}

const validTimeZone = (tz: string) => {
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; }
};
const fileSchema = {
  csv: z.string().min(1).max(5_000_000),
  fileName: z.string().max(200).optional(),
  mapping: z.partialRecord(z.enum(JOB_FIELDS), z.number().int().min(0).max(255)),
  /** The day the contractor exported the report; it bounds every source date. */
  exportedOn: z.iso.date(),
  timeZone: z.string().min(1).max(64).refine(validTimeZone, "Choose a valid time zone."),
};
export const jobsImportSchema = z.object({ ...fileSchema, dryRun: z.boolean() }).strict();
export const invoicesPreviewSchema = z.object(fileSchema).strict();
export const invoicesCommitSchema = z.object({
  reviews: z.array(z.object({ id: z.uuid(), digest: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).min(1).max(MAX_INVOICES_PER_RUN / INVOICES_PER_REVIEW),
  confirmed: z.literal(true),
  sourceFrozen: z.literal(true),
}).strict();

// ---------------------------------------------------------------------------
// Value parsing. Exports carry local wall-clock times without an offset, so
// staff name the company time zone; anything ambiguous is refused, not guessed.
// ---------------------------------------------------------------------------

function tzOffsetMs(ms: number, timeZone: string) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  return Date.UTC(+parts.year!, +parts.month! - 1, +parts.day!, +parts.hour!, +parts.minute!, +parts.second!) - ms;
}
export function zonedTime(y: number, mo: number, d: number, h: number, mi: number, s: number, timeZone: string): Date {
  const days = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  if (mo < 1 || mo > 12 || d < 1 || d > days || h > 23 || mi > 59 || s > 59) throw new RowError("is not a valid calendar date");
  const wall = Date.UTC(y, mo - 1, d, h, mi, s);
  let guess = wall - tzOffsetMs(wall, timeZone);
  guess = wall - tzOffsetMs(guess, timeZone);
  return new Date(guess);
}
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
/** ISO, YYYY-MM-DD[ HH:MM[:SS]], M/D/YYYY[ h:mm[:ss] [AM|PM]] or "Mon D, YYYY[ h:mm AM]". */
export function parseHcpDate(value: string | undefined, timeZone: string): Date | null {
  const input = value?.trim().replace(/\s+/g, " ");
  if (!input) return null;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.test(input)) {
    const parsed = new Date(input);
    if (!Number.isFinite(parsed.getTime())) throw new RowError("is not a valid date");
    return parsed;
  }
  const time = (rest: string | undefined) => {
    if (!rest) return [0, 0, 0] as const;
    const t = /^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([ap]\.?m\.?)?$/i.exec(rest.trim());
    if (!t) throw new RowError("has a time that could not be read");
    let hour = Number(t[1]);
    const meridiem = t[4]?.toLowerCase().replace(/\./g, "");
    if (meridiem) {
      if (hour < 1 || hour > 12) throw new RowError("has a time that could not be read");
      hour = (hour % 12) + (meridiem === "pm" ? 12 : 0);
    }
    return [hour, Number(t[2]), Number(t[3] ?? 0)] as const;
  };
  let m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](.+))?$/.exec(input);
  if (m) return zonedTime(+m[1]!, +m[2]!, +m[3]!, ...time(m[4]), timeZone);
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:,?\s+(.+))?$/.exec(input);
  if (m) return zonedTime(+m[3]!, +m[1]!, +m[2]!, ...time(m[4]), timeZone);
  m = /^(?:[a-z]{3,9},?\s+)?([a-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})(?:,?\s+(?:at\s+)?(.+))?$/i.exec(input);
  if (m && MONTHS.includes(m[1]!.toLowerCase())) return zonedTime(+m[3]!, MONTHS.indexOf(m[1]!.toLowerCase()) + 1, +m[2]!, ...time(m[4]), timeZone);
  throw new RowError("is not a date we can read (use the date format from the Housecall Pro export)");
}
/** "$1,234.56", "1234.5" or "1,234". Never negative, never a guessed currency. */
export function parseHcpMoney(value: string | undefined): number | null {
  const input = value?.trim().replace(/^\$\s*/, "");
  if (!input) return null;
  if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(input)) throw new RowError("must be a dollar amount like 1234.56");
  const [whole, fraction = ""] = input.replace(/,/g, "").split(".");
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(cents) || cents > 1_000_000_000) throw new RowError("is too large");
  return cents;
}
type JobKind = "completed" | "scheduled" | "in_progress" | "unscheduled" | "canceled";
export function classifyHcpStatus(raw: string | null, completedAt: Date | null): { kind: JobKind; recognized: boolean } {
  const s = (raw ?? "").toLowerCase().replace(/[_-]/g, " ").trim();
  if (/cancel/.test(s)) return { kind: "canceled", recognized: true };
  if (/complete|finished|\bdone\b|\bpaid\b/.test(s)) return { kind: "completed", recognized: true };
  if (/in progress|started|on my way|working/.test(s)) return { kind: "in_progress", recognized: true };
  if (/unscheduled|needs scheduling|not scheduled/.test(s)) return { kind: "unscheduled", recognized: true };
  if (/scheduled/.test(s)) return { kind: "scheduled", recognized: true };
  if (!s) return { kind: completedAt ? "completed" : "unscheduled", recognized: completedAt !== null };
  return { kind: completedAt ? "completed" : "unscheduled", recognized: false };
}
const LEAD_STATUS: Record<JobKind, typeof leadsTable.$inferSelect.status> = {
  completed: "completed", canceled: "lost", in_progress: "in_progress", scheduled: "production_scheduled", unscheduled: "won",
};

type Address = { addressLine1: string; addressLine2: string | null; city: string; state: string; postalCode: string };
export type ParsedJob = {
  rowNo: number; jobId: string; jobNumber: string | null;
  createdAt: Date | null; scheduledStart: Date | null; scheduledEnd: Date | null; completedAt: Date | null; invoiceSentAt: Date | null;
  customerName: string; firstName: string | null; lastName: string | null; email: string | null; phones: string[]; customerId: string | null;
  address: Address | null; description: string | null; lineItems: string | null;
  amountCents: number | null; taxCents: number; paidCents: number | null; dueCents: number | null; paymentHistory: string | null;
  employees: string[]; rawStatus: string | null; kind: JobKind; statusRecognized: boolean;
  jobTags: string[]; customerTags: string[]; leadSource: string | null; fingerprint: string;
};
export type RowProblem = { row: number; jobNumber: string | null; customer: string | null; reason: string };

const text = (v: string | undefined, max: number) => {
  const s = (v ?? "").trim().replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
  return s ? s.slice(0, max) : null;
};
const list = (v: string | undefined) => (text(v, 1000) ?? "").split(/\s*[,;|]\s*/).map((t) => t.slice(0, 60)).filter(Boolean).slice(0, 20);
const digits = (v: string | null) => (v ? v.replace(/\D/g, "") : "");

export function parseJobsFile(input: { csv: string; mapping: Partial<Record<JobField, number>>; timeZone: string }) {
  let all: string[][];
  try { all = parseCsv(input.csv); } catch (error) {
    if (error instanceof CsvParseError) throw new HousecallImportError(400, "hcp_csv_invalid", error.message);
    throw error;
  }
  const [header, ...rows] = all;
  const m = input.mapping;
  if (!header || rows.length === 0) throw new HousecallImportError(400, "hcp_csv_empty", "No data rows were found in the file.");
  if (rows.length > MAX_JOB_ROWS) throw new HousecallImportError(400, "hcp_csv_too_large", `The file has more than ${MAX_JOB_ROWS.toLocaleString("en-US")} rows. Export a shorter date range and import each file.`);
  const used = Object.values(m);
  if (new Set(used).size !== used.length) throw new HousecallImportError(400, "hcp_mapping_invalid", "Each column can only be used for one field.");
  if (used.some((i) => i >= header.length)) throw new HousecallImportError(400, "hcp_mapping_invalid", "A chosen column is missing from the file's header.");
  if (m.jobId === undefined) throw new HousecallImportError(400, "hcp_mapping_invalid", "Choose the Housecall Pro job ID column (HCP Id).");
  if (m.email === undefined && m.phone === undefined && m.homePhone === undefined && m.customerId === undefined)
    throw new HousecallImportError(400, "hcp_mapping_invalid", "Choose an email, phone or customer ID column so jobs can be matched to customers.");
  if (m.status === undefined && m.completedAt === undefined) throw new HousecallImportError(400, "hcp_mapping_invalid", "Choose the Job Status or Finished column.");
  const jobs: ParsedJob[] = [];
  const problems: RowProblem[] = [];
  const seen = new Set<string>();
  for (const [i, row] of rows.entries()) {
    const rowNo = i + 2;
    const get = (f: JobField) => (m[f] === undefined ? undefined : row[m[f]!]);
    const jobNumber = text(get("jobNumber"), 160);
    const customerName = text(get("customerName"), 200) ?? ([text(get("firstName"), 100), text(get("lastName"), 100)].filter(Boolean).join(" ") || "Unknown customer");
    const problem = (reason: string) => problems.push({ row: rowNo, jobNumber, customer: customerName, reason });
    if (row.length !== header.length) { problem("column count does not match the header; nothing from this row was used"); continue; }
    const jobId = text(get("jobId"), 160);
    if (!jobId) { problem("missing Housecall Pro job ID"); continue; }
    if (seen.has(jobId)) { problem("the same job ID appears more than once in this file; only the first row was used"); continue; }
    seen.add(jobId);
    const field = <T>(name: string, parse: () => T): T => {
      try { return parse(); } catch (error) {
        if (error instanceof RowError) throw new RowError(`${name} ${error.message}`);
        throw error;
      }
    };
    try {
      const date = (f: JobField, name: string) => field(name, () => parseHcpDate(get(f), input.timeZone));
      const money = (f: JobField, name: string) => field(name, () => parseHcpMoney(get(f)));
      const completedAt = date("completedAt", "Finished date");
      const rawStatus = text(get("status"), 80);
      const { kind, recognized } = classifyHcpStatus(rawStatus, completedAt);
      const email = text(get("email"), 200)?.toLowerCase() ?? null;
      if (email && !z.email().safeParse(email).success) throw new RowError("email is not a valid address");
      const phones = [digits(text(get("phone"), 40)), digits(text(get("homePhone"), 40))].filter((p) => p.length >= 7);
      const addressValue = { addressLine1: text(get("street"), 200), addressLine2: text(get("street2"), 200), city: text(get("city"), 100), state: text(get("state"), 50), postalCode: text(get("postalCode"), 20) };
      const address = addressValue.addressLine1 && addressValue.city && addressValue.state && addressValue.postalCode ? addressValue as Address : null;
      const parsed = {
        rowNo, jobId, jobNumber,
        createdAt: date("createdAt", "Created date"), scheduledStart: date("scheduledStart", "Scheduled date"),
        scheduledEnd: date("scheduledEnd", "End time"), completedAt, invoiceSentAt: date("invoiceSentAt", "Invoice sent date"),
        customerName, firstName: text(get("firstName"), 100), lastName: text(get("lastName"), 100), email, phones,
        customerId: text(get("customerId"), 160), address,
        description: text(get("description"), 1000), lineItems: text(get("lineItems"), 4000),
        amountCents: money("amount", "Amount"), taxCents: money("tax", "Tax") ?? 0,
        paidCents: money("paidAmount", "Paid Amount"), dueCents: money("due", "Due"), paymentHistory: text(get("paymentHistory"), 1000),
        employees: list(get("employees")), rawStatus, kind, statusRecognized: recognized,
        jobTags: list(get("jobTags")), customerTags: list(get("customerTags")), leadSource: text(get("leadSource"), 100),
      };
      if (parsed.scheduledEnd && parsed.scheduledStart && parsed.scheduledEnd < parsed.scheduledStart) throw new RowError("End time is before the scheduled date");
      // Contact values are compared without being retained in import history.
      const fingerprint = createHash("sha256").update(JSON.stringify({ ...parsed, rowNo: undefined })).digest("hex");
      jobs.push({ ...parsed, fingerprint });
    } catch (error) {
      if (error instanceof RowError) { problem(error.message); continue; }
      throw error;
    }
  }
  return { totalRows: rows.length, jobs, problems };
}

/** End of the export day in the company time zone, never later than now. */
export function exportCutoff(exportedOn: string, timeZone: string, now = new Date()) {
  const [y, mo, d] = exportedOn.split("-").map(Number);
  const endOfDay = new Date(zonedTime(y!, mo!, d!, 23, 59, 59, timeZone).getTime() + 999);
  if (zonedTime(y!, mo!, d!, 0, 0, 0, timeZone).getTime() > now.getTime())
    throw new HousecallImportError(400, "hcp_export_date_future", "The export date cannot be in the future.");
  return new Date(Math.min(endOfDay.getTime(), now.getTime()));
}

// ---------------------------------------------------------------------------
// Customer matching (shared by jobs and invoices). Never creates a person and
// never merges by guess: one customer must match, or the row is listed.
// ---------------------------------------------------------------------------

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Reader = Tx | typeof db;
async function loadCustomers(reader: Reader, org: string) {
  const contacts = await reader.select({ id: contactsTable.id, firstName: contactsTable.firstName, lastName: contactsTable.lastName, email: contactsTable.email, phone: contactsTable.phone })
    .from(contactsTable).where(eq(contactsTable.organizationId, org));
  const byEmail = new Map<string, Set<string>>(), byPhone = new Map<string, Set<string>>();
  const add = (map: Map<string, Set<string>>, key: string, id: string) => map.set(key, (map.get(key) ?? new Set()).add(id));
  for (const c of contacts) {
    if (c.email) add(byEmail, c.email.trim().toLowerCase(), c.id);
    const p = digits(c.phone);
    if (p.length >= 7) add(byPhone, p, c.id);
  }
  const provenance = await reader.select({ contactId: auditEventsTable.entityId, externalCustomerId: sql<string>`${auditEventsTable.metadata}->>'externalCustomerId'` })
    .from(auditEventsTable).where(and(
      eq(auditEventsTable.organizationId, org), eq(auditEventsTable.action, CUSTOMER_IMPORTED_ACTION),
      sql`${auditEventsTable.metadata}->>'sourceKey' = ${HCP_SOURCE_KEY}`, sql`${auditEventsTable.metadata}->>'externalCustomerId' IS NOT NULL`,
    ));
  const byCustomerId = new Map<string, Set<string>>();
  for (const p of provenance) if (p.contactId) add(byCustomerId, p.externalCustomerId, p.contactId);
  const names = new Map(contacts.map((c) => [c.id, [c.firstName, c.lastName].filter(Boolean).join(" ")]));
  return {
    names,
    match(job: ParsedJob): { contactId: string } | { reason: string } {
      if (job.customerId && byCustomerId.has(job.customerId)) {
        const ids = byCustomerId.get(job.customerId)!;
        if (ids.size === 1) return { contactId: [...ids][0]! };
        return { reason: "this Housecall Pro customer ID is linked to more than one GrowthOS customer; reconcile them first" };
      }
      const found = new Set<string>([...(job.email ? byEmail.get(job.email) ?? [] : []), ...job.phones.flatMap((p) => [...(byPhone.get(p) ?? [])])]);
      if (found.size === 1) return { contactId: [...found][0]! };
      if (found.size > 1) return { reason: "the email and phone match more than one GrowthOS customer; reconcile them first" };
      return { reason: "no GrowthOS customer has this email or phone; import the customer list first, then this file again" };
    },
  };
}

async function lockAndCheckCompany(tx: Tx, org: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`customer-lifecycle:${org}`}, 0))`);
  const [state] = await tx.select({ state: customerLifecycleTable.state }).from(customerLifecycleTable).where(eq(customerLifecycleTable.organizationId, org));
  if (state && state.state !== "active") throw new HousecallImportError(409, "hcp_company_held", "Imports are held while this company is paused or offboarding.");
}

// ---------------------------------------------------------------------------
// Jobs → customer job history
// ---------------------------------------------------------------------------

export type JobsImportResult = {
  dryRun: boolean; batchId: string | null; fileName: string | null; totalRows: number;
  newJobs: number; updatedJobs: number; alreadyImported: number;
  completed: number; upcoming: number; canceled: number;
  appointmentsCreated: number; needsScheduling: number; propertiesCreated: number;
  unmatched: RowProblem[]; problems: RowProblem[]; listsTruncated: boolean;
  sample: { row: number; jobNumber: string | null; customer: string; status: string; date: string | null; totalCents: number | null; action: string }[];
};

export async function importHousecallJobs(org: string, actor: string, raw: unknown, now = new Date()): Promise<JobsImportResult> {
  const input = jobsImportSchema.parse(raw);
  const snapshotAsOf = exportCutoff(input.exportedOn, input.timeZone, now);
  const parsed = parseJobsFile(input);
  const batchId = input.dryRun ? null : randomUUID();
  const fileName = text(input.fileName, 200);
  const result: JobsImportResult = {
    dryRun: input.dryRun, batchId, fileName, totalRows: parsed.totalRows,
    newJobs: 0, updatedJobs: 0, alreadyImported: 0, completed: 0, upcoming: 0, canceled: 0,
    appointmentsCreated: 0, needsScheduling: 0, propertiesCreated: 0,
    unmatched: [], problems: [...parsed.problems], listsTruncated: false, sample: [],
  };
  const deadline = Date.now() + (input.dryRun ? PREVIEW_BUDGET_MS : COMMIT_BUDGET_MS);
  const work = async (tx: Tx) => {
    await tx.execute(sql`select set_config('lock_timeout','5000ms',true), set_config('statement_timeout','15000ms',true)`);
    await lockAndCheckCompany(tx, org);
    // Only a real import adds calendar visits; a preview must not hold up booking.
    if (!input.dryRun) await lockContractorSchedule(tx, org);
    // Same serialization as the CSV customer/lead import.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`lead-import:${org}`}))`);
    const customers = await loadCustomers(tx, org);
    const properties = await tx.select({ id: propertiesTable.id, contactId: propertiesTable.contactId, addressLine1: propertiesTable.addressLine1, postalCode: propertiesTable.postalCode })
      .from(propertiesTable).where(eq(propertiesTable.organizationId, org));
    const propertiesByContact = new Map<string, { id: string; key: string }[]>();
    for (const p of properties) if (p.contactId) propertiesByContact.set(p.contactId, [...(propertiesByContact.get(p.contactId) ?? []), { id: p.id, key: propertyAddressKey(p.addressLine1, p.postalCode) }]);
    const ids = parsed.jobs.map((j) => j.jobId);
    const existing = new Map<string, typeof leadsTable.$inferSelect>();
    for (let i = 0; i < ids.length; i += 1000) {
      const rows = await tx.select().from(leadsTable).where(and(eq(leadsTable.organizationId, org), eq(leadsTable.importSourceKey, HCP_SOURCE_KEY), inArray(leadsTable.externalOpportunityId, ids.slice(i, i + 1000)))).for("update");
      for (const r of rows) existing.set(r.externalOpportunityId!, r);
    }
    const tagIds = new Map<string, string>();
    const tagLead = async (leadId: string, names: string[]) => {
      for (const name of [...new Set(names)]) {
        let tagId = tagIds.get(name.toLowerCase());
        if (!tagId) {
          await tx.insert(tagsTable).values({ organizationId: org, name }).onConflictDoNothing();
          const [tag] = await tx.select({ id: tagsTable.id }).from(tagsTable).where(and(eq(tagsTable.organizationId, org), eq(tagsTable.name, name)));
          tagId = tag!.id;
          tagIds.set(name.toLowerCase(), tagId);
        }
        await tx.insert(leadTagsTable).values({ organizationId: org, leadId, tagId }).onConflictDoNothing();
      }
    };
    for (const job of parsed.jobs) {
      if (Date.now() > deadline) throw new HousecallImportError(503, "hcp_import_slow", "The import could not finish in time. Nothing was saved. Export a shorter date range and import each file.");
      const listedProblem = (list: RowProblem[], reason: string) => {
        if (list.length < MAX_LISTED) list.push({ row: job.rowNo, jobNumber: job.jobNumber, customer: job.customerName, reason });
        else result.listsTruncated = true;
      };
      const dates = [job.createdAt, job.completedAt, job.invoiceSentAt].filter((d): d is Date => d !== null);
      if (dates.some((d) => d > snapshotAsOf)) { listedProblem(result.problems, "a created, finished or invoice date is after the export date"); continue; }
      if (job.completedAt && job.kind === "completed" && job.scheduledStart && job.scheduledStart > snapshotAsOf) { listedProblem(result.problems, "marked complete but scheduled after the export date"); continue; }
      const matched = customers.match(job);
      if ("reason" in matched) { listedProblem(result.unmatched, matched.reason); continue; }
      const contactId = matched.contactId;
      const prior = existing.get(job.jobId);
      if (prior && prior.contactId !== contactId) { listedProblem(result.problems, "this job was imported before for a different customer; reconcile it before importing again"); continue; }
      const upcoming = job.kind === "scheduled" && job.scheduledStart !== null && job.scheduledStart > now;
      const staffFollowUp = !job.statusRecognized ? `Status "${job.rawStatus ?? ""}" was not recognized; check this job.`
        : job.kind === "unscheduled" ? "Needs scheduling in GrowthOS."
        : job.kind === "scheduled" && !upcoming ? "Scheduled in Housecall Pro for a past date but not marked complete; check this job."
        : job.kind === "in_progress" ? "In progress in Housecall Pro; confirm its schedule in GrowthOS."
        : null;
      const applied = {
        status: LEAD_STATUS[job.kind],
        estimatedValueCents: job.amountCents !== null && job.amountCents <= 2_147_483_647 ? job.amountCents : null,
        serviceType: null as string | null,
        summary: (job.description ?? (job.jobNumber ? `Housecall Pro job ${job.jobNumber}` : "Housecall Pro job")).slice(0, 500),
        latestSource: job.leadSource ?? HCP_SOURCE_KEY,
      };
      const appliedFingerprint = createHash("sha256").update(JSON.stringify(applied)).digest("hex");
      const isoOrNull = (d: Date | null) => (d && d <= snapshotAsOf ? d.toISOString() : null);
      const history: ImportedOpportunityHistory = importedOpportunityHistorySchema.parse({
        version: 1, kind: "csv_snapshot", originalCreatedAt: isoOrNull(job.createdAt), sourceUpdatedAt: null,
        statusChangedAt: isoOrNull(job.completedAt), lastContactAt: null, snapshotAsOf: snapshotAsOf.toISOString(),
        firstImportedAt: (prior?.importedHistory?.firstImportedAt ?? now.toISOString()), lastImportedAt: now.toISOString(),
        externalCustomerId: job.customerId, externalEstimateId: null, currency: job.amountCents !== null ? "USD" : null,
        fingerprint: job.fingerprint, appliedFingerprint, mappedFields: Object.keys(input.mapping).sort(),
      });
      if (prior?.importedHistory?.fingerprint === job.fingerprint) {
        result.alreadyImported++;
        continue;
      }
      if (prior) {
        const current = createHash("sha256").update(JSON.stringify({
          status: prior.status, estimatedValueCents: prior.estimatedValueCents, serviceType: prior.serviceType, summary: prior.summary, latestSource: prior.latestSource,
        })).digest("hex");
        if (!prior.importedHistory || prior.importedHistory.appliedFingerprint !== current) {
          listedProblem(result.problems, "this job changed in Housecall Pro, but it was also edited in GrowthOS; the GrowthOS record was kept");
          continue;
        }
      }
      // Property: the job's service address, else the customer's only property.
      let propertyId: string | null = prior?.propertyId ?? null;
      if (!prior) {
        const owned = propertiesByContact.get(contactId) ?? [];
        if (job.address) {
          const key = propertyAddressKey(job.address.addressLine1, job.address.postalCode);
          propertyId = owned.find((p) => p.key === key)?.id ?? null;
          if (!propertyId) {
            const [created] = await tx.insert(propertiesTable).values({ organizationId: org, contactId, ...job.address }).returning({ id: propertiesTable.id });
            propertyId = created!.id;
            propertiesByContact.set(contactId, [...owned, { id: propertyId, key }]);
            result.propertiesCreated++;
          }
        } else if (owned.length === 1) propertyId = owned[0]!.id;
      }
      let leadId: string;
      if (prior) {
        await tx.update(leadsTable).set({ ...applied, importedHistory: history }).where(and(eq(leadsTable.id, prior.id), eq(leadsTable.organizationId, org)));
        leadId = prior.id;
        result.updatedJobs++;
      } else {
        const [lead] = await tx.insert(leadsTable).values({
          organizationId: org, contactId, propertyId, ...applied, source: job.leadSource ?? HCP_SOURCE_KEY,
          creationMethod: "import", importSourceKey: HCP_SOURCE_KEY, externalOpportunityId: job.jobId, importedHistory: history,
        }).returning({ id: leadsTable.id });
        leadId = lead!.id;
        result.newJobs++;
      }
      await tagLead(leadId, [...job.jobTags, ...job.customerTags]);
      // A clean future visit becomes a calendar appointment. No reminder is
      // scheduled and no one is notified; staff decide on any customer contact.
      let appointmentId: string | null = null;
      const clean = upcoming && !prior && propertyId !== null &&
        (!job.scheduledEnd || job.scheduledEnd.getTime() - job.scheduledStart!.getTime() <= 24 * 3_600_000);
      if (clean) {
        const [appointment] = await tx.insert(appointmentsTable).values({
          organizationId: org, leadId, contactId, propertyId, type: "other", status: "scheduled",
          scheduledStart: job.scheduledStart!, scheduledEnd: job.scheduledEnd,
          notes: [`Imported from Housecall Pro job ${job.jobNumber ?? job.jobId}.`, job.employees.length ? `Assigned in Housecall Pro: ${job.employees.join(", ")}.` : null,
            "No reminder was scheduled by the import."].filter(Boolean).join(" "),
        }).returning({ id: appointmentsTable.id });
        appointmentId = appointment!.id;
        result.appointmentsCreated++;
      }
      const followUp = upcoming && !clean ? "Scheduled in Housecall Pro, but it could not be placed on the calendar as-is (no service address or an unusual length); schedule it in GrowthOS." : staffFollowUp;
      if (followUp && job.kind !== "completed" && job.kind !== "canceled") result.needsScheduling++;
      // Read-only history record of what Housecall Pro said about this job.
      await tx.insert(activitiesTable).values({
        organizationId: org, leadId, contactId, actorUserId: actor, type: HCP_JOB_ACTIVITY,
        title: `Housecall Pro job ${job.jobNumber ?? job.jobId}${prior ? " (updated)" : ""}`,
        body: [job.description, job.lineItems && `Line items: ${job.lineItems}`].filter(Boolean).join("\n").slice(0, 4000) || null,
        occurredAt: job.completedAt ?? (job.scheduledStart && job.scheduledStart <= now ? job.scheduledStart : null) ?? job.createdAt ?? now,
        metadata: {
          source: "housecall_pro", sourceKey: HCP_SOURCE_KEY, batchId, fileName, externalJobId: job.jobId, jobNumber: job.jobNumber,
          externalCustomerId: job.customerId, status: job.rawStatus, kind: job.kind,
          scheduledStart: job.scheduledStart?.toISOString() ?? null, scheduledEnd: job.scheduledEnd?.toISOString() ?? null,
          completedAt: job.completedAt?.toISOString() ?? null, createdAt: job.createdAt?.toISOString() ?? null,
          employees: job.employees, totalCents: job.amountCents, paidCents: job.paidCents, dueCents: job.dueCents,
          jobTags: job.jobTags, customerTags: job.customerTags, propertyId, appointmentId, staffFollowUp: followUp,
          rowFingerprint: job.fingerprint, readOnly: true,
        },
      });
      if (job.kind === "completed") result.completed++;
      else if (job.kind === "canceled") result.canceled++;
      else result.upcoming++;
      if (result.sample.length < 5) result.sample.push({
        row: job.rowNo, jobNumber: job.jobNumber, customer: customers.names.get(contactId) || job.customerName, status: job.rawStatus ?? job.kind,
        date: (job.completedAt ?? job.scheduledStart)?.toISOString() ?? null, totalCents: job.amountCents,
        action: prior ? "update" : appointmentId ? "history + calendar visit" : followUp && job.kind !== "completed" && job.kind !== "canceled" ? "history, needs scheduling" : "history",
      });
    }
    if (input.dryRun) throw new DryRunRollback();
    await tx.insert(auditEventsTable).values({
      organizationId: org, actorUserId: actor, action: "housecall.jobs_imported", entityType: "housecall_import", entityId: batchId,
      metadata: {
        source: "housecall_pro", sourceKey: HCP_SOURCE_KEY, fileName, fileSha256: createHash("sha256").update(input.csv).digest("hex"),
        exportedOn: input.exportedOn, timeZone: input.timeZone, totalRows: result.totalRows, newJobs: result.newJobs, updatedJobs: result.updatedJobs,
        alreadyImported: result.alreadyImported, appointmentsCreated: result.appointmentsCreated, propertiesCreated: result.propertiesCreated,
        unmatched: result.unmatched.length, problems: result.problems.length, customerContact: false,
      },
    });
  };
  try {
    await db.transaction(work);
  } catch (error) {
    if (error instanceof DryRunRollback) return result;
    const code = (error as { code?: unknown; cause?: { code?: unknown } }).code ?? (error as { cause?: { code?: unknown } }).cause?.code;
    if (code === "55P03" || code === "57014") throw new HousecallImportError(503, "hcp_import_slow", "Another import is running or the file is too large to finish in time. Nothing was saved. Try again, or import a shorter date range.");
    throw error;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Invoices and open balances → normalized financial migration v1
// ---------------------------------------------------------------------------

type PlannedInvoice = { job: ParsedJob; leadId: string; invoice: FinancialSource["invoices"][number]; receipt: FinancialSource["receipts"][number] | null; estimatedPaymentDate: boolean };
export type InvoicePlan = {
  cutoffAt: string;
  file: { count: number; totalCents: number };
  ready: { count: number; totalCents: number; paidInFull: number; paymentCents: number; openBalances: number; openingReceivableCents: number; estimatedPaymentDates: number };
  alreadyImported: { count: number; totalCents: number };
  notInvoiced: number;
  unmatched: (RowProblem & { totalCents: number | null })[];
  unreconciled: (RowProblem & { totalCents: number | null })[];
  listsTruncated: boolean;
  planned: PlannedInvoice[];
};

/** Latest date in the Payment History text that we can read and that is not after the cutoff. */
function paymentDate(history: string | null, timeZone: string, cutoff: Date): Date | null {
  if (!history) return null;
  const candidates = history.match(/\d{4}-\d{2}-\d{2}(?:[ T]\d{1,2}:\d{2}(?::\d{2})?)?|\d{1,2}\/\d{1,2}\/\d{4}(?:,?\s+\d{1,2}:\d{2}(?::\d{2})?\s*(?:[ap]\.?m\.?)?)?/gi) ?? [];
  let best: Date | null = null;
  for (const c of candidates) {
    try {
      const d = parseHcpDate(c, timeZone);
      if (d && d <= cutoff && (!best || d > best)) best = d;
    } catch { /* not a date */ }
  }
  return best;
}
const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;

export async function planHousecallInvoices(org: string, raw: unknown, now = new Date()): Promise<InvoicePlan> {
  const input = invoicesPreviewSchema.parse(raw);
  for (const required of ["jobNumber", "amount", "paidAmount", "due"] as const)
    if (input.mapping[required] === undefined) throw new HousecallImportError(400, "hcp_mapping_invalid", "Choose the Invoice, Amount, Paid Amount and Due columns to import invoices and balances.");
  const cutoff = exportCutoff(input.exportedOn, input.timeZone, now);
  const parsed = parseJobsFile(input);
  const plan: InvoicePlan = {
    cutoffAt: cutoff.toISOString(), file: { count: 0, totalCents: 0 },
    ready: { count: 0, totalCents: 0, paidInFull: 0, paymentCents: 0, openBalances: 0, openingReceivableCents: 0, estimatedPaymentDates: 0 },
    alreadyImported: { count: 0, totalCents: 0 }, notInvoiced: 0, unmatched: [], unreconciled: [], listsTruncated: false, planned: [],
  };
  for (const p of parsed.problems) plan.unreconciled.push({ ...p, totalCents: null });
  const invoiceRows = parsed.jobs.filter((job) => {
    if (job.kind === "canceled" || !job.amountCents) { plan.notInvoiced++; return false; }
    // A job that is not finished, not invoiced and not paid has no invoice yet.
    if (job.kind !== "completed" && !job.invoiceSentAt && !job.paidCents) { plan.notInvoiced++; return false; }
    return true;
  });
  for (const job of invoiceRows) { plan.file.count++; plan.file.totalCents += job.amountCents!; }
  if (plan.file.count > MAX_INVOICES_PER_RUN) throw new HousecallImportError(400, "hcp_too_many_invoices", `The file has more than ${MAX_INVOICES_PER_RUN.toLocaleString("en-US")} invoices. Export a shorter date range (for example one year) and import each file.`);

  const ids = invoiceRows.map((j) => j.jobId);
  const leads = new Map<string, { id: string; contactId: string; propertyId: string | null }>();
  const imported = new Set<string>();
  const usedNumbers = new Set<string>();
  for (let i = 0; i < ids.length; i += 1000) {
    const slice = ids.slice(i, i + 1000);
    for (const l of await db.select({ id: leadsTable.id, contactId: leadsTable.contactId, propertyId: leadsTable.propertyId, externalId: leadsTable.externalOpportunityId })
      .from(leadsTable).where(and(eq(leadsTable.organizationId, org), eq(leadsTable.importSourceKey, HCP_SOURCE_KEY), inArray(leadsTable.externalOpportunityId, slice))))
      leads.set(l.externalId!, l);
    for (const item of await db.select({ externalId: financialMigrationItemsTable.externalId }).from(financialMigrationItemsTable).where(and(
      eq(financialMigrationItemsTable.organizationId, org), eq(financialMigrationItemsTable.sourceSystem, HCP_FINANCIAL_SOURCE.sourceSystem),
      eq(financialMigrationItemsTable.sourceAccount, HCP_FINANCIAL_SOURCE.sourceAccount), eq(financialMigrationItemsTable.entityType, "invoice"),
      inArray(financialMigrationItemsTable.externalId, slice.map((id) => `job:${id}`)),
    ))) imported.add(item.externalId);
  }
  const numbers = [...new Set(invoiceRows.map((j) => j.jobNumber).filter((n): n is string => !!n))];
  for (let i = 0; i < numbers.length; i += 1000)
    for (const n of await db.select({ number: invoicesTable.invoiceNumber }).from(invoicesTable).where(and(eq(invoicesTable.organizationId, org), inArray(invoicesTable.invoiceNumber, numbers.slice(i, i + 1000)))))
      if (n.number) usedNumbers.add(n.number);
  const contactIds = [...new Set([...leads.values()].map((l) => l.contactId))];
  const propertyIds = [...new Set([...leads.values()].map((l) => l.propertyId).filter((p): p is string => !!p))];
  const contacts = new Map<string, string>(), propertyLabels = new Map<string, string>();
  for (let i = 0; i < contactIds.length; i += 1000)
    for (const c of await db.select({ id: contactsTable.id, firstName: contactsTable.firstName, lastName: contactsTable.lastName }).from(contactsTable).where(and(eq(contactsTable.organizationId, org), inArray(contactsTable.id, contactIds.slice(i, i + 1000)))))
      contacts.set(c.id, [c.firstName, c.lastName].filter(Boolean).join(" "));
  for (let i = 0; i < propertyIds.length; i += 1000)
    for (const p of await db.select().from(propertiesTable).where(and(eq(propertiesTable.organizationId, org), inArray(propertiesTable.id, propertyIds.slice(i, i + 1000)))))
      propertyLabels.set(p.id, [p.addressLine1, p.addressLine2, p.city, p.state, p.postalCode].filter(Boolean).join(", ").slice(0, 500));
  const [company] = await db.select({ name: organizationsTable.name }).from(organizationsTable).where(eq(organizationsTable.id, org));

  const numbersInFile = new Set<string>();
  for (const job of invoiceRows) {
    const total = job.amountCents!;
    const listed = (list: InvoicePlan["unmatched"], reason: string) => {
      if (list.length < MAX_LISTED) list.push({ row: job.rowNo, jobNumber: job.jobNumber, customer: job.customerName, reason, totalCents: total });
      else plan.listsTruncated = true;
    };
    const externalId = `job:${job.jobId}`;
    if (imported.has(externalId)) { plan.alreadyImported.count++; plan.alreadyImported.totalCents += total; continue; }
    const lead = leads.get(job.jobId);
    if (!lead) { listed(plan.unmatched, "this job is not in GrowthOS yet; import the jobs first (if it was listed as unmatched there, import its customer first)"); continue; }
    if (!job.jobNumber) { listed(plan.unreconciled, "no invoice number"); continue; }
    if (!/^[^\u0000-\u001f\u007f]+$/.test(job.jobNumber)) { listed(plan.unreconciled, "the invoice number has characters we cannot keep"); continue; }
    if (numbersInFile.has(job.jobNumber)) { listed(plan.unreconciled, "the same invoice number appears on more than one job in this file"); continue; }
    numbersInFile.add(job.jobNumber);
    if (usedNumbers.has(job.jobNumber)) { listed(plan.unreconciled, "this invoice number is already used by another GrowthOS invoice; it is never renumbered"); continue; }
    if (job.paidCents === null || job.dueCents === null) { listed(plan.unreconciled, "Paid Amount or Due is blank"); continue; }
    if (job.paidCents + job.dueCents !== total) { listed(plan.unreconciled, `Paid ${dollars(job.paidCents)} + Due ${dollars(job.dueCents)} does not equal the Amount ${dollars(total)} (tips, fees, credits or refunds need to be reconciled by hand)`); continue; }
    if (job.taxCents > total) { listed(plan.unreconciled, "Tax is larger than the Amount"); continue; }
    const issuedAt = job.invoiceSentAt ?? job.completedAt ?? job.scheduledStart ?? job.createdAt;
    if (!issuedAt) { listed(plan.unreconciled, "no invoice, finished or job date"); continue; }
    if (issuedAt > cutoff) { listed(plan.unreconciled, "the invoice date is after the export date"); continue; }
    const paidInFull = job.dueCents === 0;
    const notes = [
      `Imported from Housecall Pro job ${job.jobNumber}.`,
      !paidInFull && job.paidCents > 0 ? `${dollars(job.paidCents)} was paid in Housecall Pro before the move; only the open balance of ${dollars(job.dueCents)} is carried over.` : null,
      job.lineItems ? `Original line items: ${job.lineItems}` : null,
    ].filter(Boolean).join(" ").slice(0, 2000);
    const invoice: FinancialSource["invoices"][number] = {
      externalId, invoiceNumber: job.jobNumber, leadId: lead.id, issuedAt: issuedAt.toISOString(),
      basis: paidInFull ? "full_history" : "opening_receivable", balanceAtCutoffCents: job.dueCents,
      document: {
        title: `Invoice ${job.jobNumber}`.slice(0, 150), currency: "USD", issuerName: (company?.name ?? "Contractor").slice(0, 200), issuerAddress: null,
        customerName: (contacts.get(lead.contactId) || job.customerName).slice(0, 200),
        customerAddress: lead.propertyId ? propertyLabels.get(lead.propertyId) ?? null : null, dueDate: null, notes,
        // One summary line carries the exact pre-tax amount; the original lines are kept in the notes.
        lineItems: [{ description: `Housecall Pro job ${job.jobNumber}${job.description ? `: ${job.description}` : ""}`.slice(0, 1000), quantity: "1", unitPriceCents: total - job.taxCents, totalCents: total - job.taxCents }],
        subtotalCents: total - job.taxCents, taxCents: job.taxCents, totalCents: total,
      },
    };
    let receipt: PlannedInvoice["receipt"] = null, estimatedPaymentDate = false;
    if (paidInFull) {
      const evidenced = paymentDate(job.paymentHistory, input.timeZone, cutoff);
      estimatedPaymentDate = evidenced === null;
      const occurredAt = evidenced ?? (job.completedAt && job.completedAt <= cutoff ? job.completedAt : issuedAt);
      receipt = {
        externalId: `payment:${job.jobId}`, leadId: lead.id, kind: "payment", amountCents: total, occurredAt: occurredAt.toISOString(),
        evidence: [`Housecall Pro jobs export: Paid Amount ${dollars(total)} on invoice ${job.jobNumber}.`,
          estimatedPaymentDate ? "Payment date not in the export; the job's finished date was used." : null,
          job.paymentHistory ? `Payment History: ${job.paymentHistory}` : null].filter(Boolean).join(" ").slice(0, 500),
        allocations: [{ externalInvoiceId: externalId, amountCents: total }],
      };
    }
    // Validate each invoice alone with the strict loader rules before grouping.
    const check = normalizeFinancialSource(JSON.stringify(sourceFor([{ invoice, receipt }], cutoff)), now);
    if (!check.ok) { listed(plan.unreconciled, `does not meet the financial import rules: ${check.issues[0]?.message ?? "invalid"}`); continue; }
    plan.planned.push({ job, leadId: lead.id, invoice, receipt, estimatedPaymentDate });
    plan.ready.count++; plan.ready.totalCents += total;
    if (paidInFull) { plan.ready.paidInFull++; plan.ready.paymentCents += total; if (estimatedPaymentDate) plan.ready.estimatedPaymentDates++; }
    else { plan.ready.openBalances++; plan.ready.openingReceivableCents += job.dueCents; }
  }
  return plan;
}

function sourceFor(rows: { invoice: FinancialSource["invoices"][number]; receipt: FinancialSource["receipts"][number] | null }[], cutoff: Date): FinancialSource {
  const invoices = rows.map((r) => r.invoice), receipts = rows.flatMap((r) => (r.receipt ? [r.receipt] : []));
  return {
    format: "growthos-financial-migration", version: 1, ...HCP_FINANCIAL_SOURCE, cutoffAt: cutoff.toISOString(), invoices, receipts,
    controlTotals: {
      invoiceCount: invoices.length,
      documentTotalCents: invoices.reduce((n, i) => n + i.document.totalCents, 0),
      openingReceivableCents: invoices.reduce((n, i) => n + (i.basis === "opening_receivable" ? i.balanceAtCutoffCents : 0), 0),
      balanceDueCents: invoices.reduce((n, i) => n + i.balanceAtCutoffCents, 0),
      paymentCents: receipts.reduce((n, r) => n + r.amountCents, 0),
      refundCents: 0,
    },
  };
}

const serializePlan = (plan: InvoicePlan) => {
  const { planned: _planned, ...rest } = plan;
  return rest;
};

/** Plans the file and opens one loader review per group of 50 invoices. No financial records are created. */
export async function previewHousecallInvoices(org: string, actor: string, raw: unknown, now = new Date()) {
  const plan = await planHousecallInvoices(org, raw, now);
  const sorted = [...plan.planned].sort((a, b) => a.invoice.externalId.localeCompare(b.invoice.externalId));
  const reviews: { id: string; digest: string; invoiceCount: number; documentTotalCents: number; expiresAt: string }[] = [];
  for (let i = 0; i < sorted.length; i += INVOICES_PER_REVIEW) {
    const source = sourceFor(sorted.slice(i, i + INVOICES_PER_REVIEW), new Date(plan.cutoffAt));
    const preview = await previewFinancialMigration(org, actor, { sourceJson: JSON.stringify(source) });
    if (!preview.valid)
      throw new HousecallImportError(409, "hcp_invoice_review_failed", `The financial loader refused part of this file (${preview.issues[0]?.message ?? "invalid"}). Nothing was imported; preview again.`);
    reviews.push({ id: preview.review.id, digest: preview.review.digest, invoiceCount: source.invoices.length, documentTotalCents: source.controlTotals.documentTotalCents, expiresAt: preview.review.expiresAt });
  }
  return { ...serializePlan(plan), reviews };
}

/** Commits the reviewed groups in order through the strict loader. Each group is atomic; a re-run never duplicates. */
export async function commitHousecallInvoices(org: string, actor: string, raw: unknown) {
  const input = invoicesCommitSchema.parse(raw);
  const batchId = randomUUID();
  const committed: { id: string; importedInvoices: number; importedReceipts: number; duplicateInvoices: number; documentTotalCents: number; openingReceivableCents: number; paymentCents: number }[] = [];
  let failure: { id: string; code: string; message: string } | null = null;
  for (const review of input.reviews) {
    try {
      const view = await commitFinancialMigration(org, actor, review.id, { expectedDigest: review.digest, confirmed: true, sourceFrozen: true });
      if (view.source.sourceSystem !== HCP_FINANCIAL_SOURCE.sourceSystem) throw new HousecallImportError(409, "hcp_review_not_housecall", "This review is not a Housecall Pro import.");
      const result = view.result as { importedInvoices: number; importedReceipts: number; duplicateInvoices: number } | null;
      committed.push({
        id: view.id, importedInvoices: result?.importedInvoices ?? 0, importedReceipts: result?.importedReceipts ?? 0, duplicateInvoices: result?.duplicateInvoices ?? 0,
        documentTotalCents: view.source.controlTotals.documentTotalCents, openingReceivableCents: view.source.controlTotals.openingReceivableCents, paymentCents: view.source.controlTotals.paymentCents,
      });
    } catch (error) {
      if (error instanceof FinancialMigrationError || error instanceof HousecallImportError) { failure = { id: review.id, code: error.code, message: error.message }; break; }
      throw error;
    }
  }
  const totals = committed.reduce((t, c) => ({
    reviews: t.reviews + 1, invoices: t.invoices + c.importedInvoices + c.duplicateInvoices, receipts: t.receipts + c.importedReceipts,
    documentTotalCents: t.documentTotalCents + c.documentTotalCents, openingReceivableCents: t.openingReceivableCents + c.openingReceivableCents, paymentCents: t.paymentCents + c.paymentCents,
  }), { reviews: 0, invoices: 0, receipts: 0, documentTotalCents: 0, openingReceivableCents: 0, paymentCents: 0 });
  if (committed.length)
    await recordAudit({
      organizationId: org, actorUserId: actor, action: "housecall.invoices_imported", entityType: "housecall_import", entityId: batchId,
      metadata: { source: "housecall_pro", ...HCP_FINANCIAL_SOURCE, reviewIds: committed.map((c) => c.id), ...totals, failedReviewId: failure?.id ?? null, providerEffect: false, customerContact: false },
    });
  return { batchId: committed.length ? batchId : null, committed, totals, failure, remaining: input.reviews.length - committed.length };
}
