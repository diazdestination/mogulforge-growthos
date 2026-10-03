import { and, asc, eq, isNull, lte, sql } from "drizzle-orm";
import { activitiesTable, auditEventsTable, db, revenueExecutionsTable, scheduledActionsTable, type ActionResult } from "@workspace/db";
import { sourceNurturePlansTable as plans, sourceNurtureStepsTable as steps } from "../../../../lib/db/src/schema/source-nurture";
import { mailboxCommunicationParentsTable as parents } from "../../../../lib/db/src/schema/mailbox-communication";
import { acquireNurtureLocks, assertNurtureStepCurrent, NurtureDeferredError, readNurturePlan, readNurtureStep, stopNurtureItem } from "./source-nurture-authority";
import { nurtureReason } from "./source-nurture";
import { NURTURE_SPACING_MS, SourceNurtureError } from "./source-nurture-contract";
import { sourceFingerprint, SourceAdoptionError } from "./source-adoption-contract";
import { MailboxError } from "./mailbox-contract";
import { EmailDispatchBlockedError } from "./email-dispatch-guard";
import { sendCustomerEmail } from "./customer-email";
import { emailAcceptanceEvidence } from "./user-email";
import { reserveSourceNurtureMailboxParent } from "./mailbox-communication";
import { signNurtureHttpAcceptance } from "./source-nurture-acceptance";
import { acceptContactTouch, markContactTouchDispatchStarted } from "./contact-touch-claim";

const temporary = (code: string) => code.startsWith("mailbox_sync_") || code.startsWith("nurture_predecessor_") || ["customer_lifecycle_paused", "mailbox_company_paused", "nurture_capability_required", "nurture_readiness_unavailable"].includes(code);
/** One bounded tick per retained plan. Every checkpoint is under the same lock as commands. */
export async function processSourceNurture(organizationId?: string) {
  const due = await db.select({ id: plans.id, org: plans.organizationId }).from(plans).where(and(eq(plans.state, "running"), lte(plans.nextCheckAt, new Date()), organizationId ? eq(plans.organizationId, organizationId) : undefined))
    .orderBy(asc(plans.nextCheckAt), asc(plans.id)).limit(20);
  for (const row of due) {
    try { await monitorSourceNurture(row.org, row.id); }
    catch {
      // Preserve other companies/items and rotate a failing row without
      // overwriting a concurrent Stop/Start command's state or checkpoint.
      await db.transaction(async tx => {
        await acquireNurtureLocks(tx, row.org);
        await tx.update(plans).set({ nextCheckAt: new Date(Date.now() + 60_000), lastCheckedAt: new Date(), lastCode: "nurture_monitor_read_failed" })
          .where(and(eq(plans.organizationId, row.org), eq(plans.id, row.id), eq(plans.state, "running"), lte(plans.nextCheckAt, new Date())));
      }).catch(() => undefined);
    }
  }
}
async function monitorSourceNurture(org: string, id: string) {
  await db.transaction(async tx => {
    await acquireNurtureLocks(tx, org);
    const loaded = await readNurturePlan(tx, org, id), { plan } = loaded;
    if (plan.state !== "running" || plan.nextCheckAt.getTime() > Date.now()) return;
    await acquireNurtureLocks(tx, org, loaded.items.map(item => item.leadId));
    const at = new Date(); let code: string | null = null, openItems = 0;
    if (plan.expiresAt <= at) {
      for (const item of loaded.items) await stopNurtureItem(tx, org, item.id, "nurture_expired");
      await tx.update(plans).set({ state: "expired", version: plan.version + 1, lastCode: "nurture_expired", lastCheckedAt: at }).where(and(eq(plans.organizationId, org), eq(plans.id, id)));
      return;
    }
    for (const item of loaded.items) {
      if (item.stoppedAt) continue;
      const pair = loaded.steps.filter(step => step.itemId === item.id); let stillOpen = false;
      for (const step of pair) {
        if (step.cancelledAt || !step.scheduledActionId) continue;
        const [receipt] = await tx.select().from(revenueExecutionsTable).where(and(eq(revenueExecutionsTable.organizationId, org), eq(revenueExecutionsTable.actionKey, `scheduled:${step.scheduledActionId}`)));
        if (receipt || step.claimedAt) {
          if (receipt?.state === "succeeded" && step.acceptedAt) continue;
          if (receipt?.state === "processing" && receipt.expiresAt > at) { code ??= "waiting:nurture_processing"; stillOpen = true; continue; }
          await stopNurtureItem(tx, org, item.id, "nurture_original_effect_requires_review"); code = "nurture_original_effect_requires_review"; stillOpen = false; break;
        }
        if (step.stepIndex === 2) {
          const predecessor = pair.find(candidate => candidate.stepIndex === 1);
          if (!predecessor?.acceptedAt) { code ??= "waiting:nurture_predecessor_not_accepted"; stillOpen = true; continue; }
          const notBefore = new Date(predecessor.acceptedAt.getTime() + NURTURE_SPACING_MS);
          if (!step.notBefore) {
            await tx.update(steps).set({ notBefore }).where(and(eq(steps.organizationId, org), eq(steps.id, step.id), isNull(steps.notBefore), isNull(steps.claimedAt)));
            await tx.update(scheduledActionsTable).set({ runAt: notBefore }).where(and(eq(scheduledActionsTable.organizationId, org), eq(scheduledActionsTable.id, step.scheduledActionId), eq(scheduledActionsTable.status, "pending")));
          }
        }
        try {
          await assertNurtureStepCurrent(tx, org, step.id, { phase: "claim", at });
          await tx.update(scheduledActionsTable).set({ runAt: at, lastError: null }).where(and(eq(scheduledActionsTable.organizationId, org), eq(scheduledActionsTable.id, step.scheduledActionId), eq(scheduledActionsTable.status, "pending")));
          stillOpen = true;
        } catch (error) {
          const reason = nurtureReason(error);
          if (error instanceof NurtureDeferredError || temporary(reason)) {
            const resumeAt = error instanceof NurtureDeferredError ? error.resumeAt : new Date(at.getTime() + 60_000);
            if (resumeAt >= plan.expiresAt) { await stopNurtureItem(tx, org, item.id, "nurture_window_expired"); code = "nurture_window_expired"; stillOpen = false; break; }
            await tx.update(scheduledActionsTable).set({ runAt: resumeAt, lastError: reason }).where(and(eq(scheduledActionsTable.organizationId, org), eq(scheduledActionsTable.id, step.scheduledActionId), eq(scheduledActionsTable.status, "pending")));
            code ??= `waiting:${reason}`; stillOpen = true;
          } else { await stopNurtureItem(tx, org, item.id, reason); code = reason; stillOpen = false; break; }
        }
      }
      if (stillOpen) openItems++;
    }
    await tx.update(plans).set({ ...(openItems ? {} : { state: "finished" as const, version: plan.version + 1 }), nextCheckAt: new Date(at.getTime() + 60_000), lastCheckedAt: at, lastCode: code })
      .where(and(eq(plans.organizationId, org), eq(plans.id, id), eq(plans.version, plan.version), eq(plans.state, "running")));
  });
}
/** Scheduler preflight can move only an unclaimed original action. */
export async function preflightSourceNurture(org: string, scheduledActionId: string, stepId: string) {
  return db.transaction(async tx => {
    await acquireNurtureLocks(tx, org);
    const loaded = await readNurtureStep(tx, org, stepId);
    if (loaded.step.scheduledActionId !== scheduledActionId) throw new SourceNurtureError(409, "nurture_original_action_changed");
    await acquireNurtureLocks(tx, org, [loaded.item.leadId]);
    const [receipt] = await tx.select().from(revenueExecutionsTable).where(and(eq(revenueExecutionsTable.organizationId, org), eq(revenueExecutionsTable.actionKey, `scheduled:${scheduledActionId}`)));
    if (receipt || loaded.step.claimedAt) return { held: false };
    try { await assertNurtureStepCurrent(tx, org, stepId, { phase: "claim" }); return { held: false }; }
    catch (error) {
      const reason = nurtureReason(error), resumeAt = error instanceof NurtureDeferredError ? error.resumeAt : new Date(Date.now() + 60_000);
      if ((error instanceof NurtureDeferredError || temporary(reason)) && resumeAt < loaded.plan.expiresAt) await tx.update(scheduledActionsTable).set({ runAt: resumeAt, lastError: reason }).where(and(eq(scheduledActionsTable.organizationId, org), eq(scheduledActionsTable.id, scheduledActionId), eq(scheduledActionsTable.status, "pending")));
      else await stopNurtureItem(tx, org, loaded.item.id, reason);
      return { held: true };
    }
  });
}
export async function executeSourceNurtureEmail(org: string, params: Record<string, unknown>, context: Record<string, unknown>, scheduledActionId: string): Promise<ActionResult> {
  const blocked = (): ActionResult => ({ type: "source_nurture_email", status: "skipped", detail: "Original reviewed nurture email held before provider dispatch. Ownership is retained; no automatic replay." });
  if (typeof params.stepId !== "string") return blocked();
  let current: Awaited<ReturnType<typeof assertNurtureStepCurrent>>, parentId: string;
  try {
    current = await assertNurtureStepCurrent(db, org, params.stepId, { phase: "dispatch" });
    if (current.scheduled.id !== scheduledActionId || sourceFingerprint(current.scheduled.context) !== sourceFingerprint(context) || sourceFingerprint(current.scheduled.action.params) !== sourceFingerprint(params)) return blocked();
    parentId = await reserveSourceNurtureMailboxParent({ identity: current.mailboxIdentity, stepId: current.step.id, executionFingerprint: current.executionFingerprint, message: current.message });
  } catch (error) {
    if (error instanceof SourceNurtureError || error instanceof SourceAdoptionError || error instanceof MailboxError || error instanceof NurtureDeferredError || error instanceof EmailDispatchBlockedError) return blocked();
    throw error;
  }
  let dispatchHeld = false;
  const result = await sendCustomerEmail({ organizationId: org, leadId: current.item.leadId, ...current.message, expectedSender: current.sender, outboundParentId: parentId,
    beforeDispatch: async () => { try { await assertNurtureStepCurrent(db, org, current.step.id, { phase: "dispatch" }); await markContactTouchDispatchStarted(org, `scheduled:${scheduledActionId}`); } catch { dispatchHeld = true; throw new EmailDispatchBlockedError(); } },
  }).catch(error => { if (dispatchHeld || error instanceof EmailDispatchBlockedError) return null; throw error; });
  if (!result) return blocked();
  if (result.provider !== "microsoft" || result.acceptance !== "accepted") throw new Error("Expected actual Microsoft provider acceptance.");
  const acceptedAt = new Date(), actionKey = `scheduled:${scheduledActionId}`;
  const evidence = { ...emailAcceptanceEvidence(result, { organizationId: org, leadId: current.item.leadId, recipientEmail: current.item.recipient }),
    ...signNurtureHttpAcceptance({ organizationId: org, planId: current.plan.id, itemId: current.item.id, stepId: current.step.id, actionKey, parentId,
      executionFingerprint: current.executionFingerprint, messageHash: current.step.messageHash, recipient: current.item.recipient, acceptedAt: acceptedAt.toISOString(), provider: "microsoft" }),
    sourceNurtureStepId: current.step.id, sourceNurturePlanId: current.plan.id, touchLogicalKey: actionKey };
  await db.transaction(async tx => {
    const [parent] = await tx.update(parents).set({ acceptedAt }).where(and(eq(parents.organizationId, org), eq(parents.id, parentId), eq(parents.sourceNurtureStepId, current.step.id), eq(parents.executionFingerprint, current.executionFingerprint), sql`${parents.dispatchStartedAt} is not null`, isNull(parents.acceptedAt))).returning({ id: parents.id });
    if (!parent) throw new Error("Original provider acceptance parent is unavailable. Reconciliation required.");
    const [audit] = await tx.insert(auditEventsTable).values({ organizationId: org, actorUserId: current.plan.approvedByUserId, action: "source_nurture.provider_accepted", entityType: "source_nurture_step", entityId: current.step.id, metadata: evidence, createdAt: acceptedAt }).returning();
    await tx.update(steps).set({ acceptedAt, acceptanceAuditId: audit.id }).where(and(eq(steps.organizationId, org), eq(steps.id, current.step.id), sql`${steps.claimedAt} is not null`, isNull(steps.acceptedAt)));
    await tx.insert(activitiesTable).values([{ organizationId: org, leadId: current.item.leadId, contactId: current.item.contactId, actorUserId: current.plan.approvedByUserId,
      type: "email_sent", title: "Reviewed nurture email accepted by Microsoft; delivery unconfirmed", metadata: evidence, occurredAt: acceptedAt },
    { organizationId: org, leadId: current.item.leadId, contactId: current.item.contactId, actorUserId: current.plan.approvedByUserId,
      type: "automation_message_sent", title: "Reviewed finite nurture touch", metadata: { channel: "email", sourceNurtureStepId: current.step.id, touchLogicalKey: actionKey }, occurredAt: acceptedAt }]);
    await tx.update(plans).set({ nextCheckAt: acceptedAt }).where(and(eq(plans.organizationId, org), eq(plans.id, current.plan.id), eq(plans.state, "running")));
  });
  await acceptContactTouch(org, actionKey);
  return { type: "source_nurture_email", status: "success", detail: "Microsoft accepted the original reviewed message. Sent Items observation and delivery are separate evidence." };
}
