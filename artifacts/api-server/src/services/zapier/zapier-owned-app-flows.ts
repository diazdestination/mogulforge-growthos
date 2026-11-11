import {
  activitiesTable,
  appointmentsTable,
  auditEventsTable,
  consentRecordsTable,
  contactsTable,
  db,
  estimatesTable,
  invoiceReceiptAllocationsTable,
  invoicesTable,
  leadsTable,
  organizationsTable,
  playbookEnrollmentsTable,
  projectsTable,
  suppressionsTable,
  valueEntriesTable,
  zapierActionExecutionsTable,
  type ZapierActionExecution,
} from "@workspace/db";
import { and, desc, eq, gte, inArray, lte, ne, sql } from "drizzle-orm";

import { recordAudit } from "../audit";
import { createTask } from "../crm";
import { readNativeWorkLineage, nativeWorkLabels } from "../customer-work-lineage";
import { getOrCreateEngagementLink, engagementLinkUrl } from "../engagement-links";
import { assertEstimateInitialDraft, renderEstimateEmail } from "../estimate-delivery-contract";
import { assertEstimateCleanHistory, hasRetainedEstimateEmail, recordEstimateSavedState } from "../estimate-delivery-history";
import { getInvoiceDeliveryChain } from "../invoice-delivery-attempts";
import { renderInvoiceEmail } from "../invoice-delivery-contract";
import { hasContactReplyHold, hasCustomerReplyHold } from "../response-correlation";
import { checkSendEligibility, normalizePhone } from "../send-gate";
import { phoneE164 } from "../twilio-controls";
import { getZapierBinding, zapierPollWindow } from "./zapier-connection";
import { requestZapierAction, ZapierExecutionError, type ZapierActionOutcome } from "./zapier-executions";
import { sha256Hex } from "./zapier-mcp-client";
import { pick, recordsOf, textBlocked, withOptOut, type InboundRecord } from "./zapier-specialist-flows";

/**
 * Specialist flows that act in the contractor's own mailbox, phone number and
 * accounting app through Zapier, so GrowthOS can cover what a field-service
 * suite covers without MogulForge owning a Microsoft or Google app.
 *
 * Every write is built from GrowthOS records, goes through the execution
 * ledger (default policy: approve each), is re-derived on approval and again
 * just before dispatch, and is owned by a durable receipt. A ledger
 * `succeeded` is the app's acceptance, `failed` means the app refused or the
 * request was stopped before dispatch, and `indeterminate` is unknown and is
 * never retried automatically or followed by a second send.
 */

type Reader = Pick<typeof db, "select">;

/** States that mean the customer may already have it, or a human is deciding. */
const OWNING_STATES = ["pending_approval", "executing", "succeeded", "indeterminate"] as const;
/** Closed attempts that proved nothing reached the app; a new attempt may follow. */
const CLOSED_STATES = ["failed", "rejected"] as const;

export const INVO_EMAIL_ENTITY = "invoice_email";
export const ESTI_EMAIL_ENTITY = "estimate_email";
export const INVO_PAYMENT_ENTITY = "invoice_receipt_allocation";
export const SCOUT_REVIEW_ENTITIES = { appointment: "appointment_review_request", project: "project_review_request" } as const;
export type ReviewRequestKind = keyof typeof SCOUT_REVIEW_ENTITIES;

const INVO_EMAIL_KEY = /^invo-email:([0-9a-f-]{36}):([0-9a-f]{16}):a(\d+)$/;
const ESTI_EMAIL_KEY = /^esti-email:([0-9a-f-]{36}):(\d+):a(\d+)$/;
const INVO_PAYMENT_KEY = /^invo-payment:([0-9a-f-]{36}):a(\d+)$/;
const SCOUT_REVIEW_KEY = /^scout-review:(appointment|project):([0-9a-f-]{36})$/;

function invalid(message: string): never {
  throw new ZapierExecutionError(message, "invalid_input");
}

async function owningExecution(org: string, capability: string, entityType: string, entityId: string, reader: Reader = db, exceptKey = "") {
  const [row] = await reader
    .select({ id: zapierActionExecutionsTable.id, state: zapierActionExecutionsTable.state })
    .from(zapierActionExecutionsTable)
    .where(
      and(
        eq(zapierActionExecutionsTable.organizationId, org),
        eq(zapierActionExecutionsTable.capability, capability),
        eq(zapierActionExecutionsTable.linkedEntityType, entityType),
        eq(zapierActionExecutionsTable.linkedEntityId, entityId),
        inArray(zapierActionExecutionsTable.state, [...OWNING_STATES]),
        ne(zapierActionExecutionsTable.idempotencyKey, exceptKey),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** Attempt n+1 after n closed, provably-not-performed attempts; a blocked one is reopened in place. */
async function nextAttempt(org: string, capability: string, entityType: string, entityId: string) {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(zapierActionExecutionsTable)
    .where(
      and(
        eq(zapierActionExecutionsTable.organizationId, org),
        eq(zapierActionExecutionsTable.capability, capability),
        eq(zapierActionExecutionsTable.linkedEntityType, entityType),
        eq(zapierActionExecutionsTable.linkedEntityId, entityId),
        inArray(zapierActionExecutionsTable.state, [...CLOSED_STATES]),
      ),
    );
  return (row?.count ?? 0) + 1;
}

function refuseOwned(owner: { state: string } | null, what: string): void {
  if (!owner) return;
  throw new ZapierExecutionError(
    owner.state === "pending_approval"
      ? `${what} is already waiting for approval.`
      : owner.state === "indeterminate" || owner.state === "executing"
        ? `${what} has an uncertain or running request. Check your connected app before doing anything else.`
        : `${what} was already sent through your connected app.`,
    "conflict",
  );
}

async function emailEligibility(org: string, contact: typeof contactsTable.$inferSelect, leadId: string | null) {
  const gate = await checkSendEligibility({ organizationId: org, leadId, contact, channel: "email", kind: "transactional" });
  if (!gate.ok) {
    const reason = gate.reason === "customer_lifecycle_paused" ? "customer messaging is paused for this company" : gate.reason.replace(/_/g, " ");
    invalid(`No email was requested: ${reason}.`);
  }
  if ((await hasContactReplyHold(org, contact.id)) || (leadId && (await hasCustomerReplyHold(org, leadId)))) {
    invalid("This customer has a reply waiting for office review. No email was requested.");
  }
}

async function lineageFor(org: string, refs: { leadId: string | null; customerWorkId: string | null }) {
  try {
    return await readNativeWorkLineage(db, org, refs, false);
  } catch {
    return invalid("The customer for this record is unavailable or inconsistent. Review the record first.");
  }
}

// ---------- INVO: issued invoice email from the contractor's mailbox ----------

/**
 * Exactly the reviewed invoice email GrowthOS sends natively, addressed to the
 * invoice's customer. Refuses if GrowthOS's built-in delivery already owns an
 * attempt for the invoice, so the two paths never both reach the customer.
 */
export async function buildInvoiceMailboxEmailInput(organizationId: string, invoiceId: string, expectedDocument?: string) {
  const [invoice] = await db.select().from(invoicesTable).where(and(eq(invoicesTable.organizationId, organizationId), eq(invoicesTable.id, invoiceId)));
  if (!invoice) throw new ZapierExecutionError("Invoice not found.", "not_found");
  if (invoice.status !== "issued" || !invoice.issuedDocument || !invoice.invoiceNumber || !invoice.issuedAt || !invoice.issuedDocumentSha256) {
    invalid("Only an issued invoice can be emailed.");
  }
  const documentKey = invoice.issuedDocumentSha256.slice(0, 16);
  if (expectedDocument && expectedDocument !== documentKey) invalid("The issued invoice changed after this email was requested. Request a new email.");
  const chain = await getInvoiceDeliveryChain(organizationId, invoiceId);
  if (chain.integrity !== "valid" || chain.attempts.some((attempt) => attempt.proof !== "not_dispatched")) {
    throw new ZapierExecutionError("GrowthOS email delivery already has an attempt for this invoice. Review it in the invoice's delivery panel.", "conflict");
  }
  const lineage = await lineageFor(organizationId, invoice);
  const to = lineage.contact.email?.trim().toLowerCase();
  if (!to) invalid("This customer has no email address.");
  await emailEligibility(organizationId, lineage.contact, invoice.leadId);
  const message = renderInvoiceEmail({ invoiceNumber: invoice.invoiceNumber, issuedAt: invoice.issuedAt.toISOString(), document: invoice.issuedDocument });
  return {
    documentKey,
    input: { to, subject: message.subject, body: message.body },
    contactId: lineage.contact.id,
    leadId: invoice.leadId,
  };
}

export async function invoRequestMailboxInvoiceEmail(input: { organizationId: string; invoiceId: string; actorUserId: string | null }): Promise<ZapierActionOutcome> {
  refuseOwned(await owningExecution(input.organizationId, "invo.email.send", INVO_EMAIL_ENTITY, input.invoiceId), "An email for this invoice");
  const built = await buildInvoiceMailboxEmailInput(input.organizationId, input.invoiceId);
  const attempt = await nextAttempt(input.organizationId, "invo.email.send", INVO_EMAIL_ENTITY, input.invoiceId);
  return requestZapierAction({
    organizationId: input.organizationId,
    capability: "invo.email.send",
    input: built.input,
    idempotencyKey: `invo-email:${input.invoiceId}:${built.documentKey}:a${attempt}`,
    requestedByUserId: input.actorUserId,
    linkedEntityType: INVO_EMAIL_ENTITY,
    linkedEntityId: input.invoiceId,
  });
}

/** True while a Zapier mailbox email owns this invoice; built-in delivery must not also send. */
export async function zapierInvoiceEmailOwner(organizationId: string, invoiceId: string, reader: Reader = db) {
  return owningExecution(organizationId, "invo.email.send", INVO_EMAIL_ENTITY, invoiceId, reader);
}

// ---------- ESTI: draft estimate email from the contractor's mailbox ----------

export async function buildEstimateMailboxEmailInput(organizationId: string, estimateId: string, expectedVersion?: number) {
  const [estimate] = await db.select().from(estimatesTable).where(and(eq(estimatesTable.organizationId, organizationId), eq(estimatesTable.id, estimateId)));
  if (!estimate) throw new ZapierExecutionError("Estimate not found.", "not_found");
  const version = estimate.updatedAt.getTime();
  if (expectedVersion !== undefined && expectedVersion !== version) invalid("The estimate changed after this email was requested. Request a new email.");
  try {
    assertEstimateInitialDraft(estimate);
    await assertEstimateCleanHistory(db, organizationId, estimate);
  } catch {
    invalid("Only an unsent draft estimate with intact saved history can be emailed.");
  }
  if (await hasRetainedEstimateEmail(db, organizationId, estimate.id)) {
    throw new ZapierExecutionError("GrowthOS email delivery already owns this estimate. Review it on the estimate.", "conflict");
  }
  const lineage = await lineageFor(organizationId, estimate);
  const to = lineage.contact.email?.trim().toLowerCase();
  if (!to) invalid("This customer has no email address.");
  await emailEligibility(organizationId, lineage.contact, estimate.leadId);
  const [company] = await db.select({ name: organizationsTable.name }).from(organizationsTable).where(eq(organizationsTable.id, organizationId));
  if (!company) throw new ZapierExecutionError("Organization not found.", "not_found");
  const labels = nativeWorkLabels(lineage);
  let message: ReturnType<typeof renderEstimateEmail>;
  try {
    message = renderEstimateEmail(
      {
        estimateId: estimate.id,
        businessName: company.name,
        customerLabel: labels.customerLabel,
        propertyLabel: labels.propertyLabel,
        title: estimate.title,
        lineItems: estimate.lineItems,
        subtotalCents: estimate.subtotalCents,
        taxCents: estimate.taxCents,
        totalCents: estimate.totalCents,
        notes: estimate.notes,
      },
      to,
    );
  } catch {
    return invalid("The saved estimate or recipient is invalid.");
  }
  return { version, input: { to, subject: message.subject, body: message.body }, contactId: lineage.contact.id, leadId: estimate.leadId };
}

export async function estiRequestMailboxEstimateEmail(input: { organizationId: string; estimateId: string; actorUserId: string | null }): Promise<ZapierActionOutcome> {
  refuseOwned(await owningExecution(input.organizationId, "esti.email.send", ESTI_EMAIL_ENTITY, input.estimateId), "An email for this estimate");
  const built = await buildEstimateMailboxEmailInput(input.organizationId, input.estimateId);
  const attempt = await nextAttempt(input.organizationId, "esti.email.send", ESTI_EMAIL_ENTITY, input.estimateId);
  return requestZapierAction({
    organizationId: input.organizationId,
    capability: "esti.email.send",
    input: built.input,
    idempotencyKey: `esti-email:${input.estimateId}:${built.version}:a${attempt}`,
    requestedByUserId: input.actorUserId,
    linkedEntityType: ESTI_EMAIL_ENTITY,
    linkedEntityId: input.estimateId,
  });
}

export async function zapierEstimateEmailOwner(organizationId: string, estimateId: string, reader: Reader = db) {
  return owningExecution(organizationId, "esti.email.send", ESTI_EMAIL_ENTITY, estimateId, reader);
}

// ---------- SCOUT: review request text after finished work ----------

const REVIEW_REPEAT_WINDOW_MS = 90 * 24 * 60 * 60_000;

async function reviewRequestCustomer(org: string, kind: ReviewRequestKind, id: string) {
  if (kind === "appointment") {
    const [appointment] = await db.select().from(appointmentsTable).where(and(eq(appointmentsTable.organizationId, org), eq(appointmentsTable.id, id)));
    if (!appointment) throw new ZapierExecutionError("Appointment not found.", "not_found");
    if (appointment.status !== "completed") invalid("Ask for a review only after the appointment is marked completed.");
    const [lead] = appointment.leadId ? await db.select().from(leadsTable).where(and(eq(leadsTable.organizationId, org), eq(leadsTable.id, appointment.leadId))) : [];
    if (appointment.leadId && !lead) invalid("The appointment's opportunity is unavailable.");
    const contactId = appointment.contactId ?? lead?.contactId;
    if (!contactId || (lead && appointment.contactId && lead.contactId !== appointment.contactId)) invalid("The appointment's customer is unavailable or inconsistent.");
    const [contact] = await db.select().from(contactsTable).where(and(eq(contactsTable.organizationId, org), eq(contactsTable.id, contactId)));
    if (!contact) invalid("The appointment's customer is unavailable.");
    return { contact, leadId: appointment.leadId };
  }
  const [project] = await db.select().from(projectsTable).where(and(eq(projectsTable.organizationId, org), eq(projectsTable.id, id)));
  if (!project) throw new ZapierExecutionError("Job not found.", "not_found");
  if (project.status !== "completed") invalid("Ask for a review only after the job is marked completed.");
  const lineage = await lineageFor(org, project);
  return { contact: lineage.contact, leadId: project.leadId };
}

export function reviewRequestBody(businessName: string, firstName: string | null | undefined, url: string): string {
  const greeting = firstName?.trim() ? `Hi ${firstName.trim()},` : "Hi,";
  return withOptOut(`${greeting} thank you for choosing ${businessName}. If you have a minute, a quick review would mean a lot: ${url}`);
}

export async function buildReviewRequestTextInput(organizationId: string, kind: ReviewRequestKind, id: string) {
  const { contact, leadId } = await reviewRequestCustomer(organizationId, kind, id);
  // A review request is marketing-style contact: the outreach gate adds reply
  // holds, imported-source review, quiet hours and the shared daily cap.
  const gate = await checkSendEligibility({ organizationId, leadId, contact, channel: "sms", kind: "outreach" });
  if (!gate.ok) {
    if (gate.outcome === "deferred") invalid(`Outside your sending hours. Try again after ${gate.resumeAt.toISOString()}.`);
    textBlocked(gate.reason);
  }
  const toPhone = phoneE164(contact.phone ?? "");
  if (!toPhone) textBlocked("invalid_phone");
  const [company] = await db.select({ name: organizationsTable.name }).from(organizationsTable).where(eq(organizationsTable.id, organizationId));
  if (!company) throw new ZapierExecutionError("Organization not found.", "not_found");
  const link = await getOrCreateEngagementLink(organizationId, contact.id, "review", leadId);
  if (link.organizationId !== organizationId) invalid("The review link is unavailable for this customer.");
  return {
    idempotencyKey: `scout-review:${kind}:${id}`,
    input: { toPhone, body: reviewRequestBody(company.name, contact.firstName, engagementLinkUrl(link)) },
    contactId: contact.id,
    leadId,
  };
}

export async function scoutRequestReviewText(input: { organizationId: string; kind: ReviewRequestKind; id: string; actorUserId: string | null }): Promise<ZapierActionOutcome> {
  const entityType = SCOUT_REVIEW_ENTITIES[input.kind];
  const built = await buildReviewRequestTextInput(input.organizationId, input.kind, input.id);
  // Once per job, and never a second review text to the same number inside 90 days.
  const [recent] = await db
    .select({ id: zapierActionExecutionsTable.id, state: zapierActionExecutionsTable.state })
    .from(zapierActionExecutionsTable)
    .where(
      and(
        eq(zapierActionExecutionsTable.organizationId, input.organizationId),
        eq(zapierActionExecutionsTable.capability, "scout.sms.review_request"),
        inArray(zapierActionExecutionsTable.state, [...OWNING_STATES]),
        ne(zapierActionExecutionsTable.idempotencyKey, built.idempotencyKey),
        gte(zapierActionExecutionsTable.createdAt, new Date(Date.now() - REVIEW_REPEAT_WINDOW_MS)),
        sql`${zapierActionExecutionsTable.requestSummary}->>'toPhone' = ${built.input.toPhone}`,
      ),
    )
    .limit(1);
  refuseOwned(recent ?? null, "A review request for this customer");
  return requestZapierAction({
    organizationId: input.organizationId,
    capability: "scout.sms.review_request",
    input: built.input,
    idempotencyKey: built.idempotencyKey,
    requestedByUserId: input.actorUserId,
    linkedEntityType: entityType,
    linkedEntityId: input.id,
  });
}

// ---------- INVO: recorded receipt -> accounting payment ----------

export async function buildInvoicePaymentAccountingInput(organizationId: string, allocationId: string) {
  const [row] = await db
    .select({ allocation: invoiceReceiptAllocationsTable, value: valueEntriesTable, invoice: invoicesTable })
    .from(invoiceReceiptAllocationsTable)
    .innerJoin(valueEntriesTable, and(eq(valueEntriesTable.organizationId, organizationId), eq(valueEntriesTable.id, invoiceReceiptAllocationsTable.valueEntryId)))
    .innerJoin(invoicesTable, and(eq(invoicesTable.organizationId, organizationId), eq(invoicesTable.id, invoiceReceiptAllocationsTable.invoiceId)))
    .where(and(eq(invoiceReceiptAllocationsTable.organizationId, organizationId), eq(invoiceReceiptAllocationsTable.id, allocationId)));
  if (!row) throw new ZapierExecutionError("Receipt not found.", "not_found");
  const { allocation, value, invoice } = row;
  if (allocation.kind !== "payment") invalid("Only a recorded customer payment can be sent to accounting.");
  const [reversal] = await db
    .select({ id: invoiceReceiptAllocationsTable.id })
    .from(invoiceReceiptAllocationsTable)
    .where(and(eq(invoiceReceiptAllocationsTable.organizationId, organizationId), eq(invoiceReceiptAllocationsTable.reversesAllocationId, allocation.id)))
    .limit(1);
  if (reversal) invalid("This receipt was reversed in GrowthOS. Nothing was sent to accounting.");
  const [pushed] = await db
    .select({ summary: zapierActionExecutionsTable.requestSummary, app: zapierActionExecutionsTable.zapierApp })
    .from(zapierActionExecutionsTable)
    .where(
      and(
        eq(zapierActionExecutionsTable.organizationId, organizationId),
        eq(zapierActionExecutionsTable.capability, "invo.accounting.create_invoice"),
        eq(zapierActionExecutionsTable.linkedEntityId, invoice.id),
        eq(zapierActionExecutionsTable.state, "succeeded"),
      ),
    )
    .orderBy(desc(zapierActionExecutionsTable.completedAt))
    .limit(1);
  const invoiceNumber = typeof pushed?.summary.invoiceNumber === "string" ? pushed.summary.invoiceNumber : null;
  if (!pushed || !invoiceNumber) {
    invalid("This invoice was never exported to your accounting app. Export the invoice first, then record its payment.");
  }
  const binding = await getZapierBinding(organizationId, "invo.accounting.record_payment");
  if (binding && binding.zapierApp !== pushed.app) {
    invalid("The invoice was exported to a different accounting app than the one set for payments. Review both flows first.");
  }
  const customerName = invoice.issuedDocument?.customerName ?? invoice.draftDocument.customerName;
  return {
    input: {
      invoiceNumber,
      customerName,
      amountCents: allocation.amountCents,
      paidOn: value.occurredAt.toISOString().slice(0, 10),
      reference: value.sourceReference.slice(0, 120),
    },
    invoiceId: invoice.id,
  };
}

export async function invoRequestAccountingPayment(input: { organizationId: string; invoiceId?: string; allocationId: string; actorUserId: string | null }): Promise<ZapierActionOutcome> {
  refuseOwned(await owningExecution(input.organizationId, "invo.accounting.record_payment", INVO_PAYMENT_ENTITY, input.allocationId), "This receipt's accounting payment");
  const built = await buildInvoicePaymentAccountingInput(input.organizationId, input.allocationId);
  if (input.invoiceId && built.invoiceId !== input.invoiceId) throw new ZapierExecutionError("Receipt not found on this invoice.", "not_found");
  const attempt = await nextAttempt(input.organizationId, "invo.accounting.record_payment", INVO_PAYMENT_ENTITY, input.allocationId);
  return requestZapierAction({
    organizationId: input.organizationId,
    capability: "invo.accounting.record_payment",
    input: built.input,
    idempotencyKey: `invo-payment:${input.allocationId}:a${attempt}`,
    requestedByUserId: input.actorUserId,
    linkedEntityType: INVO_PAYMENT_ENTITY,
    linkedEntityId: input.allocationId,
  });
}

// ---------- SCOUT: inbound customer email -> activity on the customer record ----------

export type InboxSyncSummary = {
  execution: ZapierActionExecution;
  received: number;
  created: number;
  skipped: number;
  ignored: number;
  pausedEnrollments: number;
};

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** A customer reply pauses that lead's active follow-up so staff decide what comes next. */
async function pauseLeadFollowUp(tx: Tx, organizationId: string, leadId: string, at: Date, reason: string, detail: string): Promise<number> {
  const rows = await tx
    .update(playbookEnrollmentsTable)
    .set({
      status: "paused",
      nextRunAt: null,
      pauseReason: reason,
      history: sql`${playbookEnrollmentsTable.history} || ${JSON.stringify([{ at: new Date().toISOString(), kind: "paused", detail }])}::jsonb`,
    })
    .where(
      and(
        eq(playbookEnrollmentsTable.organizationId, organizationId),
        eq(playbookEnrollmentsTable.leadId, leadId),
        eq(playbookEnrollmentsTable.status, "active"),
        lte(playbookEnrollmentsTable.createdAt, at),
      ),
    )
    .returning({ id: playbookEnrollmentsTable.id });
  return rows.length;
}

function senderAddress(record: InboundRecord): string | null {
  const raw = pick(record, ["from_email", "fromEmail", "from__email", "sender_email", "from", "sender", "from_address"]);
  const match = raw?.match(/[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
  return match ? match[0].toLowerCase() : null;
}

function receivedAt(record: InboundRecord): Date {
  const raw = pick(record, ["date", "received_at", "receivedDateTime", "received_date_time", "internal_date", "sent_at"]);
  const parsed = raw ? new Date(/^\d{10,13}$/.test(raw) ? Number(raw.length === 10 ? Number(raw) * 1000 : raw) : raw) : null;
  if (!parsed || !Number.isFinite(parsed.getTime()) || parsed.getTime() > Date.now() + 60_000) return new Date();
  return parsed;
}

/**
 * Log email from known customers on their record. The sender address is the
 * only matching key (no subject or content matching); an unknown or ambiguous
 * sender is ignored rather than turned into work, and email content is stored
 * as bounded, untrusted text that nothing in GrowthOS executes.
 *
 * A reply pauses the customer's active follow-up sequences, as reply evidence
 * does for built-in mailboxes, and creates one review task. Zapier search
 * results carry no signed parent-message evidence, so this does not create
 * the verified reply hold that built-in mailbox correlation uses.
 */
export async function scoutSyncInboxReplies(input: { organizationId: string; actorUserId: string | null }): Promise<InboxSyncSummary> {
  const binding = await getZapierBinding(input.organizationId, "scout.inbox.list");
  const stamp = await zapierPollWindow(input.organizationId);
  const outcome = await requestZapierAction({
    organizationId: input.organizationId,
    capability: "scout.inbox.list",
    input: {},
    idempotencyKey: `scout-inbox:${stamp}`,
    requestedByUserId: input.actorUserId,
  });
  const records = recordsOf(outcome.value);
  const appName = binding?.zapierAppName ?? "connected mailbox";
  const summary = { received: records.length, created: 0, skipped: 0, ignored: 0, pausedEnrollments: 0 };
  for (const record of records) {
    const from = senderAddress(record);
    if (!from) { summary.ignored += 1; continue; }
    const subject = pick(record, ["subject", "Subject"])?.slice(0, 200) ?? "(no subject)";
    const at = receivedAt(record);
    const messageId = pick(record, ["message_id", "messageId", "internet_message_id", "internetMessageId", "id", "thread_id"])
      ?? sha256Hex(JSON.stringify([from, subject, at.toISOString()])).slice(0, 32);
    const messageKey = `${appName}:${messageId}`.slice(0, 300);
    const [seen] = await db
      .select({ id: activitiesTable.id })
      .from(activitiesTable)
      .where(and(eq(activitiesTable.organizationId, input.organizationId), eq(activitiesTable.type, "customer_email_received"), sql`${activitiesTable.metadata}->>'messageKey' = ${messageKey}`))
      .limit(1);
    if (seen) { summary.skipped += 1; continue; }
    const contacts = await db
      .select()
      .from(contactsTable)
      .where(and(eq(contactsTable.organizationId, input.organizationId), sql`lower(trim(${contactsTable.email})) = ${from}`))
      .limit(2);
    if (contacts.length !== 1) { summary.ignored += 1; continue; }
    const contact = contacts[0]!;
    const [lead] = await db
      .select({ id: leadsTable.id })
      .from(leadsTable)
      .where(and(eq(leadsTable.organizationId, input.organizationId), eq(leadsTable.contactId, contact.id)))
      .orderBy(desc(leadsTable.createdAt))
      .limit(1);
    const snippet = pick(record, ["body_plain", "snippet", "body_preview", "bodyPreview", "body", "text"]);
    const name = [contact.firstName, contact.lastName].filter(Boolean).join(" ").trim() || from;
    const paused = await db.transaction(async (tx) => {
      const [activity] = await tx
        .insert(activitiesTable)
        .values({
          organizationId: input.organizationId,
          leadId: lead?.id ?? null,
          contactId: contact.id,
          type: "customer_email_received",
          title: `Email from ${name}: ${subject}`.slice(0, 250),
          body: snippet ?? null,
          occurredAt: at,
          metadata: { source: `zapier:${appName}`, messageKey, provenance: "connected_mailbox_search", contentTrusted: false, sender: from },
        })
        .returning({ id: activitiesTable.id });
      if (!activity || !lead) return 0;
      return pauseLeadFollowUp(tx, input.organizationId, lead.id, at, "Customer emailed; staff review required before more outreach", `Customer email logged ${activity.id}`);
    });
    summary.pausedEnrollments += paused;
    await createTask(input.organizationId, {
      title: `Reply to ${name}'s email`.slice(0, 200),
      description: `Logged from ${appName}. Review the message in your mailbox before more follow-up; GrowthOS did not act on its content.`,
      sourceEvent: `zapier.email:${messageKey}`.slice(0, 200),
      contactId: contact.id,
      leadId: lead?.id ?? null,
      priority: "high",
      dueAt: new Date(Date.now() + 24 * 60 * 60_000),
    });
    summary.created += 1;
  }
  return { execution: outcome.execution, ...summary };
}

// ---------- CALLIE: text replies and opt-outs on the contractor's own number ----------

/** The same keywords the built-in Twilio inbound webhook treats as opt-out / opt-in. */
const SMS_STOP_WORDS = new Set(["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT", "REVOKE", "OPTOUT"]);
const SMS_START_WORDS = new Set(["START", "UNSTOP"]);
export const SMS_REPLY_ACTIVITY = "customer_sms_received";
export const SMS_OPT_OUT_ACTIVITY = "sms_opt_out_received";
export const SMS_OPT_IN_ACTIVITY = "sms_opt_in_received";
const SMS_INBOUND_TYPES = [SMS_REPLY_ACTIVITY, SMS_OPT_OUT_ACTIVITY, SMS_OPT_IN_ACTIVITY];

export type SmsInboxSyncSummary = InboxSyncSummary & { optedOut: number; optedIn: number };

export function smsKeyword(body: string, optOutType?: string): "STOP" | "START" | null {
  const word = body.trim().toUpperCase();
  const type = optOutType?.trim().toUpperCase();
  if (type === "STOP" || SMS_STOP_WORDS.has(word)) return "STOP";
  if (type === "START" || SMS_START_WORDS.has(word)) return "START";
  return null;
}

function smsReceivedAt(record: InboundRecord): Date {
  const raw = pick(record, ["created_at", "createdAt", "date_sent", "dateSent", "date_created", "dateCreated", "received_at", "date"]);
  const parsed = raw ? new Date(raw) : null;
  if (!parsed || !Number.isFinite(parsed.getTime()) || parsed.getTime() > Date.now() + 60_000) return new Date();
  return parsed;
}

/**
 * Read texts received on the contractor's own number (Quo or Twilio).
 *
 * - The sender phone is the only matching key. A reply from a phone that
 *   matches exactly one customer is logged with provenance and a follow-up
 *   task; replies from unknown or shared numbers are ignored.
 * - STOP-style keywords follow the built-in Twilio webhook's consent path for
 *   any sender: the phone is suppressed for texts, and every matching contact
 *   is marked do not text with a revoked SMS consent record. A late STOP is
 *   always applied, because applying it can only prevent contact.
 * - START/UNSTOP lifts only a STOP suppression recorded before that message,
 *   exactly like the webhook. It re-grants no consent and does not clear
 *   do not text: fresh consent must be recorded before texts resume.
 * - Messages are deduped by app and provider message id; content is stored as
 *   bounded, untrusted text and is never acted on beyond the keyword check.
 */
export async function callieSyncSmsReplies(input: { organizationId: string; actorUserId: string | null }): Promise<SmsInboxSyncSummary> {
  const org = input.organizationId;
  const binding = await getZapierBinding(org, "callie.sms.inbox.list");
  const stamp = await zapierPollWindow(org);
  const outcome = await requestZapierAction({
    organizationId: org,
    capability: "callie.sms.inbox.list",
    input: {},
    idempotencyKey: `callie-sms-inbox:${stamp}`,
    requestedByUserId: input.actorUserId,
  });
  const appName = binding?.zapierAppName ?? "connected phone";
  const source = `zapier:${appName}`;
  const records = recordsOf(outcome.value)
    .map((record) => ({ record, at: smsReceivedAt(record) }))
    .sort((a, b) => a.at.getTime() - b.at.getTime());
  const summary = { received: records.length, created: 0, skipped: 0, ignored: 0, pausedEnrollments: 0, optedOut: 0, optedIn: 0 };
  for (const { record, at } of records) {
    const direction = pick(record, ["direction", "Direction"])?.toLowerCase();
    if (direction && /out/.test(direction)) { summary.ignored += 1; continue; }
    const phone = phoneE164(pick(record, ["from", "From", "from_number", "fromNumber", "sender", "participant", "phone_number"]) ?? "");
    if (!phone) { summary.ignored += 1; continue; }
    const rawBody = record.body ?? record.Body ?? record.text ?? record.content ?? record.message;
    const body = typeof rawBody === "string" ? rawBody.trim().slice(0, 1600) : "";
    const messageId = pick(record, ["id", "message_id", "messageId", "sid", "message_sid", "MessageSid"])
      ?? sha256Hex(JSON.stringify([phone, body, at.toISOString()])).slice(0, 32);
    const messageKey = `${appName}:${messageId}`.slice(0, 300);
    const keyword = smsKeyword(body, pick(record, ["OptOutType", "opt_out_type", "optOutType"]));
    const result = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`zapier-sms-inbound:${org}:${phone}`}))`);
      const [seen] = await tx
        .select({ id: activitiesTable.id })
        .from(activitiesTable)
        .where(and(eq(activitiesTable.organizationId, org), inArray(activitiesTable.type, SMS_INBOUND_TYPES), sql`${activitiesTable.metadata}->>'messageKey' = ${messageKey}`))
        .limit(1);
      if (seen) return "skipped" as const;
      const contacts = await tx
        .select()
        .from(contactsTable)
        .where(and(eq(contactsTable.organizationId, org), sql`regexp_replace(coalesce(${contactsTable.phone}, ''), '[^0-9]', '', 'g') IN (${phone.slice(1)}, ${phone.slice(2)})`));
      const meta = { source, messageKey, provenance: "connected_phone_read", contentTrusted: false, phone };
      if (keyword === "STOP") {
        await tx.insert(suppressionsTable)
          .values({ organizationId: org, channel: "sms", value: normalizePhone(phone), reason: "stop_keyword", source })
          .onConflictDoNothing();
        for (const contact of contacts) {
          await tx.update(contactsTable).set({ doNotContactSms: true }).where(and(eq(contactsTable.organizationId, org), eq(contactsTable.id, contact.id)));
          await tx.insert(consentRecordsTable).values({ organizationId: org, contactId: contact.id, channel: "sms", granted: false, disclosureVersion: "zapier:inbound-stop" });
        }
      } else if (keyword === "START") {
        // Only a STOP suppression recorded before this START is lifted.
        await tx.delete(suppressionsTable).where(and(
          eq(suppressionsTable.organizationId, org),
          eq(suppressionsTable.channel, "sms"),
          eq(suppressionsTable.value, normalizePhone(phone)),
          eq(suppressionsTable.reason, "stop_keyword"),
          lte(suppressionsTable.createdAt, at),
        ));
      } else if (contacts.length !== 1) {
        return "ignored" as const;
      }
      const type = keyword === "STOP" ? SMS_OPT_OUT_ACTIVITY : keyword === "START" ? SMS_OPT_IN_ACTIVITY : SMS_REPLY_ACTIVITY;
      const title = keyword === "STOP" ? "Customer texted STOP to your number; texts stopped"
        : keyword === "START" ? "Customer texted START to your number; record fresh consent before texting"
        : "Text reply to your number";
      const targets = contacts.length ? contacts : [null];
      let leadId: string | null = null;
      for (const contact of targets) {
        const [lead] = contact
          ? await tx.select({ id: leadsTable.id }).from(leadsTable)
            .where(and(eq(leadsTable.organizationId, org), eq(leadsTable.contactId, contact.id)))
            .orderBy(desc(leadsTable.createdAt)).limit(1)
          : [];
        if (contacts.length === 1) leadId = lead?.id ?? null;
        await tx.insert(activitiesTable).values({
          organizationId: org,
          leadId: lead?.id ?? null,
          contactId: contact?.id ?? null,
          type,
          title,
          body: keyword ? null : body || null,
          occurredAt: at,
          metadata: { ...meta, ...(keyword ? { keyword } : {}) },
        });
      }
      if (keyword) {
        await tx.insert(auditEventsTable).values({
          organizationId: org,
          actorUserId: input.actorUserId,
          action: keyword === "STOP" ? "consent.sms_opt_out_received" : "consent.sms_opt_in_received",
          entityType: "contact",
          entityId: contacts.length === 1 ? contacts[0]!.id : null,
          metadata: { source, messageKey, matchedContacts: contacts.length },
        });
        return keyword;
      }
      const contact = contacts[0]!;
      const paused = leadId ? await pauseLeadFollowUp(tx, org, leadId, at, "Customer texted; staff review required before more outreach", `Customer text logged ${messageKey}`) : 0;
      return { contact, leadId, paused };
    });
    if (result === "skipped") summary.skipped += 1;
    else if (result === "ignored") summary.ignored += 1;
    else if (result === "STOP") summary.optedOut += 1;
    else if (result === "START") summary.optedIn += 1;
    else {
      summary.created += 1;
      summary.pausedEnrollments += result.paused;
      const name = [result.contact.firstName, result.contact.lastName].filter(Boolean).join(" ").trim() || "customer";
      await createTask(org, {
        title: `Reply to ${name}'s text`.slice(0, 200),
        description: `Logged from ${appName}. Read and answer the text in your phone app; GrowthOS did not act on its content.`,
        sourceEvent: `zapier.sms:${messageKey}`.slice(0, 200),
        contactId: result.contact.id,
        leadId: result.leadId,
        priority: "high",
        dueAt: new Date(Date.now() + 24 * 60 * 60_000),
      });
    }
  }
  return { execution: outcome.execution, ...summary };
}

// ---------- approval re-derivation and settlement ----------

/** Re-derive a pending write from current GrowthOS records; any change makes it stale. */
export async function rebuildOwnedAppRequestInput(execution: ZapierActionExecution): Promise<unknown> {
  const key = execution.idempotencyKey;
  switch (execution.capability) {
    case "invo.email.send": {
      const match = key.match(INVO_EMAIL_KEY);
      if (!match || match[1] !== execution.linkedEntityId) invalid("Invoice email request is not rebuildable.");
      if (await owningExecution(execution.organizationId, execution.capability, INVO_EMAIL_ENTITY, match[1]!, db, key)) throw new ZapierExecutionError("Another email owns this invoice.", "conflict");
      return (await buildInvoiceMailboxEmailInput(execution.organizationId, match[1]!, match[2]!)).input;
    }
    case "esti.email.send": {
      const match = key.match(ESTI_EMAIL_KEY);
      if (!match || match[1] !== execution.linkedEntityId) invalid("Estimate email request is not rebuildable.");
      if (await owningExecution(execution.organizationId, execution.capability, ESTI_EMAIL_ENTITY, match[1]!, db, key)) throw new ZapierExecutionError("Another email owns this estimate.", "conflict");
      return (await buildEstimateMailboxEmailInput(execution.organizationId, match[1]!, Number(match[2]))).input;
    }
    case "scout.sms.review_request": {
      const match = key.match(SCOUT_REVIEW_KEY);
      const kind = match?.[1] as ReviewRequestKind | undefined;
      if (!match || !kind || match[2] !== execution.linkedEntityId || execution.linkedEntityType !== SCOUT_REVIEW_ENTITIES[kind]) invalid("Review request is not rebuildable.");
      return (await buildReviewRequestTextInput(execution.organizationId, kind, match[2]!)).input;
    }
    case "invo.accounting.record_payment": {
      const match = key.match(INVO_PAYMENT_KEY);
      if (!match || match[1] !== execution.linkedEntityId) invalid("Payment request is not rebuildable.");
      if (await owningExecution(execution.organizationId, execution.capability, INVO_PAYMENT_ENTITY, match[1]!, db, key)) throw new ZapierExecutionError("Another request owns this receipt.", "conflict");
      return (await buildInvoicePaymentAccountingInput(execution.organizationId, match[1]!)).input;
    }
    default:
      throw new ZapierExecutionError("This capability has no approval path.", "invalid_input");
  }
}

/**
 * Record the outcome on the GrowthOS record once the ledger settles. Only an
 * app-accepted write is recorded as sent; failed and uncertain outcomes stay
 * in the ledger, where uncertainty blocks any further request for the record.
 */
export async function settleOwnedAppExecution(execution: ZapierActionExecution): Promise<void> {
  if (execution.state !== "succeeded" || execution.direction !== "write" || !execution.linkedEntityId) return;
  const org = execution.organizationId;
  const meta = { provider: "zapier", zapierExecutionId: execution.id, app: execution.zapierApp, deliveryConfirmed: false };
  if (execution.capability === "invo.email.send") {
    const [invoice] = await db.select().from(invoicesTable).where(and(eq(invoicesTable.organizationId, org), eq(invoicesTable.id, execution.linkedEntityId)));
    if (!invoice) return;
    const lineage = await readNativeWorkLineage(db, org, invoice, false).catch(() => null);
    await db.insert(activitiesTable).values({
      organizationId: org,
      leadId: invoice.leadId,
      contactId: lineage?.contact.id ?? null,
      actorUserId: execution.approvedByUserId ?? execution.requestedByUserId,
      type: "invoice_email_accepted_zapier",
      title: `Invoice ${invoice.invoiceNumber ?? ""} emailed from your mailbox`.replace(/\s+/g, " ").trim(),
      body: "Your connected mailbox accepted this email through Zapier. Inbox delivery is not confirmed.",
      metadata: { ...meta, invoiceId: invoice.id, invoiceNumber: invoice.invoiceNumber },
    });
  } else if (execution.capability === "esti.email.send") {
    const match = execution.idempotencyKey.match(ESTI_EMAIL_KEY);
    await db.transaction(async (tx) => {
      const [current] = await tx.select().from(estimatesTable).where(and(eq(estimatesTable.organizationId, org), eq(estimatesTable.id, execution.linkedEntityId!))).for("update");
      if (!current) return;
      const lineage = await readNativeWorkLineage(tx, org, current, false).catch(() => null);
      await tx.insert(activitiesTable).values({
        organizationId: org,
        leadId: current.leadId,
        contactId: lineage?.contact.id ?? null,
        actorUserId: execution.approvedByUserId ?? execution.requestedByUserId,
        type: "estimate_email_accepted_zapier",
        title: `Estimate emailed from your mailbox: ${current.title}`.slice(0, 250),
        body: "Your connected mailbox accepted this email through Zapier. Inbox delivery and customer acceptance are not confirmed.",
        metadata: { ...meta, estimateId: current.id },
      });
      // Mark sent only if this is still the exact draft that was emailed.
      if (!match || current.status !== "draft" || current.sentAt || current.acceptedAt || String(current.updatedAt.getTime()) !== match[2]) return;
      const [updated] = await tx
        .update(estimatesTable)
        .set({ status: "sent", sentAt: execution.completedAt ?? new Date(), updatedAt: new Date(), ...(current.workVersion !== null ? { workVersion: current.workVersion + 1 } : {}) })
        .where(and(eq(estimatesTable.organizationId, org), eq(estimatesTable.id, current.id)))
        .returning();
      await recordEstimateSavedState(tx, org, updated!, execution.approvedByUserId ?? execution.requestedByUserId ?? null, null, { previousEstimate: current });
    });
  } else if (execution.capability === "scout.sms.review_request") {
    const kind = execution.linkedEntityType === SCOUT_REVIEW_ENTITIES.project ? "project" : "appointment";
    const { contact, leadId } = await reviewRequestCustomer(org, kind, execution.linkedEntityId).catch(() => ({ contact: null, leadId: null }));
    await db.insert(activitiesTable).values({
      organizationId: org,
      leadId,
      contactId: contact?.id ?? null,
      actorUserId: execution.approvedByUserId ?? execution.requestedByUserId,
      type: "review_request_texted",
      title: "Review request texted from your number",
      body: "Your phone app accepted this text through Zapier. Delivery and any review are not confirmed.",
      metadata: { ...meta, [`${kind}Id`]: execution.linkedEntityId },
    });
  } else if (execution.capability === "invo.accounting.record_payment") {
    await recordAudit({
      organizationId: org,
      actorUserId: execution.approvedByUserId ?? execution.requestedByUserId,
      action: "invoice.accounting_payment_recorded",
      entityType: "invoice_receipt_allocation",
      entityId: execution.linkedEntityId,
      metadata: { zapierExecutionId: execution.id, app: execution.zapierApp, invoiceNumber: execution.requestSummary.invoiceNumber ?? null },
    });
  }
}
