import { randomUUID } from "node:crypto";
import {
  auditEventsTable,
  contactsTable,
  db,
  leadsTable,
  organizationsTable,
  usersTable,
} from "@workspace/db";
import { createInvoice, issueInvoice } from "../services/invoices";
import { deliveryFingerprint } from "../services/invoice-delivery-contract";
import {
  getInvoiceDeliveryChain,
  INVOICE_REVIEW_ACTION,
  type InvoiceAttemptReview,
  type InvoiceAttemptReviewMetadata,
  type InvoiceAttemptOutcome,
} from "../services/invoice-delivery-attempts";

/** Provider-free canonical test fixture; caller chooses only the isolated test runner. */
export async function invoiceAttemptFixture() {
  const [org] = await db
    .insert(organizationsTable)
    .values({
      name: "Synthetic invoice recovery",
      slug: `invoice-attempt-${randomUUID()}`,
    })
    .returning();
  const [actor] = await db
    .insert(usersTable)
    .values({
      organizationId: org.id,
      role: "owner",
      emailVerifiedAt: new Date(),
    })
    .returning();
  const [contact] = await db
    .insert(contactsTable)
    .values({
      organizationId: org.id,
      firstName: "Synthetic customer",
      email: "customer@example.invalid",
    })
    .returning();
  const [lead] = await db
    .insert(leadsTable)
    .values({
      organizationId: org.id,
      contactId: contact.id,
      assignedUserId: actor.id,
    })
    .returning();
  const draft = (
    await createInvoice(org.id, actor.id, {
      requestId: randomUUID(),
      leadId: lead.id,
      document: {
        title: "Synthetic repair",
        currency: "USD",
        issuerName: "Synthetic contractor",
        customerName: "Synthetic customer",
        lineItems: [
          { description: "Agreed work", quantity: "1", unitPriceCents: 10000 },
        ],
        taxCents: 0,
      },
    })
  ).invoice;
  const invoice = (
    await issueInvoice(org.id, actor.id, draft.id, {
      requestId: randomUUID(),
      expectedVersion: draft.version,
      confirmed: true,
    })
  ).invoice;
  return {
    org: org.id,
    actor: actor.id,
    contact: contact.id,
    lead: lead.id,
    invoice,
  };
}
export type InvoiceAttemptFixture = Awaited<
  ReturnType<typeof invoiceAttemptFixture>
>;
export async function invoiceAttemptReview(
  f: InvoiceAttemptFixture,
  intent?: InvoiceAttemptReview["intent"],
): Promise<InvoiceAttemptReview> {
  const chain = await getInvoiceDeliveryChain(f.org, f.invoice.id),
    selected = intent ?? chain.nextIntents[0] ?? "retry_not_dispatched";
  const context: InvoiceAttemptReviewMetadata["context"] = {
    leadId: f.lead,
    contactId: f.contact,
    invoiceNumber: f.invoice.invoiceNumber!,
    recipient: "customer@example.invalid",
    sender: {
      userId: f.actor,
      source: "lead_assignee",
      provider: "microsoft",
      senderEmail: "office@example.invalid",
    },
  };
  const metadata: InvoiceAttemptReviewMetadata = {
    reviewVersion: 2,
    payloadSha256: deliveryFingerprint({
      document: f.invoice.document,
      context,
      selected,
      nonce: randomUUID(),
    }),
    expiresAt: new Date(Date.now() + 600000).toISOString(),
    invoiceVersion: f.invoice.version,
    documentSha256: deliveryFingerprint(f.invoice.document),
    intent: selected,
    expectedLatestExecutionId: chain.latestExecutionId,
    reason:
      selected === "initial"
        ? null
        : "Staff reviewed the exact predecessor and approved this separate invoice attempt.",
    duplicateCopyAcknowledged: false,
    context,
  };
  const [preview] = await db
    .insert(auditEventsTable)
    .values({
      organizationId: f.org,
      actorUserId: f.actor,
      action: INVOICE_REVIEW_ACTION,
      entityType: "invoice",
      entityId: f.invoice.id,
      metadata,
    })
    .returning();
  return {
    ...metadata,
    organizationId: f.org,
    invoiceId: f.invoice.id,
    actorUserId: f.actor,
    previewId: preview.id,
    duplicateCopyAcknowledged: selected === "additional_copy",
  };
}
export function invoiceAcceptance(
  review: InvoiceAttemptReview,
): InvoiceAttemptOutcome {
  return {
    kind: "accepted",
    leadId: review.context.leadId,
    contactId: review.context.contactId,
    evidence: {
      provider: "microsoft",
      providerMessageId: null,
      providerRequestId: "synthetic-request",
      acceptance: "accepted",
      deliveryConfirmed: false,
      invoiceId: review.invoiceId,
      invoiceNumber: review.context.invoiceNumber,
      previewId: review.previewId,
      payloadSha256: review.payloadSha256,
      documentSha256: review.documentSha256,
      senderUserId: review.context.sender.userId,
      senderEmail: review.context.sender.senderEmail,
    },
  };
}
