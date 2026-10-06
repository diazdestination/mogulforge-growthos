import { useEffect, useRef, useState } from 'react';
import { Link } from 'wouter';
import { customerWorkspaceAppointmentDetailSchema, type CustomerWorkspaceAppointmentDetail } from '../../../api-server/src/services/customer-workspace-contract';
import { appointmentWorkspaceLoginPath, customerWorkspacePath } from '@/lib/customer-workspace-links';
import { scheduleTimezone } from '@/lib/contractor-schedule';
import VisitWorkPanel from './visit-work-panel';
import { WorkdayDisclosure } from './workday-ui';

type Props = {
  search: string;
  organizationId: string;
  scopeKey: string;
  refreshKey: number;
  onShowDay: (start: string) => void;
  onWorkCompleted?: () => void;
};

export default function AppointmentLinkedCard(props: Props) {
  const params = new URLSearchParams(props.search);
  if (!params.has('appointmentId') && !params.has('organizationId')) return null;
  const path = appointmentWorkspaceLoginPath(`/appointments?${params.toString()}`, 'https://growthos.invalid');
  if (!path) return <p role="alert" className="mx-auto mb-5 max-w-5xl rounded-lg border p-4">This appointment link is invalid. No linked appointment was opened. Use a complete appointment link or browse the schedule below.</p>;
  if (params.get('organizationId') !== props.organizationId) return <p role="alert" className="mx-auto mb-5 max-w-5xl rounded-lg border p-4">This appointment link belongs to another company. Sign in to that company to review it; no account was switched and no linked appointment was opened.</p>;
  return <SelectedAppointment key={`${props.scopeKey}:${path}`} {...props} appointmentId={params.get('appointmentId')!} />;
}

function SelectedAppointment({ organizationId, appointmentId, scopeKey, refreshKey, onShowDay, onWorkCompleted }: Props & { appointmentId: string }) {
  const [detail, setDetail] = useState<CustomerWorkspaceAppointmentDetail | null>(null);
  const [failed, setFailed] = useState(false), [loading, setLoading] = useState(true), [revision, setRevision] = useState(0);
  const sequence = useRef(0);
  useEffect(() => {
    const request = new AbortController(), current = ++sequence.current;
    setDetail(null); setFailed(false); setLoading(true);
    void (async () => {
      try {
        const response = await fetch(`/api/v1/appointments/${encodeURIComponent(appointmentId)}`, { credentials: 'include', cache: 'no-store', signal: request.signal });
        if (!response.ok) throw new Error('Appointment unavailable');
        const result = customerWorkspaceAppointmentDetailSchema.parse(await response.json());
        if (result.organizationId !== organizationId || result.appointment.id !== appointmentId) throw new Error('Appointment context changed');
        if (current === sequence.current && !request.signal.aborted) setDetail(result);
      } catch { if (current === sequence.current && !request.signal.aborted) { setDetail(null); setFailed(true); } }
      finally { if (current === sequence.current && !request.signal.aborted) setLoading(false); }
    })();
    return () => { ++sequence.current; request.abort(); };
  }, [appointmentId, organizationId, revision, refreshKey]);

  return <section aria-label="Selected appointment" className="mx-auto mb-5 max-w-5xl min-w-0 space-y-3 rounded-xl border border-primary/40 bg-card p-4">
    <h2 className="text-lg font-semibold">Selected appointment</h2>
    {loading ? <p role="status">Opening the exact appointment…</p> : failed || !detail ? <div role="alert"><p>The linked appointment is unavailable for this company or your current access. The schedule below is separate; it has not replaced the requested appointment.</p><button type="button" className="min-h-11 underline" onClick={() => setRevision(value => value + 1)}>Retry linked appointment</button></div> : <>
      <dl className="grid min-w-0 gap-2 text-sm sm:grid-cols-2">
        <div><dt className="text-muted-foreground">Visit type</dt><dd className="capitalize">{detail.appointment.type.replaceAll('_', ' ')}</dd></div>
        <div><dt className="text-muted-foreground">Recorded status</dt><dd className="capitalize">{detail.appointment.status.replaceAll('_', ' ')}</dd></div>
        <div><dt className="text-muted-foreground">Start</dt><dd className="break-words">{new Date(detail.appointment.scheduledStart).toLocaleString()} ({scheduleTimezone})</dd></div>
        <div><dt className="text-muted-foreground">End</dt><dd className="break-words">{detail.appointment.scheduledEnd ? `${new Date(detail.appointment.scheduledEnd).toLocaleString()} (${scheduleTimezone})` : 'No end recorded'}</dd></div>
        <div><dt className="text-muted-foreground">Team member</dt><dd className="break-words">{detail.appointment.owner ? detail.appointment.owner.name || 'Team member' : 'Unassigned'}</dd></div>
        <div><dt className="text-muted-foreground">Property</dt><dd className="break-words">{detail.appointment.property ? [detail.appointment.property.addressLine1, detail.appointment.property.addressLine2, detail.appointment.property.city, detail.appointment.property.state, detail.appointment.property.postalCode].filter(Boolean).join(', ') : 'No property linked'}</dd></div>
      </dl>
      {detail.appointment.contactId ? <Link className="inline-flex min-h-11 items-center underline underline-offset-4" href={customerWorkspacePath(detail.appointment.contactId, organizationId)!}>Open customer record</Link> : <p className="text-sm text-muted-foreground">No customer linked. This visit has not been added to a customer record.</p>}
      <p className="text-sm text-muted-foreground">This is a read-only appointment summary, including visits outside the displayed schedule range. Private appointment notes are not included. {detail.permissions.canWrite ? 'To make changes, show this day and use the existing schedule record’s explicit edit control.' : 'Your current access is read-only.'}</p>
      <div className="flex flex-wrap gap-2">
        <button type="button" className="min-h-11 rounded border px-3 py-2 text-sm" onClick={() => onShowDay(detail.appointment.scheduledStart)}>Show this day in schedule</button>
        <button type="button" className="min-h-11 underline" onClick={() => setRevision(value => value + 1)}>Refresh linked appointment</button>
      </div>
      <WorkdayDisclosure title="Visit work"><VisitWorkPanel organizationId={organizationId} appointmentId={appointmentId} scopeKey={scopeKey} onCompleted={work => {
        // This is the validated atomic mutation result, not optimistic status.
        // Keep the panel mounted so its immutable completion remains visible.
        if (work.organizationId !== organizationId || work.appointment.id !== appointmentId || work.appointment.status !== 'completed' || work.completion?.appointmentId !== appointmentId) return;
        setDetail(current => current && current.organizationId === organizationId && current.appointment.id === appointmentId
          ? { ...current, appointment: { ...current.appointment, status: work.appointment.status, updatedAt: work.appointment.updatedAt } } : current);
        onWorkCompleted?.();
      }} /></WorkdayDisclosure>
    </>}
  </section>;
}
