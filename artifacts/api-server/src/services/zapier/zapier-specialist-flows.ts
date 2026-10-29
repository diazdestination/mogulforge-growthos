import {
  appointmentsTable,
  contactsTable,
  crmTasksTable,
  db,
  invoicesTable,
  leadsTable,
  organizationsTable,
  propertiesTable,
  usersTable,
  zapierActionExecutionsTable,
  type InvoiceDocument,
  type ZapierActionExecution,
} from "@workspace/db";
import { and, desc, eq, gte, inArray, lt } from "drizzle-orm";

import { createContact, createLead, createTask } from "../crm";
import { getZapierBinding } from "./zapier-connection";
import { requestZapierAction, ZapierExecutionError, type ZapierActionOutcome } from "./zapier-executions";
import { sha256Hex } from "./zapier-mcp-client";

/**
 * Bounded specialist workflows on top of the Zapier execution ledger. Every
 * flow is deterministic: GrowthOS records in, typed capability input out.
 * A flow never interprets provider content as instructions; inbound rows
 * become GrowthOS records with their provenance recorded.
 */

const SOURCE_PREFIX = "zapier";

function fullName(first: string | null | undefined, last: string | null | undefined): string {
  return [first ?? "", last ?? ""].join(" ").trim() || "Customer";
}

function addressLine(property: typeof propertiesTable.$inferSelect | null | undefined): string | undefined {
  if (!property) return undefined;
  return [property.addressLine1, property.addressLine2, `${property.city}, ${property.state} ${property.postalCode}`]
    .filter((part) => part && part.trim())
    .join(", ");
}

function isoDate(value: Date | string | null | undefined): string | undefined {
  if (!value) return undefined;
  const date = typeof value === "string" ? new Date(value) : value;
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString().slice(0, 10);
}

// ---------- APPT: appointment -> contractor calendar ----------

export const APPT_CALENDAR_ENTITY = "appointment";

export async function buildAppointmentCalendarInput(organizationId: string, appointmentId: string) {
  const [row] = await db
    .select({
      appointment: appointmentsTable,
      contact: contactsTable,
      property: propertiesTable,
      organization: organizationsTable,
      assignee: usersTable,
    })
    .from(appointmentsTable)
    .innerJoin(organizationsTable, eq(organizationsTable.id, appointmentsTable.organizationId))
    .leftJoin(contactsTable, eq(contactsTable.id, appointmentsTable.contactId))
    .leftJoin(propertiesTable, eq(propertiesTable.id, appointmentsTable.propertyId))
    .leftJoin(usersTable, eq(usersTable.id, appointmentsTable.assignedUserId))
    .where(and(eq(appointmentsTable.organizationId, organizationId), eq(appointmentsTable.id, appointmentId)));
  if (!row) throw new ZapierExecutionError("Appointment not found.", "not_found");
  const { appointment, contact, property, organization, assignee } = row;
  const startsAt = appointment.scheduledStart;
  const endsAt = appointment.scheduledEnd ?? new Date(startsAt.getTime() + 60 * 60_000);
  const customer = fullName(contact?.firstName, contact?.lastName);
  const typeLabel = appointment.type.replace(/_/g, " ");
  const attendeeEmails = assignee?.email ? [assignee.email] : undefined;
  return {
    idempotencyKey: `appt-calendar:${appointment.id}:${appointment.updatedAt.getTime()}`,
    input: {
      title: `${typeLabel}: ${customer}`,
      description: [appointment.notes ?? "", `GrowthOS appointment ${appointment.id}`].filter(Boolean).join("\n\n"),
      location: addressLine(property),
      startsAt: startsAt.toISOString(),
      endsAt: endsAt.toISOString(),
      timezone: organization.timezone,
      attendeeEmails,
    },
  };
}

export async function apptPushAppointmentToCalendar(input: {
  organizationId: string;
  appointmentId: string;
  actorUserId: string | null;
}): Promise<ZapierActionOutcome> {
  const built = await buildAppointmentCalendarInput(input.organizationId, input.appointmentId);
  return requestZapierAction({
    organizationId: input.organizationId,
    capability: "appt.calendar.create_event",
    input: built.input,
    idempotencyKey: built.idempotencyKey,
    requestedByUserId: input.actorUserId,
    linkedEntityType: APPT_CALENDAR_ENTITY,
    linkedEntityId: input.appointmentId,
  });
}

// ---------- INVO: issued invoice -> accounting ----------

export const INVO_ACCOUNTING_ENTITY = "invoice";

export async function buildInvoiceAccountingInput(organizationId: string, invoiceId: string) {
  const [row] = await db
    .select({ invoice: invoicesTable, lead: leadsTable, contact: contactsTable })
    .from(invoicesTable)
    .leftJoin(leadsTable, eq(leadsTable.id, invoicesTable.leadId))
    .leftJoin(contactsTable, eq(contactsTable.id, leadsTable.contactId))
    .where(and(eq(invoicesTable.organizationId, organizationId), eq(invoicesTable.id, invoiceId)));
  if (!row) throw new ZapierExecutionError("Invoice not found.", "not_found");
  const { invoice, contact } = row;
  if (invoice.status !== "issued" || !invoice.issuedDocument || !invoice.invoiceNumber) {
    throw new ZapierExecutionError("Only an issued invoice can be sent to accounting.", "invalid_input");
  }
  const document: InvoiceDocument = invoice.issuedDocument;
  return {
    idempotencyKey: `invo-accounting:${invoice.id}:v${invoice.version}`,
    input: {
      invoiceNumber: invoice.invoiceNumber,
      customerName: document.customerName,
      customerEmail: contact?.email ?? undefined,
      customerAddress: document.customerAddress ?? undefined,
      issuedOn: isoDate(invoice.issuedAt) ?? isoDate(new Date())!,
      dueOn: document.dueDate ?? undefined,
      memo: document.notes ?? undefined,
      lineItems: document.lineItems.map((item) => ({
        description: item.description,
        quantity: Number(item.quantity) || 1,
        unitPriceCents: item.unitPriceCents,
        totalCents: item.totalCents,
      })),
      subtotalCents: document.subtotalCents,
      taxCents: document.taxCents,
      totalCents: document.totalCents,
    },
  };
}

export async function invoPushInvoiceToAccounting(input: {
  organizationId: string;
  invoiceId: string;
  actorUserId: string | null;
}): Promise<ZapierActionOutcome> {
  const built = await buildInvoiceAccountingInput(input.organizationId, input.invoiceId);
  return requestZapierAction({
    organizationId: input.organizationId,
    capability: "invo.accounting.create_invoice",
    input: built.input,
    idempotencyKey: built.idempotencyKey,
    requestedByUserId: input.actorUserId,
    linkedEntityType: INVO_ACCOUNTING_ENTITY,
    linkedEntityId: input.invoiceId,
  });
}

// ---------- SCOUT: marketplace leads and reviews -> GrowthOS ----------

type InboundRecord = Record<string, unknown>;

function pick(record: InboundRecord, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim().slice(0, 500);
    if (typeof value === "number") return String(value);
  }
  return undefined;
}

function recordsOf(value: unknown): InboundRecord[] {
  if (Array.isArray(value)) return value.filter((item) => item && typeof item === "object") as InboundRecord[];
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of ["results", "result", "data", "items"]) {
      if (Array.isArray(record[key])) return recordsOf(record[key]);
    }
  }
  return [];
}

function externalIdOf(record: InboundRecord, fallback: string): string {
  return pick(record, ["id", "ID", "Id", "lead_id", "leadId", "review_id", "reviewId", "name"]) ?? fallback;
}

export type ScoutSyncSummary = {
  execution: ZapierActionExecution;
  received: number;
  created: number;
  skipped: number;
};

/**
 * Read new marketplace leads and create each GrowthOS opportunity once. The
 * external id is recorded on the lead so a re-read never duplicates it.
 */
export async function scoutSyncMarketplaceLeads(input: {
  organizationId: string;
  actorUserId: string | null;
}): Promise<ScoutSyncSummary> {
  const binding = await getZapierBinding(input.organizationId, "scout.leads.list");
  const stamp = new Date().toISOString().slice(0, 13); // hourly idempotency window
  const outcome = await requestZapierAction({
    organizationId: input.organizationId,
    capability: "scout.leads.list",
    input: {},
    idempotencyKey: `scout-leads:${stamp}`,
    requestedByUserId: input.actorUserId,
  });
  const records = recordsOf(outcome.value);
  let created = 0;
  let skipped = 0;
  const sourceDetail = binding ? `${SOURCE_PREFIX}:${binding.zapierAppName}` : SOURCE_PREFIX;
  for (const record of records) {
    const externalId = externalIdOf(record, `${stamp}:${records.indexOf(record)}`);
    const importKey = `${sourceDetail}:${externalId}`.slice(0, 200);
    const [existing] = await db
      .select({ id: leadsTable.id })
      .from(leadsTable)
      .where(and(eq(leadsTable.organizationId, input.organizationId), eq(leadsTable.importSourceKey, importKey)))
      .limit(1);
    if (existing) {
      skipped += 1;
      continue;
    }
    const firstName = pick(record, ["first_name", "firstName", "First Name", "name", "full_name", "Full Name"]) ?? "Marketplace";
    const lastName = pick(record, ["last_name", "lastName", "Last Name"]);
    const contact = await createContact(input.organizationId, {
      firstName: firstName.split(" ")[0] ?? firstName,
      lastName: lastName ?? (firstName.includes(" ") ? firstName.split(" ").slice(1).join(" ") : null),
      email: pick(record, ["email", "Email", "email_address"]) ?? null,
      phone: pick(record, ["phone", "Phone", "phone_number", "mobile"]) ?? null,
    });
    const lead = await createLead(input.organizationId, {
      contactId: contact.id,
      serviceType: pick(record, ["service", "service_type", "category", "job_type"]) ?? null,
      source: sourceDetail,
      sourceDetail: binding?.zapierActionName ?? null,
      summary: pick(record, ["description", "message", "notes", "details", "comments"]) ?? null,
      creationMethod: "api",
      importSourceKey: importKey,
      externalOpportunityId: externalId.slice(0, 200),
    });
    if (lead) created += 1;
    else skipped += 1;
  }
  return { execution: outcome.execution, received: records.length, created, skipped };
}

/** Read new reviews and turn each into a follow-up task once. Never auto-replies. */
export async function scoutSyncReviews(input: {
  organizationId: string;
  actorUserId: string | null;
}): Promise<ScoutSyncSummary> {
  const binding = await getZapierBinding(input.organizationId, "scout.reviews.list");
  const stamp = new Date().toISOString().slice(0, 13);
  const outcome = await requestZapierAction({
    organizationId: input.organizationId,
    capability: "scout.reviews.list",
    input: {},
    idempotencyKey: `scout-reviews:${stamp}`,
    requestedByUserId: input.actorUserId,
  });
  const records = recordsOf(outcome.value);
  let created = 0;
  let skipped = 0;
  const sourceEventBase = `zapier.review:${binding?.zapierAppName ?? "unknown"}`;
  for (const record of records) {
    const externalId = externalIdOf(record, `${stamp}:${records.indexOf(record)}`);
    const sourceEvent = `${sourceEventBase}:${externalId}`.slice(0, 200);
    const [existing] = await db
      .select({ id: crmTasksTable.id })
      .from(crmTasksTable)
      .where(and(eq(crmTasksTable.organizationId, input.organizationId), eq(crmTasksTable.sourceEvent, sourceEvent)))
      .limit(1);
    if (existing) {
      skipped += 1;
      continue;
    }
    const rating = pick(record, ["rating", "star_rating", "starRating", "stars", "recommendation_type"]);
    const reviewer = pick(record, ["reviewer_name", "reviewer", "author", "name", "from_name"]) ?? "A customer";
    const comment = pick(record, ["comment", "text", "review_text", "message", "body"]);
    const task = await createTask(input.organizationId, {
      title: `Respond to ${rating ? `${rating}-star ` : ""}review from ${reviewer}`.slice(0, 200),
      description: [comment ?? "", `Source: ${binding?.zapierAppName ?? "connected app"}`].filter(Boolean).join("\n\n"),
      sourceEvent,
      priority: rating && /^[12]/.test(rating) ? "high" : "normal",
      dueAt: new Date(Date.now() + 24 * 60 * 60_000),
    });
    if (task) created += 1;
    else skipped += 1;
  }
  return { execution: outcome.execution, received: records.length, created, skipped };
}

// ---------- CALLIE: phone-system calls -> callback tasks + approved text-back ----------

export const CALLIE_TEXTBACK_ENTITY = "crm_task";

function isMissedCall(record: InboundRecord): boolean {
  const answered = record.answered ?? record.Answered;
  if (typeof answered === "boolean") return !answered;
  const status = (pick(record, ["status", "disposition", "call_status"]) ?? "").toLowerCase();
  return /missed|no.?answer|voicemail|abandon/.test(status);
}

export async function callieSyncCalls(input: {
  organizationId: string;
  actorUserId: string | null;
}): Promise<ScoutSyncSummary & { textbacksRequested: number }> {
  const binding = await getZapierBinding(input.organizationId, "callie.calls.list");
  const stamp = new Date().toISOString().slice(0, 13);
  const outcome = await requestZapierAction({
    organizationId: input.organizationId,
    capability: "callie.calls.list",
    input: {},
    idempotencyKey: `callie-calls:${stamp}`,
    requestedByUserId: input.actorUserId,
  });
  const records = recordsOf(outcome.value);
  let created = 0;
  let skipped = 0;
  let textbacksRequested = 0;
  const base = `zapier.call:${binding?.zapierAppName ?? "unknown"}`;
  for (const record of records) {
    const externalId = externalIdOf(record, `${stamp}:${records.indexOf(record)}`);
    const sourceEvent = `${base}:${externalId}`.slice(0, 200);
    const [existing] = await db
      .select({ id: crmTasksTable.id })
      .from(crmTasksTable)
      .where(and(eq(crmTasksTable.organizationId, input.organizationId), eq(crmTasksTable.sourceEvent, sourceEvent)))
      .limit(1);
    if (existing) {
      skipped += 1;
      continue;
    }
    const caller = pick(record, ["customer_phone_number", "from", "from_number", "caller_number", "phone"]);
    const callerName = pick(record, ["customer_name", "caller_name", "name"]) ?? "Unknown caller";
    const missed = isMissedCall(record);
    const task = await createTask(input.organizationId, {
      title: `${missed ? "Return missed call" : "Call logged"}: ${callerName}${caller ? ` (${caller})` : ""}`.slice(0, 200),
      description: [`Source: ${binding?.zapierAppName ?? "connected phone system"}`, missed ? "No one answered." : "Answered call recorded for follow-up."].join("\n"),
      sourceEvent,
      priority: missed ? "high" : "normal",
      dueAt: new Date(Date.now() + (missed ? 2 : 24) * 60 * 60_000),
    });
    if (!task) {
      skipped += 1;
      continue;
    }
    created += 1;
    if (missed && caller && /^\+?[1-9]\d{6,14}$/.test(caller.replace(/[^\d+]/g, ""))) {
      await callieRequestTextBack({ organizationId: input.organizationId, taskId: task.id, actorUserId: input.actorUserId, toPhone: caller.replace(/[^\d+]/g, "") });
      textbacksRequested += 1;
    }
  }
  return { execution: outcome.execution, received: records.length, created, skipped, textbacksRequested };
}

export function textBackBody(organizationName: string): string {
  return `Hi, this is ${organizationName}. Sorry we missed your call. Reply here or let us know a good time to call you back.`;
}

export async function buildCallieTextBackInput(organizationId: string, taskId: string, toPhone?: string) {
  const [row] = await db
    .select({ task: crmTasksTable, organization: organizationsTable })
    .from(crmTasksTable)
    .innerJoin(organizationsTable, eq(organizationsTable.id, crmTasksTable.organizationId))
    .where(and(eq(crmTasksTable.organizationId, organizationId), eq(crmTasksTable.id, taskId)));
  if (!row) throw new ZapierExecutionError("Callback task not found.", "not_found");
  const phone = toPhone ?? row.task.title.match(/\((\+?\d{7,15})\)/)?.[1];
  if (!phone) throw new ZapierExecutionError("The callback task has no caller number.", "invalid_input");
  return {
    idempotencyKey: `callie-textback:${row.task.id}`,
    input: { toPhone: phone, body: textBackBody(row.organization.name) },
  };
}

export async function callieRequestTextBack(input: {
  organizationId: string;
  taskId: string;
  actorUserId: string | null;
  toPhone?: string;
}): Promise<ZapierActionOutcome> {
  const built = await buildCallieTextBackInput(input.organizationId, input.taskId, input.toPhone);
  return requestZapierAction({
    organizationId: input.organizationId,
    capability: "callie.sms.send",
    input: built.input,
    idempotencyKey: built.idempotencyKey,
    requestedByUserId: input.actorUserId,
    linkedEntityType: CALLIE_TEXTBACK_ENTITY,
    linkedEntityId: input.taskId,
  });
}

// ---------- SCHED: crew day sheets ----------

export const SCHED_DAY_SHEET_ENTITY = "user";

function dayBounds(dateIso: string, timezone: string): { start: Date; end: Date } {
  // Resolve local midnight for the organization's timezone without a tz library:
  // take the UTC offset in effect at noon of that date in the zone.
  const noonUtc = new Date(`${dateIso}T12:00:00Z`);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(noonUtc);
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  const localAsUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"));
  const offsetMs = localAsUtc - noonUtc.getTime();
  const start = new Date(Date.UTC(...(dateIso.split("-").map(Number) as [number, number, number])) - offsetMs);
  return { start, end: new Date(start.getTime() + 24 * 60 * 60_000) };
}

export async function buildCrewDaySheetInput(organizationId: string, userId: string, dateIso: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateIso)) throw new ZapierExecutionError("Date must be YYYY-MM-DD.", "invalid_input");
  const binding = await getZapierBinding(organizationId, "sched.sms.send");
  const phone = binding?.bindingConfig[`crew_phone_${userId}`];
  if (typeof phone !== "string" || !phone) {
    throw new ZapierExecutionError("No crew phone number is saved for this team member in the SCHED binding.", "invalid_input");
  }
  const [organization] = await db.select().from(organizationsTable).where(eq(organizationsTable.id, organizationId));
  if (!organization) throw new ZapierExecutionError("Organization not found.", "not_found");
  const { start, end } = dayBounds(dateIso, organization.timezone);
  const rows = await db
    .select({ appointment: appointmentsTable, contact: contactsTable, property: propertiesTable })
    .from(appointmentsTable)
    .leftJoin(contactsTable, eq(contactsTable.id, appointmentsTable.contactId))
    .leftJoin(propertiesTable, eq(propertiesTable.id, appointmentsTable.propertyId))
    .where(
      and(
        eq(appointmentsTable.organizationId, organizationId),
        eq(appointmentsTable.assignedUserId, userId),
        inArray(appointmentsTable.status, ["scheduled", "confirmed"]),
        gte(appointmentsTable.scheduledStart, start),
        lt(appointmentsTable.scheduledStart, end),
      ),
    )
    .orderBy(appointmentsTable.scheduledStart);
  const time = new Intl.DateTimeFormat("en-US", { timeZone: organization.timezone, hour: "numeric", minute: "2-digit" });
  const lines = rows.map(({ appointment, contact, property }) => {
    const when = time.format(appointment.scheduledStart);
    const who = fullName(contact?.firstName, contact?.lastName);
    const where = addressLine(property) ?? "address on file";
    return `${when} ${appointment.type.replace(/_/g, " ")} - ${who}, ${where}`;
  });
  const body = (
    lines.length === 0
      ? `${organization.name} day sheet for ${dateIso}: no jobs scheduled.`
      : `${organization.name} day sheet for ${dateIso}:\n${lines.join("\n")}`
  ).slice(0, 1200);
  const signature = sha256Hex(rows.map(({ appointment }) => `${appointment.id}:${appointment.updatedAt.getTime()}`).join("|")).slice(0, 16);
  return {
    idempotencyKey: `sched-daysheet:${userId}:${dateIso}:${signature}`,
    input: { toPhone: phone, body },
    jobs: rows.length,
  };
}

export async function schedSendCrewDaySheet(input: {
  organizationId: string;
  userId: string;
  date: string;
  actorUserId: string | null;
}): Promise<ZapierActionOutcome & { jobs: number }> {
  const built = await buildCrewDaySheetInput(input.organizationId, input.userId, input.date);
  const outcome = await requestZapierAction({
    organizationId: input.organizationId,
    capability: "sched.sms.send",
    input: built.input,
    idempotencyKey: built.idempotencyKey,
    requestedByUserId: input.actorUserId,
    linkedEntityType: SCHED_DAY_SHEET_ENTITY,
    linkedEntityId: null,
  });
  return { ...outcome, jobs: built.jobs };
}

// ---------- approval re-derivation ----------

/**
 * Re-derive the typed input for a pending write from its linked record so an
 * approval executes exactly what was requested, or is blocked as stale when
 * the record changed. The ledger never stores the payload itself.
 */
export async function rebuildZapierRequestInput(execution: ZapierActionExecution): Promise<unknown> {
  switch (execution.capability) {
    case "appt.calendar.create_event": {
      if (!execution.linkedEntityId) throw new ZapierExecutionError("Missing linked appointment.", "invalid_input");
      return (await buildAppointmentCalendarInput(execution.organizationId, execution.linkedEntityId)).input;
    }
    case "invo.accounting.create_invoice": {
      if (!execution.linkedEntityId) throw new ZapierExecutionError("Missing linked invoice.", "invalid_input");
      return (await buildInvoiceAccountingInput(execution.organizationId, execution.linkedEntityId)).input;
    }
    case "callie.sms.send": {
      if (!execution.linkedEntityId) throw new ZapierExecutionError("Missing linked callback task.", "invalid_input");
      return (await buildCallieTextBackInput(execution.organizationId, execution.linkedEntityId)).input;
    }
    case "sched.sms.send": {
      const match = execution.idempotencyKey.match(/^sched-daysheet:([^:]+):(\d{4}-\d{2}-\d{2}):/);
      if (!match) throw new ZapierExecutionError("Day sheet request is not rebuildable.", "invalid_input");
      return (await buildCrewDaySheetInput(execution.organizationId, match[1]!, match[2]!)).input;
    }
    default:
      throw new ZapierExecutionError("This capability has no approval path.", "invalid_input");
  }
}

/** Most recent ledger activity for a record, for UI badges. */
export async function latestZapierExecutionFor(organizationId: string, entityType: string, entityId: string) {
  const [row] = await db
    .select()
    .from(zapierActionExecutionsTable)
    .where(
      and(
        eq(zapierActionExecutionsTable.organizationId, organizationId),
        eq(zapierActionExecutionsTable.linkedEntityType, entityType),
        eq(zapierActionExecutionsTable.linkedEntityId, entityId),
      ),
    )
    .orderBy(desc(zapierActionExecutionsTable.createdAt))
    .limit(1);
  return row ?? null;
}
