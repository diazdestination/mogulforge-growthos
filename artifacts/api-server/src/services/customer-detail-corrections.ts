import { createHash } from "node:crypto";
import { types } from "node:util";
import { auditEventsTable, contactsTable, db, propertiesTable, usersTable, type UserRole } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { z } from "zod/v4";
import { canonicalDetailCorrectionPayload, customerDetailCorrectionReceiptSchema, customerDetailSnapshotSchema, DETAIL_CORRECTION_ACTION, DETAIL_CORRECTION_FIELDS, DETAIL_CORRECTION_SCHEMA_VERSION, detailCorrectionAuditMetadataSchema, detailCorrectionIdSchema, detailCorrectionInputSchema, DetailCorrectionError, type CustomerDetailCorrectionReceipt, type CustomerDetailSnapshot, type DetailCorrectionChangedField, type DetailCorrectionInput } from "./customer-detail-correction-contract";
export { DetailCorrectionError } from "./customer-detail-correction-contract";
export type { CustomerDetailCorrectionReceipt, CustomerDetailSnapshot, DetailCorrectionInput } from "./customer-detail-correction-contract";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Contact = typeof contactsTable.$inferSelect;
type Property = typeof propertiesTable.$inferSelect;
export type DetailCorrectionContext = { organizationId: string; contactId: string; actorUserId: string; effectiveRole?: UserRole };
const roles = ["owner", "admin", "sales_manager", "sales_rep", "inspector", "production", "office", "viewer"] as const;
const contextSchema = z.object({ organizationId: detailCorrectionIdSchema, contactId: detailCorrectionIdSchema, actorUserId: z.string().min(1).max(200).refine(value => value === value.trim() && !/[\x00-\x1f\x7f]/.test(value)), effectiveRole: z.enum(roles).optional() }).strict();
const staff = new Set<UserRole>(["owner", "admin", "office"]);
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
function context(value: unknown): DetailCorrectionContext { const parsed = contextSchema.safeParse(value); if (!parsed.success) throw new DetailCorrectionError(400, "detail_correction_invalid_request"); return parsed.data; }
function id(value: unknown): string { const parsed = detailCorrectionIdSchema.safeParse(value); if (!parsed.success) throw new DetailCorrectionError(400, "detail_correction_invalid_request"); return parsed.data; }

// Trusted session identity/effective role comes from the route. This service
// rereads and SHARE-locks actual accepted membership; it is not session/key auth.
async function actor(tx: Tx, c: DetailCorrectionContext) {
  const [user] = await tx.select().from(usersTable).where(and(eq(usersTable.organizationId, c.organizationId), eq(usersTable.id, c.actorUserId))).for("share");
  if (!user || !user.isActive || !user.emailVerifiedAt || user.id.startsWith("invite:") || !staff.has(user.role) || !staff.has(c.effectiveRole ?? user.role)) throw new DetailCorrectionError(403, "detail_correction_access_denied");
}
async function contact(tx: Tx, c: DetailCorrectionContext, write: boolean): Promise<Contact> {
  const query = tx.select().from(contactsTable).where(and(eq(contactsTable.organizationId, c.organizationId), eq(contactsTable.id, c.contactId)));
  const [row] = await query.for(write ? "update" : "share");
  if (!row) throw new DetailCorrectionError(404, "detail_correction_contact_not_found");
  return row;
}
async function property(tx: Tx, c: DetailCorrectionContext, propertyId: string | null, write: boolean): Promise<Property | null> {
  if (propertyId === null) return null;
  const query = tx.select().from(propertiesTable).where(and(eq(propertiesTable.organizationId, c.organizationId), eq(propertiesTable.id, propertyId)));
  const [row] = await query.for(write ? "update" : "share");
  if (!row) throw new DetailCorrectionError(404, "detail_correction_property_not_found");
  if (row.contactId !== c.contactId) throw new DetailCorrectionError(409, "detail_correction_property_parent_changed");
  return row;
}
function snapshot(c: DetailCorrectionContext, customer: Contact, selected: Property | null): CustomerDetailSnapshot {
  const details = { firstName: customer.firstName, lastName: customer.lastName, email: customer.email, phone: customer.phone, property: selected ? { addressLine1: selected.addressLine1, addressLine2: selected.addressLine2, city: selected.city, state: selected.state, postalCode: selected.postalCode } : null };
  const times = { contactUpdatedAt: customer.updatedAt.toISOString(), propertyUpdatedAt: selected?.updatedAt.toISOString() ?? null };
  const fingerprint = hash(JSON.stringify({ schemaVersion: "customer-detail-snapshot.v1", organizationId: c.organizationId, contactId: customer.id, propertyId: selected?.id ?? null, details, ...times, guard: { contactCreatedAt: customer.createdAt.toISOString(), preferredContactMethod: customer.preferredContactMethod, doNotContact: customer.doNotContact, doNotContactEmail: customer.doNotContactEmail, doNotContactSms: customer.doNotContactSms, propertyContactId: selected?.contactId ?? null, propertyCreatedAt: selected?.createdAt.toISOString() ?? null, latitude: selected?.latitude ?? null, longitude: selected?.longitude ?? null, propertyType: selected?.propertyType ?? null } }));
  const result = customerDetailSnapshotSchema.safeParse({ organizationId: c.organizationId, contactId: customer.id, propertyId: selected?.id ?? null, details, version: { ...times, fingerprint } });
  if (!result.success || Buffer.byteLength(JSON.stringify(result.data)) > 30_000) throw new DetailCorrectionError(503, "detail_correction_snapshot_unavailable");
  return result.data;
}
function receipt(row: typeof auditEventsTable.$inferSelect, c: DetailCorrectionContext): { receipt: CustomerDetailCorrectionReceipt; digest: string } {
  const metadata = detailCorrectionAuditMetadataSchema.safeParse(row.metadata);
  if (!metadata.success || Buffer.byteLength(JSON.stringify(row.metadata)) > 65_536 || row.action !== DETAIL_CORRECTION_ACTION || row.entityType !== "contact" || row.entityId !== c.contactId || row.actorUserId !== c.actorUserId || row.organizationId !== c.organizationId || metadata.data.after.contactId !== c.contactId || metadata.data.after.organizationId !== c.organizationId) throw new DetailCorrectionError(503, "detail_correction_receipt_unavailable");
  const m = metadata.data;
  const value = customerDetailCorrectionReceiptSchema.safeParse({ requestId: row.id, status: m.status, committedAt: m.committedAt, changedFields: m.changedFields, snapshot: m.after });
  if (!value.success) throw new DetailCorrectionError(503, "detail_correction_receipt_unavailable");
  return { receipt: value.data, digest: m.requestDigest };
}
function isAuditPrimaryKeyCollision(error: unknown): boolean {
  let value: unknown = error;
  for (let depth = 0; depth < 3 && value && typeof value === "object"; depth++) {
    if (types.isProxy(value)) return false;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const read = (key: string): unknown => {
      const descriptor = descriptors[key];
      return descriptor && "value" in descriptor ? descriptor.value : undefined;
    };
    if (read("code") === "23505" && read("constraint") === "audit_events_pkey" && (read("table") === undefined || read("table") === "audit_events") && (read("schema") === undefined || read("schema") === "public")) return true;
    value = read("cause");
  }
  return false;
}
export async function getCustomerDetailSnapshot(input: DetailCorrectionContext & { propertyId: string | null }): Promise<CustomerDetailSnapshot> {
  const { propertyId: rawProperty, ...rawContext } = input;
  const c = context(rawContext), propertyId = rawProperty === null ? null : id(rawProperty);
  return db.transaction(async tx => {
    await actor(tx, c);
    const customer = await contact(tx, c, false), selected = await property(tx, c, propertyId, false);
    return snapshot(c, customer, selected);
  });
}

export async function saveCustomerDetailCorrection(input: DetailCorrectionContext & { input: unknown }): Promise<{ receipt: CustomerDetailCorrectionReceipt; replayed: boolean }> {
  const { input: rawInput, ...rawContext } = input;
  const c = context(rawContext), parsed = detailCorrectionInputSchema.safeParse(rawInput);
  if (!parsed.success) throw new DetailCorrectionError(400, "detail_correction_invalid_request");
  const command = parsed.data, requestDigest = hash(canonicalDetailCorrectionPayload(c.organizationId, c.contactId, c.actorUserId, command));
  try {
    return await db.transaction(async tx => {
      // Same-contact serialization is native. No advisory lock/new table needed.
      await actor(tx, c);
      const current = await contact(tx, c, true);
      const [existing] = await tx.select().from(auditEventsTable).where(and(eq(auditEventsTable.id, command.requestId), eq(auditEventsTable.organizationId, c.organizationId), eq(auditEventsTable.entityType, "contact"), eq(auditEventsTable.entityId, c.contactId))).limit(1);
      if (existing) {
        if (existing.actorUserId !== c.actorUserId || existing.action !== DETAIL_CORRECTION_ACTION) throw new DetailCorrectionError(409, "detail_correction_request_conflict");
        const saved = receipt(existing, c);
        if (saved.digest !== requestDigest) throw new DetailCorrectionError(409, "detail_correction_request_conflict");
        return { receipt: saved.receipt, replayed: true };
      }
      const selected = await property(tx, c, command.propertyId, true), before = snapshot(c, current, selected);
      if (before.version.contactUpdatedAt !== command.expectedVersion.contactUpdatedAt || before.version.propertyUpdatedAt !== command.expectedVersion.propertyUpdatedAt || before.version.fingerprint !== command.expectedVersion.fingerprint) throw new DetailCorrectionError(409, "detail_correction_stale_version");
      const contactPatch: Partial<Contact> = {}, propertyPatch: Partial<Property> = {}, changedFields: DetailCorrectionChangedField[] = [];
      for (const field of ["firstName", "lastName", "email", "phone"] as const) if (command.changes[field] !== undefined && command.changes[field] !== current[field]) { contactPatch[field] = command.changes[field] as never; changedFields.push(field); }
      if (command.changes.property !== undefined && selected) for (const field of ["addressLine1", "addressLine2", "city", "state", "postalCode"] as const) if (command.changes.property[field] !== undefined && command.changes.property[field] !== selected[field]) { propertyPatch[field] = command.changes.property[field] as never; changedFields.push(`property.${field}`); }
      let savedContact = current, savedProperty = selected;
      if (Object.keys(contactPatch).length) {
        contactPatch.updatedAt = new Date(Math.max(Date.now(), current.updatedAt.getTime() + 1));
        const [row] = await tx.update(contactsTable).set(contactPatch).where(and(eq(contactsTable.organizationId, c.organizationId), eq(contactsTable.id, c.contactId))).returning();
        if (!row) throw new DetailCorrectionError(503, "detail_correction_snapshot_unavailable");
        savedContact = row;
      }
      if (Object.keys(propertyPatch).length && selected) {
        propertyPatch.latitude = null; propertyPatch.longitude = null;
        propertyPatch.updatedAt = new Date(Math.max(Date.now(), selected.updatedAt.getTime() + 1));
        const [row] = await tx.update(propertiesTable).set(propertyPatch).where(and(eq(propertiesTable.organizationId, c.organizationId), eq(propertiesTable.id, selected.id))).returning();
        if (!row) throw new DetailCorrectionError(503, "detail_correction_snapshot_unavailable");
        savedProperty = row;
      }
      const after = snapshot(c, savedContact, savedProperty), committedAt = new Date().toISOString(), status = changedFields.length ? "saved" as const : "unchanged" as const;
      const metadata = detailCorrectionAuditMetadataSchema.parse({ schemaVersion: DETAIL_CORRECTION_SCHEMA_VERSION, requestDigest, propertyId: command.propertyId, before, after, changedFields: DETAIL_CORRECTION_FIELDS.filter(field => changedFields.includes(field)), status, committedAt });
      if (Buffer.byteLength(JSON.stringify(metadata)) > 65_536) throw new DetailCorrectionError(503, "detail_correction_snapshot_unavailable");
      await tx.insert(auditEventsTable).values({ id: command.requestId, organizationId: c.organizationId, actorUserId: c.actorUserId, action: DETAIL_CORRECTION_ACTION, entityType: "contact", entityId: c.contactId, metadata, createdAt: new Date(committedAt) });
      return { receipt: { requestId: command.requestId, status, committedAt, changedFields: metadata.changedFields, snapshot: after }, replayed: false };
    });
  } catch (error) {
    // Transaction rollback includes both rows. Do not relabel other DB failures
    // as a replay/conflict; the route must render unknown errors safely.
    if (isAuditPrimaryKeyCollision(error)) throw new DetailCorrectionError(409, "detail_correction_request_conflict");
    throw error;
  }
}

export async function getCustomerDetailCorrectionReceipt(input: DetailCorrectionContext & { requestId: string }): Promise<CustomerDetailCorrectionReceipt | null> {
  const { requestId: rawRequestId, ...rawContext } = input;
  const c = context(rawContext), requestId = id(rawRequestId);
  return db.transaction(async tx => {
    await actor(tx, c);
    await contact(tx, c, false);
    const [row] = await tx.select().from(auditEventsTable).where(and(eq(auditEventsTable.id, requestId), eq(auditEventsTable.organizationId, c.organizationId), eq(auditEventsTable.actorUserId, c.actorUserId), eq(auditEventsTable.entityType, "contact"), eq(auditEventsTable.entityId, c.contactId), eq(auditEventsTable.action, DETAIL_CORRECTION_ACTION))).limit(1);
    return row ? receipt(row, c).receipt : null;
  });
}
