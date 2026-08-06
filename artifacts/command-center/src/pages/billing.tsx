import { useEffect, useState } from 'react';
import {
  CreditCard,
  Loader2,
  CheckCircle2,
  AlertCircle,
  ExternalLink,
} from 'lucide-react';
import { CLIENT } from '@/lib/client.config';

interface BillingStatus {
  enabled: boolean;
  enforced: boolean;
  canCheckout: boolean;
  status: string | null;
  planTier: string | null;
  trialEndsAt: string | null;
  hasAccess: boolean;
}

const ACTIVE = new Set(['active', 'trialing', 'past_due']);

function StatusBadge({ status }: { status: string | null }) {
  const label = status ?? 'No subscription';
  const good = status ? ACTIVE.has(status) : false;
  return (
    <span
      className={
        'inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold ' +
        (good
          ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
          : 'bg-muted text-muted-foreground')
      }
    >
      {good ? <CheckCircle2 className="w-3.5 h-3.5" /> : <AlertCircle className="w-3.5 h-3.5" />}
      {label.replace('_', ' ')}
    </span>
  );
}

export default function Billing() {
  const [data, setData] = useState<BillingStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/v1/billing', { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d: BillingStatus) => setData(d))
      .catch(() => setError('Could not load billing status.'))
      .finally(() => setLoading(false));
  }, []);

  async function go(path: string) {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(path, { method: 'POST', credentials: 'include' });
      const j = (await r.json().catch(() => ({}))) as { url?: string; error?: string };
      if (!r.ok || !j.url) throw new Error(j.error || 'Something went wrong. Please try again.');
      window.location.href = j.url;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong.');
      setBusy(false);
    }
  }

  const hasSubscription = !!data?.status && ACTIVE.has(data.status);

  return (
    <div className="w-full p-6 md:p-8 max-w-3xl mx-auto">
      <div className="flex items-center gap-3 mb-1">
        <CreditCard className="w-6 h-6 text-primary" />
        <h1 className="text-2xl font-bold tracking-tight">Billing</h1>
      </div>
      <p className="text-sm text-muted-foreground mb-8">
        Manage your {CLIENT.businessShortName} subscription and payment method.
      </p>

      {loading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="w-6 h-6 animate-spin text-primary" />
        </div>
      ) : (
        <div className="rounded-xl border border-border bg-card p-6 shadow-sm">
          {!data?.enabled ? (
            <div className="flex flex-col items-center text-center py-8">
              <div className="w-12 h-12 rounded-xl bg-muted flex items-center justify-center mb-4">
                <CreditCard className="w-6 h-6 text-muted-foreground" />
              </div>
              <h2 className="text-lg font-semibold mb-1">Billing isn't set up yet</h2>
              <p className="text-sm text-muted-foreground max-w-sm">
                This workspace is on the free beta — no payment required. Paid plans
                turn on once the operator configures Stripe.
              </p>
            </div>
          ) : (
            <>
              <div className="flex items-center justify-between gap-4 pb-6 border-b border-border">
                <div>
                  <div className="text-sm text-muted-foreground mb-1">Current plan</div>
                  <div className="font-semibold">
                    {hasSubscription ? 'Pro' : 'Free / Beta'}
                  </div>
                </div>
                <StatusBadge status={data.status} />
              </div>

              {data.trialEndsAt && (
                <p className="text-sm text-muted-foreground mt-4">
                  Trial ends {new Date(data.trialEndsAt).toLocaleDateString()}.
                </p>
              )}

              <div className="mt-6 flex flex-col sm:flex-row gap-3">
                {hasSubscription ? (
                  <button
                    onClick={() => go('/api/v1/billing/portal')}
                    disabled={busy}
                    className="inline-flex items-center justify-center gap-2 bg-primary text-primary-foreground hover:bg-primary/90 h-11 px-5 rounded-md font-semibold text-sm transition-colors disabled:opacity-60"
                  >
                    {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <ExternalLink className="w-4 h-4" />}
                    Manage billing
                  </button>
                ) : data.canCheckout ? (
                  <button
                    onClick={() => go('/api/v1/billing/checkout')}
                    disabled={busy}
                    className="inline-flex items-center justify-center gap-2 bg-primary text-primary-foreground hover:bg-primary/90 h-11 px-5 rounded-md font-semibold text-sm transition-colors disabled:opacity-60"
                  >
                    {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <CreditCard className="w-4 h-4" />}
                    Start subscription (14-day trial)
                  </button>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    No plan is available for purchase yet.
                  </p>
                )}
              </div>
            </>
          )}

          {error && (
            <p className="text-sm text-destructive mt-4" role="alert">
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
