import { useEffect, useState } from 'react';
import { Loader2, RefreshCw, ShieldAlert } from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useToast } from '@/hooks/use-toast';

type GmailConnectionStatus = {
  configured: boolean;
  connected: boolean;
  email: string | null;
  connectedAt: string | null;
  lastUsedAt: string | null;
  lastErrorAt: string | null;
  lastErrorCode: string | null;
  scope: string;
};

type GoogleModuleStatus = {
  id: string;
  name: string;
  purpose: string;
  access: string;
  maturity: 'available' | 'foundation' | 'requires_provider_approval' | 'deferred_restricted';
  risk: 'standard' | 'sensitive' | 'restricted';
  permissionGranted: boolean;
  enabled: boolean;
  lastSyncedAt: string | null;
};

type GmailConnectionCardProps = {
  callbackState: string | null;
  returnPath: '/account' | '/settings';
};

export function GmailConnectionCard({ callbackState, returnPath }: GmailConnectionCardProps) {
  const { toast } = useToast();
  const [status, setStatus] = useState<GmailConnectionStatus | null>(null);
  const [modules, setModules] = useState<GoogleModuleStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const [response, modulesResponse] = await Promise.all([
        fetch('/api/v1/integrations/gmail', { credentials: 'include' }),
        fetch('/api/v1/integrations/google/modules', { credentials: 'include' }),
      ]);
      if (!response.ok || !modulesResponse.ok) throw new Error('Could not load Google connection status');
      setStatus((await response.json()) as GmailConnectionStatus);
      setModules((await modulesResponse.json()) as GoogleModuleStatus[]);
    } catch (error) {
      toast({ title: error instanceof Error ? error.message : 'Could not load Gmail connection', variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    if (callbackState === 'connected') toast({ title: 'Gmail connected' });
    if (callbackState === 'denied') toast({ title: 'Gmail permission was not granted', variant: 'destructive' });
    if (callbackState === 'failed') toast({ title: 'Gmail connection failed. Please try again.', variant: 'destructive' });
    // The callback state is a one-time display hint; status is authoritative.
    if (callbackState) window.history.replaceState({}, '', returnPath);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const connect = async () => {
    setBusy(true);
    try {
      const response = await fetch('/api/v1/integrations/gmail/connect', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ returnPath }),
      });
      const body = (await response.json()) as { authorizationUrl?: string; error?: string };
      if (!response.ok || !body.authorizationUrl) throw new Error(body.error ?? 'Could not start Gmail connection');
      window.location.assign(body.authorizationUrl);
    } catch (error) {
      setBusy(false);
      toast({ title: error instanceof Error ? error.message : 'Could not start Gmail connection', variant: 'destructive' });
    }
  };

  const disconnect = async () => {
    if (!window.confirm('Disconnect this Gmail account? GrowthOS will immediately stop sending from it.')) return;
    setBusy(true);
    try {
      const response = await fetch('/api/v1/integrations/gmail', {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!response.ok) throw new Error('Could not disconnect Gmail');
      toast({ title: 'Gmail disconnected' });
      await load();
    } catch (error) {
      toast({ title: error instanceof Error ? error.message : 'Could not disconnect Gmail', variant: 'destructive' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Your Gmail sending account</CardTitle>
        <CardDescription>
          Connect the Google account you want GrowthOS to send from. Every team member connects their own account;
          MogulForge never asks for a Gmail password and never silently sends from the owner's mailbox.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Checking connection…</div>
        ) : (
          <>
            <div className="rounded-lg border border-border bg-muted/20 p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold">{status?.connected ? 'Connected' : 'Not connected'}</p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {status?.connected ? status.email : status?.configured ? 'Connect Gmail to approve and send BIE emails.' : 'A MogulForge administrator must finish the production Google OAuth configuration.'}
                  </p>
                </div>
                <Badge variant={status?.connected ? 'default' : 'secondary'}>{status?.connected ? 'Ready to send' : 'Action needed'}</Badge>
              </div>
              {status?.connectedAt && <p className="mt-3 text-xs text-muted-foreground">Connected {new Date(status.connectedAt).toLocaleString()}</p>}
              {status?.lastUsedAt && <p className="mt-1 text-xs text-muted-foreground">Last used {new Date(status.lastUsedAt).toLocaleString()}</p>}
              {status?.lastErrorAt && <Alert variant="destructive" className="mt-3"><AlertTitle>Most recent Gmail send needs attention</AlertTitle><AlertDescription>{status.lastErrorCode ?? 'Provider error'} · {new Date(status.lastErrorAt).toLocaleString()}</AlertDescription></Alert>}
            </div>

            <Alert>
              <ShieldAlert className="h-4 w-4" />
              <AlertTitle>Narrow permission by design</AlertTitle>
              <AlertDescription>
                GrowthOS requests Gmail send access for messages you approve. It does not request permission to read,
                delete, or organize your inbox. You can revoke access here or from your Google Account at any time.
              </AlertDescription>
            </Alert>

            <div className="flex flex-wrap gap-3">
              {status?.connected ? (
                <>
                  <Button onClick={connect} disabled={busy || !status.configured} variant="outline">
                    {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Reconnect another account
                  </Button>
                  <Button onClick={disconnect} disabled={busy} variant="destructive">Disconnect Gmail</Button>
                </>
              ) : (
                <Button onClick={connect} disabled={busy || !status?.configured}>
                  {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Connect Gmail
                </Button>
              )}
              <Button variant="ghost" onClick={() => void load()} disabled={busy || loading}>
                <RefreshCw className="mr-2 h-4 w-4" />Refresh status
              </Button>
            </div>

            <div className="border-t border-border pt-5">
              <div className="mb-4">
                <h3 className="font-semibold">Google Business Graph modules</h3>
                <p className="mt-1 text-sm text-muted-foreground">
                  GrowthOS will request each permission only when its connector is ready and you choose to enable it.
                  Declining a module never disables the CRM or other connected sources.
                </p>
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                {modules.map((module) => (
                  <div key={module.id} className="rounded-lg border border-border p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="text-sm font-semibold">{module.name}</p>
                        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{module.purpose}</p>
                      </div>
                      <Badge variant={module.enabled ? 'default' : 'secondary'}>
                        {module.enabled
                          ? 'Enabled'
                          : module.maturity === 'available'
                            ? 'Available'
                            : module.maturity === 'foundation'
                              ? 'Next'
                              : module.maturity === 'requires_provider_approval'
                                ? 'Approval required'
                                : 'Restricted / later'}
                      </Badge>
                    </div>
                    <p className="mt-3 text-[11px] text-muted-foreground">
                      Access: {module.access.replace(/_/g, ' ')} · Risk class: {module.risk}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
