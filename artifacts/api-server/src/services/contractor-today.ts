import { db, usersTable } from "@workspace/db";
import { and, eq, sql, type SQL } from "drizzle-orm";
import { z } from "zod/v4";
import { hasPermission } from "../lib/permissions";

export const contractorTodayQuery = z
  .object({
    date: z.iso.date().optional(),
    scope: z.enum(["mine", "company"]).optional(),
  })
  .strict();
const LIMIT = 50;
type Scope = "mine" | "company";
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export class ContractorTodayError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export interface DayTask {
  id: string;
  title: string;
  status: string;
  dueAt: string | null;
  leadId: string | null;
  contactId: string | null;
  customerLabel: string | null;
  assignedUserId: string | null;
  assigneeName: string | null;
  actionPath: string;
}
export interface DayAppointment {
  id: string;
  title: string;
  type: string;
  status: string;
  leadId: string | null;
  contactId: string | null;
  customerLabel: string | null;
  assignedUserId: string | null;
  assigneeName: string | null;
  scheduledStart: string;
  scheduledEnd: string | null;
}
export interface DayProject {
  id: string;
  title: string;
  status: string;
  leadId: string;
  customerLabel: string | null;
  crewNames: string[];
  scheduledStart: string | null;
  scheduledEnd: string | null;
}
export interface DayService {
  id: string;
  title: string;
  kind: string;
  status: string;
  dueAt: string;
  contactId: string;
  customerLabel: string | null;
  assignedUserId: string | null;
  assigneeName: string | null;
  taskId: string;
}
export interface DayQueue<T> {
  items: T[];
  total: number;
  truncated: boolean;
}
export interface ContractorToday {
  organizationId: string;
  generatedAt: string;
  date: string;
  timeZone: string;
  timeZoneSource: "configured" | "utc_fallback";
  startAt: string;
  endAt: string;
  scope: Scope;
  tasks: DayQueue<DayTask>;
  appointments: DayQueue<DayAppointment>;
  projects: DayQueue<DayProject>;
  services: DayQueue<DayService>;
}
const validZone = (value: unknown): value is string => {
  if (typeof value !== "string" || value.length > 100) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
};
const iso = (value: unknown): string | null =>
  value == null ? null : new Date(value as string).toISOString();
async function queue<T>(
  tx: Tx,
  selection: SQL,
  order: SQL,
): Promise<DayQueue<T>> {
  const result = await tx.execute(sql`SELECT *, count(*) OVER()::int AS "_total"
    FROM (${selection}) AS work ORDER BY ${order} LIMIT ${LIMIT}`);
  const total = Number(result.rows[0]?._total ?? 0);
  const items = result.rows.map((raw) => {
    const row = { ...raw };
    delete row._total;
    for (const key of ["dueAt", "scheduledStart", "scheduledEnd"])
      if (key in row) row[key] = iso(row[key]);
    return row as T;
  });
  return { items, total, truncated: total > items.length };
}

/** A company-scoped, read-only workday snapshot, never a filtered all-time page. */
export async function getContractorToday(
  organizationId: string,
  userId: string,
  input: z.infer<typeof contractorTodayQuery> = {},
  now = new Date(),
  effectiveRole?: (typeof usersTable.$inferSelect)["role"],
): Promise<ContractorToday> {
  const query = contractorTodayQuery.parse(input);
  return db.transaction(
    async (tx) => {
      const [actor] = await tx
        .select()
        .from(usersTable)
        .where(
          and(
            eq(usersTable.id, userId),
            eq(usersTable.organizationId, organizationId),
            eq(usersTable.isActive, true),
          ),
        );
      if (
        !actor ||
        !hasPermission(actor.role, "crm.read") ||
        (effectiveRole !== undefined &&
          !hasPermission(effectiveRole, "crm.read"))
      )
        throw new ContractorTodayError(
          403,
          "An active company membership is required.",
        );
      const scope: Scope =
        query.scope ??
        (["owner", "admin", "office", "sales_manager"].includes(
          effectiveRole ?? actor.role,
        )
          ? "company"
          : "mine");
      // Do not call getOrgSettings: its legacy normalization can write during a GET.
      const settings =
        await tx.execute(sql`SELECT inspection_availability->>'timezone' AS zone
      FROM org_settings WHERE organization_id=${organizationId} LIMIT 1`);
      const candidate = settings.rows[0]?.zone;
      let timeZone = validZone(candidate) ? candidate : "UTC";
      let timeZoneSource: "configured" | "utc_fallback" = validZone(candidate)
        ? "configured"
        : "utc_fallback";
      const zones = await tx.execute(
        sql`SELECT 1 FROM pg_timezone_names WHERE name=${timeZone} LIMIT 1`,
      );
      if (!zones.rows.length) {
        timeZone = "UTC";
        timeZoneSource = "utc_fallback";
      }
      const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).formatToParts(now);
      const part = (key: string) => parts.find((p) => p.type === key)!.value;
      const date =
        query.date ?? `${part("year")}-${part("month")}-${part("day")}`;
      const bounds = await tx.execute(sql`SELECT
      (${date}::date::timestamp AT TIME ZONE ${timeZone}) AS start,
      ((${date}::date + 1)::timestamp AT TIME ZONE ${timeZone}) AS finish`);
      const startAt = iso(bounds.rows[0].start)!,
        endAt = iso(bounds.rows[0].finish)!;
      const mine = scope === "mine";
      const invoiceReader =
        hasPermission(actor.role, "invoices.read") &&
        hasPermission(effectiveRole ?? actor.role, "invoices.read");
      const tasks = await queue<DayTask>(
        tx,
        sql`
      SELECT t.id,t.title,t.status,t.due_at AS "dueAt",l.id AS "leadId",
        coalesce(c.id,lc.id) AS "contactId",
        nullif(concat_ws(' ',coalesce(c.first_name,lc.first_name),coalesce(c.last_name,lc.last_name)),'') AS "customerLabel",
        u.id AS "assignedUserId",nullif(concat_ws(' ',u.first_name,u.last_name),'') AS "assigneeName",
        CASE WHEN ${invoiceReader} AND handoff.id IS NOT NULL
          THEN '/invoices?projectId='||handoff.id::text ELSE '/tasks?taskId='||t.id::text END AS "actionPath"
      FROM crm_tasks t
      LEFT JOIN leads l ON l.id=t.lead_id AND l.organization_id=${organizationId}
      LEFT JOIN contacts c ON c.id=t.contact_id AND c.organization_id=${organizationId}
      LEFT JOIN contacts lc ON lc.id=l.contact_id AND lc.organization_id=${organizationId}
      LEFT JOIN users u ON u.id=t.assigned_user_id AND u.organization_id=${organizationId}
      LEFT JOIN projects handoff ON t.source_event='project.invoice_preparation:'||handoff.id::text AND handoff.organization_id=${organizationId}
      WHERE t.organization_id=${organizationId} AND t.status IN ('open','in_progress')
        AND (t.due_at IS NULL OR t.due_at<${endAt}::timestamptz)
        AND (NOT ${mine} OR t.assigned_user_id=${userId})
        AND (t.lead_id IS NULL OR l.id IS NOT NULL)
        AND (t.contact_id IS NULL OR c.id IS NOT NULL)
        AND (l.id IS NULL OR lc.id IS NOT NULL)
    `,
        sql`"dueAt" ASC NULLS LAST,id`,
      );
      const appointments = await queue<DayAppointment>(
        tx,
        sql`
      SELECT a.id,a.type AS title,a.type,a.status,l.id AS "leadId",coalesce(c.id,lc.id) AS "contactId",
        nullif(concat_ws(' ',coalesce(c.first_name,lc.first_name),coalesce(c.last_name,lc.last_name)),'') AS "customerLabel",
        u.id AS "assignedUserId",nullif(concat_ws(' ',u.first_name,u.last_name),'') AS "assigneeName",
        a.scheduled_start AS "scheduledStart",a.scheduled_end AS "scheduledEnd"
      FROM appointments a
      LEFT JOIN leads l ON l.id=a.lead_id AND l.organization_id=${organizationId}
      LEFT JOIN contacts c ON c.id=a.contact_id AND c.organization_id=${organizationId}
      LEFT JOIN contacts lc ON lc.id=l.contact_id AND lc.organization_id=${organizationId}
      LEFT JOIN users u ON u.id=a.assigned_user_id AND u.organization_id=${organizationId}
      WHERE a.organization_id=${organizationId} AND a.status<>'cancelled'
        AND a.scheduled_start<${endAt}::timestamptz
        AND coalesce(a.scheduled_end,a.scheduled_start+interval '2 hours')>${startAt}::timestamptz
        AND (NOT ${mine} OR a.assigned_user_id=${userId})
        AND (a.lead_id IS NULL OR l.id IS NOT NULL)
        AND (a.contact_id IS NULL OR c.id IS NOT NULL)
        AND (l.id IS NULL OR lc.id IS NOT NULL)
    `,
        sql`"scheduledStart",id`,
      );
      const projects = await queue<DayProject>(
        tx,
        sql`
      SELECT p.id,p.name AS title,p.status,l.id AS "leadId",
        nullif(concat_ws(' ',c.first_name,c.last_name),'') AS "customerLabel",
        p.scheduled_start AS "scheduledStart",p.scheduled_end AS "scheduledEnd",
        coalesce((SELECT jsonb_agg(nullif(concat_ws(' ',u.first_name,u.last_name),'') ORDER BY u.id)
          FROM users u WHERE u.organization_id=${organizationId} AND p.crew_user_ids ? u.id),'[]'::jsonb) AS "crewNames"
      FROM projects p JOIN leads l ON l.id=p.lead_id AND l.organization_id=${organizationId}
      JOIN contacts c ON c.id=l.contact_id AND c.organization_id=${organizationId}
      WHERE p.organization_id=${organizationId} AND p.status IN ('scheduled','in_progress','on_hold')
        AND (p.scheduled_start IS NULL OR (p.scheduled_start<${endAt}::timestamptz
          AND (p.scheduled_end>${startAt}::timestamptz OR (p.scheduled_end IS NULL
            AND (p.scheduled_start>=${startAt}::timestamptz OR p.status IN ('in_progress','on_hold'))))))
        AND (NOT ${mine} OR p.crew_user_ids ? ${userId})
    `,
        sql`"scheduledStart" ASC NULLS LAST,id`,
      );
      const services = await queue<DayService>(
        tx,
        sql`
      SELECT s.id,s.equipment_label AS title,s.kind,s.status,s.due_at AS "dueAt",
        c.id AS "contactId",nullif(concat_ws(' ',c.first_name,c.last_name),'') AS "customerLabel",
        u.id AS "assignedUserId",nullif(concat_ws(' ',u.first_name,u.last_name),'') AS "assigneeName",t.id AS "taskId"
      FROM service_obligations s
      JOIN crm_tasks t ON t.id=s.task_id AND t.organization_id=${organizationId}
      JOIN contacts c ON c.id=s.contact_id AND c.organization_id=${organizationId}
      LEFT JOIN users u ON u.id=t.assigned_user_id AND u.organization_id=${organizationId}
      WHERE s.organization_id=${organizationId} AND s.status='active'
        AND (s.due_at AT TIME ZONE 'UTC')::date<=${date}::date
        AND (NOT ${mine} OR t.assigned_user_id=${userId})
    `,
        sql`"dueAt",id`,
      );
      // A nameless same-company crew member remains unnamed rather than fabricated.
      for (const project of projects.items)
        project.crewNames = project.crewNames.filter(Boolean);
      return {
        organizationId,
        generatedAt: now.toISOString(),
        date,
        timeZone,
        timeZoneSource,
        startAt,
        endAt,
        scope,
        tasks,
        appointments,
        projects,
        services,
      };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}
