import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  contactsTable,
  crmTasksTable,
  db,
  invoiceOperationsTable,
  invoiceReceiptAllocationsTable,
  invoicesTable,
  leadsTable,
  organizationsTable,
  serviceObligationsTable,
  usersTable,
  valueEntriesTable,
  type InvoiceDocument,
} from "@workspace/db";
import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";
import { createCustomerLifecycleExporter } from "./customer-lifecycle-export";

const secret = `DO_NOT_EXPORT_${randomUUID()}`;
const tenants: {
  org: string;
  owner: string;
  contact: string;
  lead: string;
  invoice: string;
  value: string;
  allocation: string;
  obligation: string;
}[] = [];
const document = {
  title: "Synthetic service",
  currency: "USD",
  issuerName: "Synthetic contractor",
  issuerAddress: null,
  customerName: "Synthetic customer",
  customerAddress: null,
  dueDate: "2026-11-01",
  notes: null,
  lineItems: [
    {
      description: "Service",
      quantity: "1.5",
      unitPriceCents: 1000,
      totalCents: 1500,
      privateToken: secret,
    },
  ],
  subtotalCents: 1500,
  taxCents: 0,
  totalCents: 1500,
  privateToken: secret,
} as unknown as InvoiceDocument;
beforeAll(async () => {
  for (const label of ["A", "B"]) {
    const [org] = await db
      .insert(organizationsTable)
      .values({
        name: `Native export ${label}`,
        slug: `native-export-${randomUUID()}`,
      })
      .returning();
    const [owner] = await db
      .insert(usersTable)
      .values({ organizationId: org.id, role: "owner" })
      .returning();
    const [contact] = await db
      .insert(contactsTable)
      .values({ organizationId: org.id, firstName: `Customer ${label}` })
      .returning();
    const [lead] = await db
      .insert(leadsTable)
      .values({ organizationId: org.id, contactId: contact.id })
      .returning();
    const [invoice] = await db
      .insert(invoicesTable)
      .values({
        organizationId: org.id,
        leadId: lead.id,
        createdByUserId: owner.id,
        status: "issued",
        version: 3,
        invoiceNumber: "INV-000001",
        draftDocument: document,
        issuedDocument: document,
        issuedDocumentSha256: createHash("sha256")
          .update(JSON.stringify(document))
          .digest("hex"),
        issuedAt: new Date(),
      })
      .returning();
    await db
      .update(invoicesTable)
      .set({
        issuedDocumentSha256: createHash("sha256")
          .update(JSON.stringify(invoice.issuedDocument))
          .digest("hex"),
      })
      .where(eq(invoicesTable.id, invoice.id));
    const [value] = await db
      .insert(valueEntriesTable)
      .values({
        organizationId: org.id,
        leadId: lead.id,
        recordedByUserId: owner.id,
        sourceReference: `synthetic-${randomUUID()}`,
        kind: "payment",
        amountCents: 1000,
        occurredAt: new Date(),
      })
      .returning();
    const [allocation] = await db
      .insert(invoiceReceiptAllocationsTable)
      .values({
        organizationId: org.id,
        invoiceId: invoice.id,
        valueEntryId: value.id,
        actorUserId: owner.id,
        kind: "payment",
        amountCents: 1000,
      })
      .returning();
    await db
      .insert(invoiceReceiptAllocationsTable)
      .values({
        organizationId: org.id,
        invoiceId: invoice.id,
        valueEntryId: value.id,
        actorUserId: owner.id,
        kind: "reversal",
        amountCents: 1000,
        reversesAllocationId: allocation.id,
        reason: "Synthetic allocation correction",
      });
    await db
      .insert(invoiceOperationsTable)
      .values({
        organizationId: org.id,
        invoiceId: invoice.id,
        actorUserId: owner.id,
        requestId: randomUUID(),
        fingerprint: secret,
        action: "issue",
        version: 2,
      });
    const [task, nextTask] = await db
      .insert(crmTasksTable)
      .values([
        {
          organizationId: org.id,
          contactId: contact.id,
          title: "Prior service",
          status: "done",
        },
        {
          organizationId: org.id,
          contactId: contact.id,
          title: "Next service",
        },
      ])
      .returning();
    const recurrence = {
      mode: "calendar_months" as const,
      intervalMonths: 6,
      anchorDate: "2026-01-31",
      endDate: null,
      agreementNote: "Customer-approved synthetic agreement",
      approvedByUserId: owner.id,
      approvedAt: new Date().toISOString(),
      privateToken: secret,
    };
    const [obligation] = await db
      .insert(serviceObligationsTable)
      .values({
        organizationId: org.id,
        contactId: contact.id,
        taskId: task.id,
        kind: "service_plan",
        equipmentLabel: "Synthetic heat pump",
        dueAt: new Date("2026-01-31T12:00:00Z"),
        status: "completed",
        recurrence,
        coverageStartsOn: "2026-01-01",
        coverageEndsOn: "2027-01-01",
        coverageEvidence: "Synthetic written agreement",
      })
      .returning();
    await db
      .insert(serviceObligationsTable)
      .values({
        organizationId: org.id,
        contactId: contact.id,
        taskId: nextTask.id,
        kind: "service_plan",
        equipmentLabel: "Synthetic heat pump",
        dueAt: new Date("2026-07-31T12:00:00Z"),
        recurrence,
        predecessorObligationId: obligation.id,
        occurrenceIndex: 1,
      });
    tenants.push({
      org: org.id,
      owner: owner.id,
      contact: contact.id,
      lead: lead.id,
      invoice: invoice.id,
      value: value.id,
      allocation: allocation.id,
      obligation: obligation.id,
    });
  }
}, 20000);
afterAll(async () => {
  await deleteTestOrgs(...tenants.map((t) => t.org));
});

describe("native contractor customer export", () => {
  it("preserves issued documents, cash references, reversals and recurring-service links without staff or retry secrets", async () => {
    const t = tenants[0],
      result = await createCustomerLifecycleExporter()(t.org, t.owner),
      encoded = JSON.stringify(result);
    expect(result.manifest.tables).toHaveLength(28);
    expect(result.manifest.tables.map(row=>row.table)).toContain("customer_work_roots");
    expect(result.manifest.tables.map(row=>row.table)).not.toContain("customer_work_commands");
    expect(result.data.invoices[0]).toMatchObject({
      id: t.invoice,
      invoice_number: "INV-000001",
      status: "issued",
      issued_document: { totalCents: 1500 },
    });
    expect(result.data.value_entries).toHaveLength(1);
    expect(result.data.invoice_receipt_allocations).toHaveLength(2);
    expect(
      result.data.invoice_receipt_allocations.find(
        (row) => row.kind === "reversal",
      ),
    ).toMatchObject({
      reverses_allocation_id: t.allocation,
      value_entry_id: t.value,
    });
    expect(result.data.service_obligations).toHaveLength(2);
    expect(
      result.data.service_obligations.find(
        (row) => row.predecessor_obligation_id,
      ),
    ).toMatchObject({
      predecessor_obligation_id: t.obligation,
      occurrence_index: 1,
    });
    for (const canary of [
      secret,
      t.owner,
      tenants[1].org,
      tenants[1].contact,
      tenants[1].invoice,
      "privateToken",
      "approvedByUserId",
    ])
      expect(encoded).not.toContain(canary);
    expect(JSON.stringify(result.data)).not.toContain("fingerprint");
    expect(result.manifest.exclusions.join(" ")).toContain("not a cash refund");
    expect(result.manifest.dataSha256).toBe(
      createHash("sha256").update(JSON.stringify(result.data)).digest("hex"),
    );
    expect(result.data.invoices[0].exported_issued_document_sha256).toBe(
      createHash("sha256")
        .update(JSON.stringify(result.data.invoices[0].issued_document))
        .digest("hex"),
    );
    expect(
      result.manifest.tables.find((row) => row.table === "invoices")?.fields,
    ).toContain("exported_issued_document_sha256");
  });
  it("withholds foreign financial parents and invalid recurrence ancestors transitively", async () => {
    const t = tenants[0],
      foreign = tenants[1];
    await db
      .insert(invoicesTable)
      .values({
        organizationId: t.org,
        leadId: foreign.lead,
        createdByUserId: t.owner,
        draftDocument: document,
      });
    await db
      .insert(invoiceReceiptAllocationsTable)
      .values({
        organizationId: t.org,
        invoiceId: foreign.invoice,
        valueEntryId: t.value,
        actorUserId: t.owner,
        kind: "payment",
        amountCents: 100,
      });
    const [invalidTask, childTask] = await db
      .insert(crmTasksTable)
      .values([
        { organizationId: t.org, title: "Invalid service parent" },
        { organizationId: t.org, title: "Invalid service child" },
      ])
      .returning();
    const [invalid] = await db
      .insert(serviceObligationsTable)
      .values({
        organizationId: t.org,
        contactId: foreign.contact,
        taskId: invalidTask.id,
        kind: "maintenance",
        equipmentLabel: "INVALID_SERVICE",
        dueAt: new Date("2026-01-01"),
      })
      .returning();
    await db
      .insert(serviceObligationsTable)
      .values({
        organizationId: t.org,
        contactId: t.contact,
        taskId: childTask.id,
        predecessorObligationId: invalid.id,
        kind: "maintenance",
        equipmentLabel: "INVALID_CHILD",
        dueAt: new Date("2026-02-01"),
      });
    const result = await createCustomerLifecycleExporter()(t.org, t.owner);
    expect(result.data.invoices).toHaveLength(1);
    expect(result.data.invoice_receipt_allocations).toHaveLength(2);
    expect(result.data.service_obligations).toHaveLength(2);
    expect(
      result.manifest.tables.find((row) => row.table === "invoices")
        ?.withheldInvalidLinks,
    ).toBe(1);
    expect(
      result.manifest.tables.find(
        (row) => row.table === "invoice_receipt_allocations",
      )?.withheldInvalidLinks,
    ).toBe(1);
    expect(
      result.manifest.tables.find((row) => row.table === "service_obligations")
        ?.withheldInvalidLinks,
    ).toBe(2);
    for (const canary of [
      foreign.lead,
      foreign.contact,
      foreign.invoice,
      "INVALID_SERVICE",
      "INVALID_CHILD",
      invalid.id,
    ])
      expect(JSON.stringify(result)).not.toContain(canary);
  });
  it("refuses to export a tampered issued snapshot as a valid invoice", async () => {
    const t = tenants[1];
    const [before] = await db
      .select()
      .from(invoicesTable)
      .where(eq(invoicesTable.id, t.invoice));
    await db
      .update(invoicesTable)
      .set({ issuedDocument: { ...before.issuedDocument!, totalCents: 1 } })
      .where(eq(invoicesTable.id, t.invoice));
    try {
      await expect(
        createCustomerLifecycleExporter()(t.org, t.owner),
      ).rejects.toMatchObject({
        status: 503,
        code: "customer_export_unavailable",
      });
    } finally {
      await db
        .update(invoicesTable)
        .set({ issuedDocument: before.issuedDocument })
        .where(eq(invoicesTable.id, t.invoice));
    }
  });
});
