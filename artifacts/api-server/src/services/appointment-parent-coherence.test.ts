import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { appointmentsTable, contactsTable, db, leadsTable, organizationsTable, pool, propertiesTable, scheduledActionsTable } from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";
import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";
import { createAppointment, updateAppointment, updateContact, updateLead, updateProperty } from "./crm";

let org: string, other: string;
const start = new Date("2035-08-01T14:00:00Z");
const end = new Date("2035-08-01T15:00:00Z");
beforeAll(async () => {
  const target = new URL(process.env.DATABASE_URL ?? "");
  if (process.env.NODE_ENV !== "test" || !["127.0.0.1", "localhost"].includes(target.hostname)) throw new Error("Use isolated test database");
  [org, other] = (await db.insert(organizationsTable).values([
    { name: "SYNTHETIC appointment parent coherence", slug: randomUUID() },
    { name: "SYNTHETIC foreign appointment parents", slug: randomUUID() },
  ]).returning()).map(row => row.id);
});
afterAll(async () => { await deleteTestOrgs(org, other); });

async function fixture(secondProperty = true) {
  const [a, b] = await db.insert(contactsTable).values([
    { organizationId: org, firstName: "Same customer name" },
    { organizationId: org, firstName: "Same customer name" },
  ]).returning();
  const propertyValues = { organizationId: org, contactId: a.id, addressLine1: "100 Synthetic Lane", city: "Example", state: "GA", postalCode: "00000" };
  const [property, wrong] = await db.insert(propertiesTable).values([propertyValues, { ...propertyValues, contactId: b.id }]).returning();
  const [second] = secondProperty ? await db.insert(propertiesTable).values({ ...propertyValues, addressLine1: "200 Synthetic Lane" }).returning() : [];
  return { a: a.id, b: b.id, property: property.id, wrong: wrong.id, second: second?.id ?? null };
}
const create = (refs: { contactId?: string | null; leadId?: string | null; propertyId?: string | null; notes?: string }) => createAppointment(org, {
  type: "other", scheduledStart: start, scheduledEnd: end, ...refs,
});
async function lead(contactId: string, propertyId: string | null = null, organizationId = org) {
  return (await db.insert(leadsTable).values({ organizationId, contactId, propertyId }).returning())[0];
}
async function counts() {
  return (await pool.query(`SELECT
    (SELECT count(*)::int FROM appointments WHERE organization_id=$1) AS appointments,
    (SELECT count(*)::int FROM scheduled_actions WHERE organization_id=$1 AND context->>'event'='appointment.reminder') AS reminders,
    (SELECT count(*)::int FROM leads WHERE organization_id=$1) AS leads`, [org])).rows[0] as { appointments: number; reminders: number; leads: number };
}
async function reminder(appointmentId: string) {
  return db.select().from(scheduledActionsTable).where(and(
    eq(scheduledActionsTable.organizationId, org),
    sql`${scheduledActionsTable.context}->>'appointmentId' = ${appointmentId}`,
    sql`${scheduledActionsTable.context}->>'event' = 'appointment.reminder'`,
  ));
}
function saved(value: Awaited<ReturnType<typeof createAppointment>>) {
  if (!value || typeof value === "string") throw new Error(`Unexpected create result: ${value}`);
  return value;
}

it("creates exactly one native visit and reminder for the explicitly selected property without an acquisition lead", async () => {
  const f = await fixture(), before = await counts();
  const appointment = saved(await create({ contactId: f.a, propertyId: f.second, notes: "Office chose the second worksite." }));
  expect(appointment).toMatchObject({ contactId: f.a, propertyId: f.second, leadId: null, notes: "Office chose the second worksite." });
  expect(await counts()).toEqual({ appointments: before.appointments + 1, reminders: before.reminders + 1, leads: before.leads });
  expect(await reminder(appointment.id)).toMatchObject([{ status: "pending", context: { appointmentId: appointment.id, contactId: f.a, event: "appointment.reminder" }, action: { type: "appointment_reminder" } }]);
});

it("keeps an explicit null or omitted worksite null even when the customer has exactly one property", async () => {
  const f = await fixture(false), before = await counts();
  for (const refs of [{ contactId: f.a, propertyId: null }, { contactId: f.a }]) {
    const appointment = saved(await create(refs));
    expect(appointment).toMatchObject({ contactId: f.a, propertyId: null, leadId: null });
    expect(await reminder(appointment.id)).toHaveLength(1);
  }
  expect(await counts()).toEqual({ appointments: before.appointments + 2, reminders: before.reminders + 2, leads: before.leads });
});

it("derives only the customer from a selected lead and never infers its property", async () => {
  const f = await fixture(), opportunity = await lead(f.a, f.property), before = await counts();
  const appointment = saved(await create({ leadId: opportunity.id, propertyId: null }));
  expect(appointment).toMatchObject({ contactId: f.a, leadId: opportunity.id, propertyId: null });
  expect(await reminder(appointment.id)).toHaveLength(1);
  expect(await counts()).toEqual({ appointments: before.appointments + 1, reminders: before.reminders + 1, leads: before.leads });
});

it("rejects wrong-customer and contradictory selected lead/property parents without creating work", async () => {
  const f = await fixture(), opportunity = await lead(f.a, f.property), before = await counts();
  for (const refs of [
    { contactId: f.a, propertyId: f.wrong },
    { contactId: f.b, leadId: opportunity.id, propertyId: f.wrong },
    { contactId: f.a, leadId: opportunity.id, propertyId: f.second },
    { propertyId: f.property },
  ]) await expect(create(refs)).rejects.toMatchObject({ code: "customer_reference_mismatch", status: 400 });
  expect(await counts()).toEqual(before);
});

it("rejects foreign or missing selected parents without an appointment or reminder", async () => {
  const f = await fixture();
  const [foreignContact] = await db.insert(contactsTable).values({ organizationId: other, firstName: "Same customer name" }).returning();
  const [foreignProperty] = await db.insert(propertiesTable).values({ organizationId: other, contactId: foreignContact.id, addressLine1: "100 Synthetic Lane", city: "Example", state: "GA", postalCode: "00000" }).returning();
  const foreignLead = await lead(foreignContact.id, foreignProperty.id, other), before = await counts();
  for (const refs of [
    { contactId: foreignContact.id, propertyId: null },
    { contactId: randomUUID(), propertyId: null },
    { contactId: f.a, propertyId: foreignProperty.id },
    { contactId: f.a, propertyId: randomUUID() },
    { leadId: foreignLead.id, propertyId: null },
    { leadId: randomUUID(), propertyId: null },
  ]) expect(await create(refs)).toBeNull();
  expect(await counts()).toEqual(before);
});

it("rejects a property reassigned by the actual CRM writer before booking", async () => {
  const f = await fixture(), before = await counts();
  expect(await updateProperty(org, f.property, { contactId: f.b })).toMatchObject({ contactId: f.b });
  await expect(create({ contactId: f.a, propertyId: f.property })).rejects.toMatchObject({ code: "customer_reference_mismatch" });
  expect(await counts()).toEqual(before);
});

it("rejects malformed lead ancestry even when no appointment property was selected", async () => {
  const f = await fixture();
  const [foreignContact] = await db.insert(contactsTable).values({ organizationId: other, firstName: "Foreign canonical customer" }).returning();
  const [foreignProperty] = await db.insert(propertiesTable).values({ organizationId: other, contactId: foreignContact.id, addressLine1: "Foreign synthetic worksite", city: "Example", state: "GA", postalCode: "00000" }).returning();
  // ID-only historical FKs permit these fixtures; new work may not adopt them.
  const malformed = [await lead(foreignContact.id), await lead(f.a, foreignProperty.id), await lead(f.a, f.wrong)];
  const before = await counts();
  for (const opportunity of malformed) await expect(create({ leadId: opportunity.id, propertyId: null })).rejects.toMatchObject({ code: "customer_reference_mismatch" });
  expect(await counts()).toEqual(before);
});

it("preserves historical property and ordinary note/status edits when an older lead named a different property", async () => {
  const f = await fixture(), opportunity = await lead(f.a, f.property);
  const [historical] = await db.insert(appointmentsTable).values({ organizationId: org, contactId: f.a, leadId: opportunity.id, propertyId: f.second,
    type: "other", status: "completed", scheduledStart: new Date("2020-01-01T14:00:00Z"), scheduledEnd: new Date("2020-01-01T15:00:00Z"), notes: "Original field notes; preserve worksite history." }).returning();
  const before = await counts();
  await create({ contactId: f.a, propertyId: null });
  expect((await db.select().from(appointmentsTable).where(eq(appointmentsTable.id, historical.id)))[0]).toEqual(historical);
  const edited = await updateAppointment(org, historical.id, { notes: "Office correction, same historical worksite.", expectedUpdatedAt: historical.updatedAt.toISOString() });
  expect(edited).toMatchObject({ id: historical.id, contactId: f.a, leadId: opportunity.id, propertyId: f.second, status: "completed", notes: "Office correction, same historical worksite." });
  expect(await updateAppointment(org, historical.id, { status: "no_show" })).toMatchObject({ propertyId: f.second, notes: "Office correction, same historical worksite.", status: "no_show" });
  expect(await reminder(historical.id)).toHaveLength(0);
  expect(await counts()).toEqual({ appointments: before.appointments + 1, reminders: before.reminders + 1, leads: before.leads });
});

// Only independent PostgreSQL backends can prove row-lock ordering. Never use
// PGlite's single backend as evidence that ordinary CRM writers waited.
const realPg = it.skipIf(process.env.SCHEDULER_TEST_BACKEND === "pglite");
async function blockedBy(blocker: number, queryPattern: string) {
  for (let attempt = 0; attempt < 300; attempt++) {
    const result = await pool.query("SELECT pid FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid)) AND query ILIKE $2", [blocker, queryPattern]);
    if (result.rows[0]) return Number(result.rows[0].pid);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error("Expected independent PostgreSQL appointment-parent lock was not observed");
}

realPg("retains selected lead/customer/property locks through native reminder insertion while actual CRM writers wait", async () => {
  const f = await fixture(), opportunity = await lead(f.a, f.property), before = await counts();
  const suffix = randomUUID().replaceAll("-", ""), hook = `qa_appointment_parent_${suffix}`, lock = `qa-appointment-parent-${suffix}`;
  const keeper = await pool.connect();
  let creating: ReturnType<typeof create> | undefined, moving: ReturnType<typeof updateProperty> | undefined;
  let editingContact: ReturnType<typeof updateContact> | undefined, editingLead: ReturnType<typeof updateLead> | undefined;
  try {
    // Freeze after the native appointment insert, while its original reminder
    // is about to be inserted in the same unmodified scheduling transaction.
    await pool.query(`CREATE FUNCTION ${hook}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.organization_id = '${org}'::uuid AND NEW.context->>'contactId' = '${f.a}' AND NEW.context->>'event' = 'appointment.reminder'
      THEN PERFORM pg_advisory_xact_lock(hashtext('${lock}')); END IF; RETURN NEW; END $$`);
    await pool.query(`CREATE TRIGGER ${hook} BEFORE INSERT ON scheduled_actions FOR EACH ROW EXECUTE FUNCTION ${hook}()`);
    await keeper.query("BEGIN");
    await keeper.query("SELECT pg_advisory_xact_lock(hashtext($1))", [lock]);
    const keeperPid = Number((await keeper.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
    creating = create({ contactId: f.a, leadId: opportunity.id, propertyId: f.property, notes: "Exact original selected worksite." });
    void creating.catch(() => {});
    const creatorPid = await blockedBy(keeperPid, '%insert into "scheduled_actions"%');
    moving = updateProperty(org, f.property, { contactId: f.b }); void moving.catch(() => {});
    editingContact = updateContact(org, f.a, { firstName: "Office changed the name" }); void editingContact.catch(() => {});
    editingLead = updateLead(org, opportunity.id, { propertyId: f.second }); void editingLead.catch(() => {});
    const writers = await Promise.all([
      blockedBy(creatorPid, '%from "properties"%for update%'), blockedBy(creatorPid, '%update "contacts"%'), blockedBy(creatorPid, '%update "leads"%'),
    ]);
    expect(new Set(writers).size).toBe(3);
    for (const writer of writers) expect(writer).not.toBe(creatorPid);
    expect(await counts()).toEqual(before);
    await keeper.query("COMMIT");
    const appointment = saved(await creating);
    expect(await moving).toMatchObject({ contactId: f.b });
    expect(await editingContact).toMatchObject({ firstName: "Office changed the name" });
    expect(await editingLead).toMatchObject({ propertyId: f.second });
    expect((await db.select().from(appointmentsTable).where(eq(appointmentsTable.id, appointment.id)))[0]).toMatchObject({ contactId: f.a, leadId: opportunity.id, propertyId: f.property, notes: "Exact original selected worksite." });
    expect(await reminder(appointment.id)).toHaveLength(1);
    expect(await counts()).toEqual({ appointments: before.appointments + 1, reminders: before.reminders + 1, leads: before.leads });
  } finally {
    await keeper.query("ROLLBACK"); keeper.release();
    await Promise.allSettled([creating, moving, editingContact, editingLead].filter(Boolean));
    await pool.query(`DROP TRIGGER IF EXISTS ${hook} ON scheduled_actions`);
    await pool.query(`DROP FUNCTION IF EXISTS ${hook}()`);
  }
}, 20_000);

realPg("waits for an actual CRM property reassignment then rejects the old customer without a visit or reminder", async () => {
  const f = await fixture(), before = await counts();
  const suffix = randomUUID().replaceAll("-", ""), hook = `qa_appointment_reassign_${suffix}`, lock = `qa-appointment-reassign-${suffix}`;
  const keeper = await pool.connect();
  let moving: ReturnType<typeof updateProperty> | undefined, creating: ReturnType<typeof create> | undefined;
  try {
    // Actual crm.updateProperty holds its updated row before commit. A private
    // test-only AFTER UPDATE barrier makes the interleaving deterministic.
    await pool.query(`CREATE FUNCTION ${hook}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.organization_id = '${org}'::uuid AND NEW.id = '${f.property}'::uuid AND NEW.contact_id = '${f.b}'::uuid
      THEN PERFORM pg_advisory_xact_lock(hashtext('${lock}')); END IF; RETURN NEW; END $$`);
    await pool.query(`CREATE TRIGGER ${hook} AFTER UPDATE ON properties FOR EACH ROW EXECUTE FUNCTION ${hook}()`);
    await keeper.query("BEGIN");
    await keeper.query("SELECT pg_advisory_xact_lock(hashtext($1))", [lock]);
    const keeperPid = Number((await keeper.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
    moving = updateProperty(org, f.property, { contactId: f.b }); void moving.catch(() => {});
    const writerPid = await blockedBy(keeperPid, '%update "properties"%');
    creating = create({ contactId: f.a, propertyId: f.property }); void creating.catch(() => {});
    const creatorPid = await blockedBy(writerPid, '%from "properties"%for share%');
    expect(creatorPid).not.toBe(writerPid);
    expect(await counts()).toEqual(before);
    await keeper.query("COMMIT");
    expect(await moving).toMatchObject({ contactId: f.b });
    await expect(creating).rejects.toMatchObject({ code: "customer_reference_mismatch", status: 400 });
    expect(await counts()).toEqual(before);
  } finally {
    await keeper.query("ROLLBACK"); keeper.release();
    await Promise.allSettled([moving, creating].filter(Boolean));
    await pool.query(`DROP TRIGGER IF EXISTS ${hook} ON properties`);
    await pool.query(`DROP FUNCTION IF EXISTS ${hook}()`);
  }
}, 20_000);
