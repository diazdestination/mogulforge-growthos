import { useEffect, useRef, useState } from "react";
import { getListUsersQueryKey, useListUsers } from "@workspace/api-client-react";
import { canWrite } from "@/lib/permissions";
import { callieButton as button, callieField as field, callieLabel, callieRequest, calliePolicySchema, policyPreviewFor, samePolicyFields, type CalliePolicy, type CalliePolicyPreview, type CallieSettings } from "./callie-contract";

export default function CalliePolicyPanel({ scopeKey, organizationId, actorId, manage, refreshToken, onSaved, onSaving }: { scopeKey: string; organizationId: string; actorId: string; manage: boolean; refreshToken: number; onSaved: () => void | Promise<void>; onSaving: (saving: boolean) => void }) {
  const { data: users = [] } = useListUsers({ query: { queryKey: [...getListUsersQueryKey(), "callie", scopeKey], enabled: manage } });
  const [saved, setSaved] = useState<CalliePolicy | null>(null), [draft, setDraft] = useState<CallieSettings | null>(null), [preview, setPreview] = useState<CalliePolicyPreview | null>(null);
  const [approved, setApproved] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState(""), [expired, setExpired] = useState(false);
  const generation = useRef(0), mounted = useRef(true);
  const [saving, setSaving] = useState(false);
  function invalidate() { generation.current++; setPreview(null); setApproved(false); setExpired(false); }
  async function refresh() {
    invalidate(); const run = generation.current; setBusy(true); setError(""); setSaved(null); setDraft(null);
    try { const value = await callieRequest(calliePolicySchema, "/policy"); if (mounted.current && run === generation.current) { setSaved(value); setDraft(value.policy); } }
    catch (failure) { if (mounted.current && run === generation.current) setError(failure instanceof Error ? failure.message : "Standing policy could not be loaded."); }
    finally { if (mounted.current && run === generation.current) setBusy(false); }
  }
  useEffect(() => { mounted.current = true; void refresh(); return () => { mounted.current = false; generation.current++; }; }, [refreshToken]);
  useEffect(() => { if (!preview) return; const delay = Math.max(0, Date.parse(preview.expiresAt) - Date.now()); const timer = setTimeout(() => { setExpired(true); setApproved(false); }, delay); return () => clearTimeout(timer); }, [preview]);
  function change(patch: Partial<CallieSettings>) { if (saving) return; invalidate(); setDraft(value => value ? { ...value, ...patch } : value); setBusy(false); }
  async function prepare() {
    if (!saved || !draft || !manage || busy) return;
    invalidate(); const run = generation.current; setBusy(true); setError(""); setNotice("");
    try { const value = await callieRequest(policyPreviewFor(organizationId, actorId, saved.version, draft), "/policy/preview", { expectedVersion: saved.version, policy: draft }); if (mounted.current && generation.current === run) setPreview(value); }
    catch (failure) { if (mounted.current && run === generation.current) setError(failure instanceof Error ? failure.message : "Preview unavailable."); }
    finally { if (mounted.current && run === generation.current) setBusy(false); }
  }
  async function approve() {
    if (!preview || !approved || expired || busy || !manage || Date.parse(preview.expiresAt) <= Date.now()) return;
    const current = preview, run = ++generation.current; setBusy(true); setSaving(true); onSaving(true); setApproved(false); setPreview(null); setError("");
    try {
      const value = await callieRequest(calliePolicySchema.refine(saved => saved.version === current.expectedVersion + 1 && samePolicyFields(saved.snapshot, current.expectedSnapshot.policy) && samePolicyFields(saved.snapshot, saved.policy)), "/policy/approve", { expectedVersion: current.expectedVersion, expectedSnapshot: current.expectedSnapshot, previewHash: current.previewHash, confirmed: true });
      if (mounted.current && run === generation.current) { setSaved(value); setDraft(value.policy); setNotice(value.policy.enabled ? "Standing policy approved for new eligible calls only. Existing calls were not enrolled. Provider and company holds still apply." : "Standing recovery disabled. Existing call evidence and callback tasks are retained."); await onSaved(); }
    } catch (failure) { if (mounted.current && run === generation.current) { setSaved(null); setDraft(null); setError(`${failure instanceof Error ? failure.message : "Save not confirmed."} Refresh the saved policy before another action. No automatic retry was made.`); } }
    finally { if (mounted.current && run === generation.current) { setBusy(false); setSaving(false); onSaving(false); } }
  }
  const eligible = users.filter(user => user.isActive && user.operationallyEligible === true && canWrite(user.role));
  return <section className="min-w-0 space-y-3 rounded-lg border p-4" aria-label="CALLIE standing policy">
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-semibold">Automatic intake setup</h3><button className={button} disabled={busy} onClick={() => void refresh()}>Refresh standing policy</button></div>
    {error && <p role="alert" className="break-words text-sm text-destructive">{error}</p>}{notice && <p role="status" className="text-sm">{notice}</p>}
    {!saved && !error && <p>Loading standing policy…</p>}
    {saved && <><p className="font-medium">{!saved.policy.enabled ? "Standing recovery is off" : saved.readiness.ready ? "Approved for new eligible calls" : "Approved, but held"}</p>{!saved.readiness.ready && saved.policy.enabled && <p className="text-sm">{callieLabel(saved.readiness.reason ?? "sending_held")}</p>}
      <p className="text-sm text-muted-foreground">Normal staff ringing comes first. CALLIE can collect keypad choices after a missed call. It sends one fixed acknowledgment only after the caller texts the exact one-call code. No unsolicited text, general SMS consent, automatic appointment or emergency dispatch is implied.</p>
      {manage && draft && <details className="min-w-0 rounded border p-3"><summary className="cursor-pointer font-medium">Review standing owners, hours and exact messages</summary>
        <form className="mt-3 min-w-0 space-y-3" onSubmit={event => { event.preventDefault(); void prepare(); }}>
          <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={draft.enabled} onChange={event => change({ enabled: event.target.checked })} />Enable standing CALLIE intake for future eligible calls</label>
          <div className="grid min-w-0 gap-3 sm:grid-cols-2"><label className="min-w-0 text-sm">CALLIE time zone<input className={field} required value={draft.timezone} onChange={event => change({ timezone: event.target.value })} /></label><label className="min-w-0 text-sm">Office response deadline (minutes)<input className={field} type="number" min={5} max={1440} required value={draft.responseMinutes} onChange={event => change({ responseMinutes: Number(event.target.value) })} /></label>
            <label className="min-w-0 text-sm">CALLIE opens at<input className={field} type="time" required value={draft.opensAt} onChange={event => change({ opensAt: event.target.value })} /></label><label className="min-w-0 text-sm">CALLIE closes at<input className={field} type="time" required value={draft.closesAt} onChange={event => change({ closesAt: event.target.value })} /></label>
            {(["businessHoursOwnerId", "afterHoursOwnerId"] as const).map(name => <label className="min-w-0 text-sm" key={name}>{name === "businessHoursOwnerId" ? "CALLIE daytime owner" : "CALLIE after-hours owner"}<select className={field} value={draft[name] ?? ""} onChange={event => change({ [name]: event.target.value || null })}><option value="">Choose accepted staff</option>{eligible.map(user => <option key={user.id} value={user.id}>{[user.firstName, user.lastName].filter(Boolean).join(" ") || user.email}</option>)}</select></label>)}
          </div>
          <fieldset><legend className="text-sm">CALLIE business days</legend><div className="flex flex-wrap gap-3">{["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((name, index) => <label className="flex min-h-11 items-center gap-2 text-sm" key={name}><input type="checkbox" checked={draft.days.includes(index + 1)} onChange={event => change({ days: event.target.checked ? [...draft.days, index + 1].sort() : draft.days.filter(day => day !== index + 1) })} />{name}</label>)}</div></fieldset>
          <p className="text-xs text-muted-foreground">The after-hours owner receives accountable work; that does not authorize overnight customer texts. Policy changes invalidate older automatic authority. A new policy does not sweep old calls.</p>
          <button className={button} disabled={busy}>Prepare exact standing-policy review</button>
        </form>
      </details>}
    </>}
    {preview && <div className="min-w-0 space-y-3 rounded-lg border border-primary p-4" aria-label="Exact CALLIE policy review">
      <h4 className="font-semibold">Review these exact prompts and one acknowledgment</h4>
      <p className="text-sm">Mode: {preview.expectedSnapshot.policy.enabled ? "Standing intake enabled" : "Standing intake disabled"} · expires {new Date(preview.expiresAt).toLocaleString()}</p>
      {preview.expectedSnapshot.policy.binding && <p className="break-words text-sm">{preview.expectedSnapshot.policy.binding.businessName} · shop number {preview.expectedSnapshot.policy.binding.sender} · disclosure {preview.expectedSnapshot.policy.binding.disclosureVersion}</p>}
      <dl className="space-y-3 text-sm">{Object.entries(preview.expectedSnapshot.policy.prompts).map(([name, text]) => <div key={name}><dt className="font-medium capitalize">{name}</dt><dd className="whitespace-pre-wrap break-words">{text}</dd></div>)}<div><dt className="font-medium">One-call acknowledgment</dt><dd className="whitespace-pre-wrap break-words">{preview.expectedSnapshot.policy.acknowledgmentBody}</dd></div></dl>
      {expired && <p role="alert">This preview expired. Prepare a fresh review; nothing was approved.</p>}
      <label className="flex items-start gap-2 text-sm"><input type="checkbox" disabled={busy || expired} checked={approved} onChange={event => setApproved(event.target.checked)} />I approve this exact standing policy for future eligible calls, including the named owners and finite messages. It does not confirm appointments or grant general messaging permission.</label>
      <button className={button} disabled={busy || expired || !approved || !manage} onClick={() => void approve()}>Approve standing policy</button>
    </div>}
  </section>;
}
