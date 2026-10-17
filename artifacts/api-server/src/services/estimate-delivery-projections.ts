import { z } from "zod/v4";
import {
  revenueExecutionsTable,
  revenueExecutionEventsTable,
  type AuditEvent,
} from "@workspace/db";
import {
  estimateDeliveryFingerprint,
  estimateEmailReviewMetadataSchema,
  estimateEmailEvidenceSchema,
  ESTIMATE_EMAIL_REVIEW_ACTION,
  ESTIMATE_EMAIL_PREVIEW_MS,
  type EstimateEmailEvidence,
  type EstimateEmailSnapshot,
} from "./estimate-delivery-contract";
import {
  estimateEmailActionKey,
  estimateEmailAdmissionMetadataSchema,
  estimateEmailProofMetadataSchema,
  ESTIMATE_EMAIL_ADMISSION_ACTION,
  ESTIMATE_EMAIL_PROOF_ACTION,
} from "./estimate-delivery-execution";
import { estimateSavedStateSchema } from "./estimate-delivery-history";
import { emailAcceptanceEvidence } from "./user-email";
export type RevenueExecution = typeof revenueExecutionsTable.$inferSelect;
export type RevenueExecutionEvent =
  typeof revenueExecutionEventsTable.$inferSelect;
export type EstimateEmailRetainedLedger = {
  org: string;
  id: string;
  executions: RevenueExecution[];
  audits: AuditEvent[];
  linkedAudits: AuditEvent[];
  review: AuditEvent | undefined;
  events: RevenueExecutionEvent[];
  participants: { id: string; org: string | null }[];
};
function parse<T>(schema: z.ZodType<T>, raw: unknown): T {
  return schema.parse(raw);
}
const baseEvidence = (id: string): EstimateEmailEvidence => ({
  estimateId: id,
  integrity: "valid",
  state: "not_sent",
  executionId: null,
  canPrepare: false,
  detail: "No provider acceptance has been retained.",
  document: null,
  message: null,
  provider: null,
  providerMessageId: null,
  providerRequestId: null,
  acceptedAt: null,
  deliveryConfirmed: false,
});
const unavailable = (id: string): EstimateEmailEvidence => ({
  ...baseEvidence(id),
  integrity: "unavailable",
  state: "held",
  detail:
    "Retained estimate delivery evidence is unavailable or inconsistent. Office verification is required.",
});
function auditMatches(a: AuditEvent, s: EstimateEmailSnapshot, action: string) {
  return (
    a.organizationId === s.organizationId &&
    a.entityType === "estimate" &&
    a.entityId === s.estimateId &&
    a.actorUserId === s.actorUserId &&
    a.action === action
  );
}
const states = [
  "processing",
  "succeeded",
  "blocked",
  "indeterminate",
  "confirmed_succeeded",
  "confirmed_not_performed",
];
/** Pure validation of the entire retained ledger. No current customer/quote joins. */
export function projectEstimateEmailRetainedEvidence(
  ledger: EstimateEmailRetainedLedger,
): EstimateEmailEvidence {
  const {
    org,
    id,
    executions,
    audits,
    linkedAudits,
    review,
    events,
    participants,
  } = ledger;
  const key = estimateEmailActionKey(id);
  try {
    if (executions.length !== 1) return unavailable(id);
    const execution = executions[0],
      admissions = audits.filter(
        (a) => a.action === ESTIMATE_EMAIL_ADMISSION_ACTION,
      ),
      proofs = audits.filter((a) => a.action === ESTIMATE_EMAIL_PROOF_ACTION);
    if (admissions.length !== 1 || proofs.length > 1) return unavailable(id);
    const admission = parse(
        estimateEmailAdmissionMetadataSchema,
        admissions[0].metadata,
      ),
      s = admission.snapshot;
    if (
      !auditMatches(admissions[0], s, ESTIMATE_EMAIL_ADMISSION_ACTION) ||
      s.organizationId !== org ||
      s.estimateId !== id ||
      admission.actor.userId !== s.actorUserId ||
      execution.organizationId !== org ||
      execution.id !== admission.executionId ||
      execution.kind !== "estimate_email" ||
      !states.includes(execution.state) ||
      execution.actorUserId !== s.actorUserId ||
      execution.actionKey !== key ||
      admission.actionKey !== key ||
      execution.fingerprint !== admission.payloadSha256 ||
      estimateDeliveryFingerprint(s) !== admission.payloadSha256
    )
      return unavailable(id);
    // Execution-id links cannot hide additional audits behind a tampered target/key.
    if (
      linkedAudits.length !== audits.length ||
      linkedAudits.some((a) => !audits.some((b) => b.id === a.id))
    )
      return unavailable(id);
    if (
      !review ||
      review.id !== admission.previewId ||
      !auditMatches(review, s, ESTIMATE_EMAIL_REVIEW_ACTION)
    )
      return unavailable(id);
    const reviewData = parse(
      estimateEmailReviewMetadataSchema,
      review.metadata,
    );
    if (
      reviewData.payloadSha256 !== admission.payloadSha256 ||
      estimateDeliveryFingerprint(reviewData.snapshot) !==
        admission.payloadSha256 ||
      Date.parse(reviewData.expiresAt) !==
        review.createdAt.getTime() + ESTIMATE_EMAIL_PREVIEW_MS
    )
      return unavailable(id);
    if (
      !events.some(
        (e) =>
          e.state === "processing" &&
          e.actorUserId === s.actorUserId &&
          e.detail === "Estimate email admitted.",
      )
    )
      return unavailable(id);
    for (const event of events) {
      if (
        event.organizationId !== org ||
        event.executionId !== execution.id ||
        !states.includes(event.state)
      )
        return unavailable(id);
      if (event.actorUserId) {
        const member = participants.find((p) => p.id === event.actorUserId);
        if (member?.org !== org) return unavailable(id);
      }
    }
    if (
      !participants.some((p) => p.id === s.actorUserId && p.org === org) ||
      !participants.some((p) => p.id === s.sender.userId && p.org === org)
    )
      return unavailable(id);
    let acceptedAt: string | null = null,
      providerMessageId: string | null = null,
      providerRequestId: string | null = null;
    if (proofs.length) {
      const proof = parse(estimateEmailProofMetadataSchema, proofs[0].metadata),
        { receipt, acceptedAt: at, ...link } = proof;
      if (
        !auditMatches(proofs[0], s, ESTIMATE_EMAIL_PROOF_ACTION) ||
        estimateDeliveryFingerprint(link) !==
          estimateDeliveryFingerprint(admission) ||
        receipt.provider !== s.sender.provider ||
        receipt.senderEmail !== s.sender.senderEmail ||
        (receipt.provider === "gmail" && receipt.id === null)
      )
        return unavailable(id);
      const safe = emailAcceptanceEvidence(receipt);
      acceptedAt = at;
      providerMessageId = safe.providerMessageId;
      providerRequestId = receipt.providerRequestId ?? null;
    }
    let state: EstimateEmailEvidence["state"] = execution.state.startsWith(
      "confirmed_",
    )
      ? "reconciled"
      : execution.state === "blocked"
        ? "held"
        : execution.state === "indeterminate" ||
            (execution.state === "processing" &&
              execution.expiresAt.getTime() <= Date.now())
          ? "uncertain"
          : execution.state === "succeeded"
            ? acceptedAt
              ? "accepted"
              : "uncertain"
            : "processing";
    // A reverted processing row with terminal events cannot regain dispatch permission.
    if (state === "processing" && events.some((e) => e.state !== "processing"))
      state = "uncertain";
    const detail = acceptedAt
      ? `Provider accepted the original reviewed email from ${s.sender.senderEmail}. Inbox delivery and customer acceptance are unconfirmed.`
      : `Original ${s.sender.provider} mailbox: ${s.sender.senderEmail}. ${state === "processing" ? "Delivery is processing." : "Verify its sent mail and retained evidence; do not resend."}`;
    return parse(estimateEmailEvidenceSchema, {
      ...baseEvidence(id),
      state,
      executionId: execution.id,
      detail,
      document: s.document,
      message: s.message,
      provider: s.sender.provider,
      providerMessageId,
      providerRequestId,
      acceptedAt,
    });
  } catch {
    return unavailable(id);
  }
}
export type EstimateEmailExecutionSummary = Pick<
  RevenueExecution,
  "id" | "kind" | "state" | "detail" | "expiresAt" | "createdAt"
>;
const safeDetail = (state: string) =>
  state.startsWith("confirmed_")
    ? "Operator reconciliation recorded. Provider acceptance and delivery are not inferred."
    : state === "succeeded"
      ? "Estimate email result retained. Inspect the original receipt; inbox delivery is unconfirmed."
      : state === "processing"
        ? "Estimate email admitted for processing."
        : state === "blocked"
          ? "Estimate email held. Original ownership is retained; do not resend."
          : "Estimate email outcome requires office verification; do not resend.";
export function projectEstimateDeliveryExecution(
  execution: RevenueExecution,
): RevenueExecution | EstimateEmailExecutionSummary {
  if (execution.kind !== "estimate_email") return execution;
  const { id, kind, state, expiresAt, createdAt } = execution;
  return { id, kind, state, detail: safeDetail(state), expiresAt, createdAt };
}
export function projectEstimateDeliveryEvent(event: RevenueExecutionEvent) {
  const { id, executionId, state, createdAt } = event;
  return { id, executionId, state, detail: safeDetail(state), createdAt };
}
export function projectEstimateDeliveryAudit(
  event: AuditEvent,
): AuditEvent | null {
  if (event.action === ESTIMATE_EMAIL_REVIEW_ACTION) return null;
  if (
    event.action !== "estimate.saved_state" &&
    !event.action.startsWith("estimate_delivery.")
  )
    return event;
  let metadata: Record<string, unknown> = { integrity: "unavailable" };
  if (event.action === "estimate.saved_state") {
    const m = estimateSavedStateSchema.safeParse(event.metadata);
    if (m.success)
      metadata = {
        status: m.data.status,
        sentAt: m.data.sentAt,
        acceptedAt: m.data.acceptedAt,
      };
  } else {
    const m = (
      event.action === ESTIMATE_EMAIL_PROOF_ACTION
        ? estimateEmailProofMetadataSchema
        : estimateEmailAdmissionMetadataSchema
    ).safeParse(event.metadata);
    if (m.success)
      metadata = {
        estimateId: m.data.snapshot.estimateId,
        provider: m.data.snapshot.sender.provider,
        deliveryConfirmed: false,
      };
  }
  // Retain the legacy audit row shape, but never expose private actor identity.
  return {
    id: event.id,
    organizationId: event.organizationId,
    action: event.action,
    entityType: event.entityType,
    entityId: event.entityId,
    createdAt: event.createdAt,
    actorUserId: null,
    metadata,
  };
}
export type EstimateEmailBusinessExport = Omit<
  EstimateEmailEvidence,
  "canPrepare" | "detail"
> & {
  leadId: string | null;
  customerWorkId: string | null;
  contactId: string;
  propertyId: string | null;
};
/** The complete same-snapshot ledger is the sole authoritative projection input. */
export function projectEstimateEmailExport(
  ledger: EstimateEmailRetainedLedger,
): EstimateEmailBusinessExport | null {
  const admission = estimateEmailAdmissionMetadataSchema.safeParse(
    ledger.audits.find((a) => a.action === ESTIMATE_EMAIL_ADMISSION_ACTION)
      ?.metadata,
  );
  if (!admission.success) return null;
  const evidence = projectEstimateEmailRetainedEvidence(ledger);
  if (evidence.integrity !== "valid" || !evidence.document || !evidence.message)
    return null;
  const { canPrepare: _can, detail: _detail, ...safe } = evidence;
  const { leadId, customerWorkId, contactId, propertyId } =
    admission.data.snapshot;
  return { ...safe, leadId, customerWorkId, contactId, propertyId };
}
