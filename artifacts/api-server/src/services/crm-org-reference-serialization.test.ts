import { randomUUID } from "node:crypto";
import { afterAll, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  appointmentsTable,
  contactsTable,
  db,
  leadsTable,
  organizationsTable,
  propertiesTable,
  usersTable,
} from "@workspace/db";
import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";
import { createAppointment, validateOrgRefs } from "./crm";
import { createManualScheduledAppointment } from "./manual-scheduling";
import { getSchedulingReviewContext } from "./scheduling-policy";

const orgs: string[] = [];
afterAll(async () => { await deleteTestOrgs(...orgs); });

async function fixture() {
  const [org] = await db.insert(organizationsTable).values({
    name: "Synthetic serialized CRM references", slug: randomUUID(), timezone: "UTC",
  }).returning();
  orgs.push(org.id);
  const [owner, staff] = await db.insert(usersTable).values([
    { organizationId: org.id, role: "owner", emailVerifiedAt: new Date() },
    { organizationId: org.id, role: "office", emailVerifiedAt: new Date() },
  ]).returning();
  const [contact] = await db.insert(contactsTable).values({
    organizationId: org.id, firstName: "Synthetic customer",
  }).returning();
  const [property] = await db.insert(propertiesTable).values({
    organizationId: org.id, contactId: contact.id, addressLine1: "1 Synthetic Lane",
    city: "Synthetic City", state: "GA", postalCode: "00000",
  }).returning();
  const [lead] = await db.insert(leadsTable).values({
    organizationId: org.id, contactId: contact.id, propertyId: property.id,
  }).returning();
  return { org, owner, staff, contact, property, lead,
    refs: { contactId: contact.id, propertyId: property.id, leadId: lead.id, assignedUserId: staff.id } };
}

// This file's first booking runs in a fresh Vitest fork: pg emits this notice once per process.
it("commits a native three-reference booking without queueing concurrent queries on its transaction client", async () => {
  const warnings: Error[] = [];
  const onWarning = (warning: Error) => {
    if (warning.name === "DeprecationWarning" &&
        warning.message.startsWith("Calling client.query() when the client is already executing a query")) {
      warnings.push(warning);
    }
  };
  process.on("warning", onWarning);
  try {
    const f = await fixture();
    const actor = { organizationId: f.org.id, userId: f.owner.id };
    const context = await getSchedulingReviewContext(actor, {
      sourceKind: "direct_customer", sourceId: f.contact.id, propertyId: f.property.id,
      reservationKind: "appointment", appointmentType: "other",
    });
    const result = await createManualScheduledAppointment(actor, {
      kind: "appointment_create", operationId: randomUUID(),
      body: { contactId: f.contact.id, propertyId: f.property.id, assignedUserId: f.staff.id,
        type: "other", scheduledStart: "2035-01-02T15:00:00.000Z", scheduledEnd: "2035-01-02T16:00:00.000Z" },
      review: { context, duration: { kind: "explicit", preset: null }, startWallTime: null, endWallTime: null },
    });
    expect(result.ack.outcome).toBe("committed");
    const [saved] = await db.select().from(appointmentsTable).where(eq(appointmentsTable.id, result.record!.id));
    expect(saved).toMatchObject({ organizationId: f.org.id, contactId: f.contact.id,
      propertyId: f.property.id, assignedUserId: f.staff.id, status: "scheduled" });
    // Node warning delivery is asynchronous; allow pending delivery before checking it.
    await new Promise<void>(resolve => setImmediate(resolve));
    console.info("CRM_ORG_REFS_WARNING_CAPTURE", JSON.stringify({ pid: process.pid, warningCount: warnings.length }));
    expect(warnings.map(warning => warning.message)).toEqual([]);
  } finally {
    process.off("warning", onWarning);
  }
});

it("validates all four same-company refs and preserves omitted refs on the real transaction and pool", async () => {
  const f = await fixture();
  await db.transaction(async tx => {
    expect(await validateOrgRefs(f.org.id, f.refs, tx)).toBe(true);
    expect(await validateOrgRefs(f.org.id, {}, tx)).toBe(true);
    expect(await validateOrgRefs(f.org.id, { contactId: null, propertyId: null, leadId: null, assignedUserId: null }, tx)).toBe(true);
  });
  expect(await validateOrgRefs(f.org.id, f.refs)).toBe(true);
});

it.each(["contactId", "propertyId", "leadId", "assignedUserId"] as const)(
  "refuses foreign-company %s without committing a native appointment",
  async key => {
    const f = await fixture(), foreign = await fixture();
    const refs = { ...f.refs, [key]: foreign.refs[key] };
    expect(await db.transaction(tx => validateOrgRefs(f.org.id, refs, tx))).toBe(false);
    expect(await createAppointment(f.org.id, { ...refs, type: "other",
      scheduledStart: new Date("2035-01-02T15:00:00.000Z"), scheduledEnd: new Date("2035-01-02T16:00:00.000Z") })).toBeNull();
    expect(await db.select().from(appointmentsTable).where(eq(appointmentsTable.organizationId, f.org.id))).toHaveLength(0);
  },
);

it("preserves missing-ref and inactive-assignee refusals on the same transaction", async () => {
  const f = await fixture();
  for (const key of ["contactId", "propertyId", "leadId", "assignedUserId"] as const) {
    expect(await db.transaction(tx => validateOrgRefs(f.org.id, { ...f.refs, [key]: randomUUID() }, tx))).toBe(false);
  }
  await db.update(usersTable).set({ isActive: false }).where(eq(usersTable.id, f.staff.id));
  expect(await db.transaction(tx => validateOrgRefs(f.org.id, f.refs, tx))).toBe(false);
  expect(await createAppointment(f.org.id, { ...f.refs, type: "other",
    scheduledStart: new Date("2035-01-02T15:00:00.000Z"), scheduledEnd: new Date("2035-01-02T16:00:00.000Z") })).toBeNull();
});
