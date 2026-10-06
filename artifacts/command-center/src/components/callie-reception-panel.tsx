import { useEffect, useRef, useState } from "react";
import { getListUsersQueryKey, useListUsers } from "@workspace/api-client-react";
import { canWrite } from "@/lib/permissions";
import { callieReceptionBindingSettingsSchema, callieReceptionSettingsSchema, type CallieReceptionView, type CallieReceptionSettings, type CallieReceptionSnapshot, type callieReceptionPreviewSchema } from "../../../api-server/src/services/callie-reception-contract";
import type { z } from "zod/v4";
import { callieButton as button, callieField as field, callieLabel, callieRequest, receptionPreviewFor, receptionViewFor, samePolicyFields } from "./callie-contract";

type Binding = z.infer<typeof callieReceptionBindingSettingsSchema>;
type Preview = z.infer<typeof callieReceptionPreviewSchema>;
const emptyBinding: Binding = { enabled: false, agentId: "", agentVersionId: "", branchId: null, environment: "staging", credentialKey: "", configurationSha256: "" };
const bindingDraft = (view: CallieReceptionView): Binding => view.binding ? { enabled: view.binding.enabled, agentId: view.binding.agentId, agentVersionId: view.binding.agentVersionId, branchId: view.binding.branchId, environment: view.binding.environment, credentialKey: view.binding.credentialKey, configurationSha256: view.binding.configurationSha256 } : { ...emptyBinding };
const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function ExactConversationPolicy({ policy }: { policy: CallieReceptionSnapshot }) {
  return <div className="w-full min-w-0 max-w-full space-y-3 text-sm [overflow-wrap:anywhere]">
    <dl className="grid min-w-0 gap-3 sm:grid-cols-2 [&>div]:min-w-0">
      <div><dt className="font-medium">Reception policy</dt><dd>{policy.enabled ? "Enable for future eligible calls" : "Off"} · {policy.templateVersion} · {policy.toolVersion}</dd></div>
      <div><dt className="font-medium">Hours and time zone</dt><dd>{policy.days.map(day => days[day - 1]).join(", ")} · {policy.opensAt}–{policy.closesAt} · {policy.timezone}</dd></div>
      <div><dt className="font-medium">Exact accountable owner IDs</dt><dd className="break-all">Daytime: {policy.businessHoursOwnerId ?? "None"} · after hours: {policy.afterHoursOwnerId ?? "None"} · response due in {policy.responseMinutes} minutes</dd></div>
      <div><dt className="font-medium">Finite limits</dt><dd>{policy.maxConversationSeconds} seconds · {policy.maxToolCalls} tool calls · extracted content retained {policy.retentionDays} days</dd></div>
      <div><dt className="font-medium">Reviewed handoff numbers</dt><dd>Daytime: {policy.businessHoursTransferPhone ?? "No transfer"} · after hours: {policy.afterHoursTransferPhone ?? "No transfer"}</dd></div>
      <div><dt className="font-medium">Approved company facts</dt><dd className="whitespace-pre-wrap break-words">{policy.businessFacts || "None"}</dd></div>
      <div><dt className="font-medium">Exact caller disclosure</dt><dd className="whitespace-pre-wrap break-words">{policy.callerDisclosure || "None"}</dd></div>
    </dl>
    <details className="min-w-0 rounded border p-3"><summary className="cursor-pointer">Exact non-secret phone and agent identities</summary><pre className="mt-2 whitespace-pre-wrap break-all text-xs">{JSON.stringify({ phone: policy.voiceBinding, reception: policy.receptionBinding }, null, 2)}</pre></details>
    <div><h5 className="font-medium">Exact bounded reception instructions</h5><p className="whitespace-pre-wrap break-words">{policy.prompt}</p></div>
  </div>;
}

export default function CallieReceptionPanel({ scopeKey, organizationId, actorId, manage, view, onSaved, onSaving }: { scopeKey: string; organizationId: string; actorId: string; manage: boolean; view: CallieReceptionView; onSaved: (view: CallieReceptionView) => void; onSaving: (saving: boolean) => void }) {
  const { data: users = [], isError: staffError } = useListUsers({ query: { queryKey: [...getListUsersQueryKey(), "callie", scopeKey], enabled: manage } });
  const [draft, setDraft] = useState<CallieReceptionSettings>(view.policy), [binding, setBinding] = useState<Binding>(() => bindingDraft(view));
  const [preview, setPreview] = useState<Preview | null>(null), [approved, setApproved] = useState(false), [bindingApproved, setBindingApproved] = useState(false);
  const [busy, setBusy] = useState(false), [saving, setSaving] = useState(false), [held, setHeld] = useState(false), [expired, setExpired] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const generation = useRef(0), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++; }; }, []);
  useEffect(() => { if (!preview) return; const timer = setTimeout(() => { setExpired(true); setApproved(false); }, Math.max(0, Date.parse(preview.expiresAt) - Date.now())); return () => clearTimeout(timer); }, [preview]);
  function invalidate() { generation.current++; setPreview(null); setApproved(false); setExpired(false); setError(""); setNotice(""); setBusy(false); }
  function change(patch: Partial<CallieReceptionSettings>) { if (saving || held) return; invalidate(); setDraft(value => ({ ...value, ...patch })); }
  function changeBinding(patch: Partial<Binding>) { if (saving || held) return; invalidate(); setBindingApproved(false); setBinding(value => ({ ...value, ...patch })); }
  const eligible = staffError ? [] : users.filter(user => user.isActive && user.operationallyEligible === true && canWrite(user.role));
  const ownersCurrent = !staffError && [draft.businessHoursOwnerId, draft.afterHoursOwnerId].every(id => id && eligible.some(user => user.id === id));
  const bindingChanged = JSON.stringify(binding) !== JSON.stringify(bindingDraft(view));
  async function prepare() {
    if (!manage || busy || saving || held) return;
    if (draft.enabled && bindingChanged) { setError("Save the reviewed agent connection first, or refresh CALLIE setup to discard unsaved connection edits. They cannot be included in a policy approval yet."); return; }
    const parsed = callieReceptionSettingsSchema.safeParse(draft);
    if (!parsed.success || draft.enabled && !ownersCurrent) { setError("Review the required company facts, disclosure, accepted owners, hours and finite limits before preparing this policy."); return; }
    invalidate(); const run = generation.current; setBusy(true);
    try { const value = await callieRequest(receptionPreviewFor(organizationId, actorId, view.version, parsed.data), "/reception/policy/preview", { expectedVersion: view.version, policy: parsed.data }); if (mounted.current && run === generation.current) setPreview(value); }
    catch (failure) { if (mounted.current && run === generation.current) setError(failure instanceof Error ? failure.message : "Conversation preview could not be confirmed."); }
    finally { if (mounted.current && run === generation.current) setBusy(false); }
  }
  async function mutate(suffix: string, body: unknown, success: string, matchesSaved: (view: CallieReceptionView) => boolean) {
    if (!manage || saving || held) return;
    invalidate(); const run = generation.current; setSaving(true); onSaving(true); setBindingApproved(false);
    try {
      const value = await callieRequest(receptionViewFor(organizationId).refine(matchesSaved), suffix, body);
      if (mounted.current && run === generation.current) { onSaved(value); setDraft(value.policy); setBinding(bindingDraft(value)); setNotice(success); }
    } catch (failure) {
      if (mounted.current && run === generation.current) { setHeld(true); setError(`${failure instanceof Error ? failure.message : "Save not confirmed."} Refresh CALLIE setup before another action. No automatic retry was made.`); }
    } finally { if (mounted.current && run === generation.current) { setSaving(false); onSaving(false); } }
  }
  function saveBinding() {
    if (!bindingApproved || busy) return;
    const parsed = callieReceptionBindingSettingsSchema.safeParse(binding);
    if (!parsed.success) { setError("Enter the reviewed agent ID, version, environment, installed credential slot name and 64-character configuration fingerprint. Never enter a secret."); return; }
    const expectedVersion = view.binding?.version ?? 0;
    void mutate("/reception/binding", { requestId: crypto.randomUUID(), expectedVersion, binding: parsed.data, confirmed: true }, "Non-secret agent binding saved. This does not configure ElevenLabs or activate a phone line. Prepare a fresh exact policy review.", saved => !!saved.binding && saved.binding.version === expectedVersion + 1 && samePolicyFields(saved.binding, parsed.data));
  }
  function approve() {
    if (!preview || !approved || expired || busy || Date.parse(preview.expiresAt) <= Date.now()) return;
    const reviewed = preview;
    void mutate("/reception/policy/approve", { expectedVersion: reviewed.expectedVersion, expectedSnapshot: reviewed.expectedSnapshot, previewHash: reviewed.previewHash, confirmed: true }, reviewed.expectedSnapshot.policy.enabled ? "Conversation policy saved for future eligible calls only. Provider and company holds still apply; real phone acceptance is separate." : "Conversation policy saved off. Original calls, evidence and office tasks remain intact.", saved => saved.version === reviewed.expectedVersion + 1 && saved.currentMode === "conversation" && saved.currentEnabled === reviewed.expectedSnapshot.policy.enabled && !!saved.approvedSnapshot && samePolicyFields(saved.approvedSnapshot, reviewed.expectedSnapshot.policy) && samePolicyFields(saved.approvedSnapshot, saved.policy));
  }
  return <section className="min-w-0 space-y-3 rounded border p-3" aria-label="CALLIE conversational reception setup">
    <h4 className="font-semibold">Conversational reception · voice only</h4>
    <p className="font-medium">{callieLabel(view.readiness.state)}</p>
    {view.readiness.reason && <p className="text-sm">{callieLabel(view.readiness.reason)}</p>}
    <p className="text-sm text-muted-foreground">Staff ringing comes first. CALLIE can collect a missed caller's request and attempt one reviewed human handoff. The original callback task stays accountable. SMS readiness, confirmed appointments and completed office work are separate.</p>
    <dl className="grid gap-2 rounded border p-3 text-sm sm:grid-cols-2"><div><dt className="font-medium">Saved agent binding</dt><dd>{view.binding ? `${view.binding.environment} · ${view.binding.enabled ? "enabled" : "off"} · version ${view.binding.version}` : "Not configured"}</dd></div><div><dt className="font-medium">Installed provider prerequisites</dt><dd>{view.binding?.credentialsConfigured ? "Credential slot configured" : "Credential slot missing"} · {view.binding?.webhookConfigured ? "Webhook signing configured" : "Webhook signing missing"}. These are configuration checks, not a live call test.</dd></div></dl>
    {error && <p role="alert" className="break-words text-sm text-destructive">{error}</p>}{notice && <p role="status" className="break-words text-sm">{notice}</p>}
    {manage && <>
      <details className="min-w-0 rounded border p-3"><summary className="cursor-pointer font-medium">Review non-secret agent connection</summary>
        <form className="mt-3 min-w-0 space-y-3" onSubmit={event => { event.preventDefault(); saveBinding(); }}><fieldset disabled={saving || held} className="min-w-0 space-y-3">
          <p className="text-xs text-muted-foreground">Use a separately prepared, reviewed provider configuration. Saving here does not create an agent, buy minutes, configure routing or install credentials. Enter only the installed credential slot's name, never its value.</p>
          <p className="text-xs text-muted-foreground">The expected agent version and configuration fingerprint are checked against provider setup. They do not pin an immutable remote version or prove a live call works.</p>
          <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={binding.enabled} onChange={event => changeBinding({ enabled: event.target.checked })} />Allow this reviewed agent binding</label>
          <div className="grid min-w-0 gap-3 sm:grid-cols-2">
            <label className="min-w-0 text-sm">Reception agent ID<input className={field} required maxLength={128} autoComplete="off" value={binding.agentId} onChange={event => changeBinding({ agentId: event.target.value })} /></label>
            <label className="min-w-0 text-sm">Reception agent version ID<input className={field} required maxLength={128} autoComplete="off" value={binding.agentVersionId} onChange={event => changeBinding({ agentVersionId: event.target.value })} /></label>
            <label className="min-w-0 text-sm">Reception branch ID (optional)<input className={field} maxLength={128} autoComplete="off" value={binding.branchId ?? ""} onChange={event => changeBinding({ branchId: event.target.value || null })} /></label>
            <label className="min-w-0 text-sm">Provider environment<select className={field} value={binding.environment} onChange={event => changeBinding({ environment: event.target.value as Binding["environment"] })}><option value="staging">Staging</option><option value="production">Production</option></select></label>
            <label className="min-w-0 text-sm">Installed credential slot name (not a secret)<input className={field} required maxLength={60} autoComplete="off" spellCheck={false} value={binding.credentialKey} onChange={event => changeBinding({ credentialKey: event.target.value })} /></label>
          </div>
          <label className="block min-w-0 text-sm">Reviewed configuration SHA-256<input className={field} required minLength={64} maxLength={64} autoComplete="off" spellCheck={false} value={binding.configurationSha256} onChange={event => changeBinding({ configurationSha256: event.target.value })} /></label>
          <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={bindingApproved} onChange={event => setBindingApproved(event.target.checked)} />I reviewed this exact non-secret agent binding. Changes invalidate previous conversation-policy authority and require fresh review.</label>
          <button className={button} disabled={busy || !bindingApproved}>Save reviewed agent binding</button>
        </fieldset></form>
      </details>
      <details className="min-w-0 rounded border p-3"><summary className="cursor-pointer font-medium">Review conversation owners, facts and limits</summary>
        <form className="mt-3 min-w-0 space-y-3" onSubmit={event => { event.preventDefault(); void prepare(); }}><fieldset disabled={saving || held} className="min-w-0 space-y-3">
          <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={draft.enabled} onChange={event => change({ enabled: event.target.checked })} />Enable conversational reception for future eligible missed calls</label>
          {staffError && <p role="alert">Accepted staff could not be checked. Refresh setup before enabling reception.</p>}
          <div className="grid min-w-0 gap-3 sm:grid-cols-2">
            <label className="min-w-0 text-sm">Reception time zone<input className={field} required maxLength={80} value={draft.timezone} onChange={event => change({ timezone: event.target.value })} /></label>
            <label className="min-w-0 text-sm">Reception response deadline (minutes)<input className={field} type="number" required min={5} max={1440} value={draft.responseMinutes} onChange={event => change({ responseMinutes: Number(event.target.value) })} /></label>
            <label className="min-w-0 text-sm">Reception opens at<input className={field} type="time" required value={draft.opensAt} onChange={event => change({ opensAt: event.target.value })} /></label>
            <label className="min-w-0 text-sm">Reception closes at<input className={field} type="time" required value={draft.closesAt} onChange={event => change({ closesAt: event.target.value })} /></label>
            {(["businessHoursOwnerId", "afterHoursOwnerId"] as const).map(name => <label className="min-w-0 text-sm" key={name}>{name === "businessHoursOwnerId" ? "Reception daytime owner" : "Reception after-hours owner"}<select className={field} value={draft[name] ?? ""} onChange={event => change({ [name]: event.target.value || null })}><option value="">Choose accepted staff</option>{draft[name] && !eligible.some(user => user.id === draft[name]) && <option value={draft[name]!} disabled>Previously selected owner unavailable</option>}{eligible.map(user => <option key={user.id} value={user.id}>{[user.firstName, user.lastName].filter(Boolean).join(" ") || user.email}</option>)}</select></label>)}
          </div>
          <fieldset><legend className="text-sm">Reception business days</legend><div className="flex flex-wrap gap-3">{days.map((name, index) => <label className="flex min-h-11 items-center gap-2 text-sm" key={name}><input type="checkbox" checked={draft.days.includes(index + 1)} onChange={event => change({ days: event.target.checked ? [...draft.days, index + 1].sort() : draft.days.filter(day => day !== index + 1) })} />{name}</label>)}</div></fieldset>
          <label className="block text-sm">Reviewed company facts<textarea className={field} maxLength={1200} required={draft.enabled} value={draft.businessFacts} onChange={event => change({ businessFacts: event.target.value })} /></label>
          <label className="block text-sm">Reviewed caller disclosure<textarea className={field} maxLength={500} required={draft.enabled} value={draft.callerDisclosure} onChange={event => change({ callerDisclosure: event.target.value })} /></label>
          <p className="text-xs text-muted-foreground">Do not promise warranty coverage, emergency arrival or availability that the company has not approved. Requests are unverified. No raw transcript or audio playback is available in this desk.</p>
          <div className="grid min-w-0 gap-3 sm:grid-cols-2">
            <label className="min-w-0 text-sm">Maximum conversation seconds<input className={field} type="number" required min={60} max={600} value={draft.maxConversationSeconds} onChange={event => change({ maxConversationSeconds: Number(event.target.value) })} /></label>
            <label className="min-w-0 text-sm">Maximum call-scoped tool calls<input className={field} type="number" required min={3} max={12} value={draft.maxToolCalls} onChange={event => change({ maxToolCalls: Number(event.target.value) })} /></label>
            <label className="min-w-0 text-sm">Extracted content retention (days)<input className={field} type="number" required min={1} max={30} value={draft.retentionDays} onChange={event => change({ retentionDays: Number(event.target.value) })} /></label>
            {(["businessHoursTransferPhone", "afterHoursTransferPhone"] as const).map(name => <label className="min-w-0 text-sm" key={name}>{name === "businessHoursTransferPhone" ? "Reviewed daytime handoff number" : "Reviewed after-hours handoff number"}<input className={field} type="tel" maxLength={12} placeholder="Optional +1…" value={draft[name] ?? ""} onChange={event => change({ [name]: event.target.value || null })} /></label>)}
          </div>
          <p className="text-xs text-muted-foreground">Empty handoff numbers mean no transfer. Numbers must be explicitly reviewed; no owner number is inferred. A phone answer may be voicemail and does not complete the callback task.</p>
          <button className={button} disabled={busy}>Prepare exact conversation-policy review</button>
        </fieldset></form>
      </details>
    </>}
    {preview && <div className="min-w-0 space-y-3 rounded border border-primary p-3" aria-label="Exact conversation policy review">
      <h4 className="font-semibold">Review the complete replacement policy</h4><p className="text-sm">Expires {new Date(preview.expiresAt).toLocaleString()}. Approval replaces the saved mode for future eligible calls only.</p>
      <ExactConversationPolicy policy={preview.expectedSnapshot.policy} />
      {expired && <p role="alert">This conversation preview expired. Prepare a fresh review; nothing was approved.</p>}
      <label className="flex items-start gap-2 text-sm"><input type="checkbox" disabled={saving || held || expired} checked={approved} onChange={event => setApproved(event.target.checked)} />I approve this exact conversation policy, reviewed identities, owners, facts, disclosure, limits and optional handoff targets. It does not book appointments or grant messaging permission.</label>
      <button className={button} disabled={!manage || saving || held || expired || !approved} onClick={approve}>Approve conversation policy</button>
    </div>}
  </section>;
}
