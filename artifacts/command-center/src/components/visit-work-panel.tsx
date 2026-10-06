import { useEffect, useState } from 'react';
import { Link } from 'wouter';
import type { z } from 'zod/v4';
import { assetPageFor, catalogFor, workFor, workContextMatches, workdayMutationSchema, workdayPhotoReservationSchema, type AppointmentWork, type WorkdayAsset, type WorkdayEntry } from './workday-contract';
import { workdayButton as button, workdayField as field, workdayCard as card, workdayLabel, WorkdayNotice, useWorkdayOperation, workdayRequest } from './workday-ui';
import VisitWorkEntry, { type WorkAction } from './visit-work-entry';
import VisitWorkCompletion from './visit-work-completion';

type Catalog = z.infer<ReturnType<typeof catalogFor>>;
type VisitWorkProps = { organizationId: string; appointmentId: string; scopeKey: string; onCompleted?: (work: AppointmentWork) => void };
export default function VisitWorkPanel(props: VisitWorkProps) {
  return <VisitWork key={`${props.scopeKey}:${props.organizationId}:${props.appointmentId}`} {...props} />;
}
function VisitWork({ organizationId, appointmentId, scopeKey, onCompleted }: VisitWorkProps) {
  const op = useWorkdayOperation(`${scopeKey}:${appointmentId}`), [work, setWork] = useState<AppointmentWork | null>(null), [actingNote, setActingNote] = useState(''), [dirty, setDirty] = useState<string[]>([]), [epoch, setEpoch] = useState(0);
  const path = `/appointments/${appointmentId}/work`;
  function refresh() { if (op.busy) return; setWork(null); setDirty([]); setEpoch(value => value + 1); void op.run(() => workdayRequest(workFor(organizationId, appointmentId), path), setWork, { refresh: true }); }
  useEffect(() => { refresh(); }, []);
  const actingReady = !!work && (!work.capabilities.requiresActingNote || !!actingNote.trim());
  const acting: Record<string, string> = work?.capabilities.requiresActingNote ? { actingNote: actingNote.trim() } : {};
  const mutationFor = (requestId: string) => workdayMutationSchema.refine(result => result.organizationId === organizationId && result.receipt.requestId === requestId && workContextMatches(result.work, organizationId, appointmentId));
  const perform: WorkAction = async (suffix, body, message, method = 'POST') => {
    if (op.busy || op.held || !actingReady) return;
    const requestId = crypto.randomUUID();
    const resultSchema = mutationFor(requestId).refine(result => suffix === '/complete'
      ? result.work.completion?.requestId === requestId && result.work.appointment.status === 'completed'
      : suffix.endsWith('/corrections') ? result.work.corrections.some(note => suffix === `/completions/${note.originalCompletionId}/corrections` && note.note === String(body.note).trim())
      : suffix.endsWith('/cancel') ? result.work.entries.some(entry => suffix === `/entries/${entry.id}/cancel` && entry.state === 'cancelled') : true);
    await op.run(() => workdayRequest(resultSchema, `${path}${suffix}`, { method, body: { ...body, requestId } }), result => { setWork(result.work); if (suffix === '/complete') onCompleted?.(result.work); }, { mutation: true, success: message });
  };
  async function upload(entry: WorkdayEntry, file: File, itemKey: string | null, caption: string) {
    if (op.busy || op.held || !actingReady || dirty.length) return;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size < 1 || file.size > 10 * 1024 * 1024) { op.setError('Choose a JPEG, PNG or WebP image between 1 byte and 10 MiB.'); return; }
    const requestId = crypto.randomUUID(), attachId = crypto.randomUUID();
    await op.run(async stillCurrent => {
      const reserved = await workdayRequest(workdayPhotoReservationSchema.refine(result => result.organizationId === organizationId && result.receipt.requestId === requestId && workContextMatches(result.work, organizationId, appointmentId)), `${path}/entries/${entry.id}/photos/request-url`, { method: 'POST', body: { requestId, expectedVersion: entry.version, contentType: file.type, sizeBytes: file.size, itemKey, caption, ...acting } });
      if (!stillCurrent()) throw new Error('Work authority changed');
      if (!reserved.uploadUrl || Date.parse(reserved.uploadExpiresAt) <= Date.now()) throw new Error('Original upload unavailable or expired; refresh and review the reservation');
      const target = new URL(reserved.uploadUrl, window.location.origin);
      if (target.origin !== window.location.origin || !/^\/api\/v1\/public\/uploads\/local\/[0-9a-f-]{36}$/i.test(target.pathname) || target.hash || [...target.searchParams.keys()].length !== 1 || !target.searchParams.get('token')) throw new Error('Upload destination could not be verified');
      const savedEntry = reserved.work.entries.find(row => row.id === entry.id), photo = savedEntry?.photos.find(row => row.id === reserved.photoId);
      if (!savedEntry || !photo || photo.state !== 'reserved' || photo.entryId !== entry.id || photo.contentType !== file.type || photo.sizeBytes !== file.size || photo.itemKey !== itemKey) throw new Error('Upload reservation context changed');
      const uploaded = await fetch(target.href, { method: 'PUT', credentials: 'include', headers: { 'Content-Type': file.type }, body: file, redirect: 'error', signal: AbortSignal.timeout(30_000) });
      if (!stillCurrent()) throw new Error('Work authority changed');
      if (!uploaded.ok) throw new Error('Photo bytes were not confirmed; refresh original reservation before another action');
      return workdayRequest(mutationFor(attachId).refine(result => result.work.entries.some(row => row.id === entry.id && row.photos.some(photo => photo.id === reserved.photoId && photo.state === 'attached'))), `${path}/entries/${entry.id}/photos`, { method: 'POST', body: { requestId: attachId, expectedVersion: savedEntry.version, photoId: reserved.photoId, ...acting } });
    }, result => setWork(result.work), { mutation: true, success: 'Private photo attached to this exact visit entry. It was not published or analyzed.' });
  }
  return <section className={card} aria-label="Visit work"><h3 className="text-xl font-semibold">Visit work</h3><p className="text-sm text-muted-foreground">Save observations and private evidence against this exact native appointment. No new lead, booking, message or invoice is created here.</p><WorkdayNotice {...op} /><button type="button" className={button} disabled={op.busy} onClick={refresh}>Refresh visit work and discard unsaved drafts</button>
    {!work ? <p role="status">{op.error ? 'Visit work unavailable. The schedule is not a replacement for this exact record.' : 'Loading exact visit work…'}</p> : <>
      <dl className="grid min-w-0 gap-2 rounded border p-3 text-sm sm:grid-cols-2"><div><dt className="font-medium">Customer</dt><dd>{work.appointment.customerLabel || 'No customer linked'}</dd></div><div><dt className="font-medium">Property</dt><dd>{work.appointment.propertyLabel || 'No property linked'}</dd></div><div><dt className="font-medium">Native visit status</dt><dd>{workdayLabel(work.appointment.status)}</dd></div><div><dt className="font-medium">Assigned performer</dt><dd className="break-all">{work.appointment.assignedUserId || 'Unassigned — office must assign an accepted performer'}</dd></div></dl>
      {work.appointment.notes && <details className="min-w-0"><summary className="min-h-11 cursor-pointer">Original appointment notes (read-only here)</summary><p className="whitespace-pre-wrap break-words text-sm">{work.appointment.notes}</p></details>}
      {work.capabilities.reasons.length > 0 && <p className="text-sm">Current work permissions: {work.capabilities.reasons.map(workdayLabel).join('; ')}.</p>}
      {work.capabilities.requiresActingNote && <div><label className="block text-sm">Office acting-on-behalf note<textarea className={field} aria-describedby={`work-acting-help-${appointmentId}`} maxLength={500} disabled={op.busy || op.held} value={actingNote} onChange={event => setActingNote(event.target.value)} /></label><p id={`work-acting-help-${appointmentId}`} className="text-xs">You are recording for the current assigned performer, not changing their identity. This note is required for every work action.</p></div>}
      {!work.entries.length && <p className="text-sm">No structured work record was recorded. Old visits and equipment labels have not been adopted into a checklist.</p>}
      {work.capabilities.canPrepare && <PrepareEntry key={`${scopeKey}:${work.appointment.contactId}:${work.appointment.propertyId}:${work.entries.map(entry => `${entry.id}:${entry.state}`).join('|')}:${epoch}`} scopeKey={scopeKey} organizationId={organizationId} work={work} busy={op.busy} disabled={op.held || !actingReady || dirty.length > 0} acting={acting} onAction={perform} />}
      <div className="space-y-4">{work.entries.map(entry => <VisitWorkEntry key={`${entry.id}:${entry.version}:${epoch}`} entry={entry} editable={work.capabilities.canEdit && actingReady && !work.completion} cancellable={work.capabilities.canCancel && !work.completion} actingReady={actingReady} busy={op.busy} held={op.held} acting={acting} onAction={perform} onUpload={upload} onDirty={(id, value) => setDirty(current => value ? current.includes(id) ? current : [...current, id] : current.includes(id) ? current.filter(item => item !== id) : current)} />)}</div>
      <VisitWorkCompletion key={`${scopeKey}:${appointmentId}:${epoch}`} work={work} scopeKey={scopeKey} organizationId={organizationId} busy={op.busy} held={op.held} dirty={dirty.length > 0} actingReady={actingReady} acting={acting} onAction={perform} />
      <section className="space-y-2 border-t pt-3"><h4 className="font-medium">Native service outcomes</h4>{work.linkedServices.length ? work.linkedServices.map(service => <p key={service.id} className="text-sm">{service.equipmentLabel} · {service.status} <Link className="inline-flex min-h-11 items-center underline" href={`/service?serviceObligationId=${service.id}&organizationId=${organizationId}`}>Open this service</Link></p>) : <p className="text-sm">No service occurrence is linked. Work completion does not invent one.</p>}</section>
    </>}
  </section>;
}

function PrepareEntry({ scopeKey, organizationId, work, busy, disabled, acting, onAction }: { scopeKey: string; organizationId: string; work: AppointmentWork; busy: boolean; disabled: boolean; acting: Record<string, string>; onAction: WorkAction }) {
  const op = useWorkdayOperation(`${scopeKey}:prepare:${work.appointment.id}`), [catalog, setCatalog] = useState<Catalog | null>(null), [assets, setAssets] = useState<WorkdayAsset[]>([]), [cursor, setCursor] = useState<string | null>(null), [seen, setSeen] = useState<string[]>([]), [ready, setReady] = useState(false);
  const [revisionId, setRevisionId] = useState(''), [assetChoice, setAssetChoice] = useState(''), [serviceId, setServiceId] = useState('');
  const contact = work.appointment.contactId, property = work.appointment.propertyId;
  function load(next: string | null = null) {
    if (busy || op.busy) return; setReady(false); if (!next) { setRevisionId(''); setAssetChoice(''); setServiceId(''); setAssets([]); setCatalog(null); }
    void op.run(async () => { const templates = await workdayRequest(catalogFor(organizationId), '/work-checklists'); const page = contact && property ? await workdayRequest(assetPageFor(organizationId, contact, property), `/contacts/${contact}/assets?propertyId=${property}${next ? `&cursor=${encodeURIComponent(next)}` : ''}`) : null; const combined = next ? [...assets, ...(page?.items ?? [])] : page?.items ?? []; if (new Set(combined.map(item => item.id)).size !== combined.length || page?.nextCursor && (page.nextCursor === next || seen.includes(page.nextCursor))) throw new Error('Equipment page context changed'); return { templates, page, combined }; }, ({ templates, page, combined }) => { setCatalog(templates); setAssets(combined); setCursor(page?.nextCursor ?? null); setSeen(next ? [...seen, next] : []); setReady(true); }, { refresh: true });
  }
  useEffect(() => { load(); }, [contact, property]);
  const revisions = catalog?.templates.filter(template => template.status === 'reviewed' && template.approvedRevision?.id === template.latestRevision.id && template.approvedRevision.reviewedAt).map(template => template.approvedRevision!) ?? [];
  const validAsset = assetChoice === 'none' || assets.some(asset => asset.id === assetChoice && asset.status === 'active' && asset.currentParentCoherent && asset.propertyId === property);
  const validService = !serviceId || work.linkedServices.some(service => service.id === serviceId && service.status === 'active');
  return <details className="min-w-0 rounded border p-3"><summary className="min-h-11 cursor-pointer font-medium">Prepare another explicit work entry</summary><WorkdayNotice {...op} /><p className="text-sm">Choose the reviewed checklist and equipment explicitly. Multiple units use separate entries. Nothing is selected just because only one option exists.</p>
    <form onSubmit={event => { event.preventDefault(); if (!busy && !disabled && ready && validAsset && validService && revisions.some(row => row.id === revisionId)) void onAction('/entries', { expectedAppointmentUpdatedAt: work.appointment.updatedAt, checklistRevisionId: revisionId, assetId: assetChoice === 'none' ? null : assetChoice, serviceObligationId: serviceId || null, ...acting }, 'Explicit visit entry prepared with saved checklist and asset snapshots.'); }}><fieldset className="min-w-0 space-y-3" disabled={busy || disabled || op.busy || !ready}>
      <label className="block text-sm">Company-reviewed checklist<select className={field} required value={revisionId} onChange={event => setRevisionId(event.target.value)}><option value="">Choose reviewed instructions</option>{revisions.map(row => <option value={row.id} key={row.id}>{row.definition.name} · revision {row.version}</option>)}</select></label>
      <label className="block text-sm">Equipment for this entry<select className={field} required value={assetChoice} onChange={event => setAssetChoice(event.target.value)}><option value="">Choose equipment or explicit none</option><option value="none">No equipment — non-equipment work</option>{assets.filter(asset => asset.status === 'active' && asset.currentParentCoherent).map(asset => <option key={asset.id} value={asset.id}>{asset.label}{asset.serial ? ` · ${asset.serial}` : ''}</option>)}</select></label>
      {!property && <p className="text-xs">This appointment has no property. Equipment cannot be linked by guess; explicit non-equipment work remains separate.</p>}
      <label className="block text-sm">Already-linked service occurrence (optional)<select className={field} value={serviceId} onChange={event => setServiceId(event.target.value)}><option value="">No service occurrence linked to this entry</option>{work.linkedServices.filter(service => service.status === 'active').map(service => <option key={service.id} value={service.id}>{service.equipmentLabel}</option>)}</select></label>
      <button className={button} disabled={!validAsset || !validService || !revisions.some(row => row.id === revisionId) || work.entries.length >= 20}>Prepare this visit entry</button>
    </fieldset></form>
    <div className="flex flex-wrap gap-2">{cursor && <button type="button" className={button} disabled={busy || disabled || op.busy} onClick={() => load(cursor)}>Load more property assets</button>}<button type="button" className={button} disabled={busy || op.busy} onClick={() => load()}>Refresh entry choices and clear selection</button></div>{ready && !revisions.length && <p>No currently reviewed checklist is available. Ask an owner or administrator to review one in Service Desk.</p>}
  </details>;
}
