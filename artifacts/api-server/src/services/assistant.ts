/**
 * CRM AI Assistant — answers natural-language questions about the org's own
 * CRM data (leads, conversion, appointments, workload, revenue) using OpenAI
 * function-calling over org-scoped aggregation tools.
 *
 * Every tool query is scoped to the caller's organizationId; the model never
 * sees data from another org and never receives raw PII beyond what the CRM
 * user could already read in the app.
 */
import {
  appointmentsTable,
  crmTasksTable,
  db,
  estimatesTable,
  leadsTable,
  organizationsTable,
  projectsTable,
  usersTable,
} from "@workspace/db";
import { and, count, desc, eq, gte, sql } from "drizzle-orm";

import {
  ASSISTANT_TOOL_SPECS,
  buildSystemPrompt,
  runAssistantToolLoop,
  type AssistantChatMessage,
  type AssistantLoopTool,
} from "./assistant-chat-loop";
import { validWorkReadScope } from "./customer-work-read-scope";

export { buildSystemPrompt, type AssistantChatMessage };

/* ------------------------------------------------------------------ tools */

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

const WON_STATUSES = [
  "won",
  "production_scheduled",
  "in_progress",
  "final_walkthrough",
  "completed",
  "review_requested",
] as const;

async function pipelineSnapshot(organizationId: string, days: number) {
  const since = daysAgo(days);
  const byStatus = await db
    .select({ status: leadsTable.status, count: count() })
    .from(leadsTable)
    .where(eq(leadsTable.organizationId, organizationId))
    .groupBy(leadsTable.status);
  const bySource = await db
    .select({ source: leadsTable.source, count: count() })
    .from(leadsTable)
    .where(eq(leadsTable.organizationId, organizationId))
    .groupBy(leadsTable.source);
  const [newInWindow] = await db
    .select({ value: count() })
    .from(leadsTable)
    .where(
      and(
        eq(leadsTable.organizationId, organizationId),
        gte(leadsTable.createdAt, since),
      ),
    );
  return {
    windowDays: days,
    leadsByStatus: byStatus,
    leadsBySource: bySource,
    newLeadsInWindow: newInWindow.value,
  };
}

async function conversionInsights(organizationId: string, days: number) {
  const since = daysAgo(days);
  const rows = await db
    .select({
      source: leadsTable.source,
      serviceType: leadsTable.serviceType,
      status: leadsTable.status,
      count: count(),
    })
    .from(leadsTable)
    .where(
      and(
        eq(leadsTable.organizationId, organizationId),
        gte(leadsTable.createdAt, since),
      ),
    )
    .groupBy(leadsTable.source, leadsTable.serviceType, leadsTable.status);

  const wonSet = new Set<string>(WON_STATUSES);
  type Bucket = { total: number; won: number; lost: number };
  const bySource = new Map<string, Bucket>();
  const byService = new Map<string, Bucket>();
  let total = 0;
  let won = 0;
  let lost = 0;
  const add = (map: Map<string, Bucket>, key: string, row: { status: string; count: number }) => {
    const b = map.get(key) ?? { total: 0, won: 0, lost: 0 };
    b.total += row.count;
    if (wonSet.has(row.status)) b.won += row.count;
    if (row.status === "lost") b.lost += row.count;
    map.set(key, b);
  };
  for (const row of rows) {
    total += row.count;
    if (wonSet.has(row.status)) won += row.count;
    if (row.status === "lost") lost += row.count;
    add(bySource, row.source ?? "unknown", row);
    add(byService, row.serviceType ?? "unknown", row);
  }
  return {
    windowDays: days,
    totals: { leads: total, won, lost, stillOpen: total - won - lost },
    bySource: Object.fromEntries(bySource),
    byServiceType: Object.fromEntries(byService),
    note: "won = any status at or past 'won'; rates should be computed as won/(won+lost) for closed-deal win rate, or won/total for overall conversion.",
  };
}

async function appointmentsStats(organizationId: string, days: number) {
  const since = daysAgo(days);
  const byStatus = await db
    .select({ status: appointmentsTable.status, count: count() })
    .from(appointmentsTable)
    .where(
      and(
        eq(appointmentsTable.organizationId, organizationId),
        gte(appointmentsTable.scheduledStart, since),
      ),
    )
    .groupBy(appointmentsTable.status);
  const byType = await db
    .select({ type: appointmentsTable.type, count: count() })
    .from(appointmentsTable)
    .where(
      and(
        eq(appointmentsTable.organizationId, organizationId),
        gte(appointmentsTable.scheduledStart, since),
      ),
    )
    .groupBy(appointmentsTable.type);
  const [upcoming] = await db
    .select({ value: count() })
    .from(appointmentsTable)
    .where(
      and(
        eq(appointmentsTable.organizationId, organizationId),
        eq(appointmentsTable.status, "scheduled"),
        sql`${appointmentsTable.scheduledStart} > now()`,
      ),
    );
  return { windowDays: days, byStatus, byType, upcomingScheduled: upcoming.value };
}

async function teamWorkload(organizationId: string) {
  const members = await db
    .select({
      userId: usersTable.id,
      firstName: usersTable.firstName,
      lastName: usersTable.lastName,
      email: usersTable.email,
    })
    .from(usersTable)
    .where(eq(usersTable.organizationId, organizationId));

  const openTasks = await db
    .select({ assignedUserId: crmTasksTable.assignedUserId, count: count() })
    .from(crmTasksTable)
    .where(
      and(
        eq(crmTasksTable.organizationId, organizationId),
        sql`${crmTasksTable.status} in ('open', 'in_progress')`,
      ),
    )
    .groupBy(crmTasksTable.assignedUserId);
  const overdueTasks = await db
    .select({ assignedUserId: crmTasksTable.assignedUserId, count: count() })
    .from(crmTasksTable)
    .where(
      and(
        eq(crmTasksTable.organizationId, organizationId),
        sql`${crmTasksTable.status} in ('open', 'in_progress')`,
        sql`${crmTasksTable.dueAt} < now()`,
      ),
    )
    .groupBy(crmTasksTable.assignedUserId);
  const activeLeads = await db
    .select({ assignedUserId: leadsTable.assignedUserId, count: count() })
    .from(leadsTable)
    .where(
      and(
        eq(leadsTable.organizationId, organizationId),
        sql`${leadsTable.status} not in ('completed', 'lost', 'nurture')`,
      ),
    )
    .groupBy(leadsTable.assignedUserId);
  const upcomingAppts = await db
    .select({ assignedUserId: appointmentsTable.assignedUserId, count: count() })
    .from(appointmentsTable)
    .where(
      and(
        eq(appointmentsTable.organizationId, organizationId),
        sql`${appointmentsTable.status} in ('scheduled', 'confirmed')`,
        sql`${appointmentsTable.scheduledStart} > now()`,
      ),
    )
    .groupBy(appointmentsTable.assignedUserId);

  const toMap = (rows: { assignedUserId: string | null; count: number }[]) => {
    const m = new Map<string, number>();
    for (const r of rows) m.set(r.assignedUserId ?? "unassigned", r.count);
    return m;
  };
  const tasksMap = toMap(openTasks);
  const overdueMap = toMap(overdueTasks);
  const leadsMap = toMap(activeLeads);
  const apptsMap = toMap(upcomingAppts);

  return {
    members: members.map((m) => ({
      name: [m.firstName, m.lastName].filter(Boolean).join(" ") || m.email || m.userId,
      openTasks: tasksMap.get(m.userId) ?? 0,
      overdueTasks: overdueMap.get(m.userId) ?? 0,
      activeLeads: leadsMap.get(m.userId) ?? 0,
      upcomingAppointments: apptsMap.get(m.userId) ?? 0,
    })),
    unassigned: {
      openTasks: tasksMap.get("unassigned") ?? 0,
      overdueTasks: overdueMap.get("unassigned") ?? 0,
      activeLeads: leadsMap.get("unassigned") ?? 0,
      upcomingAppointments: apptsMap.get("unassigned") ?? 0,
    },
  };
}

async function revenueSummary(organizationId: string, days: number) {
  const since = daysAgo(days);
  const estimates = await db
    .select({
      status: estimatesTable.status,
      count: count(),
      totalCents: sql<number>`coalesce(sum(${estimatesTable.totalCents}), 0)::bigint`,
    })
    .from(estimatesTable)
    .where(
      and(
        eq(estimatesTable.organizationId, organizationId),
        gte(estimatesTable.createdAt, since),
        validWorkReadScope(organizationId, estimatesTable.leadId, estimatesTable.customerWorkId),
      ),
    )
    .groupBy(estimatesTable.status);
  const projects = await db
    .select({ status: projectsTable.status, count: count() })
    .from(projectsTable)
    .where(
      and(
        eq(projectsTable.organizationId, organizationId),
        gte(projectsTable.createdAt, since),
        validWorkReadScope(organizationId, projectsTable.leadId, projectsTable.customerWorkId),
      ),
    )
    .groupBy(projectsTable.status);
  // Value of estimates behind projects (accepted work in production).
  const [bookedValue] = await db
    .select({
      totalCents: sql<number>`coalesce(sum(${estimatesTable.totalCents}), 0)::bigint`,
    })
    .from(projectsTable)
    .innerJoin(estimatesTable, and(eq(projectsTable.estimateId, estimatesTable.id),
      eq(estimatesTable.organizationId, organizationId),
      sql`${estimatesTable.leadId} IS NOT DISTINCT FROM ${projectsTable.leadId}`,
      sql`${estimatesTable.customerWorkId} IS NOT DISTINCT FROM ${projectsTable.customerWorkId}`))
    .where(
      and(
        eq(projectsTable.organizationId, organizationId),
        gte(projectsTable.createdAt, since),
        sql`${projectsTable.status} <> 'cancelled'`,
        validWorkReadScope(organizationId, projectsTable.leadId, projectsTable.customerWorkId),
      ),
    );
  return {
    windowDays: days,
    estimatesByStatus: estimates.map((e) => ({
      status: e.status,
      count: e.count,
      totalDollars: Number(e.totalCents) / 100,
    })),
    projectsByStatus: projects,
    bookedProjectValueDollars: Number(bookedValue?.totalCents ?? 0) / 100,
    boundary: "Validated opportunity and returning-customer native work. Saved estimate/job values are not cash, newly acquired/recovered revenue, customer signatures or causal ROI. External receipts live in the value ledger.",
  };
}

async function staleLeads(organizationId: string, days: number, limit: number) {
  const rows = await db
    .select({
      id: leadsTable.id,
      status: leadsTable.status,
      source: leadsTable.source,
      serviceType: leadsTable.serviceType,
      score: leadsTable.score,
      estimatedValueCents: leadsTable.estimatedValueCents,
      updatedAt: leadsTable.updatedAt,
    })
    .from(leadsTable)
    .where(
      and(
        eq(leadsTable.organizationId, organizationId),
        sql`${leadsTable.status} not in ('completed', 'lost', 'nurture', 'won', 'production_scheduled', 'in_progress', 'final_walkthrough', 'review_requested')`,
        sql`${leadsTable.updatedAt} < now() - make_interval(days => ${days})`,
      ),
    )
    .orderBy(desc(leadsTable.score))
    .limit(Math.min(limit, 25));
  return {
    staleAfterDays: days,
    count: rows.length,
    leads: rows.map((r) => ({
      ...r,
      estimatedValueDollars:
        r.estimatedValueCents != null ? r.estimatedValueCents / 100 : null,
      estimatedValueCents: undefined,
    })),
  };
}

/* --------------------------------------------------------- tool registry */

interface ToolDef {
  description: string;
  parameters: Record<string, unknown>;
  run: (organizationId: string, args: Record<string, unknown>) => Promise<unknown>;
}

const intArg = (v: unknown, fallback: number, max: number) => {
  const n = typeof v === "number" ? Math.floor(v) : Number.parseInt(String(v ?? ""), 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, max) : fallback;
};

const TOOL_RUNNERS: Record<string, ToolDef["run"]> = {
  get_pipeline_snapshot: (org, a) => pipelineSnapshot(org, intArg(a.days, 30, 3650)),
  get_conversion_insights: (org, a) => conversionInsights(org, intArg(a.days, 90, 3650)),
  get_appointments_stats: (org, a) => appointmentsStats(org, intArg(a.days, 30, 3650)),
  get_team_workload: (org) => teamWorkload(org),
  get_revenue_summary: (org, a) => revenueSummary(org, intArg(a.days, 90, 3650)),
  get_stale_leads: (org, a) => staleLeads(org, intArg(a.days, 14, 3650), intArg(a.limit, 10, 25)),
};

export const TOOLS: Record<string, ToolDef> = Object.fromEntries(
  Object.entries(ASSISTANT_TOOL_SPECS).map(([name, spec]) => {
    const run = TOOL_RUNNERS[name];
    if (!run) throw new Error(`Assistant tool ${name} has no implementation.`);
    return [name, { ...spec, run }];
  }),
);

/* ------------------------------------------------------------ chat loop */

/**
 * Run one assistant turn. Resolves tool calls (up to MAX_TOOL_ROUNDS), then
 * streams the final answer through onDelta. Returns the full answer text.
 */
export async function runAssistantChat(params: {
  organizationId: string;
  messages: AssistantChatMessage[];
  onDelta: (text: string) => void;
  onToolCall?: (toolName: string) => void;
}): Promise<string> {
  const [org] = await db
    .select({ name: organizationsTable.name })
    .from(organizationsTable)
    .where(eq(organizationsTable.id, params.organizationId))
    .limit(1);

  const tools: Record<string, AssistantLoopTool> = Object.fromEntries(
    Object.entries(TOOLS).map(([name, tool]) => [
      name,
      {
        description: tool.description,
        parameters: tool.parameters,
        run: (args: Record<string, unknown>) => tool.run(params.organizationId, args),
      },
    ]),
  );

  return runAssistantToolLoop({
    systemPrompt: buildSystemPrompt(org?.name),
    messages: params.messages,
    tools,
    onDelta: params.onDelta,
    onToolCall: params.onToolCall ? (name) => params.onToolCall?.(name) : undefined,
  });
}
