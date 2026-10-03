import { db } from "@workspace/db";
import { readServiceCareAuthorization } from "./service-care-authorization";
import { checkOutreachTiming } from "./send-gate";
import { standingCompanyProjection } from "./service-standing-policy";

export class ServiceClaimDeferredError extends Error {
  constructor(readonly resumeAt: Date) { super("Service contact allowance is reserved by other work."); }
}
/** Called only within the durable-claim transaction after lifecycle/schedule locks. */
export async function checkServiceClaimBudget(tx: Parameters<Parameters<typeof db.transaction>[0]>[0], org: string, approvalId: string, scheduledActionId: string) {
  const claim = await readServiceCareAuthorization(tx, org, approvalId, scheduledActionId);
  const { hours } = await standingCompanyProjection(tx, org);
  const timing = await checkOutreachTiming({ organizationId: org, contact: claim.contact, sendingHours: hours, serviceCareActionKey: `scheduled:${scheduledActionId}` }, tx);
  if (!timing.ok && timing.outcome === "deferred") {
    const authority = claim.approval.authorization;
    // Expired authority proceeds to an owned BLOCKED receipt, never a delayed send.
    if (authority?.origin !== "standing" || timing.resumeAt.getTime() < Date.parse(authority.expiresAt)) throw new ServiceClaimDeferredError(timing.resumeAt);
  }
}
