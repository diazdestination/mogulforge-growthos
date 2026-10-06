import { useEffect, useState } from "react";
import type { CallieReceptionEvidence } from "../../../api-server/src/services/callie-reception-contract";
import { callieLabel } from "./callie-contract";

const transferLabels: Record<CallieReceptionEvidence["transfer"]["state"], string> = {
  not_requested: "No human handoff requested", claiming: "Handoff claim saved — provider outcome pending",
  redirect_accepted: "Redirect accepted by provider — connection not confirmed", ringing: "Handoff phone ringing — no answer confirmed",
  phone_answered: "Handoff phone answered — may be voicemail; human acceptance unverified",
  not_answered: "Handoff phone was not answered", failed: "Handoff failed — office follow-up still needed",
  indeterminate: "Handoff outcome unknown — do not retry", blocked: "Handoff held — office follow-up still needed",
};
const outcomeLabels: Record<CallieReceptionEvidence["conversation"]["outcome"], string> = {
  pending: "No final conversation outcome recorded", completed: "Conversation ended — office work is not marked complete",
  interrupted: "Conversation interrupted — review incomplete requests", empty: "No usable caller intake — office follow-up still needed", unknown: "Conversation outcome unknown — review original evidence",
};

export default function CallieConversationEvidence({ evidence }: { evidence: CallieReceptionEvidence | null }) {
  const [clockExpired, setClockExpired] = useState(false);
  const expiresAt = evidence?.conversation.contentExpiresAt;
  useEffect(() => {
    setClockExpired(false); if (!expiresAt) return;
    let timer: ReturnType<typeof setTimeout>;
    function check() { const remaining = Date.parse(expiresAt!) - Date.now(); if (remaining <= 0) setClockExpired(true); else timer = setTimeout(check, Math.min(remaining, 2_147_000_000)); }
    check(); return () => clearTimeout(timer);
  }, [expiresAt]);
  if (!evidence) return <section className="rounded border p-3 text-sm" aria-label="Conversation evidence"><h4 className="font-semibold">Conversation evidence</h4><p>No conversation evidence is available. The original callback task and office ownership still apply; this is not proof of a completed call.</p></section>;
  const expired = evidence.conversation.contentExpired || clockExpired || Date.parse(evidence.conversation.contentExpiresAt) <= Date.now();
  const facts = !expired ? evidence.conversation.facts : null;
  return <section className="min-w-0 space-y-3 rounded border p-3" aria-label="Conversation evidence">
    <h4 className="font-semibold">Conversation and human-handoff evidence</h4>
    <p className="text-sm">{evidence.boundary}</p>
    <dl className="grid min-w-0 gap-3 text-sm sm:grid-cols-2">
      <div><dt className="font-medium">Conversation registration</dt><dd>{evidence.registration.acceptedAt ? "Provider accepted registration — not proof of connected audio" : `Registration not confirmed${evidence.registration.state ? ` · ${callieLabel(evidence.registration.state)}` : ""}`}</dd></div>
      <div><dt className="font-medium">Conversation evidence</dt><dd>{evidence.conversation.boundAt ? "Authenticated conversation identity recorded" : "No authenticated conversation identity recorded"}. {outcomeLabels[evidence.conversation.outcome]}</dd></div>
      <div><dt className="font-medium">Human-handoff phone</dt><dd>{transferLabels[evidence.transfer.state]}</dd></div>
      <div><dt className="font-medium">Saved reception state</dt><dd>{evidence.state === "indeterminate" ? "Conversation effect unknown — do not restart" : callieLabel(evidence.state)} · {callieLabel(evidence.reason)} · {evidence.toolsUsed}/{evidence.maxToolCalls} bounded tools used</dd></div>
    </dl>
    <p className="text-xs text-muted-foreground">Registration, connected conversation, phone answer, SMS and a native appointment are different outcomes. Nothing here marks the original callback task handled. An unknown original effect must not be retried.</p>
    <div className="min-w-0 space-y-2 border-t pt-3" aria-label="Unverified caller statements"><h5 className="font-semibold">Caller statements · unverified</h5>
      {expired ? <p className="text-sm">Extracted caller content expired and is no longer displayed. Original ownership, office work and effect evidence remain.</p> : <>
        {facts ? <dl className="grid min-w-0 gap-3 text-sm sm:grid-cols-2">{([
          ["Name given", facts.callerName], ["Location described", facts.describedLocation], ["Problem described", facts.problem],
          ["Service requested", facts.serviceIntent && callieLabel(facts.serviceIntent)], ["Requested next step", facts.requestIntent === "visit" ? "Visit requested — not booked" : facts.requestIntent === "callback" ? "Callback requested" : null],
          ["Caller-described urgency", callieLabel(facts.urgency)], ["Callback preference", facts.callbackPreference],
        ] as const).map(([label, value]) => <div className="min-w-0" key={label}><dt className="font-medium">{label}</dt><dd className="whitespace-pre-wrap break-words">{value || "Not provided"}</dd></div>)}</dl> : <p className="text-sm">No structured caller statements recorded.</p>}
        {evidence.conversation.summary && <div><h5 className="text-sm font-medium">Extracted summary · unverified</h5><p className="whitespace-pre-wrap break-words text-sm">{evidence.conversation.summary}</p></div>}
        <p className="text-xs text-muted-foreground">Extracted content expires {new Date(evidence.conversation.contentExpiresAt).toLocaleString()}. There is no raw transcript or audio playback. These statements do not fill or approve the staff review below.</p>
      </>}
    </div>
  </section>;
}
