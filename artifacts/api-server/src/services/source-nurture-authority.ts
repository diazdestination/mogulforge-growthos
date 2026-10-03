import { and, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { activitiesTable, appointmentsTable, auditEventsTable, contactsTable, db, leadsTable, organizationsTable, orgSettingsTable, propertiesTable, revenueExecutionsTable, scheduledActionsTable, usersTable } from "@workspace/db";
import { sourceNurturePlansTable as plans, sourceNurtureItemsTable as items, sourceNurtureStepsTable as steps, type SourceNurtureItemSnapshot } from "../../../../lib/db/src/schema/source-nurture";
import { mailboxCommunicationParentsTable as parents } from "../../../../lib/db/src/schema/mailbox-communication";
import { sourceAdoptionsTable, sourceOutreachItemsTable } from "../../../../lib/db/src/schema/source-adoption";
import { contactTouchReservationsTable as touches } from "../../../../lib/db/src/schema/contact-touch-reservations";
import { hasPermission } from "../lib/permissions";
import { activeSourceDecision, sourceContactReplyHeld, sourceEmailPermission, sourceManager } from "./source-adoption-state";
import { sourceFingerprint } from "./source-adoption-contract";
import { acquireNurtureLocks, assertSourceSlotAvailable, type NurtureTx } from "./source-outreach-ownership";
import { nurturePlanFingerprint } from "./source-nurture-fingerprint";
import { NURTURE_LIFETIME_MS, NURTURE_SPACING_MS, nurtureDeny, sourceNurtureItemSnapshotSchema, sourceNurtureSettingsSchema } from "./source-nurture-contract";
import { resolveEntitlements } from "./entitlements";
import { getCustomerLifecycleStatus } from "./customer-lifecycle";
import { assertOutboundDeliveryAllowed } from "./outbound-hold";
import { checkSendEligibility, isWithinWindow, nextAllowedSendTime, unsubscribeFooter } from "./send-gate";
import { assertContactTouchCurrent, contactTouchHours, type ContactTouchClaim } from "./contact-touch-claim";
import { verifyNurtureHttpAcceptance } from "./source-nurture-acceptance";

export { acquireNurtureLocks };
export type NurtureReader = typeof db | NurtureTx;
export type NurturePlan = typeof plans.$inferSelect;
export type NurtureItem = typeof items.$inferSelect;
export type NurtureStep = typeof steps.$inferSelect;
export const nurtureMessage = (org: string, contactId: string, settings: NurturePlan["settings"], stepIndex: 1 | 2) => ({
  subject: settings.steps[stepIndex - 1]!.subject,
  body: `${settings.steps[stepIndex - 1]!.body}\n\nPromotional email from ${settings.businessName}\n${settings.mailingAddress}${unsubscribeFooter(org, contactId)}`,
});
export class NurtureDeferredError extends Error {
  constructor(readonly reason: string, readonly resumeAt: Date) { super(reason); }
}
export async function nurtureActor(reader: Pick<typeof db, "select">, org: string, actor: string, requireCapability = true) {
  const user = await sourceManager(org, actor, reader);
  if (requireCapability) {
    const [company] = await reader.select().from(organizationsTable).where(eq(organizationsTable.id, org));
    if (!company || !resolveEntitlements(company).capabilities["revenue.autopilot"].allowed) nurtureDeny("nurture_capability_required", 403);
    if (!(await getCustomerLifecycleStatus(org, reader)).automationAllowed) nurtureDeny("customer_lifecycle_paused", 423);
  }
  return user;
}
export async function readNurturePlan(reader: Pick<typeof db, "select">, org: string, planId: string) {
  const [plan] = await reader.select().from(plans).where(and(eq(plans.organizationId, org), eq(plans.id, planId)));
  if (!plan) nurtureDeny("nurture_not_found", 404);
  const cohort = await reader.select().from(items).where(and(eq(items.organizationId, org), eq(items.planId, planId))).orderBy(items.id);
  const sequence = await reader.select().from(steps).where(and(eq(steps.organizationId, org), eq(steps.planId, planId))).orderBy(steps.itemId, steps.stepIndex);
  return { plan, items: cohort, steps: sequence };
}
/** No mutable delivery/state fields take part in the immutable review digest. */
export async function assertNurtureReview(reader: Pick<typeof db, "select">, org: string, planId: string) {
  const loaded = await readNurturePlan(reader, org, planId), { plan, items: cohort, steps: sequence } = loaded;
  if (!sourceNurtureSettingsSchema.safeParse(plan.settings).success || cohort.length < 1 || cohort.length > 10 || sequence.length !== cohort.length * 2 ||
    new Set(cohort.map(row => row.recipient)).size !== cohort.length || new Set(cohort.map(row => row.leadId)).size !== cohort.length ||
    plan.expiresAt.getTime() > plan.createdAt.getTime() + NURTURE_LIFETIME_MS || plan.startNotBefore >= plan.expiresAt ||
    nurturePlanFingerprint(plan, cohort, sequence) !== plan.payloadSha256) nurtureDeny("nurture_review_changed");
  const [review] = await reader.select().from(auditEventsTable).where(and(eq(auditEventsTable.organizationId, org), eq(auditEventsTable.id, plan.reviewId)));
  if (!review || review.actorUserId !== plan.createdByUserId || review.action !== "source_nurture.previewed" || review.entityType !== "source_nurture_plan" || review.entityId !== plan.id ||
    review.metadata.payloadSha256 !== plan.payloadSha256 || review.metadata.expiresAt !== plan.previewExpiresAt.toISOString()) nurtureDeny("nurture_review_changed");
  for (const item of cohort) {
    const pair = sequence.filter(step => step.itemId === item.id);
    if (!sourceNurtureItemSnapshotSchema.safeParse(item.snapshot).success || pair.length !== 2 || pair[0]?.stepIndex !== 1 || pair[1]?.stepIndex !== 2 || pair[1].predecessorId !== pair[0].id) nurtureDeny("nurture_review_changed");
    for (const step of pair) {
      if (step.leadId !== item.leadId || step.contactId !== item.contactId || step.expiresAt.getTime() !== plan.expiresAt.getTime() ||
        step.messageHash !== sourceFingerprint({ to: item.recipient, subject: step.subject, body: step.body })) nurtureDeny("nurture_review_changed");
    }
  }
  return loaded;
}
export async function currentNurtureSource(reader: NurtureReader, org: string, leadId: string, options: { lockRows?: boolean } = {}) {
  if (options.lockRows) {
    if (reader === db) nurtureDeny("nurture_transaction_required");
    const [lead] = await reader.select().from(leadsTable).where(and(eq(leadsTable.organizationId, org), eq(leadsTable.id, leadId))).for("share");
    if (!lead) nurtureDeny("source_not_found", 404);
    await reader.select().from(contactsTable).where(and(eq(contactsTable.organizationId, org), eq(contactsTable.id, lead.contactId))).for("share");
  }
  const source = await activeSourceDecision(org, leadId, reader);
  // Match the established outreach-stage boundary, using real lead enum values.
  // Booking/inspection and post-sale work require their own reviewed workflows.
  if (!source.lead.assignedUserId || !["new", "ai_qualified", "contact_attempted", "follow_up", "nurture"].includes(source.lead.status)) nurtureDeny("nurture_owner_or_stage_changed");
  const ownerQuery = reader.select().from(usersTable).where(and(eq(usersTable.organizationId, org), eq(usersTable.id, source.lead.assignedUserId)));
  const [owner] = await (options.lockRows ? ownerQuery.for("share") : ownerQuery);
  if (!owner?.isActive || !owner.emailVerifiedAt || owner.id.startsWith("invite:") || !hasPermission(owner.role, "crm.write")) nurtureDeny("nurture_owner_unavailable");
  if (source.lead.propertyId) {
    const [property] = await reader.select({ id: propertiesTable.id }).from(propertiesTable).where(and(eq(propertiesTable.organizationId, org), eq(propertiesTable.id, source.lead.propertyId)));
    if (!property) nurtureDeny("nurture_property_changed");
  }
  const [appointment] = await reader.select({ id: appointmentsTable.id }).from(appointmentsTable).where(and(eq(appointmentsTable.organizationId, org), eq(appointmentsTable.leadId, leadId), inArray(appointmentsTable.status, ["scheduled", "confirmed"])));
  if (appointment) nurtureDeny("nurture_appointment_booked");
  if (await sourceContactReplyHeld(org, source.contact.id, reader)) nurtureDeny("customer_reply_requires_review");
  const permission = await sourceEmailPermission(org, source.contact.id, source.snapshot.recipient, reader);
  const basic = await checkSendEligibility({ organizationId: org, leadId, contact: source.contact, channel: "email", kind: "transactional" }, reader);
  if (!basic.ok) nurtureDeny(basic.reason);
  const mailbox = await import("./mailbox-connector");
  const identity = await mailbox.getMicrosoftMailboxIdentity(org, owner.id, reader);
  if (!identity || identity.policyVersion !== 1) nurtureDeny("nurture_microsoft_mailbox_required");
  const mailboxIdentity = { ...identity, policyVersion: 1 as const };
  const nurtureMonitoringApproval = await mailbox.getNurtureMonitoringApproval(mailboxIdentity, reader);
  if (!nurtureMonitoringApproval) nurtureDeny("mailbox_nurture_approval_required");
  const sender = { userId: owner.id, source: "lead_assignee" as const, provider: "microsoft" as const, senderEmail: mailboxIdentity.mailboxEmail };
  const snapshot: SourceNurtureItemSnapshot = { version: 1, adoptionId: source.decision.id, adoptionVersion: source.decision.version, adoptionSha256: sourceFingerprint(source.decision), adoption: source.snapshot,
    permissionRecordId: permission.id, ownerUserId: owner.id, propertyId: source.lead.propertyId, leadCreatedAt: source.lead.createdAt.toISOString(), sender, mailboxIdentity, nurtureMonitoringApproval };
  return { ...source, owner, permission, sender, mailboxIdentity, nurtureMonitoringApproval, snapshot };
}
/** Minimal dependency-neutral imported-source exception; never calls send-gate. */
export async function assertNurtureStepSource(reader: Pick<typeof db, "select">, org: string, leadId: string, contactId: string, stepId: string) {
  const [step] = await reader.select().from(steps).where(and(eq(steps.organizationId, org), eq(steps.id, stepId), eq(steps.leadId, leadId), eq(steps.contactId, contactId)));
  if (!step) nurtureDeny("nurture_step_unavailable");
  const loaded = await assertNurtureReview(reader, org, step.planId), item = loaded.items.find(row => row.id === step.itemId);
  if (!item?.admittedAt || item.stoppedAt || step.cancelledAt || loaded.plan.state !== "running" || !loaded.plan.approvedByUserId || loaded.plan.expiresAt.getTime() <= Date.now()) nurtureDeny("nurture_not_running");
  await nurtureActor(reader, org, loaded.plan.createdByUserId); await nurtureActor(reader, org, loaded.plan.approvedByUserId);
  const source = await activeSourceDecision(org, leadId, reader), permission = await sourceEmailPermission(org, contactId, item.recipient, reader);
  if (source.contact.id !== contactId || sourceFingerprint(source.decision) !== item.snapshot.adoptionSha256 || sourceFingerprint(source.snapshot) !== sourceFingerprint(item.snapshot.adoption) || permission.id !== item.snapshot.permissionRecordId || source.snapshot.recipient !== item.recipient) nurtureDeny("nurture_source_changed");
  return { ...loaded, item, step, source };
}
export async function readNurtureStep(reader: Pick<typeof db, "select">, org: string, stepId: string) {
  const [step] = await reader.select().from(steps).where(and(eq(steps.organizationId, org), eq(steps.id, stepId)));
  if (!step) nurtureDeny("nurture_step_unavailable", 404);
  const loaded = await readNurturePlan(reader, org, step.planId), item = loaded.items.find(row => row.id === step.itemId);
  if (!item) nurtureDeny("nurture_item_unavailable");
  const [scheduled] = step.scheduledActionId ? await reader.select().from(scheduledActionsTable).where(and(eq(scheduledActionsTable.organizationId, org), eq(scheduledActionsTable.id, step.scheduledActionId))) : [];
  return { ...loaded, item, step, scheduled: scheduled ?? null };
}
export function nurtureTouch(input: { plan: NurturePlan; item: NurtureItem; step: NurtureStep; scheduled: typeof scheduledActionsTable.$inferSelect }): ContactTouchClaim {
  return { organizationId: input.plan.organizationId, logicalKey: `scheduled:${input.scheduled.id}`, contactId: input.item.contactId, address: input.item.recipient, channel: "email", sourceKind: "nurture", leadId: input.item.leadId,
    payload: { action: input.scheduled.action, context: input.scheduled.context } };
}
/** Shared company recovery ceiling includes both old one-touch and L6 claims. */
export async function sourceCompanyTouchCount(reader: Pick<typeof db, "select">, org: string, ownKey?: string) {
  const since = new Date(Date.now() - 86_400_000);
  const rows = await reader.select().from(touches).where(and(eq(touches.organizationId, org), inArray(touches.sourceKind, ["source", "nurture"]), sql`greatest(${touches.reservedAt}, ${touches.dispatchStartedAt}, ${touches.acceptedAt}) > ${since}`));
  const keys = new Set(rows.map(row => row.logicalKey));
  const old = await reader.select().from(sourceOutreachItemsTable).where(and(eq(sourceOutreachItemsTable.organizationId, org), gt(sourceOutreachItemsTable.claimedAt, since)));
  for (const row of old) keys.add(`source-outreach:${row.leadId}:email`);
  const accepted = await reader.select({ leadId: sourceOutreachItemsTable.leadId }).from(activitiesTable)
    .innerJoin(sourceOutreachItemsTable, and(eq(sourceOutreachItemsTable.organizationId, org), eq(sourceOutreachItemsTable.leadId, activitiesTable.leadId),
      sql`${activitiesTable.metadata}->>'sourceOutreachItemId' = ${sourceOutreachItemsTable.id}::text`))
    .where(and(eq(activitiesTable.organizationId, org), eq(activitiesTable.type, "automation_message_sent"), gt(activitiesTable.occurredAt, since)));
  for (const row of accepted) keys.add(`source-outreach:${row.leadId}:email`);
  if (ownKey) keys.delete(ownKey);
  return keys.size;
}
export async function nurturePredecessor(reader: Pick<typeof db, "select">, claim: { plan: NurturePlan; item: NurtureItem; step: NurtureStep }) {
  if (claim.step.stepIndex === 1) return { notBefore: claim.plan.startNotBefore, scanNotBefore: undefined as Date | undefined };
  const [predecessor] = await reader.select().from(steps).where(and(eq(steps.organizationId, claim.plan.organizationId), eq(steps.id, claim.step.predecessorId!), eq(steps.itemId, claim.item.id), eq(steps.stepIndex, 1)));
  if (!predecessor?.acceptedAt || !predecessor.acceptanceAuditId || !predecessor.scheduledActionId) nurtureDeny("nurture_predecessor_not_accepted");
  const [receipt] = await reader.select().from(revenueExecutionsTable).where(and(eq(revenueExecutionsTable.organizationId, claim.plan.organizationId), eq(revenueExecutionsTable.actionKey, `scheduled:${predecessor.scheduledActionId}`)));
  const [acceptance] = await reader.select().from(auditEventsTable).where(and(eq(auditEventsTable.organizationId, claim.plan.organizationId), eq(auditEventsTable.id, predecessor.acceptanceAuditId), eq(auditEventsTable.action, "source_nurture.provider_accepted"), eq(auditEventsTable.entityId, predecessor.id)));
  const [parent] = await reader.select().from(parents).where(and(eq(parents.organizationId, claim.plan.organizationId), eq(parents.sourceNurtureStepId, predecessor.id)));
  if (!receipt || receipt.state !== "succeeded" || !acceptance || !parent?.acceptedAt || !parent.observedAt || !parent.providerMessageId || !parent.dispatchStartedAt ||
    !verifyNurtureHttpAcceptance(acceptance.metadata, { organizationId: claim.plan.organizationId, planId: claim.plan.id, itemId: claim.item.id, stepId: predecessor.id, actionKey: receipt.actionKey,
      parentId: parent.id, executionFingerprint: receipt.fingerprint, messageHash: predecessor.messageHash, recipient: claim.item.recipient, acceptedAt: predecessor.acceptedAt.toISOString(), provider: "microsoft" }) ||
    parent.actionKey !== receipt.actionKey || parent.executionFingerprint !== receipt.fingerprint || parent.recipient !== claim.item.recipient || parent.leadId !== claim.item.leadId) nurtureDeny("nurture_predecessor_observation_required");
  const notBefore = new Date(predecessor.acceptedAt.getTime() + NURTURE_SPACING_MS);
  return { notBefore, scanNotBefore: new Date(Math.max(predecessor.acceptedAt.getTime(), parent.observedAt.getTime(), notBefore.getTime())) };
}
/** Typed transports call this inside their final transaction, after preparation. */
export async function assertNurtureStepCurrent(reader: NurtureReader, org: string, stepId: string, options: { phase: "claim" | "dispatch"; at?: Date } = { phase: "dispatch" }) {
  const loaded = await readNurtureStep(reader, org, stepId), { plan, item, step, scheduled } = loaded, at = options.at ?? new Date();
  if (!scheduled || scheduled.status !== "pending" || scheduled.action.type !== "source_nurture_email" ||
    sourceFingerprint(scheduled.action.params) !== sourceFingerprint({ planId: plan.id, itemId: item.id, stepId: step.id }) ||
    sourceFingerprint(scheduled.context) !== sourceFingerprint({ event: "source.nurture", leadId: item.leadId, contactId: item.contactId, planId: plan.id, itemId: item.id, stepId: step.id }) ||
    step.expiresAt <= at || plan.expiresAt <= at || step.cancelledAt || item.stoppedAt) nurtureDeny("nurture_original_action_changed");
  if (options.phase === "dispatch" && reader !== db) {
    // Generic membership/entitlement writers do not take the scheduling prefix.
    // Serialize them through the actual final claim, then re-read every grant.
    // Ordinary projections (reader === db) never acquire row locks.
    const [adoption] = await reader.select({ approvedByUserId: sourceAdoptionsTable.approvedByUserId }).from(sourceAdoptionsTable).where(and(eq(sourceAdoptionsTable.organizationId, org), eq(sourceAdoptionsTable.id, item.adoptionId)));
    await reader.select({ id: organizationsTable.id }).from(organizationsTable).where(eq(organizationsTable.id, org)).for("share");
    const [sendingPolicy] = await reader.select({ id: orgSettingsTable.organizationId }).from(orgSettingsTable).where(eq(orgSettingsTable.organizationId, org)).for("share");
    // There is no row lock for an absent settings row. Do not claim under a
    // default that a concurrent first-time setup could replace before dispatch.
    if (!sendingPolicy) nurtureDeny("nurture_sending_policy_required");
    const authorities = [...new Set([plan.createdByUserId, plan.approvedByUserId, adoption?.approvedByUserId, item.ownerUserId].filter((id): id is string => !!id))].sort();
    await reader.select({ id: usersTable.id }).from(usersTable).where(and(eq(usersTable.organizationId, org), inArray(usersTable.id, authorities))).orderBy(usersTable.id).for("share");
  }
  await assertNurtureStepSource(reader, org, item.leadId, item.contactId, step.id);
  const current = await currentNurtureSource(reader, org, item.leadId, { lockRows: options.phase === "dispatch" && reader !== db });
  if (sourceFingerprint(current.snapshot) !== sourceFingerprint(item.snapshot) || current.contact.id !== item.contactId || current.snapshot.adoption.recipient !== item.recipient) nurtureDeny("nurture_source_changed");
  const [company] = await reader.select().from(organizationsTable).where(eq(organizationsTable.id, org));
  if (company?.name !== plan.settings.businessName || current.decision.expiresAt < plan.expiresAt || sourceFingerprint(nurtureMessage(org, item.contactId, plan.settings, step.stepIndex)) !== sourceFingerprint({ subject: step.subject, body: step.body })) nurtureDeny("nurture_review_changed");
  await assertSourceSlotAvailable(reader, org, item.leadId, item.recipient, item.id);
  const predecessor = await nurturePredecessor(reader, loaded);
  if (predecessor.notBefore >= plan.expiresAt) nurtureDeny("nurture_window_expired");
  if (predecessor.notBefore > at || !step.notBefore || step.notBefore.getTime() !== predecessor.notBefore.getTime()) throw new NurtureDeferredError("nurture_not_due", predecessor.notBefore);
  const window = { ...plan.settings, quietHoursEnabled: true, maxTouchesPerDay: 1 };
  if (!isWithinWindow(window, at)) throw new NurtureDeferredError("nurture_quiet_hours", nextAllowedSendTime(window, at) ?? new Date(at.getTime() + 60_000));
  const ownKey = `scheduled:${scheduled.id}`;
  if (await sourceCompanyTouchCount(reader, org, ownKey) >= Math.min(25, plan.settings.dailyLimit)) throw new NurtureDeferredError("nurture_company_limit", new Date(at.getTime() + 60_000));
  const gate = await checkSendEligibility({ organizationId: org, leadId: item.leadId, contact: current.contact, channel: "email", kind: "outreach", sourceNurtureStepId: step.id, touchLogicalKey: ownKey,
    sendingHours: await contactTouchHours(reader, org) }, reader);
  if (!gate.ok) { if (gate.outcome === "deferred") throw new NurtureDeferredError(gate.reason, gate.resumeAt); nurtureDeny(gate.reason); }
  assertOutboundDeliveryAllowed({ channel: "email", recipient: item.recipient });
  await (await import("./mailbox-connector")).assertNurtureMailboxReady(current.mailboxIdentity, { approval: current.nurtureMonitoringApproval, notBefore: predecessor.scanNotBefore, at }, reader);
  const executionFingerprint = sourceFingerprint({ action: scheduled.action, context: scheduled.context });
  const [receipt] = await reader.select().from(revenueExecutionsTable).where(and(eq(revenueExecutionsTable.organizationId, org), eq(revenueExecutionsTable.actionKey, ownKey)));
  if (options.phase === "dispatch") {
    if (!step.claimedAt || !receipt || receipt.state !== "processing" || receipt.kind !== "source_nurture_email" || receipt.fingerprint !== executionFingerprint || receipt.actorUserId !== plan.approvedByUserId || receipt.expiresAt <= at) nurtureDeny("nurture_execution_not_owned");
    await assertContactTouchCurrent(reader, nurtureTouch({ ...loaded, scheduled }));
  } else if (step.claimedAt || receipt) nurtureDeny("nurture_execution_already_owned");
  return { ...loaded, scheduled, contact: current.contact, lead: current.lead, message: { to: item.recipient, subject: step.subject, body: step.body }, sender: current.sender,
    mailboxIdentity: current.mailboxIdentity, nurtureMonitoringApproval: current.nurtureMonitoringApproval, executionFingerprint };
}
/** Called under the full shared prefix before reply/parent row locks. Never rearm. */
export async function stopSourceNurtureForReply(tx: NurtureTx, org: string, input: { planId: string; itemId: string; stepId: string; replyId: string; replyAt: Date }) {
  const loaded = await readNurtureStep(tx, org, input.stepId);
  if (loaded.plan.id !== input.planId || loaded.item.id !== input.itemId) nurtureDeny("nurture_reply_parent_changed");
  return stopNurtureItem(tx, org, loaded.item.id, "customer_reply_requires_office");
}
export async function stopNurtureItem(tx: NurtureTx, org: string, itemId: string, reason: string) {
  await tx.update(items).set({ stoppedAt: new Date(), stopReason: reason }).where(and(eq(items.organizationId, org), eq(items.id, itemId), isNull(items.stoppedAt)));
  const sequence = await tx.select().from(steps).where(and(eq(steps.organizationId, org), eq(steps.itemId, itemId))).orderBy(steps.stepIndex);
  let cancelledActions = 0, reconciliationRequired = 0;
  for (const step of sequence) {
    if (!step.scheduledActionId) continue;
    const [receipt] = await tx.select().from(revenueExecutionsTable).where(and(eq(revenueExecutionsTable.organizationId, org), eq(revenueExecutionsTable.actionKey, `scheduled:${step.scheduledActionId}`)));
    if (step.claimedAt || receipt) { if (!receipt || ["processing", "indeterminate"].includes(receipt.state)) reconciliationRequired++; continue; }
    await tx.update(steps).set({ cancelledAt: new Date(), reason }).where(and(eq(steps.organizationId, org), eq(steps.id, step.id), isNull(steps.claimedAt), isNull(steps.cancelledAt)));
    const cancelled = await tx.update(scheduledActionsTable).set({ status: "cancelled", lastError: "Original sequence stopped. Review does not resume or replace its send authority." }).where(and(eq(scheduledActionsTable.organizationId, org), eq(scheduledActionsTable.id, step.scheduledActionId), eq(scheduledActionsTable.status, "pending"))).returning({ id: scheduledActionsTable.id });
    cancelledActions += cancelled.length;
  }
  return { cancelledActions, reconciliationRequired };
}
export async function stopSourceNurtureForContact(tx: NurtureTx, org: string, contactId: string, reason: string) {
  const cohort = await tx.select().from(items).where(and(eq(items.organizationId, org), eq(items.contactId, contactId), sql`${items.admittedAt} is not null`));
  await acquireNurtureLocks(tx, org, cohort.map(row => row.leadId));
  let cancelledActions = 0, reconciliationRequired = 0;
  for (const item of cohort) { const stopped = await stopNurtureItem(tx, org, item.id, reason); cancelledActions += stopped.cancelledActions; reconciliationRequired += stopped.reconciliationRequired; }
  return { cancelledActions, reconciliationRequired };
}
