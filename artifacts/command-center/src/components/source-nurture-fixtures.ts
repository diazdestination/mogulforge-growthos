import type { NurtureDetail, NurtureList } from "./source-nurture-types";

/** Synthetic examples only; reusable by focused contract/interaction tests. */
export const nurtureId = (number: number) => `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
export function nurtureFixture(extra: Partial<NurtureDetail> = {}): NurtureDetail {
  const now = new Date().toISOString(), later = new Date(Date.now() + 7 * 86_400_000).toISOString(), hash = "a".repeat(64);
  return {
    organizationId: nurtureId(1), id: nurtureId(2), version: 1, state: "draft", payloadSha256: hash,
    settings: { businessName: "Synthetic Contractor", mailingAddress: "10 Fixture Road, Example, GA 30301", steps: [{ subject: "Still need help?", body: "Our office can help review your original request." }, { subject: "One final check-in", body: "Please contact our office if you still need assistance." }], timezone: "America/New_York", days: ["Mon", "Tue"], startHour: 9, endHour: 18, dailyLimit: 10 },
    reviewId: nurtureId(3), createdByUserId: "owner-one", approvedByUserId: null, createdAt: now, previewExpiresAt: new Date(Date.now() + 600_000).toISOString(), startNotBefore: now, expiresAt: later, approvedAt: null, startedAt: null, stoppedAt: null, stopReason: null,
    readiness: { ready: false, reason: "environment_outbound_hold", nextCheckAt: null }, limits: { maxRecipients: 10, steps: 2, minSpacingHours: 72, maxLifetimeDays: 14 },
    items: [{ id: nurtureId(4), leadId: nurtureId(5), contactId: nurtureId(6), propertyId: null, ownerUserId: "office-one", recipient: "customer@example.invalid",
      snapshot: { version: 1, adoptionId: nurtureId(7), adoptionVersion: 1, adoptionSha256: hash, adoption: { leadId: nurtureId(5), contactId: nurtureId(6), importSourceKey: "synthetic-export", externalOpportunityId: "opportunity-1", importedHistory: { version: 1, kind: "csv_snapshot", originalCreatedAt: null, sourceUpdatedAt: now, statusChangedAt: null, lastContactAt: null, snapshotAsOf: now, firstImportedAt: now, lastImportedAt: now, externalCustomerId: "customer-1", externalEstimateId: null, currency: null, fingerprint: hash, appliedFingerprint: hash, mappedFields: [] }, sourceSha256: hash, operationalSha256: hash, recipient: "customer@example.invalid" }, permissionRecordId: nurtureId(8), ownerUserId: "office-one", propertyId: null, leadCreatedAt: now,
        sender: { userId: "owner-one", source: "company_default", provider: "microsoft", senderEmail: "office@example.invalid" }, mailboxIdentity: { organizationId: nurtureId(1), senderUserId: "owner-one", provider: "microsoft", connectionId: nurtureId(9), connectionRevision: now, mailboxAccountId: "synthetic-reader", mailboxEmail: "office@example.invalid", connectorId: nurtureId(10), connectorVersion: 2, policyVersion: 1, startedAt: now }, nurtureMonitoringApproval: { version: 3, approvedAt: now } },
      admittedAt: null, stoppedAt: null, stopReason: null, readiness: { ready: false, reason: "environment_outbound_hold", nextCheckAt: null }, mailboxSync: { ready: false, reason: "mailbox_scan_incomplete", completedCycleId: null, startedAt: null, completedAt: null },
      steps: ([1, 2] as const).map(stepIndex => ({ id: nurtureId(10 + stepIndex), stepIndex, subject: `Exact email ${stepIndex}`, body: `Synthetic Contractor\nExact message ${stepIndex} for this customer.\n10 Fixture Road, Example, GA 30301\nUnsubscribe: https://example.invalid/unsubscribe/frozen-${stepIndex}`, messageHash: hash, scheduledActionId: null, notBefore: null, expiresAt: later, claimedAt: null, acceptedAt: null, state: "not_started", reason: null, executionId: null, executionState: null, parentId: null, observedAt: null, dispatchStartedAt: null, deliveryConfirmed: false })),
      outcomes: { leadStatus: "lost", replyIds: [], taskIds: [], appointmentIds: [] },
    }], ...extra,
  };
}
export function nurtureListFixture(detail = nurtureFixture(), extra: Partial<NurtureList> = {}): NurtureList {
  return { organizationId: detail.organizationId, bucket: "attention", offset: 0, limit: 25, hasMore: false, items: [{ id: detail.id, version: detail.version, state: detail.state, payloadSha256: detail.payloadSha256, createdAt: detail.createdAt, expiresAt: detail.expiresAt, recipientCount: detail.items.length, acceptedSteps: detail.items.flatMap(item => item.steps).filter(step => step.state === "accepted").length, uncertainSteps: detail.items.flatMap(item => item.steps).filter(step => step.state === "uncertain").length, reason: detail.readiness.reason, nextCheckAt: detail.readiness.nextCheckAt }], ...extra };
}
