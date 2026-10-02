import { useEffect, useRef, useState } from 'react';
import { useGetMe } from '@workspace/api-client-react';
import ContactSelect from '@/components/contact-select';
import { canWrite } from '@/lib/permissions';
import ServiceObligationEditor, { type ServiceRow } from '@/components/service-obligation-editor';

type ServiceKind = 'warranty_check' | 'maintenance' | 'service_plan';
type ServiceStatus = 'active' | 'completed' | 'cancelled';
const SERVICE_PAGE_SIZE = 500;
type ImportResult = { preview: boolean; totalRows: number; imported: number; duplicates: number; skipped: number; errors: string[] };

const fields = [
  ['firstName', 'First name'], ['lastName', 'Last name'], ['email', 'Email'], ['phone', 'Phone'],
  ['equipmentLabel', 'Equipment'], ['kind', 'Service kind'], ['dueDate', 'Next service / warranty date'],
  ['externalRef', 'External ID'], ['notes', 'Notes'],
] as const;
const hints: Record<string, RegExp> = {
  firstName: /first|fname/i, lastName: /last|lname/i, email: /e-?mail/i,
  phone: /phone|mobile|cell/i, equipmentLabel: /equipment|unit|system/i,
  kind: /kind|service.?type|plan.?type/i, dueDate: /due|warranty|next.?service/i,
  externalRef: /external.?id|service.?id|plan.?id/i, notes: /note|comment/i,
};
const kindNames: Record<ServiceKind, string> = {
  warranty_check: 'Warranty check', maintenance: 'Maintenance', service_plan: 'Service-plan visit',
};

async function jsonRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: 'include', ...init });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data as T;
}

export default function ServiceDesk() {
  const { data: me } = useGetMe();
  const editable = canWrite(me?.role);
  const [rows, setRows] = useState<ServiceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [recordStatus, setRecordStatus] = useState<ServiceStatus>('active');
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [reopening, setReopening] = useState<ServiceRow | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [contactId, setContactId] = useState('');
  const [kind, setKind] = useState<ServiceKind>('maintenance');
  const [equipmentLabel, setEquipmentLabel] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [noticeDays, setNoticeDays] = useState(30);
  const [csv, setCsv] = useState<string | null>(null);
  const [fileName, setFileName] = useState('');
  const [headers, setHeaders] = useState<string[]>([]);
  const [mapping, setMapping] = useState<Record<string, number>>({});
  const [defaultEquipment, setDefaultEquipment] = useState('');
  const [defaultKind, setDefaultKind] = useState<ServiceKind>('maintenance');
  const [preview, setPreview] = useState<ImportResult | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const loadSequence = useRef(0);
  const viewKey = `${me?.organization?.id ?? ''}:${recordStatus}:${offset}`;
  const currentView = useRef(viewKey);
  currentView.current = viewKey;

  async function refresh() {
    const sequence = ++loadSequence.current;
    setLoading(true);
    try {
      const response = await fetch(`/api/v1/service-obligations?status=${recordStatus}&offset=${offset}`, { credentials: 'include' });
      const result = await response.json();
      if (!response.ok || !Array.isArray(result)) throw new Error(result.error || 'Service schedule could not be loaded.');
      if (sequence !== loadSequence.current || viewKey !== currentView.current) return;
      setRows(result);
      const limitHeader = response.headers.get('X-Result-Limit-Reached');
      setHasMore(limitHeader === 'true' || (limitHeader === null && result.length >= SERVICE_PAGE_SIZE));
      setLoadError(false);
    } catch (error) {
      if (sequence !== loadSequence.current || viewKey !== currentView.current) return;
      setLoadError(true);
      setNotice(error instanceof Error ? error.message : 'Service schedule could not be loaded.');
    } finally {
      if (sequence === loadSequence.current && viewKey === currentView.current) setLoading(false);
    }
  }
  useEffect(() => {
    setRows([]); setReopening(null); setEditingId(null);
    void refresh();
    return () => { ++loadSequence.current; };
  }, [recordStatus, offset, me?.organization?.id]);

  async function reopenService() {
    if (!editable || !reopening || busy || reopening.obligation.status !== 'cancelled') return;
    setBusy(true); setNotice('');
    try {
      await jsonRequest(`/api/v1/service-obligations/${reopening.obligation.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'active', expectedUpdatedAt: reopening.obligation.updatedAt }),
      });
      setNotice('Service reopened as a one-time follow-up. Approve recurrence again only after reviewing the actual agreement. No appointment was booked and no customer message was sent.');
    } catch (error) {
      setNotice(`${error instanceof Error ? error.message : 'The reopening was not confirmed.'} Review the refreshed records before deciding whether to reopen again; no automatic retry was made.`);
    } finally {
      setReopening(null);
      await refresh();
      setBusy(false);
    }
  }

  async function addService(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true); setNotice('');
    try {
      await jsonRequest('/api/v1/service-obligations', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contactId, kind, equipmentLabel, dueDate, noticeDays }),
      });
      setNotice('Service date saved. A staff follow-up task is ready; no customer message was sent.');
      setEquipmentLabel(''); setDueDate('');
      await refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not save service date.');
    } finally { setBusy(false); }
  }


  async function chooseFile(file: File | undefined) {
    setPreview(null);
    if (!file) { setCsv(null); return; }
    if (file.size > 5_000_000) { setNotice('Choose a CSV under 5 MB.'); return; }
    const text = await file.text();
    const columns = (text.split(/\r?\n/, 1)[0] ?? '').split(',').map(value => value.replace(/^"|"$/g, '').trim());
    const auto: Record<string, number> = {};
    for (const [field] of fields) {
      const index = columns.findIndex(value => hints[field].test(value));
      if (index >= 0 && !Object.values(auto).includes(index)) auto[field] = index;
    }
    setCsv(text); setFileName(file.name); setHeaders(columns); setMapping(auto);
  }

  async function runImport(commit: boolean) {
    if (!csv) return;
    setBusy(true); setNotice('');
    try {
      const result = await jsonRequest<ImportResult>('/api/v1/service-obligations/import', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          csv, mapping, hasHeader: true, source: 'housecall-pro',
          defaultKind: mapping.kind === undefined ? defaultKind : undefined,
          defaultEquipmentLabel: mapping.equipmentLabel === undefined ? defaultEquipment : undefined,
          noticeDays, ...(commit ? { commit: true } : {}),
        }),
      });
      setPreview(result);
      setNotice(commit
        ? `${result.imported} customer service dates imported. Staff tasks created; no customer messages sent.`
        : `Preview: ${result.imported} valid, ${result.duplicates} duplicates, ${result.skipped} need attention.`);
      if (commit) { setCsv(null); setFileName(''); if (fileRef.current) fileRef.current.value = ''; await refresh(); }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Import could not be processed.');
    } finally { setBusy(false); }
  }

  const canPreview = !!csv && mapping.firstName !== undefined && mapping.dueDate !== undefined &&
    (mapping.email !== undefined || mapping.phone !== undefined) &&
    (mapping.equipmentLabel !== undefined || !!defaultEquipment);
  const visible = rows.filter(row => row.obligation.status === recordStatus);
  return (
    <div className="h-full overflow-auto p-4 md:p-6 space-y-6 max-w-6xl mx-auto">
      <header>
        <h1 className="text-2xl font-bold">Customer service desk</h1>
        <p className="text-sm text-muted-foreground">Warranty checks, maintenance, and plan visits stay with customers—not in the new-lead pipeline.</p>
      </header>
      {notice && <p role="status" className="rounded-lg border bg-card p-3 text-sm">{notice}</p>}
      <section className="rounded-xl border bg-card p-4 space-y-3" aria-label="Service records">
        <h2 className="font-semibold">{recordStatus === 'active' ? 'Upcoming service' : 'Service history'}</h2>
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-sm">Service records<select className="block min-h-11 rounded-lg border bg-background p-2" disabled={busy} value={recordStatus} onChange={event => { setRecordStatus(event.target.value as ServiceStatus); setOffset(0); }}><option value="active">Active follow-up</option><option value="completed">Completed visits</option><option value="cancelled">Cancelled service</option></select></label>
          <button type="button" className="min-h-11 rounded border px-3 py-2 text-sm disabled:opacity-50" disabled={loading || busy} onClick={() => void refresh()}>Refresh service records</button>
        </div>
        {loading ? <p>Loading service dates…</p> : loadError ? <p role="alert" className="text-sm text-muted-foreground">Service dates are unavailable. Try again before deciding what needs follow-up.</p> : visible.length === 0 ? <p className="text-sm text-muted-foreground">{offset ? 'No further service records on this page.' : recordStatus === 'active' ? 'No active service dates yet.' : `No ${recordStatus} service records yet.`}</p> : (
          <ul className="space-y-2">
            {visible.map(row => { const { obligation, contact, task } = row; return (
              <li key={obligation.id} className="rounded-lg border p-3 flex flex-wrap items-center justify-between gap-3 text-sm">
                <div className="min-w-0 break-words">
                  <p className="font-medium">{contact.firstName} {contact.lastName ?? ''} · {kindNames[obligation.kind]} · {obligation.equipmentLabel}</p>
                  <p className="text-muted-foreground">Due {obligation.dueAt.slice(0, 10)} · Staff task {task.status} · {obligation.source}</p>
                  {obligation.appointmentId && <p>Appointment linked</p>}
                  <p className="text-muted-foreground">{obligation.recurrence ? `Agreed every ${obligation.recurrence.intervalMonths} months` : 'One-time service'} · {task.assignedUserId ? 'Staff assigned' : 'Staff assignment needed'}</p>
                  {(obligation.coverageStartsOn || obligation.coverageEndsOn) && <p className="text-muted-foreground">Recorded coverage: {obligation.coverageStartsOn || 'Start not recorded'} to {obligation.coverageEndsOn || 'End not recorded'}</p>}
                  {recordStatus !== 'active' && <div className="mt-2 space-y-1">
                    <p className="capitalize">Recorded status: {obligation.status}</p>
                    {obligation.completedAt && <p>Completion recorded {new Date(obligation.completedAt).toLocaleString()}</p>}
                    {obligation.completionNote && <p>{obligation.completionNote}</p>}
                    {obligation.coverageEvidence && <p>{obligation.coverageEvidence}</p>}
                    {obligation.recurrence?.agreementNote && <p>Recorded recurrence agreement: {obligation.recurrence.agreementNote}</p>}
                  </div>}
                </div>
                {editable && recordStatus === 'active' && <button disabled={busy} className="min-h-11 rounded border px-3 py-2 disabled:opacity-50" onClick={() => setEditingId(editingId === obligation.id ? null : obligation.id)}>Manage service</button>}
                {editable && recordStatus === 'active' && editingId === obligation.id && <ServiceObligationEditor key={`${obligation.id}:${obligation.updatedAt}`} row={row} onClose={() => setEditingId(null)} onSaved={async message => { setNotice(message); await refresh(); }} />}
                {editable && recordStatus === 'cancelled' && <button type="button" disabled={busy} className="min-h-11 rounded border px-3 py-2 disabled:opacity-50" onClick={() => setReopening(row)}>Review reopening</button>}
                {editable && recordStatus === 'cancelled' && reopening?.obligation.id === obligation.id && <div role="group" aria-label="Reopen service review" className="w-full space-y-2 border-t pt-3">
                  <p>Reopen this cancelled service as active staff follow-up? Its recurrence approval is cleared. A new agreement review and explicit approval are required before future recurring tasks. This does not book an appointment or contact the customer.</p>
                  <div className="flex flex-wrap gap-2"><button type="button" disabled={busy} className="min-h-11 rounded border px-3 py-2 disabled:opacity-50" onClick={() => void reopenService()}>Reopen service</button><button type="button" disabled={busy} className="min-h-11 rounded border px-3 py-2" onClick={() => setReopening(null)}>Keep cancelled</button></div>
                </div>}
              </li>
            ); })}
          </ul>
        )}
        {!loading && !loadError && <div className="space-y-2 border-t pt-3 text-sm">
          <p>Showing {visible.length} {recordStatus} records on page {Math.floor(offset / SERVICE_PAGE_SIZE) + 1}, up to {SERVICE_PAGE_SIZE} per page.</p>
          {hasMore && <p>More service records are available. Continue to the next page; this is not the complete service count.</p>}
          {offset >= 100_000 && hasMore && <p>The supported paging limit has been reached. Ask an operator for a scoped export; additional records are not shown here.</p>}
          <div className="flex flex-wrap gap-2"><button type="button" disabled={busy || offset === 0} className="min-h-11 rounded border px-3 py-2 disabled:opacity-50" onClick={() => setOffset(value => Math.max(0, value - SERVICE_PAGE_SIZE))}>Previous service page</button><button type="button" disabled={busy || !hasMore || offset >= 100_000} className="min-h-11 rounded border px-3 py-2 disabled:opacity-50" onClick={() => setOffset(value => value + SERVICE_PAGE_SIZE)}>Next service page</button></div>
        </div>}
      </section>
      {editable && <div className="grid gap-5 lg:grid-cols-2">
        <form onSubmit={addService} className="rounded-xl border bg-card p-4 space-y-3">
          <h2 className="font-semibold">Add a service date</h2>
          <label className="block text-sm">Customer<ContactSelect value={contactId} onChange={setContactId} required testId="service-contact" /></label>
          <label className="block text-sm">Service type<select className="block w-full rounded border p-2" value={kind} onChange={event => setKind(event.target.value as ServiceKind)}>
            {Object.entries(kindNames).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select></label>
          <label className="block text-sm">Equipment<input required maxLength={160} className="block w-full rounded border p-2" value={equipmentLabel} onChange={event => setEquipmentLabel(event.target.value)} /></label>
          <label className="block text-sm">Service due date<input required type="date" className="block w-full rounded border p-2" value={dueDate} onChange={event => setDueDate(event.target.value)} /></label>
          <label className="block text-sm">Staff follow-up lead time (days)<input required type="number" min={0} max={365} className="block w-full rounded border p-2" value={noticeDays} onChange={event => { setNoticeDays(Number(event.target.value)); setPreview(null); }} /></label>
          <button disabled={busy || !contactId} className="min-h-11 rounded bg-primary px-4 py-2 text-primary-foreground dark:text-slate-950 disabled:opacity-50">Save service date</button>
        </form>
        <section className="rounded-xl border bg-card p-4 space-y-3" aria-label="Import customers">
          <h2 className="font-semibold">Import customer service dates</h2>
          <p className="text-sm text-muted-foreground">Export a CSV from Housecall Pro. Map the customer, equipment, service kind, and next due date. Preview before saving.</p>
          <input ref={fileRef} type="file" accept=".csv,text/csv" aria-label="Customer service CSV" onChange={event => void chooseFile(event.target.files?.[0])} />
          {fileName && <p className="text-xs">{fileName}</p>}
          {csv && <>
            <div className="grid gap-2 sm:grid-cols-2">
              {fields.map(([field, label]) => <label key={field} className="text-sm">{label}
                <select className="block w-full rounded border p-2" value={mapping[field] ?? ''} onChange={event => {
                  const next = { ...mapping };
                  if (event.target.value === '') delete next[field]; else next[field] = Number(event.target.value);
                  setMapping(next); setPreview(null);
                }}>
                  <option value="">Not mapped</option>
                  {headers.map((header, index) => <option key={`${header}-${index}`} value={index}>{header || `Column ${index + 1}`}</option>)}
                </select>
              </label>)}
            </div>
            {mapping.equipmentLabel === undefined && <label className="block text-sm">Default equipment label<input className="block w-full rounded border p-2" value={defaultEquipment} onChange={event => { setDefaultEquipment(event.target.value); setPreview(null); }} /></label>}
            {mapping.kind === undefined && <label className="block text-sm">Default service kind<select className="block w-full rounded border p-2" value={defaultKind} onChange={event => { setDefaultKind(event.target.value as ServiceKind); setPreview(null); }}>
              {Object.entries(kindNames).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select></label>}
            <div className="flex flex-wrap gap-2">
              <button type="button" disabled={!canPreview || busy} className="rounded border px-4 py-2 disabled:opacity-50" onClick={() => void runImport(false)}>Preview CSV</button>
              <button type="button" disabled={!preview?.preview || preview.imported === 0 || busy} className="rounded bg-primary px-4 py-2 text-primary-foreground disabled:opacity-50" onClick={() => void runImport(true)}>Import valid rows</button>
            </div>
          </>}
          {preview?.errors?.length ? <ul className="text-sm text-muted-foreground list-disc pl-5">{preview.errors.map(error => <li key={error}>{error}</li>)}</ul> : null}
        </section>
      </div>}
      <p className="text-xs text-muted-foreground">This desk creates staff follow-up tasks only. Customer email/text reminders require a verified sender, purpose-specific SMS consent, and activation for this contractor.</p>
    </div>
  );
}
