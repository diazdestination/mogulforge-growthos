import { useCallback, useEffect, useState } from 'react';
import { Loader2, RefreshCw, ShieldAlert } from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useToast } from '@/hooks/use-toast';

type Status = {
  configured: boolean;
  connected: boolean;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  detailsSubmitted: boolean;
  lastSyncedAt: string | null;
};

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/v1${path}`, { credentials: 'include', ...init, headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) } });
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `Request failed (${response.status})`);
  return body;
}

/** BILL: connect the company's own Stripe account to collect card and bank payments on invoices. */
export function StripePaymentsCard({ canManage }: { canManage: boolean }) {
  const { toast } = useToast();
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (refresh = false) => {
    try {
      const next = refresh ? await api<Status>('/payments/stripe/refresh', { method: 'POST', body: '{}' }) : await api<Status>('/payments/stripe');
      setStatus(next && typeof next.configured === 'boolean' ? next : null);
    } catch (error) {
      if (refresh) toast({ variant: 'destructive', title: error instanceof Error ? error.message : 'Could not refresh Stripe' });
    }
  }, [toast]);

  useEffect(() => {
    const returning = new URLSearchParams(window.location.search).get('stripe');
    void load(returning === 'return');
  }, [load]);

  const connect = async () => {
    setBusy(true);
    try {
      const { url } = await api<{ url: string }>('/payments/stripe/connect', { method: 'POST', body: '{}' });
      window.location.assign(url);
    } catch (error) {
      setBusy(false);
      toast({ variant: 'destructive', title: error instanceof Error ? error.message : 'Could not start Stripe onboarding' });
    }
  };

  const disconnect = async () => {
    if (!window.confirm('Disconnect Stripe? New payment links stop immediately. Your Stripe account and past payments are not affected.')) return;
    setBusy(true);
    try {
      await api('/payments/stripe', { method: 'DELETE' });
      await load();
    } finally {
      setBusy(false);
    }
  };

  if (!status) return null;
  const ready = status.connected && status.chargesEnabled;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Card & bank payments (Stripe)</CardTitle>
        <CardDescription>
          BILL collects invoice payments by card or bank transfer through your own Stripe account. Money goes straight to
          you; GrowthOS records each confirmed payment on its invoice.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!status.configured ? (
          <Alert>
            <ShieldAlert className="h-4 w-4" />
            <AlertTitle>Not available on this deployment</AlertTitle>
            <AlertDescription>Online payments are not configured yet. Ask your MogulForge contact to enable them.</AlertDescription>
          </Alert>
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            <Badge variant={ready ? 'default' : 'secondary'}>
              {ready ? 'Accepting payments' : status.connected ? 'Finish Stripe setup' : 'Not connected'}
            </Badge>
            {status.connected && !status.payoutsEnabled && <span className="text-sm text-muted-foreground">Payouts are not enabled yet in Stripe.</span>}
            <div className="ml-auto flex gap-2">
              {status.connected && (
                <Button variant="outline" size="sm" disabled={busy} onClick={() => void load(true)}><RefreshCw className="mr-2 h-4 w-4" />Refresh</Button>
              )}
              {canManage && !ready && (
                <Button size="sm" disabled={busy} onClick={() => void connect()}>
                  {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}{status.connected ? 'Continue Stripe setup' : 'Connect Stripe'}
                </Button>
              )}
              {canManage && status.connected && (
                <Button variant="destructive" size="sm" disabled={busy} onClick={() => void disconnect()}>Disconnect</Button>
              )}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
