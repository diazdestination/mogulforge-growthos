import { useEffect, useState } from 'react';
import {
  CreditCard,
  Loader2,
  CheckCircle2,
  AlertCircle,
  ExternalLink,
  RefreshCw,
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
  hasSubscription?: boolean;
  canManageBilling?: boolean;
  checkout?: { state: string; intent: 'initial' | 'replacement'; canContinue: boolean; detail: string } | null;
  entitlements?: {
    mode: 'legacy' | 'managed';
    planId: 'beta' | 'growth' | 'scale' | null;
    capabilities: { 'revenue.autopilot': { allowed: boolean; detail: string } };
  };
}

const ACTIVE = new Set(['active', 'trialing']);
const PLAN_NAMES = { beta: 'Founding beta', growth: 'Growth', scale: 'Scale' };

function StatusBadge({ status }: { status: string | null }) {
  const label = status ?? 'No subscription';
  const good = status ? ACTIVE.has(status) : false;
  return (
    <span
      className={
        'inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold ' +
        (good
          ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
          : 'bg-muted text-foreground')
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
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/v1/billing', { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d: BillingStatus) => setData(d))
      .catch(() => setError('Could not load billing status.'))
      .finally(() => setLoading(false));
  }, []);

  async function refreshStatus() {
    const r = await fetch('/api/v1/billing', { credentials: 'include' });
    if (!r.ok) throw new Error('Could not refresh billing status. Try again or contact your GrowthOS operator.');
    setData(await r.json() as BillingStatus);
  }
  async function refresh() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try { await refreshStatus(); }
    catch { setError('Could not refresh billing status. Try again or contact your GrowthOS operator.'); }
    finally { setBusy(false); }
  }

  async function go(path: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const r = await fetch(path, { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: '{}' });
      const j = (await r.json().catch(() => ({}))) as { url?: string; error?: string; code?: string };
      if (j.code === 'checkout_completed' || j.code === 'checkout_expired') {
        setNotice(j.error ?? 'Refresh billing status to see the latest checkout result.');
        await refreshStatus();
        setBusy(false);
        return;
      }
      if (!r.ok || !j.url) throw new Error(j.error || 'Something went wrong. Please try again.');
      window.location.href = j.url;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong.');
      // Show the server's durable recovery state after a lost/failed response.
      await refreshStatus().catch(() => undefined);
      setBusy(false);
    }
  }

  const hasSubscription = data?.hasSubscription ?? !!data?.status;
  const canManageBilling = data?.canManageBilling ?? hasSubscription;
  const capability = data?.entitlements?.capabilities['revenue.autopilot'];
  const planName = data?.entitlements?.planId ? PLAN_NAMES[data.entitlements.planId] : 'Scope awaiting review';

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
          {!data ? null : !data.enabled ? (
            <div className="flex flex-col items-center text-center py-8">
              <div className="w-12 h-12 rounded-xl bg-muted flex items-center justify-center mb-4">
                <CreditCard className="w-6 h-6 text-muted-foreground" />
              </div>
              <h2 className="text-lg font-semibold mb-1">Billing isn't set up yet</h2>
              <p className="text-sm text-muted-foreground max-w-sm">
                Online billing is not configured. Your agreed price and included
                services are managed with your GrowthOS operator.
              </p>
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-center justify-between gap-4 pb-6 border-b border-border">
                <div>
                  <div className="text-sm text-muted-foreground mb-1">Current plan</div>
                  <div className="font-semibold">
                    {planName}
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
                {data.canCheckout && (
                  <button
                    onClick={() => go('/api/v1/billing/checkout')}
                    disabled={busy}
                    className="inline-flex items-center justify-center gap-2 bg-primary text-primary-foreground dark:text-slate-950 hover:bg-primary/90 min-h-11 px-5 py-2 rounded-md font-semibold text-sm transition-colors disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                  >
                    {busy ? <Loader2 className="w-4 h-4 shrink-0 animate-spin" /> : <CreditCard className="w-4 h-4 shrink-0" />}
                    {data.checkout ? (data.checkout.intent === 'replacement' ? 'Continue replacement checkout' : 'Continue checkout') : 'Review subscription in Stripe'}
                  </button>
                )}
                {canManageBilling && (
                  <button
                    onClick={() => go('/api/v1/billing/portal')}
                    disabled={busy}
                    className="inline-flex items-center justify-center gap-2 bg-primary text-primary-foreground dark:text-slate-950 hover:bg-primary/90 min-h-11 px-5 py-2 rounded-md font-semibold text-sm transition-colors disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                  >
                    {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <ExternalLink className="w-4 h-4" />}
                    Manage billing
                  </button>
                )}
                {!canManageBilling && !data.canCheckout && !data.checkout && (
                  <p className="text-sm text-muted-foreground">
                    No plan is available for purchase yet.
                  </p>
                )}
              </div>
              {data.checkout && (
                <div className="mt-4 space-y-2" role="status">
                  <h2 className="text-sm font-semibold">{data.checkout.state === 'reconcile' ? 'Billing review needed' : data.checkout.state === 'preparing' ? 'Preparing checkout' : 'Checkout in progress'}</h2>
                  <p className="text-sm text-muted-foreground">{data.checkout.detail}</p>
                </div>
              )}
              {hasSubscription && (
                <p className="mt-3 text-sm text-muted-foreground">
                  This company has a linked subscription. Use the billing portal or contact your GrowthOS operator to review changes or restart service.
                </p>
              )}
            </>
          )}

          {data && (
            <section aria-label="Included automation" className="mt-6 border-t border-border pt-6">
              <h2 className="font-semibold">Automated execution of approved work</h2>
              <p className="mt-2 text-sm font-medium">
                {capability ? (capability.allowed ? 'Available within your configured policy' : 'Not currently enabled for your scope') : 'Scope status is unavailable'}
              </p>
              <p className="mt-2 text-sm text-muted-foreground">
                {capability?.detail ?? 'Contact your GrowthOS operator to confirm the included workflow.'}
              </p>
              <p className="mt-2 text-sm text-muted-foreground">
                Manual reviews and history remain available. Automation still requires an authorized responder, approved work and a configured policy.
              </p>
            </section>
          )}

          {error && (
            <p className="text-sm text-destructive mt-4" role="alert">
              {error}
            </p>
          )}
          {notice && <p className="text-sm mt-4" role="status">{notice}</p>}
          <button
            onClick={refresh}
            disabled={busy}
            className="mt-5 inline-flex min-h-11 items-center justify-center gap-2 rounded-md border border-border px-4 py-2 text-sm font-medium hover:bg-muted disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            Refresh billing status
          </button>
        </div>
      )}
    </div>
  );
}
