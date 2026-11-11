import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  activitiesTable,
  appointmentsTable,
  estimatesTable,
  auditEventsTable,
  contactsTable,
  db,
  invoicesTable,
  leadsTable,
  leadTagsTable,
  organizationsTable,
  propertiesTable,
  scheduledActionsTable,
  usersTable,
} from "@workspace/db";
import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";
import {
  HCP_CUSTOMERS_HEADER, csv, hcpEstimatesCsv, hcpEstimatesMapping, hcpJobsCsv, hcpJobsMapping, type HcpEstimateRow, type HcpJobRow,
} from "../test-helpers/housecall-fixtures";
import { buildRevenueRecoveryBriefing } from "./bie";
import { importLeads } from "./reactivation";
import { getInvoice } from "./invoices";
import { listLeads } from "./crm";
import { getCustomerWorkspaceSection } from "./customer-workspace";
import {
  HCP_ESTIMATE_ACTIVITY,
  HCP_JOB_ACTIVITY,
  classifyHcpEstimateStatus,
  classifyHcpStatus,
  commitHousecallInvoices,
  exportCutoff,
  importHousecallEstimates,
  importHousecallJobs,
  parseHcpDate,
  parseHcpMoney,
  previewHousecallInvoices,
} from "./housecall-import";

const TZ = "America/New_York";
const orgs: string[] = [];
async function company(name: string) {
  const [org] = await db.insert(organizationsTable).values({ name, slug: `hcp-${randomUUID()}` }).returning();
  orgs.push(org!.id);
  const [owner] = await db.insert(usersTable).values({ organizationId: org!.id, role: "owner", isActive: true, emailVerifiedAt: new Date() }).returning();
  return { org: org!.id, actor: owner!.id };
}
afterAll(async () => { await deleteTestOrgs(...orgs); });

// Synthetic customers export in the published 24-column layout.
const customersCsv = (tag: string) => csv(HCP_CUSTOMERS_HEADER, [
  ["Avery", "Stone", "(470) 555-0101", `avery-${tag}@example.invalid`, "", "", "", "VIP, Pool", "Gate code at office", `cus_a_${tag}`,
    "12 Lake Rd", "", "Dawsonville", "GA", "30534", "false", "", "40 Ridge Way", "Unit 2", "Cumming", "GA", "30040", "false", ""],
  ["Blake", "Rivers", "(470) 555-0102", `blake-${tag}@example.invalid`, "", "", "", "", "", `cus_b_${tag}`,
    "7 Oak St", "", "Gainesville", "GA", "30501", "true", "", "", "", "", "", "", "", ""],
  ["Casey", "Moss", "", `casey-${tag}@example.invalid`, "", "", "", "", "", `cus_c_${tag}`,
    "9 Pine Ct", "", "", "GA", "", "", "", "", "", "", "", "", "", ""],
]);
const customerMapping = {
  firstName: 0, lastName: 1, phone: 2, email: 3, tags: 7, notes: 8, externalCustomerId: 9,
  addressLine1: 10, addressLine2: 11, city: 12, state: 13, postalCode: 14,
  address2Line1: 17, address2Line2: 18, address2City: 19, address2State: 20, address2PostalCode: 21,
};
const importCustomers = (org: string, actor: string, tag: string, dryRun = false) => importLeads(org, {
  csv: customersCsv(tag), mapping: customerMapping, mode: "customers", sourceKey: "housecall-pro", fileName: "customers.csv", createdByUserId: actor, dryRun,
});

function jobs(tag: string): HcpJobRow[] {
  const base = (n: string, email: string, extra: HcpJobRow): HcpJobRow => ({
    "Invoice": n, "HCP Id": `job_${n}_${tag}`, "Email": email, "Customer": "Synthetic", "Created At": "2026-03-01 08:00", ...extra,
  });
  return [
    // Paid in full, with a dated payment history.
    base("1001", `avery-${tag}@example.invalid`, { "Date": "2026-03-05 9:00 AM", "Finished": "2026-03-05 1:30 PM", "Job Status": "complete rated",
      "Street": "12 Lake Rd", "City": "Dawsonville", "State": "GA", "Zip": "30534", "Description": "Pool opening", "Line Items": "Opening service x1",
      "Amount": "$1,070.00", "Tax": "70.00", "Paid Amount": "1,070.00", "Due": "0.00", "Payment History": "03/06/2026 card $1,070.00",
      "Employee": "Jordan Tech, Sam Helper", "Job Tags": "Opening", "Customer Tags": "VIP", "Invoice Sent": "2026-03-05 2:00 PM" }),
    // Partially paid: only the exact open balance carries over.
    base("1002", `avery-${tag}@example.invalid`, { "Date": "2026-04-10", "Finished": "2026-04-10 4:00 PM", "Job Status": "complete unrated",
      "Street": "40 Ridge Way", "City": "Cumming", "State": "GA", "Zip": "30040", "Description": "Heater repair",
      "Amount": "500.00", "Paid Amount": "200.00", "Due": "300.00", "Employee": "Jordan Tech" }),
    // Unpaid, matched by phone, no address in the row (uses the customer's only property).
    base("1003", "", { "Mobile Phone": "470-555-0102", "Date": "2026-05-01", "Finished": "2026-05-01 11:00 AM", "Job Status": "Completed",
      "Amount": "250.00", "Paid Amount": "0", "Due": "250.00" }),
    // Upcoming visit with an address: becomes a calendar appointment.
    base("1004", `blake-${tag}@example.invalid`, { "Date": "2030-03-02 9:00 AM", "End Time": "2030-03-02 11:00 AM", "Job Status": "scheduled",
      "Street": "7 Oak St", "City": "Gainesville", "State": "GA", "Zip": "30501", "Description": "Spring check", "Amount": "180.00", "Employee": "Sam Helper" }),
    // Needs scheduling: history with a staff flag.
    base("1005", `casey-${tag}@example.invalid`, { "Job Status": "unscheduled", "Description": "Quote follow-up" }),
    // Canceled: history only, no invoice.
    base("1006", `casey-${tag}@example.invalid`, { "Date": "2026-02-01", "Job Status": "Pro canceled", "Amount": "90.00" }),
    // No such customer in GrowthOS.
    base("1007", `stranger-${tag}@example.invalid`, { "Date": "2026-06-01", "Finished": "2026-06-01 3:00 PM", "Job Status": "complete rated", "Amount": "75.00", "Paid Amount": "75.00", "Due": "0" }),
    // Tip makes Paid + Due differ from Amount: not reconciled automatically.
    base("1008", `blake-${tag}@example.invalid`, { "Date": "2026-06-02", "Finished": "2026-06-02 3:00 PM", "Job Status": "complete rated", "Amount": "100.00", "Paid Amount": "110.00", "Due": "0", "Tip Amount": "10.00" }),
  ];
}
const jobsRequest = (tag: string, dryRun: boolean, rows = jobs(tag)) => ({
  csv: hcpJobsCsv(rows), fileName: "jobs.csv", mapping: hcpJobsMapping(), exportedOn: "2026-10-31", timeZone: TZ, dryRun,
});
const invoiceRequest = (tag: string, rows = jobs(tag)) => {
  const { dryRun: _dryRun, ...rest } = jobsRequest(tag, false, rows);
  return rest;
};

describe("Housecall Pro value parsing", () => {
  it("reads export dates in the company time zone and refuses ambiguous values", () => {
    expect(parseHcpDate("2026-03-05 1:30 PM", TZ)!.toISOString()).toBe("2026-03-05T18:30:00.000Z");
    expect(parseHcpDate("07/04/2026 9:00 AM", TZ)!.toISOString()).toBe("2026-07-04T13:00:00.000Z");
    expect(parseHcpDate("Mar 5, 2026", TZ)!.toISOString()).toBe("2026-03-05T05:00:00.000Z");
    expect(parseHcpDate("2026-03-05T10:00:00Z", TZ)!.toISOString()).toBe("2026-03-05T10:00:00.000Z");
    expect(parseHcpDate("", TZ)).toBeNull();
    expect(() => parseHcpDate("02/30/2026", TZ)).toThrow();
    expect(() => parseHcpDate("next Tuesday", TZ)).toThrow();
    expect(parseHcpMoney("$1,234.50")).toBe(123450);
    expect(() => parseHcpMoney("-5.00")).toThrow();
    expect(classifyHcpStatus("complete unrated", null).kind).toBe("completed");
    expect(classifyHcpStatus("Pro canceled", null).kind).toBe("canceled");
    expect(classifyHcpStatus("weird", null)).toEqual({ kind: "unscheduled", recognized: false });
    expect(() => exportCutoff("2999-01-01", TZ)).toThrow(/future/);
  });
});

describe("Move from Housecall Pro", () => {
  let a: { org: string; actor: string }, b: { org: string; actor: string };
  const tag = randomUUID().slice(0, 8);
  beforeAll(async () => {
    a = await company("Synthetic Pools A");
    b = await company("Synthetic Pools B");
  });

  it("imports customers with service-address properties, tags/lead source/notes, and dedupes on re-run", async () => {
    // An existing customer with the same email is enriched, not duplicated.
    const [existing] = await db.insert(contactsTable).values({ organizationId: a.org, firstName: "Avery", lastName: "Stone", email: `avery-${tag}@example.invalid` }).returning();
    const preview = await importCustomers(a.org, a.actor, tag, true);
    expect(preview).toMatchObject({ dryRun: true, imported: 2, duplicates: 1, propertiesCreated: 3, notesRecorded: 1 });
    expect(await db.select().from(propertiesTable).where(eq(propertiesTable.organizationId, a.org))).toHaveLength(0);
    const saved = await importCustomers(a.org, a.actor, tag);
    expect(saved).toMatchObject({ imported: 2, duplicates: 1, propertiesCreated: 3, notesRecorded: 1 });
    expect((saved as { errors: string[] }).errors.join(" ")).toMatch(/service address 1 is missing street, city, state or ZIP/);
    const contacts = await db.select().from(contactsTable).where(eq(contactsTable.organizationId, a.org));
    expect(contacts).toHaveLength(3);
    const avery = await db.select().from(propertiesTable).where(and(eq(propertiesTable.organizationId, a.org), eq(propertiesTable.contactId, existing!.id)));
    expect(avery.map((p) => p.addressLine1).sort()).toEqual(["12 Lake Rd", "40 Ridge Way"]);
    const [note] = await db.select().from(activitiesTable).where(and(eq(activitiesTable.organizationId, a.org), eq(activitiesTable.contactId, existing!.id), eq(activitiesTable.type, "note")));
    expect(note!.body).toContain("Tags: VIP, Pool");
    expect(note!.body).toContain("Notes: Gate code at office");
    expect(note!.metadata).toMatchObject({ sourceKey: "housecall-pro", externalCustomerId: `cus_a_${tag}`, tags: ["VIP", "Pool"] });
    // Same file again: nothing new anywhere.
    expect(await importCustomers(a.org, a.actor, tag)).toMatchObject({ imported: 0, duplicates: 3, propertiesCreated: 0, notesRecorded: 0 });
    expect(await db.select().from(propertiesTable).where(eq(propertiesTable.organizationId, a.org))).toHaveLength(3);
    expect(await db.select().from(leadsTable).where(eq(leadsTable.organizationId, a.org))).toHaveLength(0);
  });

  it("previews jobs without saving, then imports read-only history, clean visits and flags", async () => {
    const preview = await importHousecallJobs(a.org, a.actor, jobsRequest(tag, true));
    expect(preview).toMatchObject({ dryRun: true, batchId: null, totalRows: 8, newJobs: 7, appointmentsCreated: 1, needsScheduling: 1, completed: 4, canceled: 1, upcoming: 2 });
    expect(preview.unmatched).toEqual([expect.objectContaining({ row: 8, jobNumber: "1007", reason: expect.stringMatching(/no GrowthOS customer/) })]);
    expect(await db.select().from(leadsTable).where(eq(leadsTable.organizationId, a.org))).toHaveLength(0);

    const saved = await importHousecallJobs(a.org, a.actor, jobsRequest(tag, false));
    expect(saved).toMatchObject({ dryRun: false, newJobs: 7, appointmentsCreated: 1, needsScheduling: 1, propertiesCreated: 0 });
    expect(saved.batchId).toMatch(/^[0-9a-f-]{36}$/);
    const leads = await db.select().from(leadsTable).where(eq(leadsTable.organizationId, a.org));
    expect(leads).toHaveLength(7);
    const byJob = new Map(leads.map((l) => [l.externalOpportunityId, l]));
    expect(byJob.get(`job_1001_${tag}`)).toMatchObject({ status: "completed", creationMethod: "import", importSourceKey: "housecall-pro", estimatedValueCents: 107000 });
    expect(byJob.get(`job_1004_${tag}`)!.status).toBe("production_scheduled");
    expect(byJob.get(`job_1006_${tag}`)!.status).toBe("lost");
    // Job 1001 links to the matching service address; 1003 (no address) to Blake's only property.
    const [lake] = await db.select().from(propertiesTable).where(and(eq(propertiesTable.organizationId, a.org), eq(propertiesTable.addressLine1, "12 Lake Rd")));
    expect(byJob.get(`job_1001_${tag}`)!.propertyId).toBe(lake!.id);
    expect(byJob.get(`job_1003_${tag}`)!.propertyId).not.toBeNull();
    const [history] = await db.select().from(activitiesTable).where(and(eq(activitiesTable.organizationId, a.org), eq(activitiesTable.leadId, byJob.get(`job_1001_${tag}`)!.id), eq(activitiesTable.type, HCP_JOB_ACTIVITY)));
    expect(history!.metadata).toMatchObject({ source: "housecall_pro", batchId: saved.batchId, jobNumber: "1001", employees: ["Jordan Tech", "Sam Helper"], totalCents: 107000, completedAt: "2026-03-05T18:30:00.000Z", readOnly: true });
    expect(history!.occurredAt.toISOString()).toBe("2026-03-05T18:30:00.000Z");
    const [flagged] = await db.select().from(activitiesTable).where(and(eq(activitiesTable.organizationId, a.org), eq(activitiesTable.leadId, byJob.get(`job_1005_${tag}`)!.id)));
    expect(flagged!.metadata).toMatchObject({ staffFollowUp: "Needs scheduling in GrowthOS." });
    const appointments = await db.select().from(appointmentsTable).where(eq(appointmentsTable.organizationId, a.org));
    expect(appointments).toEqual([expect.objectContaining({ leadId: byJob.get(`job_1004_${tag}`)!.id, status: "scheduled", scheduledStart: new Date("2030-03-02T14:00:00.000Z") })]);
    expect(appointments[0]!.notes).toContain("Sam Helper");
    expect(await db.select().from(leadTagsTable).where(eq(leadTagsTable.leadId, byJob.get(`job_1001_${tag}`)!.id))).toHaveLength(2);
    // Nothing is queued for a customer: no reminder or other scheduled action.
    expect(await db.select().from(scheduledActionsTable).where(eq(scheduledActionsTable.organizationId, a.org))).toHaveLength(0);
    const [audit] = await db.select().from(auditEventsTable).where(and(eq(auditEventsTable.organizationId, a.org), eq(auditEventsTable.action, "housecall.jobs_imported")));
    expect(audit!.metadata).toMatchObject({ source: "housecall_pro", newJobs: 7, customerContact: false });

    // Re-running the same file changes nothing.
    const again = await importHousecallJobs(a.org, a.actor, jobsRequest(tag, false));
    expect(again).toMatchObject({ newJobs: 0, updatedJobs: 0, alreadyImported: 7, appointmentsCreated: 0 });
    expect(await db.select().from(leadsTable).where(eq(leadsTable.organizationId, a.org))).toHaveLength(7);
    expect(await db.select().from(appointmentsTable).where(eq(appointmentsTable.organizationId, a.org))).toHaveLength(1);
  });

  it("keeps imported history out of the default pipeline but on the customer timeline", async () => {
    const [native] = await db.insert(leadsTable).values({ organizationId: a.org, contactId: (await db.select().from(contactsTable).where(eq(contactsTable.organizationId, a.org)))[0]!.id, status: "completed" }).returning();
    const ids = (rows: { id: string }[]) => rows.map((r) => r.id);
    const hcp = (await db.select().from(leadsTable).where(and(eq(leadsTable.organizationId, a.org), eq(leadsTable.importSourceKey, "housecall-pro"))));
    const history = hcp.filter((l) => l.status === "completed" || l.status === "lost").map((l) => l.id).sort();
    expect(history).toHaveLength(5);
    const shown = ids(await listLeads(a.org));
    expect(shown).toContain(native!.id);
    expect(shown.filter((id) => history.includes(id))).toEqual([]);
    expect(shown).toEqual(expect.arrayContaining(hcp.filter((l) => !history.includes(l.id)).map((l) => l.id)));
    expect(ids(await listLeads(a.org, { importedHistory: "only" })).sort()).toEqual(history);
    expect(ids(await listLeads(a.org, { importedHistory: "include" }))).toEqual(expect.arrayContaining([...history, native!.id]));
    await db.delete(leadsTable).where(eq(leadsTable.id, native!.id));
    const done = hcp.find((l) => l.externalOpportunityId === `job_1001_${tag}`)!;
    const timeline = await getCustomerWorkspaceSection(a.org, a.actor, done.contactId, { section: "activity" });
    expect(timeline.items).toEqual(expect.arrayContaining([expect.objectContaining({ leadId: done.id, label: "Housecall Pro job imported" })]));
  });

  it("refuses missing columns and lists bad rows instead of guessing", async () => {
    const { jobId: _drop, ...noId } = hcpJobsMapping();
    await expect(importHousecallJobs(a.org, a.actor, { ...jobsRequest(tag, true), mapping: noId })).rejects.toMatchObject({ code: "hcp_mapping_invalid" });
    const rows = [{ "Invoice": "2001", "HCP Id": `job_2001_${tag}`, "Email": `avery-${tag}@example.invalid`, "Finished": "sometime soon", "Job Status": "complete" }];
    const bad = await importHousecallJobs(a.org, a.actor, jobsRequest(tag, true, rows));
    expect(bad.problems).toEqual([expect.objectContaining({ row: 2, reason: expect.stringMatching(/Finished date is not a date/) })]);
    expect(bad.newJobs).toBe(0);
    await expect(importHousecallJobs(a.org, a.actor, { ...jobsRequest(tag, true), csv: "HCP Id,Email\n" })).rejects.toMatchObject({ code: "hcp_csv_empty" });
  });

  it("reconciles invoices and open balances through the strict loader, then re-runs idempotently", async () => {
    const preview = await previewHousecallInvoices(a.org, a.actor, invoiceRequest(tag));
    // Jobs 1001,1002,1003 import; 1007 unmatched; 1008 unreconciled. 1004/1005/1006 are not invoices.
    expect(preview.file).toEqual({ count: 5, totalCents: 107000 + 50000 + 25000 + 7500 + 10000 });
    expect(preview.ready).toMatchObject({ count: 3, totalCents: 182000, paidInFull: 1, paymentCents: 107000, openBalances: 2, openingReceivableCents: 55000, estimatedPaymentDates: 0 });
    expect(preview.notInvoiced).toBe(3);
    expect(preview.unmatched).toEqual([expect.objectContaining({ jobNumber: "1007", totalCents: 7500 })]);
    expect(preview.unreconciled).toEqual([expect.objectContaining({ jobNumber: "1008", reason: expect.stringMatching(/does not equal the Amount/) })]);
    const listed = preview.ready.totalCents + preview.alreadyImported.totalCents + [...preview.unmatched, ...preview.unreconciled].reduce((n, r) => n + (r.totalCents ?? 0), 0);
    expect(listed).toBe(preview.file.totalCents);
    expect(preview.reviews).toHaveLength(1);
    expect(await db.select().from(invoicesTable).where(eq(invoicesTable.organizationId, a.org))).toHaveLength(0);

    const result = await commitHousecallInvoices(a.org, a.actor, { reviews: preview.reviews.map(({ id, digest }) => ({ id, digest })), confirmed: true, sourceFrozen: true });
    expect(result.failure).toBeNull();
    expect(result.totals).toMatchObject({ invoices: 3, receipts: 1, documentTotalCents: 182000, openingReceivableCents: 55000, paymentCents: 107000 });
    const invoices = await db.select().from(invoicesTable).where(eq(invoicesTable.organizationId, a.org));
    expect(invoices.map((i) => i.invoiceNumber).sort()).toEqual(["1001", "1002", "1003"]);
    const partial = invoices.find((i) => i.invoiceNumber === "1002")!;
    expect(partial).toMatchObject({ status: "issued", balanceBasis: "opening_receivable", openingReceivableCents: 30000 });
    expect(partial.historicalSource).toMatchObject({ sourceSystem: "housecall_pro", externalId: `job:job_1002_${tag}` });
    const paid = invoices.find((i) => i.invoiceNumber === "1001")!;
    expect(paid.issuedAt!.toISOString()).toBe("2026-03-05T19:00:00.000Z");
    const paidDetail = await getInvoice(a.org, a.actor, paid.id);
    expect(paidDetail).toMatchObject({ recordedBalanceCents: 0 });
    expect(await getInvoice(a.org, a.actor, partial.id)).toMatchObject({ recordedBalanceCents: 30000 });

    // Same file again: everything is already imported, nothing new to review.
    const again = await previewHousecallInvoices(a.org, a.actor, invoiceRequest(tag));
    expect(again.alreadyImported).toEqual({ count: 3, totalCents: 182000 });
    expect(again.reviews).toHaveLength(0);
    // Committing the old reviews again is a no-op.
    const repeat = await commitHousecallInvoices(a.org, a.actor, { reviews: preview.reviews.map(({ id, digest }) => ({ id, digest })), confirmed: true, sourceFrozen: true });
    expect(repeat.committed[0]).toMatchObject({ importedInvoices: 3 });
    expect(await db.select().from(invoicesTable).where(eq(invoicesTable.organizationId, a.org))).toHaveLength(3);
  });

  it("keeps companies apart: another company's customers and jobs are never matched", async () => {
    const jobsB = await importHousecallJobs(b.org, b.actor, jobsRequest(tag, true));
    expect(jobsB.newJobs).toBe(0);
    expect(jobsB.unmatched).toHaveLength(8);
    const invoicesB = await previewHousecallInvoices(b.org, b.actor, invoiceRequest(tag));
    expect(invoicesB.ready.count).toBe(0);
    expect(invoicesB.unmatched).toHaveLength(5);
    expect(invoicesB.unreconciled).toHaveLength(0);
    expect(invoicesB.reviews).toHaveLength(0);
    // Another company's review cannot be committed from here.
    const [foreign] = await db.select().from(auditEventsTable).where(and(eq(auditEventsTable.organizationId, a.org), eq(auditEventsTable.action, "financial_migration.previewed")));
    const out = await commitHousecallInvoices(b.org, b.actor, { reviews: [{ id: foreign!.entityId!, digest: "0".repeat(64) }], confirmed: true, sourceFrozen: true });
    expect(out.failure).toMatchObject({ code: "financial_review_unavailable" });
    expect(await db.select().from(invoicesTable).where(eq(invoicesTable.organizationId, b.org))).toHaveLength(0);
  });

  it("updates a job that moved forward in Housecall Pro, unless staff edited it in GrowthOS", async () => {
    const rows = jobs(tag).map((r) => (r["Invoice"] === "1005" ? { ...r, "Job Status": "complete rated", "Date": "2026-07-01", "Finished": "2026-07-01 2:00 PM" } : r));
    const updated = await importHousecallJobs(a.org, a.actor, jobsRequest(tag, false, rows));
    expect(updated).toMatchObject({ updatedJobs: 1, alreadyImported: 6, newJobs: 0 });
    const [lead] = await db.select().from(leadsTable).where(and(eq(leadsTable.organizationId, a.org), eq(leadsTable.externalOpportunityId, `job_1005_${tag}`)));
    expect(lead!.status).toBe("completed");
    await db.update(leadsTable).set({ summary: "Edited by staff" }).where(eq(leadsTable.id, lead!.id));
    const edited = rows.map((r) => (r["Invoice"] === "1005" ? { ...r, "Description": "Changed again" } : r));
    const kept = await importHousecallJobs(a.org, a.actor, jobsRequest(tag, false, edited));
    expect(kept.updatedJobs).toBe(0);
    expect(kept.problems).toEqual([expect.objectContaining({ jobNumber: "1005", reason: expect.stringMatching(/edited in GrowthOS/) })]);
    expect((await db.select().from(leadsTable).where(eq(leadsTable.id, lead!.id)))[0]!.summary).toBe("Edited by staff");
  });
});

describe("Housecall Pro estimates", () => {
  let a: { org: string; actor: string }, b: { org: string; actor: string };
  const tag = randomUUID().slice(0, 8);
  const row = (n: string, email: string, extra: HcpEstimateRow = {}): HcpEstimateRow => ({
    "Invoice": n, "HCP Id": `est_${n}_${tag}`, "Created At": "2026-09-01 10:00", "Customer": "Synthetic", "Email": email, ...extra,
  });
  const request = (rows: HcpEstimateRow[], dryRun: boolean, extra = false, more: Record<string, unknown> = {}) => ({
    csv: hcpEstimatesCsv(rows, extra), fileName: "estimates.csv", mapping: hcpEstimatesMapping(extra), exportedOn: "2026-10-31", timeZone: TZ, dryRun, ...more,
  });
  const now = new Date("2026-11-11T15:00:00Z");
  beforeAll(async () => {
    a = await company("Synthetic Estimates A");
    b = await company("Synthetic Estimates B");
    await importCustomers(a.org, a.actor, tag);
  });

  it("recognizes estimate decisions and never guesses an unknown status", () => {
    expect(classifyHcpEstimateStatus("Approved")).toBe("approved");
    expect(classifyHcpEstimateStatus("Option declined")).toBe("declined");
    expect(classifyHcpEstimateStatus("Not sent")).toBe("draft");
    expect(classifyHcpEstimateStatus("Awaiting response")).toBe("sent");
    expect(classifyHcpEstimateStatus("Expired")).toBe("closed");
    expect(classifyHcpEstimateStatus("")).toBe("blank");
    expect(classifyHcpEstimateStatus("purple")).toBeNull();
  });

  it("imports the published Open Estimates layout as follow-up-ready estimates, only when staff say they were sent", async () => {
    const rows = [
      row("2001", `avery-${tag}@example.invalid`, { "Street": "12 Lake Rd", "City": "Dawsonville", "State": "GA", "Zip": "30534", "Customer Tag": "VIP" }),
      row("2002", "", { "Mobile Phone": "470-555-0102", "Date": "2030-01-05 9:00 AM", "End Time": "2030-01-05 10:00 AM" }),
      row("2003", `stranger-${tag}@example.invalid`),
    ];
    await expect(importHousecallEstimates(a.org, a.actor, request(rows, true), now)).rejects.toMatchObject({ code: "hcp_mapping_invalid" });
    const preview = await importHousecallEstimates(a.org, a.actor, request(rows, true, false, { openEstimatesAre: "sent" }), now);
    expect(preview).toMatchObject({ dryRun: true, totalRows: 3, openEstimates: 2, sent: 2, visitsToBook: 1, missingAmounts: 2, propertiesCreated: 0 });
    expect(preview.unmatched).toEqual([expect.objectContaining({ jobNumber: "2003" })]);
    expect(await db.select().from(estimatesTable).where(eq(estimatesTable.organizationId, a.org))).toHaveLength(0);
    expect(await db.select().from(activitiesTable).where(and(eq(activitiesTable.organizationId, a.org), eq(activitiesTable.type, HCP_ESTIMATE_ACTIVITY)))).toHaveLength(0);

    const done = await importHousecallEstimates(a.org, a.actor, request(rows, false, false, { openEstimatesAre: "sent" }), now);
    expect(done).toMatchObject({ dryRun: false, openEstimates: 2, sent: 2 });
    const leads = await db.select().from(leadsTable).where(and(eq(leadsTable.organizationId, a.org), eq(leadsTable.importSourceKey, "housecall-pro")));
    expect(leads.map((l) => [l.externalOpportunityId, l.status]).sort()).toEqual([[`estimate:est_2001_${tag}`, "estimate_sent"], [`estimate:est_2002_${tag}`, "estimate_sent"]]);
    const avery = leads.find((l) => l.externalOpportunityId === `estimate:est_2001_${tag}`)!;
    expect(avery.importedHistory).toMatchObject({ externalEstimateId: `est_2001_${tag}`, originalCreatedAt: "2026-09-01T14:00:00.000Z" });
    expect(avery.propertyId).not.toBeNull();
    const estimates = await db.select().from(estimatesTable).where(eq(estimatesTable.organizationId, a.org));
    expect(estimates).toHaveLength(2);
    expect(estimates.every((e) => e.status === "sent" && e.sentAt === null && e.leadId !== null && e.totalCents === 0)).toBe(true);
    // Nothing is queued for a customer; the native saved-state history is kept.
    expect(await db.select().from(scheduledActionsTable).where(eq(scheduledActionsTable.organizationId, a.org))).toHaveLength(0);
    const audits = await db.select().from(auditEventsTable).where(eq(auditEventsTable.organizationId, a.org));
    expect(audits.filter((e) => e.action === "estimate.created")).toHaveLength(2);
    expect(audits.filter((e) => e.action === "estimate.saved_state")).toHaveLength(2);
    expect(audits.filter((e) => e.action === "housecall.estimates_imported")).toHaveLength(1);

    // Linked to the customer, on the timeline, and picked up as follow-up.
    const workspace = await getCustomerWorkspaceSection(a.org, a.actor, avery.contactId!, { section: "estimates" });
    expect(workspace.items).toEqual([expect.objectContaining({ leadId: avery.id, status: "sent", title: "Housecall Pro estimate 2001" })]);
    const timeline = await getCustomerWorkspaceSection(a.org, a.actor, avery.contactId!, { section: "activity" });
    expect(timeline.items).toEqual(expect.arrayContaining([expect.objectContaining({ leadId: avery.id, label: "Housecall Pro estimate imported" })]));
    expect((await listLeads(a.org)).map((l) => l.id)).toContain(avery.id);
    const briefing = await buildRevenueRecoveryBriefing(a.org);
    expect(briefing.opportunities.find((o) => o.kind === "stalled_estimate")?.leadIds).toEqual(expect.arrayContaining(leads.map((l) => l.id)));

    // Re-running the same file changes nothing.
    const again = await importHousecallEstimates(a.org, a.actor, request(rows, false, false, { openEstimatesAre: "sent" }), now);
    expect(again).toMatchObject({ openEstimates: 0, alreadyImported: 2 });
    expect(await db.select().from(estimatesTable).where(eq(estimatesTable.organizationId, a.org))).toHaveLength(2);
  });

  it("keeps decided estimates as history only, drafts as drafts, and lists what it cannot place", async () => {
    const rows = [
      row("3001", `blake-${tag}@example.invalid`, { "Estimate Status": "Approved", "Amount": "1,200.00" }),
      row("3002", `blake-${tag}@example.invalid`, { "Estimate Status": "Declined", "Amount": "300.00" }),
      row("3003", `casey-${tag}@example.invalid`, { "Estimate Status": "Not sent", "Amount": "$535.00", "Tax": "35.00" }),
      row("3004", `casey-${tag}@example.invalid`, { "Estimate Status": "purple" }),
      row("3005", `casey-${tag}@example.invalid`, { "Estimate Status": "Awaiting response", "Amount": "50", "Tax": "60" }),
    ];
    const done = await importHousecallEstimates(a.org, a.actor, request(rows, false, true), now);
    expect(done).toMatchObject({ openEstimates: 1, drafts: 1, decidedHistory: 2, approved: 1, declined: 1 });
    expect(done.problems.map((p) => p.jobNumber).sort()).toEqual(["3004", "3005"]);
    const imported = await db.select().from(leadsTable).where(and(eq(leadsTable.organizationId, a.org), eq(leadsTable.externalOpportunityId, `estimate:est_3003_${tag}`)));
    expect(imported).toEqual([expect.objectContaining({ status: "estimate_preparing", estimatedValueCents: 53500 })]);
    const [draft] = await db.select().from(estimatesTable).where(eq(estimatesTable.leadId, imported[0]!.id));
    expect(draft).toMatchObject({ status: "draft", subtotalCents: 50000, taxCents: 3500, totalCents: 53500, lineItems: [expect.objectContaining({ quantity: 1, unitPriceCents: 50000 })] });
    // Decided estimates: no opportunity and no estimate, just customer history.
    expect(await db.select().from(leadsTable).where(and(eq(leadsTable.organizationId, a.org), inArray(leadsTable.externalOpportunityId, [`estimate:est_3001_${tag}`, `estimate:est_3002_${tag}`])))).toHaveLength(0);
    const history = await db.select().from(activitiesTable).where(and(eq(activitiesTable.organizationId, a.org), eq(activitiesTable.type, HCP_ESTIMATE_ACTIVITY), isNull(activitiesTable.leadId)));
    expect(history.map((h) => h.title).sort()).toEqual(["Housecall Pro estimate 3001 (approved)", "Housecall Pro estimate 3002 (declined)"]);
    const timeline = await getCustomerWorkspaceSection(a.org, a.actor, history[0]!.contactId!, { section: "activity" });
    expect(timeline.items.filter((i) => i.kind === "activity" && i.label === "Housecall Pro estimate imported").length).toBeGreaterThanOrEqual(2);

    // A later export never overwrites what is in GrowthOS.
    const later = await importHousecallEstimates(a.org, a.actor, request([
      row("3001", `blake-${tag}@example.invalid`, { "Estimate Status": "Approved", "Amount": "1,200.00" }),
      row("3003", `casey-${tag}@example.invalid`, { "Estimate Status": "Approved", "Amount": "$535.00", "Tax": "35.00" }),
    ], false, true), now);
    expect(later).toMatchObject({ alreadyImported: 1, changedSinceImport: 1, decidedHistory: 0, openEstimates: 0 });
    expect((await db.select().from(estimatesTable).where(eq(estimatesTable.id, draft!.id)))[0]!.status).toBe("draft");

    // Another company cannot match these customers.
    const other = await importHousecallEstimates(b.org, b.actor, request(rows, false, true), now);
    expect(other).toMatchObject({ openEstimates: 0, decidedHistory: 0 });
    expect(other.unmatched).toHaveLength(3);
    expect(await db.select().from(estimatesTable).where(eq(estimatesTable.organizationId, b.org))).toHaveLength(0);
  });
});
