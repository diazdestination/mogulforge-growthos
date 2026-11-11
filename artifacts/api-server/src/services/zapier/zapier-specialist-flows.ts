import {
  twilioDispatchesTable,
  activitiesTable,
  revenueExecutionsTable,
  scheduledActionsTable,
  appointmentsTable,
  contactsTable,
  crmTasksTable,
  customerWorkRootsTable,
  db,
  invoicePaymentLinksTable,
  invoicesTable,
  leadsTable,
  organizationsTable,
  propertiesTable,
  serviceObligationsTable,
  auditEventsTable,
  usersTable,
  zapierActionExecutionsTable,
  type InvoiceDocument,
  type UserRole,
  type ZapierActionExecution,
} from "@workspace/db";
import { and, desc, eq, inArray, ne, or, sql } from "drizzle-orm";
import { companyDayBounds } from "@workspace/scheduling-core";

import { hasPermission } from "../../lib/permissions";
import { renderAppointmentReminderCopy } from "../appointment-reminder-copy";
import { InvoiceError } from "../invoice-contract";
import { createContact, createLead, createTask } from "../crm";
import { hasServiceMailboxReplyHold } from "../mailbox-communication";
import { getRoutePlan, RoutePlanError } from "../route-plan";
import { checkSendEligibility } from "../send-gate";
import { serviceCareMessage } from "../service-care-policy";
import { serviceNoticeAt } from "../service-obligations";
import { hasServiceSmsReplyHold } from "../service-sms";
import { readStandingService, standingLineage, standingCompanyProjection } from "../service-standing-policy";
import { phoneE164, twilioForOrganization } from "../twilio-controls";
import { getZapierCapability } from "./zapier-capabilities";
import { defaultPolicyFor, getZapierBinding, getZapierPolicy } from "./zapier-connection";
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

export async function buildCrewDaySheetInput(organizationId: string, userId: string, dateIso: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateIso)) throw new ZapierExecutionError("Date must be YYYY-MM-DD.", "invalid_input");
  const binding = await getZapierBinding(organizationId, "sched.sms.send");
  const phone = binding?.bindingConfig[`crew_phone_${userId}`];
  if (typeof phone !== "string" || !phone) {
    throw new ZapierExecutionError("No crew phone number is saved for this team member in the SCHED binding.", "invalid_input");
  }
  const [organization] = await db.select().from(organizationsTable).where(eq(organizationsTable.id, organizationId));
  if (!organization) throw new ZapierExecutionError("Organization not found.", "not_found");
  // Route-plan reads use scheduling-core's real company-day boundaries, verify
  // crew ownership and mask malformed historical customer/property links. This
  // read includes booked jobs and appointments and never dispatches geocoding.
  const plan = await getRoutePlan(organizationId, userId, { date: dateIso, userId }).catch((error: unknown) => {
    if (error instanceof RoutePlanError) throw new ZapierExecutionError(error.message, error.code === "not_found" ? "not_found" : "invalid_input");
    throw error;
  });
  const time = new Intl.DateTimeFormat("en-US", { timeZone: plan.timeZone, hour: "numeric", minute: "2-digit" });
  const lines = plan.stops.map((stop) => {
    const when = stop.continuesFromPreviousDay ? "Continuing" : time.format(new Date(stop.scheduledStart));
    const type = stop.kind === "project" ? "job" : stop.type.replace(/_/g, " ");
    return `${when} ${type} - ${stop.customerName}, ${stop.address ?? "address unavailable"}`;
  });
  const body =
    lines.length === 0
      ? `${organization.name} day sheet for ${dateIso}: no jobs scheduled.`
      : `${organization.name} day sheet for ${dateIso} (${plan.timeZone}):\n${lines.join("\n")}`;
  if (body.length > 1200) {
    throw new ZapierExecutionError("The complete day sheet is too long for one text. Open the route plan to review every stop and share the complete schedule through another approved channel.", "invalid_input");
  }
  // Use the complete semantic message and destination, so changing a customer's
  // name/address or crew phone cannot reuse a prior message's request identity.
  const signature = sha256Hex(JSON.stringify({ toPhone: phone, body })).slice(0, 32);
  return {
    idempotencyKey: `sched-daysheet:${userId}:${dateIso}:${signature}`,
    input: { toPhone: phone, body },
    jobs: plan.stops.length,
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

// ---------- customer texts from the contractor's own number ----------

export const OPT_OUT_LINE = "Reply STOP to opt out.";

/** Every customer text sent through a contractor's own number carries an opt-out line. */
export function withOptOut(body: string): string {
  return body.trimEnd().endsWith(OPT_OUT_LINE) ? body.trimEnd() : `${body.trimEnd()} ${OPT_OUT_LINE}`;
}

export type CustomerSmsCapability = "appt.sms.send" | "maintain.sms.send";

/**
 * True when automated customer texts for this capability should go through
 * the contractor's own number: built-in texting is not active for the company,
 * and the capability is bound and not switched off. Built-in texting, when
 * active, always wins so a customer never gets the same reminder twice.
 */
export async function zapierCustomerSmsRoute(organizationId: string, capability: CustomerSmsCapability): Promise<boolean> {
  if ((await twilioForOrganization(organizationId))?.smsEnabled) return false;
  const binding = await getZapierBinding(organizationId, capability);
  if (!binding) return false;
  const definition = getZapierCapability(capability)!;
  const policy = (await getZapierPolicy(organizationId, capability)) ?? defaultPolicyFor(definition);
  return policy.mode !== "off" && policy.dailyBudget > 0;
}

const OPEN_LEDGER_STATES = ["pending_approval", "executing", "succeeded", "indeterminate", "failed"] as const;

export async function otherOpenText(organizationId: string, capability: CustomerSmsCapability, entityType: string, entityId: string, idempotencyKey = "", reader: Pick<typeof db, "select"> = db) {
  const [appointment] = capability === "appt.sms.send" ? await reader.select({ start: appointmentsTable.scheduledStart }).from(appointmentsTable).where(and(eq(appointmentsTable.organizationId, organizationId), eq(appointmentsTable.id, entityId))) : [];
  const currentAppointmentKey = appointment ? `appt-reminder-text:${entityId}:${appointment.start.toISOString()}` : null;
  const [row] = await reader
    .select({ id: zapierActionExecutionsTable.id, state: zapierActionExecutionsTable.state })
    .from(zapierActionExecutionsTable)
    .where(
      and(
        eq(zapierActionExecutionsTable.organizationId, organizationId),
        eq(zapierActionExecutionsTable.capability, capability),
        eq(zapierActionExecutionsTable.linkedEntityType, entityType),
        eq(zapierActionExecutionsTable.linkedEntityId, entityId),
        inArray(zapierActionExecutionsTable.state, [...OPEN_LEDGER_STATES]),
        ne(zapierActionExecutionsTable.idempotencyKey, idempotencyKey),
        currentAppointmentKey ? or(ne(zapierActionExecutionsTable.state, "succeeded"), eq(zapierActionExecutionsTable.idempotencyKey, currentAppointmentKey)) : undefined,
      ),
    )
    .limit(1);
  return row ?? null;
}

function textBlocked(reason: string): never {
  const readable: Record<string, string> = {
    no_sms_consent: "this customer has not agreed to receive texts",
    do_not_contact: "this customer is marked do not contact",
    do_not_contact_sms: "this customer is marked do not text",
    no_phone: "this customer has no phone number",
    invalid_phone: "this customer's phone number is not valid",
    customer_lifecycle_paused: "customer messaging is paused for this company",
  };
  const why = readable[reason] ?? (reason.startsWith("suppressed:") ? "this number opted out or is suppressed" : reason.replace(/_/g, " "));
  throw new ZapierExecutionError(`No text was requested: ${why}.`, "invalid_input");
}

// APPT: appointment reminder text

export const APPT_REMINDER_TEXT_ENTITY = "appointment_reminder";
const APPT_REMINDER_KEY = /^appt-reminder-text:([0-9a-f-]{36}):(\d{4}-\d{2}-\d{2}T[\d:.]+Z)$/;

export async function buildAppointmentReminderTextInput(organizationId: string, appointmentId: string, expectedStart?: string) {
  const [row] = await db
    .select({ appointment: appointmentsTable, contact: contactsTable, lead: leadsTable })
    .from(appointmentsTable)
    .leftJoin(leadsTable, and(eq(leadsTable.id, appointmentsTable.leadId), eq(leadsTable.organizationId, organizationId)))
    .leftJoin(
      contactsTable,
      and(eq(contactsTable.organizationId, organizationId), eq(contactsTable.id, appointmentsTable.contactId)),
    )
    .where(and(eq(appointmentsTable.organizationId, organizationId), eq(appointmentsTable.id, appointmentId)));
  if (!row) throw new ZapierExecutionError("Appointment not found.", "not_found");
  const { appointment } = row;
  if (!["scheduled", "confirmed"].includes(appointment.status)) {
    throw new ZapierExecutionError("Only a booked appointment can get a reminder text.", "invalid_input");
  }
  if (expectedStart && appointment.scheduledStart.toISOString() !== expectedStart) {
    throw new ZapierExecutionError("The appointment was rescheduled after this text was requested. Request a new reminder.", "invalid_input");
  }
  if (appointment.scheduledStart.getTime() <= Date.now()) {
    throw new ZapierExecutionError("This appointment has already started.", "invalid_input");
  }
  const contact = await appointmentTextCustomer(db, organizationId, appointment);
  const gate = await checkSendEligibility({ organizationId, leadId: appointment.leadId, contact, channel: "sms", kind: "transactional" });
  if (!gate.ok) textBlocked(gate.reason);
  const toPhone = phoneE164(contact.phone ?? "");
  if (!toPhone) textBlocked("invalid_phone");
  const copy = await renderAppointmentReminderCopy(organizationId, appointment, contact.firstName);
  const body = withOptOut(copy.smsBody);
  if (body.length > 1200) throw new ZapierExecutionError("The reminder text is too long. Shorten it in Settings.", "invalid_input");
  return {
    idempotencyKey: `appt-reminder-text:${appointment.id}:${appointment.scheduledStart.toISOString()}`,
    input: { toPhone, body },
    contactId: contact.id,
    leadId: appointment.leadId,
  };
}

export async function apptRequestReminderText(input: {
  organizationId: string;
  appointmentId: string;
  actorUserId: string | null;
  expectedStart?: string;
  scheduledActionId?: string;
}): Promise<ZapierActionOutcome> {
  const built = await buildAppointmentReminderTextInput(input.organizationId, input.appointmentId, input.expectedStart);
  return requestZapierAction({
    organizationId: input.organizationId,
    capability: "appt.sms.send",
    appointmentReminderScheduledActionId: input.scheduledActionId,
    input: built.input,
    idempotencyKey: built.idempotencyKey,
    requestedByUserId: input.actorUserId,
    linkedEntityType: APPT_REMINDER_TEXT_ENTITY,
    linkedEntityId: input.appointmentId,
  });
}

// MAINTAIN: one service-due reminder text

export const MAINTAIN_REMINDER_TEXT_ENTITY = "service_obligation";
const MAINTAIN_REMINDER_KEY = /^maintain-reminder-text:([0-9a-f-]{36}):(\d+)$/;

export async function buildServiceReminderTextInput(organizationId: string, obligationId: string, expectedVersion?: number, touchLogicalKey?: string) {
  const [row] = await db
    .select({ obligation: serviceObligationsTable, contact: contactsTable })
    .from(serviceObligationsTable)
    .innerJoin(
      contactsTable,
      and(eq(contactsTable.organizationId, organizationId), eq(contactsTable.id, serviceObligationsTable.contactId)),
    )
    .where(and(eq(serviceObligationsTable.organizationId, organizationId), eq(serviceObligationsTable.id, obligationId)));
  if (!row) throw new ZapierExecutionError("Service not found.", "not_found");
  const { obligation, contact } = row;
  await assertServiceTextParents(db, organizationId, obligation);
  const version = obligation.updatedAt.getTime();
  if (expectedVersion !== undefined && version !== expectedVersion) {
    throw new ZapierExecutionError("The service changed after this text was requested. Review it and request a new reminder.", "invalid_input");
  }
  if (obligation.status !== "active") throw new ZapierExecutionError("Only an active service can get a reminder text.", "invalid_input");
  if (obligation.appointmentId) {
    const [visit] = await db
      .select({ status: appointmentsTable.status })
      .from(appointmentsTable)
      .where(and(eq(appointmentsTable.organizationId, organizationId), eq(appointmentsTable.id, obligation.appointmentId)));
    if (visit && ["scheduled", "confirmed"].includes(visit.status)) {
      throw new ZapierExecutionError("A visit is already booked for this service.", "invalid_input");
    }
  }
  const [prior] = await db
    .select({ action: auditEventsTable.action })
    .from(auditEventsTable)
    .where(
      and(
        eq(auditEventsTable.organizationId, organizationId),
        eq(auditEventsTable.entityType, "service_obligation"),
        eq(auditEventsTable.entityId, obligation.id),
        inArray(auditEventsTable.action, ["service.care_reminder_approved", "service.care_response_recorded"]),
      ),
    )
    .limit(1);
  if (prior) {
    throw new ZapierExecutionError(
      prior.action === "service.care_response_recorded"
        ? "A customer response is already recorded for this service. Follow up from the office instead."
        : "This service already has a reminder from GrowthOS. Review it instead of texting again.",
      "invalid_input",
    );
  }
  if ((await hasServiceMailboxReplyHold(organizationId, obligation.id)) || (await hasServiceSmsReplyHold(organizationId, obligation.id))) {
    throw new ZapierExecutionError("A customer reply to this service needs office review first.", "invalid_input");
  }
  const noticeAt = serviceNoticeAt(obligation.dueAt, obligation.noticeDays);
  if (noticeAt.getTime() > Date.now()) {
    throw new ZapierExecutionError(`This reminder can be sent from ${noticeAt.toISOString().slice(0, 10)}.`, "invalid_input");
  }
  if (!touchLogicalKey) {
    const [original] = await db.select({ id: zapierActionExecutionsTable.id }).from(zapierActionExecutionsTable).where(and(eq(zapierActionExecutionsTable.organizationId, organizationId), eq(zapierActionExecutionsTable.capability, "maintain.sms.send"), eq(zapierActionExecutionsTable.idempotencyKey, `maintain-reminder-text:${obligation.id}:${version}`))).limit(1);
    if (original) touchLogicalKey = `zapier:${original.id}`;
  }
  const company = await standingCompanyProjection(db, organizationId);
  // Service reminders use the stricter outreach gate (quiet hours, caps and
  // reply holds), matching the built-in MAINTAIN reminder.
  const gate = await checkSendEligibility({ organizationId, contact, channel: "sms", kind: "outreach", sendingHours: company.hours, touchLogicalKey });
  if (!gate.ok) {
    if (gate.outcome === "deferred") {
      throw new ZapierExecutionError(`Outside your sending hours. Try again after ${gate.resumeAt.toISOString()}.`, "invalid_input");
    }
    textBlocked(gate.reason);
  }
  const toPhone = phoneE164(contact.phone ?? "");
  if (!toPhone) textBlocked("invalid_phone");
  const message = serviceCareMessage({
    businessName: company.businessName,
    equipmentLabel: obligation.equipmentLabel,
    kind: obligation.kind,
    dueDate: obligation.dueAt.toISOString().slice(0, 10),
  });
  return {
    idempotencyKey: `maintain-reminder-text:${obligation.id}:${version}`,
    input: { toPhone, body: withOptOut(message.body) },
    contactId: contact.id,
  };
}

export async function maintainRequestServiceText(input: {
  organizationId: string;
  obligationId: string;
  actorUserId: string | null;
}): Promise<ZapierActionOutcome> {
  const built = await buildServiceReminderTextInput(input.organizationId, input.obligationId);
  const open = await otherOpenText(input.organizationId, "maintain.sms.send", MAINTAIN_REMINDER_TEXT_ENTITY, input.obligationId, built.idempotencyKey);
  if (open) {
    throw new ZapierExecutionError(
      open.state === "pending_approval"
        ? "A reminder text for this service is already waiting for approval."
        : "A reminder text was already sent or attempted for this service.",
      "conflict",
    );
  }
  return requestZapierAction({
    organizationId: input.organizationId,
    capability: "maintain.sms.send",
    input: built.input,
    idempotencyKey: built.idempotencyKey,
    requestedByUserId: input.actorUserId,
    linkedEntityType: MAINTAIN_REMINDER_TEXT_ENTITY,
    linkedEntityId: input.obligationId,
  });
}

// ---------- APPT: On My Way text from the tech in the field ----------

export const APPT_ON_MY_WAY_ENTITY = "appointment_on_my_way";
const APPT_ON_MY_WAY_KEY = /^appt-omw:([0-9a-f-]{36}):(\d{4}-\d{2}-\d{2})$/;

/** The company calendar date of an instant, in the company's own time zone. */
export function companyDateOf(now: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function onMyWayBody(input: { customerFirstName: string | null; techFirstName: string | null; businessName: string; etaMinutes?: number }): string {
  const greeting = input.customerFirstName?.trim() ? `Hi ${input.customerFirstName.trim()}, ` : "Hi, ";
  const tech = input.techFirstName?.trim() || "Your technician";
  const eta = input.etaMinutes ? `, about ${input.etaMinutes} minutes away` : "";
  return withOptOut(`${greeting}${tech} from ${input.businessName} is on the way${eta}.`);
}

/**
 * Build the On My Way text for a booked appointment happening today. The
 * technician named is the appointment's assignee, else the requester. One per
 * appointment per company day (the idempotency key).
 */
export async function buildOnMyWayTextInput(
  organizationId: string,
  appointmentId: string,
  options: { etaMinutes?: number | null; requestedByUserId: string | null; expectedDate?: string; now?: Date },
) {
  const etaMinutes = options.etaMinutes ?? undefined;
  if (etaMinutes !== undefined && (!Number.isInteger(etaMinutes) || etaMinutes < 1 || etaMinutes > 240)) {
    throw new ZapierExecutionError("Choose an ETA between 1 and 240 minutes.", "invalid_input");
  }
  const [row] = await db
    .select({ appointment: appointmentsTable, organization: organizationsTable })
    .from(appointmentsTable)
    .innerJoin(organizationsTable, eq(organizationsTable.id, appointmentsTable.organizationId))
    .where(and(eq(appointmentsTable.organizationId, organizationId), eq(appointmentsTable.id, appointmentId)));
  if (!row) throw new ZapierExecutionError("Appointment not found.", "not_found");
  const { appointment, organization } = row;
  if (!["scheduled", "confirmed"].includes(appointment.status)) {
    throw new ZapierExecutionError("Only a booked appointment can get an On My Way text.", "invalid_input");
  }
  const date = companyDateOf(options.now ?? new Date(), organization.timezone);
  if (options.expectedDate && options.expectedDate !== date) {
    throw new ZapierExecutionError("This On My Way text was requested on an earlier day. Request a new one.", "invalid_input");
  }
  const bounds = companyDayBounds(date, organization.timezone);
  const end = appointment.scheduledEnd ?? new Date(appointment.scheduledStart.getTime() + 2 * 60 * 60_000);
  if (appointment.scheduledStart.getTime() >= Date.parse(bounds.to) || end.getTime() <= Date.parse(bounds.from)) {
    throw new ZapierExecutionError("On My Way texts are only for today's appointments.", "invalid_input");
  }
  const contact = await appointmentTextCustomer(db, organizationId, appointment);
  const gate = await checkSendEligibility({ organizationId, leadId: appointment.leadId, contact, channel: "sms", kind: "transactional" });
  if (!gate.ok) textBlocked(gate.reason);
  const toPhone = phoneE164(contact.phone ?? "");
  if (!toPhone) textBlocked("invalid_phone");
  const techId = appointment.assignedUserId ?? options.requestedByUserId;
  const [tech] = techId
    ? await db.select({ firstName: usersTable.firstName }).from(usersTable).where(and(eq(usersTable.organizationId, organizationId), eq(usersTable.id, techId)))
    : [];
  const company = await standingCompanyProjection(db, organizationId);
  const body = onMyWayBody({ customerFirstName: contact.firstName, techFirstName: tech?.firstName ?? null, businessName: company.businessName, etaMinutes });
  if (body.length > 1200) throw new ZapierExecutionError("The On My Way text is too long.", "invalid_input");
  return {
    idempotencyKey: `appt-omw:${appointment.id}:${date}`,
    input: { toPhone, body, ...(etaMinutes ? { etaMinutes } : {}) },
    contactId: contact.id,
  };
}

export async function apptRequestOnMyWayText(input: {
  organizationId: string;
  appointmentId: string;
  actorUserId: string | null;
  etaMinutes?: number | null;
}): Promise<ZapierActionOutcome> {
  const built = await buildOnMyWayTextInput(input.organizationId, input.appointmentId, { etaMinutes: input.etaMinutes, requestedByUserId: input.actorUserId });
  const [earlier] = await db
    .select()
    .from(zapierActionExecutionsTable)
    .where(and(eq(zapierActionExecutionsTable.organizationId, input.organizationId), eq(zapierActionExecutionsTable.idempotencyKey, built.idempotencyKey)));
  if (earlier && earlier.state !== "blocked" && (earlier.requestSummary.etaMinutes ?? null) !== (built.input.etaMinutes ?? null)) {
    throw new ZapierExecutionError(
      earlier.state === "pending_approval"
        ? "An On My Way text for this appointment is already waiting for approval."
        : "An On My Way text was already sent or attempted for this appointment today.",
      "conflict",
    );
  }
  return requestZapierAction({
    organizationId: input.organizationId,
    capability: "appt.sms.on_my_way",
    input: built.input,
    idempotencyKey: built.idempotencyKey,
    requestedByUserId: input.actorUserId,
    linkedEntityType: APPT_ON_MY_WAY_ENTITY,
    linkedEntityId: input.appointmentId,
  });
}

// ---------- BILL: text the open pay link for an invoice's current balance ----------

export const BILL_PAY_LINK_TEXT_ENTITY = "invoice_payment_link";
const BILL_PAY_LINK_KEY = /^bill-paylink-text:([0-9a-f-]{36}):v(\d+):(\d+)$/;

const usd = (cents: number) => (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });

/** The open, unexpired sandbox Checkout link that collects exactly this invoice version's balance. */
function currentPayLink(links: (typeof invoicePaymentLinksTable.$inferSelect)[], version: number, balanceCents: number, now = new Date()) {
  return links.find((link) =>
    link.state === "open" && !!link.checkoutUrl && /^https:\/\//.test(link.checkoutUrl) && link.invoiceVersion === version &&
    link.amountCents === balanceCents && !!link.expiresAt && link.expiresAt > now) ?? null;
}

/**
 * Build the pay-link text from the invoice's current balance and its open pay
 * link. Reading the invoice re-checks the actor's invoice authority.
 */
export async function buildPayLinkTextInput(
  organizationId: string,
  invoiceId: string,
  actorUserId: string | null,
  expected?: { linkId: string; version: number; amountCents: number },
  /** Field collection: the invoice must be linked to the requester's own assigned job (this one, or any current one when re-checking). */
  field?: { appointmentId: string | null; effectiveRole?: UserRole },
) {
  if (!actorUserId) throw new ZapierExecutionError("A signed-in team member must request pay link texts.", "invalid_input");
  const { getInvoice } = await import("../invoices");
  const { readFieldInvoice, FieldCollectError } = await import("../field-collect");
  const read = field
    ? readFieldInvoice(db, organizationId, { userId: actorUserId, effectiveRole: field.effectiveRole }, invoiceId, field.appointmentId).then((result) => result.invoice)
    : getInvoice(organizationId, actorUserId, invoiceId);
  const invoice = await read.catch((error: unknown) => {
    if (error instanceof InvoiceError) {
      throw new ZapierExecutionError(error.status === 404 ? "Invoice not found." : error.message, error.status === 404 ? "not_found" : "invalid_input");
    }
    // A queued text whose requester no longer has this job is stale, not a new authorization question.
    if (error instanceof FieldCollectError && expected) throw new ZapierExecutionError(error.message, "invalid_input");
    throw error;
  });
  if (invoice.status !== "issued" || !invoice.invoiceNumber) {
    throw new ZapierExecutionError("Only an issued invoice can get a pay link text.", "invalid_input");
  }
  const balance = invoice.balanceDueCents;
  if (balance === null || balance < 50) throw new ZapierExecutionError("This invoice has no balance to collect.", "invalid_input");
  if (expected && (expected.version !== invoice.version || expected.amountCents !== balance)) {
    throw new ZapierExecutionError("The invoice or its balance changed after this text was requested. Request a new pay link text.", "invalid_input");
  }
  const links = await db
    .select()
    .from(invoicePaymentLinksTable)
    .where(and(eq(invoicePaymentLinksTable.organizationId, organizationId), eq(invoicePaymentLinksTable.invoiceId, invoiceId), eq(invoicePaymentLinksTable.state, "open")))
    .orderBy(desc(invoicePaymentLinksTable.createdAt));
  const link = currentPayLink(links, invoice.version, balance);
  if (!link) {
    throw new ZapierExecutionError(
      expected ? "The pay link is no longer open for this balance. Request a new pay link text." : "Create a pay link for the current balance first.",
      "invalid_input",
    );
  }
  if (expected && expected.linkId !== link.id) {
    throw new ZapierExecutionError("The pay link changed after this text was requested. Request a new pay link text.", "invalid_input");
  }
  const [contact] = await db.select().from(contactsTable).where(and(eq(contactsTable.organizationId, organizationId), eq(contactsTable.id, invoice.contactId)));
  if (!contact) throw new ZapierExecutionError("The invoice's customer is unavailable.", "invalid_input");
  const gate = await checkSendEligibility({ organizationId, leadId: invoice.leadId, contact, channel: "sms", kind: "transactional" });
  if (!gate.ok) textBlocked(gate.reason);
  const toPhone = phoneE164(contact.phone ?? "");
  if (!toPhone) textBlocked("invalid_phone");
  const company = await standingCompanyProjection(db, organizationId);
  const greeting = contact.firstName?.trim() ? `Hi ${contact.firstName.trim()}, ` : "Hi, ";
  const body = withOptOut(`${greeting}this is ${company.businessName}. Invoice ${invoice.invoiceNumber} has a balance of ${usd(balance)}. Pay securely here: ${link.checkoutUrl}`);
  if (body.length > 1200) throw new ZapierExecutionError("The pay link text is too long.", "invalid_input");
  return {
    idempotencyKey: `bill-paylink-text:${link.id}:v${invoice.version}:${balance}`,
    input: { toPhone, body },
    linkId: link.id,
    contactId: contact.id,
  };
}

export async function billRequestPayLinkText(input: {
  organizationId: string;
  invoiceId: string;
  actorUserId: string | null;
  /** Set when a tech texts from My day; the invoice must be linked to this job assigned to them. */
  field?: { appointmentId: string; effectiveRole?: UserRole };
}): Promise<ZapierActionOutcome> {
  const built = await buildPayLinkTextInput(input.organizationId, input.invoiceId, input.actorUserId, undefined, input.field);
  return requestZapierAction({
    organizationId: input.organizationId,
    capability: "bill.sms.payment_link",
    input: built.input,
    idempotencyKey: built.idempotencyKey,
    requestedByUserId: input.actorUserId,
    linkedEntityType: BILL_PAY_LINK_TEXT_ENTITY,
    linkedEntityId: built.linkId,
  });
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
    case "appt.sms.send": {
      const match = execution.idempotencyKey.match(APPT_REMINDER_KEY);
      if (!match || match[1] !== execution.linkedEntityId) throw new ZapierExecutionError("Reminder text request is not rebuildable.", "invalid_input");
      await assertAppointmentOwnNumberAvailable(db, execution.organizationId, match[1]!, typeof execution.requestSummary?.appointmentReminderScheduledActionId === "string" ? execution.requestSummary.appointmentReminderScheduledActionId : undefined);
      return (await buildAppointmentReminderTextInput(execution.organizationId, match[1]!, match[2]!)).input;
    }
    case "appt.sms.on_my_way": {
      const match = execution.idempotencyKey.match(APPT_ON_MY_WAY_KEY);
      if (!match || match[1] !== execution.linkedEntityId) throw new ZapierExecutionError("On My Way request is not rebuildable.", "invalid_input");
      const eta = execution.requestSummary?.etaMinutes;
      return (await buildOnMyWayTextInput(execution.organizationId, match[1]!, {
        etaMinutes: typeof eta === "number" ? eta : undefined,
        requestedByUserId: execution.requestedByUserId,
        expectedDate: match[2]!,
      })).input;
    }
    case "bill.sms.payment_link": {
      const match = execution.idempotencyKey.match(BILL_PAY_LINK_KEY);
      if (!match || match[1] !== execution.linkedEntityId) throw new ZapierExecutionError("Pay link text request is not rebuildable.", "invalid_input");
      const [link] = await db.select({ invoiceId: invoicePaymentLinksTable.invoiceId }).from(invoicePaymentLinksTable).where(and(eq(invoicePaymentLinksTable.organizationId, execution.organizationId), eq(invoicePaymentLinksTable.id, match[1]!)));
      if (!link) throw new ZapierExecutionError("The pay link is unavailable.", "invalid_input");
      // Re-read with the requester's authority: office invoice access, otherwise field collection on one of their current jobs.
      const requester = execution.requestedByUserId
        ? (await db.select({ role: usersTable.role }).from(usersTable).where(and(eq(usersTable.organizationId, execution.organizationId), eq(usersTable.id, execution.requestedByUserId))))[0]
        : undefined;
      const field = requester && !hasPermission(requester.role, "invoices.read") ? { appointmentId: null } : undefined;
      return (await buildPayLinkTextInput(execution.organizationId, link.invoiceId, execution.requestedByUserId, { linkId: match[1]!, version: Number(match[2]), amountCents: Number(match[3]) }, field)).input;
    }
    case "maintain.sms.send": {
      const match = execution.idempotencyKey.match(MAINTAIN_REMINDER_KEY);
      if (!match || match[1] !== execution.linkedEntityId) throw new ZapierExecutionError("Service text request is not rebuildable.", "invalid_input");
      return (await buildServiceReminderTextInput(execution.organizationId, match[1]!, Number(match[2]), `zapier:${execution.id}`)).input;
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

/** Shared original receipts, observed under lifecycle/schedule ownership locks. */
export async function assertAppointmentOwnNumberAvailable(reader: Pick<typeof db, "select">, org: string, appointmentId: string, scheduledActionId?: string) {
  const [appointment] = await reader.select().from(appointmentsTable).where(and(eq(appointmentsTable.organizationId, org), eq(appointmentsTable.id, appointmentId)));
  if (!appointment) throw new ZapierExecutionError("Appointment is unavailable.", "not_found");
  const start = appointment.scheduledStart.toISOString();
  if (scheduledActionId) {
    const [scheduled] = await reader.select().from(scheduledActionsTable).where(and(eq(scheduledActionsTable.organizationId, org), eq(scheduledActionsTable.id, scheduledActionId)));
    const [original] = await reader.select({ id: revenueExecutionsTable.id }).from(revenueExecutionsTable).where(and(eq(revenueExecutionsTable.organizationId, org), eq(revenueExecutionsTable.actionKey, `scheduled:${scheduledActionId}`), eq(revenueExecutionsTable.kind, "appointment_reminder")));
    if (!scheduled || !original || scheduled.action.type !== "appointment_reminder" || scheduled.context.event !== "appointment.reminder" || scheduled.context.appointmentId !== appointmentId ||
      (scheduled.context.fields as Record<string, unknown> | undefined)?.["appointment.scheduledStart"] !== start) throw new ZapierExecutionError("Original scheduled reminder context is unavailable.", "conflict");
  }
  if ((await twilioForOrganization(org, reader))?.smsEnabled) throw new ZapierExecutionError("Built-in appointment texting is active. Review its reminder instead.", "conflict");
  const accepted = await reader.select().from(activitiesTable).where(and(eq(activitiesTable.organizationId, org), eq(activitiesTable.type, "appointment_reminder_sent"), sql`${activitiesTable.metadata}->>'appointmentId' = ${appointmentId}`, sql`coalesce(${activitiesTable.metadata}->>'provider', '') <> 'zapier'`));
  const acceptedStarts = new Set(accepted.map(row => row.metadata?.scheduledStart).filter((value): value is string => typeof value === "string"));
  const reserved = await reader.select().from(auditEventsTable).where(and(eq(auditEventsTable.organizationId, org), eq(auditEventsTable.entityType, "appointment"), eq(auditEventsTable.entityId, appointmentId), eq(auditEventsTable.action, "appointment.reminder_builtin_reserved")));
  const receipts = await reader.select({ receipt: revenueExecutionsTable, scheduled: scheduledActionsTable }).from(revenueExecutionsTable).innerJoin(scheduledActionsTable, and(eq(scheduledActionsTable.organizationId, org), sql`${revenueExecutionsTable.actionKey} = 'scheduled:' || ${scheduledActionsTable.id}::text`)).where(and(eq(revenueExecutionsTable.organizationId, org), sql`${scheduledActionsTable.action}->>'type' = 'appointment_reminder'`, sql`${scheduledActionsTable.context}->>'appointmentId' = ${appointmentId}`, scheduledActionId ? ne(scheduledActionsTable.id, scheduledActionId) : undefined));
  const dispatches = await reader.select().from(twilioDispatchesTable).where(and(eq(twilioDispatchesTable.organizationId, org), sql`${twilioDispatchesTable.idempotencyKey} like ${`appointment:${appointmentId}:reminder:%`}`));
  // A new start is legitimate only after a successful earlier start. Pending,
  // unproven, or unknown ownership survives a reschedule and still needs review.
  const heldReservation = reserved.some(row => row.metadata.scheduledStart === start || typeof row.metadata.scheduledStart !== "string" || !acceptedStarts.has(row.metadata.scheduledStart));
  const heldReceipt = receipts.some(row => {
    const previousStart = (row.scheduled.context.fields as Record<string, unknown> | undefined)?.["appointment.scheduledStart"];
    return previousStart === start || typeof previousStart !== "string" || row.receipt.state !== "succeeded" || !acceptedStarts.has(previousStart);
  });
  const heldDispatch = dispatches.some(row => row.idempotencyKey === `appointment:${appointmentId}:reminder:${start}` || !["accepted", "queued", "sending", "sent", "delivered"].includes(row.status));
  if (heldReservation || acceptedStarts.has(start) || heldReceipt || heldDispatch) throw new ZapierExecutionError("This appointment already has built-in reminder ownership. Review the original receipt.", "conflict");
}

/** Caller holds the existing shared lock order before inserting its ledger row. */
export async function assertCustomerTextOwnership(reader: ReminderReader, input: { organizationId: string; capability: string; linkedEntityId?: string | null; idempotencyKey: string; appointmentReminderScheduledActionId?: string; expectedPhone: string }) {
  if (!input.linkedEntityId) throw new ZapierExecutionError("Missing customer reminder record.", "invalid_input");
  const org = input.organizationId, id = input.linkedEntityId;
  if (input.capability === "appt.sms.send") {
    await assertAppointmentOwnNumberAvailable(reader, org, id, input.appointmentReminderScheduledActionId);
    const [appointment] = await reader.select().from(appointmentsTable).where(and(eq(appointmentsTable.organizationId, org), eq(appointmentsTable.id, id)));
    if (!appointment || input.idempotencyKey !== `appt-reminder-text:${id}:${appointment.scheduledStart.toISOString()}` || !["scheduled", "confirmed"].includes(appointment.status) || appointment.scheduledStart.getTime() <= Date.now()) invalidReminderParents();
    const contact = await appointmentTextCustomer(reader, org, appointment);
    if (phoneE164(contact.phone ?? "") !== input.expectedPhone) throw new ZapierExecutionError("The customer number changed before dispatch.", "conflict");
    const gate = await checkSendEligibility({ organizationId: org, leadId: appointment.leadId, contact, channel: "sms", kind: "transactional" }, reader);
    if (!gate.ok) textBlocked(gate.reason);
    if (await otherOpenText(org, "appt.sms.send", APPT_REMINDER_TEXT_ENTITY, id, input.idempotencyKey, reader)) throw new ZapierExecutionError("An earlier text owns this appointment reminder.", "conflict");
  } else if (input.capability === "maintain.sms.send") {
    const [service] = await reader.select().from(serviceObligationsTable).where(and(eq(serviceObligationsTable.organizationId, org), eq(serviceObligationsTable.id, id)));
    if (!service || service.status !== "active" || input.idempotencyKey !== `maintain-reminder-text:${id}:${service.updatedAt.getTime()}`) invalidReminderParents();
    const { contact } = await assertServiceTextParents(reader, org, service);
    const [original] = await reader.select({ id: zapierActionExecutionsTable.id }).from(zapierActionExecutionsTable).where(and(eq(zapierActionExecutionsTable.organizationId, org), eq(zapierActionExecutionsTable.idempotencyKey, input.idempotencyKey)));
    const gate = await checkSendEligibility({ organizationId: org, contact, channel: "sms", kind: "outreach", sendingHours: (await standingCompanyProjection(reader, org)).hours, touchLogicalKey: original ? `zapier:${original.id}` : undefined }, reader);
    if (!gate.ok) textBlocked(gate.reason);
    if (await hasServiceMailboxReplyHold(org, id, reader) || await hasServiceSmsReplyHold(org, id, reader)) throw new ZapierExecutionError("A customer reply needs office review first.", "invalid_input");
    const [prior] = await reader.select({ id: auditEventsTable.id }).from(auditEventsTable).where(and(eq(auditEventsTable.organizationId, org), eq(auditEventsTable.entityType, "service_obligation"), eq(auditEventsTable.entityId, id), inArray(auditEventsTable.action, ["service.care_reminder_approved", "service.care_response_recorded"]))).limit(1);
    if (prior || await otherOpenText(org, "maintain.sms.send", MAINTAIN_REMINDER_TEXT_ENTITY, id, input.idempotencyKey, reader)) throw new ZapierExecutionError("An earlier reminder or office response owns this service.", "conflict");
  } else if (input.capability === "appt.sms.on_my_way") {
    const [row] = await reader.select({ appointment: appointmentsTable, timezone: organizationsTable.timezone }).from(appointmentsTable).innerJoin(organizationsTable, eq(organizationsTable.id, appointmentsTable.organizationId)).where(and(eq(appointmentsTable.organizationId, org), eq(appointmentsTable.id, id)));
    if (!row || !["scheduled", "confirmed"].includes(row.appointment.status) || input.idempotencyKey !== `appt-omw:${id}:${companyDateOf(new Date(), row.timezone)}`) invalidReminderParents();
    const contact = await appointmentTextCustomer(reader, org, row.appointment);
    if (phoneE164(contact.phone ?? "") !== input.expectedPhone) throw new ZapierExecutionError("The customer number changed before dispatch.", "conflict");
    const gate = await checkSendEligibility({ organizationId: org, leadId: row.appointment.leadId, contact, channel: "sms", kind: "transactional" }, reader);
    if (!gate.ok) textBlocked(gate.reason);
  } else if (input.capability === "bill.sms.payment_link") {
    const [link] = await reader.select().from(invoicePaymentLinksTable).where(and(eq(invoicePaymentLinksTable.organizationId, org), eq(invoicePaymentLinksTable.id, id)));
    const [invoice] = link ? await reader.select().from(invoicesTable).where(and(eq(invoicesTable.organizationId, org), eq(invoicesTable.id, link.invoiceId))) : [];
    if (!link || !invoice || invoice.status !== "issued" || invoice.version !== link.invoiceVersion || !currentPayLink([link], invoice.version, link.amountCents) ||
      input.idempotencyKey !== `bill-paylink-text:${id}:v${invoice.version}:${link.amountCents}`) throw new ZapierExecutionError("The pay link is no longer open for this invoice balance.", "conflict");
    const contactId = invoice.leadId
      ? (await reader.select({ contactId: leadsTable.contactId }).from(leadsTable).where(and(eq(leadsTable.organizationId, org), eq(leadsTable.id, invoice.leadId))))[0]?.contactId
      : invoice.customerWorkId
        ? (await reader.select({ contactId: customerWorkRootsTable.contactId }).from(customerWorkRootsTable).where(and(eq(customerWorkRootsTable.organizationId, org), eq(customerWorkRootsTable.id, invoice.customerWorkId))))[0]?.contactId
        : null;
    const [contact] = contactId ? await reader.select().from(contactsTable).where(and(eq(contactsTable.organizationId, org), eq(contactsTable.id, contactId))) : [];
    if (!contact) invalidReminderParents();
    if (phoneE164(contact.phone ?? "") !== input.expectedPhone) throw new ZapierExecutionError("The customer number changed before dispatch.", "conflict");
    const gate = await checkSendEligibility({ organizationId: org, leadId: invoice.leadId, contact, channel: "sms", kind: "transactional" }, reader);
    if (!gate.ok) textBlocked(gate.reason);
  }
}

/** Claim built-in dispatch before releasing locks; retained on every unknown outcome. */
export async function reserveBuiltInAppointmentReminder(org: string, appointmentId: string, expectedStart: string) {
  const { acquireNurtureLocks } = await import("../source-outreach-ownership");
  return db.transaction(async tx => {
    await acquireNurtureLocks(tx, org);
    if (await otherOpenText(org, "appt.sms.send", APPT_REMINDER_TEXT_ENTITY, appointmentId, "", tx)) throw new ZapierExecutionError("The connected phone app owns this appointment reminder. Review its original receipt.", "conflict");
    const [appointment] = await tx.select({ start: appointmentsTable.scheduledStart }).from(appointmentsTable).where(and(eq(appointmentsTable.organizationId, org), eq(appointmentsTable.id, appointmentId)));
    if (!appointment) throw new ZapierExecutionError("Appointment unavailable before built-in claim.", "not_found");
    const start = appointment.start.toISOString();
    if (start !== expectedStart) throw new ZapierExecutionError("Appointment changed before reminder claim.", "conflict");
    const existing = await tx.select().from(auditEventsTable).where(and(eq(auditEventsTable.organizationId, org), eq(auditEventsTable.entityType, "appointment"), eq(auditEventsTable.entityId, appointmentId), eq(auditEventsTable.action, "appointment.reminder_builtin_reserved")));
    const accepted = await tx.select().from(activitiesTable).where(and(eq(activitiesTable.organizationId, org), eq(activitiesTable.type, "appointment_reminder_sent"), sql`${activitiesTable.metadata}->>'appointmentId' = ${appointmentId}`, sql`coalesce(${activitiesTable.metadata}->>'provider', '') <> 'zapier'`));
    if (existing.some(row => row.metadata.scheduledStart === start || typeof row.metadata.scheduledStart !== "string" || !accepted.some(activity => activity.metadata?.scheduledStart === row.metadata.scheduledStart))) throw new ZapierExecutionError("The original built-in reminder owns this appointment. Do not replay.", "conflict");
    await tx.insert(auditEventsTable).values({ organizationId: org, action: "appointment.reminder_builtin_reserved", entityType: "appointment", entityId: appointmentId, metadata: { scheduledStart: start, customerMessageSent: false } });
  });
}

type ReminderReader = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];
function invalidReminderParents(): never { throw new ZapierExecutionError("The reminder's customer or work references are unavailable or inconsistent. Review the original record.", "invalid_input"); }
/** SELECT-only validation: optional parents stay optional; supplied parents never disappear silently. */
async function reminderContact(reader: ReminderReader, org: string, refs: { contactId?: string | null; leadId?: string | null; propertyId?: string | null }) {
  const [lead] = refs.leadId ? await reader.select().from(leadsTable).where(and(eq(leadsTable.organizationId, org), eq(leadsTable.id, refs.leadId))) : [];
  if (refs.leadId && (!lead || !lead.contactId || (refs.contactId && refs.contactId !== lead.contactId))) invalidReminderParents();
  const contactId = refs.contactId ?? lead?.contactId;
  if (!contactId) invalidReminderParents();
  const [contact] = await reader.select().from(contactsTable).where(and(eq(contactsTable.organizationId, org), eq(contactsTable.id, contactId)));
  if (!contact) invalidReminderParents();
  if (refs.propertyId && lead?.propertyId && refs.propertyId !== lead.propertyId) invalidReminderParents();
  for (const propertyId of new Set([refs.propertyId, lead?.propertyId].filter((id): id is string => !!id))) {
    const [property] = await reader.select().from(propertiesTable).where(and(eq(propertiesTable.organizationId, org), eq(propertiesTable.id, propertyId)));
    if (!property || property.contactId !== contact.id) invalidReminderParents();
  }
  return contact;
}
async function appointmentTextCustomer(reader: ReminderReader, org: string, appointment: typeof appointmentsTable.$inferSelect) {
  const contact = await reminderContact(reader, org, appointment);
  if (appointment.assignedUserId) {
    const [staff] = await reader.select({ id: usersTable.id }).from(usersTable).where(and(eq(usersTable.organizationId, org), eq(usersTable.id, appointment.assignedUserId)));
    if (!staff) invalidReminderParents();
  }
  return contact;
}
async function assertServiceTextParents(reader: ReminderReader, org: string, obligation: typeof serviceObligationsTable.$inferSelect) {
  const current = await readStandingService(reader, org, obligation.id);
  await reminderContact(reader, org, { contactId: obligation.contactId, propertyId: obligation.propertyId, leadId: current.task.leadId });
  if (current.task.assignedUserId) {
    const [staff] = await reader.select({ id: usersTable.id }).from(usersTable).where(and(eq(usersTable.organizationId, org), eq(usersTable.id, current.task.assignedUserId)));
    if (!staff) invalidReminderParents();
  }
  if (obligation.appointmentId) {
    const [visit] = await reader.select().from(appointmentsTable).where(and(eq(appointmentsTable.organizationId, org), eq(appointmentsTable.id, obligation.appointmentId)));
    if (!visit || (await appointmentTextCustomer(reader, org, visit)).id !== obligation.contactId || (obligation.propertyId && visit.propertyId !== obligation.propertyId)) invalidReminderParents();
    if (["scheduled", "confirmed"].includes(visit.status)) throw new ZapierExecutionError("A visit is already booked for this service.", "invalid_input");
  }
  for (const ancestor of await standingLineage(reader, org, obligation.id)) {
    if (ancestor.contactId !== obligation.contactId || ancestor.propertyId !== obligation.propertyId) invalidReminderParents();
  }
  return current;
}
