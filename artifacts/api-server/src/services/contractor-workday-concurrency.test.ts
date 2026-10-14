import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { appointmentWorkCompletionsTable, crmTasksTable, db, pool, serviceObligationsTable, usersTable,orgSettingsTable } from "@workspace/db";
import {saveSchedulingPolicy,readSchedulingPolicy} from './scheduling-policy';
import { eq } from "drizzle-orm";
import app from "../app";
import { createSession, deleteSession } from "../lib/auth";
import { ObjectStorageService } from "../lib/objectStorage";
import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";
import { answerWorkday, contractorWorkdayFixture, reviewWorkday, workdayTestAsset, workdayTestDefinition } from "../test-helpers/contractor-workday-fixture";
import { completeAppointmentWork, getAppointmentWork, saveAppointmentWorkEntry } from "./appointment-work";
import { attachAppointmentWorkPhoto, getAppointmentWorkPhoto, reserveAppointmentWorkPhoto } from "./appointment-work-photos";
import { updateAppointment, updateProperty, updateTask } from "./crm";
import { updateWorkdayAsset } from "./property-assets";
import { reviseWorkdayTemplate } from "./work-checklists";

const realPg = it.skipIf(process.env.SCHEDULER_TEST_BACKEND === "pglite");
const orgs: string[] = [], sessions: string[] = [], originalFetch = globalThis.fetch, origin = "https://workday.example";
let server: Server | undefined, base: string;
beforeAll(async () => {
  vi.stubEnv("SESSION_SECRET", "synthetic-workday-concurrency-signing-key"); vi.stubEnv("APP_ORIGIN", origin); vi.stubEnv("OBJECT_STORAGE_PROVIDER", "postgres");
  if (process.env.SCHEDULER_TEST_BACKEND !== "pglite") { server = app.listen(0, "127.0.0.1"); await new Promise<void>(resolve => server!.once("listening", resolve)); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; }
  vi.stubGlobal("fetch", async () => { throw Error("Only captured loopback HTTP transport may run"); });
});
afterAll(async () => { if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); } for (const sid of sessions) await deleteSession(sid); await deleteTestOrgs(...orgs); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
async function fixture() { const f = await contractorWorkdayFixture(); orgs.push(f.org); await answerWorkday(f); const review = await reviewWorkday(f); return { ...f, review, command: { requestId: randomUUID(), previewToken: review.previewToken, confirmed: true } }; }
async function blockedBy(blocker: number, pattern: string) {
  for (let i = 0; i < 300; i++) { const { rows } = await pool.query("SELECT pid FROM pg_stat_activity WHERE $1::int=ANY(pg_blocking_pids(pid)) AND query ILIKE $2", [blocker, pattern]); if (rows[0]) return Number(rows[0].pid); await new Promise(resolve => setTimeout(resolve, 20)); }
  throw Error(`An actual independent PostgreSQL writer barrier was not observed (${pattern})`);
}
async function barrier(table: string, timing: "BEFORE INSERT" | "AFTER UPDATE" | "BEFORE UPDATE", condition: string) {
  const suffix = randomUUID().replaceAll("-", ""), hook = `qa_workday_${suffix}`, lock = `qa-workday-${suffix}`, keeper = await pool.connect();
  await pool.query(`CREATE FUNCTION ${hook}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF ${condition} THEN PERFORM pg_advisory_xact_lock(hashtext('${lock}')); END IF; RETURN NEW; END $$`);
  await pool.query(`CREATE TRIGGER ${hook} ${timing} ON ${table} FOR EACH ROW EXECUTE FUNCTION ${hook}()`);
  await keeper.query("BEGIN"); await keeper.query("SELECT pg_advisory_xact_lock(hashtext($1))", [lock]);
  const pid = Number((await keeper.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
  return { pid, release: () => keeper.query("COMMIT"), cleanup: async (pending: Promise<unknown>[]) => { await keeper.query("ROLLBACK"); keeper.release(); await Promise.allSettled(pending); await pool.query(`DROP TRIGGER IF EXISTS ${hook} ON ${table}`); await pool.query(`DROP FUNCTION IF EXISTS ${hook}()`); } };
}
function observe<T>(promise: Promise<T>, pending: Promise<unknown>[]) { pending.push(promise); void promise.catch(() => {}); return promise; }

realPg('native work completion preserves its original transaction and task plan after current scheduling evidence becomes corrupt',async()=>{
 const f=await fixture();
 const actor={organizationId:f.org,userId:f.owner.id};const current=await readSchedulingPolicy(actor);
 const saved=await saveSchedulingPolicy(actor,{expectedRevision:0,expectedCompanyTimeZone:current.context.companyTimeZone,enabled:true,minimumTravelGapMinutes:1440,maxConcurrentReservations:1,durationPresets:[]});
 await db.update(orgSettingsTable).set({schedulingPolicy:{...saved.policy!,digest:'0'.repeat(64)}}).where(eq(orgSettingsTable.organizationId,f.org));
 const result=await completeAppointmentWork(f.org,f.actor,f.appointment.id,f.command);
 expect(result.work.completion?.services[0].nextObligationId).toBeTruthy();
 expect(await db.select().from(appointmentWorkCompletionsTable).where(eq(appointmentWorkCompletionsTable.organizationId,f.org))).toHaveLength(1);
 expect((await completeAppointmentWork(f.org,f.actor,f.appointment.id,f.command)).receipt.replayed).toBe(true);
});

realPg("retains actual property, task and performing member locks through atomic work completion while generic writers wait", async () => {
  const f = await fixture(), pending: Promise<unknown>[] = [];
  const sid = await createSession({ user: { id: f.owner.id, email: null, firstName: null, lastName: null, profileImageUrl: null }, access_token: "synthetic" }); sessions.push(sid);
  const b = await barrier("appointment_work_completions", "BEFORE INSERT", `NEW.organization_id='${f.org}'::uuid AND NEW.original_completion_id IS NULL`);
  try {
    const finishing = observe(completeAppointmentWork(f.org, f.actor, f.appointment.id, f.command), pending);
    const finisher = await blockedBy(b.pid, '%insert into "appointment_work_completions"%');
    const property = observe(updateProperty(f.org, f.property.id, { addressLine1: "Changed by actual office writer" }), pending);
    const task = observe(updateTask(f.org, f.service!.taskId, { description: "Later actual task writer note", status: "in_progress" }), pending);
    const member = observe(originalFetch(`${base}/api/v1/users/${f.tech.id}`, { method: "PATCH", headers: { origin, cookie: `sid=${sid}`, "content-type": "application/json" }, body: JSON.stringify({ isActive: false }) }), pending);
    const writers = await Promise.all([blockedBy(finisher, '%from "properties"%for update%'), blockedBy(finisher, '%update "crm_tasks"%'), blockedBy(finisher, '%update "users"%')]);
    expect(new Set([...writers, finisher, b.pid]).size).toBe(5);
    await b.release(); const result = await finishing; expect(result.work.completion?.performerUserId).toBe(f.tech.id);
    await property; await task; expect((await member).status).toBe(200);
    expect((await db.select().from(crmTasksTable).where(eq(crmTasksTable.id, f.service!.taskId)))[0]).toMatchObject({ description: "Later actual task writer note", status: "in_progress" });
    const [proof] = await db.select().from(appointmentWorkCompletionsTable).where(eq(appointmentWorkCompletionsTable.id, result.work.completion!.id));
    expect(proof.snapshot.tasksBefore).toEqual(expect.arrayContaining([expect.objectContaining({ description: "Technician and office jointly authored this original task note." })]));
  } finally { await b.cleanup(pending); }
}, 30_000);

realPg("waits for actual property or assignment changes and rejects stale work after the writer commits", async () => {
  for (const mode of ["property", "assignment"] as const) {
    const f = await fixture(), pending: Promise<unknown>[] = [];
    const table = mode === "property" ? "properties" : "appointments", row = mode === "property" ? f.property.id : f.appointment.id;
    const b = await barrier(table, "AFTER UPDATE", `NEW.id='${row}'::uuid`);
    try {
      const changing = observe<unknown>(mode === "property" ? updateProperty(f.org, f.property.id, { contactId: f.otherContact.id }) : updateAppointment(f.org, f.appointment.id, { assignedUserId: f.office.id }), pending);
      const writer = await blockedBy(b.pid, `%update "${table}"%`);
      const finishing = observe(completeAppointmentWork(f.org, f.actor, f.appointment.id, f.command), pending);
      const finisher = await blockedBy(writer, mode === "property" ? '%from "properties"%for share%' : '%pg_advisory_xact_lock%');
      expect(new Set([writer, finisher, b.pid]).size).toBe(3); await b.release(); await changing;
      await expect(finishing).rejects.toMatchObject({ code: mode === "property" ? "workday_parent_changed" : "workday_assignment_required" });
      expect(await db.select().from(appointmentWorkCompletionsTable).where(eq(appointmentWorkCompletionsTable.organizationId, f.org))).toHaveLength(0);
      expect((await db.select().from(serviceObligationsTable).where(eq(serviceObligationsTable.id, f.service!.id)))[0].status).toBe("active");
    } finally { await b.cleanup(pending); }
  }
}, 30_000);

realPg("two actual finishers and a legacy completion writer produce one original completion and one successor", async () => {
  const f = await fixture(), pending: Promise<unknown>[] = [], b = await barrier("appointment_work_completions", "BEFORE INSERT", `NEW.organization_id='${f.org}'::uuid AND NEW.original_completion_id IS NULL`);
  try {
    const first = observe(completeAppointmentWork(f.org, f.actor, f.appointment.id, f.command), pending), firstPid = await blockedBy(b.pid, '%insert into "appointment_work_completions"%');
    const second = observe(completeAppointmentWork(f.org, f.actor, f.appointment.id, f.command), pending);
    const legacy = observe(updateAppointment(f.org, f.appointment.id, { status: "completed" }), pending);
    // Both prefixes are retained by the original finisher, on independent backends.
    let waiters: number[] = [];
    for (let i = 0; i < 300 && waiters.length < 2; i++) { const found = await pool.query("SELECT pid FROM pg_stat_activity WHERE $1::int=ANY(pg_blocking_pids(pid)) AND query ILIKE '%pg_advisory_xact_lock%'", [firstPid]); waiters = found.rows.map(r => Number(r.pid)); if (waiters.length < 2) await new Promise(resolve => setTimeout(resolve, 20)); }
    expect(new Set([firstPid, ...waiters]).size).toBe(3);
    await b.release(); const result = await first; expect((await second).receipt.replayed).toBe(true);
    await expect(legacy).rejects.toMatchObject({ code: "workday_completion_required" });
    expect(await db.select().from(appointmentWorkCompletionsTable).where(eq(appointmentWorkCompletionsTable.organizationId, f.org))).toHaveLength(1);
    expect(await db.select().from(serviceObligationsTable).where(eq(serviceObligationsTable.predecessorObligationId, f.service!.id))).toHaveLength(1);
    expect(result.work.completion?.services[0].nextObligationId).toBeTruthy();
  } finally { await b.cleanup(pending); }
}, 30_000);

realPg("actual entry, asset and template edits serialize after completion without rewriting reviewed historical work", async () => {
  const f = await fixture(), current = await getAppointmentWork(f.org, f.actor, f.appointment.id), e = current.entries[0], pending: Promise<unknown>[] = [];
  const b = await barrier("appointment_work_completions", "BEFORE INSERT", `NEW.organization_id='${f.org}'::uuid AND NEW.original_completion_id IS NULL`);
  try {
    const finishing = observe(completeAppointmentWork(f.org, f.actor, f.appointment.id, f.command), pending), finisher = await blockedBy(b.pid, '%insert into "appointment_work_completions"%');
    const entry = observe(saveAppointmentWorkEntry(f.org, f.actor, f.appointment.id, e.id, { requestId: randomUUID(), expectedVersion: e.version, answers: [], notes: "Must not overwrite completed record" }), pending);
    const asset = observe(updateWorkdayAsset(f.org, f.manager, f.assetId!, { ...workdayTestAsset, label: "Future updated asset name", requestId: randomUUID(), expectedVersion: 1, status: "active" }), pending);
    const template = observe(reviseWorkdayTemplate(f.org, f.manager, f.template.id, { requestId: randomUUID(), expectedVersion: f.template.version, definition: { ...workdayTestDefinition, name: "Future instructions" } }), pending);
    // Advisory wait queues may chain behind each other; prove each distinct
    // backend participates in the original finisher's transitive lock chain.
    let waiting: number[] = [];
    for (let i = 0; i < 300 && waiting.length < 3; i++) { const r = await pool.query(`WITH RECURSIVE waits(pid) AS (SELECT pid FROM pg_stat_activity WHERE $1::int=ANY(pg_blocking_pids(pid)) UNION SELECT a.pid FROM pg_stat_activity a JOIN waits w ON w.pid=ANY(pg_blocking_pids(a.pid))) SELECT DISTINCT w.pid FROM waits w JOIN pg_stat_activity a ON a.pid=w.pid WHERE a.query ILIKE '%pg_advisory_xact_lock%'`, [finisher]); waiting = r.rows.map(row => Number(row.pid)); if (waiting.length < 3) await new Promise(resolve => setTimeout(resolve, 20)); }
    expect(new Set([finisher, ...waiting]).size).toBe(4);
    await b.release(); const completed = await finishing; await expect(entry).rejects.toMatchObject({ code: "workday_visit_not_active" }); await asset; await template;
    const later = await getAppointmentWork(f.org, f.actor, f.appointment.id);
    expect(later.completion).toEqual(completed.work.completion); expect(later.entries[0].answers).toEqual(e.answers);
    expect(later.entries[0].assetSnapshot?.label).toBe(workdayTestAsset.label); expect(later.entries[0].checklist.definition.name).toBe(workdayTestDefinition.name);
  } finally { await b.cleanup(pending); }
}, 30_000);

realPg("actual native orphan deletion waits for photo attachment and then preserves the confirmed private object", async () => {
  const f = await fixture(), e = (await getAppointmentWork(f.org, f.actor, f.appointment.id)).entries[0], data = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlSMAAAAASUVORK5CYII=", "base64");
  const reservation = await reserveAppointmentWorkPhoto(f.org, f.actor, f.appointment.id, e.id, { requestId: randomUUID(), expectedVersion: e.version, contentType: "image/png", sizeBytes: data.length, itemKey: null, caption: "Race proof photo" });
  const url = new URL(reservation.uploadUrl!, "http://127.0.0.1"), objectId = url.pathname.split("/").at(-1)!, storage = new ObjectStorageService();
  await storage.storeDatabaseUpload({ objectId, token: url.searchParams.get("token")!, data, contentType: "image/png" });
  const nativeRemoval = (await storage.listObjectEntityUploads()).find(o => o.objectPath === `/objects/uploads/${objectId}`)!;
  const pending: Promise<unknown>[] = [], b = await barrier("appointment_work_photos", "BEFORE UPDATE", `NEW.id='${reservation.photoId}'::uuid AND NEW.state='attached'`);
  try {
    const attaching = observe(attachAppointmentWorkPhoto(f.org, f.actor, f.appointment.id, e.id, { requestId: randomUUID(), expectedVersion: reservation.work.entries[0].version, photoId: reservation.photoId }), pending), attachingPid = await blockedBy(b.pid, '%update "appointment_work_photos"%');
    const deleting = observe(nativeRemoval.remove(), pending), cleanupPid = await blockedBy(attachingPid, '%from "stored_objects"%for update%');
    expect(new Set([b.pid, attachingPid, cleanupPid]).size).toBe(3);
    await b.release(); expect((await attaching).work.entries[0].photos[0].state).toBe("attached"); expect(await deleting).toBe(false);
    expect((await getAppointmentWorkPhoto(f.org, f.actor, f.appointment.id, reservation.photoId)).data).toEqual(data);
  } finally { await b.cleanup(pending); }
}, 30_000);
