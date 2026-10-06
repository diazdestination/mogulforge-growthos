import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, like, or, sql } from "drizzle-orm";
import { z } from "zod/v4";
import {
  activitiesTable,
  auditEventsTable as audits,
  contactsTable,
  db,
  invoicesTable as invoices,
  leadsTable,
  propertiesTable,
  revenueExecutionsTable as executions,
  revenueExecutionEventsTable as events,
  usersTable,
  type ExecutionState,
  type UserRole,
} from "@workspace/db";
import {
  invoiceDeliveryAttemptsTable as attempts,
  type InvoiceDeliveryIntent,
} from "../../../../lib/db/src/schema/invoice-delivery-attempts";
import { customerWorkRootsTable as workRoots } from "../../../../lib/db/src/schema/customer-work";
import { hasPermission } from "../lib/permissions";
import {
  lockContractorSchedule,
  type ScheduleTransaction,
} from "./contractor-scheduling";
import { getCustomerLifecycleStatus } from "./customer-lifecycle";
import { InvoiceError } from "./invoice-contract";
import {
  deliveryFingerprint,
  invoiceDeliveryKey,
} from "./invoice-delivery-contract";
import { EmailDispatchBlockedError } from "./email-dispatch-guard";
import { assertOutboundDeliveryAllowed } from "./outbound-hold";
import { readInvoiceDetail, readReturningInvoiceLineage } from "./invoices";
import { readCompanyEmailSender } from "./customer-email";
import { checkSendEligibility } from "./send-gate";
import { hasContactReplyHold } from "./response-correlation";

type Reader = typeof db | ScheduleTransaction;
type Attempt = typeof attempts.$inferSelect;
type Receipt = typeof executions.$inferSelect;
type Audit = typeof audits.$inferSelect;
export const INVOICE_MAX_ATTEMPTS = 5;
export const INVOICE_REVIEW_ACTION = "invoice_delivery.previewed";
const ACCEPTED = "invoice_delivery.provider_accepted",
  REFUSED = "invoice_delivery.not_dispatched";
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const nullableReason = z.string().trim().min(10).max(1000).nullable();
const contextSchema = z
  .object({
    leadId: z.uuid(),
    contactId: z.uuid(),
    invoiceNumber: z.string().min(1).max(100),
    recipient: z.email(),
    sender: z
      .object({
        userId: z.string().min(1),
        source: z.enum(["lead_assignee", "company_default"]),
        provider: z.enum(["gmail", "microsoft"]),
        senderEmail: z.email(),
      })
      .strict(),
  })
  .strict();
// Preserve this exact v2 shape. Historical hashes/participants are not migrated.
export const invoiceAttemptReviewV2MetadataSchema = z
  .object({
    reviewVersion: z.literal(2),
    payloadSha256: hash,
    expiresAt: z.iso.datetime(),
    invoiceVersion: z.number().int().positive(),
    documentSha256: hash,
    intent: z.enum(["initial", "retry_not_dispatched", "additional_copy"]),
    expectedLatestExecutionId: z.uuid().nullable(),
    reason: nullableReason,
    duplicateCopyAcknowledged: z.literal(false),
    context: contextSchema,
  })
  .strict()
  .refine((value) =>
    value.intent === "initial"
      ? value.expectedLatestExecutionId === null && value.reason === null
      : value.expectedLatestExecutionId !== null && value.reason !== null,
  );
export const invoiceAttemptReviewV3MetadataSchema = z
  .object({
    reviewVersion: z.literal(3),
    payloadSha256: hash,
    expiresAt: z.iso.datetime(),
    invoiceVersion: z.number().int().positive(),
    documentSha256: hash,
    intent: z.enum(["initial", "retry_not_dispatched", "additional_copy"]),
    expectedLatestExecutionId: z.uuid().nullable(),
    reason: nullableReason,
    duplicateCopyAcknowledged: z.literal(false),
    context: z
      .object({
        leadId: z.null(),
        customerWorkId: z.uuid(),
        contactId: z.uuid(),
        propertyId: z.uuid().nullable(),
        sourceSha256: hash,
        senderIdentitySha256: hash,
        invoiceNumber: z.string().min(1).max(100),
        recipient: z.email(),
        sender: z
          .object({
            userId: z.string().min(1),
            source: z.literal("company_default"),
            provider: z.enum(["gmail", "microsoft"]),
            senderEmail: z.email(),
          })
          .strict(),
      })
      .strict(),
  })
  .strict()
  .refine((value) =>
    value.intent === "initial"
      ? value.expectedLatestExecutionId === null && value.reason === null
      : value.expectedLatestExecutionId !== null && value.reason !== null,
  );
export const invoiceAttemptReviewMetadataSchema = z.union([
  invoiceAttemptReviewV2MetadataSchema,
  invoiceAttemptReviewV3MetadataSchema,
]);
export type InvoiceAttemptReviewMetadata = z.infer<
  typeof invoiceAttemptReviewMetadataSchema
>;
type WithoutAcknowledgment<T> = T extends unknown
  ? Omit<T, "duplicateCopyAcknowledged">
  : never;
export type InvoiceAttemptReview =
  WithoutAcknowledgment<InvoiceAttemptReviewMetadata> & {
    organizationId: string;
    invoiceId: string;
    actorUserId: string;
    previewId: string;
    duplicateCopyAcknowledged: boolean;
    effectiveRole?: UserRole;
  };
export type InvoiceAttemptClaim = {
  organizationId: string;
  invoiceId: string;
  attemptId: string;
  executionId: string;
  ordinal: number;
  actionKey: string;
  executionFingerprint: string;
  actorUserId: string;
  previewId: string;
  payloadSha256: string;
  effectiveRole?: UserRole;
};
export type InvoiceAttemptOutcome =
  | {
      kind: "not_dispatched";
      code: "review_changed_before_dispatch" | "dispatch_guard_rejected";
    }
  | {
      kind: "accepted";
      leadId: string | null;
      contactId: string;
      customerWorkId?: string;
      propertyId?: string | null;
      evidence: Record<string, unknown> & {
        provider: string;
        providerMessageId: string | null;
        acceptance: string;
        deliveryConfirmed: boolean;
        invoiceId: string;
        invoiceNumber: string;
        previewId: string;
        payloadSha256: string;
        documentSha256: string;
        senderUserId: string;
        senderEmail?: string;
      };
    };
export interface InvoiceDeliveryAttemptEvidence {
  attemptId: string | null;
  legacy: boolean;
  ordinal: number;
  executionId: string;
  actionKey: string;
  intent: InvoiceDeliveryIntent;
  state: ExecutionState;
  detail: string;
  proof: "not_dispatched" | "provider_accepted" | "none";
  proofId: string | null;
  createdAt: string;
  completedAt: string | null;
  provider: "gmail" | "microsoft" | null;
  providerMessageId: string | null;
  providerRequestId: string | null;
  acceptedAt: string | null;
}
export interface InvoiceDeliveryChain {
  invoiceId: string;
  attemptCount: number;
  maxAttempts: 5;
  latestExecutionId: string | null;
  nextIntents: InvoiceDeliveryIntent[];
  attentionReason: string | null;
  integrity: "valid" | "unavailable";
  attempts: InvoiceDeliveryAttemptEvidence[];
}
function fail(
  code: string,
  message = "Invoice email evidence changed or is unavailable. Refresh and review the saved history; no new send is authorized.",
): never {
  throw new InvoiceError(409, code, message);
}
const key = (invoiceId: string, ordinal: number) =>
  ordinal === 1
    ? invoiceDeliveryKey(invoiceId)
    : `${invoiceDeliveryKey(invoiceId)}:attempt:${ordinal}`;
const fingerprint = (
  invoiceId: string,
  previewId: string,
  payloadSha256: string,
) => deliveryFingerprint({ invoiceId, previewId, payloadSha256 });
const metadataOf = (
  review: InvoiceAttemptReview,
): InvoiceAttemptReviewMetadata =>
  invoiceAttemptReviewMetadataSchema.parse({
    reviewVersion: review.reviewVersion,
    payloadSha256: review.payloadSha256,
    expiresAt: review.expiresAt,
    invoiceVersion: review.invoiceVersion,
    documentSha256: review.documentSha256,
    intent: review.intent,
    expectedLatestExecutionId: review.expectedLatestExecutionId,
    reason: review.reason,
    duplicateCopyAcknowledged: false,
    context: review.context,
  });
const states = new Set([
  "processing",
  "succeeded",
  "blocked",
  "indeterminate",
  "confirmed_succeeded",
  "confirmed_not_performed",
]);
function unavailable(invoiceId: string, count = 0): InvoiceDeliveryChain {
  return {
    invoiceId,
    attemptCount: count,
    maxAttempts: 5,
    latestExecutionId: null,
    nextIntents: [],
    attentionReason: "chain_evidence_unavailable",
    integrity: "unavailable",
    attempts: [],
  };
}
function proofMetadataMatches(
  proof: Audit,
  receipt: Receipt,
  invoiceId: string,
  preview: Audit,
  payloadSha256: string,
  documentSha256: string,
) {
  const m = proof.metadata;
  return (
    proof.organizationId === receipt.organizationId &&
    proof.entityType === "invoice" &&
    proof.entityId === invoiceId &&
    proof.actorUserId === receipt.actorUserId &&
    m.invoiceId === invoiceId &&
    m.previewId === preview.id &&
    m.payloadSha256 === payloadSha256 &&
    m.documentSha256 === documentSha256
  );
}
function acceptedValid(m: Record<string, unknown>) {
  return (
    ["gmail", "microsoft"].includes(String(m.provider)) &&
    m.acceptance === "accepted" &&
    m.deliveryConfirmed === false &&
    typeof m.senderUserId === "string" &&
    typeof m.senderEmail === "string" &&
    z.email().safeParse(m.senderEmail).success &&
    (m.provider === "gmail"
      ? typeof m.providerMessageId === "string" &&
        m.providerMessageId.length > 0
      : m.providerMessageId === null) &&
    (m.providerRequestId === undefined ||
      m.providerRequestId === null ||
      typeof m.providerRequestId === "string")
  );
}

/** Internal SELECT-only loader. HTTP callers must first authorize the canonical invoice page. */
export async function getInvoiceDeliveryChains(
  org: string,
  invoiceIds: string[],
  reader: Reader = db,
): Promise<Map<string, InvoiceDeliveryChain>> {
  const ids = [...new Set(z.array(z.uuid()).max(50).parse(invoiceIds))];
  if (!ids.length) return new Map();
  // A transaction reader owns one PostgreSQL client. Keep these bounded reads
  // sequential rather than queueing concurrent queries on that same session.
  const invoiceRows = await reader
    .select({
      id: invoices.id,
      status: invoices.status,
      leadId: invoices.leadId,
      customerWorkId: invoices.customerWorkId,
      rootId: workRoots.id,
      rootContactId: workRoots.contactId,
      rootPropertyId: workRoots.propertyId,
      contactId: contactsTable.id,
      propertyId: propertiesTable.id,
      propertyContactId: propertiesTable.contactId,
    })
    .from(invoices)
    .leftJoin(
      workRoots,
      and(
        eq(workRoots.id, invoices.customerWorkId),
        eq(workRoots.organizationId, org),
      ),
    )
    .leftJoin(
      contactsTable,
      and(
        eq(contactsTable.id, workRoots.contactId),
        eq(contactsTable.organizationId, org),
      ),
    )
    .leftJoin(
      propertiesTable,
      and(
        eq(propertiesTable.id, workRoots.propertyId),
        eq(propertiesTable.organizationId, org),
      ),
    )
    .where(and(eq(invoices.organizationId, org), inArray(invoices.id, ids)));
  const attemptRows = await reader
    .select()
    .from(attempts)
    .where(
      and(eq(attempts.organizationId, org), inArray(attempts.invoiceId, ids)),
    )
    .orderBy(asc(attempts.ordinal))
    .limit(ids.length * 5 + 1);
  const receiptRows = await reader
    .select()
    .from(executions)
    .where(
      and(
        eq(executions.organizationId, org),
        or(
          ...ids.map((id) =>
            like(executions.actionKey, `${invoiceDeliveryKey(id)}%`),
          ),
        ),
      ),
    )
    .limit(ids.length * 5 + 1);
  const proofRows = await reader
    .select()
    .from(audits)
    .where(
      and(
        eq(audits.organizationId, org),
        eq(audits.entityType, "invoice"),
        inArray(audits.entityId, ids),
        inArray(audits.action, [ACCEPTED, REFUSED]),
      ),
    )
    .limit(ids.length * 10 + 1);
  if (
    attemptRows.length > ids.length * 5 ||
    receiptRows.length > ids.length * 5 ||
    proofRows.length > ids.length * 10
  )
    return new Map(ids.map((id) => [id, unavailable(id)]));
  const previewIds = [
    ...new Set([
      ...attemptRows.map((row) => row.previewId),
      ...proofRows.flatMap((row) =>
        z.uuid().safeParse(row.metadata.previewId).success
          ? [String(row.metadata.previewId)]
          : [],
      ),
    ]),
  ];
  const previewRows = previewIds.length
    ? await reader
        .select()
        .from(audits)
        .where(
          and(eq(audits.organizationId, org), inArray(audits.id, previewIds)),
        )
    : [];
  const previews = new Map(previewRows.map((row) => [row.id, row]));
  const result = new Map<string, InvoiceDeliveryChain>();
  for (const invoiceId of ids) {
    const invoice = invoiceRows.find((row) => row.id === invoiceId),
      own = attemptRows.filter((row) => row.invoiceId === invoiceId),
      receipts = receiptRows.filter((row) =>
        row.actionKey.startsWith(invoiceDeliveryKey(invoiceId)),
      ),
      proofs = proofRows.filter((row) => row.entityId === invoiceId);
    let invalid = !invoice || receipts.length > 5 || own.length > 5;
    if (
      invoice?.customerWorkId &&
      (invoice.leadId !== null ||
        invoice.rootId !== invoice.customerWorkId ||
        !invoice.contactId ||
        invoice.contactId !== invoice.rootContactId ||
        (invoice.rootPropertyId !== null &&
          (invoice.propertyId !== invoice.rootPropertyId ||
            invoice.propertyContactId !== invoice.rootContactId)))
    )
      invalid = true;
    const entries: InvoiceDeliveryAttemptEvidence[] = [];
    const usedProofs = new Set<string>();
    for (let ordinal = 1; ordinal <= receipts.length && !invalid; ordinal++) {
      const receipt = receipts.find(
          (row) => row.actionKey === key(invoiceId, ordinal),
        ),
        attempt = own.find((row) => row.ordinal === ordinal);
      if (
        !receipt ||
        !states.has(receipt.state) ||
        receipt.kind !== "invoice_email" ||
        !receipt.actorUserId ||
        (ordinal > 1 && !attempt)
      ) {
        invalid = true;
        break;
      }
      const prior = entries.at(-1);
      const candidates = proofs.filter(
        (row) =>
          row.metadata.executionId === receipt.id ||
          (ordinal === 1 &&
            !attempt &&
            row.metadata.executionId === undefined &&
            row.action === ACCEPTED),
      );
      if (candidates.length > 1) {
        invalid = true;
        break;
      }
      const proof = candidates[0];
      let preview: Audit | undefined,
        payloadSha256: string | undefined,
        documentSha256: string | undefined,
        context: InvoiceAttemptReviewMetadata["context"] | undefined;
      if (attempt) {
        preview = previews.get(attempt.previewId);
        const parsed = invoiceAttemptReviewMetadataSchema.safeParse(
          preview?.metadata,
        );
        if (
          !preview ||
          !parsed.success ||
          preview.action !== INVOICE_REVIEW_ACTION ||
          preview.entityType !== "invoice" ||
          preview.entityId !== invoiceId ||
          preview.actorUserId !== attempt.actorUserId ||
          attempt.executionId !== receipt.id ||
          attempt.actionKey !== receipt.actionKey ||
          attempt.actorUserId !== receipt.actorUserId ||
          attempt.executionFingerprint !== receipt.fingerprint ||
          attempt.reviewSha256 !== deliveryFingerprint(preview.metadata) ||
          attempt.payloadSha256 !== parsed.data.payloadSha256 ||
          attempt.documentSha256 !== parsed.data.documentSha256 ||
          attempt.invoiceVersion !== parsed.data.invoiceVersion ||
          attempt.intent !== parsed.data.intent ||
          attempt.duplicateCopyAcknowledged !==
            (attempt.intent === "additional_copy") ||
          receipt.fingerprint !==
            fingerprint(invoiceId, preview.id, attempt.payloadSha256)
        ) {
          invalid = true;
          break;
        }
        payloadSha256 = attempt.payloadSha256;
        documentSha256 = attempt.documentSha256;
        context = parsed.data.context;
        // Immutable native lineage must agree with the retained participants.
        // Do not compare old acceptance with today's mutable names, address,
        // sender connection or source hash: those are reviewed afresh for a copy.
        if (
          parsed.data.reviewVersion === 3
            ? invoice?.leadId !== null ||
              invoice.customerWorkId !== parsed.data.context.customerWorkId ||
              invoice.rootId !== parsed.data.context.customerWorkId ||
              invoice.rootContactId !== parsed.data.context.contactId ||
              invoice.rootPropertyId !== parsed.data.context.propertyId
            : invoice?.customerWorkId !== null
        ) {
          invalid = true;
          break;
        }
        if (
          ordinal === 1
            ? attempt.intent !== "initial" ||
              parsed.data.expectedLatestExecutionId !== null ||
              attempt.predecessorExecutionId !== null
            : !prior ||
              attempt.predecessorExecutionId !== prior.executionId ||
              parsed.data.expectedLatestExecutionId !== prior.executionId ||
              attempt.predecessorActionKey !== prior.actionKey ||
              attempt.predecessorFingerprint !==
                receipts.find((row) => row.id === prior.executionId)
                  ?.fingerprint ||
              attempt.predecessorProofId !== prior.proofId ||
              (attempt.intent === "retry_not_dispatched"
                ? prior.state !== "blocked" || prior.proof !== "not_dispatched"
                : attempt.intent !== "additional_copy" ||
                  prior.state !== "succeeded" ||
                  prior.proof !== "provider_accepted")
        ) {
          invalid = true;
          break;
        }
      } else if (proof) {
        preview = previews.get(String(proof.metadata.previewId));
        if (
          !preview ||
          preview.action !== INVOICE_REVIEW_ACTION ||
          preview.entityType !== "invoice" ||
          preview.entityId !== invoiceId ||
          preview.actorUserId !== receipt.actorUserId ||
          !hash.safeParse(preview.metadata.payloadSha256).success ||
          !hash.safeParse(preview.metadata.documentSha256).success ||
          receipt.fingerprint !==
            fingerprint(
              invoiceId,
              preview.id,
              String(preview.metadata.payloadSha256),
            )
        ) {
          invalid = true;
          break;
        }
        payloadSha256 = String(preview.metadata.payloadSha256);
        documentSha256 = String(preview.metadata.documentSha256);
      }
      let proofKind: InvoiceDeliveryAttemptEvidence["proof"] = "none";
      if (proof) {
        if (
          !preview ||
          !payloadSha256 ||
          !documentSha256 ||
          !proofMetadataMatches(
            proof,
            receipt,
            invoiceId,
            preview,
            payloadSha256,
            documentSha256,
          )
        ) {
          invalid = true;
          break;
        }
        const m = proof.metadata;
        if (
          attempt &&
          (m.proofVersion !== 1 ||
            m.attemptId !== attempt.id ||
            m.executionId !== receipt.id ||
            m.actionKey !== receipt.actionKey ||
            m.executionFingerprint !== receipt.fingerprint ||
            m.ordinal !== ordinal)
        ) {
          invalid = true;
          break;
        }
        if (proof.action === ACCEPTED) {
          if (
            !acceptedValid(m) ||
            (context &&
              (m.senderUserId !== context.sender.userId ||
                m.senderEmail !== context.sender.senderEmail ||
                m.provider !== context.sender.provider ||
                m.invoiceNumber !== context.invoiceNumber ||
                m.leadId !== context.leadId ||
                m.contactId !== context.contactId ||
                ("customerWorkId" in context &&
                  (m.customerWorkId !== context.customerWorkId ||
                    m.propertyId !== context.propertyId ||
                    m.recipient !== context.recipient ||
                    m.sourceSha256 !== context.sourceSha256 ||
                    m.senderIdentitySha256 !== context.senderIdentitySha256))))
          ) {
            invalid = true;
            break;
          }
          proofKind = "provider_accepted";
        } else {
          if (
            !attempt ||
            m.phase !== "pre_provider" ||
            ![
              "review_changed_before_dispatch",
              "dispatch_guard_rejected",
            ].includes(String(m.code))
          ) {
            invalid = true;
            break;
          }
          proofKind = "not_dispatched";
        }
        usedProofs.add(proof.id);
      }
      const state =
        receipt.state === "processing" &&
        receipt.expiresAt.getTime() <= Date.now()
          ? "indeterminate"
          : receipt.state;
      entries.push({
        attemptId: attempt?.id ?? null,
        legacy: !attempt,
        ordinal,
        executionId: receipt.id,
        actionKey: receipt.actionKey,
        intent: attempt?.intent ?? "initial",
        state,
        detail:
          receipt.detail ??
          "Execution reserved; provider effect is not yet confirmed.",
        proof: proofKind,
        proofId: proof?.id ?? null,
        createdAt: receipt.createdAt.toISOString(),
        completedAt: receipt.completedAt?.toISOString() ?? null,
        provider:
          proofKind === "provider_accepted"
            ? (proof!.metadata.provider as "gmail" | "microsoft")
            : null,
        providerMessageId:
          proofKind === "provider_accepted" &&
          typeof proof!.metadata.providerMessageId === "string"
            ? proof!.metadata.providerMessageId
            : null,
        providerRequestId:
          proofKind === "provider_accepted" &&
          typeof proof!.metadata.providerRequestId === "string"
            ? proof!.metadata.providerRequestId
            : null,
        acceptedAt:
          proofKind === "provider_accepted"
            ? proof!.createdAt.toISOString()
            : null,
      });
    }
    if (
      own.length !== entries.filter((row) => !row.legacy).length ||
      proofs.some((row) => !usedProofs.has(row.id))
    )
      invalid = true;
    if (invalid) {
      result.set(invoiceId, unavailable(invoiceId, receipts.length));
      continue;
    }
    const latest = entries.at(-1),
      nextIntents: InvoiceDeliveryIntent[] = [];
    let attentionReason: string | null = null;
    if (invoice?.status !== "issued") attentionReason = "invoice_not_issued";
    else if (entries.length >= 5) attentionReason = "attempt_limit_reached";
    else if (!latest) nextIntents.push("initial");
    // The historical preview only saved hashes, not immutable participants or
    // sender identity. Preserve its evidence without adopting today's context
    // as authority for an additional external effect.
    else if (latest.legacy)
      attentionReason = "legacy_review_identity_unavailable";
    else if (latest.state === "blocked" && latest.proof === "not_dispatched")
      nextIntents.push("retry_not_dispatched");
    else if (
      latest.state === "succeeded" &&
      latest.proof === "provider_accepted"
    )
      nextIntents.push("additional_copy");
    else
      attentionReason =
        latest.state === "processing"
          ? "send_processing"
          : latest.state.startsWith("confirmed_")
            ? "reconciliation_is_not_send_proof"
            : latest.state === "blocked"
              ? "no_typed_no_dispatch_proof"
              : "effect_requires_review";
    result.set(invoiceId, {
      invoiceId,
      attemptCount: entries.length,
      maxAttempts: 5,
      latestExecutionId: latest?.executionId ?? null,
      nextIntents,
      attentionReason,
      integrity: "valid",
      attempts: entries,
    });
  }
  return result;
}
export async function getInvoiceDeliveryChain(
  org: string,
  invoiceId: string,
  reader: Reader = db,
) {
  return (await getInvoiceDeliveryChains(org, [invoiceId], reader)).get(
    invoiceId,
  )!;
}

async function lock(tx: ScheduleTransaction, org: string) {
  await tx.execute(
    sql`select set_config('lock_timeout','3000ms',true), set_config('statement_timeout','10000ms',true)`,
  );
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`customer-lifecycle:${org}`},0))`,
  );
  await lockContractorSchedule(tx, org);
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`invoices:${org}`},0))`,
  );
}
async function manager(
  reader: Reader,
  org: string,
  actor: string,
  effectiveRole?: UserRole,
) {
  const query = reader
    .select()
    .from(usersTable)
    .where(and(eq(usersTable.organizationId, org), eq(usersTable.id, actor)));
  const [user] = await (reader === db ? query : query.for("share"));
  if (
    !user?.isActive ||
    !user.emailVerifiedAt ||
    user.id.startsWith("invite:") ||
    !hasPermission(user.role, "invoices.manage") ||
    !hasPermission(effectiveRole ?? user.role, "invoices.manage")
  )
    throw new InvoiceError(
      403,
      "invoice_access_denied",
      "An accepted invoice manager must review this send.",
    );
}
async function assertReview(
  tx: Reader,
  review: InvoiceAttemptReview,
  expected: InvoiceAttemptReviewMetadata,
) {
  const [saved] = await tx
    .select()
    .from(audits)
    .where(
      and(
        eq(audits.organizationId, review.organizationId),
        eq(audits.id, review.previewId),
      ),
    );
  if (
    !saved ||
    saved.action !== INVOICE_REVIEW_ACTION ||
    saved.actorUserId !== review.actorUserId ||
    saved.entityType !== "invoice" ||
    saved.entityId !== review.invoiceId ||
    deliveryFingerprint(saved.metadata) !== deliveryFingerprint(expected)
  )
    fail("invoice_delivery_review_changed");
  if (Date.parse(expected.expiresAt) <= Date.now())
    fail("invoice_delivery_review_expired");
  if (expected.reviewVersion === 3) {
    // Caller retains lifecycle -> schedule -> invoice locks. These readers lock
    // the actual native/identity rows, not just this effect's advisory namespace.
    const current = await readReturningInvoiceLineage(
      tx,
      review.organizationId,
      review.invoiceId,
      {
        actorUserId: review.actorUserId,
        effectiveRole: review.effectiveRole,
        lockRows: tx !== db,
        requireIssued: true,
      },
    );
    const selected = await readCompanyEmailSender(
      tx,
      review.organizationId,
      tx !== db,
    );
    const c = expected.context;
    if (
      current.invoice.version !== expected.invoiceVersion ||
      current.invoice.invoiceNumber !== c.invoiceNumber ||
      deliveryFingerprint(current.invoice.document) !==
        expected.documentSha256 ||
      current.root.id !== c.customerWorkId ||
      current.contact.id !== c.contactId ||
      (current.property?.id ?? null) !== c.propertyId ||
      current.sourceSha256 !== c.sourceSha256 ||
      current.contact.email?.trim().toLowerCase() !== c.recipient ||
      selected.identitySha256 !== c.senderIdentitySha256 ||
      deliveryFingerprint(selected.sender) !== deliveryFingerprint(c.sender)
    )
      fail("invoice_delivery_review_changed");
    await manager(
      tx,
      review.organizationId,
      review.actorUserId,
      review.effectiveRole,
    );
    assertOutboundDeliveryAllowed({ channel: "email", recipient: c.recipient });
    const gate = await checkSendEligibility(
      {
        organizationId: review.organizationId,
        leadId: null,
        contact: current.contact,
        channel: "email",
        kind: "transactional",
      },
      tx,
    );
    if (
      !gate.ok ||
      (await hasContactReplyHold(review.organizationId, c.contactId, tx))
    )
      fail("invoice_delivery_held");
    return;
  }
  // Reader-aware validation keeps final admission on the caller's one client.
  await readInvoiceDetail(
    tx,
    review.organizationId,
    review.actorUserId,
    review.invoiceId,
    { effectiveRole: review.effectiveRole, lockRows: tx !== db },
  );
  const [invoice] = await tx
    .select()
    .from(invoices)
    .where(
      and(
        eq(invoices.organizationId, review.organizationId),
        eq(invoices.id, review.invoiceId),
      ),
    );
  if (
    !invoice ||
    invoice.status !== "issued" ||
    invoice.version !== expected.invoiceVersion ||
    invoice.invoiceNumber !== expected.context.invoiceNumber ||
    invoice.leadId !== expected.context.leadId ||
    deliveryFingerprint(invoice.issuedDocument) !== expected.documentSha256
  )
    fail("invoice_delivery_review_changed");
  const customerQuery = tx
    .select({ id: contactsTable.id, email: contactsTable.email })
    .from(leadsTable)
    .innerJoin(
      contactsTable,
      and(
        eq(contactsTable.organizationId, review.organizationId),
        eq(contactsTable.id, leadsTable.contactId),
      ),
    )
    .where(
      and(
        eq(leadsTable.organizationId, review.organizationId),
        eq(leadsTable.id, expected.context.leadId),
      ),
    );
  const [customer] = await (tx === db
    ? customerQuery
    : customerQuery.for("share"));
  const [sender] = await tx
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(
      and(
        eq(usersTable.organizationId, review.organizationId),
        eq(usersTable.id, expected.context.sender.userId),
      ),
    );
  if (
    !customer ||
    customer.id !== expected.context.contactId ||
    customer.email?.trim().toLowerCase() !== expected.context.recipient ||
    !sender
  )
    fail("invoice_delivery_review_changed");
  await manager(
    tx,
    review.organizationId,
    review.actorUserId,
    review.effectiveRole,
  );
  if (
    !(await getCustomerLifecycleStatus(review.organizationId, tx))
      .automationAllowed
  )
    fail("invoice_delivery_held");
  assertOutboundDeliveryAllowed({
    channel: "email",
    recipient: expected.context.recipient,
  });
}

/** A single transaction owns both ledgers. No crash gap can mint another key. */
export async function runInvoiceDeliveryAttempt(
  review: InvoiceAttemptReview,
  execute: (claim: InvoiceAttemptClaim) => Promise<InvoiceAttemptOutcome>,
): Promise<InvoiceDeliveryChain> {
  if (
    review.duplicateCopyAcknowledged !==
    (review.intent === "additional_copy")
  )
    fail("invoice_delivery_copy_acknowledgement_required");
  const metadata = metadataOf(review),
    receiptFingerprint = fingerprint(
      review.invoiceId,
      review.previewId,
      review.payloadSha256,
    );
  const claim = await db.transaction(async (tx) => {
    await lock(tx, review.organizationId);
    await manager(
      tx,
      review.organizationId,
      review.actorUserId,
      review.effectiveRole,
    );
    const chain = await getInvoiceDeliveryChain(
      review.organizationId,
      review.invoiceId,
      tx,
    );
    if (chain.integrity !== "valid")
      fail("invoice_delivery_evidence_unavailable");
    const [existing] = await tx
      .select()
      .from(attempts)
      .where(
        and(
          eq(attempts.organizationId, review.organizationId),
          eq(attempts.previewId, review.previewId),
        ),
      );
    if (existing) {
      if (
        existing.invoiceId !== review.invoiceId ||
        existing.actorUserId !== review.actorUserId ||
        existing.executionFingerprint !== receiptFingerprint ||
        existing.reviewSha256 !== deliveryFingerprint(metadata)
      )
        fail("invoice_delivery_review_changed");
      return null;
    }
    await assertReview(tx, review, metadata);
    if (
      chain.latestExecutionId !== review.expectedLatestExecutionId ||
      !chain.nextIntents.includes(review.intent)
    )
      fail("invoice_delivery_head_changed");
    const ordinal = chain.attemptCount + 1,
      actionKey = key(review.invoiceId, ordinal),
      executionId = randomUUID(),
      attemptId = randomUUID();
    const previous = chain.attempts.at(-1);
    const [priorReceipt] = previous
      ? await tx
          .select()
          .from(executions)
          .where(
            and(
              eq(executions.organizationId, review.organizationId),
              eq(executions.id, previous.executionId),
            ),
          )
      : [];
    await tx.insert(executions).values({
      id: executionId,
      organizationId: review.organizationId,
      actionKey,
      kind: "invoice_email",
      fingerprint: receiptFingerprint,
      actorUserId: review.actorUserId,
      expiresAt: new Date(Date.now() + 15 * 60_000),
    });
    await tx.insert(events).values({
      organizationId: review.organizationId,
      executionId,
      state: "processing",
      detail: "Reviewed invoice email attempt ownership acquired.",
      actorUserId: review.actorUserId,
    });
    await tx.insert(attempts).values({
      id: attemptId,
      organizationId: review.organizationId,
      invoiceId: review.invoiceId,
      ordinal,
      intent: review.intent,
      duplicateCopyAcknowledged: review.duplicateCopyAcknowledged,
      executionId,
      actionKey,
      executionFingerprint: receiptFingerprint,
      actorUserId: review.actorUserId,
      previewId: review.previewId,
      payloadSha256: review.payloadSha256,
      documentSha256: review.documentSha256,
      invoiceVersion: review.invoiceVersion,
      reviewSha256: deliveryFingerprint(metadata),
      predecessorExecutionId: previous?.executionId ?? null,
      predecessorActionKey: previous?.actionKey ?? null,
      predecessorFingerprint: priorReceipt?.fingerprint ?? null,
      predecessorProofId: previous?.proofId ?? null,
    });
    return {
      organizationId: review.organizationId,
      invoiceId: review.invoiceId,
      attemptId,
      executionId,
      ordinal,
      actionKey,
      executionFingerprint: receiptFingerprint,
      actorUserId: review.actorUserId,
      previewId: review.previewId,
      payloadSha256: review.payloadSha256,
      effectiveRole: review.effectiveRole,
    } satisfies InvoiceAttemptClaim;
  });
  if (!claim)
    return getInvoiceDeliveryChain(review.organizationId, review.invoiceId);
  try {
    const outcome = await execute(claim);
    await finalize(claim, metadata, outcome);
  } catch {
    // Preparation, provider or final-receipt failure is never a typed refusal.
    await db.transaction(async (tx) => {
      const [row] = await tx
        .update(executions)
        .set({
          state: "indeterminate",
          completedAt: new Date(),
          detail:
            "Invoice email effect or its final receipt is uncertain. No automatic retry is authorized.",
        })
        .where(
          and(
            eq(executions.organizationId, claim.organizationId),
            eq(executions.id, claim.executionId),
            eq(executions.state, "processing"),
            eq(executions.fingerprint, claim.executionFingerprint),
          ),
        )
        .returning();
      if (row)
        await tx.insert(events).values({
          organizationId: claim.organizationId,
          executionId: claim.executionId,
          state: "indeterminate",
          detail:
            "Invoice email attempt requires evidence-backed review; ownership is retained.",
          actorUserId: claim.actorUserId,
        });
    });
  }
  return getInvoiceDeliveryChain(review.organizationId, review.invoiceId);
}

export async function assertInvoiceDeliveryAttemptDispatch(
  claim: InvoiceAttemptClaim,
): Promise<void> {
  try {
    await db.transaction(async (tx) => {
      await lock(tx, claim.organizationId);
      const chain = await getInvoiceDeliveryChain(
        claim.organizationId,
        claim.invoiceId,
        tx,
      );
      const [row] = await tx
        .select()
        .from(attempts)
        .where(
          and(
            eq(attempts.organizationId, claim.organizationId),
            eq(attempts.id, claim.attemptId),
          ),
        );
      const [receipt] = await tx
        .select()
        .from(executions)
        .where(
          and(
            eq(executions.organizationId, claim.organizationId),
            eq(executions.id, claim.executionId),
          ),
        );
      if (
        chain.integrity !== "valid" ||
        chain.latestExecutionId !== claim.executionId ||
        !row ||
        !receipt ||
        receipt.state !== "processing" ||
        receipt.expiresAt.getTime() <= Date.now() ||
        row.executionId !== claim.executionId ||
        row.invoiceId !== claim.invoiceId ||
        row.ordinal !== claim.ordinal ||
        row.actionKey !== claim.actionKey ||
        row.actorUserId !== claim.actorUserId ||
        row.previewId !== claim.previewId ||
        row.payloadSha256 !== claim.payloadSha256 ||
        row.executionFingerprint !== claim.executionFingerprint ||
        receipt.fingerprint !== claim.executionFingerprint ||
        receipt.actorUserId !== claim.actorUserId
      )
        fail("invoice_delivery_execution_changed");
      const [audit] = await tx
        .select()
        .from(audits)
        .where(
          and(
            eq(audits.organizationId, claim.organizationId),
            eq(audits.id, claim.previewId),
          ),
        );
      const metadata = invoiceAttemptReviewMetadataSchema.parse(
        audit?.metadata,
      );
      await assertReview(
        tx,
        {
          ...metadata,
          organizationId: claim.organizationId,
          invoiceId: claim.invoiceId,
          actorUserId: claim.actorUserId,
          previewId: claim.previewId,
          effectiveRole: claim.effectiveRole,
        },
        metadata,
      );
    });
  } catch {
    throw new EmailDispatchBlockedError();
  }
}

async function finalize(
  claim: InvoiceAttemptClaim,
  review: InvoiceAttemptReviewMetadata,
  outcome: InvoiceAttemptOutcome,
) {
  await db.transaction(async (tx) => {
    const [receipt] = await tx
      .select()
      .from(executions)
      .where(
        and(
          eq(executions.organizationId, claim.organizationId),
          eq(executions.id, claim.executionId),
        ),
      )
      .for("update");
    if (
      !receipt ||
      receipt.fingerprint !== claim.executionFingerprint ||
      receipt.actionKey !== claim.actionKey ||
      receipt.actorUserId !== claim.actorUserId
    )
      fail("invoice_delivery_execution_changed");
    // A late worker cannot override interruption/reconciliation; its original
    // receipt remains held. Mutable company/actor eligibility is not rechecked
    // after an actual provider effect.
    const ownsFinalization = receipt.state === "processing";
    if (!ownsFinalization && outcome.kind !== "accepted") return;
    const common = {
      proofVersion: 1,
      attemptId: claim.attemptId,
      executionId: claim.executionId,
      ordinal: claim.ordinal,
      actionKey: claim.actionKey,
      executionFingerprint: claim.executionFingerprint,
      invoiceId: claim.invoiceId,
      previewId: claim.previewId,
      payloadSha256: claim.payloadSha256,
      documentSha256: review.documentSha256,
    };
    let state: "blocked" | "succeeded", detail: string;
    if (outcome.kind === "not_dispatched") {
      if (
        !["review_changed_before_dispatch", "dispatch_guard_rejected"].includes(
          outcome.code,
        )
      )
        fail("invoice_delivery_invalid_refusal");
      state = "blocked";
      detail =
        "Server dispatch guard refused this exact attempt before provider POST; a separately reviewed retry may be prepared.";
      await tx.insert(audits).values({
        organizationId: claim.organizationId,
        actorUserId: claim.actorUserId,
        action: REFUSED,
        entityType: "invoice",
        entityId: claim.invoiceId,
        metadata: { ...common, phase: "pre_provider", code: outcome.code },
      });
    } else if (outcome.kind === "accepted") {
      const e = outcome.evidence,
        c = review.context;
      if (
        !acceptedValid(e) ||
        e.invoiceId !== claim.invoiceId ||
        e.previewId !== claim.previewId ||
        e.payloadSha256 !== claim.payloadSha256 ||
        e.documentSha256 !== review.documentSha256 ||
        e.invoiceNumber !== c.invoiceNumber ||
        outcome.leadId !== c.leadId ||
        outcome.contactId !== c.contactId ||
        e.senderUserId !== c.sender.userId ||
        e.senderEmail !== c.sender.senderEmail ||
        e.provider !== c.sender.provider
      )
        fail("invoice_delivery_invalid_acceptance");
      if (
        review.reviewVersion === 3 &&
        (outcome.customerWorkId !== review.context.customerWorkId ||
          outcome.propertyId !== review.context.propertyId ||
          e.customerWorkId !== review.context.customerWorkId ||
          e.propertyId !== review.context.propertyId ||
          e.recipient !== review.context.recipient ||
          e.sourceSha256 !== review.context.sourceSha256 ||
          e.senderIdentitySha256 !== review.context.senderIdentitySha256)
      )
        fail("invoice_delivery_invalid_acceptance");
      state = "succeeded";
      detail =
        "The selected provider accepted this invoice attempt; inbox delivery and payment remain unconfirmed.";
      const evidence = {
        ...e,
        ...common,
        leadId: c.leadId,
        contactId: c.contactId,
        ...(review.reviewVersion === 3
          ? {
              customerWorkId: review.context.customerWorkId,
              propertyId: review.context.propertyId,
              recipient: review.context.recipient,
              sourceSha256: review.context.sourceSha256,
              senderIdentitySha256: review.context.senderIdentitySha256,
            }
          : {}),
      };
      await tx.insert(audits).values({
        organizationId: claim.organizationId,
        actorUserId: claim.actorUserId,
        action: ACCEPTED,
        entityType: "invoice",
        entityId: claim.invoiceId,
        metadata: evidence,
      });
      await tx.insert(activitiesTable).values({
        organizationId: claim.organizationId,
        actorUserId: claim.actorUserId,
        leadId: c.leadId,
        contactId: c.contactId,
        type: "email_sent",
        title: `Invoice ${c.invoiceNumber} accepted by email provider`,
        metadata: evidence,
      });
    } else fail("invoice_delivery_invalid_outcome");
    if (ownsFinalization) {
      const changed = await tx
        .update(executions)
        .set({ state, detail, completedAt: new Date() })
        .where(
          and(
            eq(executions.id, receipt.id),
            eq(executions.organizationId, claim.organizationId),
            eq(executions.state, "processing"),
            eq(executions.fingerprint, claim.executionFingerprint),
          ),
        )
        .returning({ id: executions.id });
      // Even an unexpected CAS miss must roll back proof and email_sent rows.
      if (changed.length !== 1) fail("invoice_delivery_finalization_changed");
    }
    await tx.insert(events).values({
      organizationId: claim.organizationId,
      executionId: receipt.id,
      state: ownsFinalization ? state : receipt.state,
      detail: ownsFinalization
        ? detail
        : "Late provider acceptance recorded without replacing the held or reconciled execution; no new send is authorized.",
      actorUserId: claim.actorUserId,
    });
  });
}
