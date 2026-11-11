import { useCallback, useEffect, useRef, useState } from 'react';
import { Copy, FileSignature, Link2, Loader2, MessageSquare, ShieldOff } from 'lucide-react';

type ApprovalState = 'waiting' | 'approved' | 'declined' | 'expired' | 'revoked' | 'outdated';
export type StaffApproval = {
  id: string;
  state: ApprovalState;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  decidedAt: string | null;
  signerName: string | null;
  signatureDataUrl: string | null;
  declineReason: string | null;
  totalCents: number;
};
type Status = { estimateId: string; eligible: boolean; approval: StaffApproval | null };

const when = (value: string | null) => (value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString() : 'time unavailable');
const button = 'inline-flex min-h-10 items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-xs font-bold transition-colors disabled:opacity-50';

async function api(path: string, method: 'GET' | 'POST' = 'GET') {
  const response = await fetch(`/api/v1${path}`, {
    method,
    credentials: 'include',
    headers: method === 'POST' ? { 'content-type': 'application/json' } : undefined,
    body: method === 'POST' ? '{}' : undefined,
  });
  const data = await response.json().catch(() => ({}));
  return { response, data };
}

function stateLine(approval: StaffApproval) {
  switch (approval.state) {
    case 'waiting':
      return `Waiting for the customer · link expires ${when(approval.expiresAt)}`;
    case 'approved':
      return `Approved by ${approval.signerName ?? 'the customer'} at ${when(approval.decidedAt)}`;
    case 'declined':
      return `Declined at ${when(approval.decidedAt)}${approval.declineReason ? ` — “${approval.declineReason}”` : ''}`;
    case 'expired':
      return 'Approval link expired before the customer responded.';
    case 'outdated':
      return 'Estimate changed after the link was created. The old link cannot be approved; create a new one.';
    case 'revoked':
      return `Approval link revoked at ${when(approval.revokedAt)}.`;
  }
}

/**
 * Customer approval for one estimate. Creating a link never contacts the
 * customer; a text is only a request that waits in the approvals queue.
 */
export function EstimateApprovalPanel({ estimateId, canManage }: { estimateId: string; canManage: boolean }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [textHeld, setTextHeld] = useState(false);
  const inFlight = useRef(false);

  const load = useCallback(async () => {
    try {
      const { response, data } = await api(`/estimates/${estimateId}/approval`);
      if (response.ok) setStatus(data as Status);
    } catch {
      // Leave the panel hidden; the estimate itself is unaffected.
    }
  }, [estimateId]);
  useEffect(() => {
    void load();
  }, [load]);

  async function run(key: string, work: () => Promise<void>) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(key);
    setMessage('');
    try {
      await work();
    } catch {
      setMessage('The request could not be confirmed. Refresh before trying again.');
    } finally {
      inFlight.current = false;
      setBusy(null);
    }
  }

  const createLink = () =>
    run('link', async () => {
      const { response, data } = await api(`/estimates/${estimateId}/approval-link`, 'POST');
      if (!response.ok) {
        setMessage(typeof data.error === 'string' ? data.error : 'The approval link could not be created.');
        return;
      }
      setUrl(String(data.url ?? ''));
      setStatus(current => ({ estimateId, eligible: current?.eligible ?? true, approval: data.approval as StaffApproval }));
      setMessage(data.reused ? 'This is the existing link for the current estimate.' : 'Link created. It has not been sent to anyone.');
    });

  const revoke = () =>
    run('revoke', async () => {
      const { response, data } = await api(`/estimates/${estimateId}/approval-link/revoke`, 'POST');
      if (!response.ok) {
        setMessage(typeof data.error === 'string' ? data.error : 'The link could not be revoked.');
        return;
      }
      setUrl('');
      setMessage('Link revoked. The customer can no longer use it.');
      await load();
    });

  const requestText = () =>
    run('text', async () => {
      const { response, data } = await api(`/integrations/zapier/flows/estimates/${estimateId}/approval-text`, 'POST');
      const state: string | undefined = data?.execution?.state;
      // 400/404/409 refusals with a reason are raised before any app is contacted.
      if ([400, 404, 409].includes(response.status) && !state && typeof data.error === 'string') {
        setMessage(data.error);
      } else if (!response.ok || !state) {
        setTextHeld(true);
        setMessage('Text outcome could not be confirmed. Review recent Zapier actions before requesting another.');
      } else if (state === 'pending_approval') {
        setMessage('Text request is waiting for approval in Connected apps. Nothing has been sent yet.');
      } else if (state === 'succeeded') {
        setMessage('Your texting app reported the text as sent.');
      } else if (['failed', 'blocked', 'rejected'].includes(state)) {
        setMessage('The text was not sent. Review its status in Connected apps.');
      } else {
        setTextHeld(true);
        setMessage('Text outcome needs review in Connected apps before requesting another.');
      }
    });

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setMessage('Link copied.');
    } catch {
      setMessage('Copy failed. Select the link and copy it.');
    }
  }

  if (!status || (!status.eligible && !status.approval)) return null;
  const approval = status.approval;
  const open = approval?.state === 'waiting';
  const decided = approval?.state === 'approved' || approval?.state === 'declined';
  const canCreate = canManage && status.eligible && !open && !decided;

  return (
    <section className="mt-4 space-y-3 rounded-xl border border-border/60 bg-muted/20 p-3" aria-label="Customer approval">
      <div className="flex items-center gap-2 text-sm font-semibold">
        <FileSignature className="h-4 w-4" /> Customer approval
      </div>
      {approval ? <p className="text-sm" data-testid="approval-state">{stateLine(approval)}</p> : <p className="text-sm text-muted-foreground">No approval link yet. A link lets the customer review, sign and approve or decline online.</p>}
      {approval?.state === 'approved' && approval.signatureDataUrl && (
        <img src={approval.signatureDataUrl} alt={`Signature of ${approval.signerName ?? 'the customer'}`} className="h-16 max-w-full rounded border bg-white object-contain p-1" />
      )}
      {decided && (
        <a className="inline-flex min-h-10 items-center text-xs font-bold text-primary underline" href={`/api/v1/estimates/${estimateId}/approval/record`} target="_blank" rel="noopener noreferrer">
          Open signed record
        </a>
      )}
      {url && open && (
        <div className="flex gap-2">
          <input readOnly aria-label="Approval link" value={url} onFocus={e => e.currentTarget.select()} className="h-10 min-w-0 flex-1 rounded-md border border-input bg-background px-3 text-xs" />
          <button type="button" onClick={copy} className={`${button} bg-secondary/15 text-secondary hover:bg-secondary/25`}>
            <Copy className="h-3.5 w-3.5" /> Copy
          </button>
        </div>
      )}
      {canManage && (
        <div className="flex flex-wrap gap-2">
          {(canCreate || (open && !url)) && (
            <button type="button" onClick={createLink} disabled={busy !== null} className={`${button} bg-primary/10 text-primary hover:bg-primary/20`}>
              {busy === 'link' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Link2 className="h-3.5 w-3.5" />} Get approval link
            </button>
          )}
          {open && (
            <>
              <button type="button" onClick={requestText} disabled={busy !== null || textHeld} className={`${button} bg-blue-500/10 text-blue-700 hover:bg-blue-500/20 dark:text-blue-400`}>
                {busy === 'text' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <MessageSquare className="h-3.5 w-3.5" />} Text approval link
              </button>
              <button type="button" onClick={revoke} disabled={busy !== null} className={`${button} bg-destructive/10 text-destructive hover:bg-destructive/20`}>
                {busy === 'revoke' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldOff className="h-3.5 w-3.5" />} Revoke link
              </button>
            </>
          )}
        </div>
      )}
      {message && <p className="text-xs text-muted-foreground" role="status">{message}</p>}
    </section>
  );
}
