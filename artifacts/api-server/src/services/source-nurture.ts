import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNull, lte, ne, notExists, or, sql } from "drizzle-orm";
import { appointmentsTable, auditEventsTable, crmTasksTable, db, emailResponseReviewsTable, leadsTable, organizationsTable, revenueExecutionsTable, scheduledActionsTable } from "@workspace/db";
import { sourceNurturePlansTable as plans, sourceNurtureItemsTable as items, sourceNurtureStepsTable as steps } from "../../../../lib/db/src/schema/source-nurture";
import { mailboxCommunicationParentsTable as parents } from "../../../../lib/db/src/schema/mailbox-communication";
import { sourceFingerprint } from "./source-adoption-contract";
import { assertSourceSlotAvailable, type NurtureTx } from "./source-outreach-ownership";
import { acquireNurtureLocks, assertNurtureReview, assertNurtureStepCurrent, currentNurtureSource, nurtureActor, nurtureMessage, nurturePredecessor, NurtureDeferredError, readNurturePlan, stopNurtureItem, type NurtureItem, type NurturePlan, type NurtureStep } from "./source-nurture-authority";
import { nurturePlanFingerprint } from "./source-nurture-fingerprint";
import { NURTURE_LIFETIME_MS, NURTURE_REVIEW_MS, NURTURE_SPACING_MS, nurtureDeny, sourceNurtureApprovalSchema, sourceNurtureCommandResponseSchema, sourceNurtureDetailSchema, sourceNurtureDraftSchema, sourceNurtureListQuerySchema, sourceNurtureListSchema, sourceNurtureStartSchema, sourceNurtureStopSchema, type SourceNurtureDetail } from "./source-nurture-contract";
import { assertNurtureMailboxReady, getNurtureMailboxReadiness } from "./mailbox-connector";

const iso = (date: Date | null) => date?.toISOString() ?? null;
export const nurtureReason = (error: unknown) => error && typeof error === "object" && "code" in error && typeof error.code === "string" && /^[a-z_0-9:-]{1,120}$/.test(error.code) ? error.code
  : error instanceof NurtureDeferredError ? error.reason : "nurture_readiness_unavailable";
async function audit(tx: NurtureTx, org: string, actor: string, action: string, id: string, metadata: Record<string, unknown>) {
  await tx.insert(auditEventsTable).values({ organizationId: org, actorUserId: actor, action, entityType: "source_nurture_plan", entityId: id, metadata });
}
async function frozenCurrent(tx: NurtureTx, plan: NurturePlan, cohort: NurtureItem[], sequence: NurtureStep[]) {
  await nurtureActor(tx, plan.organizationId, plan.createdByUserId);
  if (plan.approvedByUserId) await nurtureActor(tx, plan.organizationId, plan.approvedByUserId);
  const [company] = await tx.select().from(organizationsTable).where(eq(organizationsTable.id, plan.organizationId));
  if (company?.name !== plan.settings.businessName || plan.expiresAt.getTime() <= Date.now()) nurtureDeny("nurture_review_changed");
  for (const item of cohort) {
    const current = await currentNurtureSource(tx, plan.organizationId, item.leadId, { lockRows: true });
    if (sourceFingerprint(current.snapshot) !== sourceFingerprint(item.snapshot) || current.decision.expiresAt < plan.expiresAt) nurtureDeny("nurture_source_changed");
    await assertSourceSlotAvailable(tx, plan.organizationId, item.leadId, item.recipient, item.admittedAt ? item.id : undefined);
    for (const step of sequence.filter(row => row.itemId === item.id)) if (sourceFingerprint(nurtureMessage(plan.organizationId, item.contactId, plan.settings, step.stepIndex)) !== sourceFingerprint({ subject: step.subject, body: step.body })) nurtureDeny("nurture_copy_changed");
  }
}
/** Creates local immutable review only. No action or contact reservation exists yet. */
export async function previewSourceNurture(org: string, actor: string, raw: unknown) {
  const input = sourceNurtureDraftSchema.parse(raw), now = new Date(), expiresAt = new Date(input.expiresAt), startNotBefore = new Date(input.startNotBefore);
  if (startNotBefore.getTime() < now.getTime() - 60_000 || expiresAt.getTime() > now.getTime() + NURTURE_LIFETIME_MS || expiresAt.getTime() <= startNotBefore.getTime() + NURTURE_SPACING_MS) nurtureDeny("nurture_dates_invalid");
  const { leadIds, startNotBefore: _start, expiresAt: _expiry, ...settings } = input;
  const planId = randomUUID(), reviewId = randomUUID();
  await db.transaction(async tx => {
    await acquireNurtureLocks(tx, org, leadIds); await nurtureActor(tx, org, actor);
    const [company] = await tx.select().from(organizationsTable).where(eq(organizationsTable.id, org));
    if (company?.name !== settings.businessName) nurtureDeny("nurture_business_identity_changed");
    const cohort: NurtureItem[] = [], sequence: NurtureStep[] = [];
    for (const leadId of [...leadIds].sort()) {
      const current = await currentNurtureSource(tx, org, leadId, { lockRows: true });
      if (current.decision.expiresAt < expiresAt) nurtureDeny("source_review_expires_first");
      await assertSourceSlotAvailable(tx, org, leadId, current.snapshot.adoption.recipient);
      if (cohort.some(row => row.recipient === current.snapshot.adoption.recipient)) nurtureDeny("nurture_duplicate_address");
      const item: NurtureItem = { id: randomUUID(), organizationId: org, planId, leadId, contactId: current.contact.id, propertyId: current.lead.propertyId, ownerUserId: current.owner.id,
        adoptionId: current.decision.id, recipient: current.snapshot.adoption.recipient, snapshot: current.snapshot, admittedAt: null, stoppedAt: null, stopReason: null, createdAt: now };
      cohort.push(item); const firstId = randomUUID();
      for (const stepIndex of [1, 2] as const) {
        const message = nurtureMessage(org, item.contactId, settings, stepIndex);
        sequence.push({ id: stepIndex === 1 ? firstId : randomUUID(), organizationId: org, planId, itemId: item.id, leadId, contactId: item.contactId, stepIndex, predecessorId: stepIndex === 1 ? null : firstId,
          scheduledActionId: null, ...message, messageHash: sourceFingerprint({ to: item.recipient, ...message }), notBefore: stepIndex === 1 ? startNotBefore : null, expiresAt,
          claimedAt: null, acceptedAt: null, acceptanceAuditId: null, cancelledAt: null, reason: null, createdAt: now });
      }
    }
    const plan: NurturePlan = { id: planId, organizationId: org, version: 1, state: "draft", settings, payloadSha256: "", reviewId, createdByUserId: actor, approvedByUserId: null, approvedAt: null,
      previewExpiresAt: new Date(now.getTime() + NURTURE_REVIEW_MS), startNotBefore, expiresAt, startRequestId: null, startPayloadHash: null, startedAt: null, stopRequestId: null, stopPayloadHash: null, stoppedAt: null, stopReason: null,
      nextCheckAt: now, lastCheckedAt: null, lastCode: null, createdAt: now };
    plan.payloadSha256 = nurturePlanFingerprint(plan, cohort, sequence);
    await tx.insert(auditEventsTable).values({ id: reviewId, organizationId: org, actorUserId: actor, action: "source_nurture.previewed", entityType: "source_nurture_plan", entityId: planId,
      metadata: { version: 1, payloadSha256: plan.payloadSha256, expiresAt: plan.previewExpiresAt.toISOString(), recipients: cohort.length, steps: 2 }, createdAt: now });
    await tx.insert(plans).values(plan); await tx.insert(items).values(cohort);
    // The first step must exist before the exact same-item predecessor FK.
    await tx.insert(steps).values(sequence.filter(row => row.stepIndex === 1)); await tx.insert(steps).values(sequence.filter(row => row.stepIndex === 2));
  });
  return getSourceNurture(org, planId);
}
export async function approveSourceNurture(org: string, actor: string, id: string, raw: unknown) {
  const input = sourceNurtureApprovalSchema.parse(raw); let replayed = false, appliedVersion = 0;
  await db.transaction(async tx => {
    await acquireNurtureLocks(tx, org); await nurtureActor(tx, org, actor);
    const loaded = await assertNurtureReview(tx, org, id), { plan, items: cohort, steps: sequence } = loaded;
    if (plan.createdByUserId !== actor || plan.payloadSha256 !== input.payloadSha256) nurtureDeny("nurture_review_changed");
    if (plan.state === "approved" && plan.approvedByUserId === actor && plan.version === input.expectedVersion + 1) { replayed = true; appliedVersion = plan.version; return; }
    if (plan.state !== "draft" || plan.version !== input.expectedVersion || plan.previewExpiresAt.getTime() <= Date.now()) nurtureDeny("nurture_review_expired_or_changed");
    await acquireNurtureLocks(tx, org, cohort.map(row => row.leadId)); await frozenCurrent(tx, plan, cohort, sequence);
    appliedVersion = plan.version + 1;
    await tx.update(plans).set({ state: "approved", version: appliedVersion, approvedByUserId: actor, approvedAt: new Date() }).where(and(eq(plans.organizationId, org), eq(plans.id, id), eq(plans.version, plan.version)));
    await audit(tx, org, actor, "source_nurture.approved", id, { version: appliedVersion, reviewId: plan.reviewId, payloadSha256: plan.payloadSha256 });
  });
  return sourceNurtureCommandResponseSchema.parse({ detail: await getSourceNurture(org, id), command: { action: "approve", requestId: null, replayed, appliedVersion } });
}
export async function startSourceNurture(org: string, actor: string, id: string, raw: unknown) {
  const input = sourceNurtureStartSchema.parse(raw), commandHash = sourceFingerprint({ actor, id, ...input }); let replayed = false, appliedVersion = 0;
  await db.transaction(async tx => {
    await acquireNurtureLocks(tx, org); await nurtureActor(tx, org, actor);
    const loaded = await assertNurtureReview(tx, org, id), { plan, items: cohort, steps: sequence } = loaded;
    if (plan.startRequestId === input.requestId) { if (plan.startPayloadHash !== commandHash) nurtureDeny("nurture_command_conflict"); replayed = true; appliedVersion = input.expectedVersion + 1; return; }
    const [reused] = await tx.select({ id: plans.id }).from(plans).where(and(eq(plans.organizationId, org), or(eq(plans.startRequestId, input.requestId), eq(plans.stopRequestId, input.requestId))));
    if (reused) nurtureDeny("nurture_command_conflict");
    if (plan.state !== "approved" || plan.version !== input.expectedVersion || plan.payloadSha256 !== input.payloadSha256 || plan.approvedByUserId !== actor || plan.startedAt) nurtureDeny("nurture_review_changed");
    await acquireNurtureLocks(tx, org, cohort.map(row => row.leadId)); await frozenCurrent(tx, plan, cohort, sequence);
    const at = new Date();
    for (const item of cohort) await assertNurtureMailboxReady(item.snapshot.mailboxIdentity, { approval: item.snapshot.nurtureMonitoringApproval, at }, tx);
    for (const item of cohort) await tx.update(items).set({ admittedAt: at }).where(and(eq(items.organizationId, org), eq(items.id, item.id), isNull(items.admittedAt)));
    for (const step of sequence) {
      if (step.scheduledActionId || step.claimedAt) nurtureDeny("nurture_original_action_changed");
      const actionId = randomUUID();
      await tx.insert(scheduledActionsTable).values({ id: actionId, organizationId: org, action: { type: "source_nurture_email", params: { planId: id, itemId: step.itemId, stepId: step.id } },
        context: { event: "source.nurture", leadId: step.leadId, contactId: step.contactId, planId: id, itemId: step.itemId, stepId: step.id }, runAt: step.stepIndex === 1 ? plan.startNotBefore : plan.expiresAt, createdAt: at, updatedAt: at });
      await tx.update(steps).set({ scheduledActionId: actionId }).where(and(eq(steps.organizationId, org), eq(steps.id, step.id)));
    }
    appliedVersion = plan.version + 1;
    await tx.update(plans).set({ state: "running", version: appliedVersion, startRequestId: input.requestId, startPayloadHash: commandHash, startedAt: at, nextCheckAt: at }).where(and(eq(plans.organizationId, org), eq(plans.id, id)));
    await audit(tx, org, actor, "source_nurture.started", id, { requestId: input.requestId, commandHash, version: appliedVersion, payloadSha256: plan.payloadSha256, originalActions: sequence.length });
  });
  return sourceNurtureCommandResponseSchema.parse({ detail: await getSourceNurture(org, id), command: { action: "start", requestId: input.requestId, replayed, appliedVersion } });
}
export async function stopSourceNurture(org: string, actor: string, id: string, raw: unknown) {
  const input = sourceNurtureStopSchema.parse(raw), commandHash = sourceFingerprint({ actor, id, ...input }); let replayed = false, appliedVersion = 0;
  await db.transaction(async tx => {
    await acquireNurtureLocks(tx, org); await nurtureActor(tx, org, actor, false);
    const loaded = await readNurturePlan(tx, org, id), { plan } = loaded;
    if (plan.stopRequestId === input.requestId) { if (plan.stopPayloadHash !== commandHash) nurtureDeny("nurture_command_conflict"); replayed = true; appliedVersion = input.expectedVersion + 1; return; }
    const [reused] = await tx.select({ id: plans.id }).from(plans).where(and(eq(plans.organizationId, org), or(eq(plans.startRequestId, input.requestId), eq(plans.stopRequestId, input.requestId))));
    if (reused) nurtureDeny("nurture_command_conflict");
    if (plan.version !== input.expectedVersion || plan.payloadSha256 !== input.payloadSha256 || ["stopped", "finished", "expired"].includes(plan.state)) nurtureDeny("nurture_command_changed");
    await acquireNurtureLocks(tx, org, loaded.items.map(row => row.leadId));
    for (const item of loaded.items) await stopNurtureItem(tx, org, item.id, "owner_stopped");
    appliedVersion = plan.version + 1;
    await tx.update(plans).set({ state: "stopped", version: appliedVersion, stoppedAt: new Date(), stopReason: input.reason, stopRequestId: input.requestId, stopPayloadHash: commandHash, lastCode: "owner_stopped" }).where(and(eq(plans.organizationId, org), eq(plans.id, id)));
    await audit(tx, org, actor, "source_nurture.stopped", id, { requestId: input.requestId, commandHash, reason: input.reason, version: appliedVersion, payloadSha256: plan.payloadSha256 });
  });
  return sourceNurtureCommandResponseSchema.parse({ detail: await getSourceNurture(org, id), command: { action: "stop", requestId: input.requestId, replayed, appliedVersion } });
}
/** SELECT-only evidence projection: saved approval is never labeled delivery. */
export async function getSourceNurture(org: string, id: string): Promise<SourceNurtureDetail> {
  const loaded = await readNurturePlan(db, org, id), { plan } = loaded;
  const cohort: SourceNurtureDetail["items"] = [];
  for (const item of loaded.items) {
    const sequence: SourceNurtureDetail["items"][number]["steps"] = [];
    let scanNotBefore: Date | undefined;
    for (const step of loaded.steps.filter(row => row.itemId === item.id)) {
      const [receipt] = step.scheduledActionId ? await db.select().from(revenueExecutionsTable).where(and(eq(revenueExecutionsTable.organizationId, org), eq(revenueExecutionsTable.actionKey, `scheduled:${step.scheduledActionId}`))) : [];
      const [parent] = await db.select().from(parents).where(and(eq(parents.organizationId, org), eq(parents.sourceNurtureStepId, step.id)));
      let state: typeof sequence[number]["state"] = "not_started", reason: string | null = null;
      if (step.acceptedAt && receipt?.state === "succeeded") state = "accepted";
      else if (receipt?.state === "indeterminate" || step.claimedAt && !receipt || receipt?.state === "processing" && receipt.expiresAt.getTime() <= Date.now()) { state = "uncertain"; reason = "nurture_unknown_original_effect"; }
      else if (receipt?.state === "processing") state = "processing";
      else if (receipt) { state = receipt.state === "blocked" ? "held" : "finished"; reason = "nurture_original_effect_owned"; }
      else if (step.cancelledAt || item.stoppedAt || ["stopped", "expired"].includes(plan.state)) { state = "cancelled"; reason = step.reason ?? item.stopReason ?? plan.lastCode; }
      else if (plan.state === "running") {
        try { await assertNurtureStepCurrent(db, org, step.id, { phase: "claim" }); state = "ready"; }
        catch (error) { reason = nurtureReason(error); state = error instanceof NurtureDeferredError || reason.startsWith("mailbox_sync_") || reason.startsWith("nurture_predecessor_") ? "waiting" : "held"; }
      }
      if (step.stepIndex === 2) { try { scanNotBefore = (await nurturePredecessor(db, { plan, item, step })).scanNotBefore; } catch { /* expose actual current cycle even before predecessor acceptance */ } }
      sequence.push({ id: step.id, stepIndex: step.stepIndex, subject: step.subject, body: step.body, messageHash: step.messageHash, scheduledActionId: step.scheduledActionId, notBefore: iso(step.notBefore), expiresAt: step.expiresAt.toISOString(),
        claimedAt: iso(step.claimedAt), acceptedAt: iso(step.acceptedAt), state, reason, executionId: receipt?.id ?? null, executionState: receipt?.state ?? null, parentId: parent?.id ?? null, observedAt: iso(parent?.observedAt ?? null), dispatchStartedAt: iso(parent?.dispatchStartedAt ?? null), deliveryConfirmed: false });
    }
    let mailboxSync: SourceNurtureDetail["items"][number]["mailboxSync"];
    try { mailboxSync = await getNurtureMailboxReadiness(item.snapshot.mailboxIdentity, { approval: item.snapshot.nurtureMonitoringApproval, notBefore: scanNotBefore }); }
    catch (error) { mailboxSync = { ready: false, reason: nurtureReason(error), completedCycleId: null, startedAt: null, completedAt: null }; }
    const [lead] = await db.select({ status: leadsTable.status }).from(leadsTable).where(and(eq(leadsTable.organizationId, org), eq(leadsTable.id, item.leadId)));
    const replies = await db.select({ id: emailResponseReviewsTable.id, taskId: emailResponseReviewsTable.taskId }).from(emailResponseReviewsTable)
      .innerJoin(parents, and(eq(parents.organizationId, org), eq(parents.id, emailResponseReviewsTable.mailboxParentId)))
      .innerJoin(steps, and(eq(steps.organizationId, org), eq(steps.id, parents.sourceNurtureStepId), eq(steps.itemId, item.id)))
      .where(and(eq(emailResponseReviewsTable.organizationId, org), eq(emailResponseReviewsTable.leadId, item.leadId)));
    const appointments = await db.select({ id: appointmentsTable.id }).from(appointmentsTable).where(and(eq(appointmentsTable.organizationId, org), eq(appointmentsTable.leadId, item.leadId)));
    const ready = sequence.some(step => step.state === "ready"), reason = item.stopReason ?? sequence.find(step => step.reason)?.reason ?? (plan.state === "running" ? null : "nurture_not_started");
    cohort.push({ id: item.id, leadId: item.leadId, contactId: item.contactId, propertyId: item.propertyId, ownerUserId: item.ownerUserId, recipient: item.recipient, snapshot: item.snapshot,
      admittedAt: iso(item.admittedAt), stoppedAt: iso(item.stoppedAt), stopReason: item.stopReason, readiness: { ready, reason, nextCheckAt: plan.state === "running" ? iso(plan.nextCheckAt) : null }, mailboxSync, steps: sequence,
      outcomes: { leadStatus: lead?.status ?? "unavailable", replyIds: replies.map(row => row.id), taskIds: replies.flatMap(row => row.taskId ? [row.taskId] : []), appointmentIds: appointments.map(row => row.id) } });
  }
  return sourceNurtureDetailSchema.parse({ organizationId: org, id: plan.id, version: plan.version, state: plan.state, payloadSha256: plan.payloadSha256, settings: plan.settings, reviewId: plan.reviewId,
    createdByUserId: plan.createdByUserId, approvedByUserId: plan.approvedByUserId, createdAt: iso(plan.createdAt), previewExpiresAt: iso(plan.previewExpiresAt), startNotBefore: iso(plan.startNotBefore), expiresAt: iso(plan.expiresAt),
    approvedAt: iso(plan.approvedAt), startedAt: iso(plan.startedAt), stoppedAt: iso(plan.stoppedAt), stopReason: plan.stopReason,
    readiness: { ready: cohort.some(row => row.readiness.ready), reason: plan.lastCode ?? cohort.find(row => row.readiness.reason)?.readiness.reason ?? null, nextCheckAt: plan.state === "running" ? iso(plan.nextCheckAt) : null },
    limits: { maxRecipients: 10, steps: 2, minSpacingHours: 72, maxLifetimeDays: 14 }, items: cohort });
}
export async function listSourceNurture(org: string, bucket: "attention" | "waiting" | "history", offset: number) {
  const input = sourceNurtureListQuerySchema.parse({ bucket, offset });
  const terminal = inArray(plans.state, ["stopped", "finished", "expired"]);
  const held = sql`(${plans.state} in ('draft','approved') or (${plans.state} = 'running' and ${plans.lastCode} is not null and ${plans.lastCode} not like 'waiting:%'))`;
  const rows = await db.select().from(plans).where(and(eq(plans.organizationId, org), input.bucket === "history" ? terminal : input.bucket === "attention" ? held : and(eq(plans.state, "running"), sql`(${plans.lastCode} is null or ${plans.lastCode} like 'waiting:%')`)))
    .orderBy(asc(plans.createdAt), asc(plans.id)).limit(26).offset(input.offset);
  const summaries = [];
  for (const row of rows.slice(0, 25)) {
    const detail = await getSourceNurture(org, row.id), sequence = detail.items.flatMap(item => item.steps);
    summaries.push({ id: row.id, version: row.version, state: row.state, payloadSha256: row.payloadSha256, createdAt: iso(row.createdAt), expiresAt: iso(row.expiresAt), recipientCount: detail.items.length,
      acceptedSteps: sequence.filter(step => step.state === "accepted").length, uncertainSteps: sequence.filter(step => step.state === "uncertain").length, reason: detail.readiness.reason, nextCheckAt: detail.readiness.nextCheckAt });
  }
  return sourceNurtureListSchema.parse({ organizationId: org, bucket: input.bucket, offset: input.offset, limit: 25, hasMore: rows.length > 25, items: summaries });
}
