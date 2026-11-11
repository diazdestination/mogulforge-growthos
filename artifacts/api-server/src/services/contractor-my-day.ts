import {
  appointmentsTable,
  contactsTable,
  db,
  leadsTable,
  organizationsTable,
  propertiesTable,
  usersTable,
  zapierActionExecutionsTable,
  type UserRole,
} from "@workspace/db";
import { and, asc, eq, gt, inArray, lt, ne, or, isNull, sql } from "drizzle-orm";
import { companyDayBounds } from "@workspace/scheduling-core";
import { z } from "zod/v4";

import { hasPermission } from "../lib/permissions";
import { linkedInvoiceIds, withinFieldWindow } from "./field-collect";
import { readInvoiceDetail } from "./invoices";
import { getZapierCapability } from "./zapier/zapier-capabilities";
import { defaultPolicyFor, getZapierBinding, getZapierPolicy } from "./zapier/zapier-connection";
import { APPT_ON_MY_WAY_ENTITY, companyDateOf } from "./zapier/zapier-specialist-flows";

/**
 * The signed-in member's own field day: appointments assigned to them today
 * and the next few days, with what a tech needs at the door (who, where, how
 * to call, notes) and the balance of invoices linked to the job when the member
 * may read invoices or collect in the field. Read-only; every query is company-scoped.
 */

export const myDayQuery = z.object({ date: z.iso.date().optional() }).strict();
const UPCOMING_DAYS = 3;
const LIMIT = 40;

export class MyDayError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export type MyDayInvoice = {
  id: string;
  invoiceNumber: string | null;
  title: string;
  totalCents: number;
  balanceDueCents: number | null;
  paymentState: string;
};

export type MyDayJob = {
  id: string;
  type: string;
  status: string;
  scheduledStart: string;
  scheduledEnd: string | null;
  notes: string | null;
  leadId: string | null;
  contactId: string | null;
  customerName: string | null;
  customerPhone: string | null;
  propertyId: string | null;
  address: string | null;
  directionsUrl: string | null;
  /** Issued invoices linked to this job; null when the member may not see them here. */
  invoices: MyDayInvoice[] | null;
  onMyWay: { state: string; etaMinutes: number | null } | null;
};

export type MyDay = {
  organizationId: string;
  userId: string;
  generatedAt: string;
  date: string;
  timeZone: string;
  canReadInvoices: boolean;
  canCollectPayments: boolean;
  texting: { onMyWay: boolean; payLink: boolean };
  today: MyDayJob[];
  upcoming: MyDayJob[];
};

const validZone = (value: unknown): value is string => {
  if (typeof value !== "string" || value.length > 100) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
};

function addDays(date: string, days: number): string {
  const day = new Date(`${date}T12:00:00Z`);
  day.setUTCDate(day.getUTCDate() + days);
  return day.toISOString().slice(0, 10);
}

function addressOf(property: typeof propertiesTable.$inferSelect | null): string | null {
  if (!property) return null;
  const line = [property.addressLine1, property.addressLine2, [property.city, [property.state, property.postalCode].filter(Boolean).join(" ")].filter(Boolean).join(", ")]
    .map((part) => (part ?? "").trim())
    .filter(Boolean)
    .join(", ");
  return line || null;
}

async function textingReady(organizationId: string, capability: string): Promise<boolean> {
  const definition = getZapierCapability(capability);
  if (!definition || !(await getZapierBinding(organizationId, capability))) return false;
  const policy = (await getZapierPolicy(organizationId, capability)) ?? defaultPolicyFor(definition);
  return policy.mode !== "off" && policy.dailyBudget > 0;
}

export async function getMyDay(
  organizationId: string,
  userId: string,
  input: z.infer<typeof myDayQuery> = {},
  effectiveRole?: UserRole,
  now = new Date(),
): Promise<MyDay> {
  const query = myDayQuery.parse(input);
  const [actor] = await db
    .select()
    .from(usersTable)
    .where(and(eq(usersTable.id, userId), eq(usersTable.organizationId, organizationId), eq(usersTable.isActive, true)));
  const role = effectiveRole ?? actor?.role;
  if (!actor || !role || !hasPermission(actor.role, "crm.read") || !hasPermission(role, "crm.read")) {
    throw new MyDayError(403, "An active company membership is required.");
  }
  const [company] = await db.select({ timezone: organizationsTable.timezone }).from(organizationsTable).where(eq(organizationsTable.id, organizationId));
  if (!validZone(company?.timezone)) {
    throw new MyDayError(409, "The company timezone is invalid. Ask a platform administrator to correct it.");
  }
  const timeZone = company.timezone;
  const date = query.date ?? companyDateOf(now, timeZone);
  const today = companyDayBounds(date, timeZone);
  const windowEnd = companyDayBounds(addDays(date, UPCOMING_DAYS), timeZone).to;

  const rows = await db
    .select({ appointment: appointmentsTable, contact: contactsTable, leadContact: sql<string | null>`${leadsTable.contactId}`, leadProperty: sql<string | null>`${leadsTable.propertyId}` })
    .from(appointmentsTable)
    .leftJoin(leadsTable, and(eq(leadsTable.id, appointmentsTable.leadId), eq(leadsTable.organizationId, organizationId)))
    .leftJoin(
      contactsTable,
      and(eq(contactsTable.organizationId, organizationId), eq(contactsTable.id, sql`coalesce(${appointmentsTable.contactId}, ${leadsTable.contactId})`)),
    )
    .where(
      and(
        eq(appointmentsTable.organizationId, organizationId),
        eq(appointmentsTable.assignedUserId, userId),
        ne(appointmentsTable.status, "cancelled"),
        lt(appointmentsTable.scheduledStart, new Date(windowEnd)),
        or(
          gt(appointmentsTable.scheduledEnd, new Date(today.from)),
          and(isNull(appointmentsTable.scheduledEnd), gt(appointmentsTable.scheduledStart, new Date(Date.parse(today.from) - 2 * 60 * 60_000))),
        ),
      ),
    )
    .orderBy(asc(appointmentsTable.scheduledStart), asc(appointmentsTable.id))
    .limit(LIMIT);

  const propertyIds = [...new Set(rows.map((row) => row.appointment.propertyId ?? row.leadProperty).filter((id): id is string => !!id))];
  const properties = propertyIds.length
    ? await db.select().from(propertiesTable).where(and(eq(propertiesTable.organizationId, organizationId), inArray(propertiesTable.id, propertyIds)))
    : [];

  const canReadInvoices = hasPermission(actor.role, "invoices.read") && hasPermission(role, "invoices.read");
  const canCollectPayments = hasPermission(actor.role, "payments.collect") && hasPermission(role, "payments.collect");

  const todayKeys = rows.map((row) => `appt-omw:${row.appointment.id}:${date}`);
  const onMyWayRows = todayKeys.length
    ? await db
        .select({ key: zapierActionExecutionsTable.idempotencyKey, state: zapierActionExecutionsTable.state, summary: zapierActionExecutionsTable.requestSummary })
        .from(zapierActionExecutionsTable)
        .where(
          and(
            eq(zapierActionExecutionsTable.organizationId, organizationId),
            eq(zapierActionExecutionsTable.linkedEntityType, APPT_ON_MY_WAY_ENTITY),
            inArray(zapierActionExecutionsTable.idempotencyKey, todayKeys),
          ),
        )
    : [];

  // Invoices linked to each of my jobs (services/field-collect.ts). Office invoice readers see them
  // for any of their own jobs; field collectors only inside the collection window.
  async function invoicesFor(appointment: typeof appointmentsTable.$inferSelect): Promise<MyDayInvoice[] | null> {
    const readAs = canReadInvoices ? undefined : canCollectPayments && withinFieldWindow(appointment.scheduledStart, now) ? ("payments.collect" as const) : null;
    if (readAs === null) return null;
    const ids = await linkedInvoiceIds(db, organizationId, appointment);
    const items: MyDayInvoice[] = [];
    for (const id of ids) {
      const invoice = await readInvoiceDetail(db, organizationId, userId, id, { effectiveRole, readAs }).catch(() => null);
      if (!invoice || invoice.status !== "issued") continue;
      items.push({
        id: invoice.id,
        invoiceNumber: invoice.invoiceNumber,
        title: invoice.title,
        totalCents: invoice.totalCents,
        balanceDueCents: invoice.balanceDueCents,
        paymentState: invoice.paymentState,
      });
    }
    return items;
  }

  const jobs: MyDayJob[] = [];
  for (const { appointment, contact, leadProperty } of rows) {
    const propertyId = appointment.propertyId ?? leadProperty;
    const rawProperty = propertyId ? properties.find((item) => item.id === propertyId) ?? null : null;
    // Never show an address that belongs to a different customer.
    const property = rawProperty && contact && rawProperty.contactId === contact.id ? rawProperty : null;
    const address = addressOf(property);
    const omw = onMyWayRows.find((item) => item.key === `appt-omw:${appointment.id}:${date}`);
    const eta = omw?.summary?.etaMinutes;
    jobs.push({
      id: appointment.id,
      type: appointment.type,
      status: appointment.status,
      scheduledStart: appointment.scheduledStart.toISOString(),
      scheduledEnd: appointment.scheduledEnd?.toISOString() ?? null,
      notes: appointment.notes,
      leadId: appointment.leadId,
      contactId: contact?.id ?? null,
      customerName: contact ? [contact.firstName, contact.lastName].filter(Boolean).join(" ").trim() || null : null,
      customerPhone: contact?.phone?.trim() || null,
      propertyId: property?.id ?? null,
      address,
      directionsUrl: address ? `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(address)}` : null,
      invoices: await invoicesFor(appointment),
      onMyWay: omw ? { state: omw.state, etaMinutes: typeof eta === "number" ? eta : null } : null,
    });
  }

  const [onMyWay, payLink] = await Promise.all([textingReady(organizationId, "appt.sms.on_my_way"), textingReady(organizationId, "bill.sms.payment_link")]);
  const todayEnd = Date.parse(today.to);
  return {
    organizationId,
    userId,
    generatedAt: now.toISOString(),
    date,
    timeZone,
    canReadInvoices,
    canCollectPayments,
    texting: { onMyWay, payLink: payLink && canCollectPayments },
    today: jobs.filter((job) => Date.parse(job.scheduledStart) < todayEnd),
    upcoming: jobs.filter((job) => Date.parse(job.scheduledStart) >= todayEnd),
  };
}
