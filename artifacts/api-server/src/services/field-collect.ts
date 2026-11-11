import {
  appointmentsTable,
  customerWorkRootsTable,
  db,
  invoicesTable,
  usersTable,
  type UserRole,
} from "@workspace/db";
import { and, desc, eq, gte, lte, ne, or, isNull, sql } from "drizzle-orm";

import { hasPermission } from "../lib/permissions";
import { readInvoiceDetail } from "./invoices";

/**
 * Field collection (payments.collect): a tech may read the balance of, create
 * the sandbox pay link for, show the QR of and text the pay link of an issued
 * invoice ONLY when it is linked to an appointment assigned to them. Office
 * roles keep their broader invoices.* paths; this module never lists, edits or
 * voids invoices.
 *
 * How an appointment links to its invoices (existing data model, no new table):
 *  - appointment has a lead  -> issued invoices of that lead;
 *  - appointment has no lead -> issued returning-customer (customer work)
 *    invoices of the appointment's customer, at the same property when both
 *    the appointment and the work record name one.
 * The appointment must be assigned to the member, not cancelled, and within
 * FIELD_COLLECT_WINDOW_DAYS of now, so access ends after the job.
 */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Reader = typeof db | Tx;
type Appointment = typeof appointmentsTable.$inferSelect;
export type FieldActor = { userId: string; effectiveRole?: UserRole };

export const FIELD_COLLECT_WINDOW_DAYS = 7;
const LINKED_LIMIT = 5;

export class FieldCollectError extends Error {
  constructor(public status: 403 | 404, public code: string, message: string) {
    super(message);
  }
}

export async function canFieldCollect(reader: Reader, org: string, actor: FieldActor): Promise<boolean> {
  const [user] = await reader
    .select({ role: usersTable.role })
    .from(usersTable)
    .where(and(eq(usersTable.organizationId, org), eq(usersTable.id, actor.userId), eq(usersTable.isActive, true)));
  return !!user && hasPermission(user.role, "payments.collect") && hasPermission(actor.effectiveRole ?? user.role, "payments.collect");
}

export function withinFieldWindow(start: Date, now = new Date()): boolean {
  return Math.abs(start.getTime() - now.getTime()) <= FIELD_COLLECT_WINDOW_DAYS * 86_400_000;
}

/** Issued invoices linked to this appointment, newest first (see rule above). */
export async function linkedInvoiceIds(reader: Reader, org: string, appointment: Pick<Appointment, "leadId" | "contactId" | "propertyId">): Promise<string[]> {
  if (appointment.leadId) {
    const rows = await reader
      .select({ id: invoicesTable.id })
      .from(invoicesTable)
      .where(and(eq(invoicesTable.organizationId, org), eq(invoicesTable.leadId, appointment.leadId), eq(invoicesTable.status, "issued")))
      .orderBy(desc(invoicesTable.createdAt), invoicesTable.id)
      .limit(LINKED_LIMIT);
    return rows.map((row) => row.id);
  }
  if (!appointment.contactId) return [];
  const rows = await reader
    .select({ id: invoicesTable.id })
    .from(invoicesTable)
    .innerJoin(
      customerWorkRootsTable,
      and(eq(customerWorkRootsTable.organizationId, org), eq(customerWorkRootsTable.id, invoicesTable.customerWorkId)),
    )
    .where(
      and(
        eq(invoicesTable.organizationId, org),
        eq(invoicesTable.status, "issued"),
        eq(customerWorkRootsTable.contactId, appointment.contactId),
        appointment.propertyId
          ? or(isNull(customerWorkRootsTable.propertyId), eq(customerWorkRootsTable.propertyId, appointment.propertyId))
          : undefined,
      ),
    )
    .orderBy(desc(invoicesTable.createdAt), invoicesTable.id)
    .limit(LINKED_LIMIT);
  return rows.map((row) => row.id);
}

/**
 * Prove the invoice is linked to one of the actor's own current appointments.
 * With an appointmentId, that exact job; without (re-checking a queued text),
 * any of their current jobs. Returns the appointment that grants access.
 */
export async function assertFieldCollectScope(
  reader: Reader,
  org: string,
  actor: FieldActor,
  invoiceId: string,
  appointmentId: string | null,
  now = new Date(),
): Promise<Appointment> {
  if (!(await canFieldCollect(reader, org, actor))) {
    throw new FieldCollectError(403, "field_collect_denied", "Collecting payment on the job needs field collection access.");
  }
  const windowMs = FIELD_COLLECT_WINDOW_DAYS * 86_400_000;
  const jobs = await reader
    .select()
    .from(appointmentsTable)
    .where(
      and(
        eq(appointmentsTable.organizationId, org),
        eq(appointmentsTable.assignedUserId, actor.userId),
        ne(appointmentsTable.status, "cancelled"),
        gte(appointmentsTable.scheduledStart, new Date(now.getTime() - windowMs)),
        lte(appointmentsTable.scheduledStart, new Date(now.getTime() + windowMs)),
        appointmentId ? eq(appointmentsTable.id, appointmentId) : sql`true`,
      ),
    )
    .orderBy(desc(appointmentsTable.scheduledStart))
    .limit(40);
  if (appointmentId && !jobs.length) {
    throw new FieldCollectError(404, "field_job_not_found", "This job is not one of your current assigned jobs.");
  }
  for (const job of jobs) {
    if ((await linkedInvoiceIds(reader, org, job)).includes(invoiceId)) return job;
  }
  throw new FieldCollectError(403, "field_invoice_not_linked", "This invoice is not linked to a job assigned to you.");
}

/** The invoice detail a tech may see, after the scope check. */
export async function readFieldInvoice(reader: Reader, org: string, actor: FieldActor, invoiceId: string, appointmentId: string | null, options: { lockRows?: boolean } = {}) {
  const appointment = await assertFieldCollectScope(reader, org, actor, invoiceId, appointmentId);
  const invoice = await readInvoiceDetail(reader, org, actor.userId, invoiceId, { effectiveRole: actor.effectiveRole, lockRows: options.lockRows, readAs: "payments.collect" });
  return { appointment, invoice };
}

