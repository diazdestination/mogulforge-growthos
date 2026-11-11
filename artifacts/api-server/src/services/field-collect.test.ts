import { randomUUID } from "node:crypto";
import { appointmentsTable, db, leadsTable, usersTable } from "@workspace/db";
import { afterAll, describe, expect, it } from "vitest";

import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";
import {
  acceptedReturningEstimate,
  returningCustomerFixture,
  returningInvoiceDocument,
  returningProjectDraft,
} from "../test-helpers/returning-customer-fixture";
import { assertFieldCollectScope, readFieldInvoice } from "./field-collect";
import { createInvoice, getInvoice, issueInvoice } from "./invoices";
import { createCustomerWorkProject } from "./returning-customer";

const orgs: string[] = [];
afterAll(async () => {
  await deleteTestOrgs(...orgs);
});
const HOUR = 60 * 60_000;

async function company() {
  const f = await returningCustomerFixture();
  orgs.push(f.org);
  const [tech, otherTech] = await db
    .insert(usersTable)
    .values([
      { organizationId: f.org, role: "production", firstName: "Sam", emailVerifiedAt: new Date() },
      { organizationId: f.org, role: "inspector", firstName: "Lee", emailVerifiedAt: new Date() },
    ])
    .returning();
  const job = async (values: Partial<typeof appointmentsTable.$inferInsert>) =>
    (await db.insert(appointmentsTable).values({ organizationId: f.org, contactId: f.contact.id, assignedUserId: tech!.id, scheduledStart: new Date(Date.now() - HOUR), ...values }).returning())[0]!;
  const leadInvoice = async (leadId: string) => {
    const draft = (await createInvoice(f.org, f.owner.id, { requestId: randomUUID(), leadId, document: returningInvoiceDocument(12500) })).invoice;
    return (await issueInvoice(f.org, f.owner.id, draft.id, { requestId: randomUUID(), expectedVersion: draft.version, confirmed: true })).invoice;
  };
  return { f, tech: tech!, otherTech: otherTech!, job, leadInvoice };
}

describe("field collection scope (payments.collect)", () => {
  it("links a lead job to that lead's issued invoices and refuses other jobs, other leads, viewers and other companies", async () => {
    const { f, tech, otherTech, job, leadInvoice } = await company();
    const [lead, otherLead] = await db.insert(leadsTable).values([{ organizationId: f.org, contactId: f.contact.id }, { organizationId: f.org, contactId: f.contact.id }]).returning();
    const invoice = await leadInvoice(lead!.id);
    const unlinked = await leadInvoice(otherLead!.id);
    const mine = await job({ leadId: lead!.id });

    // A tech cannot read invoices in general...
    await expect(getInvoice(f.org, tech.id, invoice.id)).rejects.toMatchObject({ status: 403 });
    // ...but can read the balance of the one linked to their own job.
    const read = await readFieldInvoice(db, f.org, { userId: tech.id }, invoice.id, mine.id);
    expect(read.appointment.id).toBe(mine.id);
    expect(read.invoice).toMatchObject({ id: invoice.id, balanceDueCents: 12500 });
    // Re-checking without a job id finds any of their current jobs.
    expect((await assertFieldCollectScope(db, f.org, { userId: tech.id }, invoice.id, null)).id).toBe(mine.id);

    await expect(assertFieldCollectScope(db, f.org, { userId: tech.id }, unlinked.id, mine.id)).rejects.toMatchObject({ status: 403, code: "field_invoice_not_linked" });
    await expect(assertFieldCollectScope(db, f.org, { userId: otherTech.id }, invoice.id, mine.id)).rejects.toMatchObject({ status: 404, code: "field_job_not_found" });
    await expect(assertFieldCollectScope(db, f.org, { userId: otherTech.id }, invoice.id, null)).rejects.toMatchObject({ status: 403 });
    await expect(assertFieldCollectScope(db, f.org, { userId: f.viewer.id }, invoice.id, mine.id)).rejects.toMatchObject({ status: 403, code: "field_collect_denied" });
    // A role preview without the permission is refused even for the job's own assignee.
    await expect(assertFieldCollectScope(db, f.org, { userId: tech.id, effectiveRole: "viewer" }, invoice.id, mine.id)).rejects.toMatchObject({ code: "field_collect_denied" });

    const cancelled = await job({ leadId: lead!.id, status: "cancelled" });
    await expect(assertFieldCollectScope(db, f.org, { userId: tech.id }, invoice.id, cancelled.id)).rejects.toMatchObject({ status: 404 });
    const old = await job({ leadId: lead!.id, scheduledStart: new Date(Date.now() - 30 * 24 * HOUR) });
    await expect(assertFieldCollectScope(db, f.org, { userId: tech.id }, invoice.id, old.id)).rejects.toMatchObject({ status: 404 });

    const other = await company();
    await expect(assertFieldCollectScope(db, other.f.org, { userId: other.tech.id }, invoice.id, mine.id)).rejects.toMatchObject({ status: 404 });
    await expect(assertFieldCollectScope(db, other.f.org, { userId: tech.id }, invoice.id, mine.id)).rejects.toMatchObject({ code: "field_collect_denied" });
  });

  it("links a job with no lead to the customer's returning-work invoice at the same property", async () => {
    const { f, tech, job } = await company();
    const accepted = await acceptedReturningEstimate(f, f.secondProperty.id);
    const project = await createCustomerWorkProject(f.org, f.actor, { ...returningProjectDraft(f), status: "completed", source: { kind: "estimate", estimateId: accepted.estimate.id, expectedWorkVersion: accepted.estimate.workVersion } });
    const draft = (await createInvoice(f.org, f.owner.id, { requestId: randomUUID(), source: { kind: "customer_work", customerWorkId: accepted.estimate.customerWorkId! }, projectId: project.project.id, document: returningInvoiceDocument(10000) }, "owner")).invoice;
    const invoice = (await issueInvoice(f.org, f.owner.id, draft.id, { requestId: randomUUID(), expectedVersion: draft.version, confirmed: true })).invoice;

    const atProperty = await job({ propertyId: f.secondProperty.id });
    expect((await readFieldInvoice(db, f.org, { userId: tech.id }, invoice.id, atProperty.id)).invoice).toMatchObject({ id: invoice.id, balanceDueCents: 10000 });
    const elsewhere = await job({ propertyId: f.firstProperty.id });
    await expect(assertFieldCollectScope(db, f.org, { userId: tech.id }, invoice.id, elsewhere.id)).rejects.toMatchObject({ code: "field_invoice_not_linked" });
    const otherCustomer = await job({ contactId: f.otherContact.id });
    await expect(assertFieldCollectScope(db, f.org, { userId: tech.id }, invoice.id, otherCustomer.id)).rejects.toMatchObject({ code: "field_invoice_not_linked" });
  });
});
