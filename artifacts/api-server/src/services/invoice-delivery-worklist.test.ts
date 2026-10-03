import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  activitiesTable,
  auditEventsTable,
  contactsTable,
  db,
  invoicesTable,
  leadsTable,
  organizationsTable,
  revenueExecutionsTable,
  usersTable,
  type UserRole,
} from "@workspace/db";
import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";
import { createInvoice, issueInvoice } from "./invoices";
import { listInvoiceDeliveryWorklist } from "./invoice-delivery-worklist";
import * as kernel from "./invoice-delivery-attempts";
import * as email from "./customer-email";

const orgs: string[] = [];
async function fixture() {
  const target = new URL(process.env.DATABASE_URL ?? "");
  if (
    process.env.NODE_ENV !== "test" ||
    !["localhost", "127.0.0.1"].includes(target.hostname) ||
    !(
      target.pathname.endsWith("_test") ||
      (process.env.SCHEDULER_TEST_BACKEND === "pglite" &&
        target.pathname === "/postgres")
    )
  )
    throw new Error("Use the guarded isolated runner");
  const [org] = await db
    .insert(organizationsTable)
    .values({
      name: "Synthetic invoice worklist",
      slug: `invoice-list-${randomUUID()}`,
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
      email: "customer@example.invalid",
    })
    .returning();
  const [lead] = await db
    .insert(leadsTable)
    .values({ organizationId: org!.id, contactId: contact!.id })
    .returning();
  return { org: org!.id, actor: actor!.id, lead: lead!.id };
}
async function create(
  f: Awaited<ReturnType<typeof fixture>>,
  issued = true,
  title = "Synthetic worklist bill",
) {
  const draft = (
    await createInvoice(f.org, f.actor, {
      requestId: randomUUID(),
      leadId: f.lead,
      document: {
        title,
        currency: "USD",
        issuerName: "Synthetic contractor",
        customerName: "Synthetic customer",
        lineItems: [
          { description: "Work", quantity: "1", unitPriceCents: 10000 },
        ],
        taxCents: 0,
      },
    })
  ).invoice;
  return issued
    ? (
        await issueInvoice(f.org, f.actor, draft.id, {
          requestId: randomUUID(),
          expectedVersion: draft.version,
          confirmed: true,
        })
      ).invoice
    : draft;
}
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  await deleteTestOrgs(...orgs);
});

describe("SELECT-only canonical invoice delivery pages", () => {
  it("returns only company invoice metadata and canonical batch eligibility, without provider or write effects", async () => {
    const f = await fixture(),
      other = await fixture(),
      invoice = await create(f);
    await create(other);
    const auditBefore = await db
      .select()
      .from(auditEventsTable)
      .where(eq(auditEventsTable.organizationId, f.org));
    const invoiceBefore = await db
      .select()
      .from(invoicesTable)
      .where(eq(invoicesTable.organizationId, f.org));
    const resolve = vi.spyOn(email, "resolveCustomerEmailSender"),
      send = vi.spyOn(email, "sendCustomerEmail");
    const get = vi.spyOn(kernel, "getInvoiceDeliveryChains");
    const list = await listInvoiceDeliveryWorklist(f.org, f.actor, {});
    expect(list).toMatchObject({
      total: 1,
      page: 0,
      pageSize: 25,
      items: [
        {
          invoiceId: invoice.id,
          invoiceNumber: invoice.invoiceNumber,
          version: invoice.version,
          status: "issued",
          leadId: f.lead,
          projectId: null,
          delivery: {
            attemptCount: 0,
            maxAttempts: 5,
            latestExecutionId: null,
            nextIntents: ["initial"],
            integrity: "valid",
            latestAttempt: null,
          },
        },
      ],
    });
    expect(Object.keys(list.items[0]!).sort()).toEqual([
      "customerName",
      "delivery",
      "invoiceId",
      "invoiceNumber",
      "leadId",
      "projectId",
      "status",
      "title",
      "version",
    ]);
    expect(list.boundary).toContain("not all delivery exceptions");
    expect(get).toHaveBeenCalledExactlyOnceWith(f.org, [invoice.id]);
    expect(resolve).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(
      await db
        .select()
        .from(auditEventsTable)
        .where(eq(auditEventsTable.organizationId, f.org)),
    ).toEqual(auditBefore);
    expect(
      await db
        .select()
        .from(invoicesTable)
        .where(eq(invoicesTable.organizationId, f.org)),
    ).toEqual(invoiceBefore);
    expect(
      await db
        .select()
        .from(revenueExecutionsTable)
        .where(eq(revenueExecutionsTable.organizationId, f.org)),
    ).toEqual([]);
    expect(
      await db
        .select()
        .from(activitiesTable)
        .where(
          and(
            eq(activitiesTable.organizationId, f.org),
            eq(activitiesTable.type, "email_sent"),
          ),
        ),
    ).toEqual([]);
  });
  it("pages at 25 canonical invoices and applies only strict status/lead/project selectors", async () => {
    const f = await fixture();
    for (let index = 0; index < 26; index++)
      await create(f, false, `Synthetic bill ${index}`);
    const page0 = await listInvoiceDeliveryWorklist(f.org, f.actor, {
      status: "draft",
      page: "0",
      leadId: f.lead,
    });
    const page1 = await listInvoiceDeliveryWorklist(f.org, f.actor, {
      status: "draft",
      page: "1",
      leadId: f.lead,
    });
    expect(page0.total).toBe(26);
    expect(page0.items).toHaveLength(25);
    expect(page1.items).toHaveLength(1);
    expect(
      new Set([...page0.items, ...page1.items].map((row) => row.invoiceId))
        .size,
    ).toBe(26);
    expect(
      page0.items.every(
        (row) =>
          row.delivery.nextIntents.length === 0 &&
          row.delivery.attentionReason === "invoice_not_issued",
      ),
    ).toBe(true);
    expect(
      (await listInvoiceDeliveryWorklist(f.org, f.actor, { status: "issued" }))
        .total,
    ).toBe(0);
    expect(
      (
        await listInvoiceDeliveryWorklist(f.org, f.actor, {
          leadId: randomUUID(),
        })
      ).total,
    ).toBe(0);
    expect(
      (
        await listInvoiceDeliveryWorklist(f.org, f.actor, {
          projectId: randomUUID(),
        })
      ).total,
    ).toBe(0);
    for (const query of [
      { organizationId: randomUUID() },
      { scope: "all" },
      { limit: "1000" },
      { state: "uncertain" },
      { page: "-1" },
      { page: "10001" },
      { leadId: "bad" },
      { status: "accepted" },
      { page: ["0", "1"] },
    ])
      await expect(
        listInvoiceDeliveryWorklist(f.org, f.actor, query),
      ).rejects.toThrow();
  });
  it.each(["owner", "admin", "office", "sales_manager"] as UserRole[])(
    "allows accepted %s readers without granting a send approval",
    async (role) => {
      const f = await fixture();
      await create(f);
      await db
        .update(usersTable)
        .set({ role })
        .where(eq(usersTable.id, f.actor));
      expect(
        (await listInvoiceDeliveryWorklist(f.org, f.actor, {})).items,
      ).toHaveLength(1);
    },
  );
  it("denies unverified, inactive, invited, disallowed and cross-company actors", async () => {
    const f = await fixture(),
      other = await fixture();
    for (const change of [
      { emailVerifiedAt: null },
      { isActive: false },
      { role: "viewer" as const },
    ]) {
      await db
        .update(usersTable)
        .set({
          emailVerifiedAt: new Date(),
          isActive: true,
          role: "owner",
          ...change,
        })
        .where(eq(usersTable.id, f.actor));
      await expect(
        listInvoiceDeliveryWorklist(f.org, f.actor, {}),
      ).rejects.toMatchObject({ status: 403, code: "invoice_access_denied" });
    }
    const [invited] = await db
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
      listInvoiceDeliveryWorklist(f.org, invited!.id, {}),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      listInvoiceDeliveryWorklist(f.org, other.actor, {}),
    ).rejects.toMatchObject({ status: 403 });
  });
  it("never changes a missing or mismatched kernel row into a safe initial send", async () => {
    const f = await fixture(),
      invoice = await create(f);
    const chain = await kernel.getInvoiceDeliveryChain(f.org, invoice.id);
    const read = vi.spyOn(kernel, "getInvoiceDeliveryChains");
    read.mockResolvedValueOnce(new Map());
    await expect(
      listInvoiceDeliveryWorklist(f.org, f.actor, {}),
    ).rejects.toMatchObject({
      status: 503,
      code: "invoice_delivery_evidence_unavailable",
    });
    read.mockResolvedValueOnce(
      new Map([[invoice.id, { ...chain, invoiceId: randomUUID() }]]),
    );
    await expect(
      listInvoiceDeliveryWorklist(f.org, f.actor, {}),
    ).rejects.toMatchObject({ status: 503 });
    read.mockResolvedValueOnce(
      new Map([
        [
          invoice.id,
          {
            ...chain,
            integrity: "unavailable",
            nextIntents: [],
            attentionReason: "chain_evidence_unavailable",
          },
        ],
      ]),
    );
    expect(
      (await listInvoiceDeliveryWorklist(f.org, f.actor, {})).items[0]
        ?.delivery,
    ).toMatchObject({
      integrity: "unavailable",
      nextIntents: [],
      attentionReason: "chain_evidence_unavailable",
    });
  });
});
