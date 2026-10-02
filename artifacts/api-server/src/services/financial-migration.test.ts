import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import {
  activitiesTable,
  auditEventsTable,
  contactsTable,
  customerLifecycleTable,
  db,
  invoiceReceiptAllocationsTable,
  invoiceSequencesTable,
  invoicesTable,
  leadsTable,
  organizationsTable,
  usersTable,
  valueEntriesTable,
} from "@workspace/db";
import {
  financialMigrationItemsTable as items,
  financialMigrationReviewsTable as reviews,
} from "../../../../lib/db/src/schema/financial-migration";
import { financialSourceFixture } from "../test-helpers/financial-migration-fixture";
import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";
import {
  commitFinancialMigration,
  getFinancialMigration,
  previewFinancialMigration,
} from "./financial-migration";
import {
  allocateInvoiceValue,
  createInvoice,
  getInvoice,
  issueInvoice,
  recordInvoicePayment,
  reverseInvoiceAllocation,
} from "./invoices";
import { recordValueEntry, valueLedger } from "./revenue-workspace";
import { lockContractorSchedule } from "./contractor-scheduling";
import { createCustomerLifecycleExporter } from "./customer-lifecycle-export";

const orgs: string[] = [];
async function fixture(
  basis: "full_history" | "opening_receivable" = "full_history",
) {
  const [org] = await db
    .insert(organizationsTable)
    .values({
      name: "Synthetic financial migration",
      slug: `financial-${randomUUID()}`,
    })
    .returning();
  orgs.push(org!.id);
  const [actor] = await db
    .insert(usersTable)
    .values({
      organizationId: org!.id,
      role: "owner",
      isActive: true,
      emailVerifiedAt: new Date(),
    })
    .returning();
  const [contact] = await db
    .insert(contactsTable)
    .values({
      organizationId: org!.id,
      firstName: "Synthetic",
      lastName: "Customer",
      email: "fixture@example.invalid",
    })
    .returning();
  const [lead] = await db
    .insert(leadsTable)
    .values({
      organizationId: org!.id,
      contactId: contact!.id,
      creationMethod: "import",
    })
    .returning();
  return {
    org: org!.id,
    actor: actor!.id,
    contact: contact!.id,
    lead: lead!.id,
    source: financialSourceFixture(lead!.id, basis),
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function preview(f: Fixture, source = f.source) {
  const result = await previewFinancialMigration(f.org, f.actor, {
    sourceJson: JSON.stringify(source),
  });
  expect(result, JSON.stringify(result)).toHaveProperty("valid", true);
  if (!result.valid) throw new Error("Preview failed");
  return result.review;
}
const commit = (f: Fixture, r: Awaited<ReturnType<typeof preview>>) =>
  commitFinancialMigration(f.org, f.actor, r.id, {
    expectedDigest: r.digest,
    confirmed: true,
    sourceFrozen: true,
  });
afterAll(async () => {
  await deleteTestOrgs(...orgs);
});
describe("reviewed historical financial migration", () => {
  it("previews without financial effects then atomically imports original document and evidenced partial receipt", async () => {
    const f = await fixture(),
      p = await preview(f);
    expect(
      await db
        .select()
        .from(invoicesTable)
        .where(eq(invoicesTable.organizationId, f.org)),
    ).toHaveLength(0);
    const result = await commit(f, p);
    expect(result.state).toBe("committed");
    expect(result.result).toMatchObject({
      importedInvoices: 1,
      importedReceipts: 1,
      providerEffect: false,
    });
    const id = (result.result!.invoiceIds as string[])[0]!;
    const detail = await getInvoice(f.org, f.actor, id);
    expect(detail).toMatchObject({
      invoiceNumber: "OLD-0001",
      issuedAt: "2026-08-01T12:00:00.000Z",
      recordedPaidCents: 3000,
      recordedBalanceCents: 7000,
      historicalSource: { externalId: "source-invoice-1" },
    });
    expect(detail.document).toEqual(f.source.invoices[0]!.document);
    expect((await valueLedger(f.org)).netReceiptsCents).toBe(3000);
    const activities = await db
      .select()
      .from(activitiesTable)
      .where(eq(activitiesTable.organizationId, f.org));
    expect(activities.every((a) => a.type === "invoice_event")).toBe(true);
    expect(
      await db
        .select()
        .from(leadsTable)
        .where(eq(leadsTable.organizationId, f.org)),
    ).toHaveLength(1);
  });
  it("keeps opening A/R separate from cash and accepts only later evidenced receipts/refunds", async () => {
    const f = await fixture("opening_receivable"),
      result = await commit(f, await preview(f));
    const id = (result.result!.invoiceIds as string[])[0]!;
    let detail = await getInvoice(f.org, f.actor, id);
    expect(detail).toMatchObject({
      totalCents: 10000,
      openingReceivableCents: 7000,
      recordedPaidCents: 0,
      balanceDueCents: 7000,
    });
    expect((await valueLedger(f.org)).receiptEntryCount).toBe(0);
    await expect(
      recordInvoicePayment(f.org, f.actor, id, {
        requestId: randomUUID(),
        expectedVersion: 1,
        confirmed: true,
        amountCents: 1000,
        sourceReference: "historical-receipt",
        occurredAt: "2026-08-25T00:00:00Z",
      }),
    ).rejects.toMatchObject({ code: "invoice_opening_cutoff" });
    detail = (
      await recordInvoicePayment(f.org, f.actor, id, {
        requestId: randomUUID(),
        expectedVersion: 1,
        confirmed: true,
        amountCents: 2000,
        sourceReference: "later-payment",
        occurredAt: "2026-09-02T00:00:00Z",
      })
    ).invoice;
    expect(detail).toMatchObject({
      recordedPaidCents: 2000,
      balanceDueCents: 5000,
    });
    const refund = await recordValueEntry(f.org, f.actor, {
      leadId: f.lead,
      sourceReference: "later-refund",
      kind: "refund",
      amountCents: 500,
      occurredAt: "2026-09-03T00:00:00Z",
      confirmed: true,
    });
    detail = (
      await allocateInvoiceValue(f.org, f.actor, id, {
        requestId: randomUUID(),
        expectedVersion: detail.version,
        confirmed: true,
        valueEntryId: refund.id,
        amountCents: 500,
      })
    ).invoice;
    expect(detail).toMatchObject({
      recordedPaidCents: 1500,
      balanceDueCents: 5500,
    });
    const payment = detail.allocations.find((a) => a.kind === "payment")!;
    await expect(
      reverseInvoiceAllocation(f.org, f.actor, id, payment.id, {
        requestId: randomUUID(),
        expectedVersion: detail.version,
        confirmed: true,
        reason: "Cannot remove backing cash before refund",
      }),
    ).rejects.toMatchObject({ code: "invoice_payment_conflict" });
  });
  it("deduplicates lost acknowledgement, reformatted files and new reviews without replacing later work", async () => {
    const f = await fixture(),
      p = await preview(f),
      first = await commit(f, p);
    expect((await commit(f, p)).result).toEqual(first.result);
    const next = await previewFinancialMigration(f.org, f.actor, {
      sourceJson: JSON.stringify(f.source, null, 2),
    });
    if (!next.valid) throw Error("Expected duplicate preview");
    const again = await commit(f, next.review);
    expect(again.result).toMatchObject({
      importedInvoices: 0,
      importedReceipts: 0,
      duplicateInvoices: 1,
      duplicateReceipts: 1,
    });
    expect(
      await db
        .select()
        .from(valueEntriesTable)
        .where(eq(valueEntriesTable.organizationId, f.org)),
    ).toHaveLength(1);
    f.source.receipts[0]!.evidence =
      "Different history with the same transaction identity";
    expect(
      await previewFinancialMigration(f.org, f.actor, {
        sourceJson: JSON.stringify(f.source),
      }),
    ).toMatchObject({ valid: false });
  });
  it("rejects stale mapping, wrong digest, expired review and another reviewer", async () => {
    const f = await fixture(),
      p = await preview(f);
    await expect(
      commitFinancialMigration(f.org, f.actor, p.id, {
        expectedDigest: "a".repeat(64),
        confirmed: true,
        sourceFrozen: true,
      }),
    ).rejects.toMatchObject({ code: "financial_review_changed" });
    await db
      .update(contactsTable)
      .set({ firstName: "Changed", updatedAt: new Date() })
      .where(eq(contactsTable.id, f.contact));
    await expect(commit(f, p)).rejects.toMatchObject({
      code: "financial_mapping_changed",
    });
    const fresh = await preview(f);
    await db
      .update(reviews)
      .set({ expiresAt: new Date(0) })
      .where(eq(reviews.id, fresh.id));
    await expect(commit(f, fresh)).rejects.toMatchObject({
      code: "financial_review_expired",
    });
    const [admin] = await db
      .insert(usersTable)
      .values({
        organizationId: f.org,
        role: "admin",
        emailVerifiedAt: new Date(),
      })
      .returning();
    await expect(
      getFinancialMigration(f.org, admin!.id, p.id),
    ).rejects.toMatchObject({ status: 404 });
  });
  it("binds the review to current Date-valued record versions even when displayed names do not change", async () => {
    const f = await fixture(),
      p = await preview(f);
    await db
      .update(leadsTable)
      .set({ updatedAt: new Date(Date.now() + 1000) })
      .where(eq(leadsTable.id, f.lead));
    await expect(commit(f, p)).rejects.toMatchObject({
      code: "financial_mapping_changed",
    });
  });
  it("imports one shared receipt on two same-opportunity invoices; reordering does not duplicate it", async () => {
    const f = await fixture(),
      second = structuredClone(f.source.invoices[0]!);
    second.externalId = "source-invoice-2";
    second.invoiceNumber = "OLD-0002";
    f.source.invoices.push(second);
    f.source.receipts[0]!.amountCents = 6000;
    f.source.receipts[0]!.allocations.push({
      externalInvoiceId: second.externalId,
      amountCents: 3000,
    });
    f.source.controlTotals = {
      invoiceCount: 2,
      documentTotalCents: 20000,
      openingReceivableCents: 0,
      balanceDueCents: 14000,
      paymentCents: 6000,
      refundCents: 0,
    };
    await commit(f, await preview(f));
    f.source.invoices.reverse();
    f.source.receipts[0]!.allocations.reverse();
    expect((await commit(f, await preview(f))).result).toMatchObject({
      importedInvoices: 0,
      importedReceipts: 0,
      duplicateReceipts: 1,
    });
    expect((await valueLedger(f.org)).netReceiptsCents).toBe(6000);
    expect(
      await db
        .select()
        .from(invoiceReceiptAllocationsTable)
        .where(eq(invoiceReceiptAllocationsTable.organizationId, f.org)),
    ).toHaveLength(2);
  });
  it("preserves evidenced historical refunds and later immutable allocation corrections on duplicate replay", async () => {
    const f = await fixture();
    f.source.receipts.push({
      ...structuredClone(f.source.receipts[0]!),
      externalId: "source-refund-1",
      kind: "refund",
      amountCents: 500,
      allocations: [
        { externalInvoiceId: "source-invoice-1", amountCents: 500 },
      ],
    });
    f.source.invoices[0]!.balanceAtCutoffCents = 7500;
    f.source.controlTotals.balanceDueCents = 7500;
    f.source.controlTotals.refundCents = 500;
    const result = await commit(f, await preview(f)),
      id = (result.result!.invoiceIds as string[])[0]!;
    let detail = await getInvoice(f.org, f.actor, id);
    expect(detail).toMatchObject({
      recordedPaidCents: 2500,
      balanceDueCents: 7500,
    });
    const refund = detail.allocations.find((a) => a.kind === "refund")!;
    detail = (
      await reverseInvoiceAllocation(f.org, f.actor, id, refund.id, {
        requestId: randomUUID(),
        expectedVersion: detail.version,
        confirmed: true,
        reason: "Staff reconciled allocation separately from cash",
      })
    ).invoice;
    expect(detail.reconciliationRequired).toBe(true);
    await commit(f, await preview(f));
    expect(
      (await getInvoice(f.org, f.actor, id)).allocations.find(
        (a) => a.id === refund.id,
      )?.reversedAt,
    ).not.toBeNull();
    expect((await valueLedger(f.org)).netReceiptsCents).toBe(2500);
  });
  it("rechecks direct role, inactive membership, tenant mappings and company holds", async () => {
    const f = await fixture(),
      other = await fixture(),
      p = await preview(f);
    await expect(
      getFinancialMigration(other.org, other.actor, p.id),
    ).rejects.toMatchObject({ status: 404 });
    f.source.invoices[0]!.leadId = other.lead;
    f.source.receipts[0]!.leadId = other.lead;
    await expect(
      previewFinancialMigration(f.org, f.actor, {
        sourceJson: JSON.stringify(f.source),
      }),
    ).rejects.toMatchObject({ code: "financial_mapping_unavailable" });
    await db
      .update(usersTable)
      .set({ role: "office" })
      .where(eq(usersTable.id, f.actor));
    await expect(commit(f, p)).rejects.toMatchObject({ status: 403 });
    await db
      .update(usersTable)
      .set({ role: "owner", isActive: false })
      .where(eq(usersTable.id, f.actor));
    await expect(commit(f, p)).rejects.toMatchObject({ status: 403 });
    await db
      .update(usersTable)
      .set({ isActive: true })
      .where(eq(usersTable.id, f.actor));
    await db
      .insert(customerLifecycleTable)
      .values({
        organizationId: f.org,
        state: "paused",
        reason: "Synthetic pause",
      });
    await expect(commit(f, p)).rejects.toMatchObject({
      code: "financial_company_held",
    });
  });
  it("preserves historical native-format numbers and advances the same sequence without renaming", async () => {
    const f = await fixture();
    f.source.invoices[0]!.invoiceNumber = "INV-000040";
    await commit(f, await preview(f));
    const {
      subtotalCents: _s,
      totalCents: _t,
      lineItems,
      ...doc
    } = f.source.invoices[0]!.document;
    const draft = await createInvoice(f.org, f.actor, {
      requestId: randomUUID(),
      leadId: f.lead,
      document: {
        ...doc,
        lineItems: lineItems.map(({ totalCents: _l, ...line }) => line),
      },
    });
    const next = await issueInvoice(f.org, f.actor, draft.invoice.id, {
      requestId: randomUUID(),
      expectedVersion: 1,
      confirmed: true,
    });
    expect(next.invoice.invoiceNumber).toBe("INV-000041");
    f.source.invoices[0]!.externalId = "another-source-id";
    f.source.receipts[0]!.allocations[0]!.externalInvoiceId =
      "another-source-id";
    expect(
      await previewFinancialMigration(f.org, f.actor, {
        sourceJson: JSON.stringify(f.source),
      }),
    ).toMatchObject({ valid: false });
  });
  it("denies unverified and outstanding invited financial managers on reads and commit", async () => {
    const f = await fixture(),
      p = await preview(f);
    await db
      .update(usersTable)
      .set({ emailVerifiedAt: null })
      .where(eq(usersTable.id, f.actor));
    await expect(commit(f, p)).rejects.toMatchObject({
      code: "financial_manager_required",
    });
    await expect(
      getFinancialMigration(f.org, f.actor, p.id),
    ).rejects.toMatchObject({ code: "financial_manager_required" });
    const [invite] = await db
      .insert(usersTable)
      .values({
        id: `invite:${randomUUID()}`,
        organizationId: f.org,
        role: "owner",
        isActive: true,
        emailVerifiedAt: new Date(),
      })
      .returning();
    await expect(
      previewFinancialMigration(f.org, invite!.id, {
        sourceJson: JSON.stringify(f.source),
      }),
    ).rejects.toMatchObject({ code: "financial_manager_required" });
  });
  it("rolls back invoice, receipt, identity, numbering and audits after final reconciliation failure", async () => {
    const f = await fixture();
    f.source.invoices[0]!.invoiceNumber = "INV-000070";
    const p = await preview(f);
    await recordValueEntry(f.org, f.actor, {
      leadId: f.lead,
      sourceReference: "unallocated-existing-refund",
      kind: "refund",
      amountCents: 10,
      occurredAt: "2026-08-03T00:00:00Z",
      confirmed: true,
    });
    await expect(commit(f, p)).rejects.toMatchObject({
      code: "financial_reconciliation_failed",
    });
    for (const table of [invoicesTable, items, invoiceSequencesTable])
      expect(
        await db.select().from(table).where(eq(table.organizationId, f.org)),
      ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(valueEntriesTable)
        .where(eq(valueEntriesTable.organizationId, f.org)),
    ).toHaveLength(1);
    expect(
      await db
        .select()
        .from(auditEventsTable)
        .where(
          and(
            eq(auditEventsTable.organizationId, f.org),
            eq(auditEventsTable.action, "financial_migration.committed"),
          ),
        ),
    ).toHaveLength(0);
    expect((await getFinancialMigration(f.org, f.actor, p.id)).state).toBe(
      "review",
    );
  });
  it("rejects cross-tenant review and target mapping inserts at the database boundary", async () => {
    const f = await fixture(),
      other = await fixture(),
      p = await preview(f),
      committed = await commit(f, p);
    const invoiceId = (committed.result!.invoiceIds as string[])[0]!;
    await expect(
      db
        .insert(reviews)
        .values({
          organizationId: other.org,
          actorUserId: f.actor,
          rawSha256: "x",
          digest: "x",
          contextDigest: "x",
          payload: {},
          expiresAt: new Date(),
        }),
    ).rejects.toThrow();
    await expect(
      db
        .insert(items)
        .values({
          organizationId: other.org,
          reviewId: p.id,
          sourceSystem: "test",
          sourceAccount: "test",
          entityType: "invoice",
          externalId: "foreign",
          digest: "x",
          invoiceId,
        }),
    ).rejects.toThrow();
  });
  it("exports the non-cash basis, original document and source identities without raw approvals or extra cash", async () => {
    const f = await fixture("opening_receivable"),
      p = await preview(f);
    await commit(f, p);
    const output = await createCustomerLifecycleExporter()(f.org, f.actor);
    expect(output.data.invoices![0]).toMatchObject({
      invoice_number: "OLD-0001",
      balance_basis: "opening_receivable",
      opening_receivable_cents: 7000,
      historical_source: {
        sourceSystem: "synthetic",
        sourceAccount: "sample-account",
        externalId: "source-invoice-1",
      },
      issued_document: { totalCents: 10000 },
    });
    expect(output.data.value_entries).toHaveLength(0);
    expect(output.data.financial_migration_items).toHaveLength(1);
    expect(output.data).not.toHaveProperty("financial_migration_reviews");
    expect(JSON.stringify(output.data)).not.toContain(p.id);
    expect(JSON.stringify(output.data)).not.toContain(f.actor);
  });
});
describe.skipIf(process.env.SCHEDULER_TEST_BACKEND === "pglite")(
  "independent PostgreSQL migration commits",
  () => {
    it("claims each source invoice/receipt once across separate approvals", async () => {
      const f = await fixture(),
        a = await preview(f),
        b = await preview(f);
      await Promise.all([commit(f, a), commit(f, b)]);
      expect(
        await db
          .select()
          .from(invoicesTable)
          .where(eq(invoicesTable.organizationId, f.org)),
      ).toHaveLength(1);
      expect(
        await db
          .select()
          .from(valueEntriesTable)
          .where(eq(valueEntriesTable.organizationId, f.org)),
      ).toHaveLength(1);
      expect(
        await db
          .select()
          .from(invoiceReceiptAllocationsTable)
          .where(eq(invoiceReceiptAllocationsTable.organizationId, f.org)),
      ).toHaveLength(1);
    });
    it("shares lifecycle-before-schedule order with service-watch without deadlocking", async () => {
      const f = await fixture(),
        p = await preview(f);
      let release!: () => void, held!: () => void;
      const releaseSignal = new Promise<void>((resolve) => {
        release = resolve;
      });
      const heldSignal = new Promise<void>((resolve) => {
        held = resolve;
      });
      const watch = db.transaction(async (tx) => {
        await tx.execute(sql`select set_config('lock_timeout','3000ms',true)`);
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`customer-lifecycle:${f.org}`},0))`,
        );
        held();
        await releaseSignal;
        await lockContractorSchedule(tx, f.org);
      });
      await heldSignal;
      const migration = commit(f, p);
      // Yield so the other session attempts its first lock while lifecycle is held.
      try {
        await new Promise((resolve) => setTimeout(resolve, 50));
      } finally {
        release();
      }
      await Promise.all([watch, migration]);
      expect((await getFinancialMigration(f.org, f.actor, p.id)).state).toBe(
        "committed",
      );
    });
  },
);
