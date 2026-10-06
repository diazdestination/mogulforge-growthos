import { createHash } from "node:crypto";
import { appointmentWorkEntriesTable as entries, appointmentWorkPhotosTable as photos, db, storedObjectsTable as objects } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { ObjectStorageService } from "../lib/objectStorage";
import { attachWorkdayPhotoSchema, requestWorkdayPhotoSchema } from "./contractor-workday-contract";
import { assertWorkdayVisitWritable, readAppointmentWork, readWorkdayVisit, requireWorkdayEntry } from "./appointment-work";
import { lockWorkday, workdayActor, workdayAudit, workdayFail, workdayHash, workdayReplay, type WorkdayActor, type WorkdayTx } from "./workday-shared";

const digest = (data: Buffer) => createHash("sha256").update(data).digest("hex");
function actualImage(data: Buffer, type: string) {
  if (type === "image/png") return data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  if (type === "image/jpeg") return data.length >= 4 && data[0] === 255 && data[1] === 216 && data[2] === 255 && data[data.length - 2] === 255 && data[data.length - 1] === 217;
  return type === "image/webp" && data.length >= 12 && data.subarray(0, 4).toString("ascii") === "RIFF" && data.subarray(8, 12).toString("ascii") === "WEBP";
}
async function result(tx: WorkdayTx, org: string, actor: WorkdayActor, id: string, requestId: string, replayed: boolean) {
  return { organizationId: org, work: await readAppointmentWork(tx, org, actor, id), receipt: { requestId, replayed } };
}
export async function reserveAppointmentWorkPhoto(org: string, actor: WorkdayActor, id: string, entryId: string, raw: unknown) {
  const input = requestWorkdayPhotoSchema.parse(raw), payload = { id, entryId, ...input };
  return db.transaction(async tx => {
    await lockWorkday(tx, org); const visit = await readWorkdayVisit(tx, org, actor, id, true);
    const [old] = await tx.select().from(photos).where(and(eq(photos.organizationId, org), eq(photos.requestId, input.requestId)));
    if (old) {
      if (old.payloadSha256 !== workdayHash(payload) || old.entryId !== entryId || old.appointmentId !== id || old.createdByUserId !== actor.userId) workdayFail("workday_request_conflict");
      return { ...await result(tx, org, actor, id, input.requestId, true), photoId: old.id, uploadUrl: null, uploadExpiresAt: old.expiresAt.toISOString() };
    }
    assertWorkdayVisitWritable(visit, input.actingNote);
    const { entry, view } = await requireWorkdayEntry(tx, org, id, entryId, input.expectedVersion, visit.parentSnapshot);
    if (input.itemKey && !view.checklist.definition.items.some(item => item.key === input.itemKey && item.kind === "photo")) workdayFail("workday_photo_item_invalid", "Choose an exact reviewed photo item or general visit evidence.", 400);
    const all = await tx.select({ id: photos.id }).from(photos).where(and(eq(photos.organizationId, org), eq(photos.appointmentId, id)));
    if (all.length >= 50) workdayFail("workday_photo_limit", "This visit has reached its 50-photo reservation limit.");
    const storage = new ObjectStorageService();
    if (!storage.isDatabaseProvider()) workdayFail("workday_storage_unavailable", "Visit photos require the native private storage provider.");
    // The native provider only signs locally here. No remote storage I/O is permitted in this transaction.
    const expiresAt = new Date(Date.now() + 15 * 60_000);
    const uploadUrl = await storage.getObjectEntityUploadURL({ organizationId: org, contentType: input.contentType, size: input.sizeBytes });
    const match = /^\/api\/v1\/public\/uploads\/local\/([0-9a-f-]{36})\?token=/.exec(uploadUrl);
    if (!match) workdayFail("workday_storage_unavailable");
    const [photo] = await tx.insert(photos).values({ organizationId: org, appointmentId: id, entryId, reservedObjectId: match[1], requestId: input.requestId, payloadSha256: workdayHash(payload), itemKey: input.itemKey, caption: input.caption, contentType: input.contentType, sizeBytes: input.sizeBytes, createdByUserId: actor.userId, expiresAt }).returning();
    await tx.update(entries).set({ version: entry.version + 1, updatedAt: new Date() }).where(eq(entries.id, entryId));
    await workdayAudit(tx, org, actor.userId, "workday.photo_reserved", photo.id, input.requestId, payload, { photoId: photo.id });
    return { ...await result(tx, org, actor, id, input.requestId, false), photoId: photo.id, uploadUrl, uploadExpiresAt: expiresAt.toISOString() };
  });
}
export async function attachAppointmentWorkPhoto(org: string, actor: WorkdayActor, id: string, entryId: string, raw: unknown) {
  const input = attachWorkdayPhotoSchema.parse(raw), payload = { id, entryId, ...input };
  return db.transaction(async tx => {
    await lockWorkday(tx, org); const visit = await readWorkdayVisit(tx, org, actor, id, true);
    if (await workdayReplay(tx, org, "workday.photo_attached", input.requestId, payload)) return result(tx, org, actor, id, input.requestId, true);
    assertWorkdayVisitWritable(visit, input.actingNote);
    const { entry } = await requireWorkdayEntry(tx, org, id, entryId, input.expectedVersion, visit.parentSnapshot);
    const [photo] = await tx.select().from(photos).where(and(eq(photos.organizationId, org), eq(photos.appointmentId, id), eq(photos.entryId, entryId), eq(photos.id, input.photoId))).for("update");
    if (!photo || photo.state !== "reserved" || photo.expiresAt.getTime() <= Date.now()) workdayFail("workday_photo_reservation_expired", "Use the exact current photo reservation; an expired reservation cannot be renewed.");
    const [object] = await tx.select().from(objects).where(and(eq(objects.organizationId, org), eq(objects.id, photo.reservedObjectId))).for("share");
    if (!object || object.contentType !== photo.contentType || object.sizeBytes !== photo.sizeBytes || object.data.length !== photo.sizeBytes || !actualImage(object.data, photo.contentType)) workdayFail("workday_photo_upload_invalid", "The exact upload is missing or its image type and byte count do not match the reservation.");
    await tx.update(photos).set({ state: "attached", objectId: object.id, objectSha256: digest(object.data), attachedAt: new Date() }).where(eq(photos.id, photo.id));
    await tx.update(entries).set({ version: entry.version + 1, updatedAt: new Date() }).where(eq(entries.id, entryId));
    await workdayAudit(tx, org, actor.userId, "workday.photo_attached", photo.id, input.requestId, payload, { photoId: photo.id });
    return result(tx, org, actor, id, input.requestId, false);
  });
}
export async function getAppointmentWorkPhoto(org: string, actor: WorkdayActor, id: string, photoId: string) {
  await workdayActor(db, org, actor); await readWorkdayVisit(db, org, actor, id);
  const [row] = await db.select({ photo: photos, object: objects }).from(photos).innerJoin(objects, and(eq(objects.organizationId, photos.organizationId), eq(objects.id, photos.objectId))).innerJoin(entries, and(eq(entries.organizationId, photos.organizationId), eq(entries.id, photos.entryId), eq(entries.appointmentId, photos.appointmentId))).where(and(eq(photos.organizationId, org), eq(photos.appointmentId, id), eq(photos.id, photoId), eq(photos.state, "attached")));
  if (!row || row.object.sizeBytes !== row.photo.sizeBytes || digest(row.object.data) !== row.photo.objectSha256) workdayFail("workday_photo_unavailable", "Private visit photo unavailable.", 404);
  return { contentType: row.photo.contentType, data: row.object.data };
}
