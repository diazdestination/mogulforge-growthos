import { useEffect, useRef, useState } from "react";
import { Link } from 'wouter';
import ContactSelect from '@/components/contact-select';
type Call = {
  id: string;
  direction: string;
  phone: string;
  status: string;
  dialStatus: string | null;
  contactId: string | null;
  callieIntakeId?: string | null;
};
type Handoff = { callId: string; taskId: string; contactId: string | null; leadId: string | null; reviewedAt: string | null };
export function VoiceDesk({ onReviewed, canEdit = true }: { onReviewed?: () => void; canEdit?: boolean } = {}) {
  const [calls, setCalls] = useState<Call[]>([]),
    [handoffs, setHandoffs] = useState<Handoff[]>([]),
    [enabled, setEnabled] = useState(false),
    [contact, setContact] = useState(""),
    [requested, setRequested] = useState(false),
    [busy, setBusy] = useState(false),
    [selectedCall, setSelectedCall] = useState<Call | null>(null),
    [reviewMode, setReviewMode] = useState<'link_contact' | 'create_opportunity'>('create_opportunity'),
    [reviewContactId, setReviewContactId] = useState(''),
    [reviewFirstName, setReviewFirstName] = useState(''),
    [reviewServiceType, setReviewServiceType] = useState(''),
    [message, setMessage] = useState("");
  const operation = useRef(crypto.randomUUID());
  const reviewRequest = useRef(crypto.randomUUID());
  const mounted = useRef(true), generation = useRef(0);
  async function refresh() {
    const run = ++generation.current;
    try {
      const response = await fetch("/api/v1/communications/voice", {
        credentials: "include",
      });
      if (!response.ok) throw new Error();
      const state = await response.json();
      if (!mounted.current || run !== generation.current) return;
      setCalls(state.calls);
      setHandoffs(state.handoffs ?? []);
      setEnabled(state.enabled);
    } catch {
      if (mounted.current && run === generation.current) setMessage("Calling status could not be loaded.");
    }
  }
  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => { mounted.current = false; generation.current++; };
  }, []);
  async function call() {
    setBusy(true);
    try {
      const response = await fetch("/api/v1/communications/voice", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contactId: contact,
          requestedByContact: requested,
          requestId: operation.current,
        }),
      });
      const data = await response.json();
      if (!response.ok)
        throw new Error(
          data.error ?? "Call not confirmed. Review the call log.",
        );
      if (!mounted.current) return;
      setMessage(
        `Call operation: ${data.status}. Answer the approved staff phone and press 1 to connect. This does not confirm the customer answered.`,
      );
      operation.current = crypto.randomUUID();
      setRequested(false);
    } catch (error) {
      if (mounted.current) setMessage(
        error instanceof Error ? error.message : "Call not confirmed.",
      );
    } finally {
      if (mounted.current) { setBusy(false); await refresh(); if (mounted.current) onReviewed?.(); }
    }
  }
  async function reviewMissedCall() {
    if (!selectedCall) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/v1/communications/voice/${selectedCall.id}/review`, {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(reviewMode === 'link_contact'
          ? { action: reviewMode, requestId: reviewRequest.current, contactId: reviewContactId }
          : {
              action: reviewMode, requestId: reviewRequest.current,
              ...(reviewContactId ? { contactId: reviewContactId } : { firstName: reviewFirstName }),
              ...(reviewServiceType ? { serviceType: reviewServiceType } : {}),
            }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error === 'callie_review_required' ? 'Open this call in the CALLIE office desk to review its current request.' : result.error === 'choose_existing_contact'
        ? 'This phone matches an existing customer. Select that contact before creating an opportunity.'
        : result.error || 'Review could not be saved.');
      if (!mounted.current) return;
      setMessage(reviewMode === 'create_opportunity'
        ? 'Opportunity and callback task are linked. No text or campaign was sent.'
        : 'Customer linked to the callback task. No text was sent.');
      setSelectedCall(null);
      reviewRequest.current = crypto.randomUUID();
      await refresh();
      if (mounted.current) onReviewed?.();
    } catch (error) {
      if (mounted.current) setMessage(error instanceof Error ? error.message : 'Review could not be saved.');
    } finally { if (mounted.current) setBusy(false); }
  }
  return (
    <section
      className="rounded-lg border bg-card p-5 space-y-3"
      aria-label="Business calls"
    >
      <div className="flex justify-between">
        <h3 className="font-semibold">Business calls</h3>
        <button
          type="button"
          className="underline text-sm"
          onClick={() => void refresh()}
        >
          Refresh calls
        </button>
      </div>
      <p className="text-sm">
        Start a requested call from GrowthOS. Audio uses the approved staff
        phone, then connects to the contact. Both call legs can incur charges.
        Calls are limited to five minutes.
      </p>
      {!enabled && (
        <p className="text-sm text-muted-foreground">
          Calling is disabled until the sender, staff phone, geographic
          permissions and usage allowance are approved.
        </p>
      )}
      <label className="block text-sm">
        Contact record ID
        <input
          className="block border rounded p-2 w-full"
          value={contact}
          onChange={(event) => setContact(event.target.value)}
        />
      </label>
      <label className="flex gap-2 text-sm">
        <input
          type="checkbox"
          checked={requested}
          onChange={(event) => setRequested(event.target.checked)}
        />
        This contact asked us to call this number. I authorize this call.
      </label>
      <button
        type="button"
        className="border rounded px-4 py-2 disabled:opacity-50"
        disabled={!canEdit || !enabled || !contact || !requested || busy}
        onClick={() => void call()}
      >
        Call through staff phone
      </button>
      {message && (
        <p role="status" className="text-sm">
          {message}
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        No call recording or emergency calling. Missed calls create a staff
        callback task. Customer texts require the separately approved recovery
        policy, a reviewed caller and current SMS consent. A call does not grant SMS consent.
      </p>
      <ul className="text-sm space-y-2">
        {calls.map((item) => (
          <li key={item.id}>
            {item.direction} · {item.phone} · {item.status}
            {item.dialStatus ? ` · connection: ${item.dialStatus}` : ""}
            {handoffs.some(handoff => handoff.callId === item.id) && (
              <span className="ml-2">
                · <Link href="/tasks" className="underline">Callback task</Link>
                {handoffs.find(handoff => handoff.callId === item.id)?.reviewedAt ? ' · reviewed' : ' · needs review'}
              </span>
            )}
            {item.callieIntakeId && <Link className="ml-2 underline" href={`/calls?callieId=${item.callieIntakeId}`}>Open CALLIE office request</Link>}
            {!item.callieIntakeId && canEdit && handoffs.some(handoff => handoff.callId === item.id && !handoff.reviewedAt) && (
              <button type="button" className="underline ml-2" onClick={() => {
                setSelectedCall(item); setReviewContactId(item.contactId ?? '');
                setReviewMode('create_opportunity'); setReviewFirstName(''); setReviewServiceType('');
                reviewRequest.current = crypto.randomUUID();
              }}>Review missed call</button>
            )}
            {item.contactId && (
              <button
                type="button"
                className="underline ml-2"
                onClick={() => {
                  setContact(item.contactId!);
                  setRequested(false);
                }}
              >
                Select contact
              </button>
            )}
          </li>
        ))}
      </ul>
      {selectedCall && <div className="rounded-lg border p-3 space-y-3" aria-label="Review missed call">
        <h4 className="font-medium">Review missed call from {selectedCall.phone}</h4>
        <p className="text-xs text-muted-foreground">The callback task already exists. Choose whether to link a customer or create a sales opportunity.</p>
        <label className="block text-sm">Action<select className="block w-full rounded border p-2" value={reviewMode} onChange={event => setReviewMode(event.target.value as typeof reviewMode)}>
          <option value="create_opportunity">Create opportunity</option>
          <option value="link_contact">Link existing customer only</option>
        </select></label>
        <label className="block text-sm">Existing customer (if known)<ContactSelect value={reviewContactId} onChange={setReviewContactId} testId="missed-call-contact" /></label>
        {reviewMode === 'create_opportunity' && !reviewContactId && <label className="block text-sm">Caller first name<input className="block w-full rounded border p-2" value={reviewFirstName} maxLength={100} onChange={event => setReviewFirstName(event.target.value)} /></label>}
        {reviewMode === 'create_opportunity' && <label className="block text-sm">Service needed (optional)<input className="block w-full rounded border p-2" value={reviewServiceType} maxLength={100} onChange={event => setReviewServiceType(event.target.value)} /></label>}
        <div className="flex gap-2">
          <button type="button" disabled={busy || (reviewMode === 'link_contact' && !reviewContactId) || (reviewMode === 'create_opportunity' && !reviewContactId && !reviewFirstName.trim())} className="rounded bg-primary px-3 py-2 text-primary-foreground disabled:opacity-50" onClick={() => void reviewMissedCall()}>Save review</button>
          <button type="button" className="rounded border px-3 py-2" onClick={() => setSelectedCall(null)}>Close</button>
        </div>
      </div>}
    </section>
  );
}
