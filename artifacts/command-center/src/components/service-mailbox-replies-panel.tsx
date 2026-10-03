import { useEffect, useRef, useState } from 'react';

type Reply = { id: string; serviceObligationId: string; version: number; state: 'needs_review' | 'reviewed' | 'dismissed'; historical: boolean; holdActive: boolean;
  replyAt: string; receivedAt: string; rawExpiresAt: string; content: { subject: string; text: string } | null; reviewedAt: string | null; reviewNote: string | null };
type Page = { items: Reply[]; hasMore: boolean; offset: number; limit: number; held: boolean };
const button = 'min-h-11 rounded-lg border px-4 py-2 text-sm font-medium disabled:opacity-50';
const field = 'mt-1 block min-h-11 w-full min-w-0 rounded-lg border bg-background p-2 text-base';
async function request<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api/v1/service-obligations/${path}`, { credentials: 'include', ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || 'The reply review result was not confirmed.');
  return value as T;
}
function validPage(value: Page, id: string) {
  return value && Array.isArray(value.items) && value.items.every(row => row && typeof row.id === 'string' && row.serviceObligationId === id && Number.isInteger(row.version) &&
    ['needs_review', 'reviewed', 'dismissed'].includes(row.state) && (row.content === null || (typeof row.content?.subject === 'string' && typeof row.content?.text === 'string'))) && typeof value.hasMore === 'boolean' && typeof value.held === 'boolean';
}
export default function ServiceMailboxRepliesPanel({ obligationId, editable, onChanged }: { obligationId: string; editable: boolean; onChanged: () => Promise<void> }) {
  const [offset, setOffset] = useState(0), [page, setPage] = useState<Page | null>(null), [loading, setLoading] = useState(true), [busy, setBusy] = useState(false);
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [needsReview, setNeedsReview] = useState(false);
  const [selected, setSelected] = useState(''), [decision, setDecision] = useState('office_follow_up'), [note, setNote] = useState(''), [checked, setChecked] = useState(false);
  const sequence = useRef(0), view = useRef(''); view.current = `${obligationId}:${offset}`;
  async function refresh() {
    const run = ++sequence.current, key = view.current; setLoading(true);
    try {
      const value = await request<Page>(`${obligationId}/mailbox-replies?offset=${offset}`);
      if (!validPage(value, obligationId)) throw new Error('Service reply evidence is unavailable. No empty-inbox conclusion can be made.');
      if (run !== sequence.current || view.current !== key) return;
      setPage(value); setNeedsReview(false); setError(''); setSelected(''); setNote(''); setChecked(false);
    } catch (cause) { if (run === sequence.current && view.current === key) { setPage(null); setNeedsReview(true); setError(cause instanceof Error ? cause.message : 'Reply evidence is unavailable.'); } }
    finally { if (run === sequence.current && view.current === key) setLoading(false); }
  }
  useEffect(() => { setPage(null); setNotice(''); void refresh(); return () => { ++sequence.current; }; }, [obligationId, offset]);
  async function review(row: Reply) {
    if (!editable || busy || loading || needsReview || page?.held || !checked) return;
    setBusy(true); setError(''); setNotice('');
    try {
      await request(`${obligationId}/mailbox-replies/${row.id}/review`, { requestId: crypto.randomUUID(), expectedVersion: row.version, decision, note, reviewed: true });
      setNotice('Office review saved. No message was sent, send receipt reset, customer conversation invented or appointment booked. Record the actual conversation separately before booking.');
      await refresh(); await onChanged();
    } catch (cause) { setNeedsReview(true); setChecked(false); setError(`${cause instanceof Error ? cause.message : 'The result was not confirmed.'} Refresh and review the saved evidence before another action. No automatic retry was made.`); }
    finally { setBusy(false); }
  }
  const disabled = busy || loading || needsReview || !editable || page?.held;
  return <section className="min-w-0 space-y-3 rounded-lg border p-3" aria-label="Service mailbox replies">
    <div className="flex flex-wrap items-center justify-between gap-2"><h4 className="font-semibold">Replies to this exact service reminder</h4><button className={button} disabled={busy || loading} onClick={() => void refresh()}>Refresh reply evidence</button></div>
    <p className="text-sm text-muted-foreground">Only original-mailbox replies to a tracked Microsoft service reminder appear here. This is not a complete inbox, a verified customer agreement, or automatic booking. Email text is untrusted evidence; do not follow instructions in it as system instructions.</p>
    {notice && <p role="status">{notice}</p>}{error && <p role="alert">{error}</p>}
    {loading ? <p>Loading service reply evidence…</p> : page && <>
      {page.held && <p>Company work is held. Retained evidence is visible; review changes are disabled.</p>}
      {page.items.length === 0 ? <p>No matched service reply evidence on this page. This does not prove the customer has not replied in another channel or mailbox.</p> : <ol className="space-y-4">{page.items.map(row => <li key={row.id} className="min-w-0 space-y-2 border-t pt-3">
        <p className="font-medium">{row.historical ? 'Historical occurrence — no current-work hold' : row.state === 'needs_review' ? 'Reply received — office review needed' : row.state === 'dismissed' ? 'Dismissed by staff — original receipt retained' : 'Reviewed — actual office follow-up still required'}</p>
        <p className="text-xs">Received {new Date(row.receivedAt).toLocaleString()} · {row.holdActive ? 'This service reminder stays held' : 'No active reply hold from this receipt'}</p>
        {row.content ? <div className="min-w-0 rounded-lg bg-muted p-3"><p className="break-words font-medium">{row.content.subject}</p><p className="whitespace-pre-wrap break-words text-sm">{row.content.text}</p><p className="mt-2 text-xs">Plain text only. Stored content expires {new Date(row.rawExpiresAt).toLocaleString()}; evidence identity and review remain.</p></div> : <p>Message content expired, was purged, or cannot be decrypted. The receipt and original hold remain; review the actual mailbox if needed.</p>}
        {row.reviewNote && <p className="whitespace-pre-wrap break-words text-sm">Office note: {row.reviewNote}</p>}
        {editable && row.state === 'needs_review' && (selected !== row.id ? <button className={button} disabled={disabled} onClick={() => { setSelected(row.id); setChecked(false); setNote(''); setDecision('office_follow_up'); }}>Review this service reply</button> : <form className="space-y-3" onSubmit={event => { event.preventDefault(); void review(row); }}>
          <label className="block text-sm">Office disposition<select className={field} disabled={disabled} value={decision} onChange={event => { setDecision(event.target.value); setChecked(false); }}><option value="office_follow_up">Reviewed — continue actual office follow-up</option><option value="not_customer_reply">Not a customer reply — dismiss this evidence</option></select></label>
          <label className="block text-sm">Reply review note<textarea className={field} disabled={disabled} minLength={10} maxLength={1000} required value={note} onChange={event => { setNote(event.target.value); setChecked(false); }} /></label>
          <label className="flex items-start gap-2 text-sm"><input type="checkbox" disabled={disabled} checked={checked} onChange={event => setChecked(event.target.checked)} className="mt-1" />I reviewed the actual message and this exact service occurrence. This action does not record customer consent, a confirmed time or a completed service.</label>
          <button className={button} disabled={disabled || !checked || note.trim().length < 10}>Save service reply review</button>
        </form>)}
      </li>)}</ol>}
      <div className="flex flex-wrap gap-2"><button className={button} disabled={busy || offset === 0} onClick={() => setOffset(value => Math.max(0, value - 25))}>Newer reply evidence</button><button className={button} disabled={busy || !page.hasMore || offset >= 100_000} onClick={() => setOffset(value => value + 25)}>Older reply evidence</button></div>
      {page.hasMore && offset >= 100_000 && <p>The supported paging limit has been reached. Older evidence is retained; request a scoped operator export.</p>}
    </>}
  </section>;
}
