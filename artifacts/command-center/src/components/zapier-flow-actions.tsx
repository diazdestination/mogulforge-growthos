import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

type Capability = {
  key: string;
  binding: { config: Record<string, string | number | boolean | null> } | null;
  policy: { mode: 'off' | 'approve' | 'auto'; dailyBudget: number };
};
type Props = { capabilities: Capability[]; canManage: boolean; disabled?: boolean; onComplete: () => Promise<void>; onBusyChange?: (busy: boolean) => void };
type Option = { id: string; label: string };
type Outcome = { execution?: { state?: string }; received?: number; created?: number; skipped?: number };

const KEYS = {
  leads: 'scout.leads.list', reviews: 'scout.reviews.list', calendar: 'appt.calendar.create_event',
  accounting: 'invo.accounting.create_invoice', crew: 'sched.sms.send',
};
const timestamp = (value: string | null) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString() : 'Date unavailable';
const selectClass = 'h-10 w-full min-w-0 rounded-md border border-input bg-background px-3 text-sm';

/** Only explicit clicks request flows; record discovery is a tenant-scoped GET. */
export function ZapierFlowActions({ capabilities, canManage, disabled: setupBusy = false, onComplete, onBusyChange }: Props) {
  const [busy, setBusy] = useState<string | null>(null);
  const inFlight = useRef(false);
  const [held, setHeld] = useState<string[]>([]);
  const [result, setResult] = useState('');
  const [appointment, setAppointment] = useState('');
  const [invoice, setInvoice] = useState('');
  const [member, setMember] = useState('');
  const [date, setDate] = useState('');
  const id = useId();
  const ready = (key: string) => canManage && capabilities.some(capability => capability.key === key && capability.binding && capability.policy.mode !== 'off' && capability.policy.dailyBudget > 0);
  const disabled = (key: string) => setupBusy || busy !== null || held.includes(key);
  const crewBinding = capabilities.find(capability => capability.key === KEYS.crew)?.binding;
  const crewPhones = Object.entries(crewBinding?.config ?? {}).filter(([key, phone]) => key.startsWith('crew_phone_') && typeof phone === 'string' && phone.trim()).map(([key]) => key.slice('crew_phone_'.length)).sort().join('|');

  async function request(key: string, path: string, body: Record<string, string> = {}) {
    if (!ready(key) || setupBusy || inFlight.current || held.includes(key)) return;
    inFlight.current = true;
    onBusyChange?.(true);
    setBusy(key);
    setResult('Requesting flow…');
    try {
      const response = await fetch(`/api/v1/integrations/zapier/flows/${path}`, {
        method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      // A missing/malformed response cannot prove that no external action happened.
      const outcome = await response.json() as Outcome;
      const state = outcome.execution?.state;
      if (!response.ok || !state) {
        setHeld(current => [...current, key]);
        setResult('Outcome could not be confirmed. Review recent actions and reconcile the destination before making another request.');
      } else if (state === 'pending_approval') {
        setResult('Awaiting approval. No completed external action is confirmed. Review the request above.');
      } else if (state === 'succeeded') {
        const counts = [outcome.received, outcome.created, outcome.skipped];
        setResult(counts.every(value => typeof value === 'number' && Number.isFinite(value))
          ? `Sync completed: ${outcome.received} received · ${outcome.created} created · ${outcome.skipped} skipped.`
          : 'The connected app reported this action complete. Review its destination for the resulting record or delivery status.');
      } else if (state === 'indeterminate' || state === 'executing') {
        setHeld(current => [...current, key]);
        setResult(state === 'indeterminate'
          ? 'Outcome needs reconciliation. Review recent actions and the destination before making another request.'
          : 'Action is still running. Review recent actions before making another request.');
      } else if (['failed', 'blocked', 'rejected'].includes(state)) {
        setResult('Action did not complete. Review its status in recent actions.');
      } else {
        setHeld(current => [...current, key]);
        setResult('Outcome could not be confirmed. Review recent actions and reconcile the destination before making another request.');
      }
    } catch {
      setHeld(current => [...current, key]);
      setResult('Outcome could not be confirmed. Review recent actions and reconcile the destination before making another request.');
    } finally {
      // Reload failure must not change the outcome of the explicit flow request.
      try { await onComplete(); } catch { /* The parent owns its reload error. */ }
      inFlight.current = false;
      setBusy(null);
      onBusyChange?.(false);
    }
  }

  if (!canManage) return <p className="text-sm text-muted-foreground">An administrator can request configured app flows.</p>;
  return (
    <section aria-label="Request an app flow" className="min-w-0 space-y-3 rounded-md border p-3">
      <h3 className="font-medium">Request an app flow</h3>
      <p className="text-sm text-muted-foreground">Each button requests the named action using your saved app and policy. Approve each waits for approval; Automatic can act immediately. Nothing runs just by opening this page.</p>
      {(ready(KEYS.calendar) || ready(KEYS.accounting)) && <p className="text-xs text-muted-foreground">Record dates below use this device's timezone.</p>}
      {!Object.values(KEYS).some(ready) && <p className="text-sm text-muted-foreground">Configure an app action and enable its policy with a daily limit above zero to request a flow.</p>}
      <div className="flex flex-wrap gap-2">
        {ready(KEYS.leads) && <Button type="button" className="h-auto whitespace-normal text-left" disabled={disabled(KEYS.leads)} onClick={() => void request(KEYS.leads, 'scout/leads')}>Sync marketplace leads into GrowthOS</Button>}
        {ready(KEYS.reviews) && <Button type="button" className="h-auto whitespace-normal text-left" disabled={disabled(KEYS.reviews)} onClick={() => void request(KEYS.reviews, 'scout/reviews')}>Sync reviews into follow-up tasks</Button>}
      </div>
      {ready(KEYS.calendar) && <div className="space-y-2 rounded-md border p-3">
        <RecordPicker kind="appointments" label="Appointment" disabled={disabled(KEYS.calendar)} onChange={setAppointment} />
        <p className="text-xs text-muted-foreground">Creates an event in your connected calendar. Review existing events before requesting another export.</p>
        <Button type="button" className="h-auto whitespace-normal" disabled={disabled(KEYS.calendar) || !appointment} onClick={() => void request(KEYS.calendar, `appointments/${encodeURIComponent(appointment)}/calendar`)}>Create calendar event</Button>
      </div>}
      {ready(KEYS.accounting) && <div className="space-y-2 rounded-md border p-3">
        <RecordPicker kind="invoices" label="Issued invoice" disabled={disabled(KEYS.accounting)} onChange={setInvoice} />
        <p className="text-xs text-muted-foreground">Creates an invoice in your connected accounting app. This does not record a customer payment.</p>
        <Button type="button" className="h-auto whitespace-normal" disabled={disabled(KEYS.accounting) || !invoice} onClick={() => void request(KEYS.accounting, `invoices/${encodeURIComponent(invoice)}/accounting`)}>Export invoice to accounting</Button>
      </div>}
      {ready(KEYS.crew) && <div className="space-y-2 rounded-md border p-3">
        <RecordPicker kind="users" label="Team member" disabled={disabled(KEYS.crew)} eligibleIds={crewPhones} onChange={setMember} />
        <Label htmlFor={`${id}-date`}>Day sheet date (company timezone)</Label>
        <Input id={`${id}-date`} type="date" value={date} disabled={disabled(KEYS.crew)} onChange={event => setDate(event.target.value)} />
        <p className="text-xs text-muted-foreground">Texts this member's schedule for the chosen company date to their saved crew phone number.</p>
        <Button type="button" className="h-auto whitespace-normal" disabled={disabled(KEYS.crew) || !member || !validDate(date)} onClick={() => { if (validDate(date)) void request(KEYS.crew, 'sched/day-sheet', { userId: member, date }); }}>Send crew day sheet by text</Button>
      </div>}
      {capabilities.some(capability => capability.key.startsWith('callie.')) && <p className="text-xs text-muted-foreground">Call sync can also request missed-call texts. Call sync and text-back requests are not available from this panel while callback eligibility and send consent cannot be reviewed here.</p>}
      {result && <p role="status" className="break-words text-sm">{result}</p>}
    </section>
  );
}

function validDate(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

function RecordPicker({ kind, label, disabled, eligibleIds = '', onChange }: { kind: 'appointments' | 'invoices' | 'users'; label: string; disabled: boolean; eligibleIds?: string; onChange: (id: string) => void }) {
  const id = useId();
  const [options, setOptions] = useState<Option[]>([]);
  const [selected, setSelected] = useState('');
  const [page, setPage] = useState(0);
  const [total, setTotal] = useState(0);
  const [reload, setReload] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  useEffect(() => {
    let active = true;
    setLoading(true); setError(false); setOptions([]); setSelected(''); onChange('');
    void (async () => {
      try {
        const response = await fetch(`/api/v1/${kind}${kind === 'invoices' ? `?status=issued&page=${page}` : ''}`, { credentials: 'include' });
        if (!response.ok) throw new Error('Read unavailable');
        const body = await response.json();
        let next: Option[];
        if (kind === 'invoices') {
          if (!Array.isArray(body.items) || !Number.isFinite(body.total)) throw new Error('Invalid list');
          next = body.items.filter((row: { status: string; invoiceNumber: string | null }) => row.status === 'issued' && row.invoiceNumber).map((row: { id: string; invoiceNumber: string; customerName: string; issuedAt: string | null }) => ({ id: row.id, label: `${row.invoiceNumber} · ${row.customerName} · ${timestamp(row.issuedAt)}` }));
        } else {
          if (!Array.isArray(body)) throw new Error('Invalid list');
          next = kind === 'appointments'
            ? body.filter((row: { status: string }) => ['scheduled', 'confirmed'].includes(row.status)).map((row: { id: string; leadLabel: string | null; type: string; scheduledStart: string }) => ({ id: row.id, label: `${row.leadLabel || 'Customer unavailable'} · ${row.type.replace(/_/g, ' ')} · ${timestamp(row.scheduledStart)}` }))
            : body.filter((row: { id: string; isActive: boolean; operationallyEligible: boolean }) => row.isActive && row.operationallyEligible && eligibleIds.split('|').includes(row.id)).map((row: { id: string; firstName: string | null; lastName: string | null; email: string }) => ({ id: row.id, label: [row.firstName, row.lastName].filter(Boolean).join(' ') || row.email }));
        }
        if (active) { setOptions(next); setTotal(kind === 'invoices' ? body.total : body.length); }
      } catch { if (active) setError(true); }
      finally { if (active) setLoading(false); }
    })();
    return () => { active = false; };
  }, [kind, page, reload, eligibleIds, onChange]);
  return <div className="min-w-0 space-y-2">
    <Label htmlFor={id}>{label}</Label>
    <select id={id} className={selectClass} value={selected} disabled={disabled || loading || error} onChange={event => { const value = options.some(option => option.id === event.target.value) ? event.target.value : ''; setSelected(value); onChange(value); }}>
      <option value="">{loading ? 'Loading records…' : 'Choose an existing record'}</option>
      {options.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
    </select>
    {error ? <div className="space-y-2"><p role="alert" className="text-sm">Could not load {label.toLowerCase()} records.</p><Button type="button" variant="outline" size="sm" disabled={disabled} onClick={() => setReload(value => value + 1)}>Reload {label.toLowerCase()} records</Button></div>
      : !loading && !options.length && <p className="text-xs text-muted-foreground">No eligible records on this page.{kind === 'users' ? ' Add a saved crew phone for an active team member in the flow settings.' : ''}</p>}
    {kind === 'appointments' && !loading && total >= 200 && <p className="text-xs text-muted-foreground">Showing the latest 200 appointments. Older records are not listed here.</p>}
    {kind === 'invoices' && !loading && !error && total > 25 && <div className="flex flex-wrap items-center gap-2"><Button type="button" size="sm" variant="outline" disabled={disabled || page === 0} onClick={() => setPage(value => value - 1)}>Previous invoices</Button><span className="text-xs">Page {page + 1}</span><Button type="button" size="sm" variant="outline" disabled={disabled || (page + 1) * 25 >= total} onClick={() => setPage(value => value + 1)}>Next invoices</Button></div>}
  </div>;
}
