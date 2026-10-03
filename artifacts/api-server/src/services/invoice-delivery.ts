import {
  auditEventsTable,
  contactsTable,
  db,
  leadsTable,
  usersTable,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
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
import { EmailDispatchBlockedError } from "./email-dispatch-guard";
import {
  assertInvoiceDeliveryAttemptDispatch,
  getInvoiceDeliveryChain,
  invoiceAttemptReviewMetadataSchema,
  runInvoiceDeliveryAttempt,
  type InvoiceAttemptReviewMetadata,
  type InvoiceDeliveryChain,
} from "./invoice-delivery-attempts";
import {
  deliveryFingerprint,
  invoiceDeliveryPreviewSchema,
  invoiceDeliverySendSchema,
  renderInvoiceEmail,
  type InvoiceDeliveryEvidence,
  type InvoiceDeliveryIntent,
} from "./invoice-delivery-contract";

const PREVIEW_LIFETIME_MS = 10 * 60_000;
const reviewAction = "invoice_delivery.previewed";
const deliveryDetail =
  "Gmail/Microsoft acceptance does not confirm inbox delivery. Delivery/bounce monitoring is not connected by this send-only integration.";
function conflict(message: string): never {
  throw new InvoiceError(409, "invoice_delivery_review_changed", message);
}
async function manager(org: string, actor: string) {
  const [user] = await db
    .select({
      role: usersTable.role,
      emailVerifiedAt: usersTable.emailVerifiedAt,
    })
    .from(usersTable)
    .where(
      and(
        eq(usersTable.organizationId, org),
        eq(usersTable.id, actor),
        eq(usersTable.isActive, true),
      ),
    );
  if (
    !user ||
    !user.emailVerifiedAt ||
    actor.startsWith("invite:") ||
    !hasPermission(user.role, "invoices.manage")
  )
    throw new InvoiceError(
      403,
      "invoice_access_denied",
      "A verified, accepted active staff member with invoice management permission must review and send this invoice.",
    );
}

async function current(
  org: string,
  actor: string,
  invoiceId: string,
  intent: InvoiceDeliveryIntent,
) {
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
    additionalCopy: intent === "additional_copy",
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
      source: source.lead.source,
      assignedUserId: source.lead.assignedUserId,
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

export async function getInvoiceDelivery(
  org: string,
  actor: string,
  invoiceId: string,
): Promise<InvoiceDeliveryEvidence> {
  const invoice = await getInvoice(org, actor, invoiceId);
  const chain = await getInvoiceDeliveryChain(org, invoiceId);
  const row = chain.attempts.at(-1);
  const uncertain =
    chain.integrity !== "valid" || row?.state === "indeterminate";
  const state: InvoiceDeliveryEvidence["state"] = uncertain
    ? "uncertain"
    : row?.state === "processing"
      ? "processing"
      : row?.state === "blocked"
        ? "held"
        : row?.state === "confirmed_succeeded" ||
            row?.state === "confirmed_not_performed"
          ? "reconciled"
          : row?.state === "succeeded" && row.proof === "provider_accepted"
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
    held:
      row?.proof === "not_dispatched"
        ? "The server recorded that this exact attempt was refused before provider dispatch. A new, separately reviewed retry may be available; the original receipt stays retained."
        : "This historical attempt is held, but no typed server proof establishes that it was not dispatched. Review the evidence; it cannot authorize a retry.",
    uncertain:
      "The effect is uncertain. Check the original selected mailbox and reconcile the execution; a new preview or request cannot resend this invoice.",
    reconciled:
      "An operator recorded a reconciliation. This is not new provider/delivery evidence and does not authorize an automatic resend.",
  }[state];
  return {
    ...chain,
    state,
    executionId: chain.latestExecutionId,
    detail,
    provider: row?.provider ?? null,
    providerMessageId: row?.providerMessageId ?? null,
    providerRequestId: row?.providerRequestId ?? null,
    acceptedAt: row?.acceptedAt ?? null,
    deliveryConfirmed: false,
    deliveryDetail,
    // Backward-compatible initial-only flag. New clients must use the kernel's
    // nextIntents, never infer retry permission from a display state.
    canPrepare:
      invoice.status === "issued" && chain.nextIntents.includes("initial"),
  };
}

function decision(
  metadata: Pick<
    InvoiceAttemptReviewMetadata,
    "intent" | "expectedLatestExecutionId" | "reason"
  >,
) {
  return {
    intent: metadata.intent,
    expectedLatestExecutionId: metadata.expectedLatestExecutionId,
    reason: metadata.reason,
  };
}
function context(
  snapshot: Awaited<ReturnType<typeof current>>["snapshot"],
): InvoiceAttemptReviewMetadata["context"] {
  return {
    leadId: snapshot.leadId,
    contactId: snapshot.contactId,
    invoiceNumber: snapshot.invoiceNumber,
    recipient: snapshot.recipient,
    sender: snapshot.sender,
  };
}
function requireIntent(
  chain: InvoiceDeliveryChain,
  input: ReturnType<typeof decision>,
) {
  if (
    chain.integrity !== "valid" ||
    chain.latestExecutionId !== input.expectedLatestExecutionId ||
    !chain.nextIntents.includes(input.intent)
  )
    throw new InvoiceError(
      409,
      "invoice_delivery_reserved",
      "This review mode is not authorized by the latest retained evidence. Refresh invoice delivery status and choose an available review; uncertainty and reconciliation cannot authorize a new send.",
    );
}

export async function previewInvoiceDelivery(
  org: string,
  actor: string,
  invoiceId: string,
  raw: unknown,
) {
  const input = invoiceDeliveryPreviewSchema.parse(raw);
  const value = await current(org, actor, invoiceId, input.intent);
  if (value.snapshot.invoiceVersion !== input.expectedVersion)
    conflict(
      "The invoice changed. Refresh it and review the latest saved document.",
    );
  const chain = await getInvoiceDeliveryChain(org, invoiceId);
  requireIntent(chain, input);
  await eligibility(org, value);
  const choice = decision(input);
  const payloadSha256 = deliveryFingerprint({ ...value.snapshot, ...choice });
  const expiresAt = new Date(Date.now() + PREVIEW_LIFETIME_MS).toISOString();
  const metadata = invoiceAttemptReviewMetadataSchema.parse({
    reviewVersion: 2,
    payloadSha256,
    expiresAt,
    invoiceVersion: value.snapshot.invoiceVersion,
    documentSha256: value.snapshot.documentSha256,
    ...choice,
    duplicateCopyAcknowledged: false,
    context: context(value.snapshot),
  });
  const [review] = await db
    .insert(auditEventsTable)
    .values({
      organizationId: org,
      actorUserId: actor,
      action: reviewAction,
      entityType: "invoice",
      entityId: invoiceId,
      // Retain exact selected identities and decisions, not message bodies or
      // provider credentials. The issued document remains canonical.
      metadata,
    })
    .returning({ id: auditEventsTable.id });
  return {
    previewId: review!.id,
    payloadSha256,
    expiresAt,
    ...value.snapshot,
    ...choice,
    prospectiveAttemptNumber: chain.attemptCount + 1,
    maxAttempts: chain.maxAttempts,
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
  const readReview = async () =>
    (
      await db
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
        )
    )[0];
  const review = await readReview();
  const parsed = invoiceAttemptReviewMetadataSchema.safeParse(review?.metadata);
  if (
    !review ||
    !parsed.success ||
    parsed.data.payloadSha256 !== input.payloadSha256
  )
    conflict(
      "This exact invoice preview is unavailable to this staff member. Prepare and review it again.",
    );
  // Old previews are not adopted into new authority. Old-format accepted
  // history remains read-only; only an eligible v2 chain can authorize a copy.
  const metadata = parsed.data;
  if (
    (input.duplicateCopyAcknowledged === true) !==
    (metadata.intent === "additional_copy")
  )
    throw new InvoiceError(
      409,
      "invoice_delivery_copy_acknowledgement_required",
      "An additional copy requires a new acknowledgement after reviewing its exact document, customer and sender. Other review modes cannot use that acknowledgement.",
    );
  const chain = await getInvoiceDeliveryChain(org, invoiceId);
  // Repeated clicks or another preview racing the same predecessor only return
  // retained status. They cannot mint a different logical attempt.
  if (
    chain.integrity !== "valid" ||
    chain.latestExecutionId !== metadata.expectedLatestExecutionId
  )
    return getInvoiceDelivery(org, actor, invoiceId);
  const check = async () => {
    const saved = await readReview();
    if (
      !saved ||
      deliveryFingerprint(saved.metadata) !== deliveryFingerprint(metadata) ||
      Date.parse(metadata.expiresAt) <= Date.now()
    )
      conflict(
        "This preview expired. Prepare and review the invoice again before sending.",
      );
    const value = await current(org, actor, invoiceId, metadata.intent);
    if (
      deliveryFingerprint({ ...value.snapshot, ...decision(metadata) }) !==
        input.payloadSha256 ||
      deliveryFingerprint(context(value.snapshot)) !==
        deliveryFingerprint(metadata.context)
    )
      conflict(
        "The invoice, customer, source or selected sender changed. Review a fresh preview; the old approval cannot send.",
      );
    await eligibility(org, value);
    return value;
  };
  const reviewed = await check();
  requireIntent(chain, metadata);
  try {
    await runInvoiceDeliveryAttempt(
      {
        ...metadata,
        organizationId: org,
        invoiceId,
        previewId: input.previewId,
        actorUserId: actor,
        duplicateCopyAcknowledged: input.duplicateCopyAcknowledged === true,
      },
      async (claim) => {
        try {
          await check();
          await assertInvoiceDeliveryAttemptDispatch(claim);
        } catch (error) {
          if (
            error instanceof InvoiceError ||
            error instanceof EmailDispatchBlockedError
          )
            return {
              kind: "not_dispatched",
              code: "review_changed_before_dispatch",
            };
          throw error;
        }
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
                await assertInvoiceDeliveryAttemptDispatch(claim);
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
            return { kind: "not_dispatched", code: "dispatch_guard_rejected" };
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
        // The kernel atomically finalizes acceptance, receipt and activity. A
        // lost final write is not retried and never becomes no-effect proof.
        return {
          kind: "accepted",
          evidence,
          leadId: reviewed.snapshot.leadId,
          contactId: reviewed.snapshot.contactId,
        };
      },
    );
  } catch (error) {
    const latest = await getInvoiceDeliveryChain(org, invoiceId);
    if (
      latest.integrity === "valid" &&
      latest.latestExecutionId === metadata.expectedLatestExecutionId
    )
      throw error;
  }
  return getInvoiceDelivery(org, actor, invoiceId);
}
