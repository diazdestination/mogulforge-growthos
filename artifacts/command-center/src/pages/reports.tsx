import { useState } from "react";
import {
  useGetRoiReport,
  exportRoiReport,
  type RoiReport,
  type RoiBreakdownRow,
} from "@workspace/api-client-react";
import { BadgeDollarSign, Download, Loader2 } from "lucide-react";
import { ValueLedger } from "@/components/revenue-workspace";
import { Link } from "wouter";

/**
 * ROI Report — what the platform captured, moved, and won, with HONEST
 * attribution: every revenue figure carries the category recorded at win
 * time; review activity is requests + clicks only (completed third-party
 * reviews are never claimed).
 */

const WINDOWS = [7, 30, 90, 365];

const ATTRIBUTION_LABELS: Record<string, string> = {
  directly_attributed: "Directly attributed",
  assisted: "Assisted",
  self_reported: "Self-reported",
  estimated: "Estimated",
  unknown: "Unknown",
};

const ATTRIBUTION_HINTS: Record<string, string> = {
  directly_attributed:
    "Platform captured the lead and outreach got a reply or booking",
  assisted: "Outreach touched the lead before the win",
  self_reported: "Won without recorded platform outreach",
  estimated: "Figure is the rep's estimate — no accepted estimate on file",
  unknown: "No revenue figure recorded",
};

const dollars = (cents: number | null) =>
  cents == null
    ? "Not recorded"
    : (cents / 100).toLocaleString(undefined, {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: 2,
      });
const date = (value: string) =>
  new Date(value).toLocaleString("en-US", {
    timeZone: "UTC",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

export default function Reports() {
  const [days, setDays] = useState(30);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState(false);
  const { data, isLoading, isError, refetch } = useGetRoiReport({ days });

  const downloadCsv = async () => {
    setExporting(true);
    setExportError(false);
    try {
      const csv = await exportRoiReport({ days, endAt: data?.period.endAt });
      const blob = new Blob([csv], { type: "text/csv" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `roi-report-${days}d.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      setExportError(true);
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="flex flex-col h-full bg-background overflow-y-auto">
      <header className="px-4 py-3 md:px-6 md:py-4 border-b border-border bg-card sticky top-0 z-10 flex flex-wrap items-center gap-3">
        <div className="mr-auto">
          <h1 className="text-xl md:text-2xl font-bold tracking-tight text-foreground">
            Owner report
          </h1>
          <p className="hidden md:block text-sm text-muted-foreground">
            Recorded outcomes, receipts and the evidence behind them.
          </p>
        </div>
        <div
          className="flex items-center gap-1"
          role="group"
          aria-label="Report window"
        >
          {WINDOWS.map((w) => (
            <button
              key={w}
              onClick={() => {
                setDays(w);
                setExportError(false);
              }}
              aria-label={`Last ${w} days`}
              aria-pressed={days === w}
              data-testid={`window-${w}`}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium ${
                days === w
                  ? "bg-primary text-primary-foreground dark:text-slate-950"
                  : "bg-muted text-foreground hover:bg-muted/70"
              }`}
            >
              {w}d
            </button>
          ))}
        </div>
        <button
          onClick={downloadCsv}
          disabled={exporting || isLoading || isError || !data}
          data-testid="export-csv"
          className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border border-border bg-card text-sm font-medium text-foreground hover:bg-muted disabled:opacity-50"
        >
          {exporting ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Download className="w-4 h-4" />
          )}
          Export CSV
        </button>
      </header>

      {exportError && (
        <p role="alert" className="px-4 pt-4 text-sm text-destructive">
          CSV export failed. Your report is still available. Select Export CSV
          to retry.
        </p>
      )}
      {isError ? (
        <div className="p-6 space-y-3" role="alert">
          <p>The owner report could not load. Refresh to retry.</p>
          <button
            className="rounded-lg border px-3 py-2 text-sm hover:bg-muted"
            onClick={() => refetch()}
          >
            Retry report
          </button>
        </div>
      ) : isLoading || !data ? (
        <div
          role="status"
          aria-label="Loading owner report"
          className="flex-1 flex items-center justify-center py-24"
        >
          <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <ReportBody report={data} />
      )}
    </div>
  );
}

function ReportBody({ report }: { report: RoiReport }) {
  const {
    leads,
    appointments,
    responsiveness,
    outcomes,
    reviewsAndReferrals,
    reactivation,
  } = report;
  return (
    <div className="p-4 md:p-6 space-y-6 max-w-6xl">
      <div className="space-y-2">
        <h2 className="text-lg font-semibold">Last {report.windowDays} days</h2>
        <p className="text-sm text-muted-foreground break-words">
          {date(report.period.startAt)} to {date(report.period.endAt)} UTC. The
          end instant is excluded.
        </p>
        <p className="text-sm text-muted-foreground max-w-prose">
          Opportunities are grouped by their original creation date. Bookings
          and wins use the date each event was recorded. Statuses and recorded
          amounts reflect the latest available evidence.
        </p>
      </div>
      {/* Headline numbers */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat
          label="Opportunities started"
          value={String(leads.total)}
          sub={`${leads.native} native · ${leads.imported} imported with original dates`}
          testId="stat-leads"
        />
        <Stat
          label="Currently qualified"
          value={String(leads.qualified)}
          sub="Among opportunities started in this period"
        />
        <Stat
          label="Cohort booking rate"
          value={
            appointments.appointmentRatePct != null
              ? `${appointments.appointmentRatePct}%`
              : "—"
          }
          sub={`${appointments.leadsWithAppointment} of ${leads.total} distinct opportunities; canceled bookings excluded`}
        />
        <Stat
          label="Outreach reply rate"
          value={
            responsiveness.responseRatePct != null
              ? `${responsiveness.responseRatePct}%`
              : "—"
          }
          sub={`${responsiveness.leadsReplied} of ${responsiveness.leadsContacted} contacted in period; replies before period end`}
        />
        <Stat
          label="Wins recorded"
          value={String(outcomes.won)}
          sub="Any original creation date"
          testId="stat-won"
        />
        <Stat
          label="Known win value"
          value={dollars(outcomes.revenueWonCents)}
          sub={`${report.dataQuality.unknownWinValues} wins have no amount; not collected cash`}
          testId="stat-revenue"
          highlight
        />
        <Stat
          label="Current pipeline"
          value={dollars(outcomes.pipelineValueCents)}
          sub={`All-time open snapshot; ${report.dataQuality.unknownPipelineValues} values unknown`}
        />
        <Stat
          label="First logged outreach"
          sub={`Median for ${responsiveness.firstTouchMeasuredLeads} native opportunities with automated outreach`}
          value={
            responsiveness.medianMinutesToFirstTouch != null
              ? `${responsiveness.medianMinutesToFirstTouch} min`
              : "—"
          }
        />
      </div>

      <section aria-label="Previous period comparison" className="space-y-3">
        <h2 className="text-lg font-semibold">
          Compared with the previous {report.windowDays} days
        </h2>
        <p className="text-sm text-muted-foreground">
          Previous: {date(report.comparison.period.startAt)} to{" "}
          {date(report.comparison.period.endAt)} UTC, end excluded.
        </p>
        <div
          className="overflow-x-auto rounded-xl border"
          tabIndex={0}
          role="region"
          aria-label="Period comparison table"
        >
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/40">
                <th className="p-3 text-left">Recorded event</th>
                <th className="p-3 text-right">This period</th>
                <th className="p-3 text-right">Previous</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-b">
                <th className="p-3 text-left font-medium">
                  Lead-linked bookings created
                </th>
                <td className="p-3 text-right tabular-nums">
                  {appointments.total}
                </td>
                <td className="p-3 text-right tabular-nums">
                  {report.comparison.appointmentsRecorded}
                </td>
              </tr>
              <tr className="border-b">
                <th className="p-3 text-left font-medium">Wins recorded</th>
                <td className="p-3 text-right tabular-nums">{outcomes.won}</td>
                <td className="p-3 text-right tabular-nums">
                  {report.comparison.won}
                </td>
              </tr>
              <tr>
                <th className="p-3 text-left font-medium">Known win value</th>
                <td className="p-3 text-right tabular-nums">
                  {dollars(outcomes.revenueWonCents)}
                  <span className="block text-xs text-muted-foreground">
                    {report.dataQuality.unknownWinValues} unknown
                  </span>
                </td>
                <td className="p-3 text-right tabular-nums">
                  {dollars(report.comparison.recordedWinValueCents)}
                  <span className="block text-xs text-muted-foreground">
                    {report.comparison.unknownWinValues} unknown
                  </span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="text-sm text-muted-foreground">
          Bookings are records created in each period, across{" "}
          {appointments.distinctBookedLeads} distinct opportunities this period.
          They are not appointments scheduled to occur in the period. Canceled
          records are excluded using their current status. These totals do not
          establish GrowthOS caused a change.
        </p>
      </section>

      <section
        aria-label="Evidence coverage"
        className="rounded-xl border p-4 space-y-2"
      >
        <h2 className="font-semibold">Evidence coverage</h2>
        <p className="text-sm text-muted-foreground">
          {report.dataQuality.unknownOriginalDates} imported opportunities
          across the account have no original creation date and are excluded
          from date cohorts.
        </p>
        <p className="text-sm text-muted-foreground">
          Historical first-contact coverage is unknown.{" "}
          {report.dataQuality.importedFirstTouchExcluded} imported opportunities
          in this cohort are excluded from first-outreach timing. Missing
          recorded amounts stay unknown.
        </p>
      </section>

      <ValueLedger period={report.period} />

      {/* Revenue attribution */}
      <section
        className="bg-card border border-border rounded-xl shadow-sm overflow-hidden"
        data-testid="attribution-section"
      >
        <div className="px-4 py-3 border-b border-border flex flex-wrap items-center gap-2">
          <BadgeDollarSign className="w-4 h-4 text-primary" />
          <h2 className="font-semibold text-sm text-foreground">
            Recorded win value by attribution
          </h2>
          <span className="text-xs text-muted-foreground ml-auto">
            Recorded relationships do not establish causal lift
          </span>
        </div>
        {outcomes.revenueByAttribution.length === 0 ? (
          <p className="px-4 py-6 text-sm text-muted-foreground">
            No wins recorded in this window yet.
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wider text-muted-foreground border-b border-border">
                <th className="px-4 py-2 font-semibold">Category</th>
                <th className="px-2 py-2 font-semibold text-right">Wins</th>
                <th className="px-4 py-2 font-semibold text-right">
                  Known value
                </th>
              </tr>
            </thead>
            <tbody>
              {outcomes.revenueByAttribution.map((r) => (
                <tr
                  key={r.category}
                  className="border-b border-border/50 last:border-0"
                >
                  <td className="px-4 py-2">
                    <span className="font-medium">
                      {ATTRIBUTION_LABELS[r.category] ?? r.category}
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      {ATTRIBUTION_HINTS[r.category] ?? ""}
                    </span>
                  </td>
                  <td className="px-2 py-2 text-right tabular-nums">
                    {r.count}
                  </td>
                  <td className="px-4 py-2 text-right font-semibold tabular-nums">
                    {dollars(r.revenueCents)}
                    <span className="block text-xs font-normal text-muted-foreground">
                      {r.unknownValues} unknown
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="space-y-3" aria-label="Win evidence">
        <h2 className="text-lg font-semibold">Inspect the recorded wins</h2>
        <p className="text-sm text-muted-foreground">
          Latest {report.evidence.length} of {outcomes.won} wins in the period.
          Open the customer record to inspect estimates, activity and amounts.
        </p>
        {report.evidence.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No recorded wins to inspect in this period.
          </p>
        ) : (
          <ul className="divide-y border-y">
            {report.evidence.map((row) => (
              <li
                key={row.leadId}
                className="py-3 flex flex-wrap justify-between gap-2 text-sm"
              >
                <div className="min-w-0">
                  <Link
                    href={`/leads/${row.leadId}`}
                    className="text-primary underline underline-offset-4 break-words"
                  >
                    {row.title}
                  </Link>
                  <p className="text-xs text-muted-foreground">
                    {date(row.wonAt)} UTC ·{" "}
                    {ATTRIBUTION_LABELS[row.attribution] ?? row.attribution}
                  </p>
                </div>
                <span className="font-medium tabular-nums">
                  {dollars(row.valueCents)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Lead breakdowns */}
      <div className="grid md:grid-cols-2 gap-4">
        <Breakdown title="Leads by source" rows={leads.bySource} />
        <Breakdown title="Leads by campaign" rows={leads.byCampaign} />
        <Breakdown title="Leads by tool" rows={leads.byTool} />
        <Breakdown title="Leads by landing page" rows={leads.byLandingPage} />
        <Breakdown title="Leads by service type" rows={leads.byServiceType} />
        <Breakdown
          title="Currently lost in this creation cohort"
          rows={outcomes.lostReasons}
          emptyLabel="No opportunities in this cohort are currently lost."
        />
      </div>

      {/* Playbook performance */}
      <section className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
        <div className="px-4 py-3 border-b border-border">
          <h2 className="font-semibold text-sm text-foreground">
            Playbook event records
          </h2>
          <p className="text-xs text-muted-foreground mt-1">
            Sent counts messages. Other columns count distinct opportunities per
            playbook using each event date. Columns and playbooks are not an
            additive conversion funnel.
          </p>
        </div>
        {report.playbooks.length === 0 ? (
          <p className="px-4 py-6 text-sm text-muted-foreground">
            No playbook touches in this window.
          </p>
        ) : (
          <div
            className="overflow-x-auto"
            tabIndex={0}
            role="region"
            aria-label="Playbook event table"
          >
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wider text-muted-foreground border-b border-border">
                  <th className="px-4 py-2 font-semibold">Playbook</th>
                  <th className="px-2 py-2 font-semibold">Kind</th>
                  <th className="px-2 py-2 font-semibold text-right">Sent</th>
                  <th className="px-2 py-2 font-semibold text-right">
                    Replied
                  </th>
                  <th className="px-2 py-2 font-semibold text-right">Booked</th>
                  <th className="px-4 py-2 font-semibold text-right">Won</th>
                </tr>
              </thead>
              <tbody>
                {report.playbooks.map((p) => (
                  <tr
                    key={p.playbookId}
                    className="border-b border-border/50 last:border-0"
                  >
                    <td className="px-4 py-2 font-medium">{p.name}</td>
                    <td className="px-2 py-2 text-muted-foreground">
                      {p.kind === "post_sale" ? "Post-sale" : "Outreach"}
                    </td>
                    <td className="px-2 py-2 text-right tabular-nums">
                      {p.sent}
                    </td>
                    <td className="px-2 py-2 text-right tabular-nums">
                      {p.replied}
                    </td>
                    <td className="px-2 py-2 text-right tabular-nums">
                      {p.booked}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">
                      {p.won}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Reviews, referrals, reactivation */}
      <div className="grid md:grid-cols-2 gap-4">
        <section
          className="bg-card border border-border rounded-xl shadow-sm p-4"
          data-testid="reviews-referrals"
        >
          <h2 className="font-semibold text-sm text-foreground mb-3">
            Reviews &amp; referrals
          </h2>
          <dl className="space-y-2 text-sm">
            <Row
              k="Review requests sent"
              v={reviewsAndReferrals.reviewRequestsSent}
            />
            <Row
              k="Review link clicks"
              v={reviewsAndReferrals.reviewLinkClicks}
            />
            <Row
              k="Referral requests sent"
              v={reviewsAndReferrals.referralRequestsSent}
            />
            <Row
              k="Referral submissions"
              v={reviewsAndReferrals.referralSubmissions}
            />
            <Row
              k="Leads from referrals"
              v={reviewsAndReferrals.referralLeads}
            />
          </dl>
          <p className="text-xs text-muted-foreground mt-3">
            Clicks are tracked; completed reviews on third-party sites can't be
            detected and are never counted.
          </p>
        </section>
        <section className="bg-card border border-border rounded-xl shadow-sm p-4">
          <h2 className="font-semibold text-sm text-foreground mb-3">
            Reactivation
          </h2>
          <dl className="space-y-2 text-sm">
            <Row k="Campaigns launched" v={reactivation.campaignsLaunched} />
            <Row k="Leads enrolled" v={reactivation.leadsEnrolled} />
            <Row k="Leads that replied" v={reactivation.leadsReplied} />
          </dl>
        </section>
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  sub,
  highlight,
  testId,
}: {
  label: string;
  value: string;
  sub?: string;
  highlight?: boolean;
  testId?: string;
}) {
  return (
    <div
      className="bg-card border border-border rounded-xl p-4 shadow-sm"
      data-testid={testId}
    >
      <div className="text-xs uppercase tracking-wider text-muted-foreground font-semibold">
        {label}
      </div>
      <div
        className={`text-xl md:text-2xl font-bold mt-1 tabular-nums break-words ${highlight ? "text-emerald-700 dark:text-emerald-400" : "text-foreground"}`}
      >
        {value}
      </div>
      {sub && <div className="text-xs text-muted-foreground mt-0.5">{sub}</div>}
    </div>
  );
}

function Breakdown({
  title,
  rows,
  emptyLabel,
}: {
  title: string;
  rows: RoiBreakdownRow[];
  emptyLabel?: string;
}) {
  return (
    <section className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
      <div className="px-4 py-3 border-b border-border">
        <h2 className="font-semibold text-sm text-foreground">{title}</h2>
      </div>
      {rows.length === 0 ? (
        <p className="px-4 py-4 text-sm text-muted-foreground">
          {emptyLabel ?? "Nothing in this window yet."}
        </p>
      ) : (
        <ul className="divide-y divide-border/50">
          {rows.slice(0, 8).map((r) => (
            <li
              key={r.key}
              className="px-4 py-2 flex items-center justify-between text-sm"
            >
              <span className="truncate mr-3">{r.key}</span>
              <span className="font-semibold tabular-nums">{r.count}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Row({ k, v }: { k: string; v: number }) {
  return (
    <div className="flex items-center justify-between">
      <dt className="text-muted-foreground">{k}</dt>
      <dd className="font-semibold tabular-nums">{v}</dd>
    </div>
  );
}
