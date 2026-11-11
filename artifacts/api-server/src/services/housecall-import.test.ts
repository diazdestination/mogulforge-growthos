import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  activitiesTable,
  appointmentsTable,
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
import { HCP_CUSTOMERS_HEADER, csv, hcpJobsCsv, hcpJobsMapping, type HcpJobRow } from "../test-helpers/housecall-fixtures";
import { importLeads } from "./reactivation";
import { getInvoice } from "./invoices";
import {
  HCP_JOB_ACTIVITY,
  classifyHcpStatus,
  commitHousecallInvoices,
  exportCutoff,
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
