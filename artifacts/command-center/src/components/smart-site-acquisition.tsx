import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BarChart3,
  CheckCircle2,
  Clock3,
  Eye,
  MousePointerClick,
  Phone,
  ShieldCheck,
  Sparkles,
  Target,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';

type MeasurementSite = {
  id: string;
  name: string;
  isActive: boolean;
  analyticsEnabled: boolean;
  analyticsRetentionDays: number;
  analyticsPolicyVersion: string;
};

type AcquisitionReport = {
  scope: string;
  days: number;
  summary: {
    visitors: number;
    sessions: number;
    startedVisitors: number;
    phoneClicks: number;
    voiceVisitors: number;
    savedLeads: number;
    qualifiedLeads: number;
    appointmentLeads: number;
    estimateLeads: number;
    wonLeads: number;
    wonValueCents: number;
    medianMinutesToStaffLog: number | null;
  };
  events: { eventName: string; events: number; visitors: number }[];
  sources: {
    source: string;
    visitors: number;
    savedLeads: number;
    wonLeads: number;
  }[];
  services: {
    serviceCode: string;
    visitors: number;
    savedLeads: number;
    wonLeads: number;
  }[];
  sites: MeasurementSite[];
  measurement: Record<string, string>;
};

async function acquisitionRequest<T>(
  path: string,
  method = 'GET',
  body?: unknown,
): Promise<T> {
  const response = await fetch(`/api/v1/smart-sites${path}`, {
    method,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const value = await response.json();
  if (!response.ok)
    throw new Error(value.error || 'Acquisition measurement is unavailable.');
  return value;
}

const percent = (part: number, total: number) =>
  total > 0 ? `${Math.round((part / total) * 100)}%` : '—';
const currency = (cents: number) =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(cents / 100);
const label = (value: string) =>
  value
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (character) => character.toUpperCase());

export function SmartSiteAcquisition({
  organizationId,
  canManage,
}: {
  organizationId: string;
  canManage: boolean;
}) {
  const queryClient = useQueryClient();
  const [days, setDays] = useState(30);
  const report = useQuery({
    queryKey: ['smart-sites', organizationId, 'acquisition', days],
    queryFn: async () => {
      const result = await acquisitionRequest<AcquisitionReport>(
        `/acquisition?days=${days}`,
      );
      if (!result?.summary || !Array.isArray(result.sources))
        throw new Error('Acquisition reporting returned an unexpected response.');
      return result;
    },
    refetchInterval: 30_000,
  });
  const configure = useMutation({
    mutationFn: ({
      site,
      enabled,
      retentionDays,
    }: {
      site: MeasurementSite;
      enabled: boolean;
      retentionDays: number;
    }) =>
      acquisitionRequest<MeasurementSite>(`/${site.id}/measurement`, 'PATCH', {
        enabled,
        retentionDays,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ['smart-sites', organizationId],
      });
    },
  });
  const summary = report.data?.summary;
  const funnel = summary
    ? [
        ['Consented visitors', summary.visitors],
        ['Started a path', summary.startedVisitors],
        ['Saved inquiries', summary.savedLeads],
        ['Appointments', summary.appointmentLeads],
        ['Estimates sent', summary.estimateLeads],
        ['Recorded wins', summary.wonLeads],
      ]
    : [];
  const enabledSites = report.data?.sites.filter(
    (site) => site.analyticsEnabled,
  ).length;

  return (
    <section className="space-y-5" aria-labelledby="acquisition-title">
      <Card className="overflow-hidden border-cyan-500/30 bg-gradient-to-br from-cyan-500/10 via-card to-card">
        <CardHeader className="gap-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Badge variant="secondary">
              <ShieldCheck className="mr-1 h-3 w-3" /> Consent-first ·
              first-party
            </Badge>
            <Label className="flex items-center gap-2 text-xs">
              Reporting window
              <select
                aria-label="Acquisition reporting window"
                className="h-9 rounded-md border bg-background px-3 text-sm"
                value={days}
                onChange={(event) => setDays(Number(event.target.value))}
              >
                <option value={7}>7 days</option>
                <option value={30}>30 days</option>
                <option value={90}>90 days</option>
                <option value={365}>365 days</option>
              </select>
            </Label>
          </div>
          <CardTitle id="acquisition-title" className="text-2xl">
            From attention to actual outcomes
          </CardTitle>
          <p className="max-w-3xl text-sm text-muted-foreground">
            See which consented site experiences become saved inquiries,
            follow-up, estimates and recorded wins. Each number stays inside
            this organization and retains its evidence boundary.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          {report.error && (
            <p
              role="alert"
              className="rounded-md border border-destructive/40 p-3 text-sm text-destructive"
            >
              {report.error.message}
            </p>
          )}
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
            {[
              [Eye, 'Consented visitors', summary?.visitors],
              [Target, 'Saved inquiries', summary?.savedLeads],
              [Sparkles, 'Estimates sent', summary?.estimateLeads],
              [CheckCircle2, 'Recorded wins', summary?.wonLeads],
              [BarChart3, 'Won contract value', summary ? currency(summary.wonValueCents) : undefined],
            ].map(([Icon, metric, value]) => {
              const MetricIcon = Icon as typeof Eye;
              return (
                <div key={String(metric)} className="rounded-lg border bg-background/75 p-4">
                  <MetricIcon className="h-4 w-4 text-cyan-500" />
                  <p className="mt-3 text-xs text-muted-foreground">{metric as string}</p>
                  <p className="mt-1 text-2xl font-semibold tabular-nums">
                    {report.isLoading || report.isError ? '—' : (value as number | string)}
                  </p>
                </div>
              );
            })}
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="rounded-lg border bg-background/60 p-3 text-sm">
              <Phone className="mb-2 h-4 w-4 text-primary" />
              <strong className="block">{summary?.phoneClicks ?? '—'} phone-link clicks</strong>
              <span className="text-xs text-muted-foreground">Clicks only—not completed calls.</span>
            </div>
            <div className="rounded-lg border bg-background/60 p-3 text-sm">
              <MousePointerClick className="mb-2 h-4 w-4 text-primary" />
              <strong className="block">{summary?.voiceVisitors ?? '—'} voice/text starters</strong>
              <span className="text-xs text-muted-foreground">Distinct consented browsers.</span>
            </div>
            <div className="rounded-lg border bg-background/60 p-3 text-sm">
              <Clock3 className="mb-2 h-4 w-4 text-primary" />
              <strong className="block">
                {summary?.medianMinutesToStaffLog == null
                  ? '—'
                  : `${Math.round(summary.medianMinutesToStaffLog)} min`}
              </strong>
              <span className="text-xs text-muted-foreground">Median to staff-recorded attempt.</span>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            {report.data?.scope ?? `Last ${days} days`} · {enabledSites ?? 0} measurement-enabled site{enabledSites === 1 ? '' : 's'}.
            No synthetic projections or cross-device identity stitching.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Acquisition journey</CardTitle>
        </CardHeader>
        <CardContent>
          {funnel.length ? (
            <div className="grid gap-2 lg:grid-cols-6">
              {funnel.map(([stage, value], index) => (
                <div key={stage} className="rounded-lg border p-3">
                  <p className="text-xs text-muted-foreground">{stage}</p>
                  <p className="mt-2 text-xl font-semibold tabular-nums">{value}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {index === 0 ? 'Consented baseline' : `${percent(Number(value), Number(funnel[index - 1][1]))} of prior stage`}
                  </p>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No consented events are available for this window.</p>
          )}
          <p className="mt-3 text-xs text-muted-foreground">
            Funnel percentages describe recorded stage progression—not causal uplift. Appointment and estimate stages require corresponding GrowthOS records.
          </p>
        </CardContent>
      </Card>

      <div className="grid gap-5 xl:grid-cols-2">
        <BreakdownCard
          title="Acquisition sources"
          empty="No source evidence yet. Direct / unknown stays visible instead of being guessed."
          rows={(report.data?.sources ?? []).map((row) => ({
            key: row.source,
            label: row.source,
            visitors: row.visitors,
            leads: row.savedLeads,
            wins: row.wonLeads,
          }))}
        />
        <BreakdownCard
          title="Service interest"
          empty="No service-level measurement yet."
          rows={(report.data?.services ?? []).map((row) => ({
            key: row.serviceCode,
            label: label(row.serviceCode),
            visitors: row.visitors,
            leads: row.savedLeads,
            wins: row.wonLeads,
          }))}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Site measurement controls</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {report.data?.sites.map((site) => (
            <div key={site.id} className="grid gap-3 rounded-lg border p-4 md:grid-cols-[1fr_auto_auto] md:items-center">
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <strong>{site.name}</strong>
                  <Badge variant={site.analyticsEnabled ? 'default' : 'secondary'}>
                    {site.analyticsEnabled ? 'Measurement enabled' : 'Measurement off'}
                  </Badge>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  Policy {site.analyticsPolicyVersion} · Browser tracking still requires the visitor’s explicit choice.
                </p>
              </div>
              <Label className="space-y-1 text-xs">
                Retention
                <select
                  aria-label={`${site.name} analytics retention`}
                  className="block h-9 rounded-md border bg-background px-3 text-sm"
                  value={site.analyticsRetentionDays}
                  disabled={!canManage || configure.isPending}
                  onChange={(event) =>
                    configure.mutate({
                      site,
                      enabled: site.analyticsEnabled,
                      retentionDays: Number(event.target.value),
                    })
                  }
                >
                  <option value={30}>30 days</option>
                  <option value={90}>90 days</option>
                  <option value={180}>180 days</option>
                  <option value={365}>365 days</option>
                </select>
              </Label>
              {canManage && (
                <Button
                  variant={site.analyticsEnabled ? 'outline' : 'default'}
                  disabled={configure.isPending || !site.isActive}
                  onClick={() =>
                    configure.mutate({
                      site,
                      enabled: !site.analyticsEnabled,
                      retentionDays: site.analyticsRetentionDays,
                    })
                  }
                >
                  {site.analyticsEnabled ? 'Pause measurement' : 'Enable consented measurement'}
                </Button>
              )}
            </div>
          ))}
          {!report.data?.sites.length && !report.isLoading && (
            <p className="text-sm text-muted-foreground">Connect a Smart Site before enabling measurement.</p>
          )}
          {configure.error && (
            <p role="alert" className="text-sm text-destructive">{configure.error.message}</p>
          )}
          <details className="rounded-lg border bg-muted/20 p-4 text-sm">
            <summary className="cursor-pointer font-medium">What these numbers do—and do not—mean</summary>
            <dl className="mt-3 grid gap-3 md:grid-cols-2">
              {Object.entries(report.data?.measurement ?? {}).map(([term, definition]) => (
                <div key={term}>
                  <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label(term)}</dt>
                  <dd className="mt-1">{definition}</dd>
                </div>
              ))}
            </dl>
          </details>
        </CardContent>
      </Card>
    </section>
  );
}

function BreakdownCard({
  title,
  empty,
  rows,
}: {
  title: string;
  empty: string;
  rows: { key: string; label: string; visitors: number; leads: number; wins: number }[];
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        {rows.length ? (
          <div className="divide-y">
            <div className="grid grid-cols-[1fr_repeat(3,minmax(3.5rem,auto))] gap-3 pb-2 text-right text-xs text-muted-foreground">
              <span className="text-left">Evidence</span><span>Visitors</span><span>Leads</span><span>Wins</span>
            </div>
            {rows.map((row) => (
              <div key={row.key} className="grid grid-cols-[1fr_repeat(3,minmax(3.5rem,auto))] gap-3 py-3 text-right text-sm">
                <strong className="break-words text-left">{row.label}</strong>
                <span className="tabular-nums">{row.visitors}</span>
                <span className="tabular-nums">{row.leads}</span>
                <span className="tabular-nums">{row.wins}</span>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">{empty}</p>
        )}
      </CardContent>
    </Card>
  );
}
