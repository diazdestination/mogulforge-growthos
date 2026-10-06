import { workdayButton as button, workdayField as field } from './workday-ui';

/** Editable strings are a local form draft, not an API payload or inferred facts. */
export type AssetFormValue = {
  type: string; name: string; make: string; model: string; serial: string; location: string;
  installedOn: string; warrantyStartsOn: string; warrantyEndsOn: string; warrantySource: string; notes: string;
  attributes: { label: string; value: string }[];
};
export const emptyAssetForm = (): AssetFormValue => ({ type: '', name: '', make: '', model: '', serial: '', location: '', installedOn: '', warrantyStartsOn: '', warrantyEndsOn: '', warrantySource: '', notes: '', attributes: [] });

export function AssetFields({ value, onChange }: { value: AssetFormValue; onChange: (value: AssetFormValue) => void }) {
  const change = (patch: Partial<AssetFormValue>) => onChange({ ...value, ...patch });
  return <div className="min-w-0 space-y-3">
    <div className="grid min-w-0 gap-3 sm:grid-cols-2">
      <label className="min-w-0 text-sm">Asset name<input className={field} required maxLength={160} value={value.name} onChange={event => change({ name: event.target.value })} /></label>
      <label className="min-w-0 text-sm">Asset type<select className={field} required value={value.type} onChange={event => change({ type: event.target.value })}><option value="">Choose recorded asset type</option><option value="hvac_equipment">HVAC equipment</option><option value="roof_system">Roof system / area</option><option value="other">Other asset</option></select></label>
    </div>
    <details className="min-w-0 space-y-3 rounded border p-3"><summary className="min-h-11 cursor-pointer font-medium">Recorded identifiers and details</summary>
      <p className="text-xs text-muted-foreground">Record only known information. Optional identifiers may stay blank, including for a roof area. Nothing is inferred from the name.</p>
      <div className="grid min-w-0 gap-3 sm:grid-cols-2">{(['make', 'model', 'serial', 'location'] as const).map(key => <label key={key} className="min-w-0 text-sm">{({ make: 'Make / manufacturer', model: 'Model', serial: 'Serial number', location: 'Location at property' })[key]}<input className={field} maxLength={key === 'location' ? 300 : 160} value={value[key]} onChange={event => change({ [key]: event.target.value })} /></label>)}
        <label className="min-w-0 text-sm">Recorded installation date<input className={field} type="date" value={value.installedOn} onChange={event => change({ installedOn: event.target.value })} /></label>
      </div>
      <label className="block text-sm">Asset notes<textarea className={field} maxLength={2000} value={value.notes} onChange={event => change({ notes: event.target.value })} /></label>
      <fieldset className="min-w-0 space-y-3"><legend className="font-medium text-sm">Additional recorded details</legend>{value.attributes.map((attribute, index) => <div key={index} className="min-w-0 space-y-2 rounded border p-2">
        <label className="block text-sm">Detail {index + 1} label<input className={field} required maxLength={80} value={attribute.label} onChange={event => change({ attributes: value.attributes.map((row, i) => i === index ? { ...row, label: event.target.value } : row) })} /></label>
        <label className="block text-sm">Detail {index + 1} value<input className={field} required maxLength={300} value={attribute.value} onChange={event => change({ attributes: value.attributes.map((row, i) => i === index ? { ...row, value: event.target.value } : row) })} /></label>
        <button type="button" className={button} onClick={() => change({ attributes: value.attributes.filter((_, i) => i !== index) })}>Remove detail {index + 1}</button>
      </div>)}<button type="button" className={button} disabled={value.attributes.length >= 20} onClick={() => change({ attributes: [...value.attributes, { label: '', value: '' }] })}>Add recorded detail</button></fieldset>
    </details>
    <details className="min-w-0 space-y-3 rounded border p-3"><summary className="min-h-11 cursor-pointer font-medium">Recorded warranty dates</summary>
      <p className="text-sm text-muted-foreground">Dates and a document reference are staff-recorded facts, not a determination of warranty eligibility. Do not infer coverage or servicing requirements.</p>
      <div className="grid min-w-0 gap-3 sm:grid-cols-2"><label className="min-w-0 text-sm">Warranty starts on<input className={field} type="date" value={value.warrantyStartsOn} onChange={event => change({ warrantyStartsOn: event.target.value })} /></label><label className="min-w-0 text-sm">Warranty ends on<input className={field} type="date" value={value.warrantyEndsOn} onChange={event => change({ warrantyEndsOn: event.target.value })} /></label></div>
      <label className="block text-sm">Warranty source / document reference<textarea className={field} maxLength={1000} required={!!value.warrantyStartsOn || !!value.warrantyEndsOn} value={value.warrantySource} onChange={event => change({ warrantySource: event.target.value })} /></label>
    </details>
  </div>;
}
