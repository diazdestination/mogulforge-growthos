import {
  activitiesTable,
  appointmentsTable,
  db,
  leadsTable,
  playbookEnrollmentsTable,
  playbookTouchesTable,
  playbooksTable,
  reactivationCampaignLeadsTable,
  reactivationCampaignsTable,
} from "@workspace/db";
import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { originalOpportunityDateSql } from "./source-history";
import {
  inReportingPeriod,
  reportingPeriod,
  type ReportingPeriod,
} from "./reporting-period";

const QUALIFIED_STATUSES = [
  "ai_qualified",
  "inspection_scheduled",
  "inspection_completed",
  "estimate_preparing",
  "estimate_sent",
  "claim_pending",
  "follow_up",
  "won",
  "production_scheduled",
  "in_progress",
  "final_walkthrough",
  "completed",
  "review_requested",
];
const OPEN_PIPELINE_STATUSES = [
  "new",
  "ai_qualified",
  "contact_attempted",
  "inspection_scheduled",
  "inspection_completed",
  "estimate_preparing",
  "estimate_sent",
  "claim_pending",
  "follow_up",
  "nurture",
];

export interface BreakdownRow {
  key: string;
  count: number;
}
export interface RoiReport {
  windowDays: number;
  generatedAt: string;
  period: ReportingPeriod;
  comparison: {
    period: ReportingPeriod;
    appointmentsRecorded: number;
    won: number;
    recordedWinValueCents: number | null;
    unknownWinValues: number;
  };
  dataQuality: {
    unknownOriginalDates: number;
    unknownWinValues: number;
    unknownPipelineValues: number;
    importedFirstTouchExcluded: number;
  };
  evidence: {
    leadId: string;
    title: string;
    wonAt: string;
    valueCents: number | null;
    attribution: string;
  }[];
  leads: {
    total: number;
    qualified: number;
    native: number;
    imported: number;
    bySource: BreakdownRow[];
    byCampaign: BreakdownRow[];
    byTool: BreakdownRow[];
    byLandingPage: BreakdownRow[];
    byServiceType: BreakdownRow[];
  };
  appointments: {
    total: number;
    distinctBookedLeads: number;
    leadsWithAppointment: number;
    appointmentRatePct: number | null;
  };
  responsiveness: {
    leadsContacted: number;
    leadsReplied: number;
    responseRatePct: number | null;
    medianMinutesToFirstTouch: number | null;
    firstTouchMeasuredLeads: number;
  };
  playbooks: {
    playbookId: string;
    name: string;
    kind: string;
    sent: number;
    replied: number;
    booked: number;
    won: number;
  }[];
  reviewsAndReferrals: {
    reviewRequestsSent: number;
    reviewLinkClicks: number;
    referralRequestsSent: number;
    referralSubmissions: number;
    referralLeads: number;
  };
  reactivation: {
    campaignsLaunched: number;
    leadsEnrolled: number;
    leadsReplied: number;
  };
  outcomes: {
    won: number;
    revenueWonCents: number | null;
    revenueByAttribution: {
      category: string;
      count: number;
      revenueCents: number | null;
      unknownValues: number;
    }[];
    pipelineValueCents: number | null;
    lost: number;
    lostReasons: BreakdownRow[];
  };
}
const breakdown = (
  rows: { key: string | null; count: number }[],
): BreakdownRow[] =>
  rows
    .map((r) => ({ key: r.key ?? "unknown", count: r.count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 25);
const pct = (n: number, d: number) =>
  d > 0 ? Math.round((n / d) * 100) : null;
/** One transaction uses one connection; keep the snapshot reads sequential. */
async function readSequential<const T extends readonly PromiseLike<unknown>[]>(
  queries: T,
): Promise<{ [K in keyof T]: Awaited<T[K]> }> {
  const results: unknown[] = [];
  for (const query of queries) results.push(await query);
  return results as { [K in keyof T]: Awaited<T[K]> };
}
/** A known subtotal is distinct from a complete value; all-unknown remains null. */
function cents(value: string | number | null, count: number): number | null {
  if (value == null) return count === 0 ? 0 : null;
  const n = Number(value);
  if (!Number.isSafeInteger(n))
    throw new Error("Report value exceeds supported precision.");
  return n;
}

/**
 * Creation cohort, timestamped events, and current pipeline are separate.
 * Imported original dates determine cohorts. Current status is not historical status
 * at period end, and recorded outcomes/attribution do not establish causal lift.
 */
export async function getRoiReport(
  organizationId: string,
  windowDays: number,
  end = new Date(),
): Promise<RoiReport> {
  const period = reportingPeriod(windowDays, end);
  const previous = reportingPeriod(windowDays, new Date(period.startAt));
  return db.transaction(
    async (reader) => {
      const date = originalOpportunityDateSql(leadsTable);
      const imported = sql`(${leadsTable.creationMethod} = 'import' or ${leadsTable.importedHistory} is not null)`;
      const cohort = and(
        eq(leadsTable.organizationId, organizationId),
        inReportingPeriod(date, period),
      );
      const groupCount = (col: AnyPgColumn) =>
        reader
          .select({ key: col, count: sql<number>`count(*)::int` })
          .from(leadsTable)
          .where(cohort)
          .groupBy(col);
      // FK constraints alone do not guarantee matching organization IDs.
      const validTouches = and(
        eq(playbookTouchesTable.organizationId, organizationId),
        sql`exists (select 1 from ${leadsTable} l where l.id = ${playbookTouchesTable.leadId} and l.organization_id = ${organizationId})`,
        sql`exists (select 1 from ${playbooksTable} p where p.id = ${playbookTouchesTable.playbookId} and p.organization_id = ${organizationId})`,
        sql`exists (select 1 from ${playbookEnrollmentsTable} e where e.id = ${playbookTouchesTable.enrollmentId} and e.organization_id = ${organizationId} and e.lead_id = ${playbookTouchesTable.leadId} and e.playbook_id = ${playbookTouchesTable.playbookId})`,
      );
      const bookingStats = (range: ReportingPeriod) =>
        reader
          .select({
            total: sql<number>`count(*)::int`,
            distinctLeads: sql<number>`count(distinct ${appointmentsTable.leadId})::int`,
            cohortLeads: sql<number>`count(distinct ${appointmentsTable.leadId}) filter (where ${inReportingPeriod(date, range)})::int`,
          })
          .from(appointmentsTable)
          .innerJoin(
            leadsTable,
            and(
              eq(leadsTable.id, appointmentsTable.leadId),
              eq(leadsTable.organizationId, organizationId),
            ),
          )
          .where(
            and(
              eq(appointmentsTable.organizationId, organizationId),
              sql`${appointmentsTable.status} <> 'cancelled'`,
              inReportingPeriod(appointmentsTable.createdAt, range),
            ),
          );
      const winStats = (range: ReportingPeriod) =>
        reader
          .select({
            won: sql<number>`count(*)::int`,
            revenue: sql<
              string | null
            >`sum(${leadsTable.wonRevenueCents})::text`,
            unknown: sql<number>`count(*) filter (where ${leadsTable.wonRevenueCents} is null)::int`,
          })
          .from(leadsTable)
          .where(
            and(
              eq(leadsTable.organizationId, organizationId),
              inReportingPeriod(leadsTable.wonAt, range),
            ),
          );

      const [
        [totals],
        bySource,
        byCampaign,
        byTool,
        byLandingPage,
        byServiceType,
        [appts],
        [previousAppts],
        [contacts],
        [firstTouch],
        playbooks,
        [engagement],
        [requests],
        [campaigns],
        [enrolled],
        [reactivationReplies],
        [wins],
        [previousWins],
        attribution,
        [pipeline],
        lostReasons,
        [unknownDates],
        evidence,
      ] = await readSequential([
        reader
          .select({
            total: sql<number>`count(*)::int`,
            qualified: sql<number>`count(*) filter (where ${inArray(leadsTable.status, QUALIFIED_STATUSES as never[])})::int`,
            imported: sql<number>`count(*) filter (where ${imported})::int`,
            referrals: sql<number>`count(*) filter (where ${leadsTable.source} = 'referral')::int`,
          })
          .from(leadsTable)
          .where(cohort),
        groupCount(leadsTable.source),
        groupCount(leadsTable.campaign),
        groupCount(leadsTable.creationMethod),
        groupCount(leadsTable.landingPage),
        groupCount(leadsTable.serviceType),
        bookingStats(period),
        bookingStats(previous),
        reader
          .select({
            contacted: sql<number>`count(distinct ${playbookTouchesTable.leadId})::int`,
            replied: sql<number>`count(distinct ${playbookTouchesTable.leadId}) filter (where ${inReportingPeriod(playbookTouchesTable.repliedAt, period)} and ${playbookTouchesTable.repliedAt} >= ${playbookTouchesTable.sentAt})::int`,
          })
          .from(playbookTouchesTable)
          .where(
            and(
              validTouches,
              inReportingPeriod(playbookTouchesTable.sentAt, period),
            ),
          ),
        // First logged automated outreach for native leads; historical first contact
        // and human response coverage cannot be inferred from imported snapshots.
        reader
          .select({
            median: sql<
              number | null
            >`percentile_cont(0.5) within group (order by extract(epoch from (ft.first_sent - ${leadsTable.createdAt})) / 60)`,
            measured: sql<number>`count(*)::int`,
          })
          .from(leadsTable)
          .innerJoin(
            sql`(select ${playbookTouchesTable.leadId} as lead_id, min(${playbookTouchesTable.sentAt}) as first_sent from ${playbookTouchesTable} where ${validTouches} group by ${playbookTouchesTable.leadId}) ft`,
            sql`ft.lead_id = ${leadsTable.id}`,
          )
          .where(
            and(
              cohort,
              sql`not coalesce(${imported}, false)`,
              sql`ft.first_sent >= ${leadsTable.createdAt} and ft.first_sent < ${period.endAt}::timestamptz`,
            ),
          ),
        reader
          .select({
            playbookId: playbookTouchesTable.playbookId,
            name: playbooksTable.name,
            kind: playbooksTable.kind,
            sent: sql<number>`count(*) filter (where ${inReportingPeriod(playbookTouchesTable.sentAt, period)})::int`,
            replied: sql<number>`count(distinct ${playbookTouchesTable.leadId}) filter (where ${inReportingPeriod(playbookTouchesTable.repliedAt, period)} and ${playbookTouchesTable.repliedAt} >= ${playbookTouchesTable.sentAt})::int`,
            booked: sql<number>`count(distinct ${playbookTouchesTable.leadId}) filter (where ${inReportingPeriod(playbookTouchesTable.bookedAt, period)} and ${playbookTouchesTable.bookedAt} >= ${playbookTouchesTable.sentAt} and exists (select 1 from ${appointmentsTable} a where a.organization_id = ${organizationId} and a.lead_id = ${playbookTouchesTable.leadId} and a.status <> 'cancelled' and a.created_at >= ${period.startAt}::timestamptz and a.created_at < ${period.endAt}::timestamptz))::int`,
            won: sql<number>`count(distinct ${playbookTouchesTable.leadId}) filter (where ${playbookTouchesTable.finalOutcome} = 'won' and ${inReportingPeriod(playbookTouchesTable.finalOutcomeAt, period)} and ${playbookTouchesTable.finalOutcomeAt} >= ${playbookTouchesTable.sentAt})::int`,
          })
          .from(playbookTouchesTable)
          .innerJoin(
            playbooksTable,
            eq(playbooksTable.id, playbookTouchesTable.playbookId),
          )
          .where(
            and(
              validTouches,
              or(
                inReportingPeriod(playbookTouchesTable.sentAt, period),
                inReportingPeriod(playbookTouchesTable.repliedAt, period),
                inReportingPeriod(playbookTouchesTable.bookedAt, period),
                inReportingPeriod(playbookTouchesTable.finalOutcomeAt, period),
              ),
            ),
          )
          .groupBy(
            playbookTouchesTable.playbookId,
            playbooksTable.name,
            playbooksTable.kind,
          ),
        reader
          .select({
            reviewClicks: sql<number>`count(*) filter (where ${activitiesTable.type} = 'review_link_clicked')::int`,
            referrals: sql<number>`count(*) filter (where ${activitiesTable.type} = 'referral_submitted')::int`,
          })
          .from(activitiesTable)
          .innerJoin(
            leadsTable,
            and(
              eq(leadsTable.id, activitiesTable.leadId),
              eq(leadsTable.organizationId, organizationId),
            ),
          )
          .where(
            and(
              eq(activitiesTable.organizationId, organizationId),
              inArray(activitiesTable.type, [
                "review_link_clicked",
                "referral_submitted",
              ]),
              inReportingPeriod(activitiesTable.occurredAt, period),
            ),
          ),
        reader
          .select({
            review: sql<number>`count(*) filter (where ${playbooksTable.seedKey} = 'post_sale.review_request' or ${playbooksTable.name} ilike '%review%')::int`,
            referral: sql<number>`count(*) filter (where ${playbooksTable.seedKey} = 'post_sale.referral_request' or ${playbooksTable.name} ilike '%referral%')::int`,
          })
          .from(playbookTouchesTable)
          .innerJoin(
            playbooksTable,
            eq(playbooksTable.id, playbookTouchesTable.playbookId),
          )
          .where(
            and(
              validTouches,
              eq(playbooksTable.kind, "post_sale"),
              inReportingPeriod(playbookTouchesTable.sentAt, period),
            ),
          ),
        reader
          .select({ count: sql<number>`count(*)::int` })
          .from(reactivationCampaignsTable)
          .where(
            and(
              eq(reactivationCampaignsTable.organizationId, organizationId),
              inReportingPeriod(reactivationCampaignsTable.launchedAt, period),
              sql`exists (select 1 from ${playbooksTable} p where p.id = ${reactivationCampaignsTable.playbookId} and p.organization_id = ${organizationId})`,
            ),
          ),
        reader
          .select({
            count: sql<number>`count(distinct ${reactivationCampaignLeadsTable.id})::int`,
          })
          .from(reactivationCampaignLeadsTable)
          .innerJoin(
            reactivationCampaignsTable,
            and(
              eq(
                reactivationCampaignsTable.id,
                reactivationCampaignLeadsTable.campaignId,
              ),
              eq(reactivationCampaignsTable.organizationId, organizationId),
              sql`exists (select 1 from ${playbooksTable} p where p.id = ${reactivationCampaignsTable.playbookId} and p.organization_id = ${organizationId})`,
            ),
          )
          .innerJoin(
            leadsTable,
            and(
              eq(leadsTable.id, reactivationCampaignLeadsTable.leadId),
              eq(leadsTable.organizationId, organizationId),
            ),
          )
          .innerJoin(
            playbookEnrollmentsTable,
            and(
              eq(
                playbookEnrollmentsTable.id,
                reactivationCampaignLeadsTable.enrollmentId,
              ),
              eq(playbookEnrollmentsTable.organizationId, organizationId),
              eq(
                playbookEnrollmentsTable.leadId,
                reactivationCampaignLeadsTable.leadId,
              ),
              eq(
                playbookEnrollmentsTable.playbookId,
                reactivationCampaignsTable.playbookId,
              ),
            ),
          )
          .where(
            and(
              eq(reactivationCampaignLeadsTable.organizationId, organizationId),
              inReportingPeriod(
                reactivationCampaignLeadsTable.enrolledAt,
                period,
              ),
            ),
          ),
        reader
          .select({
            count: sql<number>`count(distinct ${playbookTouchesTable.leadId})::int`,
          })
          .from(playbookTouchesTable)
          .where(
            and(
              validTouches,
              inReportingPeriod(playbookTouchesTable.repliedAt, period),
              sql`${playbookTouchesTable.repliedAt} >= ${playbookTouchesTable.sentAt}`,
              sql`exists (select 1 from ${reactivationCampaignLeadsTable} cl join ${reactivationCampaignsTable} c on c.id = cl.campaign_id and c.organization_id = ${organizationId} where cl.organization_id = ${organizationId} and cl.lead_id = ${playbookTouchesTable.leadId} and cl.enrollment_id = ${playbookTouchesTable.enrollmentId} and c.playbook_id = ${playbookTouchesTable.playbookId})`,
            ),
          ),
        winStats(period),
        winStats(previous),
        reader
          .select({
            category: leadsTable.wonAttribution,
            count: sql<number>`count(*)::int`,
            revenue: sql<
              string | null
            >`sum(${leadsTable.wonRevenueCents})::text`,
            unknown: sql<number>`count(*) filter (where ${leadsTable.wonRevenueCents} is null)::int`,
          })
          .from(leadsTable)
          .where(
            and(
              eq(leadsTable.organizationId, organizationId),
              inReportingPeriod(leadsTable.wonAt, period),
            ),
          )
          .groupBy(leadsTable.wonAttribution),
        reader
          .select({
            count: sql<number>`count(*)::int`,
            value: sql<
              string | null
            >`sum(${leadsTable.estimatedValueCents})::text`,
            unknown: sql<number>`count(*) filter (where ${leadsTable.estimatedValueCents} is null)::int`,
          })
          .from(leadsTable)
          .where(
            and(
              eq(leadsTable.organizationId, organizationId),
              inArray(leadsTable.status, OPEN_PIPELINE_STATUSES as never[]),
            ),
          ),
        // No authoritative lostAt exists: arbitrary edits are not loss events.
        reader
          .select({
            key: leadsTable.lostReason,
            count: sql<number>`count(*)::int`,
          })
          .from(leadsTable)
          .where(and(cohort, eq(leadsTable.status, "lost")))
          .groupBy(leadsTable.lostReason),
        reader
          .select({ count: sql<number>`count(*)::int` })
          .from(leadsTable)
          .where(
            and(
              eq(leadsTable.organizationId, organizationId),
              sql`${date} is null`,
            ),
          ),
        reader
          .select({
            leadId: leadsTable.id,
            title: leadsTable.summary,
            wonAt: leadsTable.wonAt,
            valueCents: leadsTable.wonRevenueCents,
            attribution: leadsTable.wonAttribution,
          })
          .from(leadsTable)
          .where(
            and(
              eq(leadsTable.organizationId, organizationId),
              inReportingPeriod(leadsTable.wonAt, period),
            ),
          )
          .orderBy(desc(leadsTable.wonAt), leadsTable.id)
          .limit(20),
      ]);

      return {
        windowDays,
        generatedAt: new Date().toISOString(),
        period,
        comparison: {
          period: previous,
          appointmentsRecorded: previousAppts.total,
          won: previousWins.won,
          recordedWinValueCents: cents(previousWins.revenue, previousWins.won),
          unknownWinValues: previousWins.unknown,
        },
        dataQuality: {
          unknownOriginalDates: unknownDates.count,
          unknownWinValues: wins.unknown,
          unknownPipelineValues: pipeline.unknown,
          importedFirstTouchExcluded: totals.imported,
        },
        evidence: evidence.map((r) => ({
          ...r,
          title: r.title || "Won opportunity",
          wonAt: r.wonAt!.toISOString(),
          attribution: r.attribution ?? "unknown",
        })),
        leads: {
          total: totals.total,
          qualified: totals.qualified,
          native: totals.total - totals.imported,
          imported: totals.imported,
          bySource: breakdown(bySource),
          byCampaign: breakdown(byCampaign),
          byTool: breakdown(byTool),
          byLandingPage: breakdown(byLandingPage),
          byServiceType: breakdown(byServiceType),
        },
        appointments: {
          total: appts.total,
          distinctBookedLeads: appts.distinctLeads,
          leadsWithAppointment: appts.cohortLeads,
          appointmentRatePct: pct(appts.cohortLeads, totals.total),
        },
        responsiveness: {
          leadsContacted: contacts.contacted,
          leadsReplied: contacts.replied,
          responseRatePct: pct(contacts.replied, contacts.contacted),
          medianMinutesToFirstTouch:
            firstTouch.median == null
              ? null
              : Math.round(Number(firstTouch.median)),
          firstTouchMeasuredLeads: firstTouch.measured,
        },
        playbooks: playbooks.sort((a, b) => b.sent - a.sent),
        reviewsAndReferrals: {
          reviewRequestsSent: requests.review,
          reviewLinkClicks: engagement.reviewClicks,
          referralRequestsSent: requests.referral,
          referralSubmissions: engagement.referrals,
          referralLeads: totals.referrals,
        },
        reactivation: {
          campaignsLaunched: campaigns.count,
          leadsEnrolled: enrolled.count,
          leadsReplied: reactivationReplies.count,
        },
        outcomes: {
          won: wins.won,
          revenueWonCents: cents(wins.revenue, wins.won),
          revenueByAttribution: attribution
            .map((r) => ({
              category: r.category ?? "unknown",
              count: r.count,
              revenueCents: cents(r.revenue, r.count),
              unknownValues: r.unknown,
            }))
            .sort((a, b) => (b.revenueCents ?? -1) - (a.revenueCents ?? -1)),
          pipelineValueCents: cents(pipeline.value, pipeline.count),
          lost: lostReasons.reduce((n, r) => n + r.count, 0),
          lostReasons: breakdown(lostReasons),
        },
      };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}

/** Text cells are spreadsheet-safe, including formulas hidden behind whitespace. */
export function roiReportToCsv(report: RoiReport): string {
  const esc = (value: string | number | null) => {
    let s = String(value ?? "");
    if (typeof value === "string" && /^[\s\u0000-\u001f]*[=+\-@]/u.test(s))
      s = "'" + s;
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const rows: (string | number | null)[][] = [
    ["section", "metric", "key", "value"],
    ["meta", "window_days", "", report.windowDays],
    ["meta", "generated_at", "", report.generatedAt],
    ["meta", "start_at_inclusive", "UTC", report.period.startAt],
    ["meta", "end_at_exclusive", "UTC", report.period.endAt],
    [
      "meta",
      "cohort_definition",
      "",
      "Original opportunity creation date; imported dates unknown are excluded. Current statuses are not historical snapshots.",
    ],
    [
      "meta",
      "event_definition",
      "",
      "Booking creation, touch/outcome event and won dates in period. Canceled bookings excluded using current status. Lead-linked bookings only.",
    ],
    [
      "meta",
      "value_definition",
      "",
      "Known recorded USD subtotals; blanks mean unknown. Attribution is not proof of causal lift or collected cash.",
    ],
    ["leads", "total", "", report.leads.total],
    ["leads", "qualified_current", "", report.leads.qualified],
    ["leads", "native", "", report.leads.native],
    ["leads", "imported_with_original_date", "", report.leads.imported],
    ...(
      [
        "bySource",
        "byCampaign",
        "byTool",
        "byLandingPage",
        "byServiceType",
      ] as const
    ).flatMap((key) =>
      report.leads[key].map((r) => [
        "leads",
        key.replace(/[A-Z]/g, (c) => "_" + c.toLowerCase()),
        r.key,
        r.count,
      ]),
    ),
    ["appointments", "records_created", "", report.appointments.total],
    [
      "appointments",
      "distinct_booked_leads",
      "",
      report.appointments.distinctBookedLeads,
    ],
    [
      "appointments",
      "cohort_leads_booked",
      "",
      report.appointments.leadsWithAppointment,
    ],
    [
      "appointments",
      "cohort_appointment_rate_pct",
      "",
      report.appointments.appointmentRatePct,
    ],
    ...Object.entries(report.responsiveness).map(([key, value]) => [
      "responsiveness",
      key,
      "",
      value,
    ]),
    ...report.playbooks.flatMap((p) =>
      (["sent", "replied", "booked", "won"] as const).map((key) => [
        "playbooks",
        key,
        p.name,
        p[key],
      ]),
    ),
    ...Object.entries(report.reviewsAndReferrals).map(([key, value]) => [
      "reviews_referrals",
      key,
      "",
      value,
    ]),
    ...Object.entries(report.reactivation).map(([key, value]) => [
      "reactivation",
      key,
      "",
      value,
    ]),
    ["outcomes", "won", "", report.outcomes.won],
    ["outcomes", "revenue_won_cents", "", report.outcomes.revenueWonCents],
    ...report.outcomes.revenueByAttribution.flatMap((r) => [
      ["outcomes", "revenue_by_attribution_cents", r.category, r.revenueCents],
      ["outcomes", "won_by_attribution", r.category, r.count],
      ["outcomes", "unknown_win_values", r.category, r.unknownValues],
    ]),
    [
      "current_snapshot",
      "pipeline_known_value_cents",
      "",
      report.outcomes.pipelineValueCents,
    ],
    ["cohort_current_status", "lost", "", report.outcomes.lost],
    ...report.outcomes.lostReasons.map((r) => [
      "cohort_current_status",
      "lost_reason",
      r.key,
      r.count,
    ]),
    ...Object.entries(report.dataQuality).map(([key, value]) => [
      "data_quality",
      key,
      "",
      value,
    ]),
    [
      "previous_period",
      "start_at_inclusive",
      "UTC",
      report.comparison.period.startAt,
    ],
    [
      "previous_period",
      "end_at_exclusive",
      "UTC",
      report.comparison.period.endAt,
    ],
    [
      "previous_period",
      "appointments_recorded",
      "",
      report.comparison.appointmentsRecorded,
    ],
    ["previous_period", "won", "", report.comparison.won],
    [
      "previous_period",
      "recorded_win_value_cents",
      "",
      report.comparison.recordedWinValueCents,
    ],
    [
      "previous_period",
      "unknown_win_values",
      "",
      report.comparison.unknownWinValues,
    ],
    ...report.evidence.flatMap((r) => [
      ["win_evidence", "won_at", r.leadId, r.wonAt],
      ["win_evidence", "recorded_value_cents", r.leadId, r.valueCents],
      ["win_evidence", "attribution", r.leadId, r.attribution],
    ]),
  ];
  return rows.map((row) => row.map(esc).join(",")).join("\n") + "\n";
}
