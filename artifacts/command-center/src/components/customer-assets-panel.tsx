import { useEffect, useState } from 'react';
import CustomerPropertySelect from './customer-property-select';
import { AssetFields, emptyAssetForm, type AssetFormValue } from './workday-asset-fields';
import { assetPageFor, createWorkdayAssetSchema, updateWorkdayAssetSchema, workdayAssetMutationSchema, type WorkdayAsset } from './workday-contract';
import { workdayButton as button, workdayCard as card, WorkdayNotice, useWorkdayOperation, workdayRequest } from './workday-ui';

const toForm = (asset: WorkdayAsset): AssetFormValue => ({ type: asset.category, name: asset.label, make: asset.manufacturer ?? '', model: asset.model ?? '', serial: asset.serial ?? '', location: asset.location ?? '', installedOn: asset.installedOn ?? '', warrantyStartsOn: asset.warrantyStartsOn ?? '', warrantyEndsOn: asset.warrantyEndsOn ?? '', warrantySource: asset.warrantySource ?? '', notes: asset.notes ?? '', attributes: asset.attributes.map(item => ({ ...item })) });
const toContent = (value: AssetFormValue) => ({ category: value.type, label: value.name, manufacturer: value.make || null, model: value.model || null, serial: value.serial || null, location: value.location || null, installedOn: value.installedOn || null, warrantyStartsOn: value.warrantyStartsOn || null, warrantyEndsOn: value.warrantyEndsOn || null, warrantySource: value.warrantySource || null, notes: value.notes || null, attributes: value.attributes });

export default function CustomerAssetsPanel({ organizationId, contactId, scopeKey }: { organizationId: string; contactId: string; scopeKey: string }) {
  return <Assets key={`${scopeKey}:${organizationId}:${contactId}`} organizationId={organizationId} contactId={contactId} scopeKey={scopeKey} />;
}
function Assets({ organizationId, contactId, scopeKey }: { organizationId: string; contactId: string; scopeKey: string }) {
  const op = useWorkdayOperation(`${scopeKey}:${contactId}`);
  const [rows, setRows] = useState<WorkdayAsset[]>([]), [loaded, setLoaded] = useState(false), [canCreate, setCanCreate] = useState(false), [cursor, setCursor] = useState<string | null>(null), [seen, setSeen] = useState<string[]>([]);
  const [editing, setEditing] = useState<WorkdayAsset | null>(null), [formOpen, setFormOpen] = useState(false), [draft, setDraft] = useState(emptyAssetForm), [property, setProperty] = useState('');
  const path = `/contacts/${contactId}/assets`;
  function refresh(next: string | null = null) {
    if (op.busy) return;
    setLoaded(false); setFormOpen(false); setEditing(null); setRows([]);
    void op.run(async () => { const page = await workdayRequest(assetPageFor(organizationId, contactId), `${path}${next ? `?cursor=${encodeURIComponent(next)}` : ''}`); if (page.nextCursor && (page.nextCursor === next || seen.includes(page.nextCursor))) throw new Error('Asset page repeated'); const combined = next ? [...rows, ...page.items] : page.items; if (new Set(combined.map(row => row.id)).size !== combined.length) throw new Error('Asset pages overlap'); return { page, combined }; }, ({ page, combined }) => { setRows(combined); setCursor(page.nextCursor); setSeen(next ? [...seen, next] : []); setCanCreate(page.canCreate); setLoaded(true); }, { refresh: true });
  }
  useEffect(() => { refresh(); }, []);
  function start(asset: WorkdayAsset | null) { if (op.busy || op.held) return; setEditing(asset); setDraft(asset ? toForm(asset) : emptyAssetForm()); setProperty(''); setFormOpen(true); op.invalidate(); }
  function save(retire = false) {
    if (op.busy || op.held || (editing ? !editing.canEdit : !canCreate)) return;
    const requestId = crypto.randomUUID();
    const body = editing ? updateWorkdayAssetSchema.safeParse({ ...toContent(draft), requestId, expectedVersion: editing.version, status: retire ? 'retired' : editing.status }) : createWorkdayAssetSchema.safeParse({ ...toContent(draft), requestId, propertyId: property });
    if (!body.success) { op.setError('Choose an explicit property and review the recorded asset fields and date formats.'); return; }
    const originalId = editing?.id;
    void op.run(() => workdayRequest(workdayAssetMutationSchema.refine(result => result.organizationId === organizationId && result.asset.organizationId === organizationId && result.asset.contactId === contactId && result.receipt.requestId === requestId && (!originalId || result.asset.id === originalId) && result.asset.propertyId === (editing?.propertyId ?? property)), originalId ? `/assets/${originalId}` : path, { method: originalId ? 'PATCH' : 'POST', body: body.data }), result => { setRows(current => originalId ? current.map(row => row.id === originalId ? result.asset : row) : [result.asset, ...current]); setEditing(null); setFormOpen(false); }, { mutation: true, success: retire ? 'Asset retired from new selection. Historical work snapshots are unchanged.' : 'Recorded asset saved. No warranty eligibility or customer message is implied.' });
  }
  return <div className="min-w-0 space-y-3"><h3 className="text-lg font-semibold">Equipment & assets</h3><p className="text-sm text-muted-foreground">Structured records belong to this customer and an explicitly chosen property. Old service equipment labels are separate history; nothing is automatically linked.</p>
    <WorkdayNotice {...op} /><div className="flex flex-wrap gap-2"><button type="button" className={button} disabled={op.busy} onClick={() => refresh()}>Refresh assets and review saved records</button>{loaded && canCreate && <button type="button" className={button} disabled={op.busy || op.held} onClick={() => start(null)}>Add equipment or asset</button>}</div>
    {!loaded ? <p role="status">{op.error ? 'Assets are unavailable, not an empty result.' : 'Loading customer assets…'}</p> : rows.length === 0 ? <p>No structured assets recorded for this customer.</p> : <ul className="min-w-0 space-y-3" aria-label="Customer assets">{rows.map(asset => <li key={asset.id} className={card}>
      <h4 className="font-semibold">{asset.label}</h4><p className="text-sm">{asset.category.replaceAll('_', ' ')} · {asset.status} · version {asset.version}</p><p className="break-all text-xs">Recorded property ID: {asset.propertyId}</p>
      <p className="text-sm">{[asset.manufacturer, asset.model, asset.serial].filter(Boolean).join(' · ') || 'Identifiers not recorded'}</p>{asset.location && <p>{asset.location}</p>}
      <details className="space-y-2 text-sm"><summary className="min-h-11 cursor-pointer">Read recorded asset details</summary><p>Installation date: {asset.installedOn || 'Not recorded'}</p><p>Recorded warranty dates: {asset.warrantyStartsOn || 'Not recorded'} – {asset.warrantyEndsOn || 'Not recorded'}</p><p className="whitespace-pre-wrap">Source reference: {asset.warrantySource || 'Not recorded'}</p><p className="text-xs">Recorded dates do not determine warranty coverage or service requirements.</p>{asset.notes && <p className="whitespace-pre-wrap">{asset.notes}</p>}<dl className="space-y-1">{asset.attributes.map((attribute, index) => <div key={index}><dt className="font-medium">{attribute.label}</dt><dd className="whitespace-pre-wrap">{attribute.value}</dd></div>)}</dl></details>
      {!asset.currentParentCoherent && <p role="alert">The current property/customer relationship needs review. Historical facts remain; new editing is held.</p>}{asset.canEdit && <button type="button" className={button} disabled={op.busy || op.held} onClick={() => start(asset)}>Edit {asset.label}</button>}
    </li>)}</ul>}
    {cursor && loaded && <button type="button" className={button} disabled={op.busy || op.held} onClick={() => refresh(cursor)}>Load more customer assets</button>}
    {formOpen && <form className={card} onSubmit={event => { event.preventDefault(); save(); }}><fieldset className="min-w-0 space-y-3" disabled={op.busy || op.held}><legend className="font-semibold">{editing ? 'Edit recorded asset' : 'New recorded asset'}</legend>
      {editing ? <p className="text-sm">Customer/property identity is fixed. Editing will not change previous visit snapshots.</p> : <CustomerPropertySelect organizationId={organizationId} contactId={contactId} scopeKey={scopeKey} purpose="asset" value={property} onChange={setProperty} disabled={op.busy || op.held} />}
      <AssetFields value={draft} onChange={setDraft} /><div className="flex flex-wrap gap-2"><button className={button} disabled={!editing && !property}>Save recorded asset</button>{editing?.status === 'active' && <button type="button" className={button} onClick={() => save(true)}>Save edits and retire this asset</button>}<button type="button" className={button} onClick={() => setFormOpen(false)}>Close asset editor</button></div>
    </fieldset></form>}
  </div>;
}
