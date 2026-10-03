import type {
  InvoiceAttempt,
  InvoiceEmailEvidence,
} from "@/lib/invoice-delivery-ui";
import { invoiceId } from "./invoice-fixtures";

export function sampleDelivery(
  overrides: Partial<InvoiceEmailEvidence> = {},
): InvoiceEmailEvidence {
  return {
    invoiceId,
    state: "not_sent",
    executionId: null,
    detail: "No invoice email has been sent through this flow.",
    provider: null,
    providerMessageId: null,
    providerRequestId: null,
    acceptedAt: null,
    deliveryConfirmed: false,
    deliveryDetail:
      "Acceptance is not inbox delivery. Delivery/bounce monitoring is not connected.",
    canPrepare: true,
    attemptCount: 0,
    maxAttempts: 5,
    latestExecutionId: null,
    nextIntents: ["initial"],
    attentionReason: null,
    integrity: "valid",
    attempts: [],
    ...overrides,
  };
}
export function sampleAttempt(
  overrides: Partial<InvoiceAttempt> = {},
): InvoiceAttempt {
  return {
    attemptId: "attempt-a",
    legacy: false,
    ordinal: 1,
    executionId: "execution-a",
    actionKey: `invoice-delivery:${invoiceId}`,
    intent: "initial",
    state: "succeeded",
    detail: "Provider accepted this email; inbox delivery is not confirmed.",
    proof: "provider_accepted",
    proofId: "proof-a",
    createdAt: "2026-10-02T12:29:00Z",
    completedAt: "2026-10-02T12:30:00Z",
    provider: "microsoft",
    providerMessageId: null,
    providerRequestId: "request-only",
    acceptedAt: "2026-10-02T12:30:00Z",
    ...overrides,
  };
}
export function sampleAcceptedDelivery(
  overrides: Partial<InvoiceEmailEvidence> = {},
): InvoiceEmailEvidence {
  const attempt = sampleAttempt();
  return sampleDelivery({
    state: "accepted",
    canPrepare: false,
    provider: attempt.provider,
    providerRequestId: attempt.providerRequestId,
    acceptedAt: attempt.acceptedAt,
    executionId: attempt.executionId,
    latestExecutionId: attempt.executionId,
    attempts: [attempt],
    attemptCount: 1,
    nextIntents: ["additional_copy"],
    ...overrides,
  });
}
