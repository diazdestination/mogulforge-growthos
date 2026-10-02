import { z } from "zod/v4";
import { isDeepStrictEqual } from "node:util";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  db,
  activitiesTable,
  leadsTable,
  contactsTable,
  usersTable,
  estimatesTable,
  projectsTable,
  appointmentsTable,
  auditEventsTable,
  organizationsTable,
  operatingProfilesTable as profiles,
  decisionRoomsTable as rooms,
  valueEntriesTable as entries,
  projectStoriesTable as stories,
  revenueExecutionsTable as executions,
  revenueExecutionEventsTable as executionEvents,
} from "@workspace/db";
import { listTodayActions } from "./next-best-action";
import { listBieProposals } from "./bie";
import { clientReadiness } from "./client-onboarding";
import { getPortalConversation, getPortalOverview } from "./portal";
import { smartSiteFollowup } from "./smart-site-followup";
import type { PortalSession } from "@workspace/db";
import { inReportingPeriod, parseReportingPeriod, type ReportingPeriod } from "./reporting-period";

export class RevenueError extends Error {
  constructor(
    public code: string,
    public status = 400,
  ) {
    super(code);
  }
}
const line = z.string().trim().min(2).max(2000);
const reference = z.string().trim().min(5).max(160);
export const profileSchema = z
  .object({
    expectedVersion: z.number().int().min(0),
    confirmed: z.literal(true),
    content: z
      .object({
        services: line,
        serviceArea: line,
        businessHours: line,
        escalation: line,
        materials: line,
        warranties: line,
        pricingBoundaries: line,
        sourceReference: reference,
      })
      .strict(),
  })
  .strict();
export const roomSchema = z
  .object({
    expectedVersion: z.number().int().min(0),
    confirmed: z.literal(true),
    estimateId: z.uuid(),
    title: z.string().trim().min(3).max(150),
    scope: line,
    warranty: line,
    sourceReference: reference,
    options: z
      .array(
        z
          .object({ name: z.string().trim().min(2).max(80), description: line })
          .strict(),
      )
      .max(3),
  })
  .strict();
export const valueEntrySchema = z
  .object({
    leadId: z.uuid(),
    sourceReference: reference,
    kind: z.enum(["payment", "refund", "direct_cost", "cost_refund"]),
    amountCents: z.number().int().min(1).max(1_000_000_000),
    occurredAt: z.iso.datetime(),
    confirmed: z.literal(true),
  })
  .strict()
  .refine((v) => Date.parse(v.occurredAt) <= Date.now(), {
    message: "A recorded financial event cannot be in the future.",
  });
export const storySchema = z
  .object({
    projectId: z.uuid(),
    expectedVersion: z.number().int().min(0),
    title: z.string().trim().min(3).max(150),
    serviceArea: z.string().trim().min(2).max(120),
    body: z.string().trim().min(30).max(5000),
    sourceReference: reference,
  })
  .strict();

export async function getOperatingProfile(org: string) {
  const [profile] = await db
    .select()
    .from(profiles)
    .where(eq(profiles.organizationId, org))
    .orderBy(desc(profiles.version))
    .limit(1);
  return profile ?? null;
}

export async function saveOperatingProfile(
  org: string,
  actor: string,
  raw: unknown,
) {
  const input = profileSchema.parse(raw);
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`operating-profile:${org}`}))`,
    );
    const [prior] = await tx
      .select()
      .from(profiles)
      .where(eq(profiles.organizationId, org))
      .orderBy(desc(profiles.version))
      .limit(1);
    if ((prior?.version ?? 0) !== input.expectedVersion) {
      if (
        prior?.version === input.expectedVersion + 1 &&
        isDeepStrictEqual(prior.content, input.content)
      )
        return prior;
      throw new RevenueError(
        "Profile changed. Refresh before approving a new version.",
        409,
      );
    }
    const [row] = await tx
      .insert(profiles)
      .values({
        organizationId: org,
        version: input.expectedVersion + 1,
        content: input.content,
        approvedByUserId: actor,
      })
      .returning();
    await tx.insert(auditEventsTable).values({
      organizationId: org,
      actorUserId: actor,
      action: "revenue.profile_approved",
      entityType: "operating_profile",
      entityId: row.id,
      metadata: { version: row.version },
    });
    return row;
  });
}

export async function revenueDesk(org: string) {
  const [nextActions, proposals, records, staff, attempts, profile, followup] =
    await Promise.all([
      listTodayActions(org, { limit: 50 }),
      listBieProposals(org),
      db
        .select({
          id: leadsTable.id,
          summary: leadsTable.summary,
          status: leadsTable.status,
          assignedUserId: leadsTable.assignedUserId,
          createdAt: leadsTable.createdAt,
          updatedAt: leadsTable.updatedAt,
          source: leadsTable.source,
        })
        .from(leadsTable)
        .where(eq(leadsTable.organizationId, org))
        .orderBy(desc(leadsTable.createdAt))
        .limit(1000),
      db
        .select({
          id: usersTable.id,
          firstName: usersTable.firstName,
          lastName: usersTable.lastName,
          isActive: usersTable.isActive,
        })
        .from(usersTable)
        .where(eq(usersTable.organizationId, org)),
      db
        .select()
        .from(executions)
        .where(eq(executions.organizationId, org))
        .orderBy(desc(executions.createdAt))
        .limit(100),
      getOperatingProfile(org),
      smartSiteFollowup(org),
    ]);
  const leadIds = [
    ...new Set([
      ...nextActions.map((a) => a.leadId),
      ...proposals.map((p) => p.leadId),
    ]),
  ];
  const context = leadIds.length
    ? await db
        .select()
        .from(leadsTable)
        .where(
          and(
            eq(leadsTable.organizationId, org),
            inArray(leadsTable.id, leadIds),
          ),
        )
    : [];
  const map = new Map(context.map((l) => [l.id, l]));
  return {
    generatedAt: new Date().toISOString(),
    profile,
    followup,
    queue: nextActions.map((a) => {
      const l = map.get(a.leadId);
      return {
        ...a,
        assignedUserId: l?.assignedUserId ?? null,
        receivedAt: l?.createdAt ?? null,
        updatedAt: l?.updatedAt ?? null,
        source: l?.source ?? null,
        proposals: proposals.filter((p) => p.leadId === a.leadId),
      };
    }),
    proposals,
    staff,
    executions: attempts,
    records,
    limits: {
      recommendations: 50,
      proposals: 200,
      recentRecords: 1000,
      recentExecutions: 100,
    },
    boundary:
      "Suggestions and approval are not delivery. Staff logs are not independently verified replies. Financial records live in the value ledger.",
  };
}

export async function saveDecisionRoom(
  org: string,
  leadId: string,
  actor: string,
  raw: unknown,
) {
  const input = roomSchema.parse(raw);
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`decision-room:${org}:${leadId}`}))`,
    );
    const [lead] = await tx
      .select()
      .from(leadsTable)
      .where(
        and(eq(leadsTable.id, leadId), eq(leadsTable.organizationId, org)),
      );
    const [estimate] = await tx
      .select()
      .from(estimatesTable)
      .where(
        and(
          eq(estimatesTable.id, input.estimateId),
          eq(estimatesTable.organizationId, org),
          eq(estimatesTable.leadId, leadId),
        ),
      )
      .for("share");
    if (!lead || !estimate)
      throw new RevenueError(
        "Lead and estimate must belong to this workspace.",
        404,
      );
    if (!["sent", "accepted"].includes(estimate.status))
      throw new RevenueError(
        "Only a sent or accepted estimate can be shared with a customer.",
        409,
      );
    const [prior] = await tx
      .select()
      .from(rooms)
      .where(and(eq(rooms.organizationId, org), eq(rooms.leadId, leadId)))
      .orderBy(desc(rooms.version))
      .limit(1);
    if ((prior?.version ?? 0) !== input.expectedVersion)
      throw new RevenueError(
        "Decision room changed. Refresh its version before sharing.",
        409,
      );
    const [row] = await tx
      .insert(rooms)
      .values({
        organizationId: org,
        leadId,
        estimateId: estimate.id,
        version: input.expectedVersion + 1,
        title: input.title,
        scope: input.scope,
        options: input.options,
        warranty: input.warranty,
        sourceReference: input.sourceReference,
        estimateTotalCents: estimate.totalCents,
        estimateUpdatedAt: estimate.updatedAt,
        approvedByUserId: actor,
      })
      .returning();
    await tx.insert(auditEventsTable).values({
      organizationId: org,
      actorUserId: actor,
      action: "revenue.decision_room_approved",
      entityType: "lead",
      entityId: leadId,
      metadata: {
        roomId: row.id,
        version: row.version,
        estimateId: estimate.id,
      },
    });
    return row;
  });
}

export async function decisionRoom(org: string, leadId: string) {
  const [lead] = await db
    .select({ id: leadsTable.id })
    .from(leadsTable)
    .where(and(eq(leadsTable.id, leadId), eq(leadsTable.organizationId, org)));
  if (!lead) throw new RevenueError("Project not found.", 404);
  const [versions, estimates, appointments] = await Promise.all([
    db
      .select()
      .from(rooms)
      .where(and(eq(rooms.organizationId, org), eq(rooms.leadId, leadId)))
      .orderBy(desc(rooms.version))
      .limit(20),
    db
      .select()
      .from(estimatesTable)
      .where(
        and(
          eq(estimatesTable.organizationId, org),
          eq(estimatesTable.leadId, leadId),
        ),
      )
      .orderBy(desc(estimatesTable.createdAt))
      .limit(100),
    db
      .select({
        id: appointmentsTable.id,
        scheduledStart: appointmentsTable.scheduledStart,
        status: appointmentsTable.status,
      })
      .from(appointmentsTable)
      .where(
        and(
          eq(appointmentsTable.organizationId, org),
          eq(appointmentsTable.leadId, leadId),
        ),
      )
      .orderBy(desc(appointmentsTable.scheduledStart))
      .limit(20),
  ]);
  const [orgRow] = await db
    .select({ slug: organizationsTable.slug })
    .from(organizationsTable)
    .where(eq(organizationsTable.id, org));
  return {
    leadId,
    customerPath: `/project-room/${encodeURIComponent(orgRow.slug)}/${leadId}`,
    versions: versions.map((r) => ({
      ...r,
      isCurrent: estimates.some(
        (e) =>
          e.id === r.estimateId &&
          e.updatedAt.getTime() === r.estimateUpdatedAt.getTime() &&
          ["sent", "accepted"].includes(e.status),
      ),
    })),
    estimates,
    appointments,
  };
}

export async function portalDecisionRoom(
  session: PortalSession,
  leadId: string,
) {
  if ((await getPortalConversation(session, leadId)) === null) return null;
  const result = await decisionRoom(session.organizationId, leadId);
  const overview = await getPortalOverview(session);
  // Whitelist customer-safe approved content. Never expose draft estimates, staff IDs or source notes.
  return {
    leadId,
    photos: overview.claims.find((l) => l.id === leadId)?.photos ?? [],
    versions: result.versions.map((r) => ({
      id: r.id,
      version: r.version,
      title: r.title,
      scope: r.scope,
      options: r.options,
      warranty: r.warranty,
      estimateTotalCents: r.estimateTotalCents,
      createdAt: r.createdAt,
      isCurrent: r.isCurrent,
    })),
    appointments: result.appointments,
    boundary:
      "Options are explanatory. The approved estimate and your signed agreement control scope and price. This page does not sign or accept a contract.",
  };
}

export async function recordValueEntry(
  org: string,
  actor: string,
  raw: unknown,
) {
  const input = valueEntrySchema.parse(raw);
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`value-entry:${org}:${input.sourceReference}`}))`,
    );
    const [lead] = await tx
      .select({ id: leadsTable.id })
      .from(leadsTable)
      .where(
        and(
          eq(leadsTable.id, input.leadId),
          eq(leadsTable.organizationId, org),
        ),
      );
    if (!lead) throw new RevenueError("Lead not found in this workspace.", 404);
    const [prior] = await tx
      .select()
      .from(entries)
      .where(
        and(
          eq(entries.organizationId, org),
          eq(entries.sourceReference, input.sourceReference),
        ),
      );
    if (prior) {
      if (
        prior.leadId !== input.leadId ||
        prior.kind !== input.kind ||
        prior.amountCents !== input.amountCents ||
        prior.occurredAt.toISOString() !==
          new Date(input.occurredAt).toISOString()
      )
        throw new RevenueError(
          "This source reference already identifies a different entry.",
          409,
        );
      return prior;
    }
    const [row] = await tx
      .insert(entries)
      .values({
        organizationId: org,
        leadId: input.leadId,
        kind: input.kind,
        amountCents: input.amountCents,
        occurredAt: new Date(input.occurredAt),
        sourceReference: input.sourceReference,
        recordedByUserId: actor,
      })
      .returning();
    await tx.insert(auditEventsTable).values({
      organizationId: org,
      actorUserId: actor,
      action: "revenue.value_recorded",
      entityType: "value_entry",
      entityId: row.id,
      metadata: {
        leadId: row.leadId,
        kind: row.kind,
        evidence: "staff_recorded",
      },
    });
    return row;
  });
}

export async function valueLedger(org: string, requestedPeriod?: ReportingPeriod) {
  const period = requestedPeriod ? parseReportingPeriod({ startAt: requestedPeriod.startAt, endAt: requestedPeriod.endAt }) : undefined;
  const entryScope = and(
    eq(entries.organizationId, org),
    sql`exists (select 1 from ${leadsTable} l where l.id = ${entries.leadId} and l.organization_id = ${org})`,
    period ? inReportingPeriod(entries.occurredAt, period) : undefined,
  );
  const acceptedInRange = period ? inReportingPeriod(estimatesTable.acceptedAt, period) : sql`true`;
  const completedInRange = period ? inReportingPeriod(projectsTable.completedAt, period) : sql`true`;
  const [rows, totals, accepted, completed] = await Promise.all([
    db
      .select()
      .from(entries)
      .where(entryScope)
      .orderBy(desc(entries.occurredAt))
      .limit(200),
    db
      .select({
        kind: entries.kind,
        amount: sql<string>`sum(${entries.amountCents})::text`,
        count: sql<number>`count(*)::int`,
      })
      .from(entries)
      .where(entryScope)
      .groupBy(entries.kind),
    db
      .select({
        count: sql<number>`count(*) filter (where ${acceptedInRange})::int`,
        amount: sql<string>`coalesce(sum(${estimatesTable.totalCents}) filter (where ${acceptedInRange}),0)::text`,
        undated: sql<number>`count(*) filter (where ${estimatesTable.acceptedAt} is null)::int`,
      })
      .from(estimatesTable)
      .where(
        and(
          eq(estimatesTable.organizationId, org),
          eq(estimatesTable.status, "accepted"),
          sql`exists (select 1 from ${leadsTable} l where l.id = ${estimatesTable.leadId} and l.organization_id = ${org})`,
        ),
      ),
    db
      .select({
        count: sql<number>`count(*) filter (where ${completedInRange})::int`,
        undated: sql<number>`count(*) filter (where ${projectsTable.completedAt} is null)::int`,
      })
      .from(projectsTable)
      .where(
        and(
          eq(projectsTable.organizationId, org),
          eq(projectsTable.status, "completed"),
          sql`exists (select 1 from ${leadsTable} l where l.id = ${projectsTable.leadId} and l.organization_id = ${org})`,
        ),
      ),
  ]);
  const amount = (kind: string) =>
    Number(totals.find((t) => t.kind === kind)?.amount ?? 0);
  const netReceiptsCents = amount("payment") - amount("refund");
  const netDirectCostsCents = amount("direct_cost") - amount("cost_refund");
  const receiptEntryCount = totals
    .filter((t) => t.kind === "payment" || t.kind === "refund")
    .reduce((n, t) => n + t.count, 0);
  const costEntryCount = totals
    .filter((t) => t.kind === "direct_cost" || t.kind === "cost_refund")
    .reduce((n, t) => n + t.count, 0);
  if (
    ![netReceiptsCents, netDirectCostsCents, Number(accepted[0]?.amount)].every(
      Number.isSafeInteger,
    )
  )
    throw new RevenueError("Totals exceed supported precision.", 422);
  return {
    currency: "USD",
    period: period ?? "all_time",
    entries: rows,
    entryCount: totals.reduce((n, t) => n + t.count, 0),
    acceptedEstimateCount: accepted[0]?.count ?? 0,
    acceptedEstimateCents: Number(accepted[0]?.amount ?? 0),
    completedProjectCount: completed[0]?.count ?? 0,
    undatedAcceptedEstimateCount: accepted[0]?.undated ?? 0,
    undatedCompletedProjectCount: completed[0]?.undated ?? 0,
    netReceiptsCents,
    netDirectCostsCents,
    receiptEntryCount,
    costEntryCount,
    recordedContributionCents:
      receiptEntryCount && costEntryCount
        ? netReceiptsCents - netDirectCostsCents
        : null,
    boundary:
      (period ? "UTC period uses financial event, estimate acceptance and project completion dates; undated records are excluded. " : "All-time staff-recorded entries. ") +
      "No bank/accounting synchronization or causal ROI. Contribution is recorded receipts less recorded direct costs; missing costs, tax and overhead prevent a profit claim. Use new refund/cost-refund entries to correct history.",
  };
}

export async function leadEvidence(org: string, leadId: string) {
  const [lead] = await db
    .select()
    .from(leadsTable)
    .where(and(eq(leadsTable.id, leadId), eq(leadsTable.organizationId, org)));
  if (!lead) throw new RevenueError("Lead not found.", 404);
  const [activity, estimates, projects, payments, appointments] =
    await Promise.all([
      db
        .select()
        .from(activitiesTable)
        .where(
          and(
            eq(activitiesTable.organizationId, org),
            eq(activitiesTable.leadId, leadId),
          ),
        )
        .orderBy(desc(activitiesTable.createdAt))
        .limit(100),
      db
        .select()
        .from(estimatesTable)
        .where(
          and(
            eq(estimatesTable.organizationId, org),
            eq(estimatesTable.leadId, leadId),
          ),
        )
        .limit(100),
      db
        .select()
        .from(projectsTable)
        .where(
          and(
            eq(projectsTable.organizationId, org),
            eq(projectsTable.leadId, leadId),
          ),
        )
        .limit(100),
      db
        .select()
        .from(entries)
        .where(and(eq(entries.organizationId, org), eq(entries.leadId, leadId)))
        .limit(200),
      db
        .select()
        .from(appointmentsTable)
        .where(
          and(
            eq(appointmentsTable.organizationId, org),
            eq(appointmentsTable.leadId, leadId),
          ),
        )
        .limit(100),
    ]);
  return {
    leadId,
    createdAt: lead.createdAt,
    source: lead.source,
    status: lead.status,
    activity,
    estimates,
    projects,
    payments,
    appointments,
  };
}

export async function saveProjectStory(
  org: string,
  actor: string,
  raw: unknown,
) {
  const input = storySchema.parse(raw);
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`project-story:${org}:${input.projectId}`}))`,
    );
    const [project] = await tx
      .select()
      .from(projectsTable)
      .where(
        and(
          eq(projectsTable.id, input.projectId),
          eq(projectsTable.organizationId, org),
        ),
      )
      .for("share");
    if (!project) throw new RevenueError("Project not found.", 404);
    if (project.status !== "completed" || !project.completedAt)
      throw new RevenueError("A recorded completed project is required.", 409);
    const [prior] = await tx
      .select()
      .from(stories)
      .where(
        and(eq(stories.organizationId, org), eq(stories.projectId, project.id)),
      )
      .orderBy(desc(stories.version))
      .limit(1);
    if ((prior?.version ?? 0) !== input.expectedVersion)
      throw new RevenueError(
        "Story changed. Refresh before creating another version.",
        409,
      );
    const [row] = await tx
      .insert(stories)
      .values({
        organizationId: org,
        projectId: project.id,
        version: input.expectedVersion + 1,
        title: input.title,
        serviceArea: input.serviceArea,
        body: input.body,
        sourceReference: input.sourceReference,
        sourceUpdatedAt: project.updatedAt,
      })
      .returning();
    await tx.insert(auditEventsTable).values({
      organizationId: org,
      actorUserId: actor,
      action: "revenue.story_drafted",
      entityType: "project_story",
      entityId: row.id,
      metadata: { projectId: project.id, version: row.version },
    });
    return row;
  });
}

export async function approveProjectStory(
  org: string,
  id: string,
  actor: string,
) {
  return db.transaction(async (tx) => {
    const [story] = await tx
      .select()
      .from(stories)
      .where(and(eq(stories.organizationId, org), eq(stories.id, id)))
      .for("update");
    if (!story) throw new RevenueError("Story not found.", 404);
    const [project] = await tx
      .select()
      .from(projectsTable)
      .where(
        and(
          eq(projectsTable.id, story.projectId),
          eq(projectsTable.organizationId, org),
        ),
      )
      .for("share");
    if (
      !project ||
      project.status !== "completed" ||
      project.updatedAt.getTime() !== story.sourceUpdatedAt.getTime()
    )
      throw new RevenueError(
        "The source project changed; create a refreshed draft before approval.",
        409,
      );
    const [latest] = await tx
      .select({ version: stories.version })
      .from(stories)
      .where(
        and(
          eq(stories.organizationId, org),
          eq(stories.projectId, story.projectId),
        ),
      )
      .orderBy(desc(stories.version))
      .limit(1);
    if (latest.version !== story.version)
      throw new RevenueError("A newer story version needs review.", 409);
    if (story.state === "approved") return story;
    const [row] = await tx
      .update(stories)
      .set({
        state: "approved",
        approvedByUserId: actor,
        approvedAt: new Date(),
      })
      .where(eq(stories.id, id))
      .returning();
    await tx.insert(auditEventsTable).values({
      organizationId: org,
      actorUserId: actor,
      action: "revenue.story_approved",
      entityType: "project_story",
      entityId: id,
      metadata: {
        permissionAttestation: "client-approved-content-and-media-v1",
        published: false,
      },
    });
    return row;
  });
}

export async function projectGrowth(org: string) {
  const [projects, drafts] = await Promise.all([
    db
      .select({
        id: projectsTable.id,
        leadId: projectsTable.leadId,
        name: projectsTable.name,
        completedAt: projectsTable.completedAt,
        updatedAt: projectsTable.updatedAt,
      })
      .from(projectsTable)
      .where(
        and(
          eq(projectsTable.organizationId, org),
          eq(projectsTable.status, "completed"),
        ),
      )
      .orderBy(desc(projectsTable.completedAt))
      .limit(100),
    db
      .select()
      .from(stories)
      .where(eq(stories.organizationId, org))
      .orderBy(desc(stories.createdAt))
      .limit(200),
  ]);
  return {
    projects,
    stories: drafts,
    boundary:
      "Drafts and approvals only. Nothing here publishes to a website, sends a review request or contacts a customer.",
  };
}

export async function clientOperations() {
  const orgs = await db
    .select({ id: organizationsTable.id, name: organizationsTable.name })
    .from(organizationsTable)
    .orderBy(organizationsTable.name)
    .limit(100);
  return {
    limit: 100,
    clients: await Promise.all(
      orgs.map(async (org) => {
        const [readiness, profile, pending, followup] = await Promise.all([
          clientReadiness(org.id),
          getOperatingProfile(org.id),
          db
            .select({ count: sql<number>`count(*)::int` })
            .from(executions)
            .where(
              and(
                eq(executions.organizationId, org.id),
                sql`(${executions.state} = 'indeterminate' or (${executions.state} = 'processing' and ${executions.expiresAt} < now()))`,
              ),
            ),
          smartSiteFollowup(org.id),
        ]);
        return {
          ...org,
          readiness,
          profileVersion: profile?.version ?? null,
          profileApprovedAt: profile?.createdAt ?? null,
          executionsNeedingReview: pending[0]?.count ?? 0,
          inquiries: {
            unowned: followup.summary.unassigned,
            overdue: followup.summary.overdue,
          },
        };
      }),
    ),
    boundary:
      "Allowlisted setup and execution health only. Selection does not grant membership or access to another client's CRM. Usage cost accounting and provider readiness require their own evidence.",
  };
}
