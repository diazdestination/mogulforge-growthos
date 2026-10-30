import React, { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircle2, Loader2, RefreshCw, ShieldAlert, XCircle } from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';

/**
 * Zapier Connected Apps. The contractor connects their own Zapier account via
 * the Zapier MCP Embed; GrowthOS stores the resulting per-organization server
 * URL server-side. Every specialist capability is bound by the contractor to
 * one enabled action and governed by an off / approve / auto policy.
 */

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
  const embedRef = useRef<HTMLElement | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [nextStatus, nextCapabilities, nextExecutions] = await Promise.all([
        api<ZapierStatus>('/integrations/zapier'),
        api<{ capabilities: Capability[] }>('/integrations/zapier/capabilities'),
        api<{ executions: Execution[] }>('/integrations/zapier/executions?limit=25'),
      ]);
      // Defensive: an unexpected payload shape must degrade to "nothing yet",
      // never crash the Settings page.
      setStatus(nextStatus && typeof nextStatus.configured === 'boolean' ? nextStatus : { ...EMPTY_STATUS });
      setCapabilities(Array.isArray(nextCapabilities?.capabilities) ? nextCapabilities.capabilities : []);
      setExecutions(Array.isArray(nextExecutions?.executions) ? nextExecutions.executions : []);
    } catch (error) {
      toast({ title: error instanceof Error ? error.message : 'Could not load Zapier Connected Apps', variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadActions = useCallback(async () => {
    setBusy('actions');
    try {
      const response = await api<{ actions: LiveAction[] }>('/integrations/zapier/actions');
      setActions(Array.isArray(response?.actions) ? response.actions : []);
    } catch (error) {
      toast({ title: error instanceof Error ? error.message : 'Could not list Zapier actions', variant: 'destructive' });
    } finally {
      setBusy(null);
    }
  }, [toast]);

  // Load the Zapier embed only when the contractor opens it; register the
  // per-organization server URL the moment the embed reports it.
  useEffect(() => {
    if (!showEmbed || !status?.embedId) return;
    let cancelled = false;
    const ensureScript = () =>
      new Promise<void>((resolve, reject) => {
        if (document.querySelector(`script[src="${EMBED_SCRIPT}"]`)) {
          resolve();
          return;
        }
        const script = document.createElement('script');
        script.src = EMBED_SCRIPT;
        script.async = true;
        script.onload = () => resolve();
        script.onerror = () => reject(new Error('Could not load the Zapier embed'));
        document.head.appendChild(script);
      });
    const onServerUrl = async (event: Event) => {
      const serverUrl = (event as CustomEvent<{ serverUrl?: string }>).detail?.serverUrl;
      if (!serverUrl || cancelled) return;
      setBusy('connect');
      try {
        const next = await api<ZapierStatus>('/integrations/zapier/server-url', {
          method: 'POST',
          body: JSON.stringify({ serverUrl }),
        });
        setStatus(next);
        toast({ title: 'Zapier connected' });
        setShowEmbed(false);
        await load();
      } catch (error) {
        toast({ title: error instanceof Error ? error.message : 'Could not register the Zapier server', variant: 'destructive' });
      } finally {
        setBusy(null);
      }
    };
    const onClose = () => setShowEmbed(false);
    void ensureScript().catch((error: Error) => toast({ title: error.message, variant: 'destructive' }));
    const node = embedRef.current;
    node?.addEventListener('mcp-server-url', onServerUrl);
    node?.addEventListener('close-requested', onClose);
    return () => {
      cancelled = true;
      node?.removeEventListener('mcp-server-url', onServerUrl);
      node?.removeEventListener('close-requested', onClose);
    };
  }, [showEmbed, status?.embedId, load, toast]);

  const disconnect = async () => {
    if (!window.confirm('Disconnect Zapier? Every specialist capability switches off immediately.')) return;
    setBusy('disconnect');
    try {
      await api('/integrations/zapier', { method: 'DELETE' });
      toast({ title: 'Zapier disconnected' });
      setActions(null);
      await load();
    } catch (error) {
      toast({ title: error instanceof Error ? error.message : 'Could not disconnect Zapier', variant: 'destructive' });
    } finally {
      setBusy(null);
    }
  };

  const setPolicy = async (capability: Capability, mode: Capability['policy']['mode'], dailyBudget?: number) => {
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
      setBusy(null);
    }
  };

  const unbind = async (capability: Capability) => {
    setBusy(`bind:${capability.key}`);
    try {
      await api(`/integrations/zapier/capabilities/${capability.key}/binding`, { method: 'DELETE' });
      await load();
    } catch (error) {
      toast({ title: error instanceof Error ? error.message : 'Could not remove the binding', variant: 'destructive' });
    } finally {
      setBusy(null);
    }
  };

  const decide = async (execution: Execution, decision: 'approve' | 'reject') => {
    setBusy(`decide:${execution.id}`);
    try {
      await api(`/integrations/zapier/executions/${execution.id}/${decision}`, { method: 'POST', body: JSON.stringify({}) });
      toast({ title: decision === 'approve' ? 'Action approved' : 'Action rejected' });
      await load();
    } catch (error) {
      toast({ title: error instanceof Error ? error.message : 'Could not update the action', variant: 'destructive' });
    } finally {
      setBusy(null);
    }
  };

  const pending = executions.filter((execution) => execution.state === 'pending_approval');

  return (
    <Card>
      <CardHeader>
        <CardTitle>Zapier Connected Apps</CardTitle>
        <CardDescription>
          Give your specialists bounded hands in the apps you already use: SCOUT watches reviews and marketplace leads,
          APPT books onto your calendar, INVO sends issued invoices to accounting, CALLIE logs calls and texts back missed
          callers, SCHED texts crews their day sheet. Actions run through your own Zapier account, every write is logged,
          and nothing runs without a binding you chose and a policy you set.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {loading || !status ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Checking Zapier…</div>
        ) : !status.configured ? (
          <Alert>
            <ShieldAlert className="h-4 w-4" />
            <AlertTitle>Not available on this deployment</AlertTitle>
            <AlertDescription>
              The operator has not configured the Zapier MCP embed for GrowthOS yet. Ask your MogulForge contact to enable it.
            </AlertDescription>
          </Alert>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-3">
              <Badge variant={status.connected ? 'default' : 'secondary'}>{status.connected ? 'Connected' : 'Not connected'}</Badge>
              {status.connected && status.toolCount !== null && (
                <span className="text-sm text-muted-foreground">{status.toolCount} Zapier tools available · {status.serverMode} mode</span>
              )}
              {status.lastErrorCode && (
                <span className="text-sm text-destructive">Last error: {status.lastErrorCode}</span>
              )}
              <div className="ml-auto flex gap-2">
                <Button variant="outline" size="sm" onClick={() => void load()} disabled={busy !== null}><RefreshCw className="mr-2 h-4 w-4" />Refresh</Button>
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
                    <Button variant="destructive" size="sm" onClick={() => void disconnect()} disabled={busy !== null}>Disconnect</Button>
                  </>
                )}
              </div>
            </div>

            {showEmbed && status.embedId && (
              <div className="overflow-hidden rounded-md border">
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
              <div className="flex items-center justify-between">
                <Label>Specialist capabilities</Label>
                {canManage && status.connected && (
                  <Button variant="outline" size="sm" onClick={() => void loadActions()} disabled={busy !== null}>
                    {busy === 'actions' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                    {actions ? 'Reload enabled actions' : 'Load enabled actions'}
                  </Button>
                )}
              </div>
              {capabilities.map((capability) => (
                <CapabilityRow
                  key={capability.key}
                  capability={capability}
                  actions={actions}
                  canManage={canManage && status.connected}
                  busy={busy}
                  onBound={load}
                  onUnbind={() => void unbind(capability)}
                  onPolicy={(mode, budget) => void setPolicy(capability, mode, budget)}
                />
              ))}
            </div>

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
};

function CapabilityRow({ capability, actions, canManage, busy, onBound, onUnbind, onPolicy }: CapabilityRowProps) {
  const { toast } = useToast();
  const [selected, setSelected] = useState<string>('');
  const [config, setConfig] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  const matches = (actions ?? []).filter((action) =>
    capability.candidates.some(
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

  const bind = async () => {
    if (!chosen) return;
    setSaving(true);
    try {
      await api(`/integrations/zapier/capabilities/${capability.key}/binding`, {
        method: 'PUT',
        body: JSON.stringify({ app: chosen.app, action: chosen.action, config }),
      });
      toast({ title: `${capability.specialistId.toUpperCase()} bound to ${chosen.appName}` });
      setSelected('');
      setConfig({});
      await onBound();
    } catch (error) {
      toast({ title: error instanceof Error ? error.message : 'Could not bind the capability', variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-3 rounded-md border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline">{capability.specialistId.toUpperCase()}</Badge>
        <span className="font-medium">{capability.label}</span>
        <Badge variant="secondary">{capability.direction}</Badge>
        <span className="ml-auto text-xs text-muted-foreground">
          {capability.binding ? `${capability.binding.appName} · ${capability.binding.actionName}` : 'Not bound'}
        </span>
      </div>
      <p className="text-sm text-muted-foreground">{capability.description}</p>
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <Label className="text-xs">Policy</Label>
          <Select
            value={capability.policy.mode}
            onValueChange={(value) => onPolicy(value as Capability['policy']['mode'])}
            disabled={!canManage || !capability.binding || busy !== null}
          >
            <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="off">Off</SelectItem>
              <SelectItem value="approve">{capability.direction === 'write' ? 'Approve each' : 'On'}</SelectItem>
              <SelectItem value="auto">{capability.direction === 'write' ? 'Automatic' : 'On (scheduled)'}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Daily budget</Label>
          <Input
            type="number"
            min={0}
            max={500}
            className="w-28"
            defaultValue={capability.policy.dailyBudget}
            disabled={!canManage || !capability.binding || busy !== null}
            onBlur={(event) => {
              const value = Number(event.target.value);
              if (Number.isFinite(value) && value !== capability.policy.dailyBudget) onPolicy(capability.policy.mode, value);
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
              None of your enabled Zapier actions match this capability yet. Enable one of:{' '}
              {capability.candidates.map((item) => `${item.appName} → ${item.actionName}`).join(', ')} in Zapier, then reload.
            </p>
          ) : (
            <div className="flex flex-wrap items-end gap-3">
              <div className="space-y-1">
                <Label className="text-xs">{capability.binding ? 'Rebind to' : 'Bind to'}</Label>
                <Select value={selected} onValueChange={setSelected}>
                  <SelectTrigger className="w-72"><SelectValue placeholder="Choose an enabled action" /></SelectTrigger>
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
                <div key={field.key} className="space-y-1">
                  <Label className="text-xs">{field.label}{field.required ? ' *' : ''}</Label>
                  <Input
                    className="w-56"
                    value={config[field.key] ?? ''}
                    onChange={(event) => setConfig((current) => ({ ...current, [field.key]: event.target.value }))}
                  />
                </div>
              ))}
              {capability.key === 'sched.sms.send' && (
                <CrewPhones config={config} onChange={setConfig} />
              )}
              <Button size="sm" onClick={() => void bind()} disabled={!chosen || saving}>
                {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}Save binding
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Crew phone numbers live in the SCHED binding as `crew_phone_<userId>`. */
function CrewPhones({ config, onChange }: { config: Record<string, string>; onChange: (next: Record<string, string>) => void }) {
  const [userId, setUserId] = useState('');
  const [phone, setPhone] = useState('');
  const entries = Object.entries(config).filter(([key]) => key.startsWith('crew_phone_'));
  return (
    <div className="basis-full space-y-2">
      <Label className="text-xs">Crew phone numbers (team member id → mobile)</Label>
      {entries.map(([key, value]) => (
        <div key={key} className="text-xs text-muted-foreground">{key.replace('crew_phone_', '')} → {value}</div>
      ))}
      <div className="flex flex-wrap gap-2">
        <Input className="w-64" placeholder="Team member user id" value={userId} onChange={(event) => setUserId(event.target.value)} />
        <Input className="w-44" placeholder="+14045551234" value={phone} onChange={(event) => setPhone(event.target.value)} />
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!userId.trim() || !phone.trim()}
          onClick={() => {
            onChange({ ...config, [`crew_phone_${userId.trim()}`]: phone.trim() });
            setUserId('');
            setPhone('');
          }}
        >
          Add
        </Button>
      </div>
    </div>
  );
}
