import { useEffect, useId, useRef, useState } from 'react';
import {
  customerDetailSnapshotSchema, detailCorrectionInputSchema, detailCorrectionReceiptSchema,
  detailCorrectionSaveResultSchema, type CustomerDetailSnapshot, type DetailCorrectionInput,
  type DetailCorrectionReceipt,
} from '../../../api-server/src/services/customer-detail-correction-contract';
import { ContractorApiError, contractorRequest } from '@/lib/contractor-api';
import CustomerPropertySelect from './customer-property-select';
import { workdayButton as button, workdayCard as card, workdayField as field } from './workday-ui';

type Props = { organizationId: string; contactId: string; scopeKey: string; onSaved?: () => void };
const contactFields = ['firstName', 'lastName', 'email', 'phone'] as const;
const addressFields = ['addressLine1', 'addressLine2', 'city', 'state', 'postalCode'] as const;
type Draft = Record<typeof contactFields[number] | typeof addressFields[number], string>;
const blank = (): Draft => ({ firstName: '', lastName: '', email: '', phone: '', addressLine1: '', addressLine2: '', city: '', state: '', postalCode: '' });
const labels: Record<keyof Draft, string> = { firstName: 'First name', lastName: 'Last name', email: 'Email', phone: 'Phone', addressLine1: 'Street address', addressLine2: 'Address line 2', city: 'City', state: 'State or region', postalCode: 'Postal code' };
function draftFor(snapshot: CustomerDetailSnapshot): Draft {
  const result = blank();
  for (const key of contactFields) result[key] = snapshot.details[key] ?? '';
  for (const key of addressFields) result[key] = snapshot.details.property?.[key] ?? '';
  return result;
}
function matchesChanges(input: DetailCorrectionInput, receipt: DetailCorrectionReceipt): boolean {
  for (const key of contactFields) if (input.changes[key] !== undefined && receipt.snapshot.details[key] !== input.changes[key]) return false;
  if (input.changes.property) for (const key of addressFields) if (input.changes.property[key] !== undefined && receipt.snapshot.details.property?.[key] !== input.changes.property[key]) return false;
  return true;
}

export default function CustomerDetailCorrectionPanel(props: Props) {
  return <Correction key={`${props.scopeKey}:${props.organizationId}:${props.contactId}`} {...props} />;
}
function Correction({ organizationId, contactId, onSaved }: Props) {
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [held, setHeld] = useState(false);
  const [includeAddress, setIncludeAddress] = useState(false), [propertyId, setPropertyId] = useState(''), [propertyReady, setPropertyReady] = useState(false);
  const [snapshot, setSnapshot] = useState<CustomerDetailSnapshot | null>(null), [draft, setDraft] = useState(blank);
  const [error, setError] = useState(''), [notice, setNotice] = useState('');
  const alive = useRef(true), generation = useRef(0), busyRef = useRef(false), controller = useRef<AbortController | null>(null);
  const pending = useRef<DetailCorrectionInput | null>(null);
  const panelId = useId(), inputId = useId();
  useEffect(() => { alive.current = true; return () => { alive.current = false; generation.current++; controller.current?.abort(); }; }, []);
  function begin() {
    if (busyRef.current || !alive.current) return null;
    busyRef.current = true; setBusy(true); setError(''); setNotice('');
    const epoch = ++generation.current, request = new AbortController(); controller.current = request;
    return { signal: request.signal, current: () => alive.current && epoch === generation.current && !request.signal.aborted };
  }
  function finish(work: NonNullable<ReturnType<typeof begin>>) { if (work.current()) { busyRef.current = false; setBusy(false); controller.current = null; } }
  function verifyContext(value: CustomerDetailSnapshot, selected: string | null) {
    if (value.organizationId !== organizationId || value.contactId !== contactId || value.propertyId !== selected) throw new Error('Customer review context changed');
    return value;
  }
  async function load() {
    if (pending.current || (includeAddress && (!propertyReady || !propertyId))) return;
    const work = begin(); if (!work) return;
    setSnapshot(null);
    const selected = includeAddress ? propertyId : null;
    try {
      const result = verifyContext(customerDetailSnapshotSchema.parse(await contractorRequest(`/contacts/${contactId}/detail-correction${selected ? `?propertyId=${encodeURIComponent(selected)}` : ''}`, { signal: work.signal })), selected);
      if (!work.current()) return;
      setSnapshot(result); setDraft(draftFor(result)); setHeld(false);
    } catch { if (work.current()) setError('Current customer details could not be verified. Check your company access and load them again.'); }
    finally { finish(work); }
  }
  async function save() {
    if (!snapshot || held || pending.current || busyRef.current) return;
    const changes: Record<string, unknown> = {};
    for (const key of contactFields) if (draft[key] !== (snapshot.details[key] ?? '')) changes[key] = draft[key];
    if (snapshot.details.property) {
      const address: Record<string, string> = {};
      for (const key of addressFields) if (draft[key] !== (snapshot.details.property[key] ?? '')) address[key] = draft[key];
      if (Object.keys(address).length) changes.property = address;
    }
    if (!Object.keys(changes).length) { setNotice('The reviewed details are unchanged.'); return; }
    const parsed = detailCorrectionInputSchema.safeParse({ requestId: crypto.randomUUID(), propertyId: snapshot.propertyId, expectedVersion: snapshot.version, changes });
    if (!parsed.success) { setError('Review the name, email, phone and address fields. Required values must be filled and supplied contact details must be valid.'); return; }
    const work = begin(); if (!work) return;
    pending.current = parsed.data;
    try {
      const result = detailCorrectionSaveResultSchema.parse(await contractorRequest(`/contacts/${contactId}/detail-corrections`, { method: 'POST', body: parsed.data, signal: work.signal }));
      verifyContext(result.receipt.snapshot, parsed.data.propertyId);
      if (result.receipt.requestId !== parsed.data.requestId || !matchesChanges(parsed.data, result.receipt)) throw new Error('Saved result changed');
      if (!work.current()) return;
      pending.current = null; setSnapshot(result.receipt.snapshot); setDraft(draftFor(result.receipt.snapshot));
      setNotice(result.receipt.status === 'unchanged' ? 'The reviewed details are unchanged.' : 'Customer details saved.'); onSaved?.();
    } catch (failure) {
      if (!work.current()) return;
      if (failure instanceof ContractorApiError && [400, 403, 404, 409].includes(failure.status) && failure.code.startsWith('detail_correction_')) {
        pending.current = null; setSnapshot(null);
        setError(failure.status === 409 ? 'These records changed or the review was already used. Load current details and review before another save.' : 'This correction was refused. Check your access and the supplied details before loading again.');
      } else {
        setHeld(true); setError('The save result is unconfirmed. Check the original saved result before another change.');
      }
    } finally { finish(work); }
  }
  async function reconcile() {
    const original = pending.current; if (!original) return;
    const work = begin(); if (!work) return;
    try {
      const receipt = detailCorrectionReceiptSchema.parse(await contractorRequest(`/contacts/${contactId}/detail-corrections/${original.requestId}`, { signal: work.signal }));
      verifyContext(receipt.snapshot, original.propertyId);
      if (receipt.requestId !== original.requestId || !matchesChanges(original, receipt)) throw new Error('Original result changed');
      if (!work.current()) return;
      pending.current = null; setHeld(false); setSnapshot(null); setDraft(blank());
      setNotice('Original save verified. Load current details before making another edit.'); onSaved?.();
    } catch { if (work.current()) setError('The original saved result is still unavailable. Check again before another save.'); }
    finally { finish(work); }
  }
  function changeSelection(next: string) { if (busyRef.current || pending.current) return; setPropertyId(next); setSnapshot(null); setError(''); setNotice(''); }
  return <section className={card} aria-label="Customer detail review">
    <button type="button" className={button} disabled={busy} aria-expanded={open} aria-controls={panelId} onClick={() => setOpen(value => !value)}>{open ? 'Close detail review' : 'Review customer details'}</button>
    {open && <div id={panelId} className="min-w-0 space-y-4">
      <p className="text-sm text-muted-foreground">Review contact details and, when selected, a property address. Appointment times are confirmed in Scheduling.</p>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}{notice && <p role="status" className="text-sm">{notice}</p>}
      {held ? <button type="button" className={button} disabled={busy} onClick={() => void reconcile()}>Check original saved result</button> : <>
        <label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" disabled={busy} checked={includeAddress} onChange={event => { setIncludeAddress(event.target.checked); changeSelection(''); }} />Also review a property address</label>
        {includeAddress && <CustomerPropertySelect organizationId={organizationId} contactId={contactId} scopeKey={`${organizationId}:${contactId}`} purpose="correction" value={propertyId} onChange={changeSelection} onReadyChange={setPropertyReady} disabled={busy} />}
        <button type="button" className={button} disabled={busy || (includeAddress && (!propertyReady || !propertyId))} onClick={() => void load()}>{busy ? 'Checking…' : 'Load current details'}</button>
      </>}
      {snapshot && <form noValidate onSubmit={event => { event.preventDefault(); void save(); }}>
        <fieldset className="min-w-0 space-y-4" disabled={busy || held}>
          <legend className="font-semibold">Reviewed customer details</legend>
          <div className="grid min-w-0 gap-4 sm:grid-cols-2">{contactFields.map(key => <label key={key} htmlFor={`${inputId}-${key}`} className="block min-w-0 text-sm">{labels[key]}{key === 'firstName' ? ' *' : ''}<input id={`${inputId}-${key}`} className={field} type={key === 'email' ? 'email' : key === 'phone' ? 'tel' : 'text'} required={key === 'firstName'} value={draft[key]} onChange={event => setDraft(value => ({ ...value, [key]: event.target.value }))} /></label>)}</div>
          {snapshot.details.property && <div className="grid min-w-0 gap-4 sm:grid-cols-2">{addressFields.map(key => <label key={key} htmlFor={`${inputId}-${key}`} className="block min-w-0 text-sm">{labels[key]}{key !== 'addressLine2' ? ' *' : ''}<input id={`${inputId}-${key}`} className={field} required={key !== 'addressLine2'} value={draft[key]} onChange={event => setDraft(value => ({ ...value, [key]: event.target.value }))} /></label>)}</div>}
          <button className={button}>Save reviewed details</button>
        </fieldset>
      </form>}
    </div>}
  </section>;
}
