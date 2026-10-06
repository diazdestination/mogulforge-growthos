import { activitiesTable, db } from "@workspace/db";
import { sql } from "drizzle-orm";

import { ObjectStorageService } from "../lib/objectStorage";
import { expireWorkdayPhotoReservations, storedObjectIsReferenced } from "../lib/stored-object-retention";

/** Grace period before an unreferenced upload is considered orphaned. */
export const DEFAULT_UPLOAD_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * True when the object path (e.g. `/objects/uploads/<id>`) is referenced by
 * any photos_attached activity in ANY organization. Referenced uploads are
 * lead damage photos and must never be deleted.
 */
export async function isUploadReferenced(objectPath: string): Promise<boolean> {
  const native = /^\/objects\/uploads\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(objectPath);
  if (native) return storedObjectIsReferenced(db, native[1]);
  const rows = await db
    .select({ id: activitiesTable.id })
    .from(activitiesTable)
    .where(
      sql`${activitiesTable.type} = 'photos_attached'
        AND ${activitiesTable.metadata} @> ${JSON.stringify({ photoPaths: [objectPath] })}::jsonb`,
    )
    .limit(1);
  return rows.length > 0;
}

export interface UploadObject {
  /** Object path as referenced by activities, e.g. `/objects/uploads/<id>`. */
  objectPath: string;
  /** Creation time of the object. */
  createdAt: Date;
  /** Delete this object from the bucket. */
  remove: () => Promise<void | boolean>;
}

/** Lists objects under the private `uploads/` prefix in the bucket. */
export async function listUploadObjects(): Promise<UploadObject[]> {
  const service = new ObjectStorageService();
  return service.listObjectEntityUploads();
}

export interface CleanupResult {
  scanned: number;
  deleted: number;
  kept: number;
  errors: number;
}

/**
 * Deletes objects under the private `uploads/` prefix that are older than the
 * grace period and not referenced by any photos_attached activity's
 * metadata.photoPaths. Referenced objects are never deleted.
 *
 * `listObjects` is injectable for tests; production uses the bucket listing.
 */
export async function cleanupOrphanedUploads(options?: {
  maxAgeMs?: number;
  now?: Date;
  listObjects?: () => Promise<UploadObject[]>;
}): Promise<CleanupResult> {
  const maxAgeMs = options?.maxAgeMs ?? DEFAULT_UPLOAD_MAX_AGE_MS;
  const now = options?.now ?? new Date();
  const list = options?.listObjects ?? listUploadObjects;

  const result: CleanupResult = { scanned: 0, deleted: 0, kept: 0, errors: 0 };
  await expireWorkdayPhotoReservations(now);
  const objects = await list();
  for (const obj of objects) {
    result.scanned += 1;
    // Grace period: never touch fresh uploads — the assessment referencing
    // them may not have been submitted yet.
    if (now.getTime() - obj.createdAt.getTime() < maxAgeMs) {
      result.kept += 1;
      continue;
    }
    try {
      if (await isUploadReferenced(obj.objectPath)) {
        result.kept += 1;
        continue;
      }
      if (await obj.remove() === false) result.kept += 1;
      else result.deleted += 1;
    } catch (err) {
      result.errors += 1;
      console.error(
        `[upload-cleanup] failed to process ${obj.objectPath}:`,
        err,
      );
    }
  }
  return result;
}
