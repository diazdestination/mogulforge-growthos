import { activitiesTable, appointmentWorkPhotosTable as photos, db, storedObjectsTable as objects } from "@workspace/db";
import { and, eq, gt, lt, or, sql } from "drizzle-orm";
type Reader = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Recheck while holding the actual object lock; a stale orphan listing is not deletion authority. */
export async function storedObjectIsReferenced(reader: Reader, objectId: string, at = new Date()) {
  const [photo] = await reader.select({ id: photos.id }).from(photos).where(and(eq(photos.reservedObjectId, objectId), or(eq(photos.state, "attached"), and(eq(photos.state, "reserved"), gt(photos.expiresAt, at))))).limit(1);
  if (photo) return true;
  const [activity] = await reader.select({ id: activitiesTable.id }).from(activitiesTable).where(sql`${activitiesTable.type}='photos_attached' AND ${activitiesTable.metadata} @> ${JSON.stringify({ photoPaths: [`/objects/uploads/${objectId}`] })}::jsonb`).limit(1);
  return !!activity;
}
export async function deleteUnreferencedStoredObject(objectId: string): Promise<boolean> {
  return db.transaction(async tx => {
    const [row] = await tx.select({ id: objects.id }).from(objects).where(eq(objects.id, objectId)).for("update");
    if (!row) return false;
    if (await storedObjectIsReferenced(tx, objectId)) return false;
    await tx.delete(objects).where(eq(objects.id, objectId));
    return true;
  });
}
/** Tombstones only. Attached objects are never removed or detached by retention. */
export async function expireWorkdayPhotoReservations(at = new Date(), limit = 100) {
  return db.transaction(async tx => {
    const due = await tx.select({ id: photos.id }).from(photos).where(and(eq(photos.state, "reserved"), lt(photos.expiresAt, at))).orderBy(photos.expiresAt, photos.id).limit(Math.min(100, Math.max(1, limit))).for("update", { skipLocked: true });
    for (const row of due) await tx.update(photos).set({ state: "expired" }).where(and(eq(photos.id, row.id), eq(photos.state, "reserved"), lt(photos.expiresAt, at)));
    return due.length;
  });
}
