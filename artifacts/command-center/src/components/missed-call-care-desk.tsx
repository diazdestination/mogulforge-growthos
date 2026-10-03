import { useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { getGetMeQueryKey, getListUsersQueryKey, useGetMe, useListUsers, type MemberProfile } from "@workspace/api-client-react";
import { canManageSettings, canWrite } from "@/lib/permissions";
import { memberAuthorityScope } from "@/lib/member-authority-scope";

type Policy = { enabled: boolean; timezone: string; days: number[]; opensAt: string; closesAt: string; businessHoursOwnerId: string | null; afterHoursOwnerId: string | null; responseMinutes: number };
type Item = {
  care: { id: string; state: string; version: number; reason: string; dueAt: string; ownerUserId: string | null };
  call: { id: string; phone: string; createdAt: string };
  handoff: { reviewedAt: string | null; leadId: string | null; taskId: string };
  delivery: { status: string; providerSid: string | null } | null;
  replies: { messageSid: string; eventType: string; body: string | null; receivedAt: string }[];
};
type Desk = { policy: Policy; version: number; body: string; templateVersion: string; items: Item[]; companyPaused: boolean; environmentHeld: boolean };
type Preview = { caseId: string; version: number; snapshot: Record<string, unknown> & { renderedMessage: string; phone: string }; eligibility: { ready: boolean; reason: string | null; resumeAt?: string } };
const labels: Record<string, string> = { needs_review: "Staff review needed", approved: "Approved · waiting for worker", deferred: "Waiting for sending window", dispatching: "Provider handoff in progress", awaiting_reply: "Provider accepted · waiting for reply", reply_needs_review: "Customer reply needs attention", blocked: "Sending blocked", indeterminate: "Outcome unknown · do not resend", escalated: "Callback needs attention", resolved: "Handled by staff", cancelled: "Cancelled by staff" };
const reasons: Record<string, string> = { caller_review_required: "Review and link this caller in Business calls first.", care_policy_disabled: "An owner must enable and approve the recovery policy first.", customer_care_consent_required: "This caller needs a current customer-care SMS opt-in. Caller ID is not consent.", sms_not_approved: "The company SMS number and program are not approved for sending.", stale_approval: "The call or policy changed. Refresh and review a new preview.", recovery_already_owned: "This call already has a recovery operation. Refresh its status; do not resend.", provider_reconciliation_required: "An owner must reconcile the original execution receipt before this case can close.", owner_unavailable: "Choose active, accepted staff for both ownership roles.", sending_window_changed: "The approved sending conditions changed.", stale_policy: "Another person changed this policy. Refresh before saving." };
const human = (code: string) => reasons[code] ?? code.replaceAll("_", " ");
async function request<T>(path: string, body?: unknown, method = "POST"): Promise<T> {
  const response = await fetch(`/api/v1${path}`, { credentials: "include", ...(body === undefined ? {} : { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) });
  const result = await response.json();
  if (!response.ok) throw new Error(human(result.code ?? result.error ?? "Could not load this operation."));
  return result as T;
}

export function MissedCallCareDesk({ refreshToken = 0 }: { refreshToken?: number }) {
  const { data: me, isError } = useGetMe({ query: { queryKey: getGetMeQueryKey(), refetchOnMount: false } });
  if (isError || !me?.isActive || !me.organization) return null;
  // Membership changes must discard every old-company preview and checkbox.
  const scopeKey = memberAuthorityScope(me);
  return <CarePanel key={scopeKey} scopeKey={scopeKey} me={me} refreshToken={refreshToken} />;
}
function CarePanel({ scopeKey, me, refreshToken }: { scopeKey: string; me: MemberProfile; refreshToken: number }) {
  const { data: users = [] } = useListUsers({ query: { queryKey: [...getListUsersQueryKey(), "missed-call-care", scopeKey] } });
  const [desk, setDesk] = useState<Desk | null>(null), [draft, setDraft] = useState<Policy | null>(null);
  const [policyApproved, setPolicyApproved] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [preview, setPreview] = useState<{ callId: string; data: Preview } | null>(null), [messageApproved, setMessageApproved] = useState(false);
  const mounted = useRef(true), generation = useRef(0);
  const edit = canWrite(me.role), manage = canManageSettings(me.role);
  async function refresh() {
    const current = ++generation.current;
    setPreview(null); setMessageApproved(false); setPolicyApproved(false);
    try {
      const state = await request<Desk>("/communications/missed-call-care");
      if (mounted.current && generation.current === current) { setDesk(state); setDraft(state.policy); }
    } catch (failure) {
      if (mounted.current && generation.current === current) { setDesk(null); setDraft(null); setError(failure instanceof Error ? failure.message : "Recovery status could not be loaded."); }
    }
  }
  useEffect(() => { mounted.current = true; void refresh(); return () => { mounted.current = false; generation.current++; }; }, [refreshToken]);
  function change(patch: Partial<Policy>) { setDraft((current) => current ? { ...current, ...patch } : current); setPolicyApproved(false); }
  async function action(work: () => Promise<unknown>, success: string) {
    setBusy(true); setError(""); setNotice(""); setPreview(null); setMessageApproved(false);
    try { await work(); if (mounted.current) setNotice(success); }
    catch (failure) { if (mounted.current) setError(`${failure instanceof Error ? failure.message : "Result not confirmed."} Refresh status before another action; no automatic retry was made.`); }
    finally { if (mounted.current) { await refresh(); setBusy(false); } }
  }
  async function loadPreview(callId: string) {
    const current = ++generation.current;
    setBusy(true); setError(""); setPreview(null); setMessageApproved(false);
    try { const result = await request<Preview>(`/communications/voice/${callId}/care`); if (mounted.current && generation.current === current) setPreview({ callId, data: result }); }
    catch (failure) { if (mounted.current && generation.current === current) setError(failure instanceof Error ? failure.message : "Preview unavailable."); }
    finally { if (mounted.current && generation.current === current) setBusy(false); }
  }
  const ownerName = (id: string | null) => { const user = users.find((entry) => entry.id === id); return user ? [user.firstName, user.lastName].filter(Boolean).join(" ") || user.email || "Staff member" : "Owner needs assignment"; };
  const eligibleOwners = users.filter((user) => user.isActive && user.operationallyEligible === true && canWrite(user.role));
  return <section className="rounded-lg border bg-card p-5 space-y-4" aria-label="Missed-call recovery">
    <div className="flex items-center justify-between gap-3"><h2 className="text-lg font-semibold">CALLIE · Missed-call recovery</h2><button className="text-sm underline disabled:opacity-50" disabled={busy} onClick={() => { setError(""); void refresh(); }}>Refresh recovery</button></div>
    <p className="text-sm text-muted-foreground">Review the caller, approve one exact reply, then follow the response. A call does not grant SMS consent. Unknown callers are not enrolled automatically, and this workflow does not confirm an appointment or emergency dispatch.</p>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {notice && <p role="status" className="text-sm">{notice}</p>}
    {!desk && !error && <p className="text-sm">Loading recovery status…</p>}
    {desk && <>
      <p className="text-sm font-medium">Policy: {desk.policy.enabled ? "Enabled for individually reviewed calls" : "Disabled · no recovery texts will be sent"}</p>
      {(desk.companyPaused || desk.environmentHeld) && <p role="status" className="rounded border p-3 text-sm">Outbound work is on hold{desk.companyPaused ? " for this company" : " in this environment"}. Approvals do not override it.</p>}
      {manage && draft && <details className="rounded border p-3"><summary className="cursor-pointer font-medium">Owners, hours and message policy</summary>
        <form className="mt-3 space-y-3" onSubmit={(event) => { event.preventDefault(); if (!policyApproved || busy) return; void action(() => request("/communications/missed-call-care/policy", { expectedVersion: desk.version, policy: draft, approveTemplate: true }, "PUT"), "Recovery policy saved. No existing call was automatically approved."); }}>
          <label className="flex gap-2 text-sm"><input type="checkbox" checked={draft.enabled} onChange={(e) => change({ enabled: e.target.checked })} />Enable reviewed missed-call responses</label>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-sm">Time zone<input className="block w-full rounded border p-2" required value={draft.timezone} onChange={(e) => change({ timezone: e.target.value })} placeholder="America/New_York" /></label>
            <label className="text-sm">Follow-up deadline (minutes)<input className="block w-full rounded border p-2" type="number" min={5} max={1440} required value={draft.responseMinutes} onChange={(e) => change({ responseMinutes: Number(e.target.value) })} /></label>
            <label className="text-sm">Opens at<input className="block w-full rounded border p-2" type="time" required value={draft.opensAt} onChange={(e) => change({ opensAt: e.target.value })} /></label>
            <label className="text-sm">Closes at<input className="block w-full rounded border p-2" type="time" required value={draft.closesAt} onChange={(e) => change({ closesAt: e.target.value })} /></label>
            {(["businessHoursOwnerId", "afterHoursOwnerId"] as const).map((field) => <label key={field} className="text-sm">{field === "businessHoursOwnerId" ? "Business-hours owner" : "After-hours owner"}<select className="block w-full rounded border p-2" value={draft[field] ?? ""} onChange={(e) => change({ [field]: e.target.value || null })}><option value="">Choose accepted staff</option>{eligibleOwners.map((user) => <option key={user.id} value={user.id}>{ownerName(user.id)}</option>)}</select></label>)}
          </div>
          <fieldset><legend className="text-sm">Business days</legend><div className="flex flex-wrap gap-3">{["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((name, index) => <label key={name} className="flex gap-1 text-sm"><input type="checkbox" checked={draft.days.includes(index + 1)} onChange={(e) => change({ days: e.target.checked ? [...draft.days, index + 1].sort() : draft.days.filter((day) => day !== index + 1) })} />{name}</label>)}</div></fieldset>
          <p className="rounded bg-muted p-3 text-sm">{desk.body}<br /><span className="text-muted-foreground">The final preview adds your approved business name and STOP/HELP instructions. Customer texts wait for these business hours; after-hours calls still belong to the after-hours owner. Approvals expire after 24 hours.</span></p>
          <label className="flex gap-2 text-sm"><input type="checkbox" checked={policyApproved} onChange={(e) => setPolicyApproved(e.target.checked)} />I approve these owners, hours and the customer-care template.</label>
          <button className="rounded border px-3 py-2 text-sm disabled:opacity-50" disabled={!policyApproved || busy}>Save recovery policy</button>
        </form>
      </details>}
      {!desk.items.length && <p className="text-sm text-muted-foreground">No missed-call recovery cases yet. Signed missed calls will appear here for staff review.</p>}
      <ul className="space-y-3">{desk.items.map((item) => <li key={item.care.id} className="rounded border p-3 space-y-2">
        <div className="flex flex-wrap justify-between gap-2"><h3 className="font-medium">{item.call.phone}</h3><span className="text-sm font-medium">{labels[item.care.state] ?? human(item.care.state)}</span></div>
        <p className="text-xs text-muted-foreground">{ownerName(item.care.ownerUserId)} · Follow-up due {new Date(item.care.dueAt).toLocaleString()} · {human(item.care.reason)}</p>
        <div className="flex flex-wrap gap-3 text-sm"><Link className="underline" href={`/tasks?taskId=${item.handoff.taskId}`}>Open callback task</Link>{item.handoff.leadId && <Link className="underline" href={`/leads/${item.handoff.leadId}`}>Open opportunity</Link>}</div>
        {item.delivery && <p className="text-sm">SMS provider status: {human(item.delivery.status)}. {item.delivery.status === "delivered" ? "Provider-reported delivery is not proof of reading or booking." : "Acceptance is not confirmed delivery or a customer response."}</p>}
        {!!item.replies.length && <div className="rounded bg-muted p-2 text-sm"><p>Recent texts from this phone in your company · staff must confirm which request they concern.</p>{item.replies.map((reply) => <p key={reply.messageSid} className="mt-1">{reply.eventType === "message" ? reply.body : reply.eventType} <span className="text-xs text-muted-foreground">· {new Date(reply.receivedAt).toLocaleString()}</span></p>)}</div>}
        {item.care.state === "indeterminate" && <p className="text-sm">Check the original provider operation and record reconciliation in <Link className="underline" href="/bie">Revenue Desk</Link>. Do not approve another send for this call.</p>}
        {edit && <div className="flex flex-wrap gap-3 text-sm">
          {["needs_review", "blocked", "escalated"].includes(item.care.state) && <button className="underline disabled:opacity-50" disabled={busy || !item.handoff.reviewedAt || !desk.policy.enabled || desk.companyPaused || desk.environmentHeld} onClick={() => void loadPreview(item.call.id)}>Preview one customer-care reply</button>}
          {!["dispatching", "resolved", "cancelled"].includes(item.care.state) && <>
            <button className="underline disabled:opacity-50" disabled={busy} onClick={() => void action(() => request(`/communications/voice/${item.call.id}/care/close`, { expectedVersion: item.care.version, outcome: "resolved" }), "Staff marked this case handled. No customer message was sent.")}>Mark handled by staff</button>
            {item.care.state !== "indeterminate" && <button className="underline disabled:opacity-50" disabled={busy} onClick={() => void action(() => request(`/communications/voice/${item.call.id}/care/close`, { expectedVersion: item.care.version, outcome: "cancelled" }), "Recovery cancelled. Any earlier provider handoff is not recalled.")}>Cancel recovery</button>}
          </>}
        </div>}
        {!item.handoff.reviewedAt && <p className="text-xs text-muted-foreground">Review and link this caller in Business calls above before approving a text.</p>}
      </li>)}</ul>
    </>}
    {preview && <div className="rounded border border-primary p-4 space-y-3" aria-label="Approve missed-call reply">
      <h3 className="font-semibold">Exact reply to {preview.data.snapshot.phone}</h3><p className="whitespace-pre-wrap text-sm">{preview.data.snapshot.renderedMessage}</p>
      {!preview.data.eligibility.ready && <p role="alert" className="text-sm">{human(preview.data.eligibility.reason ?? "sending_blocked")}</p>}
      {preview.data.eligibility.resumeAt && <p className="text-sm">This reply will wait until {new Date(preview.data.eligibility.resumeAt).toLocaleString()} ({human(preview.data.eligibility.reason ?? "sending_window")}). It will be checked again before sending.</p>}
      <label className="flex gap-2 text-sm"><input type="checkbox" checked={messageApproved} onChange={(e) => setMessageApproved(e.target.checked)} />I reviewed this caller and approve this exact one-time reply.</label>
      <button className="rounded bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50" disabled={busy || !edit || !messageApproved || !preview.data.eligibility.ready} onClick={() => {
        const approved = preview; void action(() => request(`/communications/voice/${approved.callId}/care/approve`, { expectedVersion: approved.data.version, expectedSnapshot: approved.data.snapshot, approve: true }), "Reply approved and queued for guarded processing. This is not delivery confirmation.");
      }}>Approve and queue one reply</button>
    </div>}
  </section>;
}
