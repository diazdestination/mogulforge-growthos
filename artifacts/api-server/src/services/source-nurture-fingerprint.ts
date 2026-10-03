import { sourceFingerprint } from "./source-adoption-contract";
import type { sourceNurturePlansTable, sourceNurtureItemsTable, sourceNurtureStepsTable } from "../../../../lib/db/src/schema/source-nurture";
type Plan = typeof sourceNurturePlansTable.$inferSelect;
type Item = typeof sourceNurtureItemsTable.$inferSelect;
type Step = typeof sourceNurtureStepsTable.$inferSelect;
/** Immutable authority only: execution/state changes never rewrite a review. */
export function nurturePlanFingerprint(plan: Pick<Plan, "id" | "organizationId" | "settings" | "reviewId" | "createdByUserId" | "createdAt" | "previewExpiresAt" | "startNotBefore" | "expiresAt">,
  items: Pick<Item, "id" | "leadId" | "contactId" | "propertyId" | "ownerUserId" | "adoptionId" | "recipient" | "snapshot">[],
  steps: Pick<Step, "id" | "itemId" | "stepIndex" | "predecessorId" | "subject" | "body" | "messageHash" | "expiresAt">[]) {
  return sourceFingerprint({ version: 1, id: plan.id, organizationId: plan.organizationId, settings: plan.settings, reviewId: plan.reviewId,
    createdByUserId: plan.createdByUserId, createdAt: plan.createdAt, previewExpiresAt: plan.previewExpiresAt, startNotBefore: plan.startNotBefore, expiresAt: plan.expiresAt,
    items: [...items].sort((a, b) => a.id.localeCompare(b.id)).map(({ id, leadId, contactId, propertyId, ownerUserId, adoptionId, recipient, snapshot }) => ({ id, leadId, contactId, propertyId, ownerUserId, adoptionId, recipient, snapshot })),
    steps: [...steps].sort((a, b) => a.id.localeCompare(b.id)).map(({ id, itemId, stepIndex, predecessorId, subject, body, messageHash, expiresAt }) => ({ id, itemId, stepIndex, predecessorId, subject, body, messageHash, expiresAt })),
  });
}
