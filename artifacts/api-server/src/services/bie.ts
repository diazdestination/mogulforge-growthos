/**
 * MogulForge BIE — Revenue Command Center
 *
 * A deterministic, evidence-first orchestration layer over the CRM. The
 * language model may later narrate or prioritize this data, but no BIE claim
 * or action depends on a model response. That preserves trustworthy value on
 * day one and makes every recommendation inspectable.
 */
import {
  activitiesTable,
  bieActionProposalsTable,
  bieAgentRunsTable,
  bieAutopilotPoliciesTable,
  bieConnectedSourcesTable,
  contactsTable,
  db,
  leadsTable,
  type BieActionProposal,
  type BieActionStatus,
  type BieActionType,
  type BieAutopilotPolicy,
  type BieSource,
} from "@workspace/db";
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";

import * as crm from "./crm";
import { recordAudit } from "./audit";
import { getBusinessName } from "./settings";
import { getEmailProviderStatus, providers } from "./providers";
import { checkSendEligibility, recordBlockedSend } from "./send-gate";

const SOURCES: BieSource[] = [
  "google_ads",
  "google_analytics",
  "search_console",
  "business_profile",
];

const DEFAULT_POLICY: BieAutopilotPolicy = {
  enabled: false,
  allowedActions: [],
  dailyEmailCap: 20,
  pausedAt: null,
  pauseReason: null,
};

type BriefingOpportunityKind = "stalled_estimate" | "dormant_pipeline" | "data_quality";

export interface BriefingOpportunity {
  kind: BriefingOpportunityKind;
  title: string;
  detail: string;
  count: number;
  estimatedValueCents: number;
  confidence: "observed" | "partial";
  leadIds: string[];
}

export interface RevenueRecoveryBriefing {
  generatedAt: string;
  totalLeads: number;
  importedLeads: number;
  dataReadiness: {
    score: number;
    leadsWithContactMethod: number;
    leadsWithKnownValue: number;
    googleSourcesConnected: number;
    totalGoogleSources: number;
  };
  revenueAtRiskCents: number;
  unknownValueLeadCount: number;
  opportunityCount: number;
  opportunities: BriefingOpportunity[];
  narrative: string;
  sources: Awaited<ReturnType<typeof listBieSources>>;
  policy: BieAutopilotPolicy;
}

function asDate(value: unknown): Date | null {
  if (value instanceof Date) return value;
  if (typeof value === "string") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

function daysSince(value: unknown): number {
  const date = asDate(value);
  if (!date) return Number.POSITIVE_INFINITY;
  return Math.max(0, Math.floor((Date.now() - date.getTime()) / 86_400_000));
}

function dollars(cents: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(cents / 100);
}

function defaultSource(source: BieSource) {
  return {
    id: `virtual:${source}`,
    source,
    status: "not_connected" as const,
    accountLabel: null,
    grantedScopes: [],
    lastSyncedAt: null,
    lastError: null,
    metadata: {},
    createdAt: null,
    updatedAt: null,
  };
}

/** Returns the four beta Google sources, including honest virtual disconnected states. */
export async function listBieSources(organizationId: string) {
  const rows = await db
    .select()
    .from(bieConnectedSourcesTable)
    .where(eq(bieConnectedSourcesTable.organizationId, organizationId));
  const byKind = new Map(rows.map((row) => [row.source, row]));
  return SOURCES.map((source) => byKind.get(source) ?? defaultSource(source));
}

export async function getAutopilotPolicy(organizationId: string): Promise<BieAutopilotPolicy> {
  const [row] = await db
    .select({ policy: bieAutopilotPoliciesTable.policy })
    .from(bieAutopilotPoliciesTable)
    .where(eq(bieAutopilotPoliciesTable.organizationId, organizationId));
  if (!row?.policy) return { ...DEFAULT_POLICY };
  return {
    ...DEFAULT_POLICY,
    ...row.policy,
    allowedActions: Array.isArray(row.policy.allowedActions) ? row.policy.allowedActions : [],
  };
}

export async function updateAutopilotPolicy(
  organizationId: string,
  actorUserId: string,
  input: Partial<BieAutopilotPolicy>,
): Promise<BieAutopilotPolicy> {
  const current = await getAutopilotPolicy(organizationId);
  const allowedActions = Array.isArray(input.allowedActions)
    ? input.allowedActions.filter((value): value is BieActionType =>
        ["create_task", "change_stage", "send_email"].includes(value),
      )
    : current.allowedActions;
  const policy: BieAutopilotPolicy = {
    ...current,
    ...input,
    allowedActions: [...new Set(allowedActions)],
    dailyEmailCap: Math.min(100, Math.max(1, Math.floor(input.dailyEmailCap ?? current.dailyEmailCap))),
    pausedAt: input.enabled === true ? null : input.pausedAt ?? current.pausedAt ?? null,
    pauseReason: input.enabled === true ? null : input.pauseReason ?? current.pauseReason ?? null,
  };
  await db
    .insert(bieAutopilotPoliciesTable)
    .values({ organizationId, policy, updatedByUserId: actorUserId })
    .onConflictDoUpdate({
      target: bieAutopilotPoliciesTable.organizationId,
      set: { policy, updatedByUserId: actorUserId, updatedAt: new Date() },
    });
  await recordAudit({
    organizationId,
    actorUserId,
    action: "bie.autopilot_policy_updated",
    entityType: "bie_autopilot_policy",
    metadata: { enabled: policy.enabled, allowedActions: policy.allowedActions, dailyEmailCap: policy.dailyEmailCap },
  });
  return policy;
}

/**
 * Build an evidence-backed recovery briefing from tenant-owned CRM records.
 * Values are sums of known lead values, not predicted or claimed revenue.
 */
export async function buildRevenueRecoveryBriefing(
  organizationId: string,
): Promise<RevenueRecoveryBriefing> {
  const leadRows = await db
    .select({
      id: leadsTable.id,
      status: leadsTable.status,
      score: leadsTable.score,
      urgency: leadsTable.urgency,
      estimatedValueCents: leadsTable.estimatedValueCents,
      creationMethod: leadsTable.creationMethod,
      createdAt: leadsTable.createdAt,
      updatedAt: leadsTable.updatedAt,
      summary: leadsTable.summary,
      firstName: contactsTable.firstName,
      lastName: contactsTable.lastName,
      email: contactsTable.email,
      phone: contactsTable.phone,
    })
    .from(leadsTable)
    .innerJoin(contactsTable, eq(leadsTable.contactId, contactsTable.id))
    .where(eq(leadsTable.organizationId, organizationId))
    .orderBy(desc(leadsTable.estimatedValueCents), desc(leadsTable.createdAt))
    .limit(5_000);

  const leadIds = leadRows.map((lead) => lead.id);
  const activityRows = leadIds.length
    ? await db
        .select({
          leadId: activitiesTable.leadId,
          lastActivityAt: sql<Date | null>`max(${activitiesTable.occurredAt})`,
        })
        .from(activitiesTable)
        .where(
          and(
            eq(activitiesTable.organizationId, organizationId),
            inArray(activitiesTable.leadId, leadIds),
          ),
        )
        .groupBy(activitiesTable.leadId)
    : [];
  const latestActivity = new Map(activityRows.map((row) => [row.leadId, row.lastActivityAt]));

  const activeForRecovery = new Set(["new", "contact_attempted", "follow_up", "nurture", "lost"]);
  const stalledEstimate = leadRows.filter((lead) => {
    const quietDays = daysSince(latestActivity.get(lead.id) ?? lead.updatedAt ?? lead.createdAt);
    return ["estimate_sent", "claim_pending"].includes(lead.status) && quietDays >= 7;
  });
  const dormantPipeline = leadRows.filter((lead) => {
    const quietDays = daysSince(latestActivity.get(lead.id) ?? lead.updatedAt ?? lead.createdAt);
    return activeForRecovery.has(lead.status) && quietDays >= 14;
  });
  const valueOf = (rows: typeof leadRows) =>
    rows.reduce((total, lead) => total + Math.max(0, lead.estimatedValueCents ?? 0), 0);
  const emailReady = leadRows.filter((lead) => Boolean(lead.email));
  const knownValue = leadRows.filter((lead) => typeof lead.estimatedValueCents === "number");
  const importedLeads = leadRows.filter((lead) => lead.creationMethod === "import").length;
  const sources = await listBieSources(organizationId);
  const policy = await getAutopilotPolicy(organizationId);
  const connectedSources = sources.filter((source) => source.status === "connected").length;
  const readinessParts = [
    leadRows.length > 0 ? 25 : 0,
    leadRows.length ? Math.round((emailReady.length / leadRows.length) * 25) : 0,
    leadRows.length ? Math.round((knownValue.length / leadRows.length) * 30) : 0,
    Math.round((connectedSources / SOURCES.length) * 20),
  ];
  const dataReadinessScore = Math.min(100, readinessParts.reduce((a, b) => a + b, 0));

  const opportunities: BriefingOpportunity[] = [];
  if (stalledEstimate.length > 0) {
    opportunities.push({
      kind: "stalled_estimate",
      title: "Stalled estimates and pending claims",
      detail: `${stalledEstimate.length} records have sat without activity for at least 7 days.`,
      count: stalledEstimate.length,
      estimatedValueCents: valueOf(stalledEstimate),
      confidence: stalledEstimate.every((lead) => lead.estimatedValueCents != null) ? "observed" : "partial",
      leadIds: stalledEstimate.slice(0, 50).map((lead) => lead.id),
    });
  }
  if (dormantPipeline.length > 0) {
    opportunities.push({
      kind: "dormant_pipeline",
      title: "Dormant pipeline opportunities",
      detail: `${dormantPipeline.length} active or previously lost leads have had no activity for at least 14 days.`,
      count: dormantPipeline.length,
      estimatedValueCents: valueOf(dormantPipeline),
      confidence: dormantPipeline.every((lead) => lead.estimatedValueCents != null) ? "observed" : "partial",
      leadIds: dormantPipeline.slice(0, 50).map((lead) => lead.id),
    });
  }
  const missingValue = leadRows.filter((lead) => lead.estimatedValueCents == null).length;
  if (missingValue > 0) {
    opportunities.push({
      kind: "data_quality",
      title: "Revenue data needs enrichment",
      detail: `${missingValue} leads have no known estimated value, so BIE will not count them in revenue-at-risk totals.`,
      count: missingValue,
      estimatedValueCents: 0,
      confidence: "observed",
      leadIds: leadRows.filter((lead) => lead.estimatedValueCents == null).slice(0, 50).map((lead) => lead.id),
    });
  }

  const revenueAtRiskCents = valueOf(stalledEstimate) + valueOf(dormantPipeline);
  const narrative =
    opportunities.length === 0
      ? "BIE does not see a qualifying recovery segment yet. Import more historical leads or continue operating the pipeline to build an evidence base."
      : `BIE found ${opportunities.filter((item) => item.kind !== "data_quality").reduce((total, item) => total + item.count, 0)} recovery candidates with ${dollars(revenueAtRiskCents)} in known lead value at risk. This is a pipeline estimate, not claimed revenue.`;

  return {
    generatedAt: new Date().toISOString(),
    totalLeads: leadRows.length,
    importedLeads,
    dataReadiness: {
      score: dataReadinessScore,
      leadsWithContactMethod: leadRows.filter((lead) => lead.email || lead.phone).length,
      leadsWithKnownValue: knownValue.length,
      googleSourcesConnected: connectedSources,
      totalGoogleSources: SOURCES.length,
    },
    revenueAtRiskCents,
    unknownValueLeadCount: missingValue,
    opportunityCount: opportunities.filter((item) => item.kind !== "data_quality").reduce((total, item) => total + item.count, 0),
    opportunities,
    narrative,
    sources,
    policy,
  };
}

export async function runRevenueRecoveryBriefing(
  organizationId: string,
  actorUserId: string,
): Promise<RevenueRecoveryBriefing> {
  const [run] = await db
    .insert(bieAgentRunsTable)
    .values({
      organizationId,
      kind: "revenue_recovery_briefing",
      status: "running",
      trigger: "manual",
      initiatedByUserId: actorUserId,
    })
    .returning({ id: bieAgentRunsTable.id });
  if (!run) throw new Error("Could not create the BIE briefing run.");
  try {
    const briefing = await buildRevenueRecoveryBriefing(organizationId);
    await db
      .update(bieAgentRunsTable)
      .set({
        status: "completed",
        summary: briefing.narrative,
        result: briefing as unknown as Record<string, unknown>,
        completedAt: new Date(),
      })
      .where(eq(bieAgentRunsTable.id, run.id));
    await recordAudit({
      organizationId,
      actorUserId,
      action: "bie.revenue_briefing_generated",
      entityType: "bie_agent_run",
      entityId: run.id,
      metadata: { opportunityCount: briefing.opportunityCount, revenueAtRiskCents: briefing.revenueAtRiskCents },
    });
    return briefing;
  } catch (error) {
    await db
      .update(bieAgentRunsTable)
      .set({ status: "failed", summary: error instanceof Error ? error.message : "BIE briefing failed", completedAt: new Date() })
      .where(eq(bieAgentRunsTable.id, run.id));
    throw error;
  }
}

type LeadForProposal = {
  id: string;
  contactId: string;
  status: string;
  estimatedValueCents: number | null;
  summary: string | null;
  firstName: string | null;
  email: string | null;
};

async function proposalCandidates(organizationId: string, limit: number): Promise<LeadForProposal[]> {
  const briefing = await buildRevenueRecoveryBriefing(organizationId);
  const ids = [...new Set(
    briefing.opportunities
      .filter((opportunity) => opportunity.kind !== "data_quality")
      .flatMap((opportunity) => opportunity.leadIds),
  )].slice(0, limit);
  if (ids.length === 0) return [];
  return db
    .select({
      id: leadsTable.id,
      contactId: leadsTable.contactId,
      status: leadsTable.status,
      estimatedValueCents: leadsTable.estimatedValueCents,
      summary: leadsTable.summary,
      firstName: contactsTable.firstName,
      email: contactsTable.email,
    })
    .from(leadsTable)
    .innerJoin(contactsTable, eq(leadsTable.contactId, contactsTable.id))
    .where(and(eq(leadsTable.organizationId, organizationId), inArray(leadsTable.id, ids)))
    .orderBy(desc(leadsTable.estimatedValueCents));
}

/** Create a reviewable, deduplicated action queue. It never sends anything. */
export async function generateBieProposals(
  organizationId: string,
  actorUserId: string,
): Promise<BieActionProposal[]> {
  const [run] = await db
    .insert(bieAgentRunsTable)
    .values({ organizationId, kind: "proposal_generation", status: "running", trigger: "manual", initiatedByUserId: actorUserId })
    .returning({ id: bieAgentRunsTable.id });
  if (!run) throw new Error("Could not create the BIE proposal run.");
  try {
  const candidates = await proposalCandidates(organizationId, 20);
  const active = await db
    .select({ leadId: bieActionProposalsTable.leadId, actionType: bieActionProposalsTable.actionType })
    .from(bieActionProposalsTable)
    .where(
      and(
        eq(bieActionProposalsTable.organizationId, organizationId),
        inArray(bieActionProposalsTable.status, ["proposed", "approved"]),
      ),
    );
  const activeKeys = new Set(active.map((item) => `${item.leadId}:${item.actionType}`));
  const businessName = await getBusinessName(organizationId);
  const inserts: Array<typeof bieActionProposalsTable.$inferInsert> = [];
  for (const lead of candidates) {
    const value = lead.estimatedValueCents ?? null;
    const evidence = {
      leadStatus: lead.status,
      knownLeadValueCents: value,
      leadSummary: lead.summary,
      source: "bie.revenue_recovery_briefing",
    };
    if (lead.email && !activeKeys.has(`${lead.id}:send_email`)) {
      inserts.push({
        organizationId,
        runId: run.id,
        leadId: lead.id,
        actionType: "send_email",
        status: "proposed",
        title: "Send a recovery check-in",
        rationale: "This lead is in an evidence-backed stale pipeline segment. The message remains subject to send caps, quiet hours, suppression, and provider readiness.",
        evidence,
        payload: {
          subject: `A quick check-in from ${businessName}`,
          body: `Hi ${lead.firstName || "there"},\n\nI wanted to check in and see whether you still need help with your project. If timing or priorities have changed, reply here and we will make the next step easy.\n\n— ${businessName}`,
        },
        estimatedValueCents: value,
        createdByUserId: actorUserId,
      });
    }
    if (!activeKeys.has(`${lead.id}:create_task`)) {
      inserts.push({
        organizationId,
        runId: run.id,
        leadId: lead.id,
        actionType: "create_task",
        status: "proposed",
        title: "Assign a recovery follow-up task",
        rationale: "A human follow-up preserves momentum when outreach is not ready or the owner prefers a personal call.",
        evidence,
        payload: { title: "BIE recovery follow-up", description: "Review the BIE evidence and contact this opportunity.", priority: "high" },
        estimatedValueCents: value,
        createdByUserId: actorUserId,
      });
    }
    if (["new", "contact_attempted", "nurture"].includes(lead.status) && !activeKeys.has(`${lead.id}:change_stage`)) {
      inserts.push({
        organizationId,
        runId: run.id,
        leadId: lead.id,
        actionType: "change_stage",
        status: "proposed",
        title: "Move lead into deliberate follow-up",
        rationale: "The current stage does not reflect an active recovery sequence. This change is fully auditable and can be rejected.",
        evidence,
        payload: { status: "follow_up" },
        estimatedValueCents: value,
        createdByUserId: actorUserId,
      });
    }
  }
  const proposals = inserts.length
    ? await db.insert(bieActionProposalsTable).values(inserts).returning()
    : [];
  await db
    .update(bieAgentRunsTable)
    .set({ status: "completed", summary: `${proposals.length} action proposals generated`, result: { proposalCount: proposals.length }, completedAt: new Date() })
    .where(eq(bieAgentRunsTable.id, run.id));
  await recordAudit({
    organizationId,
    actorUserId,
    action: "bie.action_proposals_generated",
    entityType: "bie_agent_run",
    entityId: run.id,
    metadata: { proposalCount: proposals.length },
  });
  return proposals;
  } catch (error) {
    await db
      .update(bieAgentRunsTable)
      .set({
        status: "failed",
        summary: error instanceof Error ? error.message.slice(0, 500) : "BIE proposal generation failed",
        completedAt: new Date(),
      })
      .where(eq(bieAgentRunsTable.id, run.id));
    throw error;
  }
}

export async function listBieProposals(organizationId: string) {
  return db
    .select()
    .from(bieActionProposalsTable)
    .where(eq(bieActionProposalsTable.organizationId, organizationId))
    .orderBy(desc(bieActionProposalsTable.createdAt))
    .limit(200);
}

async function getProposal(organizationId: string, actionId: string) {
  const [proposal] = await db
    .select()
    .from(bieActionProposalsTable)
    .where(and(eq(bieActionProposalsTable.id, actionId), eq(bieActionProposalsTable.organizationId, organizationId)));
  return proposal ?? null;
}

export async function reviewBieProposal(
  organizationId: string,
  actionId: string,
  actorUserId: string,
  decision: "approve" | "reject",
): Promise<BieActionProposal | null> {
  const proposal = await getProposal(organizationId, actionId);
  if (!proposal || proposal.status !== "proposed") return null;
  const nextStatus: BieActionStatus = decision === "approve" ? "approved" : "rejected";
  const [updated] = await db
    .update(bieActionProposalsTable)
    .set({ status: nextStatus, reviewedByUserId: actorUserId, reviewedAt: new Date() })
    .where(eq(bieActionProposalsTable.id, proposal.id))
    .returning();
  await recordAudit({
    organizationId,
    actorUserId,
    action: decision === "approve" ? "bie.action_approved" : "bie.action_rejected",
    entityType: "bie_action_proposal",
    entityId: proposal.id,
    metadata: { actionType: proposal.actionType, leadId: proposal.leadId },
  });
  return updated ?? null;
}

async function markAction(
  id: string,
  status: BieActionStatus,
  detail: string,
): Promise<BieActionProposal | null> {
  const [updated] = await db
    .update(bieActionProposalsTable)
    .set({ status, executionDetail: detail, executedAt: status === "executed" ? new Date() : null })
    .where(eq(bieActionProposalsTable.id, id))
    .returning();
  return updated ?? null;
}

async function emailCapRemaining(organizationId: string, cap: number): Promise<boolean> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(bieActionProposalsTable)
    .where(
      and(
        eq(bieActionProposalsTable.organizationId, organizationId),
        eq(bieActionProposalsTable.actionType, "send_email"),
        eq(bieActionProposalsTable.status, "executed"),
        gte(bieActionProposalsTable.executedAt, since),
      ),
    );
  return Number(row?.count ?? 0) < cap;
}

/** Execute an approved proposal. Manual approval is required unless a later worker invokes this under enabled autopilot. */
export async function executeBieProposal(
  organizationId: string,
  actionId: string,
  actorUserId: string | null,
  options: { automated?: boolean } = {},
): Promise<BieActionProposal | null> {
  const proposal = await getProposal(organizationId, actionId);
  if (!proposal || proposal.status !== "approved") return null;
  const policy = await getAutopilotPolicy(organizationId);
  if (options.automated && (!policy.enabled || Boolean(policy.pausedAt) || !policy.allowedActions.includes(proposal.actionType))) {
    return markAction(proposal.id, "blocked", "Autopilot policy does not permit this action.");
  }
  const lead = await crm.getLead(organizationId, proposal.leadId);
  if (!lead) return markAction(proposal.id, "failed", "Lead no longer exists in this organization.");

  try {
    if (proposal.actionType === "create_task") {
      const task = await crm.createTask(organizationId, {
        leadId: lead.id,
        contactId: lead.contactId,
        assignedUserId: lead.assignedUserId,
        title: typeof proposal.payload.title === "string" ? proposal.payload.title : "BIE recovery follow-up",
        description: typeof proposal.payload.description === "string" ? proposal.payload.description : proposal.rationale,
        priority: proposal.payload.priority === "emergency" ? "emergency" : "high",
        sourceEvent: "bie.revenue_recovery",
      });
      if (!task) return markAction(proposal.id, "failed", "Could not create a task for this organization.");
      await recordAudit({ organizationId, actorUserId, action: "bie.task_created", entityType: "bie_action_proposal", entityId: proposal.id, metadata: { taskId: task.id, leadId: lead.id } });
      return markAction(proposal.id, "executed", `Created task ${task.id}.`);
    }

    if (proposal.actionType === "change_stage") {
      const nextStatus = typeof proposal.payload.status === "string" ? proposal.payload.status : "follow_up";
      const updated = await crm.updateLead(organizationId, lead.id, { status: nextStatus } as never);
      if (!updated) return markAction(proposal.id, "failed", "Could not update this lead's stage.");
      await recordAudit({ organizationId, actorUserId, action: "bie.stage_changed", entityType: "bie_action_proposal", entityId: proposal.id, metadata: { leadId: lead.id, from: lead.status, to: nextStatus } });
      return markAction(proposal.id, "executed", `Moved lead from ${lead.status} to ${nextStatus}.`);
    }

    const contact = await crm.getContact(organizationId, lead.contactId);
    if (!contact?.email) return markAction(proposal.id, "blocked", "The lead has no email address.");
    const provider = await getEmailProviderStatus();
    if (provider.provider === "mock") return markAction(proposal.id, "blocked", "Connect Gmail or configure Resend before BIE can send email.");
    if (!(await emailCapRemaining(organizationId, policy.dailyEmailCap))) {
      return markAction(proposal.id, "blocked", `BIE daily email cap (${policy.dailyEmailCap}) has been reached.`);
    }
    const eligibility = await checkSendEligibility({
      organizationId,
      contact,
      channel: "email",
      kind: "outreach",
    });
    if (!eligibility.ok) {
      await recordBlockedSend({
        organizationId,
        channel: "email",
        outcome: eligibility.outcome,
        reason: eligibility.reason,
        source: "bie.revenue_recovery",
        leadId: lead.id,
        contactId: contact.id,
        resumeAt: "resumeAt" in eligibility ? eligibility.resumeAt : undefined,
      });
      return markAction(proposal.id, "blocked", `Email ${eligibility.outcome}: ${eligibility.reason}.`);
    }
    const subject = typeof proposal.payload.subject === "string" ? proposal.payload.subject : "A quick check-in";
    const body = typeof proposal.payload.body === "string" ? proposal.payload.body : proposal.rationale;
    const sent = await providers.email.send(contact.email, subject, body);
    await crm.createActivity(organizationId, {
      leadId: lead.id,
      contactId: contact.id,
      actorUserId,
      type: "bie_email_sent",
      title: `BIE email sent: ${subject}`,
      body: body.slice(0, 300),
      metadata: { channel: "email", to: contact.email, provider: sent.provider, providerMessageId: sent.id, source: "bie.revenue_recovery" },
    });
    await recordAudit({ organizationId, actorUserId, action: "bie.email_sent", entityType: "bie_action_proposal", entityId: proposal.id, metadata: { leadId: lead.id, provider: sent.provider } });
    return markAction(proposal.id, "executed", `Email sent through ${sent.provider}.`);
  } catch (error) {
    return markAction(proposal.id, "failed", error instanceof Error ? error.message.slice(0, 500) : "Action failed.");
  }
}

/** Execute all currently approved proposals allowed by the enabled org policy. */
export async function runAutopilot(organizationId: string): Promise<BieActionProposal[]> {
  const policy = await getAutopilotPolicy(organizationId);
  if (!policy.enabled || policy.pausedAt || policy.allowedActions.length === 0) return [];
  const approved = await db
    .select({ id: bieActionProposalsTable.id })
    .from(bieActionProposalsTable)
    .where(
      and(
        eq(bieActionProposalsTable.organizationId, organizationId),
        eq(bieActionProposalsTable.status, "approved"),
        inArray(bieActionProposalsTable.actionType, policy.allowedActions),
      ),
    )
    .orderBy(bieActionProposalsTable.createdAt)
    .limit(50);
  const results: BieActionProposal[] = [];
  for (const action of approved) {
    const proposal = await getProposal(organizationId, action.id);
    const result = await executeBieProposal(
      organizationId,
      action.id,
      proposal?.reviewedByUserId ?? proposal?.createdByUserId ?? null,
      { automated: true },
    );
    if (result) results.push(result);
  }
  return results;
}
