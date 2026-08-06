import { useGetDashboardSummary, useGetEmailProviderStatus, useGetMarketingSummary, useGetMe, LeadStatus } from '@workspace/api-client-react';
import { Loader2, Trello, Calendar, CheckSquare, Activity as ActivityIcon, Globe, Sparkles, MessageSquare, ArrowRight } from 'lucide-react';
import { Link } from 'wouter';
import { format } from 'date-fns';
import { useState } from 'react';
import { canManageSettings } from '@/lib/permissions';

/** Empty-state CTA: seed the org with sample leads so a fresh CRM feels alive. */
function DemoDataBanner() {
  const [busy, setBusy] = useState(false);
  async function load() {
    setBusy(true);
    try {
      const r = await fetch('/api/v1/demo-data', {
        method: 'POST',
        credentials: 'include',
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      window.location.reload();
    } catch {
      setBusy(false);
    }
  }
  return (
    <div className="rounded-xl border border-primary/30 bg-primary/5 px-5 py-4 flex flex-col sm:flex-row sm:items-center gap-4 justify-between">
      <div className="flex items-start gap-3">
        <div className="w-9 h-9 rounded-lg bg-primary/10 text-primary flex items-center justify-center shrink-0">
          <Sparkles className="w-5 h-5" />
        </div>
        <div>
          <p className="font-semibold text-sm text-foreground">
            Your CRM is empty — want to see it in action?
          </p>
          <p className="text-sm text-muted-foreground">
            Load sample leads across the full pipeline to explore. You can clear
            them anytime.
          </p>
        </div>
      </div>
      <button
        onClick={load}
        disabled={busy}
        className="shrink-0 inline-flex items-center justify-center gap-2 bg-primary text-primary-foreground hover:bg-primary/90 h-10 px-4 rounded-md font-semibold text-sm transition-colors disabled:opacity-60"
      >
        {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
        {busy ? 'Loading…' : 'Load sample data'}
      </button>
    </div>
  );
}

function EmailFailureBanner() {
  const { data: emailProvider } = useGetEmailProviderStatus();
  if (!emailProvider || (emailProvider.recentSendFailures ?? 0) === 0) return null;
  return (
    <div
      className="rounded-md border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive"
      data-testid="banner-dashboard-email-send-failures"
    >
      <p className="font-medium">
        Automation emails are failing to send
        {emailProvider.provider === 'gmail' && ' through Gmail'}
        {emailProvider.provider === 'resend' && ' through Resend'}
        {emailProvider.provider === 'mock' && ' (no provider connected)'}
        .
      </p>
      <p className="mt-1">
        The last {emailProvider.recentSendFailures === 1 ? 'email send attempt' : `${emailProvider.recentSendFailures} email send attempts`} failed
        {emailProvider.lastSendFailureDetail ? <>: <span className="font-mono text-xs">{emailProvider.lastSendFailureDetail}</span></> : ''}
        {'. '}
        {emailProvider.provider === 'gmail'
          ? 'The Gmail connection may have expired — reconnect Gmail or configure Resend to resume sending.'
          : 'Check the email provider configuration to resume sending.'}{' '}
        <Link href="/settings" className="font-semibold underline">
          Review automation settings
        </Link>
      </p>
    </div>
  );
}

export default function Dashboard() {
  const { data: me } = useGetMe();
  const { data: summary, isLoading } = useGetDashboardSummary();

  if (isLoading) {
    return (
      <div className="p-8 flex items-center justify-center h-full">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto p-4 md:p-8 bg-background">
      <div className="max-w-6xl mx-auto space-y-6 md:space-y-8 pb-8 md:pb-0">
        
        <header>
          <h1 className="text-2xl md:text-3xl font-bold tracking-tight mb-1 text-foreground">Welcome back, {me?.firstName || 'Agent'}</h1>
          <p className="text-muted-foreground text-sm">Here's the status of your mission control today.</p>
        </header>

        {me && canManageSettings(me.role) && <EmailFailureBanner />}

        {me && canManageSettings(me.role) && (summary?.totalLeads ?? 0) === 0 && (
          <DemoDataBanner />
        )}

        {/* Top Stats */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 md:gap-4">
          <StatCard 
            title="Total Active Leads" 
            value={summary?.totalLeads ?? 0} 
            icon={Trello}
            link="/pipeline"
          />
          <StatCard 
            title="Open Tasks" 
            value={summary?.openTasks ?? 0} 
            icon={CheckSquare}
            link="/tasks"
          />
          <StatCard 
            title="Upcoming Appts" 
            value={summary?.upcomingAppointments ?? 0} 
            icon={Calendar}
            link="/appointments"
          />
          <StatCard 
            title="Unanswered Msg" 
            value={summary?.unansweredPortalMessages ?? 0} 
            icon={MessageSquare}
            link="/pipeline"
            highlight={(summary?.unansweredPortalMessages ?? 0) > 0}
          />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 md:gap-8">
          {/* Pipeline Overview */}
          <section className="bg-card border border-border rounded-xl overflow-hidden shadow-sm flex flex-col">
            <div className="p-4 border-b border-border bg-muted/20 flex items-center justify-between">
              <h2 className="font-semibold text-xs md:text-sm tracking-wide uppercase text-foreground">Pipeline Breakdown</h2>
              <Link href="/pipeline" className="text-xs font-semibold text-primary flex items-center gap-1 hover:underline">
                View All <ArrowRight className="w-3 h-3" />
              </Link>
            </div>
            <div className="p-4 flex-1">
              <div className="space-y-3">
                {summary?.leadsByStatus?.length ? (
                  summary.leadsByStatus.map(s => (
                    <div key={s.status} className="flex items-center justify-between text-sm group">
                      <div className="flex items-center gap-2">
                        <div className="w-1.5 h-1.5 rounded-full bg-primary/40 group-hover:bg-primary transition-colors" />
                        <span className="text-muted-foreground group-hover:text-foreground transition-colors capitalize">{s.status.replace(/_/g, ' ')}</span>
                      </div>
                      <span className="font-mono font-bold bg-muted px-2 py-0.5 rounded-md text-xs">{s.count}</span>
                    </div>
                  ))
                ) : (
                  <div className="text-sm text-muted-foreground py-8 text-center border-2 border-dashed border-border rounded-lg">No leads active.</div>
                )}
              </div>
            </div>
          </section>

          {/* Activity Feed */}
          <section className="bg-card border border-border rounded-xl overflow-hidden shadow-sm flex flex-col min-h-[300px] md:h-96">
            <div className="p-4 border-b border-border bg-muted/20 flex items-center justify-between">
              <h2 className="font-semibold text-xs md:text-sm tracking-wide uppercase text-foreground">Recent Activity</h2>
              <ActivityIcon className="w-4 h-4 text-muted-foreground" />
            </div>
            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              {summary?.recentActivities?.length ? (
                summary.recentActivities.map(activity => (
                  <div key={activity.id} className="flex gap-3 items-start">
                    <div className="w-7 h-7 rounded-full bg-primary/10 flex items-center justify-center shrink-0 mt-0.5">
                      <div className="w-2 h-2 rounded-full bg-primary" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-foreground truncate">{activity.title}</p>
                      {activity.body && (
                         <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2 leading-relaxed">{activity.body}</p>
                      )}
                      <p className="text-[10px] text-muted-foreground font-mono mt-1.5 uppercase tracking-wider">
                        {format(new Date(activity.occurredAt), 'MMM d, h:mm a')}
                      </p>
                    </div>
                  </div>
                ))
              ) : (
                <div className="text-sm text-muted-foreground py-8 text-center h-full flex flex-col items-center justify-center border-2 border-dashed border-border rounded-lg m-2">
                  <ActivityIcon className="w-6 h-6 mb-2 opacity-20" />
                  No recent activity.
                </div>
              )}
            </div>
          </section>
        </div>

        <MarketingSection />

      </div>
    </div>
  );
}

const CATEGORY_LABELS: Record<string, string> = {
  ai: 'AI answer engines',
  search: 'Search engines',
  social: 'Social',
  direct: 'Direct',
  other: 'Other sites',
};

const CATEGORY_COLORS: Record<string, string> = {
  ai: 'bg-violet-500/15 text-violet-600 dark:text-violet-400',
  search: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
  social: 'bg-sky-500/15 text-sky-600 dark:text-sky-400',
  direct: 'bg-muted text-muted-foreground',
  other: 'bg-secondary/15 text-secondary',
};

function MarketingSection() {
  const { data: marketing, isLoading } = useGetMarketingSummary({ days: 30 });

  return (
    <section className="bg-card border border-border rounded-xl overflow-hidden shadow-sm">
      <div className="p-4 border-b border-border bg-muted/20 flex items-center justify-between">
        <h2 className="font-semibold text-xs md:text-sm tracking-wide uppercase text-foreground">Website Traffic — Last 30 Days</h2>
        <Globe className="w-4 h-4 text-muted-foreground" />
      </div>
      {isLoading ? (
        <div className="p-8 flex justify-center"><Loader2 className="w-5 h-5 animate-spin text-primary" /></div>
      ) : !marketing || marketing.totalPageViews === 0 ? (
        <div className="p-8 text-sm text-muted-foreground text-center border-2 border-dashed border-border rounded-lg m-4">No website traffic recorded yet.</div>
      ) : (
        <div className="p-4 md:p-6 space-y-6 md:space-y-8">
          <div className="grid grid-cols-3 gap-3 md:gap-6 divide-x divide-border">
            <div className="px-2 md:px-4 text-center">
              <p className="text-[10px] md:text-xs font-semibold text-muted-foreground uppercase tracking-widest mb-1 md:mb-2">Page views</p>
              <p className="text-xl md:text-3xl font-mono font-bold text-foreground">{marketing.totalPageViews}</p>
            </div>
            <div className="px-2 md:px-4 text-center">
              <p className="text-[10px] md:text-xs font-semibold text-muted-foreground uppercase tracking-widest mb-1 md:mb-2">Visitors</p>
              <p className="text-xl md:text-3xl font-mono font-bold text-foreground">{marketing.uniqueVisitors}</p>
            </div>
            <div className="px-2 md:px-4 text-center">
              <p className="text-[10px] md:text-xs font-semibold text-muted-foreground uppercase tracking-widest mb-1 md:mb-2 flex items-center justify-center gap-1">
                <Sparkles className="w-3 h-3 text-violet-500" /> AI referrals
              </p>
              <p className="text-xl md:text-3xl font-mono font-bold text-violet-600 dark:text-violet-400">{marketing.aiReferralViews}</p>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 pt-4 border-t border-border">
            <div>
              <h3 className="text-[10px] md:text-xs font-bold uppercase tracking-widest text-foreground mb-3 flex items-center gap-2">
                <div className="w-1.5 h-1.5 rounded-full bg-primary" /> Top landing pages
              </h3>
              <div className="space-y-2">
                {marketing.landingPages.slice(0, 8).map((p) => (
                  <div key={p.path} className="flex items-center justify-between text-sm p-2 rounded-lg hover:bg-muted/50 transition-colors">
                    <span className="text-foreground/80 truncate font-mono text-[11px]">{p.path}</span>
                    <span className="font-mono font-bold shrink-0 ml-3 bg-muted px-2 py-0.5 rounded text-xs">{p.views}</span>
                  </div>
                ))}
              </div>
            </div>
            <div>
              <h3 className="text-[10px] md:text-xs font-bold uppercase tracking-widest text-foreground mb-3 flex items-center gap-2">
                <div className="w-1.5 h-1.5 rounded-full bg-primary" /> Referrers
              </h3>
              <div className="space-y-2">
                {marketing.referrers.slice(0, 8).map((r) => (
                  <div key={r.referrer} className="flex items-center justify-between text-sm gap-2 p-2 rounded-lg hover:bg-muted/50 transition-colors">
                    <span className="text-foreground/80 truncate text-[13px]">{r.referrer}</span>
                    <span className="flex items-center gap-2 shrink-0">
                      <span className={`text-[10px] font-semibold tracking-wide px-2 py-0.5 rounded-md ${CATEGORY_COLORS[r.category] ?? CATEGORY_COLORS.other}`}>
                        {CATEGORY_LABELS[r.category] ?? r.category}
                      </span>
                      <span className="font-mono font-bold bg-muted px-2 py-0.5 rounded text-xs">{r.views}</span>
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function StatCard({ title, value, icon: Icon, link, highlight = false }: { title: string, value: number, icon: any, link: string, highlight?: boolean }) {
  return (
    <Link href={link} className="block group">
      <div className={`bg-card border rounded-xl p-4 md:p-5 hover:border-primary/50 transition-all shadow-sm hover:shadow-md relative overflow-hidden ${highlight ? 'border-secondary/60 bg-secondary/5' : 'border-border'}`}>
        <div className="flex flex-col md:flex-row md:items-start justify-between relative z-10 gap-2 md:gap-0">
          <div>
            <p className="text-[10px] md:text-xs font-bold text-muted-foreground uppercase tracking-widest mb-1 md:mb-2">{title}</p>
            <div className={`text-2xl md:text-4xl font-mono font-bold tracking-tight group-hover:text-primary transition-colors ${highlight ? 'text-secondary' : 'text-foreground'}`}>{value}</div>
          </div>
          <div className={`w-8 h-8 md:w-10 md:h-10 rounded-lg flex items-center justify-center transition-colors ${highlight ? 'bg-secondary/20 text-secondary' : 'bg-primary/10 text-primary group-hover:bg-primary group-hover:text-primary-foreground'}`}>
            <Icon className="w-4 h-4 md:w-5 md:h-5" />
          </div>
        </div>
        <div className="absolute inset-0 bg-gradient-to-br from-primary/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
      </div>
    </Link>
  );
}
