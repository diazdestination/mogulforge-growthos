import { useEffect, useRef, useState } from 'react';
import { getListUsersQueryKey, useListUsers } from '@workspace/api-client-react';
import { canAssignWork, localDateTime, scheduleTimezone } from '@/lib/contractor-schedule';
import ServiceMailboxRepliesPanel from './service-mailbox-replies-panel';

type Preview = { channel: 'email' | 'sms'; recipient: string; subject: string; body: string; fingerprint: string; runAt: string; sender: { senderEmail: string; provider: string } | null };
type Care = {
  expectedUpdatedAt: string; active: boolean; preview: Preview | null; blockReason: string | null; deferredReason: string | null;
  reminder: { state: string; channel: string; recipient: string; subject: string; body: string; agreementNote: string; runAt: string | null; detail: string | null; providerEvidence: { provider?: string; providerMessageId?: string | null; providerRequestId?: string } | null; deliveryConfirmed: false } | null;
  response: { id: string; outcome: 'ready_to_book' | 'follow_up' | 'declined'; note: string; respondedAt: string; channel: string } | null;
  booking: { responseId: string } | null;
  appointment: { id: string; status: string; scheduledStart: string; scheduledEnd: string | null } | null;
};
const field = 'mt-1 block min-h-11 w-full min-w-0 rounded-lg border bg-background p-2 text-base';
const button = 'min-h-11 rounded-lg border px-4 py-2 text-sm font-medium disabled:opacity-50';
const stateLabel: Record<string, string> = { pending: 'Queued — not sent yet', succeeded: 'Provider accepted — delivery unconfirmed', processing: 'Dispatch in progress — do not resend', indeterminate: 'Unknown send result — operator reconciliation required', blocked: 'Held before dispatch — review required', cancelled: 'Cancelled before dispatch', confirmed_succeeded: 'Operator reconciled as performed', confirmed_not_performed: 'Operator reconciled as not performed — no automatic resend', failed: 'Preparation failed — operator review required' };
async function request<T>(path: string, body?: unknown): Promise<T> {
  const result = await fetch(`/api/v1/service-obligations/${path}`, { credentials: 'include', ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
  const value = await result.json();
  if (!result.ok) throw new Error(value.error || 'The service-care result was not confirmed.');
  return value as T;
}

export default function ServiceCarePanel({ obligationId, editable, onChanged, onClose }: { obligationId: string; editable: boolean; onChanged: () => Promise<void>; onClose: () => void }) {
  const [channel, setChannel] = useState<'email' | 'sms'>('email');
  const [showReplies, setShowReplies] = useState(false);
  const [care, setCare] = useState<Care | null>(null);
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [reviewNeeded, setReviewNeeded] = useState(false);
  const [notice, setNotice] = useState(''), [error, setError] = useState('');
  const [agreement, setAgreement] = useState(''), [agreedService, setAgreedService] = useState(false);
  const [responseNote, setResponseNote] = useState(''), [responseChannel, setResponseChannel] = useState('phone'), [outcome, setOutcome] = useState('ready_to_book');
  const [respondedAt, setRespondedAt] = useState(localDateTime(new Date().toISOString())), [attested, setAttested] = useState(false);
  const [start, setStart] = useState(''), [end, setEnd] = useState(''), [assignee, setAssignee] = useState(''), [visitType, setVisitType] = useState('inspection'), [confirmed, setConfirmed] = useState(false);
  const { data: users, isError: usersError } = useListUsers({ query: { queryKey: getListUsersQueryKey(), enabled: editable } });
  const sequence = useRef(0);
  const currentKey = useRef(`${obligationId}:${channel}`);
  currentKey.current = `${obligationId}:${channel}`;
  async function refresh() {
    const run = ++sequence.current, key = `${obligationId}:${channel}`;
    setLoading(true);
    try {
      const value = await request<Care>(`${obligationId}/care?channel=${channel}`);
      if (run !== sequence.current || key !== currentKey.current) return;
      setCare(value); setReviewNeeded(false); setError('');
      // A refresh is an explicit new review, never an automatic approval of a
      // replacement version, recipient, sender, response, or booked window.
      setAgreedService(false); setAttested(false); setConfirmed(false);
    } catch (e) {
      if (run !== sequence.current || key !== currentKey.current) return;
      setCare(null); setReviewNeeded(true); setError(e instanceof Error ? e.message : 'Customer care is unavailable.');
    } finally { if (run === sequence.current && key === currentKey.current) setLoading(false); }
  }
  useEffect(() => { setCare(null); void refresh(); return () => { ++sequence.current; }; }, [obligationId, channel]);
  async function perform(suffix: string, details: Record<string, unknown>, message: string) {
    if (!care || !editable || busy || reviewNeeded) return;
    setBusy(true); setError(''); setNotice('');
    try {
      await request(`${obligationId}/care/${suffix}`, { requestId: crypto.randomUUID(), expectedUpdatedAt: care.expectedUpdatedAt, ...details });
      setNotice(message);
      await refresh(); await onChanged();
    } catch (e) {
      setReviewNeeded(true);
      setError(`${e instanceof Error ? e.message : 'The result was not confirmed.'} Refresh and review the saved receipt before another action. No automatic retry was made.`);
    } finally { setBusy(false); }
  }
  const disabled = busy || loading || reviewNeeded || !editable;
  const booked = care?.appointment && ['scheduled', 'confirmed'].includes(care.appointment.status);
  const freshResponse = care?.response?.outcome === 'ready_to_book' && care.booking?.responseId !== care.response.id;
  return <section className="mt-3 w-full min-w-0 space-y-4 border-t pt-4" aria-label="Service customer care">
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-lg font-semibold">Customer care → office booking</h3><div className="flex flex-wrap gap-2"><button type="button" disabled={busy || loading} className={button} onClick={() => void refresh()}>Refresh and review</button><button type="button" disabled={busy} className={button} onClick={onClose}>Close customer care</button></div></div>
    <p className="text-sm text-muted-foreground">One reviewed reminder for this service. Supported original-mailbox replies need office review; other conversations remain staff-recorded. This is not self-booking. Completion remains a separate service action.</p>
    <button type="button" className={button} onClick={() => setShowReplies(value => !value)}>{showReplies ? 'Hide mailbox reply evidence' : 'Review mailbox reply evidence'}</button>
    {showReplies && <ServiceMailboxRepliesPanel key={obligationId} obligationId={obligationId} editable={editable} onChanged={async () => { await refresh(); await onChanged(); }} />}
    {notice && <p role="status" className="rounded-lg border p-3">{notice}</p>}
    {error && <p role="alert" className="rounded-lg border border-destructive p-3">{error}</p>}
    {loading && <p>Loading customer-care record…</p>}
    {!loading && care && <>
      {care.reminder ? <div className="space-y-2 rounded-lg border p-3">
        <h4 className="font-semibold">{stateLabel[care.reminder.state] ?? 'Receipt requires operator review'}</h4>
        <p>{care.reminder.channel.toUpperCase()} · {care.reminder.recipient}</p>
        {care.reminder.state === 'pending' && care.reminder.runAt && <p>Next eligible check: {new Date(care.reminder.runAt).toLocaleString()} ({scheduleTimezone})</p>}
        {care.reminder.detail && <p>{care.reminder.detail}</p>}
        {care.deferredReason && <p>{care.deferredReason}</p>}
        {care.blockReason && care.reminder.state === 'pending' && <p>Current hold: {care.blockReason}</p>}
        <details><summary className="cursor-pointer">Reviewed message and agreement</summary><p className="mt-2 font-medium">{care.reminder.subject}</p><p className="whitespace-pre-wrap break-words">{care.reminder.body}</p><p className="mt-2">Review note: {care.reminder.agreementNote}</p></details>
        {care.reminder.providerEvidence && <p className="break-all text-xs">Provider: {care.reminder.providerEvidence.provider ?? 'recorded'} · {care.reminder.providerEvidence.providerMessageId ? `Message receipt: ${care.reminder.providerEvidence.providerMessageId}` : 'No provider message ID returned.'} {care.reminder.providerEvidence.providerRequestId ? `Request correlation: ${care.reminder.providerEvidence.providerRequestId}` : ''} Provider acceptance is not delivery or a customer response.</p>}
        <p className="text-xs text-muted-foreground">This occurrence cannot be automatically resent through a new request or another channel. Unknown results require operator reconciliation.</p>
      </div> : care.active && !booked && <form className="space-y-3 rounded-lg border p-3" onSubmit={event => { event.preventDefault(); if (care.preview && agreedService) void perform('reminder', { channel, previewFingerprint: care.preview.fingerprint, agreementNote: agreement, expectedServiceConfirmed: true }, 'One reminder approved and queued. No delivery or booking is claimed.'); }}>
        <h4 className="font-semibold">1. Review one expected-service reminder</h4>
        <label className="block text-sm">Reminder channel<select className={field} value={channel} disabled={disabled} onChange={event => { setAgreedService(false); setChannel(event.target.value as 'email' | 'sms'); }}><option value="email">Email</option><option value="sms">SMS (approved customer-care consent required)</option></select></label>
        {care.blockReason && <p role="status">{care.blockReason}</p>}
        {care.deferredReason && <p>{care.deferredReason}</p>}
        {care.preview && <><p className="break-words">To: {care.preview.recipient}{care.preview.sender && <> · From: {care.preview.sender.senderEmail} ({care.preview.sender.provider})</>}</p><p className="font-medium">{care.preview.subject}</p><p className="whitespace-pre-wrap break-words rounded-lg bg-muted p-3">{care.preview.body}</p><p className="text-sm">Not before: {new Date(care.preview.runAt).toLocaleString()} ({scheduleTimezone}). Current contact policy, sending hours and activation are checked again at dispatch.</p></>}
        {editable && <><label className="block text-sm">Current service agreement / customer expectation evidence<textarea className={field} required minLength={10} maxLength={1000} value={agreement} onChange={event => setAgreement(event.target.value)} /></label><label className="flex items-start gap-2"><input type="checkbox" checked={agreedService} disabled={disabled || !care.preview} onChange={event => setAgreedService(event.target.checked)} className="mt-1" />I reviewed this exact message and recipient against the current service agreement. This does not grant marketing or SMS consent.</label><button disabled={disabled || !care.preview || !agreedService || agreement.trim().length < 10 || !!care.response} className={button}>Approve one reminder</button></>}
      </form>}
      {care.response && <div className="rounded-lg border p-3"><h4 className="font-semibold">Latest staff-recorded response</h4><p>{care.response.outcome.replaceAll('_', ' ')} · {care.response.channel.replaceAll('_', ' ')} · {new Date(care.response.respondedAt).toLocaleString()}</p><p className="whitespace-pre-wrap break-words">{care.response.note}</p><p className="text-xs text-muted-foreground">Staff attestation — not independently verified inbox evidence.</p></div>}
      {care.appointment && <p className="rounded-lg border p-3">Office appointment: {care.appointment.status.replaceAll('_', ' ')} · {new Date(care.appointment.scheduledStart).toLocaleString()} ({scheduleTimezone}). Manage changes in Appointments. A cancelled or missed visit requires a fresh customer confirmation before rebooking.</p>}
      {editable && care.active && <form className="space-y-3 border-t pt-4" onSubmit={event => { event.preventDefault(); if (attested) void perform('response', { channel: responseChannel, outcome, respondedAt: new Date(respondedAt).toISOString(), note: responseNote, staffAttested: true }, 'Customer response recorded as a staff attestation. Unclaimed service reminders were cancelled; any unknown send receipt is preserved.'); }}>
        <h4 className="font-semibold">2. Record the customer conversation</h4><p className="text-sm text-muted-foreground">Use the actual conversation, including a reply you reviewed in the connected mailbox. This does not release other outreach holds or automatically cancel an existing appointment.</p>
        <div className="grid gap-3 sm:grid-cols-2"><label className="min-w-0 text-sm">Response channel<select className={field} value={responseChannel} onChange={event => setResponseChannel(event.target.value)}><option value="phone">Phone conversation</option><option value="email">Email reviewed by staff</option><option value="sms">Text reviewed by staff</option><option value="in_person">In person</option></select></label><label className="min-w-0 text-sm">Response time ({scheduleTimezone})<input className={field} type="datetime-local" required value={respondedAt} onChange={event => setRespondedAt(event.target.value)} /></label></div>
        <label className="block text-sm">Customer outcome<select className={field} value={outcome} onChange={event => setOutcome(event.target.value)}><option value="ready_to_book">Ready to arrange the visit</option><option value="follow_up">Office follow-up needed</option><option value="declined">Declined this service</option></select></label>
        <label className="block text-sm">Conversation and agreed next step<textarea className={field} required minLength={10} maxLength={1000} value={responseNote} onChange={event => setResponseNote(event.target.value)} /></label>
        <label className="flex items-start gap-2"><input type="checkbox" className="mt-1" disabled={disabled} checked={attested} onChange={event => setAttested(event.target.checked)} />I reviewed the actual customer response and am recording it as staff evidence.</label>
        <button className={button} disabled={disabled || !attested || !respondedAt || responseNote.trim().length < 10}>Record customer response</button>
      </form>}
      {editable && care.active && !booked && <form className="space-y-3 border-t pt-4" onSubmit={event => { event.preventDefault(); if (care.response && confirmed) void perform('book', { responseId: care.response.id, assignedUserId: assignee, type: visitType, scheduledStart: new Date(start).toISOString(), scheduledEnd: new Date(end).toISOString(), customerConfirmed: true }, 'Office-confirmed appointment booked and linked. The normal appointment-reminder policy applies; service completion is still separate.'); }}>
        <h4 className="font-semibold">3. Book the customer-confirmed visit</h4>
        {!freshResponse && <p>Record a fresh “Ready to arrange the visit” response before booking.</p>}
        <div className="grid gap-3 sm:grid-cols-2"><label className="min-w-0 text-sm">Visit starts ({scheduleTimezone})<input className={field} type="datetime-local" required value={start} onChange={event => { setStart(event.target.value); setConfirmed(false); }} /></label><label className="min-w-0 text-sm">Visit ends ({scheduleTimezone})<input className={field} type="datetime-local" required value={end} onChange={event => { setEnd(event.target.value); setConfirmed(false); }} /></label></div>
        <div className="grid gap-3 sm:grid-cols-2"><label className="min-w-0 text-sm">Assigned team member<select className={field} required value={assignee} onChange={event => { setAssignee(event.target.value); setConfirmed(false); }}><option value="">Choose accepted staff</option>{users?.filter(canAssignWork).map(user => <option key={user.id} value={user.id}>{`${user.firstName ?? ''} ${user.lastName ?? ''}`.trim() || user.email}</option>)}</select></label><label className="min-w-0 text-sm">Visit type<select className={field} value={visitType} onChange={event => { setVisitType(event.target.value); setConfirmed(false); }}><option value="inspection">Inspection / warranty check (capacity checked)</option><option value="other">Other service visit (staff conflicts checked)</option></select></label></div>
        {usersError && <p role="alert">Team members could not be loaded. Refresh before booking.</p>}
        <label className="flex items-start gap-2"><input type="checkbox" className="mt-1" checked={confirmed} disabled={disabled || !freshResponse} onChange={event => setConfirmed(event.target.checked)} />The customer confirmed this exact time and the office has reviewed the assignment. This does not mark the service complete.</label>
        <button className={button} disabled={disabled || usersError || !freshResponse || !confirmed || !start || !end || !assignee}>Book confirmed visit</button>
      </form>}
    </>}
  </section>;
}
