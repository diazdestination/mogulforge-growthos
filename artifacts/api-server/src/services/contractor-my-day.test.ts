import { randomUUID } from "node:crypto";
import {
  appointmentsTable,
  contactsTable,
  db,
  leadsTable,
  organizationsTable,
  propertiesTable,
  usersTable,
  zapierActionExecutionsTable,
} from "@workspace/db";
import { companyDayBounds } from "@workspace/scheduling-core";
import { afterAll, describe, expect, it } from "vitest";

import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";
import { getMyDay } from "./contractor-my-day";
import { createInvoice, issueInvoice } from "./invoices";

const ZONE = "America/Chicago";
const DATE = "2026-11-11";
const HOUR = 60 * 60_000;
const orgs: string[] = [];
afterAll(async () => {
  await deleteTestOrgs(...orgs);
});

async function company() {
  const [org] = await db.insert(organizationsTable).values({ name: "Synthetic My Day Co", slug: `test-my-day-${randomUUID()}`, timezone: ZONE }).returning();
  orgs.push(org!.id);
  const [owner] = await db.insert(usersTable).values({ organizationId: org!.id, role: "owner", firstName: "Avery", emailVerifiedAt: new Date() }).returning();
  const [tech] = await db.insert(usersTable).values({ organizationId: org!.id, role: "production", firstName: "Sam", emailVerifiedAt: new Date() }).returning();
  const [contact] = await db.insert(contactsTable).values({ organizationId: org!.id, firstName: "Dana", lastName: "Reyes", phone: "+15125550142" }).returning();
  const [property] = await db.insert(propertiesTable).values({ organizationId: org!.id, contactId: contact!.id, addressLine1: "12 Oak St", city: "Austin", state: "TX", postalCode: "78701" }).returning();
  const [lead] = await db.insert(leadsTable).values({ organizationId: org!.id, contactId: contact!.id, propertyId: property!.id, assignedUserId: owner!.id }).returning();
  const dayStart = Date.parse(companyDayBounds(DATE, ZONE).from);
  const visit = async (userId: string | null, offsetHours: number, overrides: Partial<typeof appointmentsTable.$inferInsert> = {}) =>
    (await db.insert(appointmentsTable).values({
      organizationId: org!.id, leadId: lead!.id, contactId: contact!.id, propertyId: property!.id, assignedUserId: userId,
      scheduledStart: new Date(dayStart + offsetHours * HOUR), scheduledEnd: new Date(dayStart + (offsetHours + 2) * HOUR), notes: "Side gate code is with the office.", ...overrides,
    }).returning())[0]!;
  return { orgId: org!.id, owner: owner!, tech: tech!, contact: contact!, property: property!, lead: lead!, visit };
}

describe("GET /contractor/my-day service", () => {
  it("lists only my assigned appointments for today and the next few days, with what the tech needs at the door", async () => {
    const f = await company();
    const mine = await f.visit(f.tech.id, 9);
    await f.visit(f.owner.id, 10); // someone else's job
    await f.visit(null, 11); // unassigned
    await f.visit(f.tech.id, 12, { status: "cancelled" });
    const tomorrow = await f.visit(f.tech.id, 24 + 9);
    await f.visit(f.tech.id, 24 * 10); // outside the window
    await db.insert(zapierActionExecutionsTable).values({
      organizationId: f.orgId, specialistId: "appt", capability: "appt.sms.on_my_way", direction: "write", zapierApp: "OpenPhoneCLIAPI", zapierAction: "send_message",
      idempotencyKey: `appt-omw:${mine.id}:${DATE}`, requestDigest: "a".repeat(64), requestSummary: { toPhone: "+15125550142", etaMinutes: 15 }, state: "pending_approval", detail: "Waiting.",
      linkedEntityType: "appointment_on_my_way", linkedEntityId: mine.id,
    });

    const day = await getMyDay(f.orgId, f.tech.id, { date: DATE });
    expect(day).toMatchObject({ organizationId: f.orgId, userId: f.tech.id, date: DATE, timeZone: ZONE, canReadInvoices: false, canCollectPayments: false, texting: { onMyWay: false, payLink: false } });
    expect(day.today.map((job) => job.id)).toEqual([mine.id]);
    expect(day.upcoming.map((job) => job.id)).toEqual([tomorrow.id]);
    expect(day.today[0]).toMatchObject({
      customerName: "Dana Reyes",
      customerPhone: "+15125550142",
      address: "12 Oak St, Austin, TX 78701",
      directionsUrl: `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent("12 Oak St, Austin, TX 78701")}`,
      notes: "Side gate code is with the office.",
      invoices: null,
      onMyWay: { state: "pending_approval", etaMinutes: 15 },
    });
    expect(day.upcoming[0]!.onMyWay).toBeNull();
  });

  it("shows the customer's issued invoice balance to members who may read invoices", async () => {
    const f = await company();
    await f.visit(f.owner.id, 9);
    const draft = (await createInvoice(f.orgId, f.owner.id, {
      requestId: randomUUID(), leadId: f.lead.id,
      document: { title: "Synthetic repair", currency: "USD", issuerName: "Synthetic My Day Co", customerName: "Dana Reyes", lineItems: [{ description: "Agreed work", quantity: "1", unitPriceCents: 25000 }], taxCents: 0 },
    })).invoice;
    const issued = (await issueInvoice(f.orgId, f.owner.id, draft.id, { requestId: randomUUID(), expectedVersion: draft.version, confirmed: true })).invoice;
    const day = await getMyDay(f.orgId, f.owner.id, { date: DATE });
    expect(day).toMatchObject({ canReadInvoices: true, canCollectPayments: true });
    expect(day.today[0]!.invoices).toEqual([
      { id: issued.id, invoiceNumber: issued.invoiceNumber, title: "Synthetic repair", totalCents: 25000, balanceDueCents: 25000, paymentState: "unpaid" },
    ]);
  });

  it("is tenant isolated and never shows a property owned by a different customer", async () => {
    const a = await company();
    const b = await company();
    await a.visit(a.tech.id, 9);
    expect((await getMyDay(b.orgId, b.tech.id, { date: DATE })).today).toEqual([]);
    await expect(getMyDay(a.orgId, b.tech.id, { date: DATE })).rejects.toMatchObject({ status: 403 });

    const [stranger] = await db.insert(contactsTable).values({ organizationId: a.orgId, firstName: "Other" }).returning();
    const [elsewhere] = await db.insert(propertiesTable).values({ organizationId: a.orgId, contactId: stranger!.id, addressLine1: "99 Elm St", city: "Austin", state: "TX", postalCode: "78702" }).returning();
    const mismatched = await a.visit(a.tech.id, 14, { propertyId: elsewhere!.id });
    const job = (await getMyDay(a.orgId, a.tech.id, { date: DATE })).today.find((item) => item.id === mismatched.id)!;
    expect(job).toMatchObject({ address: null, directionsUrl: null, propertyId: null });
  });
});
