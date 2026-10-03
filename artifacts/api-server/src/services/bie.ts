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
  auditEventsTable,
  bieActionProposalsTable,
  bieAgentRunsTable,
  bieAutopilotPoliciesTable,
  bieConnectedSourcesTable,
  contactsTable,
  db,
  leadsTable,
  usersTable,
  appointmentsTable,
  estimatesTable,
  revenueExecutionsTable,
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
import { sendEmailForUser, getUserEmailStatus, emailAcceptanceEvidence } from "./user-email";
import { checkSendEligibility, recordBlockedSend } from "./send-gate";
import { runDurableAction } from "./durable-execution";
import { acceptContactTouch, assertContactTouchCurrent, ContactTouchDeferredError, markContactTouchDispatchStarted, type ContactTouchClaim } from "./contact-touch-claim";
import { hasPermission } from "../lib/permissions";
import { isDeepStrictEqual } from "node:util";
import { assertCapabilityForActor, CapabilityAccessError, getEntitlements } from "./entitlements";
import { needsSourceVerification, originalOpportunityDate, sourceLastContactDate } from "./source-history";
import { hasCustomerReplyHold } from "./response-correlation";
import { z } from "zod/v4";
import { EmailDispatchBlockedError } from "./email-dispatch-guard";
import { mailboxDigest } from "./mailbox-contract";
import { getMicrosoftMailboxIdentity, getLeadMonitoringApproval, assertLeadMonitoringApproval } from "./mailbox-connector";
import { reserveLeadMailboxParent, recordMailboxParentAcceptance, leadReplySendSnapshotSchema, type LeadReplySendSnapshot } from "./mailbox-communication";

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

type BriefingOpportunityKind =
  "stalled_estimate" | "dormant_pipeline" | "data_quality";

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

export async function getAutopilotPolicy(
  organizationId: string,
): Promise<BieAutopilotPolicy> {
  const [row] = await db
    .select({ policy: bieAutopilotPoliciesTable.policy })
    .from(bieAutopilotPoliciesTable)
    .where(eq(bieAutopilotPoliciesTable.organizationId, organizationId));
  if (!row?.policy) return { ...DEFAULT_POLICY };
  return {
    ...DEFAULT_POLICY,
    ...row.policy,
    allowedActions: Array.isArray(row.policy.allowedActions)
      ? row.policy.allowedActions
      : [],
  };
}

export async function updateAutopilotPolicy(
  organizationId: string,
  actorUserId: string,
  input: Partial<BieAutopilotPolicy>,
): Promise<BieAutopilotPolicy> {
  const [actor] = await db.select({ role: usersTable.role }).from(usersTable).where(and(
    eq(usersTable.id, actorUserId),
    eq(usersTable.organizationId, organizationId),
    eq(usersTable.isActive, true),
  ));
  if (!actor || !hasPermission(actor.role, "settings.manage"))
    throw new CapabilityAccessError("revenue.autopilot", "permission_required", "An active company owner or administrator must manage automated execution.");
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
    dailyEmailCap: Math.min(
      100,
      Math.max(1, Math.floor(input.dailyEmailCap ?? current.dailyEmailCap)),
    ),
    pausedAt:
      input.enabled === true
        ? null
        : (input.pausedAt ?? current.pausedAt ?? null),
    pauseReason:
      input.enabled === true
        ? null
        : (input.pauseReason ?? current.pauseReason ?? null),
  };
  // Pausing/disabling remains available even when the package no longer allows execution.
  if (policy.enabled && !policy.pausedAt)
    await assertCapabilityForActor(organizationId, actorUserId, "revenue.autopilot", "settings.manage");
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
    metadata: {
      enabled: policy.enabled,
      allowedActions: policy.allowedActions,
      dailyEmailCap: policy.dailyEmailCap,
    },
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
      importedHistory: leadsTable.importedHistory,
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
            inArray(activitiesTable.type, [
              "portal_message",
              "customer_reply",
              "email_received",
              "sms_received",
              "email_sent",
              "sms_sent",
              "bie_email_sent",
              "call_completed",
              "contact_attempt_logged",
              "smart_site_contact_attempt",
            ]),
          ),
        )
        .groupBy(activitiesTable.leadId)
    : [];
  const latestActivity = new Map(
    activityRows.map((row) => [row.leadId, row.lastActivityAt]),
  );
  const sentEstimates = leadIds.length
    ? await db
        .select({
          leadId: estimatesTable.leadId,
          sentAt: sql<Date | null>`max(${estimatesTable.sentAt})`,
        })
        .from(estimatesTable)
        .where(
          and(
            eq(estimatesTable.organizationId, organizationId),
            inArray(estimatesTable.leadId, leadIds),
          ),
        )
        .groupBy(estimatesTable.leadId)
    : [];
  const lastEstimate = new Map(
    sentEstimates.map((row) => [row.leadId, row.sentAt]),
  );
  const lastCustomerStep = (lead: (typeof leadRows)[number]) => {
    const dates = [latestActivity.get(lead.id), lastEstimate.get(lead.id), sourceLastContactDate(lead.importedHistory)]
      .map(asDate)
      .filter((value): value is Date => Boolean(value) && Number.isFinite(value!.getTime()))
      .map((value) => value.getTime());
    // Assignment, enrichment and internal notes are not customer contact.
    return dates.length ? new Date(Math.max(...dates)) : originalOpportunityDate(lead);
  };

  const activeForRecovery = new Set([
    "new",
    "contact_attempted",
    "follow_up",
    "nurture",
    "lost",
  ]);
  const stalledEstimate = leadRows.filter((lead) => {
    const lastStep = lastCustomerStep(lead);
    if (!lastStep) return false;
    const quietDays = daysSince(lastStep);
    return (
      ["estimate_sent", "claim_pending"].includes(lead.status) && quietDays >= 7
    );
  });
  const dormantPipeline = leadRows.filter((lead) => {
    const lastStep = lastCustomerStep(lead);
    if (!lastStep) return false;
    const quietDays = daysSince(lastStep);
    return activeForRecovery.has(lead.status) && quietDays >= 14;
  });
  const valueOf = (rows: typeof leadRows) =>
    rows.reduce(
      (total, lead) => total + Math.max(0, lead.estimatedValueCents ?? 0),
      0,
    );
  const emailReady = leadRows.filter((lead) => Boolean(lead.email));
  const knownValue = leadRows.filter(
    (lead) => typeof lead.estimatedValueCents === "number",
  );
  const importedLeads = leadRows.filter(
    (lead) => lead.creationMethod === "import",
  ).length;
  const sources = await listBieSources(organizationId);
  const policy = await getAutopilotPolicy(organizationId);
  const connectedSources = sources.filter(
    (source) => source.status === "connected",
  ).length;
  const readinessParts = [
    leadRows.length > 0 ? 25 : 0,
    leadRows.length
      ? Math.round((emailReady.length / leadRows.length) * 25)
      : 0,
    leadRows.length
      ? Math.round((knownValue.length / leadRows.length) * 30)
      : 0,
    Math.round((connectedSources / SOURCES.length) * 20),
  ];
  const dataReadinessScore = Math.min(
    100,
    readinessParts.reduce((a, b) => a + b, 0),
  );

  const opportunities: BriefingOpportunity[] = [];
  if (stalledEstimate.length > 0) {
    opportunities.push({
      kind: "stalled_estimate",
      title: "Stalled estimates and pending claims",
      detail: `${stalledEstimate.length} records have sat without activity for at least 7 days.`,
      count: stalledEstimate.length,
      estimatedValueCents: valueOf(stalledEstimate),
      confidence: stalledEstimate.every(
        (lead) => lead.estimatedValueCents != null,
      )
        ? "observed"
        : "partial",
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
      confidence: dormantPipeline.every(
        (lead) => lead.estimatedValueCents != null,
      )
        ? "observed"
        : "partial",
      leadIds: dormantPipeline.slice(0, 50).map((lead) => lead.id),
    });
  }
  const missingValue = leadRows.filter(
    (lead) => lead.estimatedValueCents == null,
  ).length;
  if (missingValue > 0) {
    opportunities.push({
      kind: "data_quality",
      title: "Revenue data needs enrichment",
      detail: `${missingValue} leads have no known estimated value, so BIE will not count them in revenue-at-risk totals.`,
      count: missingValue,
      estimatedValueCents: 0,
      confidence: "observed",
      leadIds: leadRows
        .filter((lead) => lead.estimatedValueCents == null)
        .slice(0, 50)
        .map((lead) => lead.id),
    });
  }

  const revenueAtRiskCents =
    valueOf(stalledEstimate) + valueOf(dormantPipeline);
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
      leadsWithContactMethod: leadRows.filter(
        (lead) => lead.email || lead.phone,
      ).length,
      leadsWithKnownValue: knownValue.length,
      googleSourcesConnected: connectedSources,
      totalGoogleSources: SOURCES.length,
    },
    revenueAtRiskCents,
    unknownValueLeadCount: missingValue,
    opportunityCount: opportunities
      .filter((item) => item.kind !== "data_quality")
      .reduce((total, item) => total + item.count, 0),
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
      metadata: {
        opportunityCount: briefing.opportunityCount,
        revenueAtRiskCents: briefing.revenueAtRiskCents,
      },
    });
    return briefing;
  } catch (error) {
    await db
      .update(bieAgentRunsTable)
      .set({
        status: "failed",
        summary: error instanceof Error ? error.message : "BIE briefing failed",
        completedAt: new Date(),
      })
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

async function proposalCandidates(
  organizationId: string,
  limit: number,
): Promise<LeadForProposal[]> {
  const briefing = await buildRevenueRecoveryBriefing(organizationId);
  const ids = [
    ...new Set(
      briefing.opportunities
        .filter((opportunity) => opportunity.kind !== "data_quality")
        .flatMap((opportunity) => opportunity.leadIds),
    ),
  ].slice(0, limit);
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
    .where(
      and(
        eq(leadsTable.organizationId, organizationId),
        inArray(leadsTable.id, ids),
      ),
    )
    .orderBy(desc(leadsTable.estimatedValueCents));
}

/** Create a reviewable, deduplicated action queue. It never sends anything. */
export async function generateBieProposals(
  organizationId: string,
  actorUserId: string,
): Promise<BieActionProposal[]> {
  // Serialize only this tenant's generators; separate clients never share a queue.
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`bie-proposals:${organizationId}`}, 0))`,
    );
    return generateBieProposalsOwned(organizationId, actorUserId);
  });
}

async function generateBieProposalsOwned(
  organizationId: string,
  actorUserId: string,
): Promise<BieActionProposal[]> {
  const [run] = await db
    .insert(bieAgentRunsTable)
    .values({
      organizationId,
      kind: "proposal_generation",
      status: "running",
      trigger: "manual",
      initiatedByUserId: actorUserId,
    })
    .returning({ id: bieAgentRunsTable.id });
  if (!run) throw new Error("Could not create the BIE proposal run.");
  try {
    const candidates = await proposalCandidates(organizationId, 20);
    const active = await db
      .select({
        leadId: bieActionProposalsTable.leadId,
        actionType: bieActionProposalsTable.actionType,
      })
      .from(bieActionProposalsTable)
      .where(
        and(
          eq(bieActionProposalsTable.organizationId, organizationId),
          inArray(bieActionProposalsTable.status, [
            "proposed",
            "approved",
            "processing",
            "indeterminate",
          ]),
        ),
      );
    const activeKeys = new Set(
      active.map((item) => `${item.leadId}:${item.actionType}`),
    );
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
          rationale:
            "This lead is in an evidence-backed stale pipeline segment. The message remains subject to send caps, quiet hours, suppression, and provider readiness.",
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
          rationale:
            "A human follow-up preserves momentum when outreach is not ready or the owner prefers a personal call.",
          evidence,
          payload: {
            title: "BIE recovery follow-up",
            description:
              "Review the BIE evidence and contact this opportunity.",
            priority: "high",
          },
          estimatedValueCents: value,
          createdByUserId: actorUserId,
        });
      }
      if (
        ["new", "contact_attempted", "nurture"].includes(lead.status) &&
        !activeKeys.has(`${lead.id}:change_stage`)
      ) {
        inserts.push({
          organizationId,
          runId: run.id,
          leadId: lead.id,
          actionType: "change_stage",
          status: "proposed",
          title: "Move lead into deliberate follow-up",
          rationale:
            "The current stage does not reflect an active recovery sequence. This change is fully auditable and can be rejected.",
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
      .set({
        status: "completed",
        summary: `${proposals.length} action proposals generated`,
        result: { proposalCount: proposals.length },
        completedAt: new Date(),
      })
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
        summary:
          error instanceof Error
            ? error.message.slice(0, 500)
            : "BIE proposal generation failed",
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
    .where(
      and(
        eq(bieActionProposalsTable.id, actionId),
        eq(bieActionProposalsTable.organizationId, organizationId),
      ),
    );
  return proposal ?? null;
}

export const prepareBieEmailInput = z.object({ expectedPayload: z.record(z.string(), z.unknown()) }).strict();
const emailReviewSchema = z.object({
  version: z.literal(1), preparedByUserId: z.string().min(1), preparedAt: z.iso.datetime(),
  leadId: z.uuid(), contactId: z.uuid(), leadCreatedAt: z.iso.datetime(), leadUpdatedAt: z.iso.datetime(),
  recipient: z.email(), sender: z.object({ provider: z.enum(["gmail", "microsoft"]), senderEmail: z.email() }).strict(),
}).strict();
export type BieEmailReview = z.infer<typeof emailReviewSchema>;
export class BieEmailReviewError extends Error {
  constructor(readonly code: string, readonly status = 409) { super("Email review changed or is unavailable. Refresh the saved draft and prepare its exact recipient and sender again; no message was sent."); }
}
function emailReviewFail(code: string, status = 409): never { throw new BieEmailReviewError(code, status); }
const normalizeMailbox = (value: string) => value.trim().toLowerCase();
async function bieEmailActor(org: string, actorId: string, requireVerified: boolean) {
  const [actor] = await db.select().from(usersTable).where(and(eq(usersTable.organizationId, org), eq(usersTable.id, actorId)));
  if (!actor?.isActive || actor.id.startsWith("invite:") || !hasPermission(actor.role, "crm.write") || (requireVerified && !actor.emailVerifiedAt)) emailReviewFail("accepted_staff_required", 403);
  return actor;
}
async function bieEmailLead(org: string, proposal: BieActionProposal) {
  const [lead] = await db.select().from(leadsTable).where(and(eq(leadsTable.organizationId, org), eq(leadsTable.id, proposal.leadId)));
  const [contact] = lead ? await db.select().from(contactsTable).where(and(eq(contactsTable.organizationId, org), eq(contactsTable.id, lead.contactId))) : [];
  if (!lead || !contact?.email || !z.email().safeParse(normalizeMailbox(contact.email)).success) emailReviewFail("lead_email_unavailable");
  if (["won", "lost", "scheduled", "inspection_scheduled", "production_scheduled", "in_progress", "completed", "review_requested"].includes(lead.status)) emailReviewFail("lead_workflow_changed");
  if (needsSourceVerification(lead)) emailReviewFail("imported_source_requires_current_review");
  return { lead, contact, recipient: normalizeMailbox(contact.email) };
}
function bieEmailMessage(proposal: BieActionProposal) {
  const parsed = z.object({ subject: z.string().min(1).max(200), body: z.string().min(1).max(5000) }).safeParse(proposal.payload);
  if (!parsed.success) emailReviewFail("email_content_review_required");
  return parsed.data;
}

/** Explicit write before review; never runs on GET or silently during approval. */
export async function prepareBieEmailProposal(org: string, id: string, actorId: string, raw: unknown) {
  const input = prepareBieEmailInput.parse(raw), proposal = await getProposal(org, id);
  if (!proposal || proposal.actionType !== "send_email" || proposal.status !== "proposed" || !isDeepStrictEqual(proposal.payload, input.expectedPayload)) emailReviewFail("proposal_changed");
  await bieEmailActor(org, actorId, true);
  const message = bieEmailMessage(proposal), { lead, contact, recipient } = await bieEmailLead(org, proposal);
  const gate = await checkSendEligibility({ organizationId: org, leadId: lead.id, contact, channel: "email", kind: "outreach" });
  if (!gate.ok && gate.outcome !== "deferred") emailReviewFail(gate.reason);
  const status = await getUserEmailStatus(org, actorId);
  if (!status.configured || !status.connected || !status.provider || !status.email) emailReviewFail("selected_email_unavailable");
  const emailReview: BieEmailReview = { version: 1, preparedByUserId: actorId, preparedAt: new Date().toISOString(),
    leadId: lead.id, contactId: contact.id, leadCreatedAt: lead.createdAt.toISOString(), leadUpdatedAt: lead.updatedAt.toISOString(), recipient,
    sender: { provider: status.provider, senderEmail: normalizeMailbox(status.email) } };
  const identity = status.provider === "microsoft" ? await getMicrosoftMailboxIdentity(org, actorId) : null;
  const monitoring = identity ? await getLeadMonitoringApproval(identity) : null;
  const deliverySnapshot: LeadReplySendSnapshot | null = identity && monitoring ? { version: 1, kind: "bie_lead_email", leadId: lead.id, contactId: contact.id,
    leadCreatedAt: emailReview.leadCreatedAt, leadUpdatedAt: emailReview.leadUpdatedAt, recipient, mailboxIdentity: identity, leadMonitoringApproval: monitoring } : null;
  const payload = { ...message, emailReview, ...(deliverySnapshot ? { deliverySnapshot } : {}) };
  return db.transaction(async tx => {
    const [owned] = await tx.select({ id: revenueExecutionsTable.id }).from(revenueExecutionsTable).where(and(eq(revenueExecutionsTable.organizationId, org), eq(revenueExecutionsTable.actionKey, `bie:${id}`)));
    if (owned) emailReviewFail("execution_already_owned");
    const [updated] = await tx.update(bieActionProposalsTable).set({ payload }).where(and(eq(bieActionProposalsTable.organizationId, org), eq(bieActionProposalsTable.id, id),
      eq(bieActionProposalsTable.status, "proposed"), eq(bieActionProposalsTable.payload, input.expectedPayload))).returning();
    if (!updated) emailReviewFail("proposal_changed");
    await tx.insert(auditEventsTable).values({ organizationId: org, actorUserId: actorId, action: "bie.email_prepared", entityType: "bie_action_proposal", entityId: id,
      metadata: { leadId: lead.id, provider: status.provider, trackedOriginalMailbox: Boolean(deliverySnapshot), payloadFingerprint: mailboxDigest(payload) } });
    return updated;
  });
}

/** Prepared sender/recipient/source is immutable through approval and dispatch. */
async function assertBieEmailReviewCurrent(org: string, proposal: BieActionProposal, actorId: string) {
  const parsed = emailReviewSchema.safeParse(proposal.payload.emailReview);
  if (!parsed.success || parsed.data.preparedByUserId !== actorId) emailReviewFail("prepare_email_review_required");
  const review = parsed.data;
  await bieEmailActor(org, actorId, true);
  const current = await bieEmailLead(org, proposal);
  if (review.leadId !== current.lead.id || review.contactId !== current.contact.id || review.recipient !== current.recipient ||
      review.leadCreatedAt !== current.lead.createdAt.toISOString() || review.leadUpdatedAt !== current.lead.updatedAt.toISOString()) emailReviewFail("lead_review_changed");
  bieEmailMessage(proposal);
  const status = await getUserEmailStatus(org, actorId);
  if (!status.configured || !status.connected || status.provider !== review.sender.provider || !status.email || normalizeMailbox(status.email) !== review.sender.senderEmail) emailReviewFail("selected_sender_changed");
  if (proposal.payload.deliverySnapshot !== undefined) {
    const snapshot = leadReplySendSnapshotSchema.safeParse(proposal.payload.deliverySnapshot);
    if (!snapshot.success) emailReviewFail("mailbox_review_changed");
    const saved = snapshot.data;
    if (
        saved.leadId !== review.leadId || saved.contactId !== review.contactId || saved.recipient !== review.recipient || saved.leadCreatedAt !== review.leadCreatedAt ||
        saved.leadUpdatedAt !== review.leadUpdatedAt || saved.mailboxIdentity.senderUserId !== actorId || saved.mailboxIdentity.organizationId !== org ||
        saved.mailboxIdentity.mailboxEmail !== review.sender.senderEmail || review.sender.provider !== "microsoft") emailReviewFail("mailbox_review_changed");
    await assertLeadMonitoringApproval(saved.mailboxIdentity, saved.leadMonitoringApproval);
  }
  const gate = await checkSendEligibility({ organizationId: org, leadId: current.lead.id, contact: current.contact, channel: "email", kind: "outreach", touchLogicalKey: `bie:${proposal.id}` });
  if (!gate.ok && gate.outcome !== "deferred") emailReviewFail(gate.reason);
  return review;
}

export async function reviewBieProposal(
  organizationId: string,
  actionId: string,
  actorUserId: string,
  decision: "approve" | "reject",
  expectedPayload?: Record<string, unknown>,
): Promise<BieActionProposal | null> {
  const proposal = await getProposal(organizationId, actionId);
  if (!proposal || proposal.status !== "proposed") return null;
  if (expectedPayload && !isDeepStrictEqual(expectedPayload, proposal.payload))
    return null;
  if (decision === "approve" && proposal.actionType === "send_email") {
    if (!expectedPayload) return null;
    try { await assertBieEmailReviewCurrent(organizationId, proposal, actorUserId); }
    catch { return null; }
  }
  const nextStatus: BieActionStatus =
    decision === "approve" ? "approved" : "rejected";
  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(bieActionProposalsTable)
      .set({
        status: nextStatus,
        reviewedByUserId: actorUserId,
        reviewedAt: new Date(),
      })
      .where(
        and(
          eq(bieActionProposalsTable.id, proposal.id),
          eq(bieActionProposalsTable.organizationId, organizationId),
          eq(bieActionProposalsTable.status, "proposed"),
          eq(bieActionProposalsTable.payload, proposal.payload),
        ),
      )
      .returning();
    if (!updated) return null;
    await tx.insert(auditEventsTable).values({
      organizationId,
      actorUserId,
      action:
        decision === "approve" ? "bie.action_approved" : "bie.action_rejected",
      entityType: "bie_action_proposal",
      entityId: proposal.id,
      metadata: { actionType: proposal.actionType, leadId: proposal.leadId },
    });
    return updated ?? null;
  });
}

async function markAction(
  id: string,
  status: BieActionStatus,
  detail: string,
): Promise<BieActionProposal | null> {
  const [updated] = await db
    .update(bieActionProposalsTable)
    .set({
      status,
      executionDetail: detail,
      executedAt: status === "executed" ? new Date() : null,
    })
    .where(eq(bieActionProposalsTable.id, id))
    .returning();
  return updated ?? null;
}

async function emailCapRemaining(
  organizationId: string,
  cap: number,
): Promise<boolean> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  // The current durable reservation is included. Pending/unknown effects consume
  // the allowance, so concurrent actions cannot both use the final slot.
  const rows = await db.execute(sql`select count(*)::int as count from (
    select action_key from revenue_executions where organization_id = ${organizationId}
      and kind = 'send_email' and created_at >= ${since} and state not in ('blocked', 'confirmed_not_performed')
    union
    select 'bie:' || id::text from bie_action_proposals where organization_id = ${organizationId}
      and action_type = 'send_email' and status = 'executed' and executed_at >= ${since}
  ) reserved`);
  return Number(rows.rows[0]?.count ?? 0) <= cap;
}

async function assertBieEmailDispatchCurrent(org: string, frozen: BieActionProposal, actorId: string,
  recipient: string, sender: { provider: "gmail" | "microsoft"; senderEmail: string }, automated: boolean) {
  try {
    const proposal = await getProposal(org, frozen.id);
    if (!proposal || proposal.status !== "approved" || !isDeepStrictEqual(proposal.payload, frozen.payload) || proposal.reviewedByUserId !== frozen.reviewedByUserId) emailReviewFail("proposal_changed");
    const prepared = proposal.payload.emailReview !== undefined;
    await bieEmailActor(org, actorId, prepared);
    if (prepared) {
      if (proposal.reviewedByUserId !== actorId) emailReviewFail("reviewing_sender_changed");
      await assertBieEmailReviewCurrent(org, proposal, actorId);
    } else if (proposal.payload.deliverySnapshot !== undefined) emailReviewFail("unreviewed_mailbox_context");
    const { lead, contact, recipient: currentRecipient } = await bieEmailLead(org, proposal);
    if (currentRecipient !== recipient) emailReviewFail("recipient_changed");
    const channel = await getUserEmailStatus(org, actorId);
    if (!channel.configured || !channel.connected || channel.provider !== sender.provider || !channel.email || normalizeMailbox(channel.email) !== sender.senderEmail) emailReviewFail("selected_sender_changed");
    const [recent] = await db.select({ id: activitiesTable.id }).from(activitiesTable).where(and(eq(activitiesTable.organizationId, org), eq(activitiesTable.leadId, lead.id),
      gte(activitiesTable.occurredAt, proposal.createdAt), inArray(activitiesTable.type, ["portal_message", "customer_reply", "email_received", "sms_received", "contact_attempt_logged", "smart_site_contact_attempt"]))).limit(1);
    const [visit] = await db.select({ id: appointmentsTable.id }).from(appointmentsTable).where(and(eq(appointmentsTable.organizationId, org), eq(appointmentsTable.leadId, lead.id), inArray(appointmentsTable.status, ["scheduled", "confirmed"]))).limit(1);
    if (recent || visit || await hasCustomerReplyHold(org, lead.id)) emailReviewFail("customer_activity_changed");
    const policy = await getAutopilotPolicy(org);
    if (automated) {
      if (!policy.enabled || policy.pausedAt || !policy.allowedActions.includes("send_email")) emailReviewFail("autopilot_policy_changed");
      await assertCapabilityForActor(org, actorId, "revenue.autopilot", "crm.write");
    }
    if (!await emailCapRemaining(org, policy.dailyEmailCap)) emailReviewFail("email_cap_reached");
    const gate = await checkSendEligibility({ organizationId: org, leadId: lead.id, contact, channel: "email", kind: "outreach", touchLogicalKey: `bie:${proposal.id}` });
    if (!gate.ok) emailReviewFail(gate.reason);
    const [owned] = await db.select().from(revenueExecutionsTable).where(and(eq(revenueExecutionsTable.organizationId, org), eq(revenueExecutionsTable.actionKey, `bie:${proposal.id}`)));
    if (!owned || owned.state !== "processing" || owned.kind !== "send_email" || owned.actorUserId !== actorId || owned.expiresAt.getTime() <= Date.now() || owned.fingerprint !== mailboxDigest(frozen.payload)) emailReviewFail("execution_not_owned");
    await assertContactTouchCurrent(db, bieContactTouch(org, frozen, contact));
  } catch { throw new EmailDispatchBlockedError(); }
}

function bieContactTouch(organizationId: string, proposal: BieActionProposal, contact: { id: string; email: string | null }): ContactTouchClaim {
  return { organizationId, logicalKey: `bie:${proposal.id}`, contactId: contact.id,
    address: normalizeMailbox(contact.email ?? ""), channel: "email", sourceKind: "bie", payload: proposal.payload, leadId: proposal.leadId };
}

/** Execute an approved proposal. Manual approval is required unless a later worker invokes this under enabled autopilot. */
export async function executeBieProposal(
  organizationId: string,
  actionId: string,
  actorUserId: string | null,
  options: { automated?: boolean } = {},
): Promise<BieActionProposal | null> {
  const proposal = await getProposal(organizationId, actionId);
  if (!proposal) return null;
  if (proposal.status !== "approved") return proposal;
  if (proposal.actionType === "send_email" && proposal.payload.emailReview !== undefined) {
    const review = emailReviewSchema.safeParse(proposal.payload.emailReview);
    if (!review.success || review.data.preparedByUserId !== actorUserId || proposal.reviewedByUserId !== actorUserId)
      emailReviewFail("reviewing_sender_required", 403);
  }
  const { customerWorkHeld } = await import("./customer-lifecycle-runtime");
  if (await customerWorkHeld(organizationId))
    return { ...proposal, executionDetail: "Company operations are paused. Approved work is retained for review." };
  if (options.automated) {
    const decision = (await getEntitlements(organizationId)).capabilities["revenue.autopilot"];
    // Hold before claiming: a downgrade must not consume or discard approved work.
    if (!decision.allowed) return { ...proposal, executionDetail: decision.detail };
  }
  const [actor] = actorUserId
    ? await db
        .select()
        .from(usersTable)
        .where(
          and(
            eq(usersTable.id, actorUserId),
            eq(usersTable.organizationId, organizationId),
            eq(usersTable.isActive, true),
          ),
        )
    : [];
  if (!actor || !hasPermission(actor.role, "crm.write"))
    return markAction(
      actionId,
      "blocked",
      "An active, authorized responder must own this action.",
    );
  let contactTouch: ContactTouchClaim | undefined;
  if (proposal.actionType === "send_email") {
    const [lead] = await db.select().from(leadsTable).where(and(eq(leadsTable.organizationId, organizationId), eq(leadsTable.id, proposal.leadId)));
    const [contact] = lead ? await db.select().from(contactsTable).where(and(eq(contactsTable.organizationId, organizationId), eq(contactsTable.id, lead.contactId))) : [];
    if (contact?.email) contactTouch = bieContactTouch(organizationId, proposal, contact);
  }
  let execution: Awaited<ReturnType<typeof runDurableAction>>;
  try {
    execution = await runDurableAction({
    organizationId,
    actionKey: `bie:${actionId}`,
    leadId: proposal.leadId,
    kind: proposal.actionType,
    payload: proposal.payload,
    actorUserId,
    ...(contactTouch ? { contactTouch } : {}),
    execute: async () => {
      const result = await executeBieProposalEffect(
        organizationId,
        actionId,
        actorUserId,
        options,
      );
      return {
        state: result?.status === "executed" ? "succeeded" : "blocked",
        detail:
          result?.executionDetail ??
          "The approved action is no longer executable.",
      };
    },
    });
  } catch (error) {
    if (error instanceof ContactTouchDeferredError)
      return { ...proposal, executionDetail: `Contact allowance held until ${error.resumeAt.toISOString()}. The original action is not claimed; review before it runs.` };
    throw error;
  }
  if (execution.state === "indeterminate")
    return markAction(
      actionId,
      "indeterminate",
      execution.detail ??
        "Reconcile the interrupted action before any new outreach.",
    );
  if (execution.state === "processing")
    return {
      ...proposal,
      status: "processing",
      executionDetail: "Another worker owns this execution.",
    };
  return getProposal(organizationId, actionId);
}

async function executeBieProposalEffect(
  organizationId: string,
  actionId: string,
  actorUserId: string | null,
  options: { automated?: boolean } = {},
): Promise<BieActionProposal | null> {
  const proposal = await getProposal(organizationId, actionId);
  if (!proposal || proposal.status !== "approved") return null;
  const policy = await getAutopilotPolicy(organizationId);
  if (
    options.automated &&
    (!policy.enabled ||
      Boolean(policy.pausedAt) ||
      !policy.allowedActions.includes(proposal.actionType))
  ) {
    return markAction(
      proposal.id,
      "blocked",
      "Autopilot policy does not permit this action.",
    );
  }
  const lead = await crm.getLead(organizationId, proposal.leadId);
  if (lead && await hasCustomerReplyHold(organizationId, lead.id))
    return markAction(proposal.id, "blocked", "Customer replied; resolve the reply review before new follow-up.");
  if (!lead)
    return markAction(
      proposal.id,
      "failed",
      "Lead no longer exists in this organization.",
    );
  if (
    [
      "won",
      "lost",
      "scheduled",
      "inspection_scheduled",
      "production_scheduled",
      "in_progress",
      "completed",
      "review_requested",
    ].includes(lead.status)
  )
    return markAction(
      proposal.id,
      "blocked",
      "The lead has moved on. Review its current workflow before taking action.",
    );
  const [reply] = await db
    .select({ id: activitiesTable.id })
    .from(activitiesTable)
    .where(
      and(
        eq(activitiesTable.organizationId, organizationId),
        eq(activitiesTable.leadId, lead.id),
        gte(activitiesTable.occurredAt, proposal.createdAt),
        inArray(activitiesTable.type, [
          "portal_message",
          "customer_reply",
          "email_received",
          "sms_received",
          "contact_attempt_logged",
          "smart_site_contact_attempt",
        ]),
      ),
    )
    .limit(1);
  const [appointment] = await db
    .select({ id: appointmentsTable.id })
    .from(appointmentsTable)
    .where(
      and(
        eq(appointmentsTable.organizationId, organizationId),
        eq(appointmentsTable.leadId, lead.id),
        inArray(appointmentsTable.status, ["scheduled", "confirmed"]),
      ),
    )
    .limit(1);
  if (reply || appointment)
    return markAction(
      proposal.id,
      "blocked",
      "New customer activity or an appointment needs a human review before this older follow-up.",
    );

  if (options.automated) {
    try {
      // Recheck after claiming and after loading current lead state, before effects.
      await assertCapabilityForActor(organizationId, actorUserId ?? "", "revenue.autopilot", "crm.write");
    } catch (error) {
      if (!(error instanceof CapabilityAccessError)) throw error;
      return markAction(proposal.id, "blocked", error.message);
    }
    if (proposal.actionType === "change_stage" && needsSourceVerification(lead))
      return markAction(proposal.id, "blocked", "Imported source status requires current review before an automated stage change.");
  }

  try {
    if (proposal.actionType === "create_task") {
      const task = await crm.createTask(organizationId, {
        leadId: lead.id,
        contactId: lead.contactId,
        assignedUserId: lead.assignedUserId,
        title:
          typeof proposal.payload.title === "string"
            ? proposal.payload.title
            : "BIE recovery follow-up",
        description:
          typeof proposal.payload.description === "string"
            ? proposal.payload.description
            : proposal.rationale,
        priority:
          proposal.payload.priority === "emergency" ? "emergency" : "high",
        sourceEvent: "bie.revenue_recovery",
      });
      if (!task)
        return markAction(
          proposal.id,
          "failed",
          "Could not create a task for this organization.",
        );
      await recordAudit({
        organizationId,
        actorUserId,
        action: "bie.task_created",
        entityType: "bie_action_proposal",
        entityId: proposal.id,
        metadata: { taskId: task.id, leadId: lead.id },
      });
      return markAction(proposal.id, "executed", `Created task ${task.id}.`);
    }

    if (proposal.actionType === "change_stage") {
      const nextStatus =
        typeof proposal.payload.status === "string"
          ? proposal.payload.status
          : "follow_up";
      const updated = await crm.updateLead(organizationId, lead.id, {
        status: nextStatus,
      } as never);
      if (!updated)
        return markAction(
          proposal.id,
          "failed",
          "Could not update this lead's stage.",
        );
      await recordAudit({
        organizationId,
        actorUserId,
        action: "bie.stage_changed",
        entityType: "bie_action_proposal",
        entityId: proposal.id,
        metadata: { leadId: lead.id, from: lead.status, to: nextStatus },
      });
      return markAction(
        proposal.id,
        "executed",
        `Moved lead from ${lead.status} to ${nextStatus}.`,
      );
    }

    const contact = await crm.getContact(organizationId, lead.contactId);
    if (!contact?.email)
      return markAction(
        proposal.id,
        "blocked",
        "The lead has no email address.",
      );
    if (!actorUserId) {
      return markAction(
        proposal.id,
        "blocked",
        "A connected user must approve and send this email.",
      );
    }
    const channel = await getUserEmailStatus(organizationId, actorUserId);
    if (!channel.configured || !channel.connected || !channel.provider || !channel.email)
      return markAction(
        proposal.id,
        "blocked",
        "This responder's selected email connection is not ready. Connect and select Gmail or Microsoft 365 / Outlook in My Profile.",
      );
    if (!(await emailCapRemaining(organizationId, policy.dailyEmailCap))) {
      return markAction(
        proposal.id,
        "blocked",
        `BIE daily email cap (${policy.dailyEmailCap}) has been reached.`,
      );
    }
    const eligibility = await checkSendEligibility({
      organizationId,
      leadId: lead.id,
      contact,
      channel: "email",
      kind: "outreach",
      touchLogicalKey: `bie:${proposal.id}`,
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
      return markAction(
        proposal.id,
        "blocked",
        `Email ${eligibility.outcome}: ${eligibility.reason}.`,
      );
    }
    const subject =
      typeof proposal.payload.subject === "string"
        ? proposal.payload.subject
        : "A quick check-in";
    const body =
      typeof proposal.payload.body === "string"
        ? proposal.payload.body
        : proposal.rationale;
    const recipient = normalizeMailbox(contact.email);
    const expectedSender = { provider: channel.provider, senderEmail: normalizeMailbox(channel.email) };
    const beforeDispatch = () => assertBieEmailDispatchCurrent(organizationId, proposal, actorUserId, recipient, expectedSender, Boolean(options.automated));
    await beforeDispatch();
    const saved = proposal.payload.deliverySnapshot as LeadReplySendSnapshot | undefined;
    const outboundParentId = saved ? await reserveLeadMailboxParent({ identity: saved.mailboxIdentity, leadId: lead.id, contactId: contact.id, proposalId: proposal.id,
      executionFingerprint: mailboxDigest(proposal.payload), message: { to: recipient, subject, body } }) : undefined;
    const sent = await sendEmailForUser({
      organizationId,
      userId: actorUserId,
      to: recipient,
      subject,
      body,
      expectedSender,
      beforeDispatch: async () => {
        await beforeDispatch();
        await markContactTouchDispatchStarted(organizationId, `bie:${proposal.id}`);
      },
      ...(outboundParentId ? { outboundParentId } : {}),
    });
    if (outboundParentId) await recordMailboxParentAcceptance(outboundParentId, organizationId);
    await acceptContactTouch(organizationId, `bie:${proposal.id}`);
    await crm.createActivity(organizationId, {
      leadId: lead.id,
      contactId: contact.id,
      actorUserId,
      type: "bie_email_sent",
      title: `BIE email accepted by provider: ${subject}`,
      body: body.slice(0, 300),
      metadata: {
        channel: "email",
        to: contact.email,
        from: sent.senderEmail,
        ...emailAcceptanceEvidence(sent, { organizationId, leadId: lead.id, recipientEmail: contact.email }),
        source: "bie.revenue_recovery",
        touchLogicalKey: `bie:${proposal.id}`,
        proposalId: proposal.id,
        ...(outboundParentId ? { outboundParentId, replyMonitoring: "original_mailbox_observation_required" } : { replyMonitoring: "untracked" }),
      },
    });
    await recordAudit({
      organizationId,
      actorUserId,
      action: "bie.email_sent",
      entityType: "bie_action_proposal",
      entityId: proposal.id,
      metadata: { leadId: lead.id, provider: sent.provider },
    });
    return markAction(
      proposal.id,
      "executed",
      `Accepted by ${sent.provider}; delivery and reply are not yet confirmed.`,
    );
  } catch (error) {
    if (error instanceof EmailDispatchBlockedError) return markAction(proposal.id, "blocked", "Final email guard changed before provider dispatch. Review the retained action; no automatic retry is permitted.");
    throw error; // Durable executor records uncertainty without an unsafe automatic retry.
  }
}

/** Execute all currently approved proposals allowed by the enabled org policy. */
export async function runAutopilot(
  organizationId: string,
): Promise<BieActionProposal[]> {
  const { customerWorkHeld } = await import("./customer-lifecycle-runtime");
  if (await customerWorkHeld(organizationId)) return [];
  const policy = await getAutopilotPolicy(organizationId);
  if (!policy.enabled || policy.pausedAt || policy.allowedActions.length === 0)
    return [];
  if (!(await getEntitlements(organizationId)).capabilities["revenue.autopilot"].allowed)
    return [];
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
