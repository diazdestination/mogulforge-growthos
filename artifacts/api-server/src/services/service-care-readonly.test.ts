import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  auditEventsTable, contactsTable, db, organizationsTable, orgSettingsTable,
  pool, propertiesTable, serviceObligationsTable, usersTable,
} from "@workspace/db";
import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";
import { appointmentCustomer, type ScheduleTransaction } from "./contractor-scheduling";
import { assertSchedulingActor } from "./scheduling-policy";
import { getServiceCare, type ServiceCareReadOptions } from "./service-care";
import { serviceCareSchedulingReadSchema } from "./service-care-policy";
import { createServiceObligation } from "./service-obligations";

// No provider is configured for these synthetic records. All database queries,
// transaction modes, authorization checks and source reads are real PostgreSQL.
vi.mock("./customer-email", () => ({
  resolveCustomerEmailSender: vi.fn().mockRejectedValue(new Error("Synthetic disconnected sender")),
  sendCustomerEmail: vi.fn(),
}));

const orgs: string[] = [];
const transaction = db.transaction.bind(db);
afterAll(async () => { await deleteTestOrgs(...orgs); });

async function fixture() {
  const [org] = await db.insert(organizationsTable).values({ name: "Synthetic Care Reader", slug: `care-reader-${randomUUID()}`, timezone: "UTC" }).returning();
  orgs.push(org.id);
  const [actor] = await db.insert(usersTable).values({ organizationId: org.id, role: "owner", emailVerifiedAt: new Date() }).returning();
  const [contact] = await db.insert(contactsTable).values({ organizationId: org.id, firstName: "Synthetic Reader Customer", email: "reader@example.invalid" }).returning();
  const [property] = await db.insert(propertiesTable).values({ organizationId: org.id, contactId: contact.id, addressLine1: "1 Synthetic Way", city: "Test", state: "CA", postalCode: "90000" }).returning();
  await db.insert(orgSettingsTable).values({ organizationId: org.id, sendingHours: { quietHoursEnabled: false } });
  const obligation = await createServiceObligation(org.id, actor.id, { contactId: contact.id, propertyId: property.id, kind: "maintenance", equipmentLabel: "Synthetic system", dueDate: "2035-01-01", noticeDays: 14 });
  if ("error" in obligation) throw new Error(obligation.error);
  return { org: org.id, actor: actor.id, contact: contact.id, property: property.id, obligation };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function readOnly<T>(callback: (tx: ScheduleTransaction) => Promise<T>) {
  return transaction(async tx => {
    const state = await tx.execute(sql`SELECT current_setting('transaction_read_only') AS read_only, current_setting('transaction_isolation') AS isolation`);
    expect(state.rows[0]).toMatchObject({ read_only: "on", isolation: "read committed" });
    return callback(tx);
  }, { accessMode: "read only" });
}
async function readOnlyCare(f: Fixture, options: ServiceCareReadOptions = { actorUserId: f.actor, appointmentType: "other" }, org = f.org) {
  // Route only the service's transaction into a real READ ONLY transaction.
  // The original pool/session configuration is never changed; restore even on failure.
  const routing = vi.spyOn(db, "transaction").mockImplementation(callback => readOnly(callback));
  try { return await getServiceCare(org, f.obligation.id, "email", options); }
  finally { routing.mockRestore(); }
}

describe("service Care on a genuine read-only PostgreSQL transaction", () => {
  it("preserves legacy Care/history and actor/source identity while withholding writable review", async () => {
    const f = await fixture();
    const metadata = { requestId: randomUUID().toUpperCase(), note: "Original synthetic history", outcome: "follow_up" };
    await db.insert(auditEventsTable).values({ organizationId: f.org, actorUserId: f.actor, entityType: "service_obligation", entityId: f.obligation.id, action: "service.care_response_recorded", metadata });
    const options = { actorUserId: f.actor, appointmentType: "other" as const };
    const { scheduling: ready, ...legacy } = await getServiceCare(f.org, f.obligation.id, "email", options);
    expect(ready.review.state).toBe("ready");
    const { scheduling, ...readLegacy } = await readOnlyCare(f, options);
    expect(readLegacy).toEqual(legacy);
    expect(serviceCareSchedulingReadSchema.parse(scheduling)).toEqual({
      ...ready,
      review: { state: "held", code: "scheduling_reader_required", message: expect.any(String) },
    });
    expect(scheduling).toMatchObject({ actorUserId: f.actor, source: { contactId: f.contact, propertyId: f.property } });
    expect(scheduling.review).not.toHaveProperty("context");
    expect(scheduling.review).not.toHaveProperty("policy");
    expect((await getServiceCare(f.org, f.obligation.id, "email", options)).scheduling.review.state).toBe("ready");
  });

  it("supports the existing actorless held read and a verified viewer's crm.read permission", async () => {
    const f = await fixture();
    expect((await readOnlyCare(f, {})).scheduling).toMatchObject({ actorUserId: null, review: { state: "held", code: "scheduling_reader_required" } });
    await db.update(usersTable).set({ role: "viewer" }).where(eq(usersTable.id, f.actor));
    expect((await readOnlyCare(f)).scheduling.actorUserId).toBe(f.actor);
  });

  it.each(["inactive", "unverified", "invited", "foreign", "missing"] as const)("rejects %s actors without suppressing authorization failures", async kind => {
    const f = await fixture();
    let actor = f.actor;
    if (kind === "inactive") await db.update(usersTable).set({ isActive: false }).where(eq(usersTable.id, actor));
    if (kind === "unverified") await db.update(usersTable).set({ emailVerifiedAt: null }).where(eq(usersTable.id, actor));
    if (kind === "invited") {
      actor = `invite:${randomUUID()}`;
      await db.insert(usersTable).values({ id: actor, organizationId: f.org, role: "owner", emailVerifiedAt: new Date() });
    }
    if (kind === "foreign") actor = (await fixture()).actor;
    if (kind === "missing") actor = randomUUID();
    await expect(readOnlyCare(f, { actorUserId: actor })).rejects.toMatchObject({ code: "scheduling_access_denied", status: 403 });
  });

  it.each(["foreign_obligation", "foreign_contact", "foreign_property", "other_customer_property"] as const)("rejects %s source lineage in read-only mode", async kind => {
    const f = await fixture(), other = await fixture();
    if (kind === "foreign_obligation") {
      await expect(readOnlyCare(f, { actorUserId: other.actor }, other.org)).rejects.toMatchObject({ code: "not_found", status: 404 });
      return;
    }
    if (kind === "foreign_contact") await db.update(serviceObligationsTable).set({ contactId: other.contact }).where(eq(serviceObligationsTable.id, f.obligation.id));
    if (kind === "foreign_property") await db.update(serviceObligationsTable).set({ propertyId: other.property }).where(eq(serviceObligationsTable.id, f.obligation.id));
    if (kind === "other_customer_property") {
      const [contact] = await db.insert(contactsTable).values({ organizationId: f.org, firstName: "Other synthetic customer" }).returning();
      await db.update(propertiesTable).set({ contactId: contact.id }).where(eq(propertiesTable.id, f.property));
    }
    await expect(readOnlyCare(f)).rejects.toMatchObject({ code: kind === "foreign_contact" ? "not_found" : "customer_reference_mismatch" });
  });

  it("proves real PostgreSQL write denial and guards each internal nonlocking mode", async () => {
    const f = await fixture();
    await expect(readOnly(tx => tx.execute(sql`UPDATE users SET is_active=false WHERE id=${f.actor}`))).rejects.toMatchObject({ cause: { code: "25006" } });
    await expect(transaction(tx => assertSchedulingActor(tx, { organizationId: f.org, userId: f.actor }, "crm.read", false, { readOnly: true }))).rejects.toThrow("read-only transaction");
    await expect(transaction(tx => appointmentCustomer(tx, f.org, f.obligation, { readOnly: true }))).rejects.toThrow("read-only transaction");
    await db.update(usersTable).set({ role: "viewer" }).where(eq(usersTable.id, f.actor));
    await expect(readOnly(tx => assertSchedulingActor(tx, { organizationId: f.org, userId: f.actor }, "crm.write", false, { readOnly: true }))).rejects.toMatchObject({ code: "scheduling_access_denied" });
  });

  it.each(["actor", "contact", "property"] as const)("retains ordinary %s SHARE locking on a writable transaction", async kind => {
    const f = await fixture();
    const contender = await pool.connect();
    try {
      await transaction(async tx => {
        await assertSchedulingActor(tx, { organizationId: f.org, userId: f.actor }, "crm.read");
        await appointmentCustomer(tx, f.org, f.obligation);
        await contender.query("BEGIN");
        await contender.query("SET LOCAL lock_timeout='100ms'");
        const [table, id] = kind === "actor" ? ["users", f.actor] : kind === "contact" ? ["contacts", f.contact] : ["properties", f.property];
        await expect(contender.query(`SELECT id FROM ${table} WHERE id=$1 FOR UPDATE`, [id])).rejects.toMatchObject({ code: "55P03" });
        await contender.query("ROLLBACK");
      });
    } finally { await contender.query("ROLLBACK"); contender.release(); }
  });
});
