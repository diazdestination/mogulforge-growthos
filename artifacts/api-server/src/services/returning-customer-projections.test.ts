import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import {
  db,
  crmTasksTable,
  leadsTable,
  valueEntriesTable,
} from "@workspace/db";
import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";
import {
  acceptedReturningEstimate,
  returningCustomerFixture,
  returningInvoiceDocument,
  returningProjectDraft,
} from "../test-helpers/returning-customer-fixture";
import { createCustomerWorkProject } from "./returning-customer";
import {
  createInvoice,
  issueInvoice,
  recordInvoicePayment,
  recordInvoiceRefund,
} from "./invoices";
import {
  getCustomerWorkspace,
  getCustomerWorkspaceSection,
} from "./customer-workspace";
import { getContractorToday } from "./contractor-today";
import { valueLedger, projectGrowth } from "./revenue-workspace";
import { createCustomerLifecycleExporter } from "./customer-lifecycle-export";

const orgs: string[] = [];
let f: Awaited<ReturnType<typeof returningCustomerFixture>>, other: typeof f;
let estimateId: string,
  projectId: string,
  secondProjectId: string,
  invoiceId: string,
  paymentId: string,
  rootId: string;
beforeAll(async () => {
  f = await returningCustomerFixture();
  other = await returningCustomerFixture();
  orgs.push(f.org, other.org);
  const accepted = await acceptedReturningEstimate(f, f.secondProperty.id);
  estimateId = accepted.estimate.id;
  rootId = accepted.estimate.customerWorkId!;
  const project = await createCustomerWorkProject(f.org, f.actor, {
    ...returningProjectDraft(f),
    status: "completed",
    source: {
      kind: "estimate",
      estimateId,
      expectedWorkVersion: accepted.estimate.workVersion,
    },
  });
  projectId = project.project.id;
  const second = await createCustomerWorkProject(
    f.org,
    f.actor,
    returningProjectDraft(f, f.firstProperty.id),
  );
  secondProjectId = second.project.id;
  const created = await createInvoice(
    f.org,
    f.owner.id,
    {
      requestId: randomUUID(),
      source: { kind: "customer_work", customerWorkId: rootId },
      projectId,
      document: returningInvoiceDocument(10000),
    },
    "owner",
  );
  invoiceId = created.invoice.id;
  const issued = await issueInvoice(
    f.org,
    f.owner.id,
    invoiceId,
    {
      requestId: randomUUID(),
      expectedVersion: created.invoice.version,
      confirmed: true,
    },
    "owner",
  );
  const paid = await recordInvoicePayment(
    f.org,
    f.owner.id,
    invoiceId,
    {
      requestId: randomUUID(),
      expectedVersion: issued.invoice.version,
      confirmed: true,
      amountCents: 5000,
      sourceReference: `projection-payment-${randomUUID()}`,
      occurredAt: new Date(Date.now() - 1000).toISOString(),
    },
    "owner",
  );
  paymentId = paid.invoice.allocations.find(
    (row) => row.kind === "payment",
  )!.valueEntryId;
  await recordInvoiceRefund(
    f.org,
    f.owner.id,
    invoiceId,
    {
      requestId: randomUUID(),
      expectedVersion: paid.invoice.version,
      confirmed: true,
      originalPaymentValueEntryId: paymentId,
      amountCents: 1000,
      sourceReference: `projection-refund-${randomUUID()}`,
      occurredAt: new Date(Date.now() - 500).toISOString(),
      reason: "Staff recorded an actual external refund correction.",
    },
    "owner",
  );
}, 20000);
afterAll(async () => {
  await deleteTestOrgs(...orgs);
});
describe("returning work across native read surfaces", () => {
  it("retains the same nine customer sections and native property lineage without exposing billing to a viewer", async () => {
    const header = await getCustomerWorkspace(
      f.org,
      f.owner.id,
      f.contact.id,
      "owner",
    );
    expect(header.availableSections).toHaveLength(9);
    const estimate = await getCustomerWorkspaceSection(
      f.org,
      f.owner.id,
      f.contact.id,
      { section: "estimates" },
    );
    expect(estimate.items).toEqual([
      expect.objectContaining({
        id: estimateId,
        leadId: null,
        customerWorkId: rootId,
        workVersion: 2,
        property: expect.objectContaining({ id: f.secondProperty.id }),
      }),
    ]);
    const projects = await getCustomerWorkspaceSection(
      f.org,
      f.owner.id,
      f.contact.id,
      { section: "projects" },
    );
    expect(projects.items.map((row) => row.id).sort()).toEqual(
      [projectId, secondProjectId].sort(),
    );
    const invoice = await getCustomerWorkspaceSection(
      f.org,
      f.owner.id,
      f.contact.id,
      { section: "invoices" },
    );
    expect(invoice.items).toEqual([
      expect.objectContaining({
        id: invoiceId,
        leadId: null,
        customerWorkId: rootId,
        projectId,
        estimateId,
      }),
    ]);
    await expect(
      getCustomerWorkspaceSection(
        f.org,
        f.viewer.id,
        f.contact.id,
        { section: "invoices" },
        "viewer",
      ),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      getCustomerWorkspaceSection(f.org, f.owner.id, other.contact.id, {
        section: "projects",
      }),
    ).rejects.toMatchObject({ status: 404 });
  });
  it("shows the actual customer in Today and preserves the original completed preparation task", async () => {
    const today = await getContractorToday(f.org, f.owner.id, {
      scope: "company",
    });
    expect(
      today.projects.items.find((row) => row.id === secondProjectId),
    ).toMatchObject({
      leadId: null,
      contactId: f.contact.id,
      customerWorkId: expect.any(String),
      customerLabel: "Synthetic Returning Customer",
    });
    const [task] = await db
      .select()
      .from(crmTasksTable)
      .where(
        and(
          eq(crmTasksTable.organizationId, f.org),
          eq(
            crmTasksTable.sourceEvent,
            `project.invoice_preparation:${projectId}`,
          ),
        ),
      );
    expect(task).toMatchObject({
      leadId: null,
      contactId: f.contact.id,
      status: "done",
    });
    expect(task.description).toBeTruthy();
  });
  it("counts cash once under business work while acquisition and public story approval remain absent", async () => {
    const ledger = await valueLedger(f.org);
    expect(ledger).toMatchObject({
      entryCount: 2,
      netReceiptsCents: 4000,
      acceptedEstimateCount: 1,
      completedProjectCount: 1,
      recordedContributionCents: null,
    });
    expect(ledger.sourceBreakdown).toEqual([
      {
        source: "lead",
        entryCount: 0,
        netReceiptsCents: 0,
        netDirectCostsCents: 0,
      },
      {
        source: "customer_work",
        entryCount: 2,
        netReceiptsCents: 4000,
        netDirectCostsCents: 0,
      },
    ]);
    expect(
      ledger.entries.every(
        (row) =>
          row.customerWorkId === rootId &&
          row.contactId === f.contact.id &&
          row.leadId === null,
      ),
    ).toBe(true);
    expect(
      await db
        .select()
        .from(leadsTable)
        .where(eq(leadsTable.organizationId, f.org)),
    ).toHaveLength(0);
    expect((await projectGrowth(f.org)).projects).toHaveLength(0);
    expect(ledger.boundary).toMatch(/not newly acquired or recovered/);
  });
  it("exports usable business lineage and original cash/document history, never command authority", async () => {
    const exported = await createCustomerLifecycleExporter()(f.org, f.owner.id);
    expect(exported.data.customer_work_roots).toHaveLength(2);
    expect(exported.data.estimates[0]).toMatchObject({
      id: estimateId,
      lead_id: null,
      customer_work_id: rootId,
      work_version: 2,
    });
    expect(exported.data.invoices[0]).toMatchObject({
      id: invoiceId,
      customer_work_id: rootId,
      project_id: projectId,
      estimate_id: estimateId,
    });
    expect(exported.data.value_entries).toHaveLength(2);
    expect(exported.data.invoice_receipt_allocations).toHaveLength(2);
    expect(exported.data).not.toHaveProperty("customer_work_commands");
    expect(JSON.stringify(exported.data)).not.toMatch(
      /payload_sha256|actor_user_id|request_id|preview_id/,
    );
  });
  it.each(["over_refund", "non_payment_parent", "before_payment"] as const)(
    "blocks the whole ledger for %s rather than publishing valid-looking partial money",
    async (mode) => {
      const isolated = await returningCustomerFixture();
      orgs.push(isolated.org);
      const project = await createCustomerWorkProject(
        isolated.org,
        isolated.actor,
        returningProjectDraft(isolated),
      );
      const root = project.project.customerWorkId!;
      const [parent] = await db
        .insert(valueEntriesTable)
        .values({
          organizationId: isolated.org,
          leadId: null,
          customerWorkId: root,
          kind: mode === "non_payment_parent" ? "direct_cost" : "payment",
          amountCents: 10000,
          sourceReference: `projection-original-${randomUUID()}`,
          recordedByUserId: isolated.owner.id,
          occurredAt: new Date(),
        })
        .returning();
      for (const amount of mode === "over_refund" ? [1000, 10000] : [1000])
        await db
          .insert(valueEntriesTable)
          .values({
            organizationId: isolated.org,
            leadId: null,
            customerWorkId: root,
            refundOfValueEntryId: parent.id,
            kind: "refund",
            amountCents: amount,
            sourceReference: `projection-invalid-${randomUUID()}`,
            recordedByUserId: isolated.owner.id,
            occurredAt: new Date(
              mode === "before_payment" ? Date.now() - 86400000 : Date.now(),
            ),
          });
      await expect(valueLedger(isolated.org)).rejects.toMatchObject({
        status: 409,
      });
      await expect(
        valueLedger(isolated.org, {
          startAt: "2026-01-01T00:00:00Z",
          endAt: "2026-02-01T00:00:00Z",
          timeZone: "UTC",
        }),
      ).rejects.toMatchObject({ status: 409 });
    },
  );
  it("withholds an incoherent physical property graph rather than exposing another customer's work", async () => {
    await db.execute(
      sql`UPDATE properties SET contact_id=${f.otherContact.id} WHERE id=${f.secondProperty.id} AND organization_id=${f.org}`,
    );
    try {
      const projects = await getCustomerWorkspaceSection(
        f.org,
        f.owner.id,
        f.contact.id,
        { section: "projects" },
      );
      expect(projects.items.map((row) => row.id)).toEqual([secondProjectId]);
      await expect(valueLedger(f.org)).rejects.toMatchObject({ status: 409 });
    } finally {
      await db.execute(
        sql`UPDATE properties SET contact_id=${f.contact.id} WHERE id=${f.secondProperty.id} AND organization_id=${f.org}`,
      );
    }
  });
});
