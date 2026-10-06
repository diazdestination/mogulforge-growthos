import { useEffect, useRef, useState } from 'react';
import { getListAppointmentsQueryKey, getListUsersQueryKey, useListAppointments, useListUsers } from '@workspace/api-client-react';
import { canAssignWork, scheduleTimezone } from '@/lib/contractor-schedule';
import { Link } from 'wouter';
import { appointmentWorkspaceLoginPath } from '@/lib/customer-workspace-links';

export type ServiceRow = {
  obligation: { id: string; contactId: string; propertyId?: string | null; kind: 'warranty_check' | 'maintenance' | 'service_plan'; equipmentLabel: string; dueAt: string; status: 'active' | 'completed' | 'cancelled'; source: string; appointmentId: string | null; updatedAt: string; recurrence: { intervalMonths: number; anchorDate: string; endDate: string | null; agreementNote: string } | null; coverageStartsOn: string | null; coverageEndsOn: string | null; coverageEvidence: string | null; completionNote?: string | null; completedAt?: string | null };
  contact: { id: string; firstName: string; lastName: string | null; phone: string | null; email: string | null };
  task: { status: string; dueAt: string | null; assignedUserId: string | null };
};
const field = 'mt-1 block min-h-11 w-full min-w-0 rounded-lg border bg-background p-2 text-base';
const button = 'min-h-11 rounded-lg border px-4 py-2 text-sm font-medium disabled:opacity-50';
async function save(path: string, body: unknown, method = 'PATCH') {
  const response = await fetch(`/api/v1/service-obligations/${path}`, { method, credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Service could not be saved. Refresh it and try again.');
  return result;
}

export default function ServiceObligationEditor({ row, onSaved, onClose, scopeKey = '', organizationId }: { row: ServiceRow; onSaved: (notice: string) => Promise<void>; onClose: () => void; scopeKey?: string; organizationId?: string }) {
  const { obligation: item, task } = row;
  const [dueDate, setDueDate] = useState(item.dueAt.slice(0, 10));
  const [assignedUserId, setAssignedUserId] = useState(task.assignedUserId ?? '');
  const [appointmentId, setAppointmentId] = useState(item.appointmentId ?? '');
  const [startsOn, setStartsOn] = useState(item.coverageStartsOn ?? '');
  const [endsOn, setEndsOn] = useState(item.coverageEndsOn ?? '');
  const [evidence, setEvidence] = useState(item.coverageEvidence ?? '');
  const [interval, setInterval] = useState(String(item.recurrence?.intervalMonths ?? 6));
  const [endDate, setEndDate] = useState(item.recurrence?.endDate ?? '');
  const [agreement, setAgreement] = useState(item.recurrence?.agreementNote ?? '');
  const [completionNote, setCompletionNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [reviewNeeded, setReviewNeeded] = useState(false);
  const [error, setError] = useState('');
  const { data: users, isError: usersError } = useListUsers({ query: { queryKey: [...getListUsersQueryKey(), 'service-editor', scopeKey] } });
  const params = { leadId: undefined, contactId: item.contactId ?? row.contact.id };
  const { data: appointments, isError: appointmentError } = useListAppointments(params, { query: { queryKey: [...getListAppointmentsQueryKey(params), 'service-editor', scopeKey] } });
  const mounted = useRef(true), view = useRef(''); view.current = `${scopeKey}:${item.id}:${item.updatedAt}`;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  async function work(fn: () => Promise<void>) {
    if (busy || reviewNeeded) return;
    const key = view.current;
    setBusy(true); setError('');
    try { await fn(); } catch (e) { if (mounted.current && key === view.current) { setReviewNeeded(true); setError(`${e instanceof Error ? e.message : 'Service could not be saved.'} Close this editor and refresh the saved service before another change. No automatic retry was made.`); } } finally { if (mounted.current && key === view.current) setBusy(false); }
  }
  async function update(status?: 'completed' | 'cancelled') {
    const key = view.current;
    const result = await save(item.id, status ? { status, completionNote, expectedUpdatedAt: item.updatedAt } : { dueDate, assignedUserId: assignedUserId || null, appointmentId: appointmentId || null, coverageStartsOn: startsOn || null, coverageEndsOn: endsOn || null, coverageEvidence: evidence || null, expectedUpdatedAt: item.updatedAt });
    if (!mounted.current || key !== view.current) return;
    await onSaved(status === 'completed' ? (result.nextObligationId ? 'Service completed. One next agreed service task is ready for office scheduling.' : 'Service completed. No next visit was created.') : status === 'cancelled' ? 'Service cancelled. No next visit will be generated from this occurrence.' : 'Service details saved. No customer message was sent.');
  }
  return <div className="mt-3 w-full min-w-0 space-y-6 border-t pt-4">
    <div className="flex items-center justify-between gap-3"><h3 className="text-lg font-semibold">Manage service</h3><button className={button} onClick={onClose}>Close</button></div>
    {error && <p role="alert" className="rounded-lg border border-destructive p-3 text-sm">{error}</p>}
    {item.appointmentId && organizationId && appointmentWorkspaceLoginPath(`/appointments?appointmentId=${item.appointmentId}&organizationId=${organizationId}`, 'https://growthos.invalid') && <p className="text-sm">If this visit has required structured work, complete its reviewed checklist there before completing this service. <Link className="inline-flex min-h-11 items-center underline" href={`/appointments?appointmentId=${item.appointmentId}&organizationId=${organizationId}`}>Open visit work</Link></p>}
    <form className="space-y-3" onSubmit={event => { event.preventDefault(); void work(() => update()); }}>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="min-w-0 text-sm">Service due date<input className={field} type="date" required value={dueDate} onChange={event => setDueDate(event.target.value)} /></label>
        <label className="min-w-0 text-sm">Responsible team member<select className={field} value={assignedUserId} onChange={event => setAssignedUserId(event.target.value)}><option value="">Unassigned</option>{users?.filter(canAssignWork).map(user => <option key={user.id} value={user.id}>{`${user.firstName ?? ''} ${user.lastName ?? ''}`.trim() || user.email}</option>)}</select></label>
      </div>
      <label className="block text-sm">Office appointment<select className={field} value={appointmentId} onChange={event => setAppointmentId(event.target.value)}><option value="">No appointment linked</option>{appointmentId && !appointments?.some(appt => appt.id === appointmentId) && <option value={appointmentId}>Current appointment — refresh its status before changing</option>}{appointments?.filter(appt => ['scheduled', 'confirmed', 'completed'].includes(appt.status)).map(appt => <option key={appt.id} value={appt.id}>{new Date(appt.scheduledStart).toLocaleString()} · {appt.status.replaceAll('_', ' ')}</option>)}</select></label>
      <p className="text-sm text-muted-foreground">Appointment times use {scheduleTimezone}. Book the visit in Appointments, then link it here. Cancellation or no-show reopens the office task.</p>
      {appointmentError && <p role="alert" className="text-sm">Appointments are unavailable. Refresh before changing this link.</p>}
      {(appointments?.length ?? 0) >= 200 && <p className="text-sm">Only 200 appointments are shown. Locate the visit in Appointments if it is missing.</p>}
      <details className="space-y-3"><summary className="cursor-pointer font-medium">Recorded warranty coverage</summary><p className="text-sm text-muted-foreground">Use only the dates and terms in the actual customer agreement. A service date does not establish coverage.</p>
        <div className="grid gap-3 sm:grid-cols-2"><label className="min-w-0 text-sm">Coverage starts<input className={field} type="date" value={startsOn} onChange={event => setStartsOn(event.target.value)} /></label><label className="min-w-0 text-sm">Coverage ends<input className={field} type="date" value={endsOn} onChange={event => setEndsOn(event.target.value)} /></label></div>
        <label className="block text-sm">Agreement or document reference<textarea className={field} maxLength={1000} required={!!startsOn || !!endsOn} value={evidence} onChange={event => setEvidence(event.target.value)} /></label>
      </details>
      {usersError && <p role="alert" className="text-sm">Team members are unavailable. Refresh before changing the accountable owner.</p>}
      <button className={button} disabled={busy || reviewNeeded || appointmentError || usersError}>Save service details</button>
    </form>
    <form className="space-y-3 border-t pt-4" onSubmit={event => { event.preventDefault(); const key = view.current; void work(async () => { await save(`${item.id}/recurrence`, { expectedUpdatedAt: item.updatedAt, intervalMonths: Number(interval), endDate: endDate || null, agreementNote: agreement }, 'POST'); if (mounted.current && key === view.current) await onSaved('Recurring staff task approved. The next task is created after this service is marked complete. Automatic reminders require separate standing approval.'); }); }}>
      <h4 className="font-semibold">Next agreed service</h4><p className="text-sm text-muted-foreground">{item.recurrence ? `Approved every ${item.recurrence.intervalMonths} months from ${item.recurrence.anchorDate}.` : 'This is currently a one-time visit.'} Keep the agreed calendar dates even if a visit is completed late. This never books or bills a customer automatically.</p>
      <p className="text-sm text-muted-foreground">This approves a recurring staff task, not customer messages. An owner or administrator can separately review forward-only automatic reminders under Customer care & booking. Changing this agreement or its owner requires new standing review.</p>
      <div className="grid gap-3 sm:grid-cols-2"><label className="min-w-0 text-sm">Repeat every (months)<input className={field} type="number" min={1} max={60} required value={interval} onChange={event => setInterval(event.target.value)} /></label><label className="min-w-0 text-sm">Last agreed due date (optional)<input className={field} type="date" value={endDate} onChange={event => setEndDate(event.target.value)} /></label></div>
      <label className="block text-sm">Customer agreement evidence<textarea className={field} required maxLength={500} value={agreement} onChange={event => setAgreement(event.target.value)} placeholder="Agreement reference and the approved service interval" /></label>
      <div className="flex flex-wrap gap-3"><button className={button} disabled={busy || reviewNeeded}>Approve recurring task</button>{item.recurrence && <button className={button} disabled={busy || reviewNeeded || !agreement.trim()} type="button" onClick={() => { const key = view.current; void work(async () => { await save(`${item.id}/recurrence`, { expectedUpdatedAt: item.updatedAt, intervalMonths: null, agreementNote: agreement }, 'POST'); if (mounted.current && key === view.current) await onSaved('Future recurrence stopped. This service remains due.'); }); }}>Stop future recurrence</button>}</div>
    </form>
    <div className="space-y-3 border-t pt-4"><h4 className="font-semibold">After the visit</h4><label className="block text-sm">Completion or cancellation note<textarea className={field} maxLength={1000} value={completionNote} onChange={event => setCompletionNote(event.target.value)} /></label><div className="flex flex-wrap gap-3"><button className={`${button} bg-primary text-primary-foreground dark:text-slate-950`} disabled={busy || reviewNeeded} onClick={() => void work(() => update('completed'))}>Mark serviced</button><button className={button} disabled={busy || reviewNeeded} onClick={() => void work(() => update('cancelled'))}>Cancel this service</button></div></div>
  </div>;
}
