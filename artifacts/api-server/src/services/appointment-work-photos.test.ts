import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { appointmentWorkPhotosTable, db, storedObjectsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";
import { contractorWorkdayFixture, workdayTestDefinition, type WorkdayFixture } from "../test-helpers/contractor-workday-fixture";
import { ObjectStorageService } from "../lib/objectStorage";
import { deleteUnreferencedStoredObject, expireWorkdayPhotoReservations } from "../lib/stored-object-retention";
import { attachAppointmentWorkPhoto, getAppointmentWorkPhoto, reserveAppointmentWorkPhoto } from "./appointment-work-photos";
import { completeAppointmentWork, getAppointmentWork, previewAppointmentWorkCompletion, saveAppointmentWorkEntry } from "./appointment-work";
import { cleanupOrphanedUploads } from "./upload-cleanup";
const orgs: string[] = [];
export const testPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlSMAAAAASUVORK5CYII=", "base64");
beforeAll(() => { vi.stubEnv("SESSION_SECRET", "synthetic-workday-photo-signing-key"); vi.stubEnv("OBJECT_STORAGE_PROVIDER", "postgres"); vi.stubGlobal("fetch", async () => { throw Error("No remote storage or providers"); }); });
afterAll(async () => { await deleteTestOrgs(...orgs); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
async function fixture() { const f = await contractorWorkdayFixture({ service: false, definition: { ...workdayTestDefinition, items: [{ key: "image", label: "Recorded condition photo", kind: "photo", required: true, allowNotApplicable: true, unit: null }] } }); orgs.push(f.org); return f; }
export async function uploadTestPhoto(f: WorkdayFixture, extra: { type?: "image/png"; data?: Buffer; itemKey?: string | null } = {}) {
  const work = await getAppointmentWork(f.org, f.actor, f.appointment.id), e = work.entries[0], data = extra.data ?? testPng;
  const input = { requestId: randomUUID(), expectedVersion: e.version, contentType: extra.type ?? "image/png", sizeBytes: data.length, itemKey: extra.itemKey === undefined ? "image" : extra.itemKey, caption: "Actual synthetic photo" };
  const reservation = await reserveAppointmentWorkPhoto(f.org, f.actor, f.appointment.id, e.id, input);
  const url = new URL(reservation.uploadUrl!, "http://127.0.0.1"), objectId = url.pathname.split("/").at(-1)!;
  await new ObjectStorageService().storeDatabaseUpload({ objectId, token: url.searchParams.get("token")!, data, contentType: input.contentType });
  return { e, reservation, objectId, input };
}
it("reserves one exact object, attaches actual bytes and serves only the current tenant/visit private content route", async () => {
  const f = await fixture(), p = await uploadTestPhoto(f);
  const input = { requestId: randomUUID(), expectedVersion: p.reservation.work.entries[0].version, photoId: p.reservation.photoId };
  const attached = await attachAppointmentWorkPhoto(f.org, f.actor, f.appointment.id, p.e.id, input);
  expect(attached.work.entries[0].photos[0]).toMatchObject({ state: "attached", available: true, contentPath: `/api/v1/appointments/${f.appointment.id}/work/photos/${p.reservation.photoId}/content` });
  expect((await getAppointmentWorkPhoto(f.org, f.actor, f.appointment.id, p.reservation.photoId)).data).toEqual(testPng);
  expect((await attachAppointmentWorkPhoto(f.org, f.actor, f.appointment.id, p.e.id, input)).receipt.replayed).toBe(true);
  const b = await fixture(); await expect(getAppointmentWorkPhoto(b.org, b.actor, b.appointment.id, p.reservation.photoId)).rejects.toMatchObject({ status: 404 });
  await expect(attachAppointmentWorkPhoto(f.org, f.actor, f.appointment.id, p.e.id, { ...input, requestId: randomUUID(), expectedVersion: attached.work.entries[0].version, objectId: p.objectId })).rejects.toBeDefined();
  expect(await deleteUnreferencedStoredObject(p.objectId)).toBe(false);
  await expect(new ObjectStorageService().getObjectEntityFile(`/objects/uploads/${p.objectId}`, f.org)).rejects.toMatchObject({ name: "ObjectNotFoundError" });
  await expect(new ObjectStorageService().getObjectEntityFile(`/objects/uploads/${p.objectId}`)).rejects.toMatchObject({ name: "ObjectNotFoundError" });
});
it("lost upload response replays inertly and never returns a new upload capability or reservation", async () => {
  const f = await fixture(), p = await uploadTestPhoto(f);
  const replay = await reserveAppointmentWorkPhoto(f.org, f.actor, f.appointment.id, p.e.id, p.input);
  expect(replay).toMatchObject({ photoId: p.reservation.photoId, uploadUrl: null, receipt: { replayed: true } });
  await expect(reserveAppointmentWorkPhoto(f.org, f.actor, f.appointment.id, p.e.id, { ...p.input, caption: "Changed command" })).rejects.toMatchObject({ code: "workday_request_conflict" });
});
it("rejects absent, wrong-content and wrong-byte uploads rather than adopting another same-company object", async () => {
  const f = await fixture(), p = await uploadTestPhoto(f, { data: Buffer.from("not an actual PNG") });
  await expect(attachAppointmentWorkPhoto(f.org, f.actor, f.appointment.id, p.e.id, { requestId: randomUUID(), expectedVersion: p.reservation.work.entries[0].version, photoId: p.reservation.photoId })).rejects.toMatchObject({ code: "workday_photo_upload_invalid" });
  const forged = randomUUID(); await db.insert(storedObjectsTable).values({ id: forged, organizationId: f.org, contentType: "image/png", sizeBytes: testPng.length, data: testPng });
  expect((await getAppointmentWork(f.org, f.actor, f.appointment.id)).entries[0].photos[0].state).toBe("reserved");
});
it("expired unbound reservations are tombstoned and deletable; attached references survive actual cleanup", async () => {
  const f = await fixture(), p = await uploadTestPhoto(f);
  await db.update(appointmentWorkPhotosTable).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(appointmentWorkPhotosTable.id, p.reservation.photoId));
  expect(await expireWorkdayPhotoReservations()).toBeGreaterThan(0);
  await expect(attachAppointmentWorkPhoto(f.org, f.actor, f.appointment.id, p.e.id, { requestId: randomUUID(), expectedVersion: p.reservation.work.entries[0].version, photoId: p.reservation.photoId })).rejects.toMatchObject({ code: "workday_photo_reservation_expired" });
  expect(await deleteUnreferencedStoredObject(p.objectId)).toBe(true);
  const b = await fixture(), attachedPhoto = await uploadTestPhoto(b);
  await attachAppointmentWorkPhoto(b.org, b.actor, b.appointment.id, attachedPhoto.e.id, { requestId: randomUUID(), expectedVersion: attachedPhoto.reservation.work.entries[0].version, photoId: attachedPhoto.reservation.photoId });
  await db.update(storedObjectsTable).set({ createdAt: new Date("2000-01-01T00:00:00Z") }).where(eq(storedObjectsTable.id, attachedPhoto.objectId));
  const report = await cleanupOrphanedUploads(); expect(report.errors).toBe(0);
  expect((await getAppointmentWorkPhoto(b.org, b.actor, b.appointment.id, attachedPhoto.reservation.photoId)).data).toEqual(testPng);
});
it("required photo answers need an exact attached item and completion freezes the reference", async () => {
  const f = await fixture(), work = await getAppointmentWork(f.org, f.actor, f.appointment.id), e = work.entries[0];
  await saveAppointmentWorkEntry(f.org, f.actor, f.appointment.id, e.id, { requestId: randomUUID(), expectedVersion: e.version, answers: [{ itemKey: "image", result: "done", value: null, reason: null }], notes: "Observed, awaiting upload" });
  const intent = async () => { const current = await getAppointmentWork(f.org, f.actor, f.appointment.id); return { expectedAppointmentUpdatedAt: current.appointment.updatedAt, entries: current.entries.map(x => ({ id: x.id, version: x.version })), serviceObligationIds: [], performedAt: new Date(Date.now() - 1000).toISOString(), summary: "Technician recorded an actual condition photo", outcome: "completed", followup: null }; };
  await expect(previewAppointmentWorkCompletion(f.org, f.actor, f.appointment.id, await intent())).rejects.toMatchObject({ code: "workday_photo_required" });
  const p = await uploadTestPhoto(f); await attachAppointmentWorkPhoto(f.org, f.actor, f.appointment.id, p.e.id, { requestId: randomUUID(), expectedVersion: p.reservation.work.entries[0].version, photoId: p.reservation.photoId });
  const review = await previewAppointmentWorkCompletion(f.org, f.actor, f.appointment.id, await intent());
  const completed = await completeAppointmentWork(f.org, f.actor, f.appointment.id, { requestId: randomUUID(), previewToken: review.previewToken, confirmed: true });
  expect(completed.work.entries[0].photos[0].state).toBe("attached");
  expect(await deleteUnreferencedStoredObject(p.objectId)).toBe(false);
  await expect(reserveAppointmentWorkPhoto(f.org, f.actor, f.appointment.id, e.id, { ...p.input, requestId: randomUUID(), expectedVersion: completed.work.entries[0].version })).rejects.toMatchObject({ code: "workday_visit_not_active" });
});
it("legacy remote storage and unsupported media stay held without network access", async () => {
  const f = await fixture(), e = (await getAppointmentWork(f.org, f.actor, f.appointment.id)).entries[0];
  const input = { requestId: randomUUID(), expectedVersion: e.version, contentType: "image/png", sizeBytes: testPng.length, itemKey: null, caption: "" };
  vi.stubEnv("OBJECT_STORAGE_PROVIDER", "gcs");
  try { await expect(reserveAppointmentWorkPhoto(f.org, f.actor, f.appointment.id, e.id, input)).rejects.toMatchObject({ code: "workday_storage_unavailable" }); } finally { vi.stubEnv("OBJECT_STORAGE_PROVIDER", "postgres"); }
  for (const invalid of [{ contentType: "image/svg+xml" }, { contentType: "video/mp4" }, { sizeBytes: 10485761 }]) await expect(reserveAppointmentWorkPhoto(f.org, f.actor, f.appointment.id, e.id, { ...input, ...invalid })).rejects.toBeDefined();
});
