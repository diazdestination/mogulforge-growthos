import { z } from "zod/v4";

export const invoiceDeliveryIntentSchema = z.enum([
  "initial",
  "retry_not_dispatched",
  "additional_copy",
]);
export type InvoiceDeliveryIntent = z.infer<typeof invoiceDeliveryIntentSchema>;
export const invoiceAttemptSchema = z.object({
  attemptId: z.string().nullable(),
  legacy: z.boolean(),
  ordinal: z.number().int().min(1).max(5),
  executionId: z.string(),
  actionKey: z.string(),
  intent: invoiceDeliveryIntentSchema,
  state: z.enum([
    "processing",
    "succeeded",
    "blocked",
    "indeterminate",
    "confirmed_succeeded",
    "confirmed_not_performed",
  ]),
  detail: z.string(),
  proof: z.enum(["not_dispatched", "provider_accepted", "none"]),
  proofId: z.string().nullable(),
  createdAt: z.iso.datetime(),
  completedAt: z.iso.datetime().nullable(),
  provider: z.enum(["gmail", "microsoft"]).nullable(),
  providerMessageId: z.string().nullable(),
  providerRequestId: z.string().nullable(),
  acceptedAt: z.iso.datetime().nullable(),
});
export type InvoiceAttempt = z.infer<typeof invoiceAttemptSchema>;
export const invoiceChainSummarySchema = z.object({
  attemptCount: z.number().int().nonnegative(),
  maxAttempts: z.literal(5),
  latestExecutionId: z.string().nullable(),
  nextIntents: z.array(invoiceDeliveryIntentSchema).max(1),
  attentionReason: z.string().nullable(),
  integrity: z.enum(["valid", "unavailable"]),
});
export const invoiceEmailEvidenceSchema = invoiceChainSummarySchema.extend({
  invoiceId: z.string(),
  state: z.enum([
    "not_sent",
    "processing",
    "accepted",
    "held",
    "uncertain",
    "reconciled",
  ]),
  executionId: z.string().nullable(),
  detail: z.string(),
  provider: z.enum(["gmail", "microsoft"]).nullable(),
  providerMessageId: z.string().nullable(),
  providerRequestId: z.string().nullable(),
  acceptedAt: z.iso.datetime().nullable(),
  deliveryConfirmed: z.literal(false),
  deliveryDetail: z.string(),
  canPrepare: z.boolean(),
  attempts: z.array(invoiceAttemptSchema).max(5),
});
export type InvoiceEmailEvidence = z.infer<typeof invoiceEmailEvidenceSchema>;
export const invoiceEmailPreviewSchema = z.object({
  previewId: z.uuid(),
  payloadSha256: z.string().regex(/^[a-f0-9]{64}$/),
  expiresAt: z.iso.datetime(),
  invoiceId: z.string(),
  invoiceVersion: z.number().int().positive(),
  recipient: z.email(),
  sender: z.object({
    userId: z.string(),
    source: z.enum(["lead_assignee", "company_default"]),
    provider: z.enum(["gmail", "microsoft"]),
    senderEmail: z.email(),
  }),
  subject: z.string(),
  body: z.string(),
  intent: invoiceDeliveryIntentSchema,
  expectedLatestExecutionId: z.string().nullable(),
  reason: z.string().nullable(),
  prospectiveAttemptNumber: z.number().int().min(1).max(5),
  maxAttempts: z.literal(5),
});
export type InvoiceEmailPreview = z.infer<typeof invoiceEmailPreviewSchema>;
export const invoiceDeliveryWorklistSchema = z.object({
  items: z
    .array(
      z.object({
        invoiceId: z.string(),
        invoiceNumber: z.string().nullable(),
        title: z.string(),
        customerName: z.string(),
        status: z.enum(["draft", "issued", "void"]),
        version: z.number().int().positive(),
        leadId: z.string(),
        projectId: z.string().nullable(),
        delivery: invoiceChainSummarySchema.extend({
          latestAttempt: invoiceAttemptSchema.nullable(),
        }),
      }),
    )
    .max(25),
  total: z.number().int().nonnegative(),
  page: z.number().int().nonnegative(),
  pageSize: z.literal(25),
  boundary: z.string(),
});
export const invoiceDeliveryLabels: Record<
  InvoiceEmailEvidence["state"],
  string
> = {
  not_sent: "Not sent",
  processing: "Send in progress",
  accepted: "Provider accepted — delivery unconfirmed",
  held: "Held — review required",
  uncertain: "Uncertain — check the original mailbox",
  reconciled: "Operator reconciliation recorded — no retry",
};
export const reviewLabel = (intent: InvoiceDeliveryIntent) =>
  ({
    initial: "Preview invoice email",
    retry_not_dispatched: "Review a safe retry",
    additional_copy: "Review another copy",
  })[intent];
export const attemptIntentLabel = (intent: InvoiceDeliveryIntent) =>
  ({
    initial: "Original email",
    retry_not_dispatched: "Reviewed safe retry",
    additional_copy: "Reviewed additional copy",
  })[intent];
export function invoiceDeliveryBlocker(reason: string | null) {
  if (!reason) return null;
  return (
    (
      {
        invoice_not_issued:
          "Only a currently issued, non-void invoice can be emailed.",
        attempt_limit_reached:
          "The limit of five lifetime email attempts has been reached. No new send is available here.",
        chain_evidence_unavailable:
          "The saved delivery evidence could not be verified. Ask an administrator to investigate; do not send another copy.",
        legacy_review_identity_unavailable:
          "This earlier attempt does not contain the complete frozen review identity needed for another send. Its history remains available; check the original mailbox and ask an administrator to review it.",
        send_processing:
          "A send is still in progress. Check delivery status before taking another action.",
        reconciliation_is_not_send_proof:
          "An operator recorded a reconciliation. That does not prove a safe retry or authorize another copy.",
        no_typed_no_dispatch_proof:
          "There is no verified proof that this attempt stopped before dispatch. Check the original mailbox; no retry is available.",
        effect_requires_review:
          "The previous email result is uncertain. Check the original mailbox and saved receipt evidence; do not send another copy.",
      } as Record<string, string>
    )[reason] ??
    "Delivery needs review. Check the original mailbox and saved evidence before taking further action."
  );
}
export function attemptLabel(
  attempt: InvoiceAttempt | null,
  integrity = "valid",
) {
  if (integrity !== "valid")
    return "Delivery evidence unavailable — review required";
  if (!attempt) return "Not sent";
  if (attempt.state === "processing") return invoiceDeliveryLabels.processing;
  if (
    attempt.state === "confirmed_succeeded" ||
    attempt.state === "confirmed_not_performed"
  )
    return invoiceDeliveryLabels.reconciled;
  if (attempt.state === "succeeded" && attempt.proof === "provider_accepted")
    return invoiceDeliveryLabels.accepted;
  if (attempt.state === "blocked" && attempt.proof === "not_dispatched")
    return "Verified not dispatched — a fresh review is required";
  if (attempt.state === "blocked") return invoiceDeliveryLabels.held;
  return invoiceDeliveryLabels.uncertain;
}
