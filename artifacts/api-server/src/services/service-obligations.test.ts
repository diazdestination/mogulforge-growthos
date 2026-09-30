import {
  contactsTable,
  crmTasksTable,
  db,
  leadsTable,
  organizationsTable,
  serviceObligationsTable,
  usersTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";
import {
  createServiceObligation,
  importServiceCustomers,
  listServiceObligations,
  parseServiceDate,
  updateServiceObligation,
} from "./service-obligations";

let orgA: string, orgB: string, actorA: string, actorB: string, contactA: string;
beforeAll(async () => {
  const [a] = await db.insert(organizationsTable).values({ name: "Service A", slug: `service-a-${randomUUID()}` }).returning();
  const [b] = await db.insert(organizationsTable).values({ name: "Service B", slug: `service-b-${randomUUID()}` }).returning();
  orgA = a.id; orgB = b.id;
  const [ua] = await db.insert(usersTable).values({ organizationId: orgA, role: "admin" }).returning();
  const [ub] = await db.insert(usersTable).values({ organizationId: orgB, role: "admin" }).returning();
  actorA = ua.id; actorB = ub.id;
  const [contact] = await db.insert(contactsTable).values({
    organizationId: orgA,
    firstName: "Existing",
    email: "existing@example.test",
    phone: "+12025550155",
    doNotContact: true,
  }).returning();
  contactA = contact.id;
});
afterAll(async () => {
  await deleteTestOrgs(orgA, orgB);
});

describe("service date and staff follow-up", () => {
  it("accepts explicit ISO/US dates but rejects rollover or ambiguous dates", () => {
    expect(parseServiceDate("2028-02-29")?.toISOString()).toBe("2028-02-29T12:00:00.000Z");
    expect(parseServiceDate("2/29/2028")?.toISOString()).toBe("2028-02-29T12:00:00.000Z");
    expect(parseServiceDate("2027-02-29")).toBeNull();
    expect(parseServiceDate("29/02/2028")).toBeNull();
  });

  it("creates an owned customer obligation and staff task, never a sales lead", async () => {
    const created = await createServiceObligation(orgA, actorA, {
      contactId: contactA,
      kind: "warranty_check",
      equipmentLabel: "Heat pump",
      dueDate: "2028-06-15",
      noticeDays: 30,
      source: "housecall-pro",
      externalRef: "plan-manual-1",
    });
    if ("error" in created) throw new Error(created.error);
    expect(created.status).toBe("active");
    const [task] = await db.select().from(crmTasksTable).where(eq(crmTasksTable.id, created.taskId));
    expect(task.sourceEvent).toBe("service.obligation_due");
    expect(task.contactId).toBe(contactA);
    expect(task.dueAt?.toISOString()).toBe("2028-05-16T12:00:00.000Z");
    expect(await db.select().from(leadsTable).where(eq(leadsTable.organizationId, orgA))).toHaveLength(0);
    expect((await listServiceObligations(orgB))).toHaveLength(0);
    expect(await updateServiceObligation(orgB, actorB, created.id, { status: "completed" })).toEqual({ error: "not_found" });
    expect(await createServiceObligation(orgB, actorB, {
      contactId: contactA, kind: "maintenance", equipmentLabel: "Wrong tenant", dueDate: "2028-06-15", noticeDays: 30,
    })).toEqual({ error: "contact_not_found" });

    const updated = await updateServiceObligation(orgA, actorA, created.id, { status: "completed" });
    if ("error" in updated) throw new Error(updated.error);
    expect(updated.completedAt).not.toBeNull();
    const [done] = await db.select().from(crmTasksTable).where(eq(crmTasksTable.id, created.taskId));
    expect(done.status).toBe("done");
  });
});

describe("customer/service CSV import", () => {
  const csv = [
    "First,Last,Email,Phone,Equipment,Kind,Due,External",
    "Existing,Customer,existing@example.test,+12025550155,Furnace,maintenance,2028-09-10,service-001",
    "New,Customer,new@example.test,+12025550156,Heat pump,service_plan,9/12/2028,service-002",
    "Bad,Date,bad@example.test,+12025550157,Furnace,maintenance,2/30/2028,service-003",
  ].join("\n");
  const input = {
    csv,
    mapping: { firstName: 0, lastName: 1, email: 2, phone: 3, equipmentLabel: 4, kind: 5, dueDate: 6, externalRef: 7 },
    hasHeader: true,
    source: "housecall-pro",
    noticeDays: 21,
  };

  it("previews without saving, then imports customers without consent or opportunities", async () => {
    const preview = await importServiceCustomers(orgA, actorA, { ...input, commit: false });
    expect(preview).toMatchObject({ preview: true, totalRows: 3, imported: 2, skipped: 1 });
    expect(await db.select().from(contactsTable).where(eq(contactsTable.email, "new@example.test"))).toHaveLength(0);
    expect(await db.select().from(serviceObligationsTable).where(eq(serviceObligationsTable.externalRef, "service-001"))).toHaveLength(0);

    const committed = await importServiceCustomers(orgA, actorA, { ...input, commit: true });
    expect(committed).toMatchObject({ preview: false, imported: 2, skipped: 1 });
    const [oldContact] = await db.select().from(contactsTable).where(eq(contactsTable.id, contactA));
    expect(oldContact.doNotContact).toBe(true);
    const [newContact] = await db.select().from(contactsTable).where(eq(contactsTable.email, "new@example.test"));
    expect(newContact.organizationId).toBe(orgA);
    expect(newContact.doNotContactSms).toBe(false);
    expect(await db.select().from(leadsTable).where(eq(leadsTable.organizationId, orgA))).toHaveLength(0);

    const repeated = await importServiceCustomers(orgA, actorA, { ...input, commit: true });
    expect(repeated).toMatchObject({ imported: 0, duplicates: 2, skipped: 1 });
    expect(await db.select().from(serviceObligationsTable).where(eq(serviceObligationsTable.externalRef, "service-001"))).toHaveLength(1);
  });
});
