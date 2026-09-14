import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useGetMe } from '@workspace/api-client-react';
import { Link } from 'wouter';
import {
  ArrowUpRight,
  CheckCircle2,
  Copy,
  Globe2,
  Loader2,
  ShieldCheck,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { SmartSiteFollowup, ResponseTarget } from './smart-site-followup';
import { SmartSiteAcquisition } from './smart-site-acquisition';

type Site = {
  id: string;
  name: string;
  siteKey: string;
  profile: string;
  isActive: boolean;
  responseTargetMinutes: number;
};
type Profile = { id: string; name: string; services: [string, string][] };
type Overview = {
  rows: {
    siteId: string;
    siteName: string;
    service: string;
    captured: number;
    unassigned: number;
    won: number;
    contractValueCents: number;
  }[];
  recent: {
    leadId: string;
    name: string;
    service: string;
    status: string;
    createdAt: string;
    source: string;
  }[];
};
async function request<T>(
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
    throw new Error(
      value.error || 'Smart Sites could not complete the request.',
    );
  return value;
}
const currency = (v: number) =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(v / 100);

export function SmartSitesControl() {
  const { data: me } = useGetMe();
  if (!me)
    return (
      <p className="text-sm text-muted-foreground">
        Loading your organization…
      </p>
    );
  if (!me.organization)
    return (
      <p className="text-sm text-muted-foreground">
        Choose an organization before configuring Smart Sites.
      </p>
    );
  // A workspace change discards one-time secrets and form state as well as cached results.
  return (
    <SmartSitesWorkspace
      key={me.organization.id}
      organizationId={me.organization.id}
      canManage={me.role === 'owner' || me.role === 'admin'}
      userId={me.id}
      canWrite={me.role !== 'viewer'}
    />
  );
}

function SmartSitesWorkspace({
  organizationId,
  canManage,
  userId,
  canWrite,
}: {
  organizationId: string;
  canManage: boolean;
  userId: string;
  canWrite: boolean;
}) {
  const client = useQueryClient();
  const sites = useQuery({
    queryKey: ['smart-sites', organizationId, 'list'],
    queryFn: () => request<Site[]>(''),
  });
  const profiles = useQuery({
    queryKey: ['smart-sites', organizationId, 'profiles'],
    queryFn: () => request<Profile[]>('/profiles'),
  });
  const overview = useQuery({
    queryKey: ['smart-sites', organizationId, 'overview'],
    queryFn: async () => {
      const value = await request<Overview>('/overview');
      if (!value || !Array.isArray(value.rows) || !Array.isArray(value.recent))
        throw new Error(
          'Reporting returned an unexpected response. Counts are unavailable.',
        );
      return value;
    },
    refetchInterval: 30_000,
  });
  const [name, setName] = useState('');
  const [siteKey, setSiteKey] = useState('');
  const [profile, setProfile] = useState('roofing-exteriors');
  const [credential, setCredential] = useState<
    (Site & { secret: string }) | null
  >(null);
  const [notice, setNotice] = useState('');
  const refresh = () =>
    client.invalidateQueries({ queryKey: ['smart-sites', organizationId] });
  const create = useMutation({
    mutationFn: () =>
      request<Site & { secret: string }>('', 'POST', {
        name: name.trim(),
        siteKey: siteKey.trim(),
        profile,
      }),
    onSuccess: (data) => {
      setCredential(data);
      setName('');
      setSiteKey('');
      setNotice(
        'Connection created in draft. Store the key on your website server before enabling capture.',
      );
      void refresh();
    },
  });
  const toggle = useMutation({
    mutationFn: (s: Site) =>
      request(`/${s.id}`, 'PATCH', { isActive: !s.isActive }),
    onSuccess: () => {
      void refresh();
    },
  });
  const rotate = useMutation({
    mutationFn: (s: Site) =>
      request<Site & { secret: string }>(`/${s.id}/rotate-key`, 'POST'),
    onSuccess: (data) => {
      setCredential(data);
      setNotice(
        'Old key revoked. Capture is off until the new server key is installed and you enable it again.',
      );
      void refresh();
    },
  });
  const totals = (overview.data?.rows ?? []).reduce(
    (a, r) => ({
      captured: a.captured + r.captured,
      unassigned: a.unassigned + r.unassigned,
      won: a.won + r.won,
      value: a.value + r.contractValueCents,
    }),
    { captured: 0, unassigned: 0, won: 0, value: 0 },
  );
  const error =
    sites.error ||
    profiles.error ||
    overview.error ||
    create.error ||
    toggle.error ||
    rotate.error;
  const copy = async () => {
    if (!credential) return;
    try {
      await navigator.clipboard.writeText(
        `GROWTHOS_SITE_ID=${credential.id}\nGROWTHOS_SITE_SECRET=${credential.secret}`,
      );
      setNotice(
        'Server settings copied. Never paste them into browser code or a public repository.',
      );
    } catch {
      setNotice(
        'Clipboard unavailable. Select and copy the server settings manually.',
      );
    }
  };

  return (
    <section className="space-y-5" aria-labelledby="smart-sites-title">
      <Card className="overflow-hidden border-primary/30 bg-gradient-to-br from-primary/10 via-card to-card">
        <CardHeader className="gap-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Badge variant="secondary">
              <ShieldCheck className="mr-1 h-3 w-3" /> Tenant-isolated
              acquisition
            </Badge>
            <Link
              href="/pipeline"
              className="inline-flex items-center gap-1 text-sm text-primary"
            >
              Open lead inbox <ArrowUpRight className="h-4 w-4" />
            </Link>
          </div>
          <CardTitle id="smart-sites-title" className="text-2xl">
            Your sites. One growth workspace.
          </CardTitle>
          <p className="max-w-2xl text-sm text-muted-foreground">
            Connect the next client experience to real leads, clear ownership
            and measurable outcomes. Website branding stays independent;
            customer records stay in this organization.
          </p>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {[
              ['Saved inquiries', totals.captured],
              ['Need an owner', totals.unassigned],
              ['Recorded wins', totals.won],
              ['Won contract value', currency(totals.value)],
            ].map(([label, value]) => (
              <div
                key={label}
                className="rounded-lg border bg-background/70 p-4"
              >
                <p className="text-xs text-muted-foreground">{label}</p>
                <p className="mt-2 text-2xl font-semibold tabular-nums">
                  {overview.isLoading || overview.isError ? '—' : value}
                </p>
              </div>
            ))}
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            All-time Smart Site receipts. No sample numbers. Won value is
            recorded contract value—not collected cash, ROI or profit. External
            email/SMS delivery is not enabled by this setup.
          </p>
        </CardContent>
      </Card>
      {error && (
        <p
          role="alert"
          className="rounded-md border border-destructive/40 p-3 text-sm text-destructive"
        >
          {error.message}
        </p>
      )}
      {notice && (
        <p role="status" className="rounded-md border p-3 text-sm">
          {notice}
        </p>
      )}
      {credential && (
        <Card className="border-amber-500/50">
          <CardHeader>
            <CardTitle className="text-base">
              Save this server key securely
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Shown only in this session. Keep it server-side. The database
              stores only its hash. Losing it requires a replacement key.
            </p>
            <Label htmlFor="smart-site-secret">
              Server environment settings for {credential.name}
            </Label>
            <textarea
              id="smart-site-secret"
              readOnly
              rows={4}
              className="w-full break-all rounded-md border bg-background p-3 font-mono text-xs"
              value={`GROWTHOS_SITE_ID=${credential.id}\nGROWTHOS_SITE_SECRET=${credential.secret}`}
            />
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={() => void copy()}>
                <Copy className="mr-2 h-4 w-4" /> Copy server settings
              </Button>
              <Button variant="secondary" onClick={() => setCredential(null)}>
                I saved it securely
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
      <SmartSiteFollowup
        organizationId={organizationId}
        userId={userId}
        canWrite={canWrite}
      />
      <SmartSiteAcquisition
        organizationId={organizationId}
        canManage={canManage}
      />
      <div className="grid gap-5 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Connect a Smart Site</CardTitle>
          </CardHeader>
          <CardContent>
            {canManage ? (
              <form
                className="space-y-4"
                onSubmit={(e) => {
                  e.preventDefault();
                  create.mutate();
                }}
              >
                <div className="space-y-2">
                  <Label htmlFor="smart-name">Site name</Label>
                  <Input
                    id="smart-name"
                    required
                    minLength={2}
                    maxLength={100}
                    placeholder="Painless Roofing"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="smart-key">Unique source label</Label>
                  <Input
                    id="smart-key"
                    required
                    minLength={3}
                    maxLength={80}
                    pattern="[a-z0-9][a-z0-9-]{2,79}"
                    placeholder="painless-roofing-website"
                    value={siteKey}
                    onChange={(e) => setSiteKey(e.target.value.toLowerCase())}
                  />
                  <p className="text-xs text-muted-foreground">
                    Lowercase letters, numbers and hyphens. Recorded on every
                    lead.
                  </p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="smart-profile">Business intake profile</Label>
                  <select
                    id="smart-profile"
                    className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                    value={profile}
                    onChange={(e) => setProfile(e.target.value)}
                  >
                    {profiles.data?.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                  <p className="text-xs text-muted-foreground">
                    {profiles.data
                      ?.find((p) => p.id === profile)
                      ?.services.map((s) => s[1])
                      .join(' · ')}
                  </p>
                </div>
                <p className="text-xs text-muted-foreground">
                  Creates a draft connection in the current organization. For
                  another business, switch to its organization first. Profiles
                  configure intake; they do not provision calendars, payments or
                  messaging.
                </p>
                <Button
                  type="submit"
                  disabled={create.isPending || !profiles.data}
                >
                  {create.isPending ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <Globe2 className="mr-2 h-4 w-4" />
                  )}{' '}
                  Create draft connection
                </Button>
              </form>
            ) : (
              <p className="text-sm text-muted-foreground">
                An owner or administrator can configure connections. You can
                review this organization's inquiries below.
              </p>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Connected experiences</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {sites.isLoading ? (
              <p>Loading connections…</p>
            ) : sites.data?.length ? (
              sites.data.map((s) => (
                <div key={s.id} className="space-y-3 rounded-lg border p-4">
                  <div className="flex flex-wrap justify-between gap-2">
                    <strong className="break-words">{s.name}</strong>
                    <Badge variant={s.isActive ? 'default' : 'secondary'}>
                      {s.isActive ? 'Capture enabled' : 'Capture off'}
                    </Badge>
                  </div>
                  <p className="break-all text-xs text-muted-foreground">
                    {s.siteKey} · {s.profile}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Server endpoint:{' '}
                    <code className="break-all">
                      /api/v1/public/smart-sites/{s.id}/intake
                    </code>
                  </p>
                  {canManage && (
                    <div className="flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={toggle.isPending}
                        onClick={() => toggle.mutate(s)}
                      >
                        {s.isActive ? 'Disable capture' : 'Enable capture'}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={rotate.isPending}
                        onClick={() => {
                          if (
                            window.confirm(
                              'Replace the server key? The old key will stop working and capture will be disabled until the new key is installed.',
                            )
                          )
                            rotate.mutate(s);
                        }}
                      >
                        Replace server key
                      </Button>
                    </div>
                  )}
                  {canManage && (
                    <ResponseTarget
                      key={`${s.id}:${s.responseTargetMinutes}`}
                      id={s.id}
                      minutes={s.responseTargetMinutes ?? 60}
                      organizationId={organizationId}
                    />
                  )}
                </div>
              ))
            ) : (
              <div className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">
                Your first connection starts here. Draft it, install its server
                key, then enable and verify a labeled test inquiry.
              </div>
            )}
            <div className="flex gap-2 pt-2 text-xs text-muted-foreground">
              <CheckCircle2 className="h-4 w-4 shrink-0" /> A saved inquiry
              includes a consent receipt, follow-up task and audit record. It
              does not confirm a call, appointment or email.
            </div>
          </CardContent>
        </Card>
      </div>
      {!!overview.data?.rows.length && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Service breakdown</CardTitle>
          </CardHeader>
          <CardContent className="divide-y">
            {overview.data.rows.map((row) => (
              <div
                key={`${row.siteId}-${row.service}`}
                className="space-y-3 py-4 first:pt-0 last:pb-0"
              >
                <div>
                  <p className="font-medium">{row.service}</p>
                  <p className="text-xs text-muted-foreground">
                    {row.siteName}
                  </p>
                </div>
                <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  {[
                    ['Saved inquiries', row.captured],
                    ['Need an owner', row.unassigned],
                    ['Recorded wins', row.won],
                    ['Won contract value', currency(row.contractValueCents)],
                  ].map(([label, value]) => (
                    <div key={label}>
                      <dt className="text-xs text-muted-foreground">{label}</dt>
                      <dd className="mt-1 font-semibold tabular-nums">
                        {value}
                      </dd>
                    </div>
                  ))}
                </dl>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Latest saved inquiries</CardTitle>
        </CardHeader>
        <CardContent>
          {overview.data?.recent.length ? (
            <div className="divide-y">
              {overview.data.recent.map((lead) => (
                <Link
                  key={lead.leadId}
                  href={`/leads/${lead.leadId}`}
                  className="flex flex-wrap items-center justify-between gap-3 py-3"
                >
                  <div>
                    <p className="font-medium">
                      {lead.name} · {lead.service}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {lead.source} ·{' '}
                      {new Date(lead.createdAt).toLocaleString()}
                    </p>
                  </div>
                  <span className="inline-flex items-center gap-2 text-sm">
                    {lead.status.replaceAll('_', ' ')}
                    <ArrowUpRight className="h-4 w-4" />
                  </span>
                </Link>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              No saved inquiries to show yet. A successful server submission
              will appear here with a real lead record.
            </p>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
