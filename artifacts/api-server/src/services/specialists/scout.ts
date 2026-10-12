/**
 * SCOUT — deterministic follow-up specialist (proposal-only).
 *
 * Grounded in the HVAC owner intake: an unanswered estimate gets three
 * reminders 24 hours apart, then a staff phone call; nothing is sent without
 * a staff choice. SCOUT therefore only proposes the next step into the BIE
 * queue. Email reminders become ordinary `send_email` drafts that still need
 * the existing prepare → exact-payload approval → execute path. There is no
 * SMS action in the BIE queue, so a text reminder is proposed as a staff task.
 *
 * No model is called. Every proposal records the facts that triggered it.
 */
import {
  activitiesTable,
  appointmentsTable,
  bieActionProposalsTable,
  contactsTable,
  db,
  estimatesTable,
  leadsTable,
  type BieActionProposal,
} from "@workspace/db";
import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";

import { getBusinessName } from "../settings";
import { needsSourceVerification, originalOpportunityDate, sourceLastContactDate } from "../source-history";
import { hasCustomerReplyHold } from "../response-correlation";
import {
  OPEN_PROPOSAL_STATUSES,
  insertSpecialistProposals,
  specialistSubjectKeys,
  withSpecialistRun,
  type SpecialistProposalDraft,
} from "./contract";

/** Owner-intake default cadence. Changing it is a reviewed code/config change, not a model decision. */
export const SCOUT_CADENCE = {
  reminderCount: 3,
  reminderIntervalHours: 24,
  staleLeadDays: 7,
} as const;

const HOUR = 3_600_000;
const CLOSED_LEAD_STATUSES = new Set([
  "won", "lost", "nurture", "scheduled", "inspection_scheduled", "production_scheduled",
  "in_progress", "final_walkthrough", "completed", "review_requested",
]);
const STALE_LEAD_STATUSES = new Set(["new", "ai_qualified", "contact_attempted", "follow_up"]);
const STAGE_TO_FOLLOW_UP = new Set(["new", "ai_qualified", "contact_attempted"]);
/** Customer-originated signals; staff notes and assignment are not customer contact. */
const INBOUND_ACTIVITY = ["portal_message", "customer_reply", "email_received", "sms_received"];
const CUSTOMER_STEP_ACTIVITY = [
  ...INBOUND_ACTIVITY, "email_sent", "sms_sent", "bie_email_sent", "call_completed",
  "contact_attempt_logged", "smart_site_contact_attempt",
];

export interface ScoutEstimateFact {
  estimateId: string;
  leadId: string;
  leadStatus: string;
  estimateTitle: string;
  totalCents: number | null;
  sentAt: Date;
  contactFirstName: string | null;
  contactEmail: string | null;
  contactHasPhone: boolean;
  lastInboundAt: Date | null;
  replyHold: boolean;
  appointmentBooked: boolean;
}

export interface ScoutLeadFact {
  leadId: string;
  leadStatus: string;
  /** Null when an imported record has no source date; SCOUT does not guess one. */
  lastCustomerStepAt: Date | null;
  hasOpenEstimateCadence: boolean;
  importedNeedsReview: boolean;
  estimatedValueCents: number | null;
}

export type ScoutHistory = Map<string, Pick<BieActionProposal, "status" | "evidence" | "executedAt" | "reviewedAt" | "updatedAt">[]>;

export type ScoutDecision =
  | { kind: "draft"; draft: SpecialistProposalDraft }
  | { kind: "skip"; subject: string; reason: string };

const settled = (status: string) => status === "executed" || status === "rejected";
const open = (status: string) => ["proposed", "approved", "processing", "indeterminate"].includes(status);

/** Pure: the next cadence step for one sent estimate, or why there is none. */
export function planEstimateStep(fact: ScoutEstimateFact, history: ScoutHistory, now: Date, businessName: string): ScoutDecision {
  const prefix = `scout:estimate:${fact.estimateId}:step:`;
  const subject = `scout:estimate:${fact.estimateId}`;
  if (CLOSED_LEAD_STATUSES.has(fact.leadStatus)) return { kind: "skip", subject, reason: "lead_moved_on" };
  if (fact.lastInboundAt && fact.lastInboundAt > fact.sentAt) return { kind: "skip", subject, reason: "customer_responded" };
  if (fact.replyHold) return { kind: "skip", subject, reason: "customer_reply_hold" };
  if (fact.appointmentBooked) return { kind: "skip", subject, reason: "appointment_booked" };
  const priors = [...history.entries()].filter(([key]) => key.startsWith(prefix)).flatMap(([, rows]) => rows);
  // An indeterminate step is never re-proposed: reconcile it first.
  if (priors.some((row) => open(row.status))) return { kind: "skip", subject, reason: "step_awaiting_review_or_reconciliation" };
  const done = priors.filter((row) => settled(row.status));
  const completedStep = done.reduce((max, row) => Math.max(max, Number(row.evidence.step) || 0), 0);
  const step = completedStep + 1;
  const finalStep = SCOUT_CADENCE.reminderCount + 1;
  if (step > finalStep) return { kind: "skip", subject, reason: "cadence_complete" };
  const anchor = completedStep === 0
    ? fact.sentAt
    : new Date(Math.max(...done.filter((row) => Number(row.evidence.step) === completedStep)
        .map((row) => (row.executedAt ?? row.reviewedAt ?? row.updatedAt).getTime())));
  const dueAt = new Date(anchor.getTime() + SCOUT_CADENCE.reminderIntervalHours * HOUR);
  if (now < dueAt) return { kind: "skip", subject, reason: `step_${step}_due_${dueAt.toISOString()}` };
  const hoursSinceSent = Math.floor((now.getTime() - fact.sentAt.getTime()) / HOUR);
  const evidence = {
    rule: step <= SCOUT_CADENCE.reminderCount ? "unanswered_estimate_reminder" : "unanswered_estimate_call",
    estimateId: fact.estimateId,
    estimateTitle: fact.estimateTitle,
    estimateTotalCents: fact.totalCents,
    estimateSentAt: fact.sentAt.toISOString(),
    hoursSinceSent,
    lastCustomerResponseAt: fact.lastInboundAt?.toISOString() ?? null,
    leadStatus: fact.leadStatus,
    step,
    cadence: { ...SCOUT_CADENCE, finalStep },
    previousStepSettledAt: completedStep ? anchor.toISOString() : null,
  };
  const base = { leadId: fact.leadId, subjectKey: `${prefix}${step}`, estimatedValueCents: fact.totalCents, evidence };
  if (step <= SCOUT_CADENCE.reminderCount) {
    const label = `Estimate reminder ${step} of ${SCOUT_CADENCE.reminderCount}`;
    const why = `Estimate "${fact.estimateTitle}" was sent ${hoursSinceSent} hours ago with no recorded customer response. The configured cadence is ${SCOUT_CADENCE.reminderCount} reminders ${SCOUT_CADENCE.reminderIntervalHours} hours apart, then a staff call.`;
    if (fact.contactEmail) {
      return { kind: "draft", draft: { ...base, actionType: "send_email", title: label,
        rationale: `${why} Prepare and approve the exact message before anything is sent; a text reminder is not part of this queue.`,
        payload: {
          subject: `Following up on your estimate from ${businessName}`,
          body: `Hi ${fact.contactFirstName || "there"},\n\nI wanted to follow up on the estimate we sent for "${fact.estimateTitle}". Do you have any questions, or would you like to schedule the work? Reply here and we will take care of the next step.\n\n— ${businessName}`,
        } } };
    }
    return { kind: "draft", draft: { ...base, actionType: "create_task", title: `${label} (no email on file)`,
      rationale: `${why} No email address is on file, so a staff member should send the reminder by text or phone.`,
      payload: { title: `${label}: ${fact.estimateTitle}`, description: `${why} ${fact.contactHasPhone ? "Text or call the customer." : "No phone or email on file; update the contact first."}`, priority: "high" } } };
  }
  return { kind: "draft", draft: { ...base, actionType: "create_task", title: "Call about unanswered estimate",
    rationale: `All ${SCOUT_CADENCE.reminderCount} reminders for "${fact.estimateTitle}" are settled with no recorded customer response. The cadence calls for a staff phone call next.`,
    payload: { title: `Call customer about estimate: ${fact.estimateTitle}`, description: `Estimate sent ${hoursSinceSent} hours ago; ${SCOUT_CADENCE.reminderCount} reminders completed without a recorded reply. Call the customer and log the outcome.`, priority: "high" } } };
}

/** Pure: follow-up proposals for an open lead with no recent customer contact. */
export function planStaleLead(fact: ScoutLeadFact, history: ScoutHistory, now: Date): ScoutDecision[] {
  const subject = `scout:lead:${fact.leadId}`;
  if (!STALE_LEAD_STATUSES.has(fact.leadStatus)) return [{ kind: "skip", subject, reason: "status_not_open" }];
  if (fact.hasOpenEstimateCadence) return [{ kind: "skip", subject, reason: "estimate_cadence_owns_follow_up" }];
  if (!fact.lastCustomerStepAt) return [{ kind: "skip", subject, reason: "no_customer_contact_date" }];
  const quietDays = Math.floor((now.getTime() - fact.lastCustomerStepAt.getTime()) / 86_400_000);
  if (quietDays < SCOUT_CADENCE.staleLeadDays) return [{ kind: "skip", subject, reason: "recent_customer_contact" }];
  // Anchored to the last customer step: new contact creates a new subject, repeats do not.
  const anchor = fact.lastCustomerStepAt.toISOString().slice(0, 10);
  const evidence = { rule: "stale_open_lead", leadStatus: fact.leadStatus, lastCustomerStepAt: fact.lastCustomerStepAt.toISOString(), quietDays, staleAfterDays: SCOUT_CADENCE.staleLeadDays };
  const out: ScoutDecision[] = [];
  const taskKey = `${subject}:stale:${anchor}:task`;
  if (history.has(taskKey)) out.push({ kind: "skip", subject: taskKey, reason: "already_proposed_for_this_quiet_period" });
  else out.push({ kind: "draft", draft: { leadId: fact.leadId, actionType: "create_task", subjectKey: taskKey, evidence, estimatedValueCents: fact.estimatedValueCents,
    title: "Follow up with a quiet lead",
    rationale: `No customer contact has been recorded for ${quietDays} days (threshold ${SCOUT_CADENCE.staleLeadDays}). A staff follow-up keeps the opportunity owned.`,
    payload: { title: "SCOUT follow-up: quiet lead", description: `No recorded customer contact for ${quietDays} days. Review the lead and contact the customer.`, priority: "high" } } });
  const stageKey = `${subject}:stale:${anchor}:stage`;
  if (STAGE_TO_FOLLOW_UP.has(fact.leadStatus) && !fact.importedNeedsReview) {
    if (history.has(stageKey)) out.push({ kind: "skip", subject: stageKey, reason: "already_proposed_for_this_quiet_period" });
    else out.push({ kind: "draft", draft: { leadId: fact.leadId, actionType: "change_stage", subjectKey: stageKey, evidence, estimatedValueCents: fact.estimatedValueCents,
      title: "Move quiet lead into follow-up",
      rationale: `The lead is still "${fact.leadStatus}" after ${quietDays} quiet days. Moving it to follow-up makes the open work visible; reject if the stage is intentional.`,
      payload: { status: "follow_up" } } });
  }
  return out;
}

async function loadLeads(org: string) {
  return db
    .select({
      id: leadsTable.id, status: leadsTable.status, createdAt: leadsTable.createdAt, creationMethod: leadsTable.creationMethod,
      importedHistory: leadsTable.importedHistory, estimatedValueCents: leadsTable.estimatedValueCents,
      firstName: contactsTable.firstName, email: contactsTable.email, phone: contactsTable.phone,
    })
    .from(leadsTable)
    .innerJoin(contactsTable, and(eq(contactsTable.id, leadsTable.contactId), eq(contactsTable.organizationId, org)))
    .where(eq(leadsTable.organizationId, org))
    .orderBy(desc(leadsTable.createdAt))
    .limit(500);
}

export interface ScoutRunResult {
  runId: string;
  inserted: BieActionProposal[];
  skipped: Array<{ subject: string; reason: string }>;
}

/** Run SCOUT for one tenant. Inserts `proposed` rows only; returns what it inserted and skipped. */
export async function runScout(organizationId: string, actorUserId: string, now = new Date()): Promise<ScoutRunResult> {
  const businessName = await getBusinessName(organizationId);
  const leads = await loadLeads(organizationId);
  return withSpecialistRun({ organizationId, key: "scout", actorUserId }, async (tx, runId) => {
    const leadIds = leads.map((lead) => lead.id);
    const estimates = leadIds.length ? await tx.select({
      id: estimatesTable.id, leadId: estimatesTable.leadId, title: estimatesTable.title, totalCents: estimatesTable.totalCents, sentAt: estimatesTable.sentAt,
    }).from(estimatesTable).where(and(eq(estimatesTable.organizationId, organizationId), inArray(estimatesTable.leadId, leadIds),
      eq(estimatesTable.status, "sent"), isNotNull(estimatesTable.sentAt))).orderBy(desc(estimatesTable.sentAt)) : [];
    const latestEstimate = new Map<string, (typeof estimates)[number]>();
    for (const estimate of estimates) if (estimate.leadId && !latestEstimate.has(estimate.leadId)) latestEstimate.set(estimate.leadId, estimate);
    const activity = leadIds.length ? await tx.select({
      leadId: activitiesTable.leadId,
      inbound: sql<Date | null>`max(${activitiesTable.occurredAt}) filter (where ${inArray(activitiesTable.type, INBOUND_ACTIVITY)})`,
      customerStep: sql<Date | null>`max(${activitiesTable.occurredAt})`,
    }).from(activitiesTable).where(and(eq(activitiesTable.organizationId, organizationId), inArray(activitiesTable.leadId, leadIds),
      inArray(activitiesTable.type, CUSTOMER_STEP_ACTIVITY))).groupBy(activitiesTable.leadId) : [];
    const activityByLead = new Map(activity.map((row) => [row.leadId, row]));
    const booked = leadIds.length ? await tx.selectDistinct({ leadId: appointmentsTable.leadId }).from(appointmentsTable)
      .where(and(eq(appointmentsTable.organizationId, organizationId), inArray(appointmentsTable.leadId, leadIds),
        inArray(appointmentsTable.status, ["scheduled", "confirmed"]))) : [];
    const bookedLeads = new Set(booked.map((row) => row.leadId));
    const history = await specialistSubjectKeys(tx, organizationId, "scout");
    const asDate = (value: unknown) => (value == null ? null : new Date(value as string));

    const drafts: SpecialistProposalDraft[] = [];
    const skipped: Array<{ subject: string; reason: string }> = [];
    // Never stack a second open email on a lead, whichever proposer created the first.
    const openEmails = leadIds.length ? await tx.selectDistinct({ leadId: bieActionProposalsTable.leadId }).from(bieActionProposalsTable)
      .where(and(eq(bieActionProposalsTable.organizationId, organizationId), eq(bieActionProposalsTable.actionType, "send_email"),
        inArray(bieActionProposalsTable.status, [...OPEN_PROPOSAL_STATUSES]))) : [];
    const openEmailLeads = new Set(openEmails.map((row) => row.leadId));
    const take = (decision: ScoutDecision) => {
      if (decision.kind === "skip") { skipped.push(decision); return; }
      if (decision.draft.actionType === "send_email" && openEmailLeads.has(decision.draft.leadId)) {
        skipped.push({ subject: decision.draft.subjectKey, reason: "another_open_email_on_lead" }); return;
      }
      drafts.push(decision.draft);
    };
    for (const lead of leads) {
      const estimate = latestEstimate.get(lead.id);
      const acts = activityByLead.get(lead.id);
      if (estimate?.sentAt) {
        take(planEstimateStep({
          estimateId: estimate.id, leadId: lead.id, leadStatus: lead.status, estimateTitle: estimate.title, totalCents: estimate.totalCents,
          sentAt: estimate.sentAt, contactFirstName: lead.firstName, contactEmail: lead.email, contactHasPhone: Boolean(lead.phone),
          lastInboundAt: asDate(acts?.inbound), replyHold: await hasCustomerReplyHold(organizationId, lead.id, tx), appointmentBooked: bookedLeads.has(lead.id),
        }, history, now, businessName));
      }
      const steps = [asDate(acts?.customerStep), estimate?.sentAt ?? null, sourceLastContactDate(lead.importedHistory)]
        .filter((value): value is Date => Boolean(value) && Number.isFinite(value!.getTime()));
      const lastCustomerStepAt = steps.length ? new Date(Math.max(...steps.map((d) => d.getTime()))) : originalOpportunityDate(lead);
      for (const decision of planStaleLead({
        leadId: lead.id, leadStatus: lead.status, lastCustomerStepAt, hasOpenEstimateCadence: Boolean(estimate),
        importedNeedsReview: needsSourceVerification(lead), estimatedValueCents: lead.estimatedValueCents,
      }, history, now)) take(decision);
    }
    const { inserted, skippedOpen } = await insertSpecialistProposals(tx, { organizationId, runId, key: "scout", actorUserId, drafts });
    for (const subject of skippedOpen) skipped.push({ subject, reason: "open_proposal_exists" });
    return {
      inserted, skipped,
      summary: `SCOUT proposed ${inserted.length} follow-up action${inserted.length === 1 ? "" : "s"} for review.`,
      result: { leadsReviewed: leads.length, skippedCount: skipped.length, cadence: SCOUT_CADENCE },
    };
  });
}
