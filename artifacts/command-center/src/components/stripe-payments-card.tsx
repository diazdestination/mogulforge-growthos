import { useCallback, useEffect, useState } from 'react';
import { ExternalLink, Loader2, RefreshCw, ShieldAlert } from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useToast } from '@/hooks/use-toast';

type Onboarding = 'not_started' | 'needs_info' | 'ready' | 'restricted';

export type StripeAccountStatus = {
  configured: boolean;
  mode?: 'test' | 'live';
  configIssue?: string | null;
  connected: boolean;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  detailsSubmitted: boolean;
  lastSyncedAt: string | null;
  onboarding?: Onboarding;
  onboardingDetail?: string;
  requirementsDue?: number;
  currentDeadline?: string | null;
};

const STATUS: Record<Onboarding, { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline' }> = {
  not_started: { label: 'Not started', variant: 'outline' },
  needs_info: { label: 'Needs info', variant: 'secondary' },
  ready: { label: 'Ready', variant: 'default' },
  restricted: { label: 'Restricted', variant: 'destructive' },
};

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/v1${path}`, { credentials: 'include', ...init, headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) } });
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `Request failed (${response.status})`);
  return body;
}

function onboardingOf(status: StripeAccountStatus): Onboarding {
  if (status.onboarding) return status.onboarding;
  if (!status.connected) return 'not_started';
  return status.chargesEnabled ? 'ready' : 'needs_info';
}

/**
 * BILL: the owner connects the company's own Stripe account (Stripe Connect) so
 * customers can pay invoices by card or bank, and money goes straight to the
 * company. Shows onboarding status and lets the owner start or continue it.
 */
export function StripePaymentsCard({ canManage }: { canManage: boolean }) {
  const { toast } = useToast();
  const [status, setStatus] = useState<StripeAccountStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [returnState] = useState(() => new URLSearchParams(window.location.search).get('stripe'));

  const load = useCallback(async (refresh = false) => {
    try {
      const next = refresh ? await api<StripeAccountStatus>('/payments/stripe/refresh', { method: 'POST', body: '{}' }) : await api<StripeAccountStatus>('/payments/stripe');
      setStatus(next && typeof next.configured === 'boolean' ? next : null);
    } catch (error) {
      if (refresh) {
        toast({ variant: 'destructive', title: error instanceof Error ? error.message : 'Could not refresh Stripe' });
        // Still show the last known status.
        await api<StripeAccountStatus>('/payments/stripe').then(setStatus, () => undefined);
      }
    }
  }, [toast]);

  useEffect(() => {
    // Coming back from Stripe: re-read the account from Stripe so the status is current.
    void load(returnState === 'return' && canManage);
  }, [load, returnState, canManage]);

  const connect = async () => {
    setBusy(true);
    try {
      const { url } = await api<{ url: string }>('/payments/stripe/connect', { method: 'POST', body: '{}' });
      window.location.assign(url);
    } catch (error) {
      setBusy(false);
      toast({ variant: 'destructive', title: error instanceof Error ? error.message : 'Could not start Stripe setup' });
    }
  };

  const disconnect = async () => {
    if (!window.confirm('Disconnect Stripe? New pay links stop immediately. Your Stripe account and past payments are not affected.')) return;
    setBusy(true);
    try {
      await api('/payments/stripe', { method: 'DELETE' });
      await load();
    } finally {
      setBusy(false);
    }
  };

  if (!status) return null;
  const live = status.mode === 'live';
  const onboarding = onboardingOf(status);
  const badge = STATUS[onboarding];
  const action = onboarding === 'not_started' ? 'Start Stripe setup' : onboarding === 'ready' ? 'Update details in Stripe' : 'Continue Stripe setup';
  return (
    <Card aria-label="Stripe payments">
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle>Card &amp; bank payments (Stripe)</CardTitle>
          <Badge variant={live ? 'default' : 'outline'}>{live ? 'Live' : 'Test mode'}</Badge>
        </div>
        <CardDescription>
          Customers pay invoices by card or bank through your company's own Stripe account; money goes straight to you.
          {live ? ' Live mode: real cards are charged.' : ' Test mode: no real money moves.'}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!status.configured ? (
          <Alert>
            <ShieldAlert className="h-4 w-4" />
            <AlertTitle>Not available on this deployment</AlertTitle>
            <AlertDescription>
              Online payments are not set up yet. Ask your MogulForge contact to enable them.
              {status.configIssue && canManage && <span className="mt-1 block text-xs">Setup problem: {status.configIssue}</span>}
            </AlertDescription>
          </Alert>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium">Stripe setup:</span>
              <Badge variant={badge.variant}>{badge.label}</Badge>
              {status.lastSyncedAt && <span className="text-xs text-muted-foreground">Checked {new Date(status.lastSyncedAt).toLocaleString()}</span>}
            </div>
            {status.onboardingDetail && <p className="text-sm">{status.onboardingDetail}</p>}
            {status.currentDeadline && onboarding !== 'restricted' && (status.requirementsDue ?? 0) > 0 && (
              <p className="text-sm text-muted-foreground">Stripe's deadline: {new Date(status.currentDeadline).toLocaleDateString()}.</p>
            )}
            {returnState === 'refresh' && canManage && onboarding !== 'ready' && (
              <Alert>
                <AlertTitle>Your Stripe setup link expired</AlertTitle>
                <AlertDescription>Use “{action}” to pick up where you left off.</AlertDescription>
              </Alert>
            )}
            {onboarding !== 'ready' && <p className="text-sm text-muted-foreground">Pay links stay off until Stripe says the account is ready.</p>}
            <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
              {canManage && (
                <Button size="sm" variant={onboarding === 'ready' ? 'outline' : 'default'} disabled={busy} onClick={() => void connect()}>
                  {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ExternalLink className="mr-2 h-4 w-4" />}{action}
                </Button>
              )}
              {status.connected && canManage && (
                <Button variant="outline" size="sm" disabled={busy} onClick={() => void load(true)}><RefreshCw className="mr-2 h-4 w-4" />Check status</Button>
              )}
              {canManage && status.connected && (
                <Button variant="ghost" size="sm" className="text-destructive sm:ml-auto" disabled={busy} onClick={() => void disconnect()}>Disconnect</Button>
              )}
            </div>
            {!canManage && onboarding !== 'ready' && <p className="text-sm text-muted-foreground">An owner or admin finishes Stripe setup.</p>}
          </>
        )}
      </CardContent>
    </Card>
  );
}
