import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { contactsTable, db, leadsTable, propertiesTable, usersTable, type UserRole } from "@workspace/db";
import { customerWorkRootsTable } from "../../../../lib/db/src/schema/customer-work";
import { hasPermission, type Permission } from "../lib/permissions";
import { lockContractorSchedule } from "./contractor-scheduling";
import { getCustomerLifecycleStatus } from "./customer-lifecycle";
import { canonicalCustomerWorkValue, CustomerWorkError } from "./returning-customer-contract";

export type CustomerWorkTx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type CustomerWorkReader = typeof db | CustomerWorkTx;
export type CustomerWorkActor = { userId: string; effectiveRole?: UserRole };
export function customerWorkFail(code: string, message = "This saved work changed or is unavailable. Refresh the exact original record before continuing.", status = 409): never { throw new CustomerWorkError(status, code, message); }
export const customerWorkHash = (value: unknown) => createHash("sha256").update(canonicalCustomerWorkValue(value)).digest("hex");
export function assertCustomerWorkReader(reader: CustomerWorkReader, locked: boolean) { if (locked && reader === db) customerWorkFail("customer_work_transaction_required", "Locked authority requires the original transaction.", 503); }
export async function lockCustomerWork(tx: CustomerWorkTx, org: string, billing = false) {
  await tx.execute(sql`select set_config('lock_timeout','3000ms',true),set_config('statement_timeout','10000ms',true)`);
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`customer-lifecycle:${org}`},0))`);
  await lockContractorSchedule(tx, org);
  if (billing) await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`invoices:${org}`},0))`);
}
export async function customerWorkActor(reader: CustomerWorkReader, org: string, actor: CustomerWorkActor, permission: Permission, locked = false) {
  assertCustomerWorkReader(reader, locked);
  const q = reader.select().from(usersTable).where(and(eq(usersTable.organizationId, org), eq(usersTable.id, actor.userId)));
  const [user] = await (locked ? q.for("share") : q);
  if (!user?.isActive || !user.emailVerifiedAt || user.id.startsWith("invite:") || !hasPermission(user.role, permission) || !hasPermission(actor.effectiveRole ?? user.role, permission)) customerWorkFail("customer_work_access_denied", "An accepted, verified, active staff session with the current permission is required.", 403);
  return user;
}
export async function assertCustomerWorkActive(reader: CustomerWorkReader, org: string) {
  if (!(await getCustomerLifecycleStatus(org, reader)).automationAllowed) customerWorkFail("customer_work_company_held", "This company is paused or offboarding. Retained work is read-only.");
}
export async function readCustomerWorkParents(reader: CustomerWorkReader, org: string, contactId: string, propertyId: string | null, locked = false) {
  assertCustomerWorkReader(reader, locked);
  const cq = reader.select().from(contactsTable).where(and(eq(contactsTable.organizationId, org), eq(contactsTable.id, contactId)));
  const [contact] = await (locked ? cq.for("share") : cq);
  if (!contact) customerWorkFail("customer_work_parent_unavailable", "Choose an existing customer in this company.", 404);
  let property: typeof propertiesTable.$inferSelect | null = null;
  if (propertyId) {
    const pq = reader.select().from(propertiesTable).where(and(eq(propertiesTable.organizationId, org), eq(propertiesTable.id, propertyId)));
    const [row] = await (locked ? pq.for("share") : pq);
    if (!row || row.contactId !== contactId) customerWorkFail("customer_work_parent_mismatch", "Choose a property currently belonging to this exact customer.");
    property = row;
  }
  return { contact, property };
}
export async function readCustomerWorkRoot(reader: CustomerWorkReader, org: string, rootId: string, locked = false) {
  assertCustomerWorkReader(reader, locked);
  const q = reader.select().from(customerWorkRootsTable).where(and(eq(customerWorkRootsTable.organizationId, org), eq(customerWorkRootsTable.id, rootId)));
  const [root] = await (locked ? q.for("share") : q);
  if (!root) customerWorkFail("customer_work_not_found", "This returning work is unavailable in your company.", 404);
  return { root, ...await readCustomerWorkParents(reader, org, root.contactId, root.propertyId, locked) };
}
export async function createCustomerWorkRoot(tx: CustomerWorkTx, org: string, actorUserId: string, source: {contactId: string;propertyId: string | null}) {
  await readCustomerWorkParents(tx, org, source.contactId, source.propertyId, true);
  const [root] = await tx.insert(customerWorkRootsTable).values({organizationId: org, contactId: source.contactId, propertyId: source.propertyId, createdByUserId: actorUserId}).returning();
  return root!;
}
export async function readNativeWorkLineage(reader: CustomerWorkReader, org: string, refs: {leadId: string | null;customerWorkId: string | null}, locked = false) {
  assertCustomerWorkReader(reader, locked);
  if (refs.customerWorkId && refs.leadId === null) return { kind: "customer_work" as const, lead: null, ...await readCustomerWorkRoot(reader, org, refs.customerWorkId, locked) };
  if (!refs.leadId || refs.customerWorkId !== null) customerWorkFail("customer_work_scope_invalid");
  const q = reader.select().from(leadsTable).where(and(eq(leadsTable.organizationId, org), eq(leadsTable.id, refs.leadId)));
  const [lead] = await (locked ? q.for("share") : q);
  if (!lead) customerWorkFail("customer_work_not_found", "The source opportunity is unavailable in this company.", 404);
  return { kind: "lead" as const, lead, root: null, ...await readCustomerWorkParents(reader, org, lead.contactId, lead.propertyId, locked) };
}
export function nativeWorkLabels(lineage: Awaited<ReturnType<typeof readNativeWorkLineage>>) {
  const customerLabel = [lineage.contact.firstName, lineage.contact.lastName].filter(Boolean).join(" ").trim() || "Customer";
  const propertyLabel = lineage.property ? [lineage.property.addressLine1, lineage.property.addressLine2, lineage.property.city, lineage.property.state, lineage.property.postalCode].filter(Boolean).join(", ") : null;
  return { sourceKind: lineage.kind, contactId: lineage.contact.id, propertyId: lineage.property?.id ?? null, customerLabel, propertyLabel, leadLabel: lineage.lead ? (lineage.lead.summary?.trim() || customerLabel) : null };
}
