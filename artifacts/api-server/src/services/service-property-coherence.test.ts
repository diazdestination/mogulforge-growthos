import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { contactsTable, db, organizationsTable, pool, propertiesTable, usersTable } from "@workspace/db";
import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";
import { createServiceObligation } from "./service-obligations";
import { updateProperty } from "./crm";

let org: string, other: string, actor: string;
beforeAll(async () => {
  const target = new URL(process.env.DATABASE_URL ?? "");
  if (process.env.NODE_ENV !== "test" || !["127.0.0.1", "localhost"].includes(target.hostname)) throw new Error("Use isolated test database");
  [org, other] = (await db.insert(organizationsTable).values([
    { name: "SYNTHETIC service parent coherence", slug: randomUUID() }, { name: "SYNTHETIC foreign service parent", slug: randomUUID() },
  ]).returning()).map(row => row.id);
  [actor] = (await db.insert(usersTable).values({ organizationId: org, role: "owner", emailVerifiedAt: new Date() }).returning()).map(row => row.id);
});
afterAll(async () => { await deleteTestOrgs(org, other); });
async function fixture() {
  const [a, b] = await db.insert(contactsTable).values([
    { organizationId: org, firstName: "Same name" }, { organizationId: org, firstName: "Same name" },
  ]).returning();
  const [property] = await db.insert(propertiesTable).values({ organizationId: org, contactId: a.id, addressLine1: "100 Synthetic Lane", city: "Example", state: "GA", postalCode: "00000" }).returning();
  return { a: a.id, b: b.id, property: property.id };
}
const create = (contactId: string, propertyId: string | null) => createServiceObligation(org, actor, {
  contactId, propertyId, kind: "maintenance", equipmentLabel: "Synthetic unit", dueDate: "2028-06-15", noticeDays: 14,
});
async function counts(contactId: string) {
  return (await pool.query(`SELECT
    (SELECT count(*)::int FROM service_obligations WHERE organization_id=$1 AND contact_id=$2) AS services,
    (SELECT count(*)::int FROM crm_tasks WHERE organization_id=$1 AND contact_id=$2) AS tasks,
    (SELECT count(*)::int FROM leads WHERE organization_id=$1 AND contact_id=$2) AS leads`, [org, contactId])).rows[0];
}
it("records an explicit customer property or explicit null without creating an acquisition lead", async () => {
  const f = await fixture();
  expect(await create(f.a, f.property)).toMatchObject({ contactId: f.a, propertyId: f.property });
  expect(await create(f.a, null)).toMatchObject({ contactId: f.a, propertyId: null });
  expect(await counts(f.a)).toEqual({ services: 2, tasks: 2, leads: 0 });
});
it("rejects a same-name wrong customer, foreign property and a property reassigned before creation", async () => {
  const f = await fixture();
  expect(await create(f.b, f.property)).toEqual({ error: "property_not_found" });
  const [foreign] = await db.insert(propertiesTable).values({ organizationId: other, addressLine1: "100 Synthetic Lane", city: "Example", state: "GA", postalCode: "00000" }).returning();
  expect(await create(f.a, foreign.id)).toEqual({ error: "property_not_found" });
  await updateProperty(org, f.property, { contactId: f.b });
  expect(await create(f.a, f.property)).toEqual({ error: "property_not_found" });
  expect(await counts(f.a)).toEqual({ services: 0, tasks: 0, leads: 0 });
  expect(await counts(f.b)).toEqual({ services: 0, tasks: 0, leads: 0 });
});

// PGlite cannot model independent PostgreSQL backends. CI runs both cases on PG16.
const realPg = it.skipIf(process.env.SCHEDULER_TEST_BACKEND === "pglite");
async function blockedBy(blocker: number, queryPattern: string) {
  for (let n = 0; n < 300; n++) {
    const result = await pool.query("SELECT pid FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid)) AND query ILIKE $2", [blocker, queryPattern]);
    if (result.rows[0]) return Number(result.rows[0].pid);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error("Expected independent PostgreSQL parent lock was not observed");
}
realPg("holds selected parent rows through actual creation while the real CRM property writer waits", async () => {
  const f = await fixture(), suffix = randomUUID().replaceAll("-", ""), hook = `qa_service_parent_${suffix}`, lock = `qa-service-parent-${suffix}`;
  const keeper = await pool.connect();
  let creating: ReturnType<typeof create> | undefined, changing: ReturnType<typeof updateProperty> | undefined;
  try {
    // Test-only barrier AFTER the service's parent reads, before its first insert.
    // The production function and writer run unchanged on different PG backends.
    await pool.query(`CREATE FUNCTION ${hook}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.organization_id = '${org}'::uuid AND NEW.contact_id = '${f.a}'::uuid THEN PERFORM pg_advisory_xact_lock(hashtext('${lock}')); END IF;
      RETURN NEW; END $$`);
    await pool.query(`CREATE TRIGGER ${hook} BEFORE INSERT ON crm_tasks FOR EACH ROW EXECUTE FUNCTION ${hook}()`);
    await keeper.query("BEGIN");
    await keeper.query("SELECT pg_advisory_xact_lock(hashtext($1))", [lock]);
    const keeperPid = Number((await keeper.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
    creating = create(f.a, f.property);
    const creatorPid = await blockedBy(keeperPid, '%insert into "crm_tasks"%');
    let settled = false;
    changing = updateProperty(org, f.property, { contactId: f.b });
    void changing.then(() => { settled = true; }, () => { settled = true; });
    const writerPid = await blockedBy(creatorPid, '%from "properties"%for update%');
    expect(writerPid).not.toBe(creatorPid); expect(settled).toBe(false);
    expect(await counts(f.a)).toEqual({ services: 0, tasks: 0, leads: 0 });
    await keeper.query("COMMIT");
    const created = await creating;
    expect(created).toMatchObject({ contactId: f.a, propertyId: f.property });
    expect(await changing).toMatchObject({ contactId: f.b });
    expect(await counts(f.a)).toEqual({ services: 1, tasks: 1, leads: 0 });
    if ("error" in created) throw new Error(created.error);
    expect((await pool.query("SELECT contact_id, property_id FROM service_obligations WHERE id=$1", [created.id])).rows[0]).toEqual({ contact_id: f.a, property_id: f.property });
    expect((await pool.query("SELECT count(*)::int AS count FROM audit_events WHERE organization_id=$1 AND entity_id=$2 AND action='service.obligation_created'", [org, created.id])).rows[0].count).toBe(1);
  } finally {
    await keeper.query("ROLLBACK"); keeper.release();
    await Promise.allSettled([creating, changing].filter(Boolean));
    await pool.query(`DROP TRIGGER IF EXISTS ${hook} ON crm_tasks`);
    await pool.query(`DROP FUNCTION IF EXISTS ${hook}()`);
  }
}, 20_000);
realPg("rechecks a competing property reassignment after waiting and creates nothing for the old customer", async () => {
  const f = await fixture(), writer = await pool.connect();
  let creating: ReturnType<typeof create> | undefined;
  try {
    await writer.query("BEGIN");
    await writer.query("UPDATE properties SET contact_id=$1 WHERE id=$2 AND organization_id=$3", [f.b, f.property, org]);
    const writerPid = Number((await writer.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
    creating = create(f.a, f.property);
    const creatorPid = await blockedBy(writerPid, '%from "properties"%for share%');
    expect(creatorPid).not.toBe(writerPid);
    await writer.query("COMMIT");
    expect(await creating).toEqual({ error: "property_not_found" });
    expect(await counts(f.a)).toEqual({ services: 0, tasks: 0, leads: 0 });
  } finally {
    await writer.query("ROLLBACK"); writer.release();
    await Promise.allSettled([creating].filter(Boolean));
  }
}, 20_000);
