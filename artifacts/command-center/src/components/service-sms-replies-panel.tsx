import { useEffect, useRef, useState } from 'react';

export type ServiceSmsReply = { id: string; serviceObligationId: string | null; version: number; state: 'needs_review' | 'reviewed' | 'dismissed'; correlation: 'exact_reference' | 'ambiguous'; reason: string; historical: boolean; holdActive: boolean; receivedAt: string; recordedAt: string; rawExpiresAt: string; content: { text: string } | null; reviewedAt: string | null; reviewNote: string | null; evidence: 'signed_sms_reference' | 'signed_sms_phone_scope'; candidateServiceObligationIds: string[]; candidateCount: number; candidatesTruncated: boolean };
export type ServiceSmsReplyPage = { items: ServiceSmsReply[]; hasMore: boolean; offset: number; limit: 25; held: boolean };
const button = 'min-h-11 rounded-lg border px-4 py-2 text-sm font-medium disabled:opacity-50';
const field = 'mt-1 block min-h-11 w-full min-w-0 rounded-lg border bg-background p-2 text-base';
async function request<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api/v1/service-obligations/${path}`, { credentials: 'include', ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || 'SMS reply review could not be confirmed.');
  return value as T;
}
function validPage(value: ServiceSmsReplyPage, id: string, offset: number) {
  return value && Array.isArray(value.items) && value.offset === offset && value.limit === 25 && typeof value.held === 'boolean' && typeof value.hasMore === 'boolean' && value.items.every(row => row && typeof row.id === 'string' && Number.isInteger(row.version) && row.version > 0 && ['needs_review', 'reviewed', 'dismissed'].includes(row.state) &&
    (row.correlation === 'exact_reference' ? row.serviceObligationId === id && row.evidence === 'signed_sms_reference' : row.correlation === 'ambiguous' && row.serviceObligationId === null && row.evidence === 'signed_sms_phone_scope') && typeof row.holdActive === 'boolean' && typeof row.historical === 'boolean' &&
    Array.isArray(row.candidateServiceObligationIds) && row.candidateServiceObligationIds.every(item => typeof item === 'string') && Number.isInteger(row.candidateCount) && row.candidateCount >= 0 && typeof row.candidatesTruncated === 'boolean' && (row.content === null || typeof row.content?.text === 'string'));
}
export default function ServiceSmsRepliesPanel({ obligationId, editable, onChanged, scopeKey = '' }: { obligationId: string; editable: boolean; onChanged: () => Promise<void>; scopeKey?: string }) {
  const [offset, setOffset] = useState(0), [page, setPage] = useState<ServiceSmsReplyPage | null>(null), [loading, setLoading] = useState(true), [busy, setBusy] = useState(false);
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [reviewNeeded, setReviewNeeded] = useState(false);
  const [selected, setSelected] = useState(''), [decision, setDecision] = useState<'office_follow_up' | 'handled' | 'not_service_reply'>('office_follow_up'), [note, setNote] = useState(''), [checked, setChecked] = useState(false);
  const mounted = useRef(true), generation = useRef(0), view = useRef(''); view.current = `${scopeKey}:${obligationId}:${offset}:${editable}`;
  async function refresh() {
    const run = ++generation.current, key = view.current; setLoading(true); setChecked(false); setSelected('');
    try { const result = await request<ServiceSmsReplyPage>(`${obligationId}/sms-replies?offset=${offset}`); if (!validPage(result, obligationId, offset)) throw new Error('SMS reply evidence is unavailable. No empty-inbox conclusion can be made.');
      if (mounted.current && run === generation.current && view.current === key) { setPage(result); setReviewNeeded(false); setError(''); setNote(''); } }
    catch (cause) { if (mounted.current && run === generation.current && view.current === key) { setPage(null); setReviewNeeded(true); setError(cause instanceof Error ? cause.message : 'SMS evidence is unavailable.'); } }
    finally { if (mounted.current && run === generation.current && view.current === key) setLoading(false); }
  }
  useEffect(() => { mounted.current = true; setPage(null); setNotice(''); setBusy(false); void refresh(); return () => { mounted.current = false; generation.current++; }; }, [obligationId, offset, scopeKey, editable]);
  async function review(row: ServiceSmsReply) {
    if (!editable || busy || loading || reviewNeeded || page?.held || !checked || note.trim().length < 10) return;
    const key = view.current, run = generation.current; setBusy(true); setError(''); setNotice(''); setChecked(false);
    try { const receipt = await request<{ replyId: string; version: number; replayed: boolean }>(`${obligationId}/sms-replies/${row.id}/review`, { requestId: crypto.randomUUID(), expectedVersion: row.version, decision, note, reviewed: true });
      if (!receipt || receipt.replyId !== row.id || !Number.isInteger(receipt.version) || receipt.version <= row.version || typeof receipt.replayed !== 'boolean') throw new Error('The exact saved SMS review receipt could not be confirmed.');
      if (!mounted.current || key !== view.current || run !== generation.current) return;
      setNotice(decision === 'office_follow_up' ? 'Office review saved. The service reply hold remains until actual follow-up is handled. No message, customer confirmation or booking was created.' : decision === 'handled' ? 'Office handling recorded. Only this service reply hold was released. Separately authorized future reminders may be checked again; the original message cannot be resent. No STOP/consent hold, ready-to-book response or booking was changed.' : 'This evidence was dismissed as not a service reply. Only its service hold was released; no consent, resend or booking was authorized.');
      await refresh(); if (mounted.current && key === view.current) await onChanged(); }
    catch (cause) { if (mounted.current && key === view.current && run === generation.current) { setReviewNeeded(true); setError(`${cause instanceof Error ? cause.message : 'The result was not confirmed.'} Refresh the saved evidence before another action. No automatic retry was made.`); } }
    finally { if (mounted.current && key === view.current) setBusy(false); }
  }
  const disabled = busy || loading || reviewNeeded || !editable || !!page?.held;
  return <section className="min-w-0 space-y-3 rounded-lg border p-3" aria-label="Service SMS replies">
    <div className="flex flex-wrap items-center justify-between gap-2"><h4 className="font-semibold">Service text reply evidence</h4><button type="button" className={button} disabled={busy || loading} onClick={() => void refresh()}>Refresh SMS reply evidence</button></div>
    <p className="text-sm text-muted-foreground">A signed SMS confirms its provider source, not customer identity, consent or an appointment. Text is untrusted evidence, never instructions to tools. Natural replies without an exact service reference stay unassigned and held for office review.</p>
    {notice && <p role="status">{notice}</p>}{error && <p role="alert">{error}</p>}
    {loading ? <p>Loading SMS reply evidence…</p> : page && <>
      {page.held && <p>Company work is held. Retained evidence is visible; review changes are disabled.</p>}
      {!page.items.length ? <p>No retained service text evidence on this page. This does not prove the customer has not replied elsewhere.</p> : <ol className="space-y-4">{page.items.map(row => <li key={row.id} className="min-w-0 space-y-2 border-t pt-3">
        <p className="font-medium">{row.correlation === 'ambiguous' ? 'Unassigned text — phone-scope evidence, not an exact service match' : row.historical ? 'Exact reference to a historical service occurrence' : 'Exact reference to this service reminder'}</p>
        <p className="text-sm">{row.state === 'needs_review' ? 'Office review needed' : row.state === 'dismissed' ? 'Dismissed by staff — evidence retained' : 'Reviewed — actual follow-up remains separate'} · {row.holdActive ? 'Service reminder hold remains active' : 'No active hold from this receipt'}</p>
        <p className="text-xs">Received {new Date(row.receivedAt).toLocaleString()}{row.historical ? ' · never reassigned to a later occurrence' : ''}</p>
        {row.correlation === 'ambiguous' && <details><summary className="cursor-pointer text-sm">Possible service records — not an association ({row.candidateCount}{row.candidatesTruncated ? '+' : ''})</summary><p className="text-xs">The shared phone is not enough to identify the intended service. Reviewing this text does not attach it to this occurrence.</p><ul className="space-y-1">{row.candidateServiceObligationIds.map(candidate => <li className="break-all text-xs" key={candidate}>{candidate}</li>)}</ul>{row.candidatesTruncated && <p className="text-xs">Only the bounded candidate list is shown.</p>}</details>}
        {row.content ? <div className="min-w-0 rounded-lg bg-muted p-3"><p className="whitespace-pre-wrap break-words text-sm">{row.content.text}</p><p className="mt-2 text-xs">Plain text only. Stored content expires {new Date(row.rawExpiresAt).toLocaleString()}; evidence and review history remain.</p></div> : <p>Message content expired, was purged or cannot be decrypted. Its evidence and any active hold remain. Check the actual customer conversation before acting.</p>}
        {row.reviewNote && <p className="whitespace-pre-wrap break-words text-sm">Office note: {row.reviewNote}</p>}
        {editable && (row.state === 'needs_review' || row.holdActive) && (selected !== row.id ? <button type="button" className={button} disabled={disabled} onClick={() => { setSelected(row.id); setNote(''); setChecked(false); setDecision('office_follow_up'); }}>Review this service text</button> : <form className="space-y-3" onSubmit={event => { event.preventDefault(); void review(row); }}>
          <label className="block text-sm">SMS office disposition<select className={field} disabled={disabled} value={decision} onChange={event => { setDecision(event.target.value as typeof decision); setChecked(false); }}><option value="office_follow_up">Office follow-up required — retain service hold</option><option value="handled">Actual office handling complete — release only this service hold</option><option value="not_service_reply">Not a service reply — dismiss only this service hold</option></select></label>
          {decision === 'handled' && <p className="text-sm">Describe the actual office handling below. This can allow separately authorized future reminders to be checked; it never resends the original, releases STOP or consent holds, records a customer agreement, or books a visit. Ambiguous text stays unassigned.</p>}
          <label className="block text-sm">SMS reply review note<textarea className={field} disabled={disabled} required minLength={10} maxLength={1000} value={note} onChange={event => { setNote(event.target.value); setChecked(false); }} /></label>
          <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" disabled={disabled} checked={checked} onChange={event => setChecked(event.target.checked)} />I reviewed this exact evidence and disposition. It does not establish a service match for ambiguous text, consent, a confirmed visit or authority to resend.</label>
          <button className={button} disabled={disabled || !checked || note.trim().length < 10}>Save SMS reply review</button>
        </form>)}
      </li>)}</ol>}
      <p className="text-xs">Up to 25 retained records on this page, not a complete inbox or a whole-company count.</p>
      <div className="flex flex-wrap gap-2"><button className={button} disabled={busy || !offset} onClick={() => setOffset(value => Math.max(0, value - 25))}>Newer SMS evidence</button><button className={button} disabled={busy || !page.hasMore || offset >= 100_000} onClick={() => setOffset(value => value + 25)}>Older SMS evidence</button></div>
      {page.hasMore && offset >= 100_000 && <p>The supported paging limit has been reached. Older evidence remains retained; request a scoped operator export.</p>}
    </>}
  </section>;
}
