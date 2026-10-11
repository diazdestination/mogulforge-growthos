/**
 * DB-backed SCOUT/INVO tests. All records are synthetic; the two invoices are
 * shaped like owner-supplied HVAC and roofing examples without their data.
 */
import { randomUUID } from "node:crypto";

import {
  auditEventsTable,
  bieActionProposalsTable,
  bieAgentRunsTable,
  contactsTable,
  crmTasksTable,
  db,
  estimatesTable,
  leadsTable,
  organizationsTable,
  usersTable,
} from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { deleteTestOrgs } from "../../test-helpers/delete-test-orgs";
import { executeBieProposal, listBieProposals, reviewBieProposal } from "../bie";
import { createInvoice, issueInvoice } from "../invoices";
import { listSpecialistProposals, runSpecialist, SpecialistAccessError } from "./index";

const orgs: string[] = [];
async function fixture(name: string) {
  const [org] = await db.insert(organizationsTable).values({ name, slug: `specialists-${randomUUID()}` }).returning();
  orgs.push(org.id);
  const [owner] = await db.insert(usersTable).values({ organizationId: org.id, role: "owner", isActive: true, emailVerifiedAt: new Date() }).returning();
  const [rep] = await db.insert(usersTable).values({ organizationId: org.id, role: "sales_rep", isActive: true, emailVerifiedAt: new Date() }).returning();
  return { org: org.id, owner: owner.id, rep: rep.id };
}
async function lead(org: string, status: string, email: string | null, createdDaysAgo = 0) {
  const [contact] = await db.insert(contactsTable).values({ organizationId: org, firstName: "Synthetic", lastName: "Customer", email }).returning();
  const [row] = await db.insert(leadsTable).values({ organizationId: org, contactId: contact.id, status: status as never, source: "native_qa" }).returning();
  if (createdDaysAgo) await db.update(leadsTable).set({ createdAt: new Date(Date.now() - createdDaysAgo * 86_400_000) }).where(eq(leadsTable.id, row.id));
  return row;
}
const proposalsFor = (org: string) => db.select().from(bieActionProposalsTable).where(eq(bieActionProposalsTable.organizationId, org));

let a: Awaited<ReturnType<typeof fixture>>;
let b: Awaited<ReturnType<typeof fixture>>;
beforeAll(async () => {
  a = await fixture("Synthetic HVAC specialists");
  b = await fixture("Synthetic roofing specialists");
});
afterAll(async () => {
  await deleteTestOrgs(...orgs);
});

describe("SCOUT (proposal-only)", () => {
  it("proposes reminder 1 for an unanswered estimate, follow-ups for a quiet lead, and never duplicates on re-run", async () => {
    const estimateLead = await lead(a.org, "estimate_sent", `scout-${randomUUID()}@example.test`);
    await db.insert(estimatesTable).values({ organizationId: a.org, leadId: estimateLead.id, title: "Synthetic AC replacement", status: "sent",
      sentAt: new Date(Date.now() - 30 * 3_600_000), totalCents: 900_000, subtotalCents: 900_000, taxCents: 0 });
    const quiet = await lead(a.org, "new", null, 10);

    const first = await runSpecialist(a.org, "scout", a.owner);
    expect(first.specialist).toBe("SCOUT");
    const mine = first.proposals.filter((p) => [estimateLead.id, quiet.id].includes(p.leadId));
    expect(mine.map((p) => `${p.leadId === quiet.id ? "quiet" : "estimate"}:${p.actionType}`).sort())
      .toEqual(["estimate:send_email", "quiet:change_stage", "quiet:create_task"]);
    expect(mine.every((p) => p.status === "proposed" && p.createdByUserId === a.owner && p.runId === first.runId)).toBe(true);
    const email = mine.find((p) => p.actionType === "send_email")!;
    expect(email.evidence).toMatchObject({ specialist: "SCOUT", rule: "unanswered_estimate_reminder", step: 1 });

    const [run] = await db.select().from(bieAgentRunsTable).where(eq(bieAgentRunsTable.id, first.runId));
    expect(run).toMatchObject({ kind: "specialist_scout", status: "completed", initiatedByUserId: a.owner });
    const [audit] = await db.select().from(auditEventsTable).where(and(eq(auditEventsTable.organizationId, a.org), eq(auditEventsTable.entityId, first.runId)));
    expect(audit).toMatchObject({ action: "bie.specialist_scout_run", actorUserId: a.owner });

    const again = await runSpecialist(a.org, "scout", a.owner);
    expect(again.proposals).toHaveLength(0);
    expect(again.skipped.some((s) => s.reason === "step_awaiting_review_or_reconciliation")).toBe(true);

    // The existing human path still owns execution: approve the exact payload, then execute.
    const stage = mine.find((p) => p.actionType === "change_stage")!;
    expect(await reviewBieProposal(a.org, stage.id, a.owner, "approve", stage.payload)).toMatchObject({ status: "approved" });
    expect(await executeBieProposal(a.org, stage.id, a.owner)).toMatchObject({ status: "executed" });
    const third = await runSpecialist(a.org, "scout", a.owner);
    expect(third.proposals.filter((p) => p.leadId === quiet.id && p.actionType === "change_stage")).toHaveLength(0);
  });

  it("is tenant-isolated: another company's run and listing see none of these proposals", async () => {
    const other = await runSpecialist(b.org, "scout", b.owner);
    const aLeads = new Set((await proposalsFor(a.org)).map((p) => p.leadId));
    expect(other.proposals.some((p) => aLeads.has(p.leadId))).toBe(false);
    expect((await listSpecialistProposals(b.org, "scout")).every((p) => p.organizationId === b.org)).toBe(true);
    expect((await listSpecialistProposals(a.org, "scout")).length).toBeGreaterThan(0);
  });
});

describe("INVO (proposal-only, synthetic invoices modeled on owner examples)", () => {
  it("proposes office review, warranty dates, overdue follow-up and wording review; executes a task on completed work", async () => {
    const hvacLead = await lead(a.org, "completed", null);
    await createInvoice(a.org, a.owner, { requestId: randomUUID(), leadId: hvacLead.id, document: {
      title: "Synthetic HVAC service", currency: "USD", issuerName: "Synthetic HVAC", customerName: "Synthetic customer", notes: "Terms: upon receipt.",
      lineItems: [
        { description: "Standard Repair — synthetic: limit switch, filter drier, refrigerant recharge", quantity: "1", unitPriceCents: 115_000 },
        { description: "Standard Repair — synthetic: blower belts (2), drain lines (2), coil cleaning (2)", quantity: "1", unitPriceCents: 121_500 },
      ], taxCents: 0 } });
    const roofLead = await lead(a.org, "won", null);
    const draft = (await createInvoice(a.org, a.owner, { requestId: randomUUID(), leadId: roofLead.id, document: {
      title: "Synthetic shingle roof replacement", currency: "USD", issuerName: "Synthetic Roofing", customerName: "Synthetic customer",
      notes: "Due on receipt. This shingle estimate includes a manufacturer limited lifetime warranty and 5 year workmanship warranty.",
      lineItems: [{ description: "Architectural shingle system — synthetic scope", quantity: "1", unitPriceCents: 1_105_000 }], taxCents: 0 } })).invoice;
    const issued = (await issueInvoice(a.org, a.owner, draft.id, { requestId: randomUUID(), expectedVersion: draft.version, confirmed: true })).invoice;
    await db.execute(sql`update invoices set issued_at = now() - interval '12 days' where id = ${issued.id}`);

    await expect(runSpecialist(a.org, "invo", a.rep)).rejects.toBeInstanceOf(SpecialistAccessError);

    const run = await runSpecialist(a.org, "invo", a.owner, { warrantyDatesRequired: true });
    expect(run.specialist).toBe("INVO");
    const byRule = Object.fromEntries(run.proposals.map((p) => [`${p.leadId === hvacLead.id ? "hvac" : "roof"}:${p.evidence.rule}`, p]));
    expect(Object.keys(byRule).sort()).toEqual([
      "hvac:multi_line_office_review", "hvac:warranty_dates_missing",
      "roof:estimate_wording_on_invoice", "roof:overdue_unpaid_balance", "roof:warranty_dates_missing",
    ]);
    expect(run.proposals.every((p) => p.actionType === "create_task" && p.status === "proposed")).toBe(true);
    expect(byRule["roof:overdue_unpaid_balance"]!.evidence).toMatchObject({ balanceDueCents: 1_105_000, dueBasis: "due_on_receipt", daysPastDue: 12 });

    expect((await runSpecialist(a.org, "invo", a.owner, { warrantyDatesRequired: true })).proposals).toHaveLength(0);

    const listed = await listBieProposals(a.org);
    expect(listed.find((p) => p.id === byRule["roof:overdue_unpaid_balance"]!.id)?.specialist).toBe("invo");

    // Internal invoice tasks execute on won/completed work through the unchanged approval path.
    const overdue = byRule["roof:overdue_unpaid_balance"]!;
    await reviewBieProposal(a.org, overdue.id, a.owner, "approve", overdue.payload);
    const executed = await executeBieProposal(a.org, overdue.id, a.owner);
    expect(executed).toMatchObject({ status: "executed" });
    const [task] = await db.select().from(crmTasksTable).where(and(eq(crmTasksTable.organizationId, a.org), eq(crmTasksTable.leadId, roofLead.id)));
    expect(task?.title).toMatch(/unpaid invoice/);
  });
});
