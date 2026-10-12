/**
 * INVO execution revalidation: an approved invoice task is created only if the
 * invoice still matches what was proposed. Synthetic records only.
 */
import { randomUUID } from "node:crypto";

import { bieActionProposalsTable, crmTasksTable, db, invoicesTable, valueEntriesTable, type BieActionProposal } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { deleteTestOrgs } from "../../test-helpers/delete-test-orgs";
import { invoiceAcceptance, invoiceAttemptFixture, invoiceAttemptReview, type InvoiceAttemptFixture } from "../../test-helpers/invoice-attempt-fixture";
import { executeBieProposal, reviewBieProposal } from "../bie";
import { assertInvoiceDeliveryAttemptDispatch, runInvoiceDeliveryAttempt } from "../invoice-delivery-attempts";
import { createInvoice, recordInvoicePayment, updateInvoice, voidInvoice } from "../invoices";
import { SpecialistAccessError, revalidateInvoiceProposal, runInvo, type CurrentInvoiceState } from "./invo";

const NOW = new Date();
const ISSUED = new Date(NOW.getTime() - 12 * 86_400_000);
const orgs: string[] = [];
beforeEach(() => vi.stubEnv("GROWTHOS_OUTBOUND_HOLD", "false"));
afterEach(() => vi.unstubAllEnvs());
afterAll(async () => deleteTestOrgs(...orgs));

async function fixture() {
  const f = await invoiceAttemptFixture();
  orgs.push(f.org);
  await db.update(invoicesTable).set({ issuedAt: ISSUED }).where(eq(invoicesTable.id, f.invoice.id));
  return f;
}
async function proposals(f: InvoiceAttemptFixture, warrantyDatesRequired = false) {
  return (await runInvo(f.org, f.actor, { warrantyDatesRequired }, NOW)).inserted;
}
const byRule = (rows: BieActionProposal[], rule: string) => rows.find((p) => p.evidence.rule === rule)!;
async function approveAndExecute(f: InvoiceAttemptFixture, proposal: BieActionProposal) {
  expect(await reviewBieProposal(f.org, proposal.id, f.actor, "approve", proposal.payload)).toMatchObject({ status: "approved" });
  return executeBieProposal(f.org, proposal.id, f.actor);
}
const invoiceTasks = (f: InvoiceAttemptFixture) =>
  db.select().from(crmTasksTable).where(and(eq(crmTasksTable.organizationId, f.org), eq(crmTasksTable.sourceEvent, "bie.invoice_review")));
const confirm = (version: number) => ({ requestId: randomUUID(), expectedVersion: version, confirmed: true as const });

describe("INVO overdue follow-up revalidation", () => {
  it("creates the task when the unpaid balance is unchanged", async () => {
    const f = await fixture();
    const overdue = byRule(await proposals(f), "overdue_unpaid_balance");
    expect(overdue.evidence).toMatchObject({ daysPastDue: 12, balanceDueCents: 10000, invoiceVersion: f.invoice.version });
    expect(JSON.stringify(overdue.payload)).not.toMatch(/\$|10000|100\.00/); // tasks carry no amounts
    expect(await approveAndExecute(f, overdue)).toMatchObject({ status: "executed" });
    expect(await invoiceTasks(f)).toHaveLength(1);
  });

  for (const [label, amount] of [["fully paid", 10000], ["partially paid", 2500]] as const) {
    it(`blocks a stale task after the invoice is ${label}`, async () => {
      const f = await fixture();
      const overdue = byRule(await proposals(f), "overdue_unpaid_balance");
      await recordInvoicePayment(f.org, f.actor, f.invoice.id, { ...confirm(f.invoice.version), amountCents: amount,
        sourceReference: `synthetic-receipt-${randomUUID()}`, occurredAt: new Date(NOW.getTime() - 3_600_000).toISOString() });
      const result = await approveAndExecute(f, overdue);
      expect(result).toMatchObject({ status: "blocked" });
      expect(result!.executionDetail).toMatch(/changed|paid/);
      expect(await invoiceTasks(f)).toHaveLength(0);
    });
  }

  it("blocks when the balance needs reconciliation (unallocated refund)", async () => {
    const f = await fixture();
    const overdue = byRule(await proposals(f), "overdue_unpaid_balance");
    await db.insert(valueEntriesTable).values({ organizationId: f.org, leadId: f.lead, kind: "refund", amountCents: 500,
      occurredAt: new Date(NOW.getTime() - 3_600_000), sourceReference: `synthetic-refund-${randomUUID()}`, recordedByUserId: f.actor });
    const result = await approveAndExecute(f, overdue);
    expect(result).toMatchObject({ status: "blocked" });
    expect(result!.executionDetail).toMatch(/reconciliation/);
    expect(await invoiceTasks(f)).toHaveLength(0);
  });

  it("blocks after the invoice is voided", async () => {
    const f = await fixture();
    const overdue = byRule(await proposals(f), "overdue_unpaid_balance");
    await voidInvoice(f.org, f.actor, f.invoice.id, { ...confirm(f.invoice.version), reason: "Synthetic duplicate invoice" });
    const result = await approveAndExecute(f, overdue);
    expect(result).toMatchObject({ status: "blocked" });
    expect(result!.executionDetail).toMatch(/void|changed/);
    expect(await invoiceTasks(f)).toHaveLength(0);
  });

  it("blocks an invalid or cross-tenant invoice reference", async () => {
    const f = await fixture(), other = await fixture();
    const [overdue, second] = [byRule(await proposals(f), "overdue_unpaid_balance"), byRule(await proposals(other), "overdue_unpaid_balance")];
    // Evidence is server-owned; simulate corruption/cross-tenant references directly.
    await db.update(bieActionProposalsTable).set({ evidence: { ...overdue.evidence, invoiceId: other.invoice.id } }).where(eq(bieActionProposalsTable.id, overdue.id));
    const cross = await approveAndExecute(f, overdue);
    expect(cross).toMatchObject({ status: "blocked" });
    expect(cross!.executionDetail).toMatch(/not available/);
    await db.update(bieActionProposalsTable).set({ evidence: { ...second.evidence, invoiceId: "not-a-uuid" } }).where(eq(bieActionProposalsTable.id, second.id));
    const invalid = await approveAndExecute(other, second);
    expect(invalid).toMatchObject({ status: "blocked" });
    expect(invalid!.executionDetail).toMatch(/no valid invoice reference/);
    expect([...(await invoiceTasks(f)), ...(await invoiceTasks(other))]).toHaveLength(0);
  });
});

describe("INVO unsent-invoice revalidation", () => {
  it("blocks an office-review task after the draft document is edited", async () => {
    const f = await fixture();
    const draft = (await createInvoice(f.org, f.actor, { requestId: randomUUID(), leadId: f.lead, document: {
      title: "Synthetic HVAC service", currency: "USD", issuerName: "Synthetic HVAC", customerName: "Synthetic customer",
      lineItems: [{ description: "Standard Repair A", quantity: "1", unitPriceCents: 115_000 }, { description: "Standard Repair B", quantity: "1", unitPriceCents: 121_500 }],
      taxCents: 0 } })).invoice;
    const review = (await proposals(f)).find((p) => p.evidence.rule === "multi_line_office_review" && p.evidence.invoiceId === draft.id)!;
    await updateInvoice(f.org, f.actor, draft.id, { requestId: randomUUID(), expectedVersion: draft.version, document: {
      title: "Synthetic HVAC service", currency: "USD", issuerName: "Synthetic HVAC", customerName: "Synthetic customer",
      lineItems: [{ description: "Standard Repair A", quantity: "1", unitPriceCents: 120_000 }, { description: "Standard Repair B", quantity: "1", unitPriceCents: 121_500 }],
      taxCents: 0 } });
    const result = await approveAndExecute(f, review);
    expect(result).toMatchObject({ status: "blocked" });
    expect(result!.executionDetail).toMatch(/changed/);
    expect(await invoiceTasks(f)).toHaveLength(0);
  });

  it("blocks a warranty-date task after a new delivery attempt", async () => {
    const f = await fixture();
    const warranty = byRule(await proposals(f, true), "warranty_dates_missing");
    expect(warranty).toBeTruthy();
    const delivery = await invoiceAttemptReview(f);
    await runInvoiceDeliveryAttempt(delivery, async (claim) => {
      await assertInvoiceDeliveryAttemptDispatch(claim);
      return invoiceAcceptance(delivery);
    });
    const result = await approveAndExecute(f, warranty);
    expect(result).toMatchObject({ status: "blocked" });
    expect(result!.executionDetail).toMatch(/already been sent/);
    expect(await invoiceTasks(f)).toHaveLength(0);
  });
});

describe("INVO effective principal", () => {
  it("rejects a capped role for running, reviewing and executing invoice proposals without consuming them", async () => {
    const f = await fixture();
    await expect(runInvo(f.org, f.actor, {}, NOW, { effectiveRole: "sales_rep" })).rejects.toBeInstanceOf(SpecialistAccessError);
    const overdue = byRule(await proposals(f), "overdue_unpaid_balance");
    expect(await reviewBieProposal(f.org, overdue.id, f.actor, "approve", overdue.payload, { effectiveRole: "sales_rep" })).toBeNull();
    await reviewBieProposal(f.org, overdue.id, f.actor, "approve", overdue.payload);
    const held = await executeBieProposal(f.org, overdue.id, f.actor, { effectiveRole: "sales_rep" });
    expect(held).toMatchObject({ status: "approved", executionDetail: expect.stringMatching(/Invoice access/) });
    expect(await invoiceTasks(f)).toHaveLength(0);
    expect(await executeBieProposal(f.org, overdue.id, f.actor)).toMatchObject({ status: "executed" });
  });
});

describe("revalidateInvoiceProposal (pure)", () => {
  const current = (extra: Partial<CurrentInvoiceState> = {}): CurrentInvoiceState => ({
    id: "00000000-0000-4000-8000-00000000f001", leadId: "lead-1", status: "issued", version: 3,
    document: { title: "Synthetic", notes: null, lineItems: [{ description: "A", quantity: "1", unitPriceCents: 1, totalCents: 1 }] },
    balanceDueCents: 500, reconciliationRequired: false, deliveryAttemptCount: 0, ...extra,
  });
  const ev = (rule: string, extra: Record<string, unknown> = {}) => ({ rule, invoiceId: "00000000-0000-4000-8000-00000000f001", invoiceVersion: 3, ...extra });
  it("accepts unchanged state and rejects each stale class", () => {
    expect(revalidateInvoiceProposal(ev("overdue_unpaid_balance", { balanceDueCents: 500 }), "lead-1", current())).toBeNull();
    expect(revalidateInvoiceProposal(ev("overdue_unpaid_balance", { balanceDueCents: 500 }), "lead-1", current({ balanceDueCents: 0 }))).toMatch(/paid in full/);
    expect(revalidateInvoiceProposal(ev("overdue_unpaid_balance", { balanceDueCents: 500 }), "lead-1", current({ balanceDueCents: 200 }))).toMatch(/balance changed/);
    expect(revalidateInvoiceProposal(ev("overdue_unpaid_balance", { balanceDueCents: 500 }), "lead-1", current({ reconciliationRequired: true, balanceDueCents: null }))).toMatch(/reconciliation/);
    expect(revalidateInvoiceProposal(ev("overdue_unpaid_balance"), "lead-1", current({ status: "void" }))).toMatch(/voided/);
    expect(revalidateInvoiceProposal(ev("estimate_wording_on_invoice"), "lead-1", current({ version: 4 }))).toMatch(/changed/);
    expect(revalidateInvoiceProposal(ev("multi_line_office_review"), "lead-1", current({ deliveryAttemptCount: 1 }))).toMatch(/already been sent/);
    expect(revalidateInvoiceProposal(ev("warranty_dates_missing"), "lead-1", current({ deliveryAttemptCount: 1 }))).toMatch(/already been sent/);
    expect(revalidateInvoiceProposal(ev("estimate_wording_on_invoice"), "lead-2", current())).toMatch(/not available/);
    expect(revalidateInvoiceProposal(ev("estimate_wording_on_invoice"), "lead-1", null)).toMatch(/not available/);
    expect(revalidateInvoiceProposal({ rule: "execute_payment", invoiceId: "x" }, "lead-1", current())).toMatch(/no valid invoice reference/);
  });
});
