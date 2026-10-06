import { useEffect, useRef, useState } from "react";
import type { CallieReceptionView } from "../../../api-server/src/services/callie-reception-contract";
import { callieButton as button, callieField as field, callieRequest, receptionViewFor } from "./callie-contract";
import CalliePolicyPanel from "./callie-policy-panel";
import CallieReceptionPanel from "./callie-reception-panel";

export default function CallieSetupPanel({ scopeKey, organizationId, actorId, manage, refreshToken }: { scopeKey: string; organizationId: string; actorId: string; manage: boolean; refreshToken: number }) {
  const [view, setView] = useState<CallieReceptionView | null>(null), [mode, setMode] = useState<"keypad" | "conversation" | null>(null);
  const [error, setError] = useState(""), [revision, setRevision] = useState(0), [saving, setSaving] = useState(false);
  const generation = useRef(0), mounted = useRef(true);
  useEffect(() => {
    mounted.current = true; const run = ++generation.current, abort = new AbortController(); setView(null); setMode(null); setError(""); setSaving(false);
    void callieRequest(receptionViewFor(organizationId), "/reception", undefined, abort.signal).then(value => {
      if (mounted.current && generation.current === run) { setView(value); setMode(value.currentMode); }
    }).catch(failure => { if (!abort.signal.aborted && mounted.current && generation.current === run) setError(failure instanceof Error ? failure.message : "Reception setup could not be loaded."); });
    return () => { mounted.current = false; generation.current++; abort.abort(); };
  }, [organizationId, refreshToken, revision]);
  async function keypadSaved() {
    const run = generation.current;
    try { const next = await callieRequest(receptionViewFor(organizationId), "/reception"); if (mounted.current && run === generation.current) setView(next); }
    catch { if (mounted.current && run === generation.current) { setView(null); setSaving(false); setError("The saved mode could not be rechecked. Refresh setup before another action; no retry was made."); } }
  }
  return <section className="min-w-0 space-y-3 rounded-lg border p-3" aria-label="CALLIE intake setup">
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-semibold">How CALLIE handles a missed call</h3><button className={button} disabled={saving} onClick={() => setRevision(value => value + 1)}>Refresh CALLIE setup</button></div>
    {error && <p role="alert" className="break-words text-sm text-destructive">{error}</p>}
    {!view && !error && <p>Checking saved CALLIE mode…</p>}
    {view && mode && <>
      <p className="text-sm">Saved mode: <strong>{view.currentMode === "conversation" ? "Conversational reception" : "Keypad intake"}</strong> · {view.currentEnabled ? "Enabled policy" : "Off"}. Only one saved mode handles new eligible calls.</p>
      <p className="text-xs text-muted-foreground">Code and configuration readiness are not proof of a working phone line. Company/provider holds and a real test of staff ringing, audio, voicemail and handoff must be checked before client activation.</p>
      {manage && <label className="block text-sm">Mode to review<select className={field} disabled={saving} value={mode} onChange={event => setMode(event.target.value as "keypad" | "conversation")}><option value="keypad">Keypad intake + caller-confirmed one-call text</option><option value="conversation">Conversational reception · voice only</option></select></label>}
      {mode !== view.currentMode && <p role="status" className="rounded border p-3 text-sm">Draft mode change only. The saved mode remains in effect until you review and approve the exact replacement policy. Previous previews have been discarded.</p>}
      {mode === "conversation" ? <CallieReceptionPanel key={`conversation:${revision}`} scopeKey={scopeKey} organizationId={organizationId} actorId={actorId} manage={manage} view={view} onSaved={setView} onSaving={setSaving} /> : <CalliePolicyPanel key={`keypad:${revision}`} scopeKey={scopeKey} organizationId={organizationId} actorId={actorId} manage={manage} refreshToken={refreshToken} onSaved={keypadSaved} onSaving={setSaving} />}
      <p className="text-xs text-muted-foreground">Existing calls, callback tasks and their original evidence stay in their original mode. Switching modes does not enroll historical calls or grant messaging consent.</p>
    </>}
  </section>;
}
