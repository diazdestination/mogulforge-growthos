import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { CheckCircle2, Loader2, RefreshCw, XCircle } from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { ZapierFlowActions } from './zapier-flow-actions';

const CUSTOMER_TEXT_KEYS = ['appt.sms.send', 'maintain.sms.send', 'scout.sms.review_request', 'appt.sms.on_my_way', 'bill.sms.payment_link', 'esti.sms.approval_link'];
const CUSTOMER_EMAIL_KEYS = ['invo.email.send', 'esti.email.send'];
const pollLabel = (minutes: number) => minutes % 60 === 0 ? `Every ${minutes / 60 === 1 ? 'hour' : `${minutes / 60} hours`}` : `Every ${minutes} minutes`;

type ZapierStatus = {
  configured: boolean;
  provisioning: 'mogulforge' | 'legacy' | 'unassigned';
  connectionFingerprint: string | null;
  monthlyActionLimit?: number | null;
  connected: boolean;
  serverMode: 'agentic' | 'managed' | 'unknown' | null;
  toolCount: number | null;
  connectedAt: string | null;
  lastUsedAt: string | null;
  lastErrorAt: string | null;
  lastErrorCode: string | null;
  pollIntervalMinutes?: number;
  pollIntervalChoices?: number[];
};

type LiveAction = {
  app: string;
  appName: string;
  action: string;
  actionName: string;
  actionType: 'read' | 'write';
  description: string | null;
};

type Capability = {
  key: string;
  specialistId: string;
  direction: 'read' | 'write';
  label: string;
  description: string;
  recommendedMode?: 'approve' | 'auto';
  candidates: { app: string; appName: string; action: string; actionName: string; configFields: { key: string; label: string; required: boolean }[] }[];
  binding: {
    app: string;
    appName: string;
    action: string;
    actionName: string;
    config: Record<string, string | number | boolean | null>;
    boundAt: string;
  } | null;
  policy: { mode: 'off' | 'approve' | 'auto'; dailyBudget: number; updatedAt: string | null };
  /** Only on CALLIE's missed-call text-back. */
  textBack?: TextBackSettings;
};

type TextBackSettings = {
  messagingRegistered: boolean;
  registeredByName: string | null;
  registeredAt: string | null;
  windowHours: number;
  windowChoices: number[];
};

const CALLIE_TEXTBACK_KEY = 'callie.sms.send';

type Execution = {
  id: string;
  specialistId: string;
  capability: string;
  direction: 'read' | 'write';
  zapierApp: string;
  zapierAction: string;
  state: string;
  detail: string;
  errorCode: string | null;
  requestSummary: Record<string, unknown>;
  resultSummary: Record<string, unknown>;
  createdAt: string;
  completedAt: string | null;
};

const EMPTY_STATUS: ZapierStatus = {
  configured: false,
  provisioning: 'unassigned',
  connectionFingerprint: null,
  connected: false,
  serverMode: null,
  toolCount: null,
  connectedAt: null,
  lastUsedAt: null,
  lastErrorAt: null,
  lastErrorCode: null,
};

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/v1${path}`, {
    credentials: 'include',
    cache: 'no-store',
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    ...init,
  });
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `Request failed (${response.status})`);
  return body;
}

const STATE_LABEL: Record<string, string> = {
  pending_approval: 'Needs approval',
  executing: 'Running',
  succeeded: 'Done',
  failed: 'Failed',
  blocked: 'Blocked',
  indeterminate: 'Needs reconciliation',
  rejected: 'Rejected',
};

type ZapierConnectedAppsCardProps = {
  canManage: boolean;
};

export function ZapierConnectedAppsCard({ canManage }: ZapierConnectedAppsCardProps) {
  const { toast } = useToast();
  const [status, setStatus] = useState<ZapierStatus | null>(null);
  const [capabilities, setCapabilities] = useState<Capability[]>([]);
  const [executions, setExecutions] = useState<Execution[]>([]);
  const [actions, setActions] = useState<LiveAction[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionsLoading, setActionsLoading] = useState(false);
  const [actionsError, setActionsError] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const loadGeneration = useRef(0);
  const actionGeneration = useRef(0);
  const connectedRef = useRef(false);
  const versionRef = useRef<string | null>(null);
  const mutationRef = useRef(false);
  const active = useRef(false);

  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      ++loadGeneration.current;
      ++actionGeneration.current;
    };
  }, []);

  const load = useCallback(async () => {
    if (!active.current) return;
    const generation = ++loadGeneration.current;
    setLoading(true);
    try {
      const [nextStatus, nextCapabilities, nextExecutions] = await Promise.all([
        api<ZapierStatus>('/integrations/zapier'),
        api<{ capabilities: Capability[] }>('/integrations/zapier/capabilities'),
        api<{ executions: Execution[] }>('/integrations/zapier/executions?limit=25'),
      ]);
      if (generation !== loadGeneration.current) return;
      // Defensive: an unexpected payload shape must degrade to "nothing yet",
      // never crash the Settings page.
      setStatus(nextStatus && typeof nextStatus.configured === 'boolean' ? nextStatus : { ...EMPTY_STATUS });
      connectedRef.current = Boolean(nextStatus?.connected);
      const version = nextStatus?.connectionFingerprint ?? null;
      if (!nextStatus?.connected || version !== versionRef.current) {
        ++actionGeneration.current;
        setActions(null);
        setActionsLoading(false);
        setActionsError(false);
      }
      versionRef.current = version;
      setCapabilities(Array.isArray(nextCapabilities?.capabilities) ? nextCapabilities.capabilities : []);
      setExecutions(Array.isArray(nextExecutions?.executions) ? nextExecutions.executions : []);
      setLoadError(false);
    } catch (error) {
      if (generation !== loadGeneration.current) return;
      setLoadError(true);
      toast({ title: error instanceof Error ? error.message : 'Could not load Zapier Connected Apps', variant: 'destructive' });
    } finally {
      if (generation === loadGeneration.current) setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadActions = useCallback(async () => {
    if (!canManage || !connectedRef.current) return;
    const generation = ++actionGeneration.current;
    setActionsLoading(true);
    setActionsError(false);
    try {
      const response = await api<{ actions: LiveAction[] }>('/integrations/zapier/actions');
      if (generation !== actionGeneration.current || !connectedRef.current) return;
      setActions(Array.isArray(response?.actions) ? response.actions : []);
    } catch (error) {
      if (generation !== actionGeneration.current || !connectedRef.current) return;
      setActions(null);
      setActionsError(true);
      toast({ title: error instanceof Error ? error.message : 'Could not list Zapier actions', variant: 'destructive' });
    } finally {
      if (generation === actionGeneration.current) setActionsLoading(false);
    }
  }, [canManage, toast]);

  useEffect(() => {
    if (status?.connected && canManage) void loadActions();
  }, [status?.connected, status?.connectionFingerprint, canManage, loadActions]);

  const disconnect = async () => {
    if (mutationRef.current || !canManage) return;
    if (!window.confirm('Disconnect Zapier? Every specialist capability switches off immediately.')) return;
    mutationRef.current = true;
    connectedRef.current = false;
    ++actionGeneration.current;
    ++loadGeneration.current;
    setActionsLoading(false);
    setBusy('disconnect');
    try {
      await api('/integrations/zapier', { method: 'DELETE' });
      if (!active.current) return;
      toast({ title: 'Zapier disconnected' });
      setActions(null);
      await load();
    } catch (error) {
      if (!active.current) return;
      toast({ title: error instanceof Error ? error.message : 'Could not disconnect Zapier', variant: 'destructive' });
      await load();
    } finally {
      mutationRef.current = false;
      setBusy(null);
    }
  };

  const setPolicy = async (capability: Capability, mode: Capability['policy']['mode'], dailyBudget?: number) => {
    if (mutationRef.current || !canManage || !connectedRef.current) return;
    mutationRef.current = true;
    setBusy(`policy:${capability.key}`);
    try {
      await api(`/integrations/zapier/capabilities/${capability.key}/policy`, {
        method: 'PUT',
        body: JSON.stringify({ mode, dailyBudget: dailyBudget ?? capability.policy.dailyBudget }),
      });
      await load();
    } catch (error) {
      if (!active.current) return;
      toast({ title: error instanceof Error ? error.message : 'Could not update the policy', variant: 'destructive' });
    } finally {
      mutationRef.current = false;
      setBusy(null);
    }
  };

  const setTextBack = async (body: { messagingRegistered: boolean; windowHours?: number }) => {
    if (mutationRef.current || !canManage) return;
    mutationRef.current = true;
    setBusy('textback');
    try {
      await api('/integrations/zapier/callie/text-back-settings', { method: 'PUT', body: JSON.stringify(body) });
      if (!active.current) return;
      toast({ title: body.messagingRegistered ? 'Text-back settings saved' : 'Registration unconfirmed · missed-call text-back is Off' });
      await load();
    } catch (error) {
      if (!active.current) return;
      toast({ title: error instanceof Error ? error.message : 'Could not save text-back settings', variant: 'destructive' });
    } finally {
      mutationRef.current = false;
      setBusy(null);
    }
  };

  const setPollInterval = async (minutes: number) => {
    if (mutationRef.current || !canManage || !connectedRef.current) return;
    mutationRef.current = true;
    setBusy('poll');
    try {
      await api('/integrations/zapier/poll-interval', { method: 'PUT', body: JSON.stringify({ minutes }) });
      await load();
    } catch (error) {
      if (!active.current) return;
      toast({ title: error instanceof Error ? error.message : 'Could not update the sync interval', variant: 'destructive' });
    } finally {
      mutationRef.current = false;
      setBusy(null);
    }
  };

  const unbind = async (capability: Capability) => {
    if (mutationRef.current || !canManage || !connectedRef.current) return;
    mutationRef.current = true;
    setBusy(`bind:${capability.key}`);
    try {
      await api(`/integrations/zapier/capabilities/${capability.key}/binding`, { method: 'DELETE' });
      await load();
    } catch (error) {
      if (!active.current) return;
      toast({ title: error instanceof Error ? error.message : 'Could not remove the binding', variant: 'destructive' });
    } finally {
      mutationRef.current = false;
      setBusy(null);
    }
  };

  const decide = async (execution: Execution, decision: 'approve' | 'reject') => {
    if (mutationRef.current || !canManage) return;
    mutationRef.current = true;
    setBusy(`decide:${execution.id}`);
    try {
      await api(`/integrations/zapier/executions/${execution.id}/${decision}`, { method: 'POST', body: JSON.stringify({}) });
      if (!active.current) return;
      toast({ title: decision === 'approve' ? 'Action approved' : 'Action rejected' });
      await load();
    } catch (error) {
      if (!active.current) return;
      toast({ title: error instanceof Error ? error.message : 'Could not update the action', variant: 'destructive' });
    } finally {
      mutationRef.current = false;
      setBusy(null);
    }
  };

  const pending = executions.filter((execution) => execution.state === 'pending_approval');

  return (
    <Card>
      <CardHeader>
        <CardTitle>Zapier Connected Apps</CardTitle>
        <CardDescription>
          MogulForge sets up your app connection. Your team chooses which flows may run.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {loadError && <Alert variant="destructive"><AlertTitle>Could not refresh Zapier setup</AlertTitle><AlertDescription>Try refreshing again. Previously loaded settings may be out of date.<Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>Retry setup</Button></AlertDescription></Alert>}
        {loading && !status ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Checking Zapier…</div>
        ) : !status ? null : (
          <>
            <div className="flex flex-wrap items-center gap-3">
              <Badge variant={status.connected ? 'default' : 'secondary'}>
                {status.provisioning === 'legacy' ? 'Connection needs review' :
                  status.connected && status.provisioning === 'mogulforge' ? 'Managed by MogulForge' :
                  status.connectionFingerprint ? 'Disconnected' : 'Awaiting MogulForge setup'}
              </Badge>
              <div className="flex w-full flex-wrap gap-2 sm:ml-auto sm:w-auto">
                <Button variant="outline" size="sm" onClick={() => void load()} disabled={busy !== null || loading}><RefreshCw className="mr-2 h-4 w-4" />Refresh</Button>
                {canManage && status.connected && (
                  <Button variant="outline" size="sm" onClick={() => void disconnect()} disabled={busy !== null}>Disconnect</Button>
                )}
              </div>
            </div>
            {status.provisioning === 'legacy' && (
              <p className="text-sm text-muted-foreground">Ask MogulForge to review this existing connection.</p>
            )}
            {status.connected && status.monthlyActionLimit === 0 && (
              <p className="text-sm text-muted-foreground">MogulForge has paused connected app actions for your company. Contact MogulForge to review your setup.</p>
            )}
            {!status.connected && <p className="text-sm text-muted-foreground">Contact MogulForge to connect your apps.</p>}
            {status.connected && <p className="text-sm text-muted-foreground">Choose a supported flow and fill in its required settings. Saving the flow sets its policy to Off until you choose when it may run.</p>}
            {!canManage && <p className="text-sm text-muted-foreground">An owner or administrator can configure flows and choose policies. You can review the current setup here.</p>}

            {status.connected && status.pollIntervalMinutes && status.pollIntervalChoices?.length ? (
              <div className="space-y-1">
                <Label htmlFor="zapier-poll-interval">Automatic sync interval</Label>
                <select
                  id="zapier-poll-interval"
                  className="h-10 w-full max-w-xs rounded-md border border-input bg-background px-3 text-sm"
                  value={status.pollIntervalMinutes}
                  disabled={!canManage || busy !== null}
                  onChange={(event) => void setPollInterval(Number(event.target.value))}
                >
                  {status.pollIntervalChoices.map((minutes) => <option key={minutes} value={minutes}>{pollLabel(minutes)}</option>)}
                </select>
                <p className="text-xs text-muted-foreground">How often GrowthOS checks connected apps for leads, reviews, calls and customer email replies.</p>
              </div>
            ) : null}

            {pending.length > 0 && (
              <div className="space-y-2">
                <Label>Waiting for your approval</Label>
                {pending.map((execution) => (
                  <div key={execution.id} className="flex flex-wrap items-center gap-3 rounded-md border p-3">
                    <div className="min-w-0 flex-1 text-sm">
                      <div className="font-medium">{execution.specialistId.toUpperCase()} · {execution.capability}</div>
                      <div className="truncate text-muted-foreground">
                        {Object.entries(execution.requestSummary).filter(([key]) => key !== 'appointmentReminderScheduledActionId').map(([key, value]) => `${key}: ${String(value)}`).join(' · ') || execution.detail}
                      </div>
                    </div>
                    <Button size="sm" onClick={() => void decide(execution, 'approve')} disabled={busy !== null || !canManage}>
                      <CheckCircle2 className="mr-2 h-4 w-4" />Approve
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => void decide(execution, 'reject')} disabled={busy !== null || !canManage}>
                      <XCircle className="mr-2 h-4 w-4" />Reject
                    </Button>
                  </div>
                ))}
              </div>
            )}

            <div className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Label>Specialist capabilities</Label>
                {canManage && status.connected && (
                  <Button variant="outline" size="sm" onClick={() => void loadActions()} disabled={busy !== null || actionsLoading}>
                    {actionsLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                    {actions ? 'Reload enabled actions' : 'Load enabled actions'}
                  </Button>
                )}
              </div>
              {actionsLoading && <p role="status" className="text-sm text-muted-foreground">Checking your enabled actions…</p>}
              {actionsError && <Alert variant="destructive"><AlertTitle>Could not load available actions</AlertTitle><AlertDescription>Try reloading. Contact MogulForge if the connection is still unavailable.</AlertDescription></Alert>}
              {status.serverMode === 'managed' && <p className="text-sm text-muted-foreground">This fixed-tool connection cannot configure these specialist flows. Reconnect using Zapier’s app/action discovery setup so it exposes the supported apps and actions below. Contact your operator if your account only offers fixed tools.</p>}
              {capabilities.map((capability) => (
                <CapabilityRow
                  key={JSON.stringify([capability.key, status.connectionFingerprint])}
                  capability={capability}
                  actions={actionsError || actionsLoading ? null : actions}
                  canManage={canManage && status.connected}
                  busy={busy}
                  onBound={load}
                  onUnbind={() => void unbind(capability)}
                  onPolicy={(mode, budget) => void setPolicy(capability, mode, budget)}
                  onTextBack={(body) => void setTextBack(body)}
                  canManageSettings={canManage}
                  onSaving={(saving) => { mutationRef.current = saving; setBusy(saving ? `bind:${capability.key}` : null); }}
                />
              ))}
            </div>

            <ZapierFlowActions capabilities={capabilities} canManage={canManage && status.connected} disabled={busy !== null} onBusyChange={saving => { mutationRef.current = saving; setBusy(saving ? 'flow' : null); }} onComplete={load} />

            {executions.length > 0 && (
              <div className="space-y-2">
                <Label>Recent actions</Label>
                <div className="divide-y rounded-md border text-sm">
                  {executions.slice(0, 12).map((execution) => (
                    <div key={execution.id} className="flex flex-wrap items-center gap-3 p-2">
                      <Badge variant={execution.state === 'succeeded' ? 'default' : execution.state === 'pending_approval' ? 'secondary' : 'outline'}>
                        {STATE_LABEL[execution.state] ?? execution.state}
                      </Badge>
                      <span className="font-medium">{execution.specialistId.toUpperCase()}</span>
                      <span className="text-muted-foreground">{execution.capability}</span>
                      <span className="ml-auto text-xs text-muted-foreground">{new Date(execution.createdAt).toLocaleString()}</span>
                      {execution.detail && <div className="basis-full text-xs text-muted-foreground">{execution.detail}</div>}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

type CapabilityRowProps = {
  capability: Capability;
  actions: LiveAction[] | null;
  canManage: boolean;
  busy: string | null;
  onBound: () => Promise<void>;
  onUnbind: () => void;
  onPolicy: (mode: Capability['policy']['mode'], dailyBudget?: number) => void;
  onSaving: (saving: boolean) => void;
  onTextBack?: (body: { messagingRegistered: boolean; windowHours?: number }) => void;
  /** Settings managers may confirm registration even before Zapier is connected. */
  canManageSettings?: boolean;
};

function CapabilityRow({ capability, actions, canManage, busy, onBound, onUnbind, onPolicy, onSaving, onTextBack, canManageSettings = canManage }: CapabilityRowProps) {
  const { toast } = useToast();
  const [selected, setSelected] = useState<string>(() => capability.binding ? `${capability.binding.app}::${capability.binding.action}` : '');
  const [config, setConfig] = useState<Record<string, string>>(() => Object.fromEntries(Object.entries(capability.binding?.config ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === 'string')));
  const [saving, setSaving] = useState(false);
  const id = useId();
  useEffect(() => {
    if (!canManage) { setSelected(''); setConfig({}); }
  }, [canManage]);

  const matches = (actions ?? []).filter((action) =>
    action.actionType === capability.direction && capability.candidates.some(
      (candidate) =>
        (candidate.app === action.app || candidate.appName.toLowerCase() === action.appName.toLowerCase()) &&
        (candidate.action === action.action || candidate.actionName.toLowerCase() === action.actionName.toLowerCase()),
    ),
  );
  const chosen = matches.find((action) => `${action.app}::${action.action}` === selected) ?? null;
  const candidate = chosen
    ? capability.candidates.find(
        (item) =>
          (item.app === chosen.app || item.appName.toLowerCase() === chosen.appName.toLowerCase()) &&
          (item.action === chosen.action || item.actionName.toLowerCase() === chosen.actionName.toLowerCase()),
      ) ?? null
    : null;
  const missingFields = candidate?.configFields.filter(field => field.required && !config[field.key]?.trim()) ?? [];
  const configured = capability.binding && capability.candidates.some(item =>
    (item.app === capability.binding?.app || item.appName.toLowerCase() === capability.binding?.appName.toLowerCase()) &&
    (item.action === capability.binding?.action || item.actionName.toLowerCase() === capability.binding?.actionName.toLowerCase()) &&
    item.configFields.every(field => !field.required || (typeof capability.binding?.config[field.key] === 'string' && String(capability.binding.config[field.key]).trim())));

  const bind = async () => {
    if (!chosen || missingFields.length || busy !== null || !canManage || saving) return;
    setSaving(true);
    onSaving(true);
    try {
      await api(`/integrations/zapier/capabilities/${capability.key}/binding`, {
        method: 'PUT',
        body: JSON.stringify({ app: chosen.app, action: chosen.action, config }),
      });
      toast({ title: `${capability.specialistId.toUpperCase()} flow saved · choose its policy to enable it` });
      setSelected('');
      setConfig({});
      await onBound();
    } catch (error) {
      toast({ title: error instanceof Error ? error.message : 'Could not bind the capability', variant: 'destructive' });
    } finally {
      setSaving(false);
      onSaving(false);
    }
  };

  return (
    <div className="min-w-0 space-y-3 rounded-md border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline">{capability.specialistId.toUpperCase()}</Badge>
        <span className="font-medium">{capability.label}</span>
        <Badge variant="secondary">{capability.direction}</Badge>
        <span className="text-xs text-muted-foreground sm:ml-auto">
          {capability.binding ? `${capability.binding.appName} · ${capability.binding.actionName}` : 'Needs setup'}
        </span>
      </div>
      <p className="text-sm text-muted-foreground">{capability.description}</p>
      <p className="break-words text-xs text-muted-foreground">Supported: {capability.candidates.map(item => `${item.appName} → ${item.actionName}`).join('; ')}</p>
      {CUSTOMER_TEXT_KEYS.includes(capability.key) && (
        <p className="text-xs text-muted-foreground">Texts go only to customers who agreed to receive them and end with "Reply STOP to opt out." Replies and STOP requests arrive in your phone app. Set up "Log customer text replies and opt-outs" so GrowthOS records STOPs too; until then, mark a customer who opts out do not text on their record.</p>
      )}
      {capability.key === CALLIE_TEXTBACK_KEY && capability.textBack && (
        <TextBackControls id={id} settings={capability.textBack} canManage={canManageSettings} disabled={busy !== null || saving} onSave={(body) => onTextBack?.(body)} />
      )}
      {CUSTOMER_EMAIL_KEYS.includes(capability.key) && (
        <p className="text-xs text-muted-foreground">Sends from your own mailbox as plain text, only to customers who can be emailed. "Accepted" means your mail app took the message, not that it was delivered. Replies arrive in your mailbox; customer email reply logging can record them here.</p>
      )}
      <p className="text-xs text-muted-foreground">{!capability.binding ? 'Select and configure a supported action to set up this flow.' : !configured ? 'Required settings are missing. Save a complete binding before choosing a policy.' : capability.policy.mode === 'off' ? 'Configured · Off. Choose a policy to allow this flow.' : capability.policy.dailyBudget === 0 ? 'Paused · Daily limit is 0.' : 'Configured · Policy enabled. Provider execution has not been verified by this setup.'}</p>
      {CUSTOMER_TEXT_KEYS.includes(capability.key) && capability.recommendedMode === 'auto' && (
        <p className="text-xs text-muted-foreground">Recommended: Automatic. A team member taps Send for one customer with fixed wording, so that tap is the approval. Choose Approve each to have the office review every text first.</p>
      )}
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <Label htmlFor={`${id}-policy`} className="text-xs">Policy</Label>
          <Select
            value={capability.policy.mode}
            onValueChange={(value) => onPolicy(value as Capability['policy']['mode'])}
            disabled={!canManage || !configured || busy !== null || saving || (capability.key === CALLIE_TEXTBACK_KEY && !capability.textBack?.messagingRegistered)}
          >
            <SelectTrigger id={`${id}-policy`} className="w-40 max-w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="off">Off</SelectItem>
              <SelectItem value="approve">{capability.direction === 'write' ? 'Approve each' : 'On'}</SelectItem>
              <SelectItem value="auto">{capability.direction === 'write' ? 'Automatic' : 'On (scheduled)'}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor={`${id}-budget`} className="text-xs">Daily action limit</Label>
          <Input
            id={`${id}-budget`}
            type="number"
            min={0}
            max={500}
            className="w-28"
            defaultValue={capability.policy.dailyBudget}
            disabled={!canManage || !capability.binding || busy !== null || saving}
            onBlur={(event) => {
              const value = Number(event.target.value);
              if (event.target.value.trim() && Number.isInteger(value) && value >= 0 && value <= 500 && value !== capability.policy.dailyBudget) onPolicy(capability.policy.mode, value);
            }}
          />
        </div>
        {capability.binding && canManage && (
          <Button variant="outline" size="sm" onClick={onUnbind} disabled={busy !== null}>Unbind</Button>
        )}
      </div>
      {canManage && actions && (
        <div className="space-y-2 rounded-md bg-muted/40 p-3">
          {matches.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              Contact MogulForge to make a supported app available for this flow. Reload enabled actions after setup.
            </p>
          ) : (
            <div className="flex flex-wrap items-end gap-3">
              <div className="w-full min-w-0 space-y-1 sm:w-72">
                <Label htmlFor={`${id}-action`} className="text-xs">{capability.binding ? 'Replace action' : 'Choose action'}</Label>
                <Select value={selected} disabled={busy !== null || saving} onValueChange={value => {
                  setSelected(value);
                  const action = matches.find(item => `${item.app}::${item.action}` === value);
                  const sameBinding = action && capability.binding && (action.app === capability.binding.app || action.appName === capability.binding.appName) && (action.action === capability.binding.action || action.actionName === capability.binding.actionName);
                  setConfig(Object.fromEntries(Object.entries(capability.binding?.config ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && (Boolean(sameBinding) || entry[0].startsWith('crew_phone_')))));
                }}>
                  <SelectTrigger id={`${id}-action`} className="w-full min-w-0 [&>span]:truncate"><SelectValue placeholder="Choose an enabled action" /></SelectTrigger>
                  <SelectContent>
                    {matches.map((action) => (
                      <SelectItem key={`${action.app}::${action.action}`} value={`${action.app}::${action.action}`}>
                        {action.appName} → {action.actionName}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {candidate?.configFields.map((field) => (
                <div key={field.key} className="w-full space-y-1 sm:w-56">
                  <Label htmlFor={`${id}-${field.key}`} className="text-xs">{field.label}{field.required ? ' *' : ''}</Label>
                  <Input
                    id={`${id}-${field.key}`}
                    required={field.required}
                    disabled={busy !== null || saving}
                    className="w-full"
                    value={config[field.key] ?? ''}
                    onChange={(event) => setConfig((current) => ({ ...current, [field.key]: event.target.value }))}
                  />
                </div>
              ))}
              {capability.key === 'sched.sms.send' && (
                <CrewPhones config={config} onChange={setConfig} disabled={busy !== null || saving} />
              )}
              <Button size="sm" onClick={() => void bind()} disabled={!chosen || missingFields.length > 0 || saving || busy !== null}>
                {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}Save flow
              </Button>
              {missingFields.length > 0 && <p className="basis-full text-xs text-muted-foreground">Complete required settings: {missingFields.map(field => field.label).join(', ')}.</p>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Crew phone numbers live in the SCHED binding as `crew_phone_<userId>`. */
function CrewPhones({ config, onChange, disabled }: { config: Record<string, string>; onChange: (next: Record<string, string>) => void; disabled: boolean }) {
  const [userId, setUserId] = useState('');
  const [phone, setPhone] = useState('');
  const [members, setMembers] = useState<{ id: string; name: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const id = useId();
  const entries = Object.entries(config).filter(([key]) => key.startsWith('crew_phone_'));
  useEffect(() => {
    let active = true;
    setLoading(true); setError(false);
    void api<{ id: string; firstName: string | null; lastName: string | null; email: string; isActive: boolean; operationallyEligible: boolean }[]>('/users').then(users => {
      if (!Array.isArray(users)) throw new Error('Invalid member list');
      if (active) setMembers(users.filter(user => user.isActive && user.operationallyEligible).map(user => ({ id: user.id, name: [user.firstName, user.lastName].filter(Boolean).join(' ') || user.email })));
    }).catch(() => { if (active) setError(true); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [attempt]);
  const memberName = (key: string) => members.find(member => member.id === key.slice('crew_phone_'.length))?.name ?? 'Unavailable team member';
  const validPhone = /^\+[1-9]\d{6,14}$/.test(phone.trim());
  return (
    <div className="basis-full space-y-2">
      <p className="text-xs font-medium">Crew phone numbers</p>
      {entries.map(([key, value]) => (
        <div key={key} className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground"><span>{memberName(key)} → {value}</span><Button type="button" size="sm" variant="outline" aria-label={`Remove phone for ${memberName(key)}`} disabled={disabled} onClick={() => { const next = { ...config }; delete next[key]; onChange(next); }}>Remove</Button></div>
      ))}
      {error && <div><p role="alert" className="text-xs">Could not load crew members.</p><Button type="button" size="sm" variant="outline" disabled={disabled || loading} onClick={() => setAttempt(value => value + 1)}>Retry crew members</Button></div>}
      {!loading && !error && members.length === 0 && <p className="text-xs text-muted-foreground">No active, operationally eligible team members are available. Ask an administrator to review the team.</p>}
      <div className="flex flex-wrap gap-2">
        <div className="w-full min-w-0 space-y-1 sm:w-64"><Label htmlFor={`${id}-member`} className="text-xs">Crew member</Label><select id={`${id}-member`} className="h-10 w-full min-w-0 rounded-md border border-input bg-background px-3 text-sm" disabled={disabled || loading || error} value={userId} onChange={(event) => setUserId(event.target.value)}><option value="">{loading ? 'Loading crew members…' : 'Choose a crew member'}</option>{members.map(member => <option key={member.id} value={member.id}>{member.name}</option>)}</select></div>
        <div className="w-full space-y-1 sm:w-44"><Label htmlFor={`${id}-phone`} className="text-xs">Mobile phone</Label><Input id={`${id}-phone`} type="tel" disabled={disabled} placeholder="+14045551234" value={phone} onChange={(event) => setPhone(event.target.value)} /></div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={disabled || loading || error || !members.some(member => member.id === userId) || !validPhone}
          onClick={() => {
            onChange({ ...config, [`crew_phone_${userId.trim()}`]: phone.trim() });
            setUserId('');
            setPhone('');
          }}
        >
          Add crew phone
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">Include the country code, for example +14045551234. Changes apply when you save this flow.</p>
    </div>
  );
}

const TEXTBACK_HOURS_LABEL = (hours: number) => hours % 24 === 0 ? `${hours / 24 === 1 ? '24 hours' : `${hours / 24} days`}` : `${hours} hours`;

/**
 * CALLIE missed-call text-back: the registration confirmation (required before
 * the policy can leave Off) and the one-text-per-caller window.
 */
function TextBackControls({ id, settings, canManage, disabled, onSave }: { id: string; settings: TextBackSettings; canManage: boolean; disabled: boolean; onSave: (body: { messagingRegistered: boolean; windowHours?: number }) => void }) {
  const choices = settings.windowChoices.includes(settings.windowHours) ? settings.windowChoices : [...settings.windowChoices, settings.windowHours].sort((a, b) => a - b);
  return (
    <div className="space-y-3 rounded-md border border-dashed p-3">
      <div className="flex items-start gap-2">
        <Checkbox
          id={`${id}-registered`}
          checked={settings.messagingRegistered}
          disabled={!canManage || disabled}
          aria-required="true"
          aria-describedby={`${id}-registered-help`}
          onCheckedChange={(checked) => onSave({ messagingRegistered: checked === true })}
          className="mt-0.5"
        />
        <div className="min-w-0 space-y-1">
          <Label htmlFor={`${id}-registered`} className="text-sm">Our business texting is registered (required)</Label>
          <p id={`${id}-registered-help`} className="text-xs text-muted-foreground">
            Tick this only if the number CALLIE texts from has an approved A2P 10DLC brand and campaign (Twilio) or completed Quo business-texting registration; GrowthOS records who confirmed it and when, but cannot check it for you.
          </p>
          <p className="text-xs text-muted-foreground">
            {settings.messagingRegistered && settings.registeredAt
              ? `Confirmed by ${settings.registeredByName ?? 'a team member'} on ${new Date(settings.registeredAt).toLocaleString()}.`
              : 'Not confirmed · missed-call text-back stays Off until it is.'}
          </p>
        </div>
      </div>
      <div className="space-y-1">
        <Label htmlFor={`${id}-window`} className="text-xs">Text-back window</Label>
        <select
          id={`${id}-window`}
          className="h-10 w-full max-w-xs rounded-md border border-input bg-background px-3 text-sm"
          value={settings.windowHours}
          disabled={!canManage || disabled}
          onChange={(event) => onSave({ messagingRegistered: settings.messagingRegistered, windowHours: Number(event.target.value) })}
        >
          {choices.map((hours) => <option key={hours} value={hours}>{`At most one text per caller every ${TEXTBACK_HOURS_LABEL(hours)}`}</option>)}
        </select>
      </div>
      <p className="text-xs text-muted-foreground">
        Built to support texting rules, not a guarantee of legal compliance: CALLIE sends one informational reply that names your business and ends with "Reply STOP to opt out", only after a recorded missed inbound call, only between 8am and 9pm in your company time zone (a caller's own time zone is not known), and never to a number that opted out, is suppressed, is a landline or is not a valid US mobile number. Each skip is shown in CALLIE's text-back activity on Calls. A missed call is not permission for review requests, reminders or marketing texts.
      </p>
    </div>
  );
}
