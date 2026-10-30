import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { CheckCircle2, Loader2, RefreshCw, ShieldAlert, XCircle } from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { ZapierFlowActions } from './zapier-flow-actions';

/**
 * Zapier Connected Apps. The contractor connects their own Zapier account via
 * the Zapier MCP Embed; GrowthOS stores the resulting per-organization server
 * URL server-side. Every specialist capability is bound by the contractor to
 * one enabled action and governed by an off / approve / auto policy.
 */

const CUSTOMER_TEXT_KEYS = ['appt.sms.send', 'maintain.sms.send', 'callie.sms.send'];

type ZapierStatus = {
  configured: boolean;
  embedId: string | null;
  connected: boolean;
  serverMode: 'agentic' | 'managed' | 'unknown' | null;
  toolCount: number | null;
  connectedAt: string | null;
  lastUsedAt: string | null;
  lastErrorAt: string | null;
  lastErrorCode: string | null;
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
};

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

const EMBED_SCRIPT = 'https://mcp.zapier.com/embed/v1/mcp.js';
const EMPTY_STATUS: ZapierStatus = {
  configured: false,
  embedId: null,
  connected: false,
  serverMode: null,
  toolCount: null,
  connectedAt: null,
  lastUsedAt: null,
  lastErrorAt: null,
  lastErrorCode: null,
};

declare module 'react' {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace JSX {
    interface IntrinsicElements {
      'zapier-mcp': React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> & {
        'embed-id'?: string;
        width?: string;
        height?: string;
        'sign-up-email'?: string;
        'sign-up-first-name'?: string;
        'sign-up-last-name'?: string;
      };
    }
  }
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/v1${path}`, {
    credentials: 'include',
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
  signUp: { email: string | null; firstName: string | null; lastName: string | null };
  canManage: boolean;
};

export function ZapierConnectedAppsCard({ signUp, canManage }: ZapierConnectedAppsCardProps) {
  const { toast } = useToast();
  const [status, setStatus] = useState<ZapierStatus | null>(null);
  const [capabilities, setCapabilities] = useState<Capability[]>([]);
  const [executions, setExecutions] = useState<Execution[]>([]);
  const [actions, setActions] = useState<LiveAction[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [showEmbed, setShowEmbed] = useState(false);
  const [scriptAttempt, setScriptAttempt] = useState(0);
  const [scriptError, setScriptError] = useState(false);
  const [actionsLoading, setActionsLoading] = useState(false);
  const [actionsError, setActionsError] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const embedRef = useRef<HTMLElement | null>(null);
  const loadGeneration = useRef(0);
  const actionGeneration = useRef(0);
  const connectedRef = useRef(false);
  const mutationRef = useRef(false);
  const embedGeneration = useRef(0);

  useEffect(() => () => { ++loadGeneration.current; ++actionGeneration.current; }, []);

  const load = useCallback(async () => {
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
      if (!nextStatus?.connected) { ++actionGeneration.current; setActions(null); setActionsLoading(false); }
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
  }, [status?.connected, canManage, loadActions]);

  // Load the Zapier embed only when the contractor opens it; register the
  // per-organization server URL the moment the embed reports it.
  useEffect(() => {
    if (!showEmbed || !status?.embedId) return;
    let cancelled = false;
    const generation = ++embedGeneration.current;
    const controller = new AbortController();
    let registering = false;
    let toolsChangedDuringRegistration = false;
    const ensureScript = () =>
      new Promise<void>((resolve, reject) => {
        const existing = document.querySelector<HTMLScriptElement>(`script[src="${EMBED_SCRIPT}"]`);
        if (existing?.dataset.loaded === 'true' || customElements.get('zapier-mcp')) {
          resolve();
          return;
        }
        const script = existing ?? document.createElement('script');
        script.src = EMBED_SCRIPT;
        script.async = true;
        script.addEventListener('load', () => { script.dataset.loaded = 'true'; resolve(); }, { once: true });
        script.addEventListener('error', () => { script.remove(); reject(new Error('Could not load the Zapier embed')); }, { once: true });
        if (!existing) document.head.appendChild(script);
      });
    const onServerUrl = async (event: Event) => {
      const serverUrl = (event as CustomEvent<{ serverUrl?: string }>).detail?.serverUrl;
      if (!serverUrl || cancelled || registering || mutationRef.current || !canManage) return;
      registering = true;
      mutationRef.current = true;
      setBusy('connect');
      try {
        const next = await api<ZapierStatus>('/integrations/zapier/server-url', {
          method: 'POST',
          body: JSON.stringify({ serverUrl }),
          signal: controller.signal,
        });
        if (cancelled) return;
        const alreadyConnected = connectedRef.current;
        connectedRef.current = next.connected;
        setStatus(next);
        toast({ title: 'Zapier connected' });
        await load();
        if (!cancelled && alreadyConnected) await loadActions();
      } catch (error) {
        if (cancelled) return;
        toast({ title: error instanceof Error ? error.message : 'Could not register the Zapier server', variant: 'destructive' });
      } finally {
        registering = false;
        if (generation === embedGeneration.current) {
          mutationRef.current = false;
          if (!cancelled) {
            setBusy(null);
            if (toolsChangedDuringRegistration) {
              toolsChangedDuringRegistration = false;
              void loadActions();
            }
          }
        }
      }
    };
    const onClose = () => { setShowEmbed(false); setBusy(null); };
    // Before registration this is intentionally deferred: registration always
    // discovers fresh actions, including changes made while it was in flight.
    const onToolsChanged = () => {
      if (registering) { toolsChangedDuringRegistration = true; return; }
      if (!cancelled && connectedRef.current) {
        void loadActions().then(() => { if (!cancelled && !registering) void load(); });
      }
    };
    setScriptError(false);
    void ensureScript().catch(() => { if (!cancelled) setScriptError(true); });
    const node = embedRef.current;
    node?.addEventListener('mcp-server-url', onServerUrl);
    node?.addEventListener('close-requested', onClose);
    node?.addEventListener('tools-changed', onToolsChanged);
    return () => {
      cancelled = true;
      controller.abort();
      if (registering && generation === embedGeneration.current) {
        ++embedGeneration.current;
        mutationRef.current = false;
        setBusy(null);
      }
      node?.removeEventListener('mcp-server-url', onServerUrl);
      node?.removeEventListener('close-requested', onClose);
      node?.removeEventListener('tools-changed', onToolsChanged);
    };
  }, [showEmbed, status?.embedId, load, loadActions, toast, canManage, scriptAttempt]);

  const disconnect = async () => {
    if (mutationRef.current || !canManage) return;
    if (!window.confirm('Disconnect Zapier? Every specialist capability switches off immediately.')) return;
    mutationRef.current = true;
    connectedRef.current = false;
    ++actionGeneration.current;
    ++loadGeneration.current;
    setActionsLoading(false);
    setShowEmbed(false);
    setBusy('disconnect');
    try {
      await api('/integrations/zapier', { method: 'DELETE' });
      toast({ title: 'Zapier disconnected' });
      setActions(null);
      await load();
    } catch (error) {
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
      toast({ title: error instanceof Error ? error.message : 'Could not update the policy', variant: 'destructive' });
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
      toast({ title: decision === 'approve' ? 'Action approved' : 'Action rejected' });
      await load();
    } catch (error) {
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
          Connect your apps to the supported specialist flows below. Use your own Zapier account and choose which flows may run.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {loadError && <Alert variant="destructive"><AlertTitle>Could not refresh Zapier setup</AlertTitle><AlertDescription>Try refreshing again. Previously loaded settings may be out of date.<Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>Retry setup</Button></AlertDescription></Alert>}
        {loading && !status ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Checking Zapier…</div>
        ) : !status ? null : !status.configured ? (
          <Alert>
            <ShieldAlert className="h-4 w-4" />
            <AlertTitle>Not available on this deployment</AlertTitle>
            <AlertDescription>
              The operator has not configured the Zapier MCP embed for GrowthOS yet. Ask your MogulForge contact to enable it.
            </AlertDescription>
          </Alert>
        ) : (
          <>
            <ol className="list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
              <li>Connect your own Zapier account.</li>
              <li>Add the app and enable its listed action in Zapier.</li>
              <li>Select a supported flow below and fill in its required settings.</li>
              <li>Save the flow, then choose its policy and daily limit.</li>
            </ol>
            <p className="text-sm text-muted-foreground">Connection alone does not enable a flow. Saving a binding switches that flow Off; choose its policy yourself. Discovering actions does not test whether they will run.</p>
            {!canManage && <p className="text-sm text-muted-foreground">Ask an owner or administrator with settings access to connect apps, configure flows and choose policies. You can review the current setup here.</p>}
            <div className="flex flex-wrap items-center gap-3">
              <Badge variant={status.connected ? 'default' : 'secondary'}>{status.connected ? 'Connected' : 'Not connected'}</Badge>
              {status.connected && status.toolCount !== null && (
                <span className="text-sm text-muted-foreground">{status.toolCount} Zapier tools available · {status.serverMode} mode</span>
              )}
              {status.lastErrorCode && (
                <span className="text-sm text-destructive">Last error: {status.lastErrorCode}</span>
              )}
              <div className="flex w-full flex-wrap gap-2 sm:ml-auto sm:w-auto">
                <Button variant="outline" size="sm" onClick={() => void load()} disabled={busy !== null || loading}><RefreshCw className="mr-2 h-4 w-4" />Refresh</Button>
                {canManage && !status.connected && (
                  <Button size="sm" onClick={() => setShowEmbed((value) => !value)} disabled={busy !== null}>
                    {showEmbed ? 'Hide Zapier' : 'Connect Zapier'}
                  </Button>
                )}
                {canManage && status.connected && (
                  <>
                    <Button variant="outline" size="sm" onClick={() => setShowEmbed((value) => !value)} disabled={busy !== null}>
                      {showEmbed ? 'Hide Zapier' : 'Manage apps in Zapier'}
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => void disconnect()} disabled={busy !== null}>Disconnect</Button>
                  </>
                )}
              </div>
            </div>

            {showEmbed && status.embedId && (
              <div className="min-w-0 overflow-hidden rounded-md border">
                {scriptError && <Alert variant="destructive"><AlertTitle>Zapier could not load</AlertTitle><AlertDescription>Check your connection and try again.<Button variant="outline" size="sm" onClick={() => setScriptAttempt(value => value + 1)}>Retry loading Zapier</Button></AlertDescription></Alert>}
                <zapier-mcp
                  ref={embedRef as React.RefObject<HTMLElement>}
                  embed-id={status.embedId}
                  width="100%"
                  height="640px"
                  sign-up-email={signUp.email ?? undefined}
                  sign-up-first-name={signUp.email ? signUp.firstName ?? 'GrowthOS' : undefined}
                  sign-up-last-name={signUp.email ? signUp.lastName ?? 'User' : undefined}
                />
              </div>
            )}

            {pending.length > 0 && (
              <div className="space-y-2">
                <Label>Waiting for your approval</Label>
                {pending.map((execution) => (
                  <div key={execution.id} className="flex flex-wrap items-center gap-3 rounded-md border p-3">
                    <div className="min-w-0 flex-1 text-sm">
                      <div className="font-medium">{execution.specialistId.toUpperCase()} · {execution.capability}</div>
                      <div className="truncate text-muted-foreground">
                        {Object.entries(execution.requestSummary).map(([key, value]) => `${key}: ${String(value)}`).join(' · ') || execution.detail}
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
              {actionsError && <Alert variant="destructive"><AlertTitle>Could not discover enabled actions</AlertTitle><AlertDescription>Check the app connection in Zapier, then reload enabled actions. Existing bindings have not been changed.</AlertDescription></Alert>}
              {status.serverMode === 'managed' && <p className="text-sm text-muted-foreground">This fixed-tool connection cannot configure these specialist flows. Reconnect using Zapier’s app/action discovery setup so it exposes the supported apps and actions below. Contact your operator if your account only offers fixed tools.</p>}
              {capabilities.map((capability) => (
                <CapabilityRow
                  key={capability.key}
                  capability={capability}
                  actions={actionsError || actionsLoading ? null : actions}
                  canManage={canManage && status.connected}
                  busy={busy}
                  onBound={load}
                  onUnbind={() => void unbind(capability)}
                  onPolicy={(mode, budget) => void setPolicy(capability, mode, budget)}
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
};

function CapabilityRow({ capability, actions, canManage, busy, onBound, onUnbind, onPolicy, onSaving }: CapabilityRowProps) {
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
        <p className="text-xs text-muted-foreground">Texts go only to customers who agreed to receive them and end with "Reply STOP to opt out." Replies and STOP requests arrive in your phone app, not GrowthOS. If a customer opts out, mark them do not text on their customer record.</p>
      )}
      <p className="text-xs text-muted-foreground">{!capability.binding ? 'Select and configure a supported action to set up this flow.' : !configured ? 'Required settings are missing. Save a complete binding before choosing a policy.' : capability.policy.mode === 'off' ? 'Configured · Off. Choose a policy to allow this flow.' : capability.policy.dailyBudget === 0 ? 'Paused · Daily limit is 0.' : 'Configured · Policy enabled. Provider execution has not been verified by this setup.'}</p>
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <Label htmlFor={`${id}-policy`} className="text-xs">Policy</Label>
          <Select
            value={capability.policy.mode}
            onValueChange={(value) => onPolicy(value as Capability['policy']['mode'])}
            disabled={!canManage || !configured || busy !== null || saving}
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
              None of your enabled Zapier actions match this flow yet. Open Manage apps in Zapier, connect one of the supported apps above and enable its listed action with {capability.direction} access. This page refreshes when Zapier reports a change; use Reload enabled actions if needed.
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
