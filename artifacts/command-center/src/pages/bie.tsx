import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'wouter';
import {
  Activity,
  Bot,
  CheckCircle2,
  Copy,
  CircleAlert,
  Database,
  FileUp,
  FileSearch2,
  FlaskConical,
  Gauge,
  MailSearch,
  Loader2,
  Play,
  RefreshCw,
  Send,
  ShieldCheck,
  Sparkles,
  Target,
  Trash2,
  XCircle,
} from 'lucide-react';
import { useGetMe, UserRole } from '@workspace/api-client-react';
import { canManageSettings, canWrite } from '@/lib/permissions';
import { cn } from '@/lib/utils';
import { RevenueWorkspace } from '@/components/revenue-workspace';
import { CustomerReplies } from '@/components/customer-replies';
import { BieEmailReviewSummary, preparedBieEmail } from '@/components/bie-email-review';

type SourceStatus = 'not_connected' | 'pending' | 'connected' | 'error';
type ActionType = 'create_task' | 'change_stage' | 'send_email';
type ActionStatus = 'proposed' | 'approved' | 'processing' | 'indeterminate' | 'executed' | 'blocked' | 'rejected' | 'failed';

interface BieSource {
  id: string;
  source: 'google_ads' | 'google_analytics' | 'search_console' | 'business_profile';
  status: SourceStatus;
  accountLabel: string | null;
  lastSyncedAt: string | null;
  lastError: string | null;
}

interface BiePolicy {
  enabled: boolean;
  allowedActions: ActionType[];
  dailyEmailCap: number;
  pausedAt?: string | null;
  pauseReason?: string | null;
}

interface Opportunity {
  kind: 'stalled_estimate' | 'dormant_pipeline' | 'data_quality';
  title: string;
  detail: string;
  count: number;
  estimatedValueCents: number;
  confidence: 'observed' | 'partial';
  leadIds: string[];
}

interface Briefing {
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
  opportunities: Opportunity[];
  narrative: string;
  sources: BieSource[];
  policy: BiePolicy;
}

interface Proposal {
  id: string;
  actionType: ActionType;
  status: ActionStatus;
  title: string;
  rationale: string;
  evidence: Record<string, unknown>;
  payload: Record<string, unknown>;
  estimatedValueCents: number | null;
  executionDetail: string | null;
  createdAt: string;
}

type EmailSourceStatus = 'pending' | 'active' | 'paused' | 'error';
type EmailFactStatus = 'needs_review' | 'verified' | 'rejected';

interface EmailIntelligenceSource {
  id: string;
  status: EmailSourceStatus;
  intakeAddress: string;
  allowedForwarders: string[];
  retentionDays: number;
  attachmentsEnabled: boolean;
  lastReceivedAt: string | null;
  lastErrorCode: string | null;
}

interface EmailIntelligenceStatus {
  source: EmailIntelligenceSource | null;
  providerConfigured: boolean;
  messagesAccepted: number;
  factsAwaitingReview: number;
  rawMessagesHeld: number;
}

interface EmailIntelligenceFact {
  id: string;
  kind: string;
  status: EmailFactStatus;
  statement: string;
  evidenceExcerpt: string;
  confidence: number;
}

interface EmailIntelligenceMessage {
  id: string;
  fromEmail: string;
  forwardedBy: string;
  redactedSubject: string;
  status: 'processed' | 'raw_purged';
  receivedAt: string;
  rawExpiresAt: string;
  rawPurgedAt: string | null;
  rawAvailable: boolean;
  facts: EmailIntelligenceFact[];
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/v1${path}`, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    ...init,
  });
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw Object.assign(new Error(body.error || 'BIE could not complete that request.'), { status: response.status });
  return body;
}

const dollars = (cents: number) =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(cents / 100);

const sourceNames: Record<BieSource['source'], string> = {
  google_ads: 'Google Ads',
  google_analytics: 'Google Analytics 4',
  search_console: 'Search Console',
  business_profile: 'Business Profile',
};

const actionNames: Record<ActionType, string> = {
  send_email: 'Email recovery check-in',
  create_task: 'Create follow-up task',
  change_stage: 'Move to follow-up',
};

function StatusPill({ status }: { status: SourceStatus | ActionStatus }) {
  const copy: Record<string, string> = {
    not_connected: 'Not connected',
    pending: 'Setup pending',
    connected: 'Connected',
    error: 'Needs attention',
    proposed: 'Needs review',
    approved: 'Approved',
    processing: 'In progress',
    indeterminate: 'Needs reconciliation',
    executed: 'Done',
    blocked: 'Blocked safely',
    rejected: 'Rejected',
    failed: 'Failed',
  };
  const tone: Record<string, string> = {
    connected: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/20',
    approved: 'bg-sky-500/10 text-sky-700 dark:text-sky-300 border-sky-500/20',
    executed: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/20',
    proposed: 'bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/20',
    blocked: 'bg-slate-500/10 text-muted-foreground border-border',
    failed: 'bg-destructive/10 text-destructive border-destructive/20',
    error: 'bg-destructive/10 text-destructive border-destructive/20',
  };
  return (
    <span className={cn('inline-flex rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide', tone[status] ?? 'bg-muted text-muted-foreground border-border')}>
      {copy[status]}
    </span>
  );
}

function EvidencePill({ confidence }: { confidence: Opportunity['confidence'] }) {
  return (
    <span className={cn(
      'inline-flex rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
      confidence === 'observed'
        ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
        : 'border-amber-500/20 bg-amber-500/10 text-amber-700 dark:text-amber-300',
    )}>
      {confidence === 'observed' ? 'Observed' : 'Partial data'}
    </span>
  );
}

function MetricCard({
  icon: Icon,
  label,
  value,
  detail,
  emphasis,
}: {
  icon: typeof Gauge;
  label: string;
  value: string;
  detail: string;
  emphasis?: boolean;
}) {
  return (
    <div className={cn('rounded-xl border p-4 shadow-sm', emphasis ? 'border-primary/30 bg-primary/[0.04]' : 'border-border bg-card')}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{label}</p>
          <p className={cn('mt-2 text-2xl font-bold tracking-tight', emphasis && 'text-primary')}>{value}</p>
        </div>
        <div className={cn('rounded-lg p-2', emphasis ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground')}>
          <Icon className="h-4 w-4" />
        </div>
      </div>
      <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{detail}</p>
    </div>
  );
}

function ActionButtons({
  proposal,
  busy,
  onReview,
  onExecute,
  onPrepare,
}: {
  proposal: Proposal;
  busy: boolean;
  onReview: (id: string, decision: 'approve' | 'reject') => void;
  onExecute: (id: string) => void;
  onPrepare: (id: string) => void;
}) {
  if (proposal.status === 'proposed') {
    return (
      <div className="flex flex-wrap gap-2">
        {proposal.actionType === 'send_email' && <button disabled={busy} onClick={() => onPrepare(proposal.id)} className="min-h-10 rounded-md border border-border px-3 text-xs font-semibold">{preparedBieEmail(proposal.payload) ? 'Refresh recipient and sender' : 'Prepare recipient and sender'}</button>}
        <button onClick={() => onReview(proposal.id, 'approve')} disabled={busy || (proposal.actionType === 'send_email' && !preparedBieEmail(proposal.payload))} className="inline-flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-xs font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-60">
          <CheckCircle2 className="h-3.5 w-3.5" /> Approve
        </button>
        <button onClick={() => onReview(proposal.id, 'reject')} disabled={busy} className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-background px-3 text-xs font-semibold hover:bg-muted disabled:opacity-60">
          <XCircle className="h-3.5 w-3.5" /> Reject
        </button>
      </div>
    );
  }
  if (proposal.status === 'approved') {
    return (
      <button onClick={() => onExecute(proposal.id)} disabled={busy} className="inline-flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-xs font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-60">
        <Play className="h-3.5 w-3.5" /> Execute now
      </button>
    );
  }
  return proposal.executionDetail ? <p className="max-w-52 text-right text-xs text-muted-foreground">{proposal.executionDetail}</p> : null;
}

export default function Bie() {
  const queryClient = useQueryClient();
  const { data: profile } = useGetMe();
  const canManage = canManageSettings(profile?.role as UserRole | undefined);
  const canAct = canWrite(profile?.role as UserRole | undefined);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [staleActions, setStaleActions] = useState<string[]>([]);

  const briefingQuery = useQuery({
    queryKey: ['bie', 'briefing'],
    queryFn: () => request<Briefing>('/bie/briefing'),
  });
  const actionsQuery = useQuery({
    queryKey: ['bie', 'actions'],
    queryFn: () => request<Proposal[]>('/bie/actions'),
  });
  const emailStatusQuery = useQuery({
    queryKey: ['email-intelligence', 'status'],
    queryFn: () => request<EmailIntelligenceStatus>('/email-intelligence'),
  });
  const emailMessagesQuery = useQuery({
    queryKey: ['email-intelligence', 'messages'],
    queryFn: () => request<EmailIntelligenceMessage[]>('/email-intelligence/messages'),
    enabled: Boolean(emailStatusQuery.data?.source),
  });

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['bie', 'briefing'] }),
      queryClient.invalidateQueries({ queryKey: ['bie', 'actions'] }),
      queryClient.invalidateQueries({ queryKey: ['email-intelligence'] }),
    ]);
  };
  const withFeedback = async (operation: () => Promise<unknown>, success: string) => {
    setError(null);
    setNotice(null);
    try {
      await operation();
      await refresh();
      setNotice(success);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'BIE could not complete that request.');
    }
  };

  const briefingMutation = useMutation({
    mutationFn: () => request<Briefing>('/bie/briefing/run', { method: 'POST' }),
    onSuccess: async () => {
      await refresh();
      setNotice('Recovery briefing refreshed from your CRM records.');
    },
    onError: (err) => setError(err instanceof Error ? err.message : 'BIE could not run the briefing.'),
  });
  const proposalsMutation = useMutation({
    mutationFn: () => request<Proposal[]>('/bie/actions/generate', { method: 'POST' }),
    onSuccess: async (proposals) => {
      await refresh();
      setNotice(`${proposals.length} reviewable action${proposals.length === 1 ? '' : 's'} added to the queue.`);
    },
    onError: (err) => setError(err instanceof Error ? err.message : 'BIE could not build the action queue.'),
  });
  const actionMutation = useMutation({
    mutationFn: ({ id, path, expectedPayload }: { id: string; path: 'approve' | 'reject' | 'execute' | 'prepare-email'; expectedPayload?: Record<string, unknown> }) => request<Proposal>(`/bie/actions/${id}/${path}`, { method: 'POST', body: JSON.stringify(['approve', 'prepare-email'].includes(path) ? { expectedPayload } : {}) }),
    onSuccess: async () => {
      await refresh();
      setNotice('Action queue updated.');
    },
    onError: (err, input) => {
      if ('status' in err && (err.status === 409 || err.status === 412)) setStaleActions(ids => [...new Set([...ids, input.id])]);
      setError(err instanceof Error ? err.message : 'BIE could not update this action.');
    },
  });
  const policyMutation = useMutation({
    mutationFn: (policy: Partial<BiePolicy>) => request<BiePolicy>('/bie/autopilot', { method: 'PUT', body: JSON.stringify(policy) }),
    onSuccess: async () => {
      await refresh();
      setNotice('Autopilot policy saved.');
    },
    onError: (err) => setError(err instanceof Error ? err.message : 'BIE could not update the policy.'),
  });
  const emailSetupMutation = useMutation({
    mutationFn: async () => {
      if (!profile?.email) throw new Error('Your GrowthOS account needs an email address before creating an inbox.');
      return request<EmailIntelligenceStatus>('/email-intelligence/source', {
        method: 'POST',
        body: JSON.stringify({ allowedForwarders: [profile.email] }),
      });
    },
    onSuccess: async () => {
      await refresh();
      setNotice('A tenant-specific Email Intelligence Inbox was reserved. Live delivery remains off until the provider bridge is configured.');
    },
    onError: (err) => setError(err instanceof Error ? err.message : 'The inbox could not be created.'),
  });
  const emailTestMutation = useMutation({
    mutationFn: () => request<{ factCount: number }>('/email-intelligence/test', { method: 'POST' }),
    onSuccess: async (result) => {
      await refresh();
      setNotice(`Synthetic message processed with ${result.factCount} reviewable fact${result.factCount === 1 ? '' : 's'}.`);
    },
    onError: (err) => setError(err instanceof Error ? err.message : 'The synthetic email test failed.'),
  });
  const emailFactMutation = useMutation({
    mutationFn: ({ id, status }: { id: string; status: 'verified' | 'rejected' }) => request<EmailIntelligenceFact>(`/email-intelligence/facts/${id}/review`, {
      method: 'POST',
      body: JSON.stringify({ status }),
    }),
    onSuccess: async () => {
      await refresh();
      setNotice('Email intelligence finding reviewed.');
    },
    onError: (err) => setError(err instanceof Error ? err.message : 'The finding could not be reviewed.'),
  });
  const emailPurgeMutation = useMutation({
    mutationFn: (id: string) => request<{ success: boolean }>(`/email-intelligence/messages/${id}/raw`, { method: 'DELETE' }),
    onSuccess: async () => {
      await refresh();
      setNotice('Encrypted raw message content was permanently purged. Redacted review facts remain.');
    },
    onError: (err) => setError(err instanceof Error ? err.message : 'Raw message content could not be purged.'),
  });
  const emailDeleteMutation = useMutation({
    mutationFn: (id: string) => request<{ success: boolean }>(`/email-intelligence/messages/${id}`, { method: 'DELETE' }),
    onSuccess: async () => {
      await refresh();
      setNotice('The email record and all of its derived findings were deleted.');
    },
    onError: (err) => setError(err instanceof Error ? err.message : 'The email record could not be deleted.'),
  });
  const emailSourceMutation = useMutation({
    mutationFn: ({ id, status }: { id: string; status: 'active' | 'paused' }) => request<EmailIntelligenceStatus>(`/email-intelligence/source/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status }),
    }),
    onSuccess: async (_, variables) => {
      await refresh();
      setNotice(variables.status === 'active' ? 'Live email intake enabled.' : 'Email intake paused.');
    },
    onError: (err) => setError(err instanceof Error ? err.message : 'The email source could not be updated.'),
  });

  const briefing = briefingQuery.data;
  const proposed = useMemo(() => (actionsQuery.data ?? []).filter((action) => action.status === 'proposed'), [actionsQuery.data]);
  const busy = briefingMutation.isPending || proposalsMutation.isPending || actionMutation.isPending || policyMutation.isPending || emailSetupMutation.isPending || emailTestMutation.isPending || emailFactMutation.isPending || emailPurgeMutation.isPending || emailDeleteMutation.isPending || emailSourceMutation.isPending;
  const emailStatus = emailStatusQuery.data;
  const emailSource = emailStatus?.source;

  if (briefingQuery.isLoading) {
    return <div className="flex min-h-[50vh] items-center justify-center"><Loader2 className="h-7 w-7 animate-spin text-primary" /></div>;
  }
  if (!briefing) {
    return <div className="mx-auto max-w-3xl p-8"><p className="text-destructive">{briefingQuery.error instanceof Error ? briefingQuery.error.message : 'BIE could not load your tenant data.'}</p></div>;
  }

  const policy = briefing.policy;
  const autopilotState = policy.enabled && !policy.pausedAt ? 'Guardrailed autopilot enabled' : 'Approval-first mode';

  return (
    <div className="mx-auto max-w-7xl space-y-6 p-4 md:p-7">
      <section className="overflow-hidden rounded-2xl border border-primary/25 bg-gradient-to-br from-primary/[0.12] via-card to-card p-5 md:p-7">
        <div className="flex flex-col justify-between gap-5 xl:flex-row xl:items-start">
          <div className="max-w-3xl">
            <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-primary/20 bg-background/70 px-3 py-1 text-xs font-semibold text-primary">
              <Sparkles className="h-3.5 w-3.5" /> MOGULFORGE BIE · GROWTHOS
            </div>
            <h1 className="text-3xl font-bold tracking-tight md:text-4xl">Revenue Desk</h1>
            <p className="mt-3 text-sm leading-relaxed text-muted-foreground md:text-base">{briefing.narrative}</p>
            <p className="mt-3 text-xs text-muted-foreground">Last calculated {new Date(briefing.generatedAt).toLocaleString()}. Pipeline value is not claimed revenue.</p>
          </div>
          <div className="flex shrink-0 flex-wrap gap-2 xl:max-w-sm xl:justify-end">
            <Link href="/evidence" className="inline-flex h-10 items-center gap-2 rounded-md border border-primary/30 bg-background px-4 text-sm font-semibold text-primary shadow-sm hover:bg-primary/5">
              <FileSearch2 className="h-4 w-4" /> Open Evidence Intelligence
            </Link>
            <button onClick={() => { setError(null); setNotice(null); briefingMutation.mutate(); }} disabled={busy} className="inline-flex h-10 items-center gap-2 rounded-md bg-primary px-4 text-sm font-semibold text-primary-foreground shadow-sm hover:bg-primary/90 disabled:opacity-60">
              {briefingMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />} Run recovery briefing
            </button>
            <button onClick={() => { setError(null); setNotice(null); proposalsMutation.mutate(); }} disabled={busy || briefing.opportunityCount === 0} className="inline-flex h-10 items-center gap-2 rounded-md border border-border bg-background px-4 text-sm font-semibold hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60">
              <Bot className="h-4 w-4" /> Build action queue
            </button>
          </div>
        </div>
      </section>

      {(notice || error) && (
        <div className={cn('flex items-start gap-2 rounded-lg border px-4 py-3 text-sm', error ? 'border-destructive/30 bg-destructive/5 text-destructive' : 'border-emerald-500/30 bg-emerald-500/5 text-emerald-700 dark:text-emerald-300')}>
          {error ? <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" /> : <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />}
          {error || notice}
        </div>
      )}

      <RevenueWorkspace />
      <CustomerReplies canReview={canWrite(profile?.role as UserRole | undefined)} />
      <details className="space-y-5 rounded-xl border p-4">
      <summary className="cursor-pointer text-sm font-semibold">Advanced BIE analysis, integrations & policy</summary>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard icon={Target} label="Known lead value at risk" value={dollars(briefing.revenueAtRiskCents)} detail="Observed sums for qualifying CRM leads only." emphasis />
        <MetricCard icon={Activity} label="Recovery candidates" value={String(briefing.opportunityCount)} detail="Stalled estimates, claims, and dormant pipeline records." />
        <MetricCard icon={Gauge} label="Data readiness" value={`${briefing.dataReadiness.score}/100`} detail={`${briefing.dataReadiness.leadsWithKnownValue} of ${briefing.totalLeads} leads have known value.`} />
        <MetricCard icon={Database} label="Google revenue stack" value={`${briefing.dataReadiness.googleSourcesConnected}/${briefing.dataReadiness.totalGoogleSources}`} detail="Connected sources only; no provider metrics are assumed." />
      </div>

      <section className="rounded-xl border border-border bg-card p-5 shadow-sm">
        <div className="flex flex-col justify-between gap-4 lg:flex-row lg:items-start">
          <div className="max-w-3xl">
            <div className="flex flex-wrap items-center gap-2">
              <MailSearch className="h-5 w-5 text-primary" />
              <h2 className="text-lg font-semibold">Email Intelligence Inbox</h2>
              <span className={cn(
                'inline-flex rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
                emailSource?.status === 'active'
                  ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                  : 'border-amber-500/20 bg-amber-500/10 text-amber-700 dark:text-amber-300',
              )}>
                {emailSource?.status === 'active' ? 'Live intake' : emailSource ? 'Setup pending' : 'Not configured'}
              </span>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">Analyze only the business email streams an owner authorizes. Attachments are off, raw content is encrypted and short-lived, and every extracted fact requires review.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            {!emailSource && canManage && (
              <button disabled={busy || !profile?.email} onClick={() => { setError(null); setNotice(null); emailSetupMutation.mutate(); }} className="inline-flex h-9 items-center gap-2 rounded-md bg-primary px-3 text-xs font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-60">
                {emailSetupMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <MailSearch className="h-3.5 w-3.5" />} Reserve secure inbox
              </button>
            )}
            {emailSource && canManage && (
              <button disabled={busy} onClick={() => { setError(null); setNotice(null); emailTestMutation.mutate(); }} className="inline-flex h-9 items-center gap-2 rounded-md border border-border bg-background px-3 text-xs font-semibold hover:bg-muted disabled:opacity-60">
                {emailTestMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FlaskConical className="h-3.5 w-3.5" />} Run synthetic test
              </button>
            )}
            {emailSource && canManage && emailStatus?.providerConfigured && (
              <button disabled={busy} onClick={() => { setError(null); setNotice(null); emailSourceMutation.mutate({ id: emailSource.id, status: emailSource.status === 'active' ? 'paused' : 'active' }); }} className="inline-flex h-9 items-center gap-2 rounded-md border border-border bg-background px-3 text-xs font-semibold hover:bg-muted disabled:opacity-60">
                {emailSource.status === 'active' ? 'Pause live intake' : 'Activate live intake'}
              </button>
            )}
          </div>
        </div>

        {emailStatusQuery.isError && <p className="mt-4 text-sm text-destructive">{emailStatusQuery.error instanceof Error ? emailStatusQuery.error.message : 'Email Intelligence status could not be loaded.'}</p>}

        {emailSource ? (
          <>
            <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
              <div className="rounded-lg bg-muted/60 p-3 md:col-span-2">
                <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Reserved intake address</p>
                <div className="mt-1 flex items-center gap-2">
                  <code className="break-all text-sm font-semibold text-foreground">{emailSource.intakeAddress}</code>
                  <button title="Copy address" onClick={() => { void navigator.clipboard?.writeText(emailSource.intakeAddress); setNotice('Inbox address copied.'); }} className="rounded p-1 text-muted-foreground hover:bg-background hover:text-foreground"><Copy className="h-3.5 w-3.5" /></button>
                </div>
                {!emailStatus?.providerConfigured && <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">Reserved only. The inbound provider bridge and DNS are not configured, so this address cannot receive live mail yet.</p>}
              </div>
              <div className="rounded-lg bg-muted/60 p-3"><p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Data controls</p><p className="mt-1 text-sm font-medium">{emailSource.retentionDays}-day raw retention</p><p className="mt-1 text-xs text-muted-foreground">Attachments {emailSource.attachmentsEnabled ? 'enabled' : 'disabled'}</p></div>
              <div className="rounded-lg bg-muted/60 p-3"><p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Review queue</p><p className="mt-1 text-sm font-medium">{emailStatus?.factsAwaitingReview ?? 0} finding{emailStatus?.factsAwaitingReview === 1 ? '' : 's'} waiting</p><p className="mt-1 text-xs text-muted-foreground">{emailStatus?.rawMessagesHeld ?? 0} encrypted raw message{emailStatus?.rawMessagesHeld === 1 ? '' : 's'} retained</p></div>
            </div>
            <div className="mt-3 rounded-lg border border-border/80 bg-background/40 p-3 text-xs text-muted-foreground">
              Authorized forwarder{emailSource.allowedForwarders.length === 1 ? '' : 's'}: <span className="font-medium text-foreground">{emailSource.allowedForwarders.join(', ')}</span>. Only authenticated provider events attributed to this list are accepted.
            </div>

            <div className="mt-4 divide-y divide-border rounded-lg border border-border">
              {emailMessagesQuery.isLoading && <div className="p-4 text-sm text-muted-foreground">Loading email intelligence evidence…</div>}
              {!emailMessagesQuery.isLoading && !(emailMessagesQuery.data?.length) && <div className="p-4 text-sm text-muted-foreground">No messages processed. Owners can run the synthetic fixture without connecting a real mailbox.</div>}
              {(emailMessagesQuery.data ?? []).slice(0, 6).map((message) => (
                <div key={message.id} className="p-4">
                  <div className="flex flex-col justify-between gap-2 md:flex-row md:items-start">
                    <div><p className="text-sm font-semibold">{message.redactedSubject || '(No subject)'}</p><p className="mt-0.5 text-xs text-muted-foreground">From {message.fromEmail} · received {new Date(message.receivedAt).toLocaleString()}</p></div>
                    <div className="flex flex-wrap items-center gap-2">
                      {message.rawAvailable && canManage ? <button disabled={busy} onClick={() => { setError(null); setNotice(null); emailPurgeMutation.mutate(message.id); }} className="inline-flex h-8 items-center gap-1.5 self-start rounded-md border border-border bg-background px-2.5 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-60"><Trash2 className="h-3.5 w-3.5" /> Purge raw</button> : <span className="text-xs text-muted-foreground">Raw content purged</span>}
                      {canManage && <button disabled={busy} onClick={() => { if (window.confirm('Delete this email record and every derived finding? This cannot be undone.')) { setError(null); setNotice(null); emailDeleteMutation.mutate(message.id); } }} className="inline-flex h-8 items-center gap-1.5 self-start rounded-md border border-destructive/30 bg-background px-2.5 text-xs font-medium text-destructive hover:bg-destructive/5 disabled:opacity-60"><XCircle className="h-3.5 w-3.5" /> Delete record</button>}
                    </div>
                  </div>
                  <div className="mt-3 space-y-2">
                    {message.facts.length === 0 && <p className="text-xs text-muted-foreground">No deterministic beta rule matched this message.</p>}
                    {message.facts.map((fact) => (
                      <div key={fact.id} className="rounded-md bg-muted/50 p-3">
                        <div className="flex flex-col justify-between gap-2 md:flex-row md:items-start">
                          <div><div className="flex flex-wrap items-center gap-2"><span className="text-xs font-semibold uppercase tracking-wide text-primary">{fact.kind.replaceAll('_', ' ')}</span><span className="text-[10px] font-medium text-muted-foreground">{fact.confidence}% rule confidence</span><span className="text-[10px] font-medium text-muted-foreground">{fact.status.replaceAll('_', ' ')}</span></div><p className="mt-1 text-sm">{fact.statement}</p><p className="mt-1 text-xs leading-relaxed text-muted-foreground">“{fact.evidenceExcerpt}”</p></div>
                          {fact.status === 'needs_review' && <div className="flex shrink-0 gap-1.5"><button disabled={busy} onClick={() => { setError(null); setNotice(null); emailFactMutation.mutate({ id: fact.id, status: 'verified' }); }} className="rounded-md bg-primary px-2.5 py-1.5 text-xs font-semibold text-primary-foreground disabled:opacity-60">Verify</button><button disabled={busy} onClick={() => { setError(null); setNotice(null); emailFactMutation.mutate({ id: fact.id, status: 'rejected' }); }} className="rounded-md border border-border bg-background px-2.5 py-1.5 text-xs font-semibold disabled:opacity-60">Reject</button></div>}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </>
        ) : !emailStatusQuery.isLoading && (
          <div className="mt-4 rounded-lg border border-dashed border-border p-5 text-sm text-muted-foreground">No mailbox access is requested. An owner may reserve an organization-specific inbox and begin with a synthetic fixture; live routing stays disabled until the provider and domain are deliberately configured.</div>
        )}
      </section>

      <div className="grid gap-6 xl:grid-cols-[1.5fr_1fr]">
        <section className="rounded-xl border border-border bg-card p-5 shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold">Recovery opportunities</h2>
              <p className="mt-1 text-sm text-muted-foreground">Each recommendation has source evidence and stays tenant-scoped.</p>
            </div>
            <span className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground"><ShieldCheck className="h-4 w-4 text-primary" /> Evidence first</span>
          </div>
          <div className="mt-4 space-y-3">
            {briefing.opportunities.length ? briefing.opportunities.map((item) => (
              <div key={item.kind} className="rounded-lg border border-border/80 bg-background/40 p-4">
                <div className="flex flex-col justify-between gap-2 sm:flex-row">
                  <div>
                    <div className="flex flex-wrap items-center gap-2"><h3 className="font-semibold">{item.title}</h3><EvidencePill confidence={item.confidence} /></div>
                    <p className="mt-1 text-sm text-muted-foreground">{item.detail}</p>
                  </div>
                  <div className="shrink-0 text-left sm:text-right"><p className="text-lg font-bold">{dollars(item.estimatedValueCents)}</p><p className="text-xs text-muted-foreground">{item.count} lead{item.count === 1 ? '' : 's'}</p></div>
                </div>
              </div>
            )) : (
              <div className="rounded-lg border border-dashed border-border p-6 text-center">
                <FileUp className="mx-auto h-6 w-6 text-muted-foreground" />
                <h3 className="mt-2 font-semibold">Start with a historical CSV</h3>
                <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">Import past leads and BIE will calculate a recovery view from records it can actually inspect.</p>
                <Link href="/reactivation" className="mt-3 inline-flex text-sm font-semibold text-primary hover:underline">Open CSV import and Win-back →</Link>
              </div>
            )}
          </div>
        </section>

        <section className="rounded-xl border border-border bg-card p-5 shadow-sm">
          <div className="flex items-start justify-between gap-3"><div><h2 className="text-lg font-semibold">Google Revenue Stack</h2><p className="mt-1 text-sm text-muted-foreground">Ads, GA4, Search Console, and Business Profile.</p></div><Database className="h-5 w-5 text-primary" /></div>
          <div className="mt-4 space-y-3">
            {briefing.sources.map((source) => (
              <div key={source.source} className="flex items-center justify-between gap-3 rounded-lg border border-border/80 p-3">
                <div><p className="text-sm font-medium">{sourceNames[source.source]}</p><p className="mt-0.5 text-xs text-muted-foreground">{source.accountLabel || (source.status === 'not_connected' ? 'Secure connection not configured' : 'No account label returned')}</p></div>
                <StatusPill status={source.status} />
              </div>
            ))}
          </div>
          <div className="mt-4 rounded-lg bg-muted/60 p-3 text-xs leading-relaxed text-muted-foreground">Connection credentials are intentionally not stored here. BIE will show provider evidence only after a secure OAuth connector is configured.</div>
        </section>
      </div>

      <section className="rounded-xl border border-border bg-card p-5 shadow-sm">
        <div className="flex flex-col justify-between gap-4 md:flex-row md:items-start">
          <div><div className="flex flex-wrap items-center gap-2"><h2 className="text-lg font-semibold">Expert action queue</h2><StatusPill status={proposed.length ? 'proposed' : 'executed'} /></div><p className="mt-1 text-sm text-muted-foreground">Approve individual actions before execution. Email also checks provider readiness, suppression, quiet hours, and the BIE daily cap.</p></div>
          <div className="rounded-lg border border-border bg-background px-3 py-2 text-right"><p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Mode</p><p className="mt-0.5 text-sm font-semibold">{autopilotState}</p></div>
        </div>
        <div className="mt-4 divide-y divide-border rounded-lg border border-border">
          {actionsQuery.isLoading && <div className="p-5 text-sm text-muted-foreground">Loading action queue…</div>}
          {!actionsQuery.isLoading && !(actionsQuery.data?.length) && <div className="p-5 text-sm text-muted-foreground">No queued actions yet. Run a recovery briefing, then build a review queue.</div>}
          {(actionsQuery.data ?? []).map((proposal) => (
            <div key={proposal.id} className="flex flex-col gap-3 p-4 lg:flex-row lg:items-center lg:justify-between">
              <div className="max-w-3xl"><div className="flex flex-wrap items-center gap-2"><p className="font-medium">{proposal.title}</p><StatusPill status={proposal.status} /><span className="text-xs text-muted-foreground">{actionNames[proposal.actionType]}</span></div><p className="mt-1 text-sm text-muted-foreground">{proposal.rationale}</p>{proposal.estimatedValueCents != null && <p className="mt-1 text-xs font-medium text-muted-foreground">Known lead value: {dollars(proposal.estimatedValueCents)}</p>}</div>
              {proposal.actionType === 'send_email' && <BieEmailReviewSummary payload={proposal.payload} status={proposal.status} showContent />}
              {staleActions.includes(proposal.id) && <div className="space-y-2 text-sm"><p role="alert">The saved action changed. Refresh and review the current sender, recipient and message before another decision.</p><button disabled={busy || actionsQuery.isFetching} className="min-h-10 rounded-md border border-border px-3" onClick={async () => { const result = await actionsQuery.refetch(); if (!result.isError) setStaleActions(ids => ids.filter(id => id !== proposal.id)); }}>Refresh saved action for review</button></div>}
              <ActionButtons proposal={proposal} busy={busy || !canAct || staleActions.includes(proposal.id)} onPrepare={(id) => { setError(null); setNotice(null); actionMutation.mutate({ id, path: 'prepare-email', expectedPayload: proposal.payload }); }} onReview={(id, decision) => { setError(null); setNotice(null); actionMutation.mutate({ id, path: decision, expectedPayload: proposal.payload }); }} onExecute={(id) => { setError(null); setNotice(null); actionMutation.mutate({ id, path: 'execute' }); }} />
            </div>
          ))}
        </div>
      </section>

      <section className="rounded-xl border border-border bg-card p-5 shadow-sm">
        <div className="flex flex-col justify-between gap-4 md:flex-row md:items-center"><div><div className="flex items-center gap-2"><ShieldCheck className="h-5 w-5 text-primary" /><h2 className="text-lg font-semibold">Guardrailed autopilot</h2></div><p className="mt-1 max-w-3xl text-sm text-muted-foreground">Default off. Only individually approved actions can run, every execution is audited, and email can never bypass provider, consent, suppression, quiet-hour, or daily-cap checks.</p></div>{canManage && <button disabled={busy} onClick={() => { setError(null); setNotice(null); policyMutation.mutate({ enabled: !policy.enabled, allowedActions: !policy.enabled && policy.allowedActions.length === 0 ? ['create_task', 'change_stage'] : policy.allowedActions }); }} className="inline-flex h-10 shrink-0 items-center gap-2 rounded-md border border-border bg-background px-4 text-sm font-semibold hover:bg-muted disabled:opacity-60">{policy.enabled ? <><XCircle className="h-4 w-4" /> Disable autopilot</> : <><ShieldCheck className="h-4 w-4" /> Enable guardrailed autopilot</>}</button>}</div>
        <div className="mt-4 grid gap-3 md:grid-cols-3"><div className="rounded-lg bg-muted/60 p-3"><p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Allowed actions</p><p className="mt-1 text-sm font-medium">{policy.allowedActions.length ? policy.allowedActions.map((action) => actionNames[action]).join(' · ') : 'None — execution remains off'}</p>{canManage && <div className="mt-3 space-y-2">{(['create_task', 'change_stage', 'send_email'] as ActionType[]).map((action) => <label key={action} className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground"><input type="checkbox" checked={policy.allowedActions.includes(action)} disabled={busy} onChange={(event) => { const allowedActions = event.target.checked ? [...new Set([...policy.allowedActions, action])] : policy.allowedActions.filter((item) => item !== action); setError(null); setNotice(null); policyMutation.mutate({ allowedActions }); }} />{actionNames[action]}</label>)}</div>}</div><div className="rounded-lg bg-muted/60 p-3"><p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Daily BIE email cap</p><p className="mt-1 text-sm font-medium">{policy.dailyEmailCap} messages maximum</p></div><div className="rounded-lg bg-muted/60 p-3"><p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Operator control</p><p className="mt-1 text-sm font-medium">{policy.pausedAt ? `Paused: ${policy.pauseReason || 'by operator'}` : 'No active pause'}</p></div></div>
      </section>

      <p className="pb-4 text-center text-xs text-muted-foreground">BIE does not train a shared model on tenant records. Product learning should use de-identified outcome evaluations with beta consent.</p>
      </details>
    </div>
  );
}
