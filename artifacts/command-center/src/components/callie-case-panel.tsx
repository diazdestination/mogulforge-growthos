import { useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { z } from "zod";
import {
  bookCallieVisit,
  getCallieSchedulingContext,
} from "@workspace/api-client-react";
import {
  callieBookingSchema,
  callieBookingOutcomeSchema,
  canonicalCallieBookingInput,
  type CallieBooking,
  type CallieBookingOutcome,
} from "../../../api-server/src/services/callie-office-contract";
import {
  useSchedulingAuthority,
  useSchedulingContext,
  useSchedulingReview,
} from "@/hooks/use-scheduling-review";
import { freezeSchedulingValue } from "@/lib/scheduling-command";
import { SchedulingIntervalFields } from "./scheduling-interval-fields";
import { SchedulingIntervalReview } from "./scheduling-interval-review";
import ContactSelect from "./contact-select";
import CallieConversationEvidence from "./callie-conversation-evidence";
import { scheduleTimezone } from "@/lib/contractor-schedule";
import {
  callieButton as button,
  callieField as field,
  callieLabel,
  callieRequest,
  callieDetailFor,
  callieCommandFor,
  callieBookingFor,
  callieSchedulingContextFor,
  requestLabel,
  type CallieDetail,
} from "./callie-contract";

const callieCustodySchema = z.strictObject({
  formatVersion: z.literal(1),
  organizationId: z.uuid(),
  actorUserId: z.string().min(1),
  intakeId: z.uuid(),
  body: z.record(z.string(), z.unknown()),
  hash: z.string().regex(/^[a-f0-9]{64}$/),
  outcome: callieBookingOutcomeSchema.nullable(),
});
type CallieCustody = z.infer<typeof callieCustodySchema>;
async function bookingHash(body: unknown) {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(canonicalCallieBookingInput(body)),
      ),
    ),
    (n) => n.toString(16).padStart(2, "0"),
  ).join("");
}
/** The original CALLIE booking protocol remains separate from office actions. */
export function useCallieBookingCommand(
  organizationId: string,
  intakeId: string,
  onCommitted: (detail: CallieDetail | null) => void,
) {
  const cached = useSchedulingAuthority(),
    authority = useSchedulingAuthority({
      organizationId,
      actorUserId: cached.profile?.id ?? "",
    });
  const [, render] = useState(0),
    actor = authority.profile?.id;
  const key = `growthos.callie.booking.v1:${organizationId}:${actor}:${intakeId}`,
    identity = `${key}:${authority.identity}`;
  const ref = useRef<{
    identity: string;
    ready: boolean;
    busy: boolean;
    blocked: boolean;
    bytes: string | null;
    saved: CallieCustody | null;
    error: string;
  }>({
    identity,
    ready: false,
    busy: false,
    blocked: false,
    bytes: null,
    saved: null,
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
      error: "",
    };
  const token = ref.current,
    current = () => ref.current === token && authority.isCurrent();
  const parser = (original: CallieCustody) =>
    callieBookingFor(
      original.organizationId,
      original.actorUserId,
      original.intakeId,
      callieBookingSchema.parse(original.body),
      original.hash,
    );
  const validate = async (value: unknown) => {
    const result = callieCustodySchema.parse(value);
    callieBookingSchema.parse(result.body);
    if (
      result.organizationId !== organizationId ||
      result.actorUserId !== actor ||
      result.intakeId !== intakeId ||
      (await bookingHash(result.body)) !== result.hash
    )
      throw new Error("Original CALLIE custody is invalid.");
    if (result.outcome)
      parser(result).parse({
        detail: null,
        replayed: true,
        bookingOutcome: result.outcome,
      });
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
          "Original CALLIE booking custody is unavailable or invalid. Nothing new can be sent.";
      } finally {
        if (current()) {
          token.ready = true;
          render((n) => n + 1);
        }
      }
    })();
  }, [identity]);
  const persist = async (value: CallieCustody) => {
    if (!current() || sessionStorage.getItem(key) !== token.bytes)
      throw new Error("Original custody changed.");
    const bytes = JSON.stringify(value);
    sessionStorage.setItem(key, bytes);
    if (sessionStorage.getItem(key) !== bytes)
      throw new Error("Original readback failed.");
    const parsed = await validate(JSON.parse(bytes));
    if (!current() || sessionStorage.getItem(key) !== bytes)
      throw new Error("Original booking authority changed.");
    token.bytes = bytes;
    token.saved = parsed;
  };
  const execute = async (body?: CallieBooking) => {
    if (
      !current() ||
      !token.ready ||
      token.busy ||
      token.blocked ||
      token.saved?.outcome ||
      (body && token.saved)
    )
      return;
    token.busy = true;
    token.error = "";
    render((n) => n + 1);
    try {
      if (body) {
        const parsed = callieBookingSchema.parse(body),
          frozen = freezeSchedulingValue(structuredClone(body));
        if (
          !parsed.schedulingReview ||
          parsed.schedulingReview.context.organizationId !== organizationId
        )
          throw new Error("Review this exact CALLIE source before booking.");
        const hash = await bookingHash(frozen);
        if (!current()) return;
        await persist({
          formatVersion: 1,
          organizationId,
          actorUserId: actor!,
          intakeId,
          body: frozen,
          hash,
          outcome: null,
        });
      }
      const original = token.saved;
      if (
        !original ||
        !current() ||
        sessionStorage.getItem(key) !== token.bytes
      )
        throw new Error("Original booking custody changed.");
      const raw = await bookCallieVisit(
        intakeId,
        original.body as CallieBooking,
      );
      if (!current()) return;
      const result = parser(original).parse(raw);
      await persist({ ...original, outcome: result.bookingOutcome });
      if (current()) onCommitted(result.detail);
    } catch {
      if (current()) {
        token.error = token.saved
          ? "The original CALLIE booking result is unconfirmed. Retry only that original request."
          : "CALLIE booking custody could not be verified. Nothing was sent.";
        if (!token.saved) token.blocked = true;
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
      !!token.saved,
    busy: token.busy,
    error: authority.allowed ? token.error : "",
    pending:
      authority.allowed && token.ready && !token.saved?.outcome
        ? (token.saved?.body ?? null)
        : null,
    outcome:
      authority.allowed && token.ready ? (token.saved?.outcome ?? null) : null,
    submit: (body: CallieBooking) => execute(body),
    retry: () => execute(),
  };
}

export default function CallieCasePanel({ scopeKey, organizationId, id, editable, onChanged, onClose }: { scopeKey: string; organizationId: string; id: string; editable: boolean; onChanged: () => void; onClose: () => void }) {
  const [detail, setDetail] = useState<CallieDetail | null>(null), [busy, setBusy] = useState(false), [loading, setLoading] = useState(true), [reviewNeeded, setReviewNeeded] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [identityAction, setIdentityAction] = useState("link_contact"), [contactId, setContactId] = useState(""), [firstName, setFirstName] = useState(""), [serviceType, setServiceType] = useState(""), [identityConfirmed, setIdentityConfirmed] = useState(false);
  const [owner, setOwner] = useState(""), [officeNote, setOfficeNote] = useState(""), [officeConfirmed, setOfficeConfirmed] = useState(false);
  const [property, setProperty] = useState(""),
    [visitType, setVisitType] = useState<"inspection" | "other">("inspection"),
    [confirmationNote, setConfirmationNote] = useState(""),
    [confirmed, setConfirmed] = useState(false);
  const booking = useCallieBookingCommand(organizationId, id, (value) => {
    if (value) setDetail(value);
    setNotice(
      "The original office-confirmed appointment committed. Its booking proof is retained.",
    );
    onChanged();
  });
  const authority = booking.authority;
  const selection = JSON.stringify([
    id,
    detail?.version,
    detail?.expectedFingerprint,
    detail?.contact?.id,
    detail?.leadId,
    property,
    visitType,
  ]);
  const scheduling = useSchedulingContext({
    authority,
    identity: selection,
    enabled: editable && !!detail?.actions.canBook && authority.allowed,
    load: async () => {
      const selected = {
        appointmentType: visitType,
        ...(property ? { propertyId: property } : {}),
      };
      const read = callieSchedulingContextFor(
        organizationId,
        authority.profile!.id,
        id,
        selected,
      ).parse(await getCallieSchedulingContext(id, selected));
      if (
        read.expectedVersion !== detail?.version ||
        read.expectedFingerprint !== detail?.expectedFingerprint ||
        read.source?.contactId !== detail?.contact?.id ||
        read.source?.leadId !== detail?.leadId ||
        read.review.state !== "ready"
      )
        throw new Error("CALLIE booking source changed");
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
  const staff = review.draft.resourceUserIds[0] ?? "";
  useEffect(() => {
    setConfirmed(false);
  }, [review.draft, scheduling.value, selection]);
  const mounted = useRef(true), generation = useRef(0), readAbort = useRef<AbortController | null>(null);
  function resetAcknowledgments() { setIdentityConfirmed(false); setOfficeConfirmed(false); setConfirmed(false); }
  async function refresh() {
    const run = ++generation.current; readAbort.current?.abort(); const abort = new AbortController(); readAbort.current = abort; resetAcknowledgments(); setLoading(true); setReviewNeeded(true); setError("");
    try { const value = await callieRequest(callieDetailFor(organizationId, id), `/${id}`, undefined, abort.signal); if (mounted.current && run === generation.current) { setDetail(value); setReviewNeeded(false); setOwner(""); } }
    catch (failure) { if (mounted.current && run === generation.current) { setDetail(null); setError(failure instanceof Error ? failure.message : "CALLIE request is unavailable."); } }
    finally { if (mounted.current && run === generation.current) setLoading(false); }
  }
  useEffect(() => { mounted.current = true; void refresh(); return () => { mounted.current = false; generation.current++; readAbort.current?.abort(); }; }, [id]);
  async function perform(
    suffix: string,
    values: Record<string, unknown>,
    success: string,
  ) {
    if (
      !detail ||
      !editable ||
      busy ||
      loading ||
      reviewNeeded ||
      !authority.isCurrent()
    )
      return;
    const run = ++generation.current;
    setBusy(true);
    setError("");
    setNotice("");
    resetAcknowledgments();
    try {
      const value = await callieRequest(callieCommandFor(organizationId, id), `/${id}/${suffix}`, { requestId: crypto.randomUUID(), expectedVersion: detail.version, expectedFingerprint: detail.expectedFingerprint, ...values });
      if (
        mounted.current &&
        run === generation.current &&
        authority.isCurrent()
      ) { setDetail(value.detail); setNotice(success); setOwner(""); onChanged(); }
    } catch (failure) {
      if (
        mounted.current &&
        run === generation.current &&
        authority.isCurrent()
      ) { setReviewNeeded(true); setError(`${failure instanceof Error ? failure.message : "The result was not confirmed."} Refresh the saved request before another action. No automatic retry was made.`); }
    } finally {
      if (
        mounted.current &&
        run === generation.current &&
        authority.isCurrent()
      )
        setBusy(false);
    }
  }
  const disabled =
    busy || loading || reviewNeeded || !editable || !authority.allowed;
  function bookingChange(setter: (value: string) => void, value: string) { setter(value); setConfirmed(false); }
  return ( <section className="min-w-0 space-y-4 rounded-lg border border-primary p-4" aria-label="CALLIE request detail">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-lg font-semibold">Office review</h3>
        <div className="flex flex-wrap gap-2">
          <button className={button} disabled={busy || loading} onClick={() => void refresh()}>Refresh CALLIE request</button>
          <button className={button} disabled={busy} onClick={onClose}>Close request</button>
        </div>
      </div>
      {loading && <p>Loading saved request…</p>}
      {error && ( <p role="alert" className="break-words text-sm text-destructive">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="break-words text-sm">
          {notice}
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
          Retry original CALLIE booking
        </button>
      )}
      {booking.outcome && (
        <p role="status">
          Original CALLIE booking committed: {booking.outcome.appointmentId}.
          Its proof remains valid even if the saved display is unavailable.
        </p>
      )}
      {detail && !loading && (
        <>
          <div className="space-y-2">
            <p className="font-semibold">
              {detail.phone} · {requestLabel(detail)}
            </p>
            <p>{callieLabel(detail.state)}</p>
            <p className="text-sm">
              {detail.owner.eligible ? detail.owner.label : "Accountable owner unavailable — assign accepted staff"}{" "}
              · follow-up due {new Date(detail.dueAt).toLocaleString()}{" "}
              {detail.overdue ? "· overdue" : ""}
            </p>
            <p className="text-sm text-muted-foreground">
              {callieLabel(detail.reason)}
            </p>
          </div>
          <div className="flex flex-wrap gap-3 text-sm">
            <Link className="underline" href={`/tasks?taskId=${detail.task.id}`}>Open original callback task</Link>
            {detail.leadId && <Link className="underline" href={`/leads/${detail.leadId}`}>Open linked opportunity</Link>}
          </div>
          {detail.mode === "conversation" && <CallieConversationEvidence evidence={detail.reception} />}
          <dl className="grid min-w-0 gap-3 rounded border p-3 text-sm sm:grid-cols-2">
            <div>
              <dt className="font-medium">Caller-supplied service</dt>
              <dd>
                {detail.serviceIntent ? callieLabel(detail.serviceIntent) : "Not completed"}
              </dd>
            </div>
            <div>
              <dt className="font-medium">Preferred callback window</dt>
              <dd>
                {detail.callbackWindow === "any" ? "No preference" : detail.callbackWindow ? callieLabel(detail.callbackWindow) : "Not completed"}{" "}
                · preference only, not an agreed appointment
              </dd>
            </div>
            <div>
              <dt className="font-medium">One-call text permission</dt>
              <dd>{callieLabel(detail.smsProof)}</dd>
            </div>
            <div>
              <dt className="font-medium">Identity review</dt>
              <dd>
                {detail.identityReviewed ? `Explicitly reviewed by staff: ${detail.contact?.name}` : "Caller identity not currently reviewed. Caller ID and keypad choices are not verified identity."}
              </dd>
            </div>
          </dl>
          <p className="text-xs text-muted-foreground">
            {detail.mode === "conversation" ? "This voice-only request creates no text permission or follow-up SMS. Only the office can confirm the customer and save an agreed visit." : "Text confirmation permits only this call's fixed acknowledgment. It does not grant recurring SMS or marketing consent."}{" "}
            Customer content cannot instruct tools or confirm a booking.
          </p>
          {detail.delivery && <p className="rounded border p-3 text-sm">Acknowledgment status: {callieLabel(detail.delivery.status)}. Provider acceptance or delivery is not proof of reading, a reply or a booked visit.</p>}
          {detail.execution && (
            <details className="rounded border p-3 text-sm">
              <summary className="cursor-pointer">Original send receipt</summary>
              <p className="mt-2">{callieLabel(detail.execution.state)}</p>
              <p className="break-all text-xs">
                Receipt: {detail.execution.id}
              </p>
              {detail.delivery?.providerSid && (
                <p className="break-all text-xs">
                  Provider message: {detail.delivery.providerSid}
                </p>
              )}
              <p>This identity is retained. Policy edits, new codes or staff actions do not permit a second send.</p>
            </details>
          )}
          {detail.actions.blockReason && (
            <p className="rounded border p-3 text-sm">
              {callieLabel(detail.actions.blockReason)}
              {detail.actions.blockReason === "provider_reconciliation_required" && (
                <>
                  {" "}
                  <Link className="underline" href="/bie">Review original execution in Revenue Desk</Link>
                </>
              )}
            </p>
          )}
          {detail.appointment && (
            <div className="space-y-2 rounded border p-3">
              <h4 className="font-semibold">
                Actual office appointment:{" "}
                {detail.appointment.status.replaceAll("_", " ")}
              </h4>
              <p className="text-sm">
                {new Date(detail.appointment.scheduledStart).toLocaleString()} –{" "}
                {detail.appointment.scheduledEnd ? new Date(detail.appointment.scheduledEnd).toLocaleString() : "end not recorded"}{" "}
                ({scheduleTimezone})
              </p>
              <p className="text-xs">Staff confirmed the exact customer agreement. This is not service completion or emergency dispatch. Cancellations and later work need fresh review, not replaying this request.</p>
              <Link className="text-sm underline" href={`/appointments?appointmentId=${detail.appointment.id}&organizationId=${organizationId}`}>Open Appointments to manage the saved visit</Link>
            </div>
          )}
          {editable && detail.actions.canReviewCaller && ( <form className="min-w-0 space-y-3 border-t pt-4" onSubmit={event => { event.preventDefault(); if (!identityConfirmed) return; void perform("review-caller", { action: identityAction, ...(contactId ? { contactId } : {}), ...(identityAction === "create_opportunity" && !contactId ? { firstName } : {}), ...(identityAction === "create_opportunity" && serviceType ? { serviceType } : {}), staffConfirmed: true }, "Caller explicitly reviewed and linked. No general consent was granted and no message was sent."); }}>
              <h4 className="font-semibold">1. Review the actual caller</h4>
              <p className="text-sm text-muted-foreground">Use the actual customer conversation. Link existing customers instead of duplicating them; create an opportunity only after staff decides this is sales work.</p>
              <label className="block text-sm">
                Caller review action
                <select className={field} value={identityAction} onChange={event => { setIdentityAction(event.target.value); setIdentityConfirmed(false); }}>
                  <option value="link_contact">Link existing customer only</option>
                  <option value="create_opportunity">Create a staff-reviewed opportunity</option>
                </select>
              </label>
              <label className="block text-sm">
                Confirmed existing customer
                <ContactSelect queryScope={scopeKey} value={contactId} onChange={value => { setContactId(value); setIdentityConfirmed(false); }} testId="callie-customer" />
              </label>
              {identityAction === "create_opportunity" && !contactId && (
                <label className="block text-sm">
                  Confirmed caller first name
                  <input className={field} required maxLength={100} value={firstName} onChange={event => { setFirstName(event.target.value); setIdentityConfirmed(false); }} />
                </label>
              )}
              {identityAction === "create_opportunity" && (
                <label className="block text-sm">
                  Staff-reviewed service needed
                  <input className={field} maxLength={100} value={serviceType} onChange={event => { setServiceType(event.target.value); setIdentityConfirmed(false); }} />
                </label>
              )}
              <label className="flex items-start gap-2 text-sm">
                <input type="checkbox" disabled={disabled} checked={identityConfirmed} onChange={event => setIdentityConfirmed(event.target.checked)} />I reviewed this actual caller and confirm the customer link or new opportunity. Caller ID alone was not my identity evidence.</label>
              <button className={button} disabled={disabled || !identityConfirmed || (identityAction === "link_contact" ? !contactId : !contactId && !firstName.trim())}>Save CALLIE caller review</button>
            </form>
          )}
          {editable && detail.actions.canBook && (
            <form
              className="min-w-0 space-y-3 border-t pt-4"
              onSubmit={(event) => {
                event.preventDefault();
                if (
                  !confirmed ||
                  !detail.contact ||
                  booking.locked ||
                  !review.review ||
                  !review.current() ||
                  !review.draft.startAt ||
                  !review.draft.endAt ||
                  review.draft.resourceUserIds.length !== 1
                )
                  return;
                void booking.submit({
                  requestId: crypto.randomUUID(),
                  expectedVersion: detail.version,
                  expectedFingerprint: detail.expectedFingerprint,
                  contactId: detail.contact.id,
                  leadId: detail.leadId,
                  propertyId: property || null,
                  assignedUserId: staff,
                  type: visitType,
                  scheduledStart: review.draft.startAt,
                  scheduledEnd: review.draft.endAt,
                  confirmationNote,
                  customerConfirmed: true,
                  schedulingReview: review.review,
                });
              }}
            >
              <h4 className="font-semibold">2. Confirm the agreed visit</h4>
              <p className="text-sm">
                {detail.contact?.name} · {detail.contact?.phone}. A caller's preferred callback window is not a customer-confirmed appointment.</p>
              <fieldset disabled={booking.locked} className="space-y-3">
                <label className="block text-sm">
                  Reviewed service property
                  <select className={field} value={property} onChange={event => bookingChange(setProperty, event.target.value)}>
                    <option value="">No property linked</option>
                    {detail.bookingOptions.properties.map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="grid min-w-0 gap-3 sm:grid-cols-2">
                  <label className="min-w-0 text-sm">
                    Accepted technician
                    <select
                      className={field}
                      required
                      value={staff}
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
                      {detail.bookingOptions.staff.map((option) => (
                        <option key={option.id} value={option.id}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="min-w-0 text-sm">
                    CALLIE visit type
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
                      <option value="inspection">Inspection (capacity checked)</option>
                      <option value="other">Other visit (staff conflicts checked)</option>
                    </select>
                  </label>
                </div>
                {scheduling.error && <p role="status">{scheduling.error}</p>}
                <button
                  type="button"
                  className={button}
                  onClick={() => void scheduling.refresh()}
                >
                  Refresh CALLIE scheduling review
                </button>
                <SchedulingIntervalFields
                  {...review.fields}
                  resources={detail.bookingOptions.staff.filter(
                    (option) => option.id === staff,
                  )}
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
              <label className="block text-sm">
                Actual customer agreement
                <textarea
                  className={field}
                  required
                  minLength={10}
                  maxLength={1000}
                  disabled={booking.locked}
                  value={confirmationNote} onChange={event => bookingChange(setConfirmationNote, event.target.value)}
                />
              </label>
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  disabled={disabled || booking.locked || !review.review}
                  checked={confirmed}
                  onChange={(event) => setConfirmed(event.target.checked)}
                />The customer confirmed this exact time and the office reviewed this customer, property and technician. This is staff-recorded confirmation, not a caller-request or AI booking.</label>
              <button
                className={button}
                disabled={
                  disabled ||
                  booking.locked ||
                  !confirmed ||
                  !review.review ||
                  !staff ||
                  confirmationNote.trim().length < 10
                }
              >
                Book CALLIE confirmed visit
              </button>
            </form>
          )}
          {editable && !detail.appointment && detail.requestIntent === "visit" && !detail.identityReviewed && <p className="text-sm">Review and link the actual caller before arranging the requested visit. No appointment has been booked.</p>}
          {editable && (detail.actions.canAssign || detail.actions.canClose) && (
              <details className="min-w-0 rounded border p-3">
                <summary className="cursor-pointer font-medium">Assign or close office work</summary>
                <div className="mt-3 min-w-0 space-y-3">
                  <label className="block text-sm">
                    Office action note
                    <textarea className={field} minLength={10} maxLength={1000} value={officeNote} onChange={event => { setOfficeNote(event.target.value); setOfficeConfirmed(false); }} />
                  </label>
                  {detail.actions.canAssign && (
                    <>
                      <label className="block text-sm">
                        New accountable owner
                        <select className={field} value={owner} onChange={event => { setOwner(event.target.value); setOfficeConfirmed(false); }}>
                          <option value="">Choose accepted staff</option>
                          {detail.bookingOptions.staff.map((option) => (
                            <option key={option.id} value={option.id}>
                              {option.label}
                            </option>
                          ))}
                        </select>
                      </label>
                      <p className="text-xs">Reassignment holds the old automated acknowledgment and keeps the work office-only.</p>
                      <button className={button} disabled={disabled || !owner || officeNote.trim().length < 10} onClick={() => void perform("office-action", { action: "assign", assignedUserId: owner, note: officeNote }, "Callback owner updated. Automated acknowledgment is held for office review; no message was sent.")}>Assign CALLIE callback</button>
                    </>
                  )}
                  {detail.actions.canClose && (
                    <>
                      <label className="flex items-start gap-2 text-sm">
                        <input type="checkbox" disabled={disabled} checked={officeConfirmed} onChange={event => setOfficeConfirmed(event.target.checked)} />I reviewed the actual office outcome. This does not recall an earlier provider handoff or authorize a resend.</label>
                      <div className="flex flex-wrap gap-2">
                        <button className={button} disabled={disabled || !officeConfirmed || officeNote.trim().length < 10} onClick={() => void perform("office-action", { action: "resolved", note: officeNote, staffConfirmed: true }, "Staff marked the request handled and completed the original callback task. No customer message was sent.")}>Mark CALLIE handled</button>
                        <button className={button} disabled={disabled || !officeConfirmed || officeNote.trim().length < 10} onClick={() => void perform("office-action", { action: "cancelled", note: officeNote, staffConfirmed: true }, "CALLIE recovery stopped. The original callback task stays open; earlier provider effects are retained.")}>Stop CALLIE recovery</button>
                      </div>
                    </>
                  )}
                </div>
              </details>
            )}
        </>
      )}
    </section>
  );
}
