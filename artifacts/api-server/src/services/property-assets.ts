import { contactsTable, db, propertiesTable, propertyAssetsTable } from "@workspace/db";
import { and, desc, eq, sql } from "drizzle-orm";
import { hasPermission } from "../lib/permissions";
import { z } from "zod/v4";
import { createWorkdayAssetSchema, updateWorkdayAssetSchema, workdayAssetMutationSchema, workdayAssetPageSchema, workdayAssetQuerySchema, workdayAssetSchema } from "./contractor-workday-contract";
import { lockWorkday, workdayActor, workdayAudit, workdayFail, workdayReplay, workdayVersion, type WorkdayActor, type WorkdayReader } from "./workday-shared";

export async function workdayAssetParents(reader: WorkdayReader, org: string, contactId: string, propertyId: string, locked = false) {
  const contact = reader.select().from(contactsTable).where(and(eq(contactsTable.organizationId, org), eq(contactsTable.id, contactId)));
  const [c] = await (locked ? contact.for("share") : contact);
  const property = reader.select().from(propertiesTable).where(and(eq(propertiesTable.organizationId, org), eq(propertiesTable.id, propertyId)));
  const [p] = await (locked ? property.for("share") : property);
  if (!c || !p || p.contactId !== c.id) workdayFail("workday_parent_changed", "Choose a current property belonging to this exact customer.");
  return { contact: c, property: p };
}
export async function projectWorkdayAsset(reader: WorkdayReader, row: typeof propertyAssetsTable.$inferSelect, canWrite: boolean) {
  const [p] = await reader.select({ contactId: propertiesTable.contactId }).from(propertiesTable).where(and(eq(propertiesTable.organizationId, row.organizationId), eq(propertiesTable.id, row.propertyId)));
  const coherent = p?.contactId === row.contactId;
  return workdayAssetSchema.parse({ ...row.facts, id: row.id, organizationId: row.organizationId, contactId: row.contactId, propertyId: row.propertyId, version: row.version, status: row.status, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(), currentParentCoherent: coherent, canEdit: canWrite && coherent });
}
function coverage(v: { warrantyStartsOn: string | null; warrantyEndsOn: string | null; warrantySource: string | null }) {
  if ((v.warrantyStartsOn && v.warrantyEndsOn && v.warrantyStartsOn > v.warrantyEndsOn) || ((v.warrantyStartsOn || v.warrantyEndsOn) && !v.warrantySource?.trim())) workdayFail("workday_warranty_source_required", "Recorded warranty dates require their actual source note and a valid interval.", 400);
}
export async function listWorkdayAssets(org: string, actor: WorkdayActor, contactId: string, raw: unknown) {
  const q = workdayAssetQuerySchema.parse(raw), user = await workdayActor(db, org, actor);
  const [c] = await db.select({ id: contactsTable.id }).from(contactsTable).where(and(eq(contactsTable.organizationId, org), eq(contactsTable.id, contactId)));
  if (!c) workdayFail("workday_not_found", "Customer unavailable in this company.", 404);
  let cursor: { at: string; id: string; org: string; contactId: string; propertyId: string | null } | null = null;
  if (q.cursor) { try { cursor = z.object({ at: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/), id: z.uuid(), org: z.uuid(), contactId: z.uuid(), propertyId: z.uuid().nullable() }).strict().parse(JSON.parse(Buffer.from(q.cursor, "base64url").toString())); if (cursor.org !== org || cursor.contactId !== contactId || cursor.propertyId !== (q.propertyId ?? null) || !Number.isFinite(Date.parse(cursor.at))) throw Error(); } catch { workdayFail("workday_invalid_cursor", "Refresh this customer page.", 400); } }
  const result = await db.execute(sql`SELECT id,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at FROM property_assets
    WHERE organization_id=${org} AND contact_id=${contactId} ${q.propertyId ? sql`AND property_id=${q.propertyId}` : sql``}
    ${cursor ? sql`AND (created_at,id)<(${cursor.at}::timestamptz,${cursor.id}::uuid)` : sql``} ORDER BY created_at DESC,id DESC LIMIT 26`);
  const canWrite = hasPermission(user.role, "crm.write") && hasPermission(actor.effectiveRole ?? user.role, "crm.write");
  const page = result.rows.slice(0, 25), items = [];
  for (const item of page) { const [row] = await db.select().from(propertyAssetsTable).where(and(eq(propertyAssetsTable.organizationId, org), eq(propertyAssetsTable.id, String(item.id)))); if (row) items.push(await projectWorkdayAsset(db, row, canWrite)); }
  const last = page.at(-1), hasMore = result.rows.length > 25;
  return workdayAssetPageSchema.parse({ organizationId: org, contactId, propertyId: q.propertyId ?? null, items, limit: 25, hasMore, nextCursor: hasMore && last ? Buffer.from(JSON.stringify({ at: last.cursor_at, id: last.id, org, contactId, propertyId: q.propertyId ?? null })).toString("base64url") : null, canCreate: canWrite });
}
export async function createWorkdayAsset(org: string, actor: WorkdayActor, contactId: string, raw: unknown) {
  const input = createWorkdayAssetSchema.parse(raw); coverage(input);
  return db.transaction(async tx => {
    await lockWorkday(tx, org); await workdayActor(tx, org, actor, "crm.write", true);
    const payload = { contactId, ...input }, old = await workdayReplay(tx, org, "workday.asset_created", input.requestId, payload);
    if (old) return workdayAssetMutationSchema.parse({ ...old, receipt: { requestId: input.requestId, replayed: true } });
    await workdayAssetParents(tx, org, contactId, input.propertyId, true);
    const { requestId, propertyId, ...facts } = input;
    const [row] = await tx.insert(propertyAssetsTable).values({ organizationId: org, contactId, propertyId, facts, createdByUserId: actor.userId }).returning();
    const result = { organizationId: org, asset: await projectWorkdayAsset(tx, row, true) };
    await workdayAudit(tx, org, actor.userId, "workday.asset_created", row.id, requestId, payload, result);
    return { ...result, receipt: { requestId, replayed: false } };
  });
}
export async function updateWorkdayAsset(org: string, actor: WorkdayActor, id: string, raw: unknown) {
  const input = updateWorkdayAssetSchema.parse(raw); coverage(input);
  return db.transaction(async tx => {
    await lockWorkday(tx, org); await workdayActor(tx, org, actor, "crm.write", true);
    const payload = { id, ...input }, old = await workdayReplay(tx, org, "workday.asset_updated", input.requestId, payload);
    if (old) return workdayAssetMutationSchema.parse({ ...old, receipt: { requestId: input.requestId, replayed: true } });
    const [row] = await tx.select().from(propertyAssetsTable).where(and(eq(propertyAssetsTable.organizationId, org), eq(propertyAssetsTable.id, id))).for("update");
    if (!row) workdayFail("workday_not_found", "Asset unavailable in this company.", 404);
    await workdayAssetParents(tx, org, row.contactId, row.propertyId, true); workdayVersion(row.version, input.expectedVersion);
    const { requestId, expectedVersion: _version, status, ...facts } = input;
    const [updated] = await tx.update(propertyAssetsTable).set({ facts, status, version: row.version + 1, updatedAt: new Date() }).where(eq(propertyAssetsTable.id, id)).returning();
    const result = { organizationId: org, asset: await projectWorkdayAsset(tx, updated, true) };
    await workdayAudit(tx, org, actor.userId, "workday.asset_updated", id, requestId, payload, result);
    return { ...result, receipt: { requestId, replayed: false } };
  });
}
