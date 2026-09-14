import { useState } from 'react';
import {
  useGetRoiReport,
  exportRoiReport,
  type RoiReport,
  type RoiBreakdownRow,
} from '@workspace/api-client-react';
import { BadgeDollarSign, Download, Loader2 } from 'lucide-react';
import { ValueLedger } from '@/components/revenue-workspace';

/**
 * ROI Report — what the platform captured, moved, and won, with HONEST
 * attribution: every revenue figure carries the category recorded at win
 * time; review activity is requests + clicks only (completed third-party
 * reviews are never claimed).
 */

const WINDOWS = [7, 30, 90, 365];

const ATTRIBUTION_LABELS: Record<string, string> = {
  directly_attributed: 'Directly attributed',
  assisted: 'Assisted',
  self_reported: 'Self-reported',
  estimated: 'Estimated',
  unknown: 'Unknown',
};

const ATTRIBUTION_HINTS: Record<string, string> = {
  directly_attributed: 'Platform captured the lead and outreach got a reply or booking',
  assisted: 'Outreach touched the lead before the win',
  self_reported: 'Won without recorded platform outreach',
  estimated: "Figure is the rep's estimate — no accepted estimate on file",
  unknown: 'No revenue figure recorded',
};

const dollars = (cents: number) =>
  (cents / 100).toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

export default function Reports() {
  const [days, setDays] = useState(30);
  const [exporting, setExporting] = useState(false);
  const { data, isLoading } = useGetRoiReport({ days });

  const downloadCsv = async () => {
    setExporting(true);
    try {
      const csv = await exportRoiReport({ days });
      const blob = new Blob([csv], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `roi-report-${days}d.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="flex flex-col h-full bg-background overflow-y-auto">
      <header className="px-4 py-3 md:px-6 md:py-4 border-b border-border bg-card sticky top-0 z-10 flex flex-wrap items-center gap-3">
        <div className="mr-auto">
          <h1 className="text-xl md:text-2xl font-bold tracking-tight text-foreground">ROI Report</h1>
          <p className="hidden md:block text-sm text-muted-foreground">
            What was captured, moved, and won — every revenue figure carries its attribution.
          </p>
        </div>
        <div className="flex items-center gap-1" role="group" aria-label="Report window">
          {WINDOWS.map(w => (
            <button
              key={w}
              onClick={() => setDays(w)}
              data-testid={`window-${w}`}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium ${
                days === w ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:text-foreground'
              }`}
            >
              {w}d
            </button>
          ))}
        </div>
        <button
          onClick={downloadCsv}
          disabled={exporting || isLoading}
          data-testid="export-csv"
          className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border border-border bg-card text-sm font-medium text-foreground hover:bg-muted disabled:opacity-50"
        >
          {exporting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
          Export CSV
        </button>
      </header>

      {isLoading || !data ? (
        <div className="flex-1 flex items-center justify-center py-24">
          <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <ReportBody report={data} />
      )}
    </div>
  );
}

function ReportBody({ report }: { report: RoiReport }) {
  const { leads, appointments, responsiveness, outcomes, reviewsAndReferrals, reactivation } = report;
  return (
    <div className="p-4 md:p-6 space-y-6 max-w-6xl">
      <ValueLedger />
      {/* Headline numbers */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat label="Leads captured" value={String(leads.total)} testId="stat-leads" />
        <Stat label="Qualified leads" value={String(leads.qualified)} />
        <Stat
          label="Appointment rate"
          value={appointments.appointmentRatePct != null ? `${appointments.appointmentRatePct}%` : '—'}
          sub={`${appointments.leadsWithAppointment} of ${leads.total} leads`}
        />
        <Stat
          label="Response rate"
          value={responsiveness.responseRatePct != null ? `${responsiveness.responseRatePct}%` : '—'}
          sub={`${responsiveness.leadsReplied} of ${responsiveness.leadsContacted} contacted`}
        />
        <Stat label="Opportunities won" value={String(outcomes.won)} testId="stat-won" />
        <Stat label="Revenue won" value={dollars(outcomes.revenueWonCents)} testId="stat-revenue" highlight />
        <Stat label="Pipeline value" value={dollars(outcomes.pipelineValueCents)} />
        <Stat
          label="Median first touch"
          value={
            responsiveness.medianMinutesToFirstTouch != null
              ? `${responsiveness.medianMinutesToFirstTouch} min`
              : '—'
          }
        />
      </div>

      {/* Revenue attribution */}
      <section className="bg-card border border-border rounded-xl shadow-sm overflow-hidden" data-testid="attribution-section">
        <div className="px-4 py-3 border-b border-border flex items-center gap-2">
          <BadgeDollarSign className="w-4 h-4 text-primary" />
          <h2 className="font-semibold text-sm text-foreground">Revenue by attribution</h2>
          <span className="text-xs text-muted-foreground ml-auto">
            revenue is never claimed just because a message was sent
          </span>
        </div>
        {outcomes.revenueByAttribution.length === 0 ? (
          <p className="px-4 py-6 text-sm text-muted-foreground">No wins recorded in this window yet.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wider text-muted-foreground border-b border-border">
                <th className="px-4 py-2 font-semibold">Category</th>
                <th className="px-2 py-2 font-semibold text-right">Wins</th>
                <th className="px-4 py-2 font-semibold text-right">Revenue</th>
              </tr>
            </thead>
            <tbody>
              {outcomes.revenueByAttribution.map(r => (
                <tr key={r.category} className="border-b border-border/50 last:border-0">
                  <td className="px-4 py-2">
                    <span className="font-medium">{ATTRIBUTION_LABELS[r.category] ?? r.category}</span>
                    <span className="block text-xs text-muted-foreground">{ATTRIBUTION_HINTS[r.category] ?? ''}</span>
                  </td>
                  <td className="px-2 py-2 text-right tabular-nums">{r.count}</td>
                  <td className="px-4 py-2 text-right font-semibold tabular-nums">{dollars(r.revenueCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* Lead breakdowns */}
      <div className="grid md:grid-cols-2 gap-4">
        <Breakdown title="Leads by source" rows={leads.bySource} />
        <Breakdown title="Leads by campaign" rows={leads.byCampaign} />
        <Breakdown title="Leads by tool" rows={leads.byTool} />
        <Breakdown title="Leads by landing page" rows={leads.byLandingPage} />
        <Breakdown title="Leads by service type" rows={leads.byServiceType} />
        <Breakdown title="Lost reasons" rows={outcomes.lostReasons} emptyLabel="No lost leads in this window." />
      </div>

      {/* Playbook performance */}
      <section className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
        <div className="px-4 py-3 border-b border-border">
          <h2 className="font-semibold text-sm text-foreground">Playbook performance</h2>
        </div>
        {report.playbooks.length === 0 ? (
          <p className="px-4 py-6 text-sm text-muted-foreground">No playbook touches in this window.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wider text-muted-foreground border-b border-border">
                  <th className="px-4 py-2 font-semibold">Playbook</th>
                  <th className="px-2 py-2 font-semibold">Kind</th>
                  <th className="px-2 py-2 font-semibold text-right">Sent</th>
                  <th className="px-2 py-2 font-semibold text-right">Replied</th>
                  <th className="px-2 py-2 font-semibold text-right">Booked</th>
                  <th className="px-4 py-2 font-semibold text-right">Won</th>
                </tr>
              </thead>
              <tbody>
                {report.playbooks.map(p => (
                  <tr key={p.playbookId} className="border-b border-border/50 last:border-0">
                    <td className="px-4 py-2 font-medium">{p.name}</td>
                    <td className="px-2 py-2 text-muted-foreground">{p.kind === 'post_sale' ? 'Post-sale' : 'Outreach'}</td>
                    <td className="px-2 py-2 text-right tabular-nums">{p.sent}</td>
                    <td className="px-2 py-2 text-right tabular-nums">{p.replied}</td>
                    <td className="px-2 py-2 text-right tabular-nums">{p.booked}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{p.won}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Reviews, referrals, reactivation */}
      <div className="grid md:grid-cols-2 gap-4">
        <section className="bg-card border border-border rounded-xl shadow-sm p-4" data-testid="reviews-referrals">
          <h2 className="font-semibold text-sm text-foreground mb-3">Reviews &amp; referrals</h2>
          <dl className="space-y-2 text-sm">
            <Row k="Review requests sent" v={reviewsAndReferrals.reviewRequestsSent} />
            <Row k="Review link clicks" v={reviewsAndReferrals.reviewLinkClicks} />
            <Row k="Referral requests sent" v={reviewsAndReferrals.referralRequestsSent} />
            <Row k="Referral submissions" v={reviewsAndReferrals.referralSubmissions} />
            <Row k="Leads from referrals" v={reviewsAndReferrals.referralLeads} />
          </dl>
          <p className="text-xs text-muted-foreground mt-3">
            Clicks are tracked; completed reviews on third-party sites can't be detected and are never counted.
          </p>
        </section>
        <section className="bg-card border border-border rounded-xl shadow-sm p-4">
          <h2 className="font-semibold text-sm text-foreground mb-3">Reactivation</h2>
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

function Stat({ label, value, sub, highlight, testId }: { label: string; value: string; sub?: string; highlight?: boolean; testId?: string }) {
  return (
    <div className="bg-card border border-border rounded-xl p-4 shadow-sm" data-testid={testId}>
      <div className="text-xs uppercase tracking-wider text-muted-foreground font-semibold">{label}</div>
      <div className={`text-2xl font-bold mt-1 tabular-nums ${highlight ? 'text-emerald-600 dark:text-emerald-400' : 'text-foreground'}`}>
        {value}
      </div>
      {sub && <div className="text-xs text-muted-foreground mt-0.5">{sub}</div>}
    </div>
  );
}

function Breakdown({ title, rows, emptyLabel }: { title: string; rows: RoiBreakdownRow[]; emptyLabel?: string }) {
  return (
    <section className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
      <div className="px-4 py-3 border-b border-border">
        <h2 className="font-semibold text-sm text-foreground">{title}</h2>
      </div>
      {rows.length === 0 ? (
        <p className="px-4 py-4 text-sm text-muted-foreground">{emptyLabel ?? 'Nothing in this window yet.'}</p>
      ) : (
        <ul className="divide-y divide-border/50">
          {rows.slice(0, 8).map(r => (
            <li key={r.key} className="px-4 py-2 flex items-center justify-between text-sm">
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
