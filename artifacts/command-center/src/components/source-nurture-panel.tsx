import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getListUsersQueryKey, useListUsers } from "@workspace/api-client-react";
import { useSearch } from "wouter";
import { z } from "zod/v4";
import { ContractorApiError, contractorRequest } from "@/lib/contractor-api";
import { localDateTime, scheduleTimezone } from "@/lib/contractor-schedule";
import { nurtureCommandSchema, nurtureDraftSchema, nurtureListSchema, nurtureReason, nurtureStepLabel, parseNurtureDetail, type NurtureBucket, type NurtureDetail, type NurtureDraft } from "./source-nurture-types";

const field = "mt-1 block min-h-11 w-full min-w-0 rounded-lg border border-border bg-background p-2 text-base";
const button = "min-h-11 rounded-lg border border-border px-3 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50";
const primary = `${button} bg-primary text-primary-foreground`;
const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
const candidatesSchema = z.object({ candidates: z.array(z.object({ id: z.uuid(), status: z.string(), importSourceKey: z.string().nullable(), externalOpportunityId: z.string().nullable() })).max(100), page: z.number().int().nonnegative(), hasMore: z.boolean() });
const initialDraft = (businessName: string, timezone: string): NurtureDraft => ({ leadIds: [], businessName, mailingAddress: "", steps: [{ subject: "", body: "" }, { subject: "", body: "" }], timezone, days: [], startHour: 9, endHour: 18, dailyLimit: 10, startNotBefore: new Date(Date.now() + 3_600_000).toISOString(), expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString() });
function failure(cause: unknown) { return cause instanceof ContractorApiError ? nurtureReason(cause.code) : cause instanceof Error && !(cause instanceof z.ZodError) ? cause.message : "The exact response could not be verified."; }
const when = (value: string | null) => value ? new Date(value).toLocaleString() : "Not recorded";
type Props = { organizationId: string; actorUserId: string; businessName: string; timezone: string; canManage: boolean; scopeKey: string };

/** A finite reviewed workflow inside Win-back, not a second campaign dashboard. */
export function SourceNurturePanel(props: Props) {
  return <NurtureContent key={`${props.scopeKey}:${props.canManage}`} {...props} />;
}
function NurtureContent({ organizationId, actorUserId, businessName, timezone, canManage, scopeKey }: Props) {
  const cache = useQueryClient(), search = useSearch();
  const deepLink = new URLSearchParams(search).get("nurtureId");
  const [bucket, setBucket] = useState<NurtureBucket>("attention"), [offset, setOffset] = useState(0), [candidatePage, setCandidatePage] = useState(0);
  const [draft, setDraft] = useState(() => initialDraft(businessName, timezone)), [draftOpen, setDraftOpen] = useState(false);
  const [detail, setDetail] = useState<NurtureDetail | null>(null), [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false), [loading, setLoading] = useState(false), [reviewNeeded, setReviewNeeded] = useState(false), [expired, setExpired] = useState(false);
  const [approval, setApproval] = useState(false), [startConfirmed, setStartConfirmed] = useState(false), [stopConfirmed, setStopConfirmed] = useState(false), [stopReason, setStopReason] = useState("");
  const [notice, setNotice] = useState(""), [error, setError] = useState("");
  const mounted = useRef(true), generation = useRef(0), commandInFlight = useRef(false);
  const { data: users = [] } = useListUsers({ query: { queryKey: [...getListUsersQueryKey(), "source-nurture", scopeKey] } });
  const ownerName = (id: string) => { const owner = Array.isArray(users) ? users.find(user => user.id === id) : null; return owner ? [owner.firstName, owner.lastName].filter(Boolean).join(" ") || owner.email || id : id; };
  const list = useQuery({ queryKey: ["source-nurture", scopeKey, bucket, offset], retry: false, refetchOnWindowFocus: false,
    queryFn: async ({ signal }) => {
      const value = nurtureListSchema.parse(await contractorRequest<unknown>(`/source-nurture?bucket=${bucket}&offset=${offset}`, { signal }));
      if (value.organizationId !== organizationId || value.bucket !== bucket || value.offset !== offset || new Set(value.items.map(item => item.id)).size !== value.items.length) throw new Error("The worklist did not match the current company and page.");
      return value;
    },
  });
  const candidates = useQuery({ queryKey: ["nurture-source-candidates", scopeKey, candidatePage], enabled: draftOpen && canManage, retry: false,
    queryFn: async ({ signal }) => {
      const value = candidatesSchema.parse(await contractorRequest<unknown>(`/source-adoption?page=${candidatePage}&campaignPage=0`, { signal }));
      if (value.page !== candidatePage) throw new Error("Opportunity page changed. Refresh before selecting.");
      return value;
    },
  });
  function clearConfirmations() { setApproval(false); setStartConfirmed(false); setStopConfirmed(false); setExpired(false); }
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++; }; }, []);
  useEffect(() => {
    if (list.isError) { generation.current++; setDetail(null); setBusy(false); setLoading(false); clearConfirmations(); setReviewNeeded(true); }
  }, [list.isError]);
  useEffect(() => {
    if (!deepLink) { generation.current++; setDetail(null); setSelectedId(null); setLoading(false); clearConfirmations(); return; }
    if (!z.uuid().safeParse(deepLink).success) { generation.current++; setDetail(null); setSelectedId(null); setLoading(false); clearConfirmations(); setError("This saved nurture link is invalid. Select an existing plan below."); return; }
    void openPlan(deepLink);
  }, [deepLink]);
  useEffect(() => {
    if (!detail) return;
    const deadline = detail.state === "draft" ? detail.previewExpiresAt : detail.expiresAt;
    const timer = setTimeout(() => { setExpired(true); setApproval(false); setStartConfirmed(false); }, Math.max(0, Date.parse(deadline) - Date.now()));
    return () => clearTimeout(timer);
  }, [detail]);
  async function refreshList() { await cache.invalidateQueries({ queryKey: ["source-nurture", scopeKey] }); }
  async function openPlan(id: string) {
    const run = ++generation.current;
    setSelectedId(id); setLoading(true); setDetail(null); setDraftOpen(false); setReviewNeeded(true); clearConfirmations(); setError("");
    try {
      const value = parseNurtureDetail(await contractorRequest<unknown>(`/source-nurture/${id}`), organizationId, id);
      if (!mounted.current || run !== generation.current) return;
      setDetail(value); setReviewNeeded(false);
    } catch (cause) {
      if (mounted.current && run === generation.current) setError(`${failure(cause)} Refresh saved evidence before any further action.`);
    } finally { if (mounted.current && run === generation.current) setLoading(false); }
  }
  function newDraft() {
    if (!canManage || busy || loading || reviewNeeded || list.isError) return;
    generation.current++; clearConfirmations(); setDetail(null); setSelectedId(null); setDraft(initialDraft(businessName, timezone)); setDraftOpen(true); setCandidatePage(0); setError(""); setNotice("This is a new review. Earlier plans and their permanent address reservations are unchanged; this cannot retry an earlier send.");
  }
  const draftValid = nurtureDraftSchema.safeParse(draft).success && Date.parse(draft.startNotBefore) >= Date.now() - 60_000 && Date.parse(draft.expiresAt) > Date.parse(draft.startNotBefore) + 72 * 3_600_000 && Date.parse(draft.expiresAt) <= Date.now() + 14 * 86_400_000;
  async function prepare(event: React.FormEvent) {
    event.preventDefault();
    if (!canManage || commandInFlight.current || !draftValid || !draftOpen || candidates.isError || list.isError) return;
    commandInFlight.current = true; const run = ++generation.current; setBusy(true); setError(""); setNotice(""); clearConfirmations();
    try {
      const input = nurtureDraftSchema.parse(draft);
      const value = parseNurtureDetail(await contractorRequest<unknown>("/source-nurture/preview", { method: "POST", body: input }), organizationId);
      if (value.createdByUserId !== actorUserId || value.state !== "draft" || value.items.length !== input.leadIds.length || value.items.some(item => !input.leadIds.includes(item.leadId))) throw new Error("The preview did not match your exact selected opportunities and current reviewer.");
      if (!mounted.current || run !== generation.current) return;
      setDetail(value); setSelectedId(value.id); setDraftOpen(false); setReviewNeeded(false);
      setNotice("Exact review saved. No approval, enrollment or send was performed. Review both complete messages for every recipient below.");
      await refreshList();
    } catch (cause) {
      if (mounted.current && run === generation.current) { setReviewNeeded(true); setError(`${failure(cause)} The preview result is unconfirmed. Refresh saved work before preparing another review; no automatic retry was made.`); }
    } finally { commandInFlight.current = false; if (mounted.current) setBusy(false); }
  }
  async function command(action: "approve" | "start" | "stop") {
    if (!canManage || !detail || busy || commandInFlight.current || loading || reviewNeeded || list.isError) return;
    if (action === "approve" && (!approval || detail.state !== "draft" || detail.createdByUserId !== actorUserId || expired || Date.parse(detail.previewExpiresAt) <= Date.now())) return;
    if (action === "start" && (!startConfirmed || detail.state !== "approved" || expired || Date.parse(detail.expiresAt) <= Date.now())) return;
    if (action === "stop" && (!stopConfirmed || stopReason.trim().length < 10 || ["stopped", "finished", "expired"].includes(detail.state))) return;
    commandInFlight.current = true; const run = generation.current;
    const requestId = action === "approve" ? null : crypto.randomUUID();
    const reviewed = detail;
    setBusy(true); clearConfirmations(); setNotice(""); setError("");
    try {
      const raw = await contractorRequest<unknown>(`/source-nurture/${reviewed.id}/${action}`, { method: "POST", body: { expectedVersion: reviewed.version, payloadSha256: reviewed.payloadSha256, confirmed: true, ...(requestId ? { requestId } : {}), ...(action === "stop" ? { reason: stopReason.trim() } : {}) } });
      const result = nurtureCommandSchema.parse(raw);
      const saved = parseNurtureDetail(result.detail, organizationId, reviewed.id);
      if (result.command.action !== action || result.command.requestId !== requestId || result.command.appliedVersion !== reviewed.version + 1 || saved.version < result.command.appliedVersion || saved.payloadSha256 !== reviewed.payloadSha256) throw new Error("The command receipt did not match this exact review.");
      if (!mounted.current || run !== generation.current) return;
      setDetail(saved); setReviewNeeded(false); setStopReason("");
      setNotice(action === "approve" ? "Exact plan approved. It has not started and no email was sent by approval. A separate start is required." : action === "start" ? "Start receipt saved. Only this finite plan was admitted. Inspect each original step below; start is not provider acceptance or delivery." : "Stop receipt saved. Remaining unclaimed emails are stopped. A dispatched request cannot be recalled; unknown results and original reservations remain.");
      await refreshList();
    } catch (cause) {
      if (mounted.current && run === generation.current) { setReviewNeeded(true); setError(`${failure(cause)} This result is unconfirmed. Refresh this exact saved plan before another decision. Do not retry, clone or create a replacement send.`); }
    } finally { commandInFlight.current = false; if (mounted.current) setBusy(false); }
  }
  async function refreshSaved() {
    if (busy || loading) return;
    clearConfirmations(); setError(""); setReviewNeeded(true);
    const refreshed = await list.refetch();
    if (!mounted.current) return;
    if (refreshed.isError) { setReviewNeeded(true); return; }
    if (selectedId) await openPlan(selectedId); else setReviewNeeded(false);
  }
  const locked = busy || loading || reviewNeeded || !canManage || list.isError;
  return <section aria-labelledby="source-nurture-title" className="min-w-0 space-y-4 rounded-xl border border-border p-4">
    <header className="space-y-2"><h2 id="source-nurture-title" className="text-lg font-semibold">Reviewed two-message follow-up</h2><p className="max-w-prose text-sm text-muted-foreground">Recover a small set of adopted, independently permissioned opportunities with two fixed Microsoft emails. At most ten addresses; no rolling enrollment or automatic renewal. Existing one-touch campaigns remain separate.</p></header>
    <div className="flex flex-wrap gap-2"><button type="button" className={button} disabled={busy || loading || list.isFetching} onClick={() => void refreshSaved()}>Refresh saved nurture work</button>{canManage && <button type="button" className={button} disabled={locked || list.isPending} onClick={newDraft}>Prepare a new two-message review</button>}</div>
    {error && <p role="alert" className="break-words">{error}</p>}{notice && <p role="status" className="break-words">{notice}</p>}
    {!canManage && <p className="text-sm">Read-only: an accepted active owner or administrator must approve, start or stop a plan. Customer permission and provider readiness remain separate.</p>}
    <nav aria-label="Nurture work queues" className="flex flex-wrap gap-2">{(["attention", "waiting", "history"] as const).map(value => <button type="button" key={value} className={button} aria-pressed={bucket === value} disabled={busy || loading} onClick={() => { setBucket(value); setOffset(0); }}>{({ attention: "Needs attention", waiting: "Waiting", history: "History" })[value]}</button>)}</nav>
    {list.isPending ? <p role="status">Loading nurture work…</p> : list.isError ? <p role="alert">Nurture work is unavailable. Current authority and evidence cannot be inferred; refresh before any decision.</p> : <>
      <p className="text-xs text-muted-foreground">Page {Math.floor(offset / 25) + 1} · up to 25 plans. Counts below belong to individual saved plans, not the whole company. The server keeps oldest attention work discoverable.</p>
      {!list.data.items.length && <p className="text-sm">No plans on this page. This does not establish provider readiness or absence of customer replies.</p>}
      <div className="space-y-2">{list.data.items.map(item => <article key={item.id} className="min-w-0 space-y-1 rounded-lg border p-3 text-sm"><button type="button" className={`${button} max-w-full text-left`} disabled={busy || loading} aria-current={selectedId === item.id ? "true" : undefined} onClick={() => void openPlan(item.id)}>Review {item.state} plan · {item.recipientCount} {item.recipientCount === 1 ? "recipient" : "recipients"} · {when(item.createdAt)}</button><p>{item.acceptedSteps} provider-accepted emails (delivery unconfirmed) · {item.uncertainSteps} unknown results.</p>{item.reason && <p className="break-words">{nurtureReason(item.reason)}</p>}{item.nextCheckAt && <p>Next bounded check: {when(item.nextCheckAt)}</p>}<p>Expires {when(item.expiresAt)}</p></article>)}</div>
      {(offset > 0 || list.data.hasMore) && <nav aria-label="Nurture plan pages" className="flex flex-wrap items-center gap-2"><button type="button" className={button} disabled={offset === 0 || list.isFetching || busy} onClick={() => setOffset(value => Math.max(0, value - 25))}>Previous nurture plans</button><button type="button" className={button} disabled={!list.data.hasMore || offset >= 100_000 || list.isFetching || busy} onClick={() => setOffset(value => value + 25)}>More nurture plans</button></nav>}
    </>}
    {draftOpen && canManage && !list.isError && <form className="min-w-0 space-y-4 rounded-lg border p-3" onSubmit={prepare}>
      <h3 className="font-semibold">Prepare both messages and the exact finite window</h3><p className="text-sm">First review source management and independent address permission above. A selected imported record is not necessarily eligible. The server freezes current facts and every complete recipient-specific message.</p>
      <fieldset disabled={locked} className="min-w-0 space-y-3"><legend className="text-sm font-medium">Selected opportunities: {draft.leadIds.length} / 10 across pages</legend>
        {candidates.isPending ? <p>Loading imported opportunities…</p> : candidates.isError ? <p role="alert">Source candidates unavailable. No review can be prepared.</p> : <>
          <div className="max-h-60 space-y-2 overflow-y-auto">{candidates.data.candidates.map(item => <label className="flex min-w-0 items-start gap-2 break-words text-sm" key={item.id}><input type="checkbox" checked={draft.leadIds.includes(item.id)} disabled={!draft.leadIds.includes(item.id) && draft.leadIds.length >= 10} onChange={event => setDraft(value => ({ ...value, leadIds: event.target.checked ? [...value.leadIds, item.id] : value.leadIds.filter(id => id !== item.id) }))} /><span className="min-w-0 [overflow-wrap:anywhere]">{item.importSourceKey ?? "Unknown source"} / {item.externalOpportunityId ?? "Missing source identity"} · {item.status}</span></label>)}</div>
          {(candidatePage > 0 || candidates.data.hasMore) && <div className="flex flex-wrap gap-2"><button type="button" className={button} disabled={candidatePage === 0 || candidates.isFetching} onClick={() => setCandidatePage(value => value - 1)}>Previous nurture opportunities</button><span className="text-sm">Source page {candidatePage + 1} · up to 100 records</span><button type="button" className={button} disabled={!candidates.data.hasMore || candidates.isFetching} onClick={() => setCandidatePage(value => value + 1)}>More nurture opportunities</button></div>}
        </>}
        <button type="button" className={button} disabled={!draft.leadIds.length} onClick={() => setDraft(value => ({ ...value, leadIds: [] }))}>Clear nurture selection</button>
        <label className="block text-sm">Nurture business name<input className={field} readOnly value={draft.businessName} /><span className="text-xs">Uses the recorded company identity. A changed company identity requires a new review.</span></label>
        <label className="block text-sm">Nurture business mailing address<textarea className={field} required minLength={10} maxLength={400} value={draft.mailingAddress} onChange={event => setDraft(value => ({ ...value, mailingAddress: event.target.value }))} /></label>
        {([0, 1] as const).map(index => <div key={index} className="space-y-2 rounded-lg border p-3"><h4 className="font-medium">Email {index + 1} of 2</h4><label className="block text-sm">Email {index + 1} subject<input className={field} required minLength={3} maxLength={180} value={draft.steps[index].subject} onChange={event => setDraft(value => ({ ...value, steps: value.steps.map((step, position) => position === index ? { ...step, subject: event.target.value } : step) as NurtureDraft["steps"] }))} /></label><label className="block text-sm">Email {index + 1} message<textarea className={field} required minLength={10} maxLength={4000} rows={5} value={draft.steps[index].body} onChange={event => setDraft(value => ({ ...value, steps: value.steps.map((step, position) => position === index ? { ...step, body: event.target.value } : step) as NurtureDraft["steps"] }))} /></label></div>)}
        <p className="text-sm">The complete preview includes the business identification, mailing address and unsubscribe footer. No AI rewriting occurs after review. Email two cannot run until at least 72 hours after actual acceptance of email one and a fresh bounded reply check.</p>
        <label className="block text-sm">Nurture sending timezone<input className={field} required value={draft.timezone} onChange={event => setDraft(value => ({ ...value, timezone: event.target.value }))} /></label>
        <div className="flex flex-wrap gap-3" role="group" aria-label="Nurture sending days">{days.map(day => <label key={day} className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" checked={draft.days.includes(day)} onChange={event => setDraft(value => ({ ...value, days: event.target.checked ? [...value.days, day] : value.days.filter(item => item !== day) }))} />{day}</label>)}</div>
        <div className="grid min-w-0 gap-3 sm:grid-cols-3"><label className="min-w-0 text-sm">Nurture start hour (24-hour)<input type="number" className={field} min={8} max={19} value={draft.startHour} onChange={event => setDraft(value => ({ ...value, startHour: Number(event.target.value) }))} /></label><label className="min-w-0 text-sm">Nurture end hour (24-hour)<input type="number" className={field} min={9} max={20} value={draft.endHour} onChange={event => setDraft(value => ({ ...value, endHour: Number(event.target.value) }))} /></label><label className="min-w-0 text-sm">Reviewed company daily cap<input type="number" className={field} min={1} max={25} value={draft.dailyLimit} onChange={event => setDraft(value => ({ ...value, dailyLimit: Number(event.target.value) }))} /></label></div>
        <div className="grid min-w-0 gap-3 sm:grid-cols-2"><label className="min-w-0 text-sm">First email no earlier than ({scheduleTimezone})<input type="datetime-local" className={field} required value={localDateTime(draft.startNotBefore)} onChange={event => setDraft(value => ({ ...value, startNotBefore: event.target.value ? new Date(event.target.value).toISOString() : "" }))} /></label><label className="min-w-0 text-sm">Nurture expires within 14 days ({scheduleTimezone})<input type="datetime-local" className={field} required value={localDateTime(draft.expiresAt)} onChange={event => setDraft(value => ({ ...value, expiresAt: event.target.value ? new Date(event.target.value).toISOString() : "" }))} /></label></div>
        <p className="text-xs">Allow more than 72 hours between the first possible send and expiry, with an initial time that has not passed. The plan must end within 14 days and before any source approval expires. Its exact timezone and the company's stricter quiet-hour and contact caps still apply. No backfill, expired catch-up or alternate sender.</p>
        <button className={primary} disabled={locked || !draftValid || candidates.isError || candidates.isPending}>Prepare exact two-message preview</button>
      </fieldset>
    </form>}
    {loading && <p role="status">Loading exact nurture evidence…</p>}
    {detail && !list.isError && <div className="min-w-0 space-y-4 border-t pt-4">
      <h3 className="font-semibold">Saved plan: {detail.state} · version {detail.version}</h3><p className="text-sm">{detail.readiness.ready ? "At the last refresh, checks permitted the next applicable action; nothing is sent by this view." : `Held or waiting at the last refresh: ${nurtureReason(detail.readiness.reason)}`}</p>
      <p className="text-sm">Review expires {when(detail.previewExpiresAt)}. First email no earlier than {when(detail.startNotBefore)}; all work expires {when(detail.expiresAt)}. Email two is at least 72 hours after actual first-email acceptance, never merely 72 hours after approval.</p>
      <p className="break-words text-sm">Sending window: {detail.settings.days.join(", ")} · {detail.settings.startHour}:00–{detail.settings.endHour}:00 {detail.settings.timezone}. Reviewed company daily cap: {detail.settings.dailyLimit}. Dates shown in this browser's {scheduleTimezone} time zone.</p>
      <p className="text-sm">Approved {when(detail.approvedAt)} · Started {when(detail.startedAt)} · Stopped {when(detail.stoppedAt)}.</p>{detail.stopReason && <p className="break-words text-sm">Stop reason: {detail.stopReason}</p>}
      <a className="break-all text-sm underline" href={`/reactivation?nurtureId=${detail.id}`}>Open this saved plan directly</a>
      {detail.items.map(item => <article key={item.id} className="min-w-0 space-y-3 rounded-lg border p-3">
        <h4 className="break-words font-semibold">{item.recipient}</h4><p className="break-words text-sm">Accountable office owner: {ownerName(item.ownerUserId)} <span className="text-xs text-muted-foreground">({item.ownerUserId})</span>.</p>
        <p className="break-words text-sm">Source: {item.snapshot.adoption.importSourceKey} / {item.snapshot.adoption.externalOpportunityId}. Adoption version {item.snapshot.adoptionVersion}. Marketing permission is independently recorded for this exact address; this screen does not verify the customer's consent.</p>
        <details className="min-w-0 break-words text-xs"><summary className="cursor-pointer font-medium">Exact source, customer and permission references</summary><div className="mt-2 space-y-1"><p>Lead {item.leadId} · customer {item.contactId} · property {item.propertyId ?? "None recorded"}.</p><p>Source approval {item.snapshot.adoptionId}, version {item.snapshot.adoptionVersion}. Address-permission record {item.snapshot.permissionRecordId}.</p><p>Original opportunity date: {when(item.snapshot.adoption.importedHistory.originalCreatedAt)}; source snapshot: {when(item.snapshot.adoption.importedHistory.snapshotAsOf)}. These historical dates are not a new inquiry.</p><p>Source snapshot hash: {item.snapshot.adoption.sourceSha256}. Exact plan review hash: {detail.payloadSha256}.</p></div></details>
        <p className="break-words text-sm">From {item.snapshot.sender.senderEmail} (Microsoft; {item.snapshot.sender.source.replaceAll("_", " ")}). Approved reader: {item.snapshot.mailboxIdentity.mailboxEmail}, connector version {item.snapshot.mailboxIdentity.connectorVersion}, forward-only start {when(item.snapshot.mailboxIdentity.startedAt)}. Separate nurture grant version {item.snapshot.nurtureMonitoringApproval.version}, approved {when(item.snapshot.nurtureMonitoringApproval.approvedAt)}.</p>
        <p className="text-sm">{item.readiness.ready ? "Item current checks ready; no send implied." : nurtureReason(item.readiness.reason)}</p>
        <div className="break-words rounded-lg bg-muted/40 p-3 text-sm"><p>{item.mailboxSync.ready ? "The last refresh reported a fresh bounded mailbox cycle." : `Mailbox progression held: ${nurtureReason(item.mailboxSync.reason)}`}</p><p>Complete cycle: {item.mailboxSync.completedCycleId ?? "None"} · started {when(item.mailboxSync.startedAt)} · completed {when(item.mailboxSync.completedAt)}. A completed bounded check is not proof that no reply exists anywhere. Step two must recheck this evidence before dispatch.</p></div>
        {item.steps.map(step => <section key={step.id} aria-label={`Email ${step.stepIndex} for ${item.recipient}`} className="min-w-0 space-y-2 rounded-lg border p-3"><h5 className="font-semibold">Email {step.stepIndex} of 2 — {nurtureStepLabel(step.state)}</h5><p className="break-words font-medium">Subject: {step.subject}</p><pre className="whitespace-pre-wrap break-words font-sans text-sm [overflow-wrap:anywhere]">{step.body}</pre>{step.reason && <p className="break-words text-sm">{nurtureReason(step.reason)}</p>}<p className="text-xs">Earliest original step time: {when(step.notBefore)} · accepted {when(step.acceptedAt)} · Sent Items parent observed {when(step.observedAt)}.</p>{(step.executionId || step.executionState || step.claimedAt || step.dispatchStartedAt) && <p className="break-words text-xs">Original receipt: {step.executionId ?? "No execution ID recorded"} · {step.executionState ?? "state not recorded"} · claimed {when(step.claimedAt)} · dispatch boundary {when(step.dispatchStartedAt)}. This receipt is never replaced to retry an unknown result.</p>}</section>)}
        <div className="flex flex-wrap gap-3 text-sm"><a className="underline" href={`/leads/${item.leadId}?tab=messages`}>Open lead and original replies ({item.outcomes.replyIds.length})</a>{item.outcomes.taskIds.map(id => <a className="underline" key={id} href={`/tasks?taskId=${id}`}>Open office task</a>)}</div>{item.outcomes.appointmentIds.length > 0 && <p className="break-words text-sm">Recorded appointment IDs: {item.outcomes.appointmentIds.join(", ")}. <a className="underline" href="/appointments">Open schedule</a> (adjust its date range to review the recorded appointment).</p>}<p className="text-xs">Current lead status: {item.outcomes.leadStatus}. These are recorded outcomes, not proof the plan caused a sale. No delivery, booking or recovered revenue is inferred.</p>
      </article>)}
      {reviewNeeded && <p role="alert">The last result is unconfirmed. Refresh this saved plan before any command; no new key or automatic retry is available.</p>}
      {canManage && detail.state === "draft" && <div className="space-y-3"><label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={approval} disabled={locked || expired || detail.createdByUserId !== actorUserId} onChange={event => setApproval(event.target.checked)} /><span>I reviewed every exact recipient, office owner, sender, reader grant, both full messages and footers, timing and expiry. Approve only this frozen plan; do not send or start it.</span></label><button type="button" className={primary} disabled={locked || !approval || expired || detail.createdByUserId !== actorUserId} onClick={() => void command("approve")}>Approve exact nurture plan — does not start</button>{expired && <p className="text-sm">The ten-minute review expired. A fresh preview is required; earlier reservations are unchanged.</p>}{detail.createdByUserId !== actorUserId && <p className="text-sm">Only the member who prepared this actor-bound review can approve it.</p>}</div>}
      {canManage && detail.state === "approved" && <div className="space-y-3"><label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={startConfirmed} disabled={locked || expired} onChange={event => setStartConfirmed(event.target.checked)} /><span>Explicitly start only these frozen recipients and two messages, subject to all current holds. Starting permanently reserves the original opportunity and address; it is not a delivery confirmation.</span></label><button type="button" className={primary} disabled={locked || !startConfirmed || expired} onClick={() => void command("start")}>Start approved two-message plan</button></div>}
      {canManage && !["stopped", "finished", "expired"].includes(detail.state) && <div className="space-y-3 rounded-lg border p-3"><h4 className="font-semibold">Stop future unclaimed plan work</h4><label className="block text-sm">Nurture stop reason<textarea className={field} maxLength={1000} value={stopReason} disabled={locked} onChange={event => { setStopReason(event.target.value); setStopConfirmed(false); }} /></label><label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={stopConfirmed} disabled={locked} onChange={event => setStopConfirmed(event.target.checked)} /><span>I want to stop remaining unclaimed work. Already dispatched requests cannot be recalled; unknown outcomes and permanent reservations remain, and this plan has no resume action.</span></label><button type="button" className={button} disabled={locked || !stopConfirmed || stopReason.trim().length < 10} onClick={() => void command("stop")}>Stop this nurture plan</button></div>}
      <p className="text-xs text-muted-foreground">A reply, opt-out, booked appointment, terminal lead outcome or explicit stop blocks future unclaimed messages. Office reply handling never restarts cancelled work, creates consent or books an appointment.</p>
    </div>}
  </section>;
}
