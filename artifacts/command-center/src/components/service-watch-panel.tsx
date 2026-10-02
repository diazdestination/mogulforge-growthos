import { useEffect, useRef, useState } from 'react';
import { getListUsersQueryKey, useListUsers } from '@workspace/api-client-react';
import { canAssignWork, localDateTime, scheduleTimezone } from '@/lib/contractor-schedule';

const reasonNames: Record<string, string> = {
  reminder_needs_review: 'Service reminder needs staff review', no_response_recorded: 'No customer response recorded after three days',
  reminder_blocked: 'Reminder held or changed — review its receipt', send_unknown: 'Unknown send result — do not resend',
  visit_cancelled: 'Visit cancelled — arrange the next office step', visit_no_show: 'Visit recorded as no-show', service_overdue: 'Service date is overdue',
  response_needs_action: 'Recorded conversation needs an office next step', next_action_overdue: 'Promised office next action is overdue',
  owner_required: 'Accepted responsible staff member required', source_review_required: 'Source record needs operator review',
};
const label = (reason: string) => reasonNames[reason] ?? 'Operator review required';
const states: Record<string, string> = { clear: 'No current exception', open: 'Needs attention', acknowledged: 'Office plan recorded', resolved: 'Resolved by source records', held: 'Work held — review required' };
const field = 'mt-1 block min-h-11 w-full min-w-0 rounded-lg border bg-background p-2 text-base';
const button = 'min-h-11 rounded-lg border px-3 py-2 text-sm disabled:opacity-50';
export type WatchDetail = {
  obligationId: string; customerLabel: string; equipmentLabel: string; serviceStatus: string; dueDate: string;
  expectedVersion: number; expectedFingerprint: string; state: string; reasons: string[]; monitorPending: boolean;
  assignedUserId: string | null; ownerValid: boolean; held: boolean; nextAction: string | null; nextActionAt: string | null;
  lastEvaluatedAt: string | null; timezone: string; timezoneFallback: boolean;
  history: { id: string; action: string; createdAt: string; metadata: { state?: string; reasons?: string[]; note?: string; nextActionAt?: string; action?: string } }[];
  historyHasMore: boolean;
};
async function request<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api/v1/${path}`, { credentials: 'include', ...(body === undefined ? {} : { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || 'The office-work result was not confirmed.');
  return value as T;
}

export function ServiceWatchPanel({ obligationId, editable, onOpenCare, onClose, onChanged }: { obligationId: string; editable: boolean; onOpenCare: () => void; onClose: () => void; onChanged: () => Promise<void> }) {
  const [data, setData] = useState<WatchDetail | null>(null), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [reviewNeeded, setReviewNeeded] = useState(false);
  const [owner, setOwner] = useState(''), [note, setNote] = useState(''), [deadline, setDeadline] = useState(''), [reviewed, setReviewed] = useState(false);
  const { data: users, isError: usersError } = useListUsers({ query: { queryKey: getListUsersQueryKey(), enabled: editable } });
  const sequence = useRef(0), key = useRef(obligationId); key.current = obligationId;
  async function refresh() {
    const run = ++sequence.current, id = obligationId; setLoading(true);
    try {
      const result = await request<WatchDetail>(`service-obligations/${id}/watch`);
      if (run !== sequence.current || id !== key.current) return;
      setData(result); setOwner(result.assignedUserId ?? ''); setNote(result.nextAction ?? ''); setDeadline(localDateTime(result.nextActionAt));
      setReviewed(false); setReviewNeeded(false); setError('');
    } catch (cause) {
      if (run === sequence.current && id === key.current) { setError(cause instanceof Error ? cause.message : 'Service watch is unavailable.'); setReviewNeeded(true); }
    } finally { if (run === sequence.current && id === key.current) setLoading(false); }
  }
  useEffect(() => { setData(null); void refresh(); return () => { ++sequence.current; }; }, [obligationId]);
  async function save(action: 'assign' | 'acknowledge') {
    if (!data || busy || loading || reviewNeeded || data.held || !editable) return;
    setBusy(true); setNotice('');
    try {
      await request(`service-obligations/${obligationId}/watch`, { action, requestId: crypto.randomUUID(), expectedVersion: data.expectedVersion, expectedFingerprint: data.expectedFingerprint,
        assignedUserId: owner, note, ...(action === 'acknowledge' ? { nextActionAt: new Date(deadline).toISOString(), reviewed: true } : {}) });
      await refresh(); await onChanged(); setNotice('Office plan saved. No customer message, reply, booking or service completion was created.');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Save was not confirmed.'); setReviewNeeded(true); setReviewed(false); }
    finally { setBusy(false); }
  }
  const disabled = loading || busy || reviewNeeded || !editable || !!data?.held;
  return <section aria-label="Service watch detail" className="min-w-0 space-y-3 rounded-xl border bg-card p-3 sm:p-4">
    <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="font-semibold">Service watch — office follow-up</h2><button className={button} onClick={onClose}>Close watch</button></div>
    <p className="text-sm text-muted-foreground">An office plan is not a customer response. Keep the actual customer conversation, visit and completion in Customer care & booking.</p>
    {notice && <p role="status">{notice}</p>}{error && <p role="alert">{error}</p>}
    {reviewNeeded && <p>Refresh and review the current source and saved plan before another change. No automatic retry was made.</p>}
    <button className={button} disabled={busy || loading} onClick={() => void refresh()}>Refresh and review watch</button>
    {loading && <p>Loading service watch…</p>}
    {!loading && data && <>
      <p className="break-words font-medium">{data.customerLabel} · {data.equipmentLabel}</p><p>Due {data.dueDate} · {states[data.state] ?? 'Review required'}</p>
      {data.held && <p>Company work is paused or held. No service notification or office-plan change is authorized here.</p>}
      {data.monitorPending && <p className="text-sm">Current source differs from the last monitor snapshot. This view shows the current facts; scheduled notifications may still need reconciliation.</p>}
      {data.timezoneFallback && <p>Company service timezone is not configured; date comparisons use UTC.</p>}
      {data.reasons.length > 0 && <ul className="list-disc space-y-1 pl-5">{data.reasons.map(reason => <li key={reason}>{label(reason)}</li>)}</ul>}
      {data.nextAction && <div className="rounded-lg border p-3"><p className="whitespace-pre-wrap break-words">Recorded office plan: {data.nextAction}</p>{data.nextActionAt && <p>Next action: {new Date(data.nextActionAt).toLocaleString()} ({scheduleTimezone})</p>}</div>}
      <button className={button} onClick={onOpenCare}>Open customer care & booking</button>
      {editable && data.reasons.length > 0 && <form className="space-y-3 border-t pt-3" onSubmit={event => { event.preventDefault(); if (reviewed) void save('acknowledge'); }}>
        <label className="block text-sm">Responsible staff<select className={field} required disabled={disabled} value={owner} onChange={event => { setOwner(event.target.value); setReviewed(false); }}><option value="">Choose accepted staff</option>{users?.filter(canAssignWork).map(user => <option key={user.id} value={user.id}>{`${user.firstName ?? ''} ${user.lastName ?? ''}`.trim() || user.email}</option>)}</select></label>
        {usersError && <p role="alert">Accepted staff could not be loaded. Refresh before saving.</p>}
        <label className="block text-sm">Office next action / assignment note<textarea className={field} disabled={disabled} minLength={10} maxLength={1000} required value={note} onChange={event => { setNote(event.target.value); setReviewed(false); }} /></label>
        <button type="button" className={button} disabled={disabled || usersError || !owner || note.trim().length < 10} onClick={() => void save('assign')}>Assign responsible staff only</button>
        <label className="block text-sm">Office follow-up deadline ({scheduleTimezone})<input className={field} disabled={disabled} type="datetime-local" required value={deadline} onChange={event => { setDeadline(event.target.value); setReviewed(false); }} /></label>
        <p className="text-sm">Choose a future time within 30 days. Missing that time reopens attention; this does not postpone the actual service date or claim the customer agreed.</p>
        <label className="flex items-start gap-2 text-sm"><input className="mt-1" type="checkbox" disabled={disabled} checked={reviewed} onChange={event => setReviewed(event.target.checked)} />I reviewed these current exceptions and will take the stated office action by this time.</label>
        <button className={button} disabled={disabled || usersError || !owner || !deadline || !reviewed || note.trim().length < 10}>Acknowledge and save office plan</button>
      </form>}
      <details><summary className="cursor-pointer">Retained watch history ({data.history.length}{data.historyHasMore ? '+' : ''})</summary>
        {data.history.length === 0 ? <p>No watch transitions recorded yet.</p> : <ol className="mt-2 space-y-3">{data.history.map(event => <li key={event.id} className="border-l pl-3 text-sm"><p>{event.action.replace('service.watch_', '').replaceAll('_', ' ')} · {new Date(event.createdAt).toLocaleString()}</p>{event.metadata.state && <p>{states[event.metadata.state] ?? event.metadata.state}</p>}{event.metadata.reasons?.length ? <p>{event.metadata.reasons.map(label).join('; ')}</p> : null}{event.metadata.note && <p className="whitespace-pre-wrap break-words">{event.metadata.note}</p>}</li>)}</ol>}
        {data.historyHasMore && <p>Only the latest 50 transitions are shown; older retained audit evidence is not deleted.</p>}
      </details>
    </>}
  </section>;
}

type WatchList = { items: { id: string; serviceObligationId: string; state: string; reasons: string[]; customerLabel: string; equipmentLabel: string; dueDate: string; assignedUserId: string | null; updatedAt: string }[]; hasMore: boolean; unmonitoredCount: number; held: boolean };
export function ServiceWatchQueue({ organizationId, revision, onOpen }: { organizationId: string; revision: number; onOpen: (id: string) => void }) {
  const [scope, setScope] = useState('attention'), [offset, setOffset] = useState(0), [data, setData] = useState<WatchList | null>(null);
  const [loading, setLoading] = useState(true), [error, setError] = useState('');
  const sequence = useRef(0), key = useRef(''); key.current = `${organizationId}:${scope}:${offset}:${revision}`;
  async function refresh() {
    const run = ++sequence.current, view = key.current; setLoading(true);
    try { const value = await request<WatchList>(`service-watch?scope=${scope}&offset=${offset}`); if (!Array.isArray(value.items)) throw new Error('Service watch is unavailable.'); if (run === sequence.current && view === key.current) { setData(value); setError(''); } }
    catch (cause) { if (run === sequence.current && view === key.current) setError(cause instanceof Error ? cause.message : 'Service watch is unavailable.'); }
    finally { if (run === sequence.current && view === key.current) setLoading(false); }
  }
  useEffect(() => { setData(null); void refresh(); return () => { ++sequence.current; }; }, [organizationId, scope, offset, revision]);
  return <section aria-label="Service watch queue" className="min-w-0 space-y-3 rounded-xl border bg-card p-3 sm:p-4">
    <h2 className="font-semibold">MAINTAIN · Service watch</h2><p className="text-sm text-muted-foreground">Accountable office follow-up from recorded service facts. No automatic customer replies or bookings. Phone alerts require separate service-alert opt-in and an accepted owner's working device.</p>
    <div className="flex flex-wrap gap-2"><label className="min-w-0 text-sm">Watch records<select className={field} value={scope} onChange={event => { setScope(event.target.value); setOffset(0); }}><option value="attention">Needs attention / office plan / held</option><option value="history">Resolved history</option></select></label><button className={button} disabled={loading} onClick={() => void refresh()}>Refresh watch queue</button></div>
    {loading ? <p>Loading watch queue…</p> : error ? <p role="alert">{error} No empty-queue conclusion is available.</p> : data && <>
      {data.held && <p>Company work is paused. Retained records remain visible; notifications and office-plan changes stay held.</p>}
      {data.unmonitoredCount > 0 && <p>{data.unmonitoredCount} active services await their first bounded monitor check. An empty queue is not an all-clear.</p>}
      {data.items.length === 0 ? <p>{scope === 'history' ? 'No resolved watch history on this page.' : 'No recorded watch exceptions on this page.'}</p> : <ul className="space-y-2">{data.items.map(row => <li key={row.id} className="flex min-w-0 flex-wrap items-start justify-between gap-3 rounded-lg border p-3"><div className="min-w-0 flex-1 break-words"><p className="font-medium">{row.customerLabel} · {row.equipmentLabel}</p><p>{states[row.state]} · Due {row.dueDate} · {row.assignedUserId ? 'Staff assigned' : 'Owner needed'}</p><p className="text-sm">{row.reasons.map(label).join('; ')}</p></div><button className={button} onClick={() => onOpen(row.serviceObligationId)}>Review service watch</button></li>)}</ul>}
      <p className="text-sm">Up to 50 records per page. {data.hasMore ? 'More records are available.' : 'End of this filtered queue.'}</p>
      <div className="flex flex-wrap gap-2"><button className={button} disabled={offset === 0} onClick={() => setOffset(value => Math.max(0, value - 50))}>Previous watch page</button><button className={button} disabled={!data.hasMore || offset >= 100_000} onClick={() => setOffset(value => value + 50)}>Next watch page</button></div>
      {data.hasMore && offset >= 100_000 && <p>The supported paging limit has been reached. Request an operator's scoped export; further records are not displayed.</p>}
    </>}
  </section>;
}
