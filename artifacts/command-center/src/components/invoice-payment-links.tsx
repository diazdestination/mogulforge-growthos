import { useCallback, useEffect, useState } from 'react';
import { Check, Copy, CreditCard, Loader2 } from 'lucide-react';

import { invoiceButton, money, type InvoiceDetail } from '@/lib/invoice-ui';

type PaymentLink = {
  id: string;
  invoiceVersion: number;
  amountCents: number;
  url: string | null;
  state: 'open' | 'processing' | 'paid' | 'failed' | 'expired' | 'needs_reconciliation';
  detail: string;
  expiresAt: string | null;
  paidAt: string | null;
  createdAt: string;
  sourceReference?: string | null;
};

type AccountStatus = { configured: boolean; connected: boolean; chargesEnabled: boolean };

const STATE_LABEL: Record<PaymentLink['state'], string> = {
  open: 'Waiting for payment',
  processing: 'Bank payment clearing',
  paid: 'Paid and recorded',
  failed: 'Payment failed',
  expired: 'Expired',
  needs_reconciliation: 'Payment needs review',
};

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/v1${path}`, { credentials: 'include', ...init, headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) } });
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `Request failed (${response.status})`);
  return body;
}

/**
 * BILL online collection for an issued invoice: a Stripe Checkout link (card or
 * bank) on the contractor's own Stripe account. The link is shared by staff;
 * Stripe's confirmation records the payment on the invoice automatically.
 */
export function InvoicePaymentLinks({ invoice, canManage }: { invoice: InvoiceDetail; canManage: boolean }) {
  const [account, setAccount] = useState<AccountStatus | null>(null);
  const [links, setLinks] = useState<PaymentLink[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [sessionIds, setSessionIds] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    try {
      const [status, list] = await Promise.all([
        api<AccountStatus>('/payments/stripe'),
        api<{ links?: PaymentLink[] }>(`/invoices/${invoice.id}/payment-links`),
      ]);
      setAccount(status && typeof status.configured === 'boolean' ? status : null);
      setLinks(Array.isArray(list?.links) ? list.links : []);
    } catch {
      setAccount(null);
    }
  }, [invoice.id]);

  useEffect(() => {
    void load();
  }, [load, invoice.version]);

  if (!account?.configured || invoice.status !== 'issued') return null;
  const balance = invoice.balanceDueCents ?? 0;
  const pending = links.some(link => ['open', 'processing', 'needs_reconciliation'].includes(link.state));
  const open = links.find((link) => link.state === 'open' && link.url && link.invoiceVersion === invoice.version && link.amountCents === balance && (!link.expiresAt || new Date(link.expiresAt) > new Date()));

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      await api(`/invoices/${invoice.id}/payment-links`, { method: 'POST', body: '{}' });
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not create the payment link');
    } finally {
      setBusy(false);
    }
  };

  const copy = async (url: string, id: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(id);
      window.setTimeout(() => setCopied(null), 2000);
    } catch {
      setError('Copy failed. Select the link and copy it manually.');
    }
  };

  const reconcile = async (link: PaymentLink, expire = false) => {
    setBusy(true); setError(null);
    try {
      const checkoutSessionId = sessionIds[link.id]?.trim();
      await api(`/invoices/${invoice.id}/payment-links/${link.id}/reconcile`, { method: 'POST', body: JSON.stringify({ ...(checkoutSessionId ? { checkoutSessionId } : {}), ...(expire ? { expire: true } : {}) }) });
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not resolve this payment'); }
    finally { setBusy(false); }
  };

  return (
    <div className="space-y-3 rounded-md border p-3" aria-label="Online payment">
      <div className="flex flex-wrap items-center gap-2">
        <CreditCard className="w-4 h-4" />
        <span className="font-semibold">Sandbox online payment</span>
        {canManage && account.connected && account.chargesEnabled && balance >= 50 && !pending && (
          <button type="button" className={`${invoiceButton} ml-auto`} disabled={busy} onClick={() => void create()}>
            {busy && <Loader2 className="w-4 h-4 animate-spin" />} Create payment link for {money(balance)}
          </button>
        )}
      </div>
      {!account.connected || !account.chargesEnabled ? (
        <p className="text-sm text-muted-foreground">Connect and finish your Stripe account in Settings → Connections to collect card and bank payments.</p>
      ) : open ? (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <input readOnly value={open.url ?? ''} aria-label="Payment link" className="min-w-0 flex-1 rounded border bg-background px-2 py-1.5 font-mono text-xs" onFocus={(event) => event.target.select()} />
          <button type="button" className={invoiceButton} onClick={() => void copy(open.url!, open.id)}>
            {copied === open.id ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />} {copied === open.id ? 'Copied' : 'Copy link'}
          </button>
          <p className="basis-full text-xs text-muted-foreground">Send this link to your customer. When Stripe confirms the payment it is recorded on this invoice automatically.</p>
        </div>
      ) : null}
      {error && <p className="text-sm text-destructive">{error}</p>}
      {links.length > 0 && (
        <ul className="divide-y rounded border text-sm">
          {links.slice(0, 5).map((link) => (
            <li key={link.id} className="flex flex-wrap items-center gap-2 p-2">
              <span className={link.state === 'needs_reconciliation' || link.state === 'failed' ? 'font-semibold text-destructive' : 'font-medium'}>{STATE_LABEL[link.state]}</span>
              <span className="text-muted-foreground">{money(link.amountCents)}</span>
              <span className="ml-auto text-xs text-muted-foreground">{new Date(link.createdAt).toLocaleString()}</span>
              {link.state === 'needs_reconciliation' && <span className="basis-full text-xs text-muted-foreground">{link.detail}</span>}
              {link.state === 'needs_reconciliation' && link.sourceReference && <span className="basis-full text-xs">Receipt reference: <code>{link.sourceReference}</code></span>}
              {canManage && ['open', 'processing', 'needs_reconciliation'].includes(link.state) && <div className="basis-full flex flex-wrap gap-2">
                {link.state === 'needs_reconciliation' && <input aria-label="Original sandbox Checkout session ID" placeholder="Original Checkout session ID, if known" value={sessionIds[link.id] ?? ''} onChange={event => setSessionIds(current => ({ ...current, [link.id]: event.target.value }))} className="min-w-0 flex-1 rounded border bg-background px-2 py-1 text-xs" />}
                <button type="button" className={invoiceButton} disabled={busy} onClick={() => void reconcile(link)}>Check original payment</button>
                {link.state === 'open' && <button type="button" className={invoiceButton} disabled={busy} onClick={() => void reconcile(link, true)}>Close unpaid link</button>}
              </div>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
