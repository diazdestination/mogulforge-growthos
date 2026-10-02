import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import {
  activitiesTable,
  auditEventsTable,
  contactsTable,
  crmTasksTable,
  db,
  estimatesTable,
  invoiceOperationsTable,
  invoiceReceiptAllocationsTable,
  invoiceSequencesTable,
  invoicesTable,
  leadsTable,
  organizationsTable,
  projectsTable,
  usersTable,
  valueEntriesTable,
} from "@workspace/db";
import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";
import {
  allocateInvoiceValue,
  createInvoice,
  getInvoice,
  issueInvoice,
  listInvoices,
  recordInvoicePayment,
  reverseInvoiceAllocation,
  updateInvoice,
  voidInvoice,
} from "./invoices";
import {
  invoiceDocument,
  invoiceDocumentInputSchema,
  type InvoiceDetail,
} from "./invoice-contract";
import { updateProject } from "./crm";

const orgs: string[] = [];
const occurredAt = new Date(Date.now() - 86_400_000).toISOString();
const draft = (amount = 10000) => ({
  title: "Synthetic HVAC repair",
  currency: "USD" as const,
  issuerName: "Synthetic contractor",
  customerName: "Synthetic customer",
  lineItems: [
    {
      description: "Agreed repair work",
      quantity: "1",
      unitPriceCents: amount,
    },
  ],
  taxCents: 0,
});
async function fixture() {
  const [org] = await db
    .insert(organizationsTable)
    .values({ name: "Synthetic invoice QA", slug: `invoice-${randomUUID()}` })
    .returning();
  orgs.push(org.id);
  const [owner] = await db
    .insert(usersTable)
    .values({
      organizationId: org.id,
      role: "owner",
      isActive: true,
      emailVerifiedAt: new Date(),
    })
    .returning();
  const [contact] = await db
    .insert(contactsTable)
    .values({
      organizationId: org.id,
      firstName: "Synthetic",
      lastName: "Customer",
    })
    .returning();
  const [lead] = await db
    .insert(leadsTable)
    .values({
      organizationId: org.id,
      contactId: contact.id,
      source: "native_qa",
    })
    .returning();
  return { org: org.id, actor: owner.id, contact: contact.id, lead: lead.id };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function makeDraft(f: Fixture, extra: Record<string, unknown> = {}) {
  return (
    await createInvoice(f.org, f.actor, {
      requestId: randomUUID(),
      leadId: f.lead,
      document: draft(),
      ...extra,
    })
  ).invoice;
}
const command = (invoice: InvoiceDetail) => ({
  requestId: randomUUID(),
  expectedVersion: invoice.version,
  confirmed: true as const,
});
async function issued(f: Fixture, extra: Record<string, unknown> = {}) {
  const invoice = await makeDraft(f, extra);
  return (await issueInvoice(f.org, f.actor, invoice.id, command(invoice)))
    .invoice;
}
async function value(
  f: Fixture,
  kind: "payment" | "refund",
  amountCents: number,
) {
  const [row] = await db
    .insert(valueEntriesTable)
    .values({
      organizationId: f.org,
      leadId: f.lead,
      kind,
      amountCents,
      occurredAt: new Date(occurredAt),
      sourceReference: `invoice-source-${randomUUID()}`,
      recordedByUserId: f.actor,
    })
    .returning();
  return row!;
}
afterAll(async () => {
  await deleteTestOrgs(...orgs);
});

describe("invoice calculations and document lifecycle", () => {
  it("computes exact fixed-decimal line totals, rejects client totals and invalid precision, and caps total amounts", () => {
    const document = invoiceDocument(
      invoiceDocumentInputSchema.parse({
        ...draft(),
        lineItems: [
          { description: "half cent", quantity: "0001.250", unitPriceCents: 2 },
          { description: "fraction", quantity: "0.333", unitPriceCents: 300 },
        ],
        taxCents: 17,
      }),
    );
    expect(
      document.lineItems.map((line) => [line.quantity, line.totalCents]),
    ).toEqual([
      ["1.25", 3],
      ["0.333", 100],
    ]);
    expect(document).toMatchObject({
      subtotalCents: 103,
      taxCents: 17,
      totalCents: 120,
    });
    for (const quantity of ["0", "-1", "1e2", "1.0001", ".5", "Infinity"])
      expect(
        invoiceDocumentInputSchema.safeParse({
          ...draft(),
          lineItems: [{ ...draft().lineItems[0], quantity }],
        }).success,
      ).toBe(false);
    expect(
      invoiceDocumentInputSchema.safeParse({ ...draft(), totalCents: 1 })
        .success,
    ).toBe(false);
    expect(
      invoiceDocumentInputSchema.safeParse({
        ...draft(),
        lineItems: [{ ...draft().lineItems[0], totalCents: 1 }],
      }).success,
    ).toBe(false);
    expect(
      invoiceDocumentInputSchema.safeParse({
        ...draft(),
        dueDate: "2026-02-30",
      }).success,
    ).toBe(false);
    expect(
      invoiceDocumentInputSchema.safeParse({ ...draft(), taxCents: 0.5 })
        .success,
    ).toBe(false);
    expect(() =>
      invoiceDocument(
        invoiceDocumentInputSchema.parse({
          ...draft(1_000_000_000),
          taxCents: 1,
        }),
      ),
    ).toThrow(/must not exceed/);
  });

  it("persists request identity across retries, rejects changed requests and stale versions", async () => {
    const f = await fixture();
    const input = {
      requestId: randomUUID(),
      leadId: f.lead,
      document: draft(),
    };
    const first = await createInvoice(f.org, f.actor, input);
    const again = await createInvoice(f.org, f.actor, input);
    expect(again).toMatchObject({
      duplicate: true,
      invoice: { id: first.invoice.id, version: 1 },
    });
    await expect(
      createInvoice(f.org, f.actor, {
        ...input,
        document: { ...draft(), title: "Different" },
      }),
    ).rejects.toMatchObject({ code: "invoice_request_conflict" });
    const edited = (
      await updateInvoice(f.org, f.actor, first.invoice.id, {
        requestId: randomUUID(),
        expectedVersion: 1,
        document: { ...draft(), notes: "Reviewed terms" },
      })
    ).invoice;
    expect(edited.version).toBe(2);
    await expect(
      issueInvoice(f.org, f.actor, edited.id, {
        ...command(edited),
        expectedVersion: 1,
      }),
    ).rejects.toMatchObject({ code: "invoice_version_changed" });
    expect(
      await db
        .select()
        .from(invoiceOperationsTable)
        .where(eq(invoiceOperationsTable.organizationId, f.org)),
    ).toHaveLength(2);
  });

  it("numbers only on issue, freezes issued content, and never creates sent or paid evidence", async () => {
    const f = await fixture();
    const [estimate] = await db
      .insert(estimatesTable)
      .values({
        organizationId: f.org,
        leadId: f.lead,
        title: "Original estimate",
        totalCents: 10000,
      })
      .returning();
    const pending = await makeDraft(f, { estimateId: estimate!.id });
    expect(pending).toMatchObject({
      invoiceNumber: null,
      issuedAt: null,
      status: "draft",
      balanceDueCents: null,
    });
    const input = command(pending);
    const completed = (await issueInvoice(f.org, f.actor, pending.id, input))
      .invoice;
    expect(completed).toMatchObject({
      invoiceNumber: "INV-000001",
      status: "issued",
      recordedPaidCents: 0,
      balanceDueCents: 10000,
      paymentState: "unpaid",
    });
    expect(await issueInvoice(f.org, f.actor, pending.id, input)).toMatchObject(
      { duplicate: true, invoice: { invoiceNumber: "INV-000001" } },
    );
    await db
      .update(estimatesTable)
      .set({ title: "Later estimate edit", totalCents: 99999 })
      .where(eq(estimatesTable.id, estimate!.id));
    await db
      .update(contactsTable)
      .set({ firstName: "Later contact edit" })
      .where(eq(contactsTable.id, f.contact));
    expect((await getInvoice(f.org, f.actor, pending.id)).document).toEqual(
      completed.document,
    );
    await expect(
      updateInvoice(f.org, f.actor, pending.id, {
        requestId: randomUUID(),
        expectedVersion: completed.version,
        document: draft(1),
      }),
    ).rejects.toMatchObject({ code: "invoice_transition_unavailable" });
    expect(
      await db
        .select()
        .from(valueEntriesTable)
        .where(eq(valueEntriesTable.organizationId, f.org)),
    ).toHaveLength(0);
    expect(
      (
        await db
          .select()
          .from(invoiceSequencesTable)
          .where(eq(invoiceSequencesTable.organizationId, f.org))
      )[0]?.nextNumber,
    ).toBe(2);
    const events = await db
      .select()
      .from(auditEventsTable)
      .where(eq(auditEventsTable.organizationId, f.org));
    expect(events.map((event) => event.action)).toEqual([
      "invoice.draft_created",
      "invoice.issued",
    ]);
    expect(
      events.every((event) => event.metadata.providerEffect === false),
    ).toBe(true);
  });

  it("rejects empty issuance, retains void history and never reuses its number", async () => {
    const f = await fixture();
    const empty = await makeDraft(f, {
      document: { ...draft(), lineItems: [] },
    });
    await expect(
      issueInvoice(f.org, f.actor, empty.id, command(empty)),
    ).rejects.toMatchObject({ code: "invoice_invalid_request" });
    let invoice = await issued(f);
    invoice = (
      await voidInvoice(f.org, f.actor, invoice.id, {
        ...command(invoice),
        reason: "Customer scope was replaced.",
      })
    ).invoice;
    expect(invoice).toMatchObject({
      status: "void",
      invoiceNumber: "INV-000001",
      balanceDueCents: 0,
    });
    await expect(
      issueInvoice(f.org, f.actor, invoice.id, command(invoice)),
    ).rejects.toMatchObject({ code: "invoice_transition_unavailable" });
    expect((await issued(f)).invoiceNumber).toBe("INV-000002");
    expect(invoice.document.totalCents).toBe(10000);
  });

  it("rolls the sequence and audit back when numbering cannot commit", async () => {
    const f = await fixture();
    await issued(f);
    const second = await makeDraft(f);
    await db
      .update(invoiceSequencesTable)
      .set({ nextNumber: 1 })
      .where(eq(invoiceSequencesTable.organizationId, f.org));
    await expect(
      issueInvoice(f.org, f.actor, second.id, command(second)),
    ).rejects.toBeDefined();
    expect(await getInvoice(f.org, f.actor, second.id)).toMatchObject({
      status: "draft",
      version: 1,
      invoiceNumber: null,
    });
    expect(
      (
        await db
          .select()
          .from(invoiceSequencesTable)
          .where(eq(invoiceSequencesTable.organizationId, f.org))
      )[0]?.nextNumber,
    ).toBe(1);
    expect(
      await db
        .select()
        .from(invoiceOperationsTable)
        .where(
          and(
            eq(invoiceOperationsTable.invoiceId, second.id),
            eq(invoiceOperationsTable.action, "issued"),
          ),
        ),
    ).toHaveLength(0);
  });
});

describe("recorded receipt allocation and reconciliation", () => {
  it("records partial receipts atomically, retries once, prevents overpayment and duplicate canonical receipts", async () => {
    const f = await fixture();
    let invoice = await issued(f);
    const input = {
      ...command(invoice),
      amountCents: 4000,
      sourceReference: `manual-${randomUUID()}`,
      occurredAt,
    };
    invoice = (await recordInvoicePayment(f.org, f.actor, invoice.id, input))
      .invoice;
    expect(invoice).toMatchObject({
      recordedPaidCents: 4000,
      recordedBalanceCents: 6000,
      balanceDueCents: 6000,
      paymentState: "partial",
    });
    expect(
      await recordInvoicePayment(f.org, f.actor, invoice.id, input),
    ).toMatchObject({ duplicate: true });
    await expect(
      recordInvoicePayment(f.org, f.actor, invoice.id, {
        ...input,
        ...command(invoice),
      }),
    ).rejects.toMatchObject({ code: "invoice_receipt_unavailable" });
    const tooMuch = {
      ...command(invoice),
      amountCents: 6001,
      sourceReference: `too-large-${randomUUID()}`,
      occurredAt,
    };
    await expect(
      recordInvoicePayment(f.org, f.actor, invoice.id, tooMuch),
    ).rejects.toMatchObject({ code: "invoice_payment_conflict" });
    expect(
      await db
        .select()
        .from(valueEntriesTable)
        .where(eq(valueEntriesTable.sourceReference, tooMuch.sourceReference)),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(invoiceReceiptAllocationsTable)
        .where(eq(invoiceReceiptAllocationsTable.organizationId, f.org)),
    ).toHaveLength(1);
    invoice = (
      await recordInvoicePayment(f.org, f.actor, invoice.id, {
        ...command(invoice),
        amountCents: 6000,
        sourceReference: `balance-${randomUUID()}`,
        occurredAt,
      })
    ).invoice;
    expect(invoice).toMatchObject({
      recordedPaidCents: 10000,
      balanceDueCents: 0,
      paymentState: "paid",
    });
    await expect(
      voidInvoice(f.org, f.actor, invoice.id, {
        ...command(invoice),
        reason: "Trying to hide a paid invoice.",
      }),
    ).rejects.toMatchObject({ code: "invoice_payment_conflict" });
  });

  it("applies existing receipts without double counting and reverses only their allocation", async () => {
    const f = await fixture();
    let invoice = await issued(f);
    const receipt = await value(f, "payment", 15000);
    expect(
      (await getInvoice(f.org, f.actor, invoice.id)).availableValueEntries[0],
    ).toMatchObject({ id: receipt.id, availableCents: 15000 });
    invoice = (
      await allocateInvoiceValue(f.org, f.actor, invoice.id, {
        ...command(invoice),
        valueEntryId: receipt.id,
        amountCents: 10000,
      })
    ).invoice;
    expect(invoice.paymentState).toBe("paid");
    const reversal = {
      ...command(invoice),
      reason: "Applied to the wrong invoice; receipt still exists.",
    };
    invoice = (
      await reverseInvoiceAllocation(
        f.org,
        f.actor,
        invoice.id,
        invoice.allocations[0]!.id,
        reversal,
      )
    ).invoice;
    expect(invoice).toMatchObject({
      recordedPaidCents: 0,
      balanceDueCents: 10000,
      paymentState: "unpaid",
    });
    expect(invoice.availableValueEntries[0]?.availableCents).toBe(15000);
    expect(invoice.allocations[0]?.reversalReason).toContain("wrong invoice");
    expect(
      await reverseInvoiceAllocation(
        f.org,
        f.actor,
        invoice.id,
        invoice.allocations[0]!.id,
        reversal,
      ),
    ).toMatchObject({ duplicate: true });
    const cash = await db
      .select()
      .from(valueEntriesTable)
      .where(eq(valueEntriesTable.organizationId, f.org));
    expect(cash.map((entry) => [entry.kind, entry.amountCents])).toEqual([
      ["payment", 15000],
    ]);
  });

  it("holds paid status for unallocated refunds, applies explicit refunds, and restores the hold if that allocation is reversed", async () => {
    const f = await fixture();
    let invoice = await issued(f);
    invoice = (
      await recordInvoicePayment(f.org, f.actor, invoice.id, {
        ...command(invoice),
        amountCents: 10000,
        sourceReference: `full-${randomUUID()}`,
        occurredAt,
      })
    ).invoice;
    const refund = await value(f, "refund", 2500);
    invoice = await getInvoice(f.org, f.actor, invoice.id);
    expect(invoice).toMatchObject({
      recordedBalanceCents: 0,
      balanceDueCents: null,
      reconciliationRequired: true,
      unallocatedRefundCents: 2500,
      paymentState: "reconciliation_required",
    });
    invoice = (
      await allocateInvoiceValue(f.org, f.actor, invoice.id, {
        ...command(invoice),
        valueEntryId: refund.id,
        amountCents: 2500,
      })
    ).invoice;
    expect(invoice).toMatchObject({
      recordedPaidCents: 7500,
      balanceDueCents: 2500,
      reconciliationRequired: false,
      paymentState: "partial",
    });
    await expect(
      reverseInvoiceAllocation(
        f.org,
        f.actor,
        invoice.id,
        invoice.allocations.find((a) => a.kind === "payment")!.id,
        {
          ...command(invoice),
          reason: "Would leave a negative receipt balance.",
        },
      ),
    ).rejects.toMatchObject({ code: "invoice_payment_conflict" });
    invoice = (
      await reverseInvoiceAllocation(
        f.org,
        f.actor,
        invoice.id,
        invoice.allocations.find((a) => a.kind === "refund")!.id,
        {
          ...command(invoice),
          reason: "Refund allocated to a different invoice.",
        },
      )
    ).invoice;
    expect(invoice.paymentState).toBe("reconciliation_required");
    expect(
      await db
        .select()
        .from(valueEntriesTable)
        .where(eq(valueEntriesTable.organizationId, f.org)),
    ).toHaveLength(2);
  });

  it("cannot allocate more than one receipt across invoices or more refund than recorded receipts", async () => {
    const f = await fixture();
    const a = await issued(f),
      b = await issued(f);
    const receipt = await value(f, "payment", 10000);
    await allocateInvoiceValue(f.org, f.actor, a.id, {
      ...command(a),
      valueEntryId: receipt.id,
      amountCents: 7000,
    });
    await expect(
      allocateInvoiceValue(f.org, f.actor, b.id, {
        ...command(b),
        valueEntryId: receipt.id,
        amountCents: 3001,
      }),
    ).rejects.toMatchObject({ code: "invoice_receipt_unavailable" });
    const refund = await value(f, "refund", 1000);
    await expect(
      allocateInvoiceValue(f.org, f.actor, b.id, {
        ...command(b),
        valueEntryId: refund.id,
        amountCents: 1,
      }),
    ).rejects.toMatchObject({ code: "invoice_payment_conflict" });
    expect((await getInvoice(f.org, f.actor, a.id)).paymentState).toBe(
      "reconciliation_required",
    );
  });
});

describe("invoice tenant, role and job boundaries", () => {
  it("rejects foreign invoices, linked records, receipts and same-company wrong-lead relationships", async () => {
    const f = await fixture(),
      foreign = await fixture();
    const invoice = await issued(f);
    await expect(
      getInvoice(foreign.org, foreign.actor, invoice.id),
    ).rejects.toMatchObject({ code: "invoice_not_found" });
    expect((await listInvoices(foreign.org, foreign.actor, {})).items).toEqual(
      [],
    );
    await expect(
      createInvoice(f.org, f.actor, {
        requestId: randomUUID(),
        leadId: foreign.lead,
        document: draft(),
      }),
    ).rejects.toMatchObject({ code: "invoice_not_found" });
    const [project] = await db
      .insert(projectsTable)
      .values({
        organizationId: foreign.org,
        leadId: foreign.lead,
        name: "Foreign job",
      })
      .returning();
    await expect(
      makeDraft(f, { projectId: project!.id }),
    ).rejects.toMatchObject({ code: "invoice_not_found" });
    const receipt = await value(foreign, "payment", 10000);
    await expect(
      allocateInvoiceValue(f.org, f.actor, invoice.id, {
        ...command(invoice),
        valueEntryId: receipt.id,
        amountCents: 1,
      }),
    ).rejects.toMatchObject({ code: "invoice_receipt_unavailable" });
    const [otherLead] = await db
      .insert(leadsTable)
      .values({ organizationId: f.org, contactId: f.contact })
      .returning();
    const [estimate] = await db
      .insert(estimatesTable)
      .values({
        organizationId: f.org,
        leadId: otherLead!.id,
        title: "Different opportunity",
      })
      .returning();
    await expect(
      makeDraft(f, { estimateId: estimate!.id }),
    ).rejects.toMatchObject({ code: "invoice_not_found" });
  });

  it("rechecks current active roles for direct calls and after request replay", async () => {
    const f = await fixture();
    const [office, sales, viewer] = await db
      .insert(usersTable)
      .values([
        { organizationId: f.org, role: "office", isActive: true },
        { organizationId: f.org, role: "sales_manager", isActive: true },
        { organizationId: f.org, role: "viewer", isActive: true },
      ])
      .returning();
    const input = {
      requestId: randomUUID(),
      leadId: f.lead,
      document: draft(),
    };
    const invoice = (await createInvoice(f.org, office!.id, input)).invoice;
    expect((await getInvoice(f.org, sales!.id, invoice.id)).id).toBe(
      invoice.id,
    );
    await expect(
      issueInvoice(f.org, sales!.id, invoice.id, command(invoice)),
    ).rejects.toMatchObject({ code: "invoice_access_denied" });
    await expect(
      getInvoice(f.org, viewer!.id, invoice.id),
    ).rejects.toMatchObject({ code: "invoice_access_denied" });
    await db
      .update(usersTable)
      .set({ isActive: false })
      .where(eq(usersTable.id, office!.id));
    await expect(createInvoice(f.org, office!.id, input)).rejects.toMatchObject(
      { code: "invoice_access_denied" },
    );
  });

  it("completes only the matching project preparation task after a successful draft and leaves failed work open", async () => {
    const f = await fixture(),
      other = await fixture();
    const [project] = await db
      .insert(projectsTable)
      .values({
        organizationId: f.org,
        leadId: f.lead,
        name: "Synthetic completed job",
      })
      .returning();
    await updateProject(f.org, project!.id, { status: "completed" });
    const sourceEvent = `project.invoice_preparation:${project!.id}`;
    const [task] = await db
      .select()
      .from(crmTasksTable)
      .where(
        and(
          eq(crmTasksTable.organizationId, f.org),
          eq(crmTasksTable.sourceEvent, sourceEvent),
        ),
      );
    expect(task?.status).toBe("open");
    const [foreignTask] = await db
      .insert(crmTasksTable)
      .values({
        organizationId: other.org,
        leadId: other.lead,
        title: "Foreign similarly named task",
        sourceEvent,
      })
      .returning();
    await expect(
      makeDraft(f, { projectId: project!.id, leadId: other.lead }),
    ).rejects.toMatchObject({ code: "invoice_not_found" });
    expect(
      (
        await db
          .select()
          .from(crmTasksTable)
          .where(eq(crmTasksTable.id, task!.id))
      )[0]?.status,
    ).toBe("open");
    await makeDraft(f, { projectId: project!.id });
    expect(
      (
        await db
          .select()
          .from(crmTasksTable)
          .where(eq(crmTasksTable.id, task!.id))
      )[0]?.status,
    ).toBe("done");
    expect(
      (
        await db
          .select()
          .from(crmTasksTable)
          .where(eq(crmTasksTable.id, foreignTask!.id))
      )[0]?.status,
    ).toBe("open");
  });

  it("rolls back the draft, audit and preparation completion when final reconciliation fails", async () => {
    const f = await fixture(),
      other = await fixture();
    const existing = await issued(f);
    const foreignReceipt = await value(other, "payment", 100);
    await db.insert(invoiceReceiptAllocationsTable).values({
      organizationId: f.org,
      invoiceId: existing.id,
      valueEntryId: foreignReceipt.id,
      kind: "payment",
      amountCents: 100,
      actorUserId: f.actor,
    });
    const [project] = await db
      .insert(projectsTable)
      .values({
        organizationId: f.org,
        leadId: f.lead,
        name: "Atomic invoice preparation",
      })
      .returning();
    await updateProject(f.org, project!.id, { status: "completed" });
    const sourceEvent = `project.invoice_preparation:${project!.id}`;
    const requestId = randomUUID();
    const beforeAudit = await db
      .select()
      .from(auditEventsTable)
      .where(eq(auditEventsTable.organizationId, f.org));
    const beforeActivity = await db
      .select()
      .from(activitiesTable)
      .where(eq(activitiesTable.organizationId, f.org));
    await expect(
      createInvoice(f.org, f.actor, {
        requestId,
        leadId: f.lead,
        projectId: project!.id,
        document: draft(),
      }),
    ).rejects.toMatchObject({ code: "invoice_unavailable" });
    expect(
      await db
        .select()
        .from(invoicesTable)
        .where(eq(invoicesTable.projectId, project!.id)),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(invoiceOperationsTable)
        .where(eq(invoiceOperationsTable.requestId, requestId)),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(auditEventsTable)
        .where(eq(auditEventsTable.organizationId, f.org)),
    ).toHaveLength(beforeAudit.length);
    expect(
      await db
        .select()
        .from(activitiesTable)
        .where(eq(activitiesTable.organizationId, f.org)),
    ).toHaveLength(beforeActivity.length);
    expect(
      (
        await db
          .select()
          .from(crmTasksTable)
          .where(
            and(
              eq(crmTasksTable.organizationId, f.org),
              eq(crmTasksTable.sourceEvent, sourceEvent),
            ),
          )
      )[0]?.status,
    ).toBe("open");
  });

  it("fails closed for forged cross-tenant allocation rows and altered issued snapshots", async () => {
    const f = await fixture(),
      other = await fixture();
    const invoice = await issued(f);
    const foreignCash = await value(other, "payment", 100);
    const [forged] = await db
      .insert(invoiceReceiptAllocationsTable)
      .values({
        organizationId: f.org,
        invoiceId: invoice.id,
        valueEntryId: foreignCash.id,
        kind: "payment",
        amountCents: 100,
        actorUserId: f.actor,
      })
      .returning();
    await expect(getInvoice(f.org, f.actor, invoice.id)).rejects.toMatchObject({
      code: "invoice_unavailable",
    });
    await db
      .update(invoiceReceiptAllocationsTable)
      .set({ organizationId: other.org })
      .where(eq(invoiceReceiptAllocationsTable.id, forged!.id));
    await expect(getInvoice(f.org, f.actor, invoice.id)).rejects.toMatchObject({
      code: "invoice_unavailable",
    });
    await db
      .delete(invoiceReceiptAllocationsTable)
      .where(eq(invoiceReceiptAllocationsTable.id, forged!.id));
    const ownCash = await value(f, "payment", 100);
    const otherInvoice = await issued(other);
    const [wrongOwner] = await db
      .insert(invoiceReceiptAllocationsTable)
      .values({
        organizationId: other.org,
        invoiceId: otherInvoice.id,
        valueEntryId: ownCash.id,
        kind: "payment",
        amountCents: 100,
        actorUserId: other.actor,
      })
      .returning();
    await expect(getInvoice(f.org, f.actor, invoice.id)).rejects.toMatchObject({
      code: "invoice_unavailable",
    });
    await db
      .delete(invoiceReceiptAllocationsTable)
      .where(eq(invoiceReceiptAllocationsTable.id, wrongOwner!.id));
    await db
      .update(invoicesTable)
      .set({ issuedDocument: { ...invoice.document, totalCents: 99999 } })
      .where(eq(invoicesTable.id, invoice.id));
    await expect(getInvoice(f.org, f.actor, invoice.id)).rejects.toMatchObject({
      code: "invoice_unavailable",
    });
    await expect(listInvoices(f.org, f.actor, {})).rejects.toMatchObject({
      code: "invoice_unavailable",
    });
  });
});

describe.skipIf(process.env.SCHEDULER_TEST_BACKEND === "pglite")(
  "PostgreSQL invoice concurrency",
  () => {
    it("issues one number/event for concurrent retries and unique numbers across invoices", async () => {
      const f = await fixture();
      const a = await makeDraft(f),
        b = await makeDraft(f);
      const input = command(a);
      const responses = await Promise.all([
        issueInvoice(f.org, f.actor, a.id, input),
        issueInvoice(f.org, f.actor, a.id, input),
        issueInvoice(f.org, f.actor, b.id, command(b)),
      ]);
      expect(responses.filter((result) => result.duplicate)).toHaveLength(1);
      expect(
        new Set(responses.map((result) => result.invoice.invoiceNumber)).size,
      ).toBe(2);
      expect(
        await db
          .select()
          .from(invoiceOperationsTable)
          .where(
            and(
              eq(invoiceOperationsTable.organizationId, f.org),
              eq(invoiceOperationsTable.action, "issued"),
            ),
          ),
      ).toHaveLength(2);
    });
    it("serializes project completion with invoice preparation without a late open handoff", async () => {
      const f = await fixture();
      const [project] = await db
        .insert(projectsTable)
        .values({
          organizationId: f.org,
          leadId: f.lead,
          name: "Concurrent completion",
        })
        .returning();
      await Promise.all([
        updateProject(f.org, project!.id, { status: "completed" }),
        makeDraft(f, { projectId: project!.id }),
      ]);
      const tasks = await db
        .select()
        .from(crmTasksTable)
        .where(
          and(
            eq(crmTasksTable.organizationId, f.org),
            eq(
              crmTasksTable.sourceEvent,
              `project.invoice_preparation:${project!.id}`,
            ),
          ),
        );
      expect(tasks.every((task) => task.status === "done")).toBe(true);
      expect(tasks.length).toBeLessThanOrEqual(1);
      expect(
        await db
          .select()
          .from(invoicesTable)
          .where(eq(invoicesTable.projectId, project!.id)),
      ).toHaveLength(1);
    });
    it("cannot split one canonical receipt past its available amount under concurrent allocation", async () => {
      const f = await fixture();
      const a = await issued(f),
        b = await issued(f),
        receipt = await value(f, "payment", 10000);
      const results = await Promise.allSettled([
        allocateInvoiceValue(f.org, f.actor, a.id, {
          ...command(a),
          valueEntryId: receipt.id,
          amountCents: 7000,
        }),
        allocateInvoiceValue(f.org, f.actor, b.id, {
          ...command(b),
          valueEntryId: receipt.id,
          amountCents: 7000,
        }),
      ]);
      expect(
        results.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);
      expect(
        await db
          .select()
          .from(invoiceReceiptAllocationsTable)
          .where(eq(invoiceReceiptAllocationsTable.valueEntryId, receipt.id)),
      ).toHaveLength(1);
    });
  },
);
