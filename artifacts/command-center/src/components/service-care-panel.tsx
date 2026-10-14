import { useEffect, useRef, useState } from 'react';
import {
  bookServiceCareVisit,
  getListUsersQueryKey,
  useListUsers,
  useGetMe,
} from "@workspace/api-client-react";
import { z } from "zod";
import {
  serviceCareBookingSchema,
  serviceCareBookingResultSchema,
  serviceCareBookingOutcomeSchema,
  serviceCareSchedulingReadSchema,
  careCanonicalJson,
  type ServiceCareBookingInput,
  type ServiceCareBookingOutcome,
  type ServiceCareSchedulingRead,
} from "../../../api-server/src/services/service-care-booking-contract";
import {
  useSchedulingAuthority,
  useSchedulingContext,
  useSchedulingReview,
} from "@/hooks/use-scheduling-review";
import { freezeSchedulingValue } from "@/lib/scheduling-command";
import { sameCustomerWorkId } from "@/hooks/use-customer-work-command";
import { SchedulingIntervalFields } from "./scheduling-interval-fields";
import { SchedulingIntervalReview } from "./scheduling-interval-review";
import { canAssignWork, localDateTime, scheduleTimezone } from '@/lib/contractor-schedule';
import ServiceMailboxRepliesPanel from './service-mailbox-replies-panel';
import ServiceSmsRepliesPanel from './service-sms-replies-panel';
import ServiceStandingRemindersPanel from './service-standing-reminders-panel';

type Preview = { channel: 'email' | 'sms'; recipient: string; subject: string; body: string; fingerprint: string; runAt: string; sender: { senderEmail: string; provider: string } | null };
type Care = {
  scheduling?: unknown;
  expectedUpdatedAt: string;
  active: boolean;
  preview: Preview | null;
  blockReason: string | null;
  deferredReason: string | null;
  reminder: { state: string; channel: string; recipient: string; subject: string; body: string; agreementNote: string; origin?: 'individual' | 'standing'; policyRevisionId?: string | null; runAt: string | null; detail: string | null; providerEvidence: { provider?: string; providerMessageId?: string | null; providerRequestId?: string } | null; deliveryConfirmed: false } | null;
  response: { id: string; outcome: 'ready_to_book' | 'follow_up' | 'declined'; note: string; respondedAt: string; channel: string } | null;
  booking: { responseId: string } | null;
  appointment: { id: string; status: string; scheduledStart: string; scheduledEnd: string | null } | null;
};
const field = 'mt-1 block min-h-11 w-full min-w-0 rounded-lg border bg-background p-2 text-base';
const button = 'min-h-11 rounded-lg border px-4 py-2 text-sm font-medium disabled:opacity-50';
const stateLabel: Record<string, string> = { pending: 'Queued — not sent yet', succeeded: 'Provider accepted — delivery unconfirmed', processing: 'Dispatch in progress — do not resend', indeterminate: 'Unknown send result — operator reconciliation required', blocked: 'Held before dispatch — review required', cancelled: 'Cancelled before dispatch', confirmed_succeeded: 'Operator reconciled as performed', confirmed_not_performed: 'Operator reconciled as not performed — no automatic resend', failed: 'Preparation failed — operator review required' };
const careCustodySchema = z.strictObject({
  formatVersion: z.literal(1),
  organizationId: z.uuid(),
  actorUserId: z.string().min(1),
  obligationId: z.uuid(),
  body: z.record(z.string(), z.unknown()),
  hash: z.string().regex(/^[a-f0-9]{64}$/),
  outcome: serviceCareBookingOutcomeSchema.nullable(),
  retiredRequestIds: z.array(z.uuid()).optional(),
  completed: z
    .array(
      z.strictObject({
        body: z.record(z.string(), z.unknown()),
        hash: z.string().regex(/^[a-f0-9]{64}$/),
        outcome: serviceCareBookingOutcomeSchema,
      }),
    )
    .optional(),
});
type CareCustody = z.infer<typeof careCustodySchema>;
async function careHash(raw: unknown) {
  const bytes = new TextEncoder().encode(
    careCanonicalJson(serviceCareBookingSchema.parse(raw)),
  );
  return Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    (n) => n.toString(16).padStart(2, "0"),
  ).join("");
}
function careProof(custody: CareCustody, proof: ServiceCareBookingOutcome) {
  const body = serviceCareBookingSchema.parse(custody.body);
  if (
    !sameCustomerWorkId(proof.organizationId, custody.organizationId) ||
    proof.actorUserId !== custody.actorUserId ||
    !sameCustomerWorkId(proof.obligationId, custody.obligationId) ||
    !sameCustomerWorkId(proof.requestId, body.requestId) ||
    proof.requestFingerprint !== custody.hash ||
    !sameCustomerWorkId(proof.responseId, body.responseId) ||
    proof.expectedUpdatedAt !== body.expectedUpdatedAt
  )
    throw new Error("Original Service Care booking proof does not match.");
}
/** Service Care keeps its own original request/hash/outcome; it is never a native receipt. */
export function useCareBookingCommand(
  obligationId: string,
  onCommitted: (outcome: ServiceCareBookingOutcome) => void,
) {
  const authority = useSchedulingAuthority(),
    [, render] = useState(0);
  const org = authority.profile?.organization?.id,
    actor = authority.profile?.id;
  const key = `growthos.service-care.booking.v1:${org}:${actor}:${obligationId}`,
    identity = `${key}:${authority.identity}`;
  const ref = useRef<{
    identity: string;
    ready: boolean;
    busy: boolean;
    blocked: boolean;
    bytes: string | null;
    saved: CareCustody | null;
    future: { responseId: string; read: ServiceCareSchedulingRead } | null;
    error: string;
  }>({
    identity,
    ready: false,
    busy: false,
    blocked: false,
    bytes: null,
    saved: null,
    future: null,
    error: "",
  });
  if (ref.current.identity !== identity)
    ref.current = {
      identity,
      ready: false,
      busy: false,
      blocked: false,
      bytes: null,
      saved: null,
      future: null,
      error: "",
    };
  const token = ref.current,
    current = () => ref.current === token && authority.isCurrent();
  const validate = async (value: unknown) => {
    const result = careCustodySchema.parse(value);
    serviceCareBookingSchema.parse(result.body);
    if (
      result.organizationId !== org ||
      result.actorUserId !== actor ||
      result.obligationId !== obligationId ||
      (await careHash(result.body)) !== result.hash
    )
      throw new Error("Original booking custody is invalid.");
    if (
      result.retiredRequestIds?.some((id) =>
        sameCustomerWorkId(
          id,
          serviceCareBookingSchema.parse(result.body).requestId,
        ),
      )
    )
      throw new Error("Retired request reused");
    if (result.outcome) careProof(result, result.outcome);
    for (const prior of result.completed ?? []) {
      if (
        (await careHash(prior.body)) !== prior.hash ||
        !result.retiredRequestIds?.some((id) =>
          sameCustomerWorkId(
            id,
            serviceCareBookingSchema.parse(prior.body).requestId,
          ),
        )
      )
        throw new Error("Invalid prior booking proof");
      careProof({ ...result, ...prior }, prior.outcome);
    }
    return freezeSchedulingValue(result);
  };
  useEffect(() => {
    void (async () => {
      if (!current()) return;
      try {
        token.bytes = sessionStorage.getItem(key);
        if (token.bytes !== null)
          token.saved = await validate(JSON.parse(token.bytes));
      } catch {
        token.blocked = true;
        token.error =
          "Original booking custody is unavailable or invalid. No new booking can be sent.";
      } finally {
        if (current()) {
          token.ready = true;
          render((n) => n + 1);
        }
      }
    })();
  }, [identity]);
  const persist = async (value: CareCustody) => {
    if (!current() || sessionStorage.getItem(key) !== token.bytes)
      throw new Error("Original booking custody changed.");
    const bytes = JSON.stringify(value);
    sessionStorage.setItem(key, bytes);
    if (sessionStorage.getItem(key) !== bytes)
      throw new Error("Original booking readback failed.");
    const parsed = await validate(JSON.parse(bytes));
    if (!current() || sessionStorage.getItem(key) !== bytes)
      throw new Error("Original booking authority changed.");
    token.bytes = bytes;
    token.saved = parsed;
  };
  const execute = async (body?: ServiceCareBookingInput) => {
    if (
      !current() ||
      !token.ready ||
      token.busy ||
      token.blocked ||
      (token.saved?.outcome && !token.future) ||
      (body && token.saved && !token.future)
    )
      return;
    token.busy = true;
    token.error = "";
    render((n) => n + 1);
    let dispatched = false;
    try {
      if (body) {
        const frozen = freezeSchedulingValue(
          structuredClone(serviceCareBookingSchema.parse(body)),
        );
        if (
          !frozen.schedulingReview ||
          frozen.schedulingReview.context.organizationId !== org
        )
          throw new Error("Review this exact service source before booking.");
        const previous = token.saved,
          retiredRequestIds = [
            ...(previous?.retiredRequestIds ?? []),
            ...(previous?.outcome
              ? [serviceCareBookingSchema.parse(previous.body).requestId]
              : []),
          ];
        if (
          retiredRequestIds.some((id) =>
            sameCustomerWorkId(id, frozen.requestId),
          )
        )
          throw new Error("Retired request cannot be reused");
        if (
          previous?.outcome &&
          (!token.future ||
            !sameCustomerWorkId(frozen.responseId, token.future.responseId) ||
            sameCustomerWorkId(
              frozen.responseId,
              previous.outcome.responseId,
            ) ||
            frozen.expectedUpdatedAt !== token.future.read.expectedUpdatedAt ||
            careCanonicalJson(frozen.schedulingReview.context.source) !==
              careCanonicalJson(token.future.read.source))
        )
          throw new Error("Fresh separately confirmed source required");
        const hash = await careHash(frozen);
        if (!current()) return;
        const completed = [
          ...(previous?.completed ?? []),
          ...(previous?.outcome
            ? [
                {
                  body: previous.body,
                  hash: previous.hash,
                  outcome: previous.outcome,
                },
              ]
            : []),
        ];
        await persist({
          formatVersion: 1,
          organizationId: org!,
          actorUserId: actor!,
          obligationId,
          body: frozen,
          hash,
          outcome: null,
          retiredRequestIds,
          completed,
        });
        token.future = null;
      }
      const original = token.saved;
      if (
        !original ||
        original.outcome ||
        !current() ||
        sessionStorage.getItem(key) !== token.bytes
      )
        throw new Error("Original booking custody changed.");
      dispatched = true;
      const result = serviceCareBookingResultSchema.parse(
        await bookServiceCareVisit(
          obligationId,
          original.body as ServiceCareBookingInput,
        ),
      );
      if (!current()) return;
      careProof(original, result.bookingOutcome);
      await persist({ ...original, outcome: result.bookingOutcome });
      if (current()) onCommitted(result.bookingOutcome);
    } catch {
      if (current()) {
        token.error = dispatched
          ? "The original booking result is unconfirmed. Retry only that original request."
          : "Booking custody could not be verified. Nothing was sent; any original committed proof remains authoritative.";
        if (!dispatched || !token.saved) token.blocked = true;
        else
          try {
            if (sessionStorage.getItem(key) !== token.bytes)
              token.blocked = true;
          } catch {
            token.blocked = true;
          }
      }
    } finally {
      if (current()) {
        token.busy = false;
        render((n) => n + 1);
      }
    }
  };
  return {
    authority,
    locked:
      !authority.allowed ||
      !token.ready ||
      token.blocked ||
      token.busy ||
      (!!token.saved && !token.future),
    busy: token.busy,
    error: authority.allowed ? token.error : "",
    pending:
      authority.allowed && token.ready && !token.saved?.outcome
        ? (token.saved?.body ?? null)
        : null,
    outcome:
      authority.allowed && token.ready ? (token.saved?.outcome ?? null) : null,
    separate: !!token.future,
    prepareSeparate: (read: ServiceCareSchedulingRead, responseId: string) => {
      if (
        !current() ||
        token.blocked ||
        token.busy ||
        !token.ready ||
        !token.saved?.outcome ||
        !z.uuid().safeParse(responseId).success ||
        sameCustomerWorkId(responseId, token.saved.outcome.responseId)
      )
        return;
      const parsed = serviceCareSchedulingReadSchema.safeParse(read);
      if (
        !parsed.success ||
        parsed.data.review.state !== "ready" ||
        parsed.data.organizationId !== org ||
        parsed.data.actorUserId !== actor ||
        parsed.data.obligationId !== obligationId
      )
        return;
      token.future = freezeSchedulingValue({ responseId, read: parsed.data });
      token.error = "";
      render((n) => n + 1);
    },
    submit: (body: ServiceCareBookingInput) => execute(body),
    retry: () => (token.saved?.outcome ? Promise.resolve() : execute()),
  };
}
async function request<T>(path: string, body?: unknown): Promise<T> {
  const result = await fetch(`/api/v1/service-obligations/${path}`, { credentials: 'include', ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
  const value = await result.json();
  if (!result.ok) throw new Error(value.error || 'The service-care result was not confirmed.');
  return value as T;
}

export default function ServiceCarePanel({ obligationId, editable, onChanged, onClose, scopeKey = '', manageStanding = false }: { obligationId: string; editable: boolean; onChanged: () => Promise<void>; onClose: () => void; scopeKey?: string; manageStanding?: boolean }) {
  useGetMe();
  const [channel, setChannel] = useState<'email' | 'sms'>('email');
  const [showReplies, setShowReplies] = useState<'mailbox' | 'sms' | null>(null);
  const [care, setCare] = useState<Care | null>(null);
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [reviewNeeded, setReviewNeeded] = useState(false);
  const [notice, setNotice] = useState(''), [error, setError] = useState('');
  const [agreement, setAgreement] = useState(''), [agreedService, setAgreedService] = useState(false);
  const [responseNote, setResponseNote] = useState(''), [responseChannel, setResponseChannel] = useState('phone'), [outcome, setOutcome] = useState('ready_to_book');
  const [respondedAt, setRespondedAt] = useState(localDateTime(new Date().toISOString())), [attested, setAttested] = useState(false);
  const [visitType, setVisitType] = useState<"inspection" | "other">(
      "inspection",
    ),
    [confirmed, setConfirmed] = useState(false);
  const booking = useCareBookingCommand(obligationId, () => {
    setNotice(
      "The original office-confirmed appointment committed. Service completion remains separate.",
    );
    void refresh();
    void onChanged();
  });
  const authority = booking.authority;
  const selection = JSON.stringify([
    obligationId,
    care?.expectedUpdatedAt,
    care?.response?.id,
    visitType,
  ]);
  const scheduling = useSchedulingContext({
    authority,
    identity: selection,
    enabled: editable && !!care && !loading && authority.allowed,
    load: async () => {
      const read = serviceCareSchedulingReadSchema.parse(care?.scheduling);
      if (
        !sameCustomerWorkId(
          read.organizationId,
          authority.profile?.organization?.id,
        ) ||
        read.actorUserId !== authority.profile?.id ||
        !sameCustomerWorkId(read.obligationId, obligationId) ||
        read.expectedUpdatedAt !== care?.expectedUpdatedAt ||
        read.appointmentType !== visitType ||
        read.review.state !== "ready"
      )
        throw new Error("Service booking source changed");
      return read.review;
    },
  });
  const interval = {
    startAt: null,
    endAt: null,
    legacyEffectiveEnd: null,
    reservation: null,
    evidence: "legacy" as const,
  };
  const review = useSchedulingReview({
    authority,
    identity: selection,
    context: scheduling.value?.context ?? null,
    interval,
    initialDraft: { startAt: null, endAt: null, resourceUserIds: [] },
    transition: "admission",
  });
  const assignee = review.draft.resourceUserIds[0] ?? "";
  useEffect(() => {
    setConfirmed(false);
  }, [review.draft, scheduling.value, selection]);
  const { data: users, isError: usersError } = useListUsers({ query: { queryKey: [...getListUsersQueryKey(), 'service-care', scopeKey], enabled: editable } });
  const sequence = useRef(0),
    mounted = useRef(true);
  const currentKey = useRef("");
  currentKey.current = `${scopeKey}:${obligationId}:${channel}:${editable}`;
  async function refresh() {
    const run = ++sequence.current, key = currentKey.current;
    setLoading(true);
    try {
      const value = await request<Care>(
        `${obligationId}/care?channel=${channel}&appointmentType=${visitType}`,
      );
      if (!mounted.current || run !== sequence.current || key !== currentKey.current) return;
      setCare(value);
      setReviewNeeded(false);
      setError("");
      // A refresh is an explicit new review, never an automatic approval of a
      // replacement version, recipient, sender, response, or booked window.
      setAgreedService(false);
      setAttested(false);
      setConfirmed(false);
    } catch (e) {
      if (!mounted.current || run !== sequence.current || key !== currentKey.current) return;
      setCare(null); setReviewNeeded(true); setError(e instanceof Error ? e.message : 'Customer care is unavailable.');
    } finally { if (mounted.current && run === sequence.current && key === currentKey.current) setLoading(false); }
  }
  useEffect(() => { mounted.current = true; setCare(null); void refresh(); return () => { mounted.current = false; ++sequence.current; }; }, [obligationId, channel, scopeKey, editable, visitType]);
  useEffect(() => {
    setAgreement("");
    setAgreedService(false);
    setResponseNote("");
    setAttested(false);
    setConfirmed(false);
    setShowReplies(null);
    setNotice("");
    setBusy(false);
  }, [obligationId, scopeKey, editable]);
  async function perform(
    suffix: string,
    details: Record<string, unknown>,
    message: string,
  ) {
    if (!care || !editable || busy || reviewNeeded || !authority.isCurrent())
      return;
    const run = sequence.current,
      key = currentKey.current;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await request(`${obligationId}/care/${suffix}`, { requestId: crypto.randomUUID(), expectedUpdatedAt: care.expectedUpdatedAt, ...details });
      if (!mounted.current || run !== sequence.current || key !== currentKey.current ||
        !authority.isCurrent()
      )
        return;
      setNotice(message);
      await refresh();
      if (
        mounted.current &&
        key === currentKey.current &&
        authority.isCurrent()
      )
        await onChanged();
    } catch (e) {
      if (
        !mounted.current ||
        key !== currentKey.current ||
        !authority.isCurrent()
      )
        return;
      setReviewNeeded(true);
      setError(`${e instanceof Error ? e.message : 'The result was not confirmed.'} Refresh and review the saved receipt before another action. No automatic retry was made.`);
    } finally {
      if (
        mounted.current &&
        key === currentKey.current &&
        authority.isCurrent()
      )
        setBusy(false);
    }
  }
  const disabled = busy || loading || reviewNeeded || !editable;
  const booked = care?.appointment && ['scheduled', 'confirmed'].includes(care.appointment.status);
  const freshResponse = care?.response?.outcome === 'ready_to_book' && care.booking?.responseId !== care.response.id;
  return ( <section className="mt-3 w-full min-w-0 space-y-4 border-t pt-4" aria-label="Service customer care">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-lg font-semibold">Customer care → office booking</h3>
        <div className="flex flex-wrap gap-2">
          <button type="button" disabled={busy || loading} className={button} onClick={() => void refresh()}>Refresh and review</button>
          <button type="button" disabled={busy} className={button} onClick={onClose}>Close customer care</button>
        </div>
      </div>
      <p className="text-sm text-muted-foreground">One reminder per service occurrence, from individual review or a separately approved standing policy. Mailbox and SMS evidence need office review; conversations and confirmed booking remain separate staff actions. Completion is separate too.</p>
      <ServiceStandingRemindersPanel key={`standing:${scopeKey}:${obligationId}:${manageStanding}`} obligationId={obligationId} manage={manageStanding} scopeKey={scopeKey} onChanged={async () => { await refresh(); if (mounted.current) await onChanged(); }} />
      <div className="flex flex-wrap gap-2">
        <button type="button" className={button} onClick={() => setShowReplies(value => value === 'mailbox' ? null : 'mailbox')}>
          {showReplies === 'mailbox' ? 'Hide mailbox reply evidence' : 'Review mailbox reply evidence'}
        </button>
        <button type="button" className={button} onClick={() => setShowReplies(value => value === 'sms' ? null : 'sms')}>
          {showReplies === 'sms' ? 'Hide service SMS evidence' : 'Review service SMS evidence'}
        </button>
      </div>
      {showReplies === 'mailbox' && <ServiceMailboxRepliesPanel key={`mailbox:${scopeKey}:${obligationId}`} obligationId={obligationId} editable={editable} scopeKey={scopeKey} onChanged={async () => { await refresh(); if (mounted.current) await onChanged(); }} />}
      {showReplies === 'sms' && <ServiceSmsRepliesPanel key={`sms:${scopeKey}:${obligationId}`} obligationId={obligationId} editable={editable} scopeKey={scopeKey} onChanged={async () => { await refresh(); if (mounted.current) await onChanged(); }} />}
      {notice && (
        <p role="status" className="rounded-lg border p-3">
          {notice}
        </p>
      )}
      {error && ( <p role="alert" className="rounded-lg border border-destructive p-3">
          {error}
        </p>
      )}
      {booking.error && <p role="alert">{booking.error}</p>}
      {booking.pending && (
        <button
          type="button"
          className={button}
          disabled={booking.busy || !editable}
          onClick={() => void booking.retry()}
        >
          Retry original service booking
        </button>
      )}
      {booking.outcome && (
        <div role="status">
          <p>
            Original service booking committed: {booking.outcome.appointmentId}.
            Its proof is retained; a missing display does not permit recreation.
          </p>
          {!booking.separate &&
            editable &&
            care?.active &&
            !booked &&
            freshResponse &&
            care.response &&
            scheduling.value &&
            !sameCustomerWorkId(
              care.response.id,
              booking.outcome.responseId,
            ) && (
              <button
                type="button"
                className={button}
                onClick={() => {
                  const read = serviceCareSchedulingReadSchema.safeParse(
                    care.scheduling,
                  );
                  if (read.success && authority.isCurrent()) {
                    booking.prepareSeparate(read.data, care.response!.id);
                    review.invalidate();
                    setConfirmed(false);
                  }
                }}
              >
                Prepare separately confirmed service visit
              </button>
            )}
        </div>
      )}
      {loading && <p>Loading customer-care record…</p>}
      {!loading && care && (
        <>
          {care.reminder ? (
            <div className="space-y-2 rounded-lg border p-3">
              <h4 className="font-semibold">
                {stateLabel[care.reminder.state] ?? 'Receipt requires operator review'}
              </h4>
              <p className="text-sm">
                {care.reminder.origin === 'standing' ? 'Standing-policy admission — not a new individual staff approval for this occurrence.' : 'Individually reviewed reminder.'}
              </p>
              <p>
                {care.reminder.channel.toUpperCase()} ·{" "}
                {care.reminder.recipient}
              </p>
              {care.reminder.state === "pending" && care.reminder.runAt && (
                <p>
                  Next eligible check:{" "}
                  {new Date(care.reminder.runAt).toLocaleString()} (
                  {scheduleTimezone})
                </p>
              )}
              {care.reminder.detail && <p>{care.reminder.detail}</p>}
              {care.deferredReason && <p>{care.deferredReason}</p>}
              {care.blockReason && care.reminder.state === 'pending' && <p>Current hold: {care.blockReason}</p>}
              <details>
                <summary className="cursor-pointer">Reviewed message and agreement</summary>
                <p className="mt-2 font-medium">{care.reminder.subject}</p>
                <p className="whitespace-pre-wrap break-words">
                  {care.reminder.body}
                </p>
                <p className="mt-2">
                  Review note: {care.reminder.agreementNote}
                </p>
              </details>
              {care.reminder.providerEvidence && (
                <p className="break-all text-xs">
                  Provider:{" "}
                  {care.reminder.providerEvidence.provider ?? "recorded"} ·{" "}
                  {care.reminder.providerEvidence.providerMessageId ? `Message receipt: ${care.reminder.providerEvidence.providerMessageId}` : 'No provider message ID returned.'}{" "}
                  {care.reminder.providerEvidence.providerRequestId ? `Request correlation: ${care.reminder.providerEvidence.providerRequestId}` : ''}{" "}
                  Provider acceptance is not delivery or a customer response.
                </p>
              )}
              <p className="text-xs text-muted-foreground">This occurrence cannot be automatically resent through a new request or another channel. Unknown results require operator reconciliation.</p>
            </div>
          ) : (
            care.active &&
            !booked && ( <form className="space-y-3 rounded-lg border p-3" onSubmit={event => { event.preventDefault(); if (care.preview && agreedService) void perform('reminder', { channel, previewFingerprint: care.preview.fingerprint, agreementNote: agreement, expectedServiceConfirmed: true }, 'One reminder approved and queued. No delivery or booking is claimed.'); }}>
                <h4 className="font-semibold">1. Review one expected-service reminder</h4>
                <label className="block text-sm">
                  Reminder channel
                  <select className={field} value={channel} disabled={disabled} onChange={event => { setAgreedService(false); setChannel(event.target.value as 'email' | 'sms'); }}>
                    <option value="email">Email</option>
                    <option value="sms">SMS (approved customer-care consent required)</option>
                  </select>
                </label>
                {care.blockReason && <p role="status">{care.blockReason}</p>}
                {care.deferredReason && <p>{care.deferredReason}</p>}
                {care.preview && (
                  <>
                    <p className="break-words">
                      To: {care.preview.recipient}
                      {care.preview.sender && (
                        <>
                          {" "}
                          · From: {care.preview.sender.senderEmail} (
                          {care.preview.sender.provider})
                        </>
                      )}
                    </p>
                    <p className="font-medium">{care.preview.subject}</p>
                    <p className="whitespace-pre-wrap break-words rounded-lg bg-muted p-3">
                      {care.preview.body}
                    </p>
                    <p className="text-sm">
                      Not before:{" "}
                      {new Date(care.preview.runAt).toLocaleString()} (
                      {scheduleTimezone}). Current contact policy, sending hours and activation are checked again at dispatch.</p>
                  </>
                )}
                {editable && (
                  <>
                    <label className="block text-sm">
                      Current service agreement / customer expectation evidence
                      <textarea className={field} disabled={busy} required minLength={10} maxLength={1000} value={agreement} onChange={event => { setAgreement(event.target.value); setAgreedService(false); }} />
                    </label>
                    <label className="flex items-start gap-2">
                      <input type="checkbox" checked={agreedService} disabled={disabled || !care.preview} onChange={event => setAgreedService(event.target.checked)} className="mt-1" />I reviewed this exact message and recipient against the current service agreement. This does not grant marketing or SMS consent.</label>
                    <button disabled={disabled || !care.preview || !agreedService || agreement.trim().length < 10 || !!care.response} className={button}>Approve one reminder</button>
                  </>
                )}
              </form>
            )
          )}
          {care.response && (
            <div className="rounded-lg border p-3">
              <h4 className="font-semibold">Latest staff-recorded response</h4>
              <p>
                {care.response.outcome.replaceAll("_", " ")} ·{" "}
                {care.response.channel.replaceAll("_", " ")} ·{" "}
                {new Date(care.response.respondedAt).toLocaleString()}
              </p>
              <p className="whitespace-pre-wrap break-words">
                {care.response.note}
              </p>
              <p className="text-xs text-muted-foreground">Staff attestation — not independently verified inbox evidence.</p>
            </div>
          )}
          {care.appointment && (
            <p className="rounded-lg border p-3">
              Office appointment: {care.appointment.status.replaceAll("_", " ")}{" "}
              · {new Date(care.appointment.scheduledStart).toLocaleString()} (
              {scheduleTimezone}). Manage changes in Appointments. A cancelled or missed visit requires a fresh customer confirmation before rebooking.</p>
          )}
          {editable && care.active && ( <form className="space-y-3 border-t pt-4" onSubmit={event => { event.preventDefault(); if (attested) void perform('response', { channel: responseChannel, outcome, respondedAt: new Date(respondedAt).toISOString(), note: responseNote, staffAttested: true }, 'Customer response recorded as a staff attestation. Unclaimed service reminders were cancelled; any unknown send receipt is preserved.'); }}>
              <h4 className="font-semibold">2. Record the customer conversation</h4>
              <p className="text-sm text-muted-foreground">Use the actual conversation, including a reply you reviewed in the connected mailbox. This does not release other outreach holds or automatically cancel an existing appointment.</p>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="min-w-0 text-sm">
                  Response channel
                  <select className={field} disabled={busy} value={responseChannel} onChange={event => { setResponseChannel(event.target.value); setAttested(false); }}>
                    <option value="phone">Phone conversation</option>
                    <option value="email">Email reviewed by staff</option>
                    <option value="sms">Text reviewed by staff</option>
                    <option value="in_person">In person</option>
                  </select>
                </label>
                <label className="min-w-0 text-sm">
                  Response time ({scheduleTimezone})
                  <input className={field} disabled={busy} type="datetime-local" required value={respondedAt} onChange={event => { setRespondedAt(event.target.value); setAttested(false); }} />
                </label>
              </div>
              <label className="block text-sm">
                Customer outcome
                <select className={field} disabled={busy} value={outcome} onChange={event => { setOutcome(event.target.value); setAttested(false); }}>
                  <option value="ready_to_book">Ready to arrange the visit</option>
                  <option value="follow_up">Office follow-up needed</option>
                  <option value="declined">Declined this service</option>
                </select>
              </label>
              <label className="block text-sm">
                Conversation and agreed next step
                <textarea className={field} disabled={busy} required minLength={10} maxLength={1000} value={responseNote} onChange={event => { setResponseNote(event.target.value); setAttested(false); }} />
              </label>
              <label className="flex items-start gap-2">
                <input type="checkbox" className="mt-1" disabled={disabled} checked={attested} onChange={event => setAttested(event.target.checked)} />I reviewed the actual customer response and am recording it as staff evidence.</label>
              <button className={button} disabled={disabled || !attested || !respondedAt || responseNote.trim().length < 10}>Record customer response</button>
            </form>
          )}
          {editable && care.active && !booked && (
            <form
              className="space-y-3 border-t pt-4"
              onSubmit={(event) => {
                event.preventDefault();
                if (
                  care.response &&
                  confirmed &&
                  !booking.locked &&
                  review.review &&
                  review.current() &&
                  review.draft.startAt &&
                  review.draft.endAt &&
                  review.draft.resourceUserIds.length === 1
                )
                  void booking.submit({
                    requestId: crypto.randomUUID(),
                    expectedUpdatedAt: care.expectedUpdatedAt,
                    responseId: care.response.id,
                    assignedUserId: assignee,
                    type: visitType,
                    scheduledStart: review.draft.startAt,
                    scheduledEnd: review.draft.endAt,
                    customerConfirmed: true,
                    schedulingReview: review.review,
                  });
              }}
            >
              <h4 className="font-semibold">3. Book the customer-confirmed visit</h4>
              {!freshResponse && <p>Record a fresh “Ready to arrange the visit” response before booking.</p>}
              <fieldset disabled={booking.locked} className="space-y-3">
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="min-w-0 text-sm">
                    Assigned team member
                    <select
                      className={field}
                      required
                      value={assignee}
                      onChange={(event) => {
                        review.fields.onDraftChange({
                          ...review.draft,
                          resourceUserIds: event.target.value
                            ? [event.target.value]
                            : [],
                        });
                        setConfirmed(false);
                      }}
                    >
                      <option value="">Choose accepted staff</option>
                      {users?.filter(canAssignWork).map((user) => (
                        <option key={user.id} value={user.id}>
                          {`${user.firstName ?? ''} ${user.lastName ?? ''}`.trim() || user.email}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="min-w-0 text-sm">
                    Visit type
                    <select
                      className={field}
                      value={visitType}
                      onChange={(event) => {
                        setVisitType(
                          event.target.value as "inspection" | "other",
                        );
                        setConfirmed(false);
                      }}
                    >
                      <option value="inspection">Inspection / warranty check (capacity checked)</option>
                      <option value="other">Other service visit (staff conflicts checked)</option>
                    </select>
                  </label>
                </div>
                {scheduling.error && <p role="status">{scheduling.error}</p>}
                <button
                  type="button"
                  className={button}
                  onClick={() => void refresh()}
                >
                  Refresh service scheduling review
                </button>
                <SchedulingIntervalFields
                  {...review.fields}
                  resources={(users ?? [])
                    .filter((user) => user.id === assignee)
                    .map((user) => ({
                      id: user.id,
                      label:
                        [user.firstName, user.lastName]
                          .filter(Boolean)
                          .join(" ") ||
                        user.email ||
                        user.id,
                    }))}
                  presets={scheduling.value?.policy?.durationPresets ?? []}
                  disabled={booking.locked}
                />
                <SchedulingIntervalReview
                  companyTimeZone={
                    scheduling.value?.context.companyTimeZone ?? null
                  }
                  interval={interval}
                  proposal={review.proposal}
                  resources={[]}
                  conflict={null}
                />
              </fieldset>
              {usersError && <p role="alert">Team members could not be loaded. Refresh before booking.</p>}
              <label className="flex items-start gap-2">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={confirmed}
                  disabled={
                    disabled ||
                    booking.locked ||
                    !freshResponse ||
                    !review.review
                  }
                  onChange={(event) => setConfirmed(event.target.checked)}
                />The customer confirmed this exact time and the office has reviewed the assignment. This does not mark the service complete.</label>
              <button
                className={button}
                disabled={
                  disabled ||
                  booking.locked ||
                  usersError ||
                  !freshResponse ||
                  !confirmed ||
                  !review.review ||
                  !assignee
                }
              >
                Book confirmed visit
              </button>
            </form>
          )}
        </>
      )}
    </section>
  );
}
