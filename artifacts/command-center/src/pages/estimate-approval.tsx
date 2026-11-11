import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { CheckCircle2, Loader2, ShieldCheck, XCircle } from 'lucide-react';

type LineItem = { description: string; quantity: number; unitPriceCents: number; totalCents: number };
type State = 'waiting' | 'approved' | 'declined' | 'expired' | 'revoked' | 'outdated';
export type PublicEstimateApproval = {
  state: State;
  companyName: string;
  consentText: string;
  expiresAt: string;
  estimate: { customerName: string | null; title: string; lineItems: LineItem[]; subtotalCents: number; taxCents: number; totalCents: number; notes: string | null } | null;
  decidedAt: string | null;
  signerName: string | null;
};

const money = (cents: number) => (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const when = (value: string | null) => (value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString() : '');
const field = 'w-full rounded-xl border border-input bg-background px-4 py-3 text-base focus:outline-none focus:ring-2 focus:ring-primary/40';
const CLOSED: Record<Exclude<State, 'waiting' | 'approved' | 'declined'>, { title: string; body: string }> = {
  expired: { title: 'This approval link has expired', body: 'Ask the company for a new link to review and approve the estimate.' },
  revoked: { title: 'This approval link is no longer active', body: 'The company withdrew this link. Ask them for a new one if you still want to approve the estimate.' },
  outdated: { title: 'This estimate was updated', body: 'The estimate changed after this link was sent, so it can no longer be approved here. Ask the company for a new link.' },
};
const CANVAS_WIDTH = 600;
const CANVAS_HEIGHT = 200;

/** Drawn signature on a fixed-size canvas, so the PNG stays small whatever the screen density. */
function SignaturePad({ onChange, disabled }: { onChange: (hasInk: boolean) => void; disabled: boolean }) {
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const drawing = useRef(false);
  const point = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    return {
      x: ((event.clientX - box.left) / (box.width || CANVAS_WIDTH)) * CANVAS_WIDTH,
      y: ((event.clientY - box.top) / (box.height || CANVAS_HEIGHT)) * CANVAS_HEIGHT,
    };
  };
  const context = () => {
    const ctx = canvas.current?.getContext('2d') ?? null;
    if (ctx) {
      ctx.lineWidth = 3;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = '#111827';
    }
    return ctx;
  };
  const start = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (disabled) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    drawing.current = true;
    const ctx = context();
    const { x, y } = point(event);
    ctx?.beginPath();
    ctx?.moveTo(x, y);
    ctx?.lineTo(x + 0.1, y + 0.1);
    ctx?.stroke();
    onChange(true);
  };
  const move = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current || disabled) return;
    event.preventDefault();
    const ctx = context();
    const { x, y } = point(event);
    ctx?.lineTo(x, y);
    ctx?.stroke();
  };
  const end = () => {
    drawing.current = false;
  };
  const clear = () => {
    const ctx = canvas.current?.getContext('2d');
    ctx?.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    onChange(false);
  };
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium" id="signature-label">Signature</span>
        <button type="button" onClick={clear} disabled={disabled} className="min-h-11 px-3 text-sm font-medium text-primary underline disabled:opacity-50">
          Clear signature
        </button>
      </div>
      <canvas
        ref={canvas}
        data-signature-pad
        width={CANVAS_WIDTH}
        height={CANVAS_HEIGHT}
        role="img"
        aria-labelledby="signature-label"
        onPointerDown={start}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={end}
        onPointerLeave={end}
        className="block h-40 w-full touch-none rounded-xl border-2 border-dashed border-input bg-white"
      />
      <p className="text-xs text-muted-foreground">Sign with your finger or mouse inside the box.</p>
    </div>
  );
}

export default function EstimateApproval({ token }: { token: string }) {
  const [view, setView] = useState<PublicEstimateApproval | null>(null);
  const [loadError, setLoadError] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState('');
  const [consent, setConsent] = useState(false);
  const [hasInk, setHasInk] = useState(false);
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState('');
  const path = `/api/v1/public/estimate-approvals/${encodeURIComponent(token)}`;

  const load = useCallback(async () => {
    try {
      const response = await fetch(path, { credentials: 'omit' });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : 'This approval link could not be opened.');
      setView(data as PublicEstimateApproval);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'This approval link could not be opened.');
    }
  }, [path]);
  useEffect(() => {
    void load();
  }, [load]);

  async function submit(action: 'approve' | 'decline', body: Record<string, unknown>) {
    setBusy(true);
    setError('');
    try {
      const response = await fetch(`${path}/${action}`, {
        method: 'POST',
        credentials: 'omit',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(typeof data.error === 'string' ? data.error : 'Your response could not be recorded. Please try again.');
        // The link may have changed state (expired, revoked, updated); show what stands now.
        if ([409, 410].includes(response.status)) await load();
        return;
      }
      setView(data as PublicEstimateApproval);
    } catch {
      setError('Your response could not be confirmed. Reload this page to see whether it was recorded before trying again.');
    } finally {
      setBusy(false);
    }
  }

  function approve() {
    const pad = document.querySelector<HTMLCanvasElement>('canvas[data-signature-pad]');
    if (!name.trim()) return setError('Type your full name.');
    if (!hasInk || !pad) return setError('Draw your signature in the box.');
    if (!consent) return setError('Tick the box to confirm your approval.');
    let signatureDataUrl = '';
    try {
      signatureDataUrl = pad.toDataURL('image/png');
    } catch {
      signatureDataUrl = '';
    }
    if (!signatureDataUrl.startsWith('data:image/png;base64,')) return setError('Your signature could not be read. Clear it and sign again.');
    void submit('approve', { signerName: name.trim(), signatureDataUrl, consent: true });
  }

  function decline() {
    if (!reason.trim()) return setError('Tell the company why you are declining.');
    void submit('decline', { reason: reason.trim() });
  }

  const shell = (children: ReactNode) => (
    <main className="min-h-screen bg-muted/30 px-4 py-6 sm:py-10">
      <div className="mx-auto w-full max-w-xl space-y-4">{children}</div>
    </main>
  );

  if (loadError) return shell(<section className="rounded-2xl border bg-card p-6 text-center"><h1 className="text-lg font-semibold">Approval link unavailable</h1><p className="mt-2 text-sm text-muted-foreground">{loadError}</p></section>);
  if (!view) return shell(<div className="flex justify-center py-20" aria-label="Loading estimate"><Loader2 className="h-8 w-8 animate-spin text-primary" /></div>);

  const estimate = view.estimate;
  const header = (
    <header className="space-y-1">
      <p className="text-sm font-medium text-muted-foreground">{view.companyName}</p>
      <h1 className="text-2xl font-bold leading-tight">{estimate?.title ?? 'Estimate approval'}</h1>
      {estimate?.customerName && <p className="text-sm text-muted-foreground">Prepared for {estimate.customerName}</p>}
    </header>
  );

  if (view.state === 'expired' || view.state === 'revoked' || view.state === 'outdated') {
    const closed = CLOSED[view.state];
    return shell(<>{header}<section className="rounded-2xl border bg-card p-6"><h2 className="text-lg font-semibold">{closed.title}</h2><p className="mt-2 text-sm text-muted-foreground">{closed.body}</p></section></>);
  }

  const lines = estimate && (
    <section className="overflow-hidden rounded-2xl border bg-card">
      <ul className="divide-y">
        {estimate.lineItems.map((item, index) => (
          <li key={index} className="flex items-start justify-between gap-4 p-4">
            <div className="min-w-0">
              <p className="break-words font-medium">{item.description}</p>
              <p className="text-xs text-muted-foreground">{item.quantity} × {money(item.unitPriceCents)}</p>
            </div>
            <p className="shrink-0 font-mono text-sm">{money(item.totalCents)}</p>
          </li>
        ))}
      </ul>
      <dl className="space-y-1 border-t bg-muted/30 p-4 text-sm">
        <div className="flex justify-between"><dt>Subtotal</dt><dd className="font-mono">{money(estimate.subtotalCents)}</dd></div>
        {estimate.taxCents > 0 && <div className="flex justify-between"><dt>Tax</dt><dd className="font-mono">{money(estimate.taxCents)}</dd></div>}
        <div className="flex justify-between text-base font-bold"><dt>Total</dt><dd className="font-mono" data-testid="approval-total">{money(estimate.totalCents)}</dd></div>
      </dl>
      {estimate.notes && <p className="whitespace-pre-wrap border-t p-4 text-sm text-muted-foreground">{estimate.notes}</p>}
    </section>
  );

  if (view.state === 'approved' || view.state === 'declined') {
    const approved = view.state === 'approved';
    return shell(
      <>
        {header}
        <section className="flex items-start gap-3 rounded-2xl border bg-card p-5" role="status">
          {approved ? <CheckCircle2 className="h-6 w-6 shrink-0 text-green-600" /> : <XCircle className="h-6 w-6 shrink-0 text-destructive" />}
          <div>
            <h2 className="font-semibold">{approved ? `Approved by ${view.signerName ?? 'the customer'}` : 'Estimate declined'}</h2>
            <p className="text-sm text-muted-foreground">{approved ? `Signed ${when(view.decidedAt)}. ${view.companyName} has your signed approval and will be in touch to schedule the work.` : `Recorded ${when(view.decidedAt)}. ${view.companyName} has been told.`}</p>
          </div>
        </section>
        {lines}
      </>,
    );
  }

  return shell(
    <>
      {header}
      {lines}
      {!declining ? (
        <section className="space-y-4 rounded-2xl border bg-card p-5">
          <h2 className="text-lg font-semibold">Approve and sign</h2>
          <label className="block space-y-1">
            <span className="text-sm font-medium">Full name</span>
            <input className={field} value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" maxLength={120} disabled={busy} />
          </label>
          <SignaturePad onChange={setHasInk} disabled={busy} />
          <label className="flex min-h-11 items-start gap-3 text-sm">
            <input type="checkbox" className="mt-0.5 h-5 w-5 shrink-0" checked={consent} onChange={(e) => setConsent(e.target.checked)} disabled={busy} />
            <span>{view.consentText} I agree that my typed name and drawn signature are my electronic signature.</span>
          </label>
          {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
          <button type="button" onClick={approve} disabled={busy} className="flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 font-semibold text-primary-foreground disabled:opacity-60">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />} Approve estimate
          </button>
          <button type="button" onClick={() => { setDeclining(true); setError(''); }} disabled={busy} className="min-h-11 w-full text-sm font-medium text-muted-foreground underline">
            Decline this estimate
          </button>
        </section>
      ) : (
        <section className="space-y-4 rounded-2xl border bg-card p-5">
          <h2 className="text-lg font-semibold">Decline this estimate</h2>
          <label className="block space-y-1">
            <span className="text-sm font-medium">Reason</span>
            <textarea className={field} rows={4} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} disabled={busy} />
          </label>
          {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
          <button type="button" onClick={decline} disabled={busy} className="flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-destructive px-4 font-semibold text-destructive-foreground disabled:opacity-60">
            {busy && <Loader2 className="h-4 w-4 animate-spin" />} Decline estimate
          </button>
          <button type="button" onClick={() => { setDeclining(false); setError(''); }} disabled={busy} className="min-h-11 w-full text-sm font-medium text-muted-foreground underline">
            Back to approval
          </button>
        </section>
      )}
      <p className="text-center text-xs text-muted-foreground">Link valid until {when(view.expiresAt)}. Your name, signature, time, IP address and browser are recorded with your response.</p>
    </>,
  );
}
