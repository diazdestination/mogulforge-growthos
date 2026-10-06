import { useEffect, useState } from 'react';
import { workdayButton as button, workdayField as field, workdayCard as card, workdayLabel } from './workday-ui';
import type { WorkdayAnswer, WorkdayEntry } from './workday-contract';

export type WorkAction = (suffix: string, body: Record<string, unknown>, message: string, method?: 'POST' | 'PATCH') => Promise<void>;
export default function VisitWorkEntry({ entry, editable, cancellable, actingReady, busy, held, acting, onAction, onDirty, onUpload }: { entry: WorkdayEntry; editable: boolean; cancellable: boolean; actingReady: boolean; busy: boolean; held: boolean; acting: Record<string, string>; onAction: WorkAction; onDirty: (id: string, dirty: boolean) => void; onUpload: (entry: WorkdayEntry, file: File, itemKey: string | null, caption: string) => Promise<void> }) {
  const [answers, setAnswers] = useState<WorkdayAnswer[]>(entry.answers), [notes, setNotes] = useState(entry.notes), [cancelReason, setCancelReason] = useState(''), [file, setFile] = useState<File | null>(null), [photoItem, setPhotoItem] = useState(''), [caption, setCaption] = useState('');
  const dirty = JSON.stringify(answers) !== JSON.stringify(entry.answers) || notes !== entry.notes;
  useEffect(() => { onDirty(entry.id, dirty); return () => onDirty(entry.id, false); }, [dirty, entry.id]);
  const writable = editable && entry.state === 'draft' && entry.holdReasons.length === 0;
  const locked = busy || held || !writable;
  const canCancel = cancellable && entry.state === 'draft';
  const cancelLocked = busy || held || !actingReady;
  function change(itemKey: string, patch: Partial<WorkdayAnswer> | null) {
    if (locked) return;
    setAnswers(value => patch === null ? value.filter(row => row.itemKey !== itemKey) : [...value.filter(row => row.itemKey !== itemKey), { ...(value.find(row => row.itemKey === itemKey) ?? { itemKey, result: 'done' as const, value: null, reason: null }), ...patch }]);
  }
  return <section className={card} aria-label={`Visit entry: ${entry.checklist.definition.name}`}>
    <h4 className="font-semibold">{entry.assetSnapshot?.label ?? 'No equipment selected'} · {entry.checklist.definition.name}</h4>
    <p className="text-sm">{workdayLabel(entry.state)} · saved version {entry.version} · company-reviewed checklist revision {entry.checklist.version}</p>
    <p className="text-xs">{entry.assetSnapshot ? `Recorded equipment snapshot: ${[entry.assetSnapshot.manufacturer, entry.assetSnapshot.model, entry.assetSnapshot.serial].filter(Boolean).join(' · ') || 'optional identifiers not recorded'}` : 'Explicit non-equipment work. No equipment was inferred from a historical label.'}</p>
    {entry.serviceObligationId && <p className="break-all text-xs">Linked service occurrence: {entry.serviceObligationId}. Completion is a separate explicit choice.</p>}
    {entry.holdReasons.length > 0 && <p role="alert" className="text-sm">Work held: {entry.holdReasons.map(workdayLabel).join('; ')}. Refresh and ask the office to review the current parents; saved snapshots are unchanged.</p>}
    <form onSubmit={event => { event.preventDefault(); if (!locked) void onAction(`/entries/${entry.id}`, { expectedVersion: entry.version, answers, notes, ...acting }, 'Visit progress saved. This is not completed work.', 'PATCH'); }}>
      <fieldset className="min-w-0 space-y-3" disabled={locked}>
        {entry.checklist.definition.items.map(item => { const answer = answers.find(row => row.itemKey === item.key); return <div key={item.key} className="min-w-0 space-y-2 rounded border p-3">
          <h5 className="font-medium">{item.label}</h5><p className="text-xs">{item.required ? 'Required for completion' : 'Optional'}{item.unit ? ` · recorded unit: ${item.unit}; no automatic pass/fail threshold` : ''}</p>
          <label className="block text-sm">{item.label} outcome<select className={field} value={answer?.result ?? ''} onChange={event => change(item.key, event.target.value ? { result: event.target.value as WorkdayAnswer['result'], ...(event.target.value === 'not_applicable' ? { value: null } : {}) } : null)}><option value="">Not answered</option><option value="done">{item.kind === 'result' ? 'Done' : 'Observation recorded'}</option><option value="needs_attention">Needs attention</option>{item.allowNotApplicable && <option value="not_applicable">Not applicable — reason required</option>}</select></label>
          {item.kind === 'text' && answer?.result !== 'not_applicable' && <label className="block text-sm">{item.label} observation<textarea className={field} maxLength={2000} value={typeof answer?.value === 'string' ? answer.value : ''} onChange={event => change(item.key, { value: event.target.value })} /></label>}
          {item.kind === 'number' && answer?.result !== 'not_applicable' && <label className="block text-sm">{item.label} value ({item.unit})<input className={field} type="number" step="any" value={typeof answer?.value === 'number' ? answer.value : ''} onChange={event => change(item.key, { value: event.target.value === '' ? null : Number(event.target.value) })} /></label>}
          {item.kind === 'photo' && <p className="text-sm">{entry.photos.filter(photo => photo.state === 'attached' && photo.itemKey === item.key).length} attached private photos. Use the photo section below; selecting an outcome does not upload evidence.</p>}
          {answer && <label className="block text-sm">{item.label} reason{answer.result !== 'done' ? ' (required)' : ' (optional)'}<textarea className={field} maxLength={1000} value={answer.reason ?? ''} onChange={event => change(item.key, { reason: event.target.value || null })} /></label>}
        </div>; })}
        <label className="block text-sm">Work notes for {entry.checklist.definition.name}<textarea className={field} maxLength={2000} value={notes} onChange={event => setNotes(event.target.value)} /></label>
        {writable && <button className={button} disabled={!dirty}>Save progress for {entry.checklist.definition.name}</button>}
      </fieldset>
    </form>
    <p role="status" className="text-xs">{dirty ? 'Unsaved progress — save before photos or completion. Nothing is stored offline.' : 'Showing saved progress. A saved draft is not physical proof of completion.'}</p>
    <div className="min-w-0 space-y-2"><h5 className="font-medium">Private visit photos</h5>{!entry.photos.length && <p className="text-sm">No private work photos recorded.</p>}<ul className="space-y-2">{entry.photos.map(photo => <li className="min-w-0 rounded border p-2" key={photo.id}><p className="text-sm">{photo.caption || 'Work photo'} · {photo.state}</p>{photo.available && photo.contentPath ? <PrivateWorkPhoto path={photo.contentPath} caption={photo.caption} /> : <p className="text-xs">{photo.state === 'reserved' ? 'Upload reservation only — not attached evidence.' : 'Photo unavailable; no successful upload is assumed.'}</p>}</li>)}</ul></div>
    {writable && <form onSubmit={event => { event.preventDefault(); if (!locked && file && !dirty) void onUpload(entry, file, photoItem || null, caption); }}><fieldset className="min-w-0 space-y-3" disabled={locked || dirty}>
      <p className="text-xs">JPEG, PNG or WebP, up to 10 MiB; at most 50 per visit. Private work evidence only, not public marketing or AI/video analysis. A failed or uncertain upload must be reviewed, not automatically retried.</p>
      <label className="block text-sm">Photo evidence item<select className={field} value={photoItem} onChange={event => setPhotoItem(event.target.value)}><option value="">General visit evidence</option>{entry.checklist.definition.items.filter(item => item.kind === 'photo').map(item => <option key={item.key} value={item.key}>{item.label}</option>)}</select></label>
      <label className="block text-sm">Photo caption<input className={field} maxLength={500} value={caption} onChange={event => setCaption(event.target.value)} /></label>
      <label className="block min-w-0 text-sm">Choose private work photo<input className="mt-1 block min-h-11 w-full min-w-0 max-w-full text-sm" type="file" accept="image/jpeg,image/png,image/webp" onChange={event => setFile(event.target.files?.[0] ?? null)} /></label>
      <button className={button} disabled={!file}>Upload and attach private photo</button>
    </fieldset></form>}
    {canCancel && <details className="min-w-0 space-y-2"><summary className="min-h-11 cursor-pointer">Cancel this entry</summary><p className="text-sm">Cancellation preserves saved history and does not cancel the appointment or service. The office may cancel a held draft, review the changed facts and explicitly prepare a new entry. Nothing is automatically replaced.</p><label className="block text-sm">Entry cancellation reason<textarea className={field} disabled={cancelLocked} maxLength={2000} value={cancelReason} onChange={event => setCancelReason(event.target.value)} /></label><button type="button" className={button} disabled={cancelLocked || !cancelReason.trim()} onClick={() => { if (!cancelLocked && cancelReason.trim()) void onAction(`/entries/${entry.id}/cancel`, { expectedVersion: entry.version, reason: cancelReason.trim(), ...acting }, 'Entry cancelled; retained history is unchanged. Review the current facts before explicitly preparing another entry.'); }}>Cancel this work entry</button></details>}
  </section>;
}

function PrivateWorkPhoto({ path, caption }: { path: string; caption: string }) {
  const [failed, setFailed] = useState(false);
  return failed ? <p role="status" className="text-sm">Private photo unavailable. Access or storage could not be verified.</p> : <img src={path} alt={caption || 'Private visit evidence recorded by staff'} loading="lazy" className="max-h-64 max-w-full rounded object-contain" onError={() => setFailed(true)} />;
}
