import { useEffect, useState } from 'react';
import { getListUsersQueryKey, useListUsers } from '@workspace/api-client-react';
import type { z } from 'zod/v4';
import { Link } from 'wouter';
import { canAssignWork, localDateTime, scheduleTimezone } from '@/lib/contractor-schedule';
import { previewWorkdayCompletionSchema, workdayCompletionPreviewSchema, type AppointmentWork } from './workday-contract';
import { workdayButton as button, workdayField as field, workdayCard as card, workdayLabel, WorkdayNotice, useWorkdayOperation, workdayRequest } from './workday-ui';
import type { WorkAction } from './visit-work-entry';

type Props = { work: AppointmentWork; scopeKey: string; organizationId: string; busy: boolean; held: boolean; dirty: boolean; actingReady: boolean; acting: Record<string, string>; onAction: WorkAction };
type Preview = z.infer<typeof workdayCompletionPreviewSchema>;

export default function VisitWorkCompletion(props: Props) {
  return props.work.completion ? <CompletedWork {...props} /> : <CompleteWork {...props} />;
}

function CompletedWork({ work, organizationId, busy, held, actingReady, acting, onAction }: Props) {
  const completion = work.completion!, [note, setNote] = useState('');
  useEffect(() => { setNote(''); }, [work.corrections.length, work.corrections[0]?.id]);
  return <section className={card} aria-label="Recorded work completion"><h4 className="text-lg font-semibold">Recorded work completion</h4>
    <p className="text-sm">Immutable staff-recorded evidence — not warranty coverage, customer acceptance, invoice delivery or payment.</p>
    <p className="whitespace-pre-wrap">{completion.summary}</p>
    <dl className="space-y-1 text-sm"><div><dt className="inline font-medium">Outcome: </dt><dd className="inline">{workdayLabel(completion.outcome)}</dd></div><div><dt className="inline font-medium">Work performed: </dt><dd className="inline">{new Date(completion.performedAt).toLocaleString()}</dd></div><div><dt className="inline font-medium">Recorded: </dt><dd className="inline">{new Date(completion.recordedAt).toLocaleString()}</dd></div><div><dt className="inline font-medium">Performer: </dt><dd className="inline break-all">{completion.performerUserId}</dd></div><div><dt className="inline font-medium">Recorded by: </dt><dd className="inline break-all">{completion.recordedByUserId}</dd></div></dl>
    {completion.actingNote && <p className="whitespace-pre-wrap text-sm">Office acting-on-behalf note: {completion.actingNote}</p>}
    <p className="text-sm">{completion.entries.length} saved work {completion.entries.length === 1 ? 'entry' : 'entries'} · native visit marked completed.</p>
    {completion.followupTaskId && <p className="text-sm">Office follow-up task recorded. <Link className="inline-flex min-h-11 items-center underline" href={`/tasks?taskId=${completion.followupTaskId}`}>Open office follow-up</Link></p>}
    {completion.services.length ? <ul className="space-y-2 text-sm">{completion.services.map(service => <li key={service.id}>Service occurrence completed: {work.linkedServices.find(row => row.id === service.id)?.equipmentLabel || 'Recorded occurrence'} <Link className="inline-flex min-h-11 items-center underline" href={`/service?serviceObligationId=${service.id}&organizationId=${organizationId}`}>Open completed occurrence</Link>{service.nextObligationId ? <> · Next occurrence recorded. <Link className="inline-flex min-h-11 items-center underline" href={`/service?serviceObligationId=${service.nextObligationId}&organizationId=${organizationId}`}>Open next service occurrence</Link></> : ' · no next occurrence recorded'}</li>)}</ul> : <p className="text-sm">No service occurrence was completed by this record.</p>}
    <section className="space-y-2"><h5 className="font-medium">Append-only corrections</h5>{work.corrections.map(correction => <article key={correction.id} className="rounded border p-3 text-sm"><p className="whitespace-pre-wrap">{correction.note}</p><p className="break-all text-muted-foreground">{correction.recordedByUserId} · {new Date(correction.recordedAt).toLocaleString()}</p></article>)}{!work.corrections.length && <p className="text-sm">No correction recorded.</p>}{work.correctionsHasMore && <p className="text-sm">Only the latest 25 corrections are shown; earlier evidence is retained.</p>}</section>
    {work.capabilities.canCorrect && <form onSubmit={event => { event.preventDefault(); if (note.trim() && actingReady && !busy && !held) void onAction(`/completions/${completion.id}/corrections`, { note: note.trim(), ...acting }, 'Correction appended. The original completion was not changed.'); }}><fieldset className="space-y-2" disabled={busy || held || !actingReady}><label className="block text-sm">Correction note<textarea required maxLength={2000} className={field} value={note} onChange={event => setNote(event.target.value)} /></label><p className="text-xs">A correction adds an attributed note. It cannot change original observations, service dates or the performer.</p><button className={button} disabled={!note.trim()}>Append correction note</button></fieldset></form>}
  </section>;
}

function CompleteWork({ work, scopeKey, organizationId, busy, held, dirty, actingReady, acting, onAction }: Props) {
  const [performedAt, setPerformedAt] = useState(() => localDateTime(new Date().toISOString())), [summary, setSummary] = useState(''), [outcome, setOutcome] = useState<'completed' | 'needs_followup'>('completed');
  const [serviceIds, setServiceIds] = useState<string[]>([]), [assignedUserId, setAssignedUserId] = useState(''), [dueAt, setDueAt] = useState(''), [followupNote, setFollowupNote] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null), [confirmed, setConfirmed] = useState(false), [expired, setExpired] = useState(false);
  const entries = work.entries.filter(entry => entry.state === 'draft');
  const services = work.linkedServices.filter(service => service.status === 'active' && entries.some(entry => entry.serviceObligationId === service.id));
  const attention = entries.some(entry => entry.answers.some(answer => answer.result === 'needs_attention'));
  const context = JSON.stringify({ organizationId, scopeKey, appointment: work.appointment, entries: work.entries, services: work.linkedServices, capabilities: work.capabilities, acting, dirty, performedAt, summary, outcome, serviceIds, assignedUserId, dueAt, followupNote });
  const op = useWorkdayOperation(context);
  const usersQuery = useListUsers({ query: { queryKey: [...getListUsersQueryKey(), scopeKey, 'work-followup'], enabled: work.capabilities.canComplete && outcome === 'needs_followup' } });
  const users = !usersQuery.isError ? usersQuery.data?.filter(canAssignWork) ?? [] : [];
  useEffect(() => { setPreview(null); setConfirmed(false); setExpired(false); }, [context]);
  useEffect(() => { if (!preview) return; const remaining = Date.parse(preview.expiresAt) - Date.now(); if (remaining <= 0) { setExpired(true); return; } const timer = setTimeout(() => setExpired(true), remaining); return () => clearTimeout(timer); }, [preview]);
  const enabled = work.capabilities.canComplete && actingReady && entries.length > 0 && !dirty && !busy && !held;
  async function review() {
    if (!enabled || op.busy) return;
    setPreview(null); setConfirmed(false);
    let intent: z.infer<typeof previewWorkdayCompletionSchema>;
    try {
      if (attention && outcome !== 'needs_followup') throw new Error('Needs-attention observations require an explicit office follow-up.');
      if (serviceIds.some(id => !services.some(service => service.id === id))) throw new Error('A selected service is no longer linked to this saved work.');
      if (outcome === 'needs_followup' && !users.some(user => user.id === assignedUserId)) throw new Error('Choose an active, accepted office follow-up owner.');
      intent = previewWorkdayCompletionSchema.parse({ expectedAppointmentUpdatedAt: work.appointment.updatedAt, entries: entries.map(entry => ({ id: entry.id, version: entry.version })), serviceObligationIds: serviceIds, performedAt: new Date(performedAt).toISOString(), summary: summary.trim(), outcome, followup: outcome === 'needs_followup' ? { assignedUserId, dueAt: new Date(dueAt).toISOString(), note: followupNote.trim() } : null, ...acting });
    } catch (failure) { op.setError(failure instanceof Error ? failure.message : 'Check the completion fields.'); return; }
    await op.run(() => workdayRequest(workdayCompletionPreviewSchema.refine(result => result.organizationId === organizationId && result.appointmentId === work.appointment.id && JSON.stringify(result.intent) === JSON.stringify(intent) && Date.parse(result.expiresAt) > Date.now() && result.entries.length === entries.length && new Set(result.entries.map(entry => entry.id)).size === entries.length && result.entries.every(row => { const source = entries.find(entry => entry.id === row.id); return !!source && JSON.stringify(source) === JSON.stringify(row); }) && result.serviceVersions.length === work.linkedServices.length && new Set(result.serviceVersions.map(service => service.id)).size === result.serviceVersions.length && serviceIds.every(id => result.serviceVersions.some(service => service.id === id)) && result.serviceVersions.every(service => work.linkedServices.some(source => source.id === service.id && source.updatedAt === service.updatedAt))), `/appointments/${work.appointment.id}/work/completion-preview`, { method: 'POST', body: intent }), setPreview);
  }
  if (!work.capabilities.canComplete) return <p className="text-sm">Completion is not currently available for this actor and exact visit. Saved work remains visible.</p>;
  return <section className={card} aria-label="Complete saved visit work"><h4 className="text-lg font-semibold">Complete saved visit work</h4><p className="text-sm">Review the saved entries and choose which actual service occurrences, if any, to finish. This does not send a customer message, create an invoice or claim warranty coverage.</p><WorkdayNotice {...op} />
    {dirty && <p role="status">Save or discard each unsaved work-entry draft before completion.</p>}{attention && <p className="text-sm">A saved observation needs attention. Choose Needs office follow-up and name the person responsible.</p>}
    <form onSubmit={event => { event.preventDefault(); void review(); }}><fieldset disabled={!enabled || op.busy} className="min-w-0 space-y-3">
      <label className="block text-sm">Work performed at ({scheduleTimezone})<input type="datetime-local" className={field} required value={performedAt} onChange={event => setPerformedAt(event.target.value)} /></label>
      <label className="block text-sm">Completion summary<textarea className={field} required maxLength={2000} value={summary} onChange={event => setSummary(event.target.value)} /></label>
      <label className="block text-sm">Work outcome<select className={field} value={outcome} onChange={event => setOutcome(event.target.value as typeof outcome)}><option value="completed">Completed — no follow-up recorded</option><option value="needs_followup">Needs office follow-up</option></select></label>
      {outcome === 'needs_followup' && <div className="space-y-3 rounded border p-3"><label className="block text-sm">Office follow-up owner<select className={field} required disabled={usersQuery.isPending || usersQuery.isError} value={assignedUserId} onChange={event => setAssignedUserId(event.target.value)}><option value="">Choose an accepted team member</option>{users.map(user => <option key={user.id} value={user.id}>{`${user.firstName ?? ''} ${user.lastName ?? ''}`.trim() || user.email}</option>)}</select></label>{usersQuery.isError && <p role="alert">Team membership could not be checked. Refresh before assigning follow-up.</p>}<label className="block text-sm">Office follow-up due ({scheduleTimezone})<input className={field} type="datetime-local" required value={dueAt} onChange={event => setDueAt(event.target.value)} /></label><label className="block text-sm">Office follow-up action<textarea className={field} required maxLength={2000} value={followupNote} onChange={event => setFollowupNote(event.target.value)} /></label></div>}
      <fieldset className="space-y-2 rounded border p-3"><legend className="px-1 text-sm font-medium">Service occurrences to complete (explicit and optional)</legend>{services.length ? services.map(service => <label key={service.id} className="flex min-h-11 items-center gap-3 text-sm"><input type="checkbox" checked={serviceIds.includes(service.id)} onChange={event => setServiceIds(ids => event.target.checked ? [...ids, service.id] : ids.filter(id => id !== service.id))} /><span>{service.equipmentLabel}</span></label>) : <p className="text-sm">No active service occurrence is attached to these work entries.</p>}<p className="text-xs">Unchecked occurrences remain unchanged. Any next occurrence must come from its already-recorded service recurrence.</p></fieldset>
      <button className={button} disabled={!summary.trim() || !performedAt || !entries.length}>Review exact completion</button>
    </fieldset></form>
    {preview && <section className="space-y-3 rounded border border-primary/40 p-3" aria-label="Exact completion review">
      <h5 className="font-semibold">Review before completing</h5><p className="whitespace-pre-wrap">{preview.intent.summary}</p>
      <p className="text-sm">{preview.entries.length} saved entries · {workdayLabel(preview.intent.outcome)} · {preview.intent.serviceObligationIds.length} service occurrences explicitly selected</p>
      <p className="text-xs">Native task reconciliation is checked for {preview.serviceVersions.length} linked service records. Only the explicitly selected occurrences above are marked performed; the other service statuses are not completed by this action.</p>
      <ul className="space-y-1 text-sm">{preview.entries.map(entry => <li key={entry.id}>{entry.checklist.definition.name} · revision {entry.checklist.version} · {entry.assetSnapshot?.label || 'Explicit non-equipment work'}</li>)}</ul>
      {preview.intent.followup && <p className="whitespace-pre-wrap break-words text-sm">Office follow-up: {preview.intent.followup.note} · owner {preview.intent.followup.assignedUserId} · due {new Date(preview.intent.followup.dueAt).toLocaleString()}</p>}
      <p className="text-xs">{preview.warning}</p><p className="text-xs">Review expires {new Date(preview.expiresAt).toLocaleTimeString()}. Changing this draft or saved work requires another review.</p>
      {expired && <p role="status">This review expired. Request a fresh review; no completion was retried.</p>}
      <label className="flex min-h-11 items-center gap-3 text-sm"><input type="checkbox" disabled={!enabled || expired || op.busy} checked={confirmed} onChange={event => setConfirmed(event.target.checked)} /><span>I checked the saved work and selected service outcomes.</span></label>
      <button type="button" className={button} disabled={!enabled || op.busy || expired || !confirmed} onClick={() => { if (Date.parse(preview.expiresAt) <= Date.now()) { setExpired(true); return; } if (confirmed && enabled) void onAction('/complete', { previewToken: preview.previewToken, confirmed: true }, 'Work completion recorded against this exact visit.'); }}>Record reviewed completion</button>
    </section>}
  </section>;
}
