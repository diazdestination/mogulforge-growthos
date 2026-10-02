import {
  activitiesTable,
  auditEventsTable,
  contactsTable,
  db,
  leadsTable,
  revenueExecutionsTable,
  usersTable,
} from "@workspace/db";
import { and, desc, eq } from "drizzle-orm";
import { hasPermission } from "../lib/permissions";
import { InvoiceError } from "./invoice-contract";
import { getInvoice } from "./invoices";
import {
  resolveCustomerEmailSender,
  sendCustomerEmail,
} from "./customer-email";
import { assertCustomerLifecycleActive } from "./customer-lifecycle";
import { assertOutboundDeliveryAllowed } from "./outbound-hold";
import { checkSendEligibility } from "./send-gate";
import { emailAcceptanceEvidence } from "./user-email";
import { runDurableAction } from "./durable-execution";
import { EmailDispatchBlockedError } from "./email-dispatch-guard";
import {
  deliveryFingerprint,
  invoiceDeliveryKey,
  invoiceDeliveryPreviewSchema,
  invoiceDeliverySendSchema,
  renderInvoiceEmail,
  type InvoiceDeliveryEvidence,
} from "./invoice-delivery-contract";

const PREVIEW_LIFETIME_MS = 10 * 60_000;
const reviewAction = "invoice_delivery.previewed";
const deliveryDetail =
  "Gmail/Microsoft acceptance does not confirm inbox delivery. Delivery/bounce monitoring is not connected by this send-only integration.";
const conflict = (message: string): never => {
  throw new InvoiceError(409, "invoice_delivery_review_changed", message);
};
async function manager(org: string, actor: string) {
  const [user] = await db
    .select({ role: usersTable.role })
    .from(usersTable)
    .where(
      and(
        eq(usersTable.organizationId, org),
        eq(usersTable.id, actor),
        eq(usersTable.isActive, true),
      ),
    );
  if (!user || !hasPermission(user.role, "invoices.manage"))
    throw new InvoiceError(
      403,
      "invoice_access_denied",
      "An active staff member with invoice management permission must review and send this invoice.",
    );
}

async function current(org: string, actor: string, invoiceId: string) {
  await manager(org, actor);
  // Reuse canonical document integrity, financial reconciliation, tenant and
  // related-record validation; never render the mutable draft of an issued bill.
  const invoice = await getInvoice(org, actor, invoiceId);
  if (
    invoice.status !== "issued" ||
    !invoice.invoiceNumber ||
    !invoice.issuedAt
  )
    throw new InvoiceError(
      409,
      "invoice_delivery_not_issued",
      "Only a currently issued, non-void invoice can be emailed.",
    );
  const [source] = await db
    .select({ lead: leadsTable, contact: contactsTable })
    .from(leadsTable)
    .innerJoin(
      contactsTable,
      and(
        eq(contactsTable.id, leadsTable.contactId),
        eq(contactsTable.organizationId, org),
      ),
    )
    .where(
      and(
        eq(leadsTable.organizationId, org),
        eq(leadsTable.id, invoice.leadId),
      ),
    );
  if (!source)
    throw new InvoiceError(
      404,
      "invoice_not_found",
      "The invoice customer is unavailable in this company.",
    );
  const recipient = source.contact.email?.trim().toLowerCase() ?? "";
  let sender: Awaited<ReturnType<typeof resolveCustomerEmailSender>>;
  try {
    sender = await resolveCustomerEmailSender({
      organizationId: org,
      leadId: invoice.leadId,
    });
  } catch {
    throw new InvoiceError(
      409,
      "invoice_delivery_sender_unavailable",
      "The assigned or explicitly selected company sender must connect their selected Gmail/Microsoft account. No alternate mailbox will be used.",
    );
  }
  const message = renderInvoiceEmail({
    invoiceNumber: invoice.invoiceNumber,
    issuedAt: invoice.issuedAt,
    document: invoice.document,
  });
  // Current native issue is the transactional basis; imported history is not
  // erased or used to authorize marketing. A changed source/contact/assignment
  // invalidates the displayed review even if its recipient happens to match.
  const snapshot = {
    invoiceId,
    invoiceVersion: invoice.version,
    invoiceNumber: invoice.invoiceNumber,
    issuedAt: invoice.issuedAt,
    documentSha256: deliveryFingerprint(invoice.document),
    leadId: invoice.leadId,
    contactId: source.contact.id,
    sourceSha256: deliveryFingerprint({
      creationMethod: source.lead.creationMethod,
      importedHistory: source.lead.importedHistory,
      updatedAt: source.lead.updatedAt.toISOString(),
      contactUpdatedAt: source.contact.updatedAt.toISOString(),
    }),
    recipient,
    sender,
    ...message,
  };
  return { snapshot, contact: source.contact };
}

async function eligibility(
  org: string,
  value: Awaited<ReturnType<typeof current>>,
) {
  try {
    await assertCustomerLifecycleActive(org);
    assertOutboundDeliveryAllowed({
      channel: "email",
      recipient: value.snapshot.recipient,
    });
  } catch {
    throw new InvoiceError(
      409,
      "invoice_delivery_held",
      "Customer email is held by company lifecycle, staging policy or the outbound safety switch. No email was sent.",
    );
  }
  const gate = await checkSendEligibility({
    organizationId: org,
    leadId: value.snapshot.leadId,
    contact: value.contact,
    channel: "email",
    kind: "transactional",
  });
  if (!gate.ok)
    throw new InvoiceError(
      409,
      "invoice_delivery_held",
      `Invoice email is not permitted (${gate.reason}). No email was sent.`,
    );
}

async function execution(org: string, invoiceId: string) {
  const [row] = await db
    .select()
    .from(revenueExecutionsTable)
    .where(
      and(
        eq(revenueExecutionsTable.organizationId, org),
        eq(revenueExecutionsTable.actionKey, invoiceDeliveryKey(invoiceId)),
      ),
    );
  return row;
}

export async function getInvoiceDelivery(
  org: string,
  actor: string,
  invoiceId: string,
): Promise<InvoiceDeliveryEvidence> {
  const invoice = await getInvoice(org, actor, invoiceId);
  const row = await execution(org, invoiceId);
  const [accepted] = await db
    .select({
      metadata: auditEventsTable.metadata,
      createdAt: auditEventsTable.createdAt,
    })
    .from(auditEventsTable)
    .where(
      and(
        eq(auditEventsTable.organizationId, org),
        eq(auditEventsTable.entityType, "invoice"),
        eq(auditEventsTable.entityId, invoiceId),
        eq(auditEventsTable.action, "invoice_delivery.provider_accepted"),
      ),
    )
    .orderBy(desc(auditEventsTable.createdAt))
    .limit(1);
  const metadata = accepted?.metadata;
  const uncertain =
    row?.state === "indeterminate" ||
    (row?.state === "processing" && row.expiresAt.getTime() <= Date.now());
  const state: InvoiceDeliveryEvidence["state"] = uncertain
    ? "uncertain"
    : row?.state === "processing"
      ? "processing"
      : row?.state === "blocked"
        ? "held"
        : row?.state === "confirmed_succeeded" ||
            row?.state === "confirmed_not_performed"
          ? "reconciled"
          : row?.state === "succeeded" && accepted
            ? "accepted"
            : row
              ? "uncertain"
              : "not_sent";
  const detail = {
    not_sent:
      "No invoice email has been sent through this flow. Preview and explicitly approve the exact customer and document.",
    processing:
      "A send is owned and may be in progress. Check status; do not prepare a second send.",
    accepted:
      "The selected email provider accepted this invoice. Acceptance is not confirmed delivery or a payment.",
    held: "The reserved send was held before dispatch. It was not sent. Operator review is required; this flow does not automatically requeue reserved attempts.",
    uncertain:
      "The effect is uncertain. Check the original selected mailbox and reconcile the execution; a new preview or request cannot resend this invoice.",
    reconciled:
      "An operator recorded a reconciliation. This is not new provider/delivery evidence and does not authorize an automatic resend.",
  }[state];
  return {
    invoiceId,
    state,
    executionId: row?.id ?? null,
    detail,
    provider:
      metadata?.provider === "gmail" || metadata?.provider === "microsoft"
        ? metadata.provider
        : null,
    providerMessageId:
      typeof metadata?.providerMessageId === "string"
        ? metadata.providerMessageId
        : null,
    providerRequestId:
      typeof metadata?.providerRequestId === "string"
        ? metadata.providerRequestId
        : null,
    acceptedAt: accepted?.createdAt.toISOString() ?? null,
    deliveryConfirmed: false,
    deliveryDetail,
    canPrepare: !row && invoice.status === "issued",
  };
}

export async function previewInvoiceDelivery(
  org: string,
  actor: string,
  invoiceId: string,
  raw: unknown,
) {
  const input = invoiceDeliveryPreviewSchema.parse(raw);
  const value = await current(org, actor, invoiceId);
  if (value.snapshot.invoiceVersion !== input.expectedVersion)
    conflict(
      "The invoice changed. Refresh it and review the latest saved document.",
    );
  if (await execution(org, invoiceId))
    throw new InvoiceError(
      409,
      "invoice_delivery_reserved",
      "This invoice already has a reserved send. Check its evidence rather than creating another request.",
    );
  await eligibility(org, value);
  const payloadSha256 = deliveryFingerprint(value.snapshot);
  const expiresAt = new Date(Date.now() + PREVIEW_LIFETIME_MS).toISOString();
  const [review] = await db
    .insert(auditEventsTable)
    .values({
      organizationId: org,
      actorUserId: actor,
      action: reviewAction,
      entityType: "invoice",
      entityId: invoiceId,
      // Only hashes and record identities; immutable invoice contents remain canonical.
      metadata: {
        payloadSha256,
        expiresAt,
        invoiceVersion: value.snapshot.invoiceVersion,
        documentSha256: value.snapshot.documentSha256,
      },
    })
    .returning({ id: auditEventsTable.id });
  return {
    previewId: review!.id,
    payloadSha256,
    expiresAt,
    ...value.snapshot,
    deliveryDetail,
  };
}

export async function sendInvoiceDelivery(
  org: string,
  actor: string,
  invoiceId: string,
  raw: unknown,
) {
  const input = invoiceDeliverySendSchema.parse(raw);
  await manager(org, actor);
  // Read permission and canonical invoice/relationship integrity apply to replay too.
  await getInvoice(org, actor, invoiceId);
  const [review] = await db
    .select()
    .from(auditEventsTable)
    .where(
      and(
        eq(auditEventsTable.id, input.previewId),
        eq(auditEventsTable.organizationId, org),
        eq(auditEventsTable.actorUserId, actor),
        eq(auditEventsTable.action, reviewAction),
        eq(auditEventsTable.entityType, "invoice"),
        eq(auditEventsTable.entityId, invoiceId),
      ),
    );
  if (!review || review.metadata.payloadSha256 !== input.payloadSha256)
    conflict(
      "This exact invoice preview is unavailable to this staff member. Prepare and review it again.",
    );
  if (await execution(org, invoiceId))
    return getInvoiceDelivery(org, actor, invoiceId);
  const check = async () => {
    if (
      typeof review.metadata.expiresAt !== "string" ||
      !Number.isFinite(Date.parse(review.metadata.expiresAt)) ||
      Date.parse(review.metadata.expiresAt) <= Date.now()
    )
      conflict(
        "This preview expired. Prepare and review the invoice again before sending.",
      );
    const value = await current(org, actor, invoiceId);
    if (deliveryFingerprint(value.snapshot) !== input.payloadSha256)
      conflict(
        "The invoice, customer, source or selected sender changed. Review a fresh preview; the old approval cannot send.",
      );
    await eligibility(org, value);
    return value;
  };
  const reviewed = await check();
  try {
    await runDurableAction({
      organizationId: org,
      actionKey: invoiceDeliveryKey(invoiceId),
      kind: "invoice_email",
      payload: {
        invoiceId,
        previewId: input.previewId,
        payloadSha256: input.payloadSha256,
      },
      actorUserId: actor,
      leadId: reviewed.snapshot.leadId,
      execute: async () => {
        try {
          await check();
        } catch (error) {
          if (error instanceof InvoiceError)
            return {
              state: "blocked",
              detail: `Invoice email held before dispatch: ${error.code}.`,
            };
          throw error;
        }
        await db.insert(auditEventsTable).values({
          organizationId: org,
          actorUserId: actor,
          action: "invoice_delivery.approved",
          entityType: "invoice",
          entityId: invoiceId,
          metadata: {
            previewId: review.id,
            payloadSha256: input.payloadSha256,
          },
        });
        // This callback also runs after provider token refresh, at actual dispatch.
        // A late stale approval or revoked permission is never permission to send.
        let dispatchCheckRejected = false;
        let result: Awaited<ReturnType<typeof sendCustomerEmail>>;
        try {
          result = await sendCustomerEmail({
            organizationId: org,
            leadId: reviewed.snapshot.leadId,
            to: reviewed.snapshot.recipient,
            subject: reviewed.snapshot.subject,
            body: reviewed.snapshot.body,
            expectedSender: reviewed.snapshot.sender,
            beforeDispatch: async () => {
              try {
                await check();
              } catch (error) {
                dispatchCheckRejected = true;
                throw error;
              }
            },
          });
        } catch (error) {
          if (
            dispatchCheckRejected ||
            error instanceof EmailDispatchBlockedError
          )
            return {
              state: "blocked",
              detail:
                "Invoice review no longer authorized at dispatch. No email was sent.",
            };
          // No guessing based on provider error text: a timeout, lost receipt or
          // failed receipt write remains indeterminate, never safe for replay.
          throw error;
        }
        const evidence = {
          ...emailAcceptanceEvidence(result, {
            organizationId: org,
            leadId: reviewed.snapshot.leadId,
            recipientEmail: reviewed.snapshot.recipient,
          }),
          invoiceId,
          invoiceNumber: reviewed.snapshot.invoiceNumber,
          previewId: review.id,
          payloadSha256: input.payloadSha256,
          documentSha256: reviewed.snapshot.documentSha256,
          senderUserId: result.senderUserId,
        };
        await db.transaction(async (tx) => {
          await tx.insert(auditEventsTable).values({
            organizationId: org,
            actorUserId: actor,
            action: "invoice_delivery.provider_accepted",
            entityType: "invoice",
            entityId: invoiceId,
            metadata: evidence,
          });
          await tx.insert(activitiesTable).values({
            organizationId: org,
            actorUserId: actor,
            leadId: reviewed.snapshot.leadId,
            contactId: reviewed.snapshot.contactId,
            type: "email_sent",
            title: `Invoice ${reviewed.snapshot.invoiceNumber} accepted by email provider`,
            metadata: evidence,
          });
        });
        return {
          state: "succeeded",
          detail:
            "Invoice accepted by selected email provider; delivery is unconfirmed.",
        };
      },
    });
  } catch (error) {
    // A racing review with another hash/key cannot bypass the one logical slot.
    if (!(await execution(org, invoiceId))) throw error;
  }
  return getInvoiceDelivery(org, actor, invoiceId);
}
