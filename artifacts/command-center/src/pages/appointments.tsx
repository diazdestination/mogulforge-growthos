import { useEffect, useRef, useState } from 'react';
import { useListAppointments, useCreateAppointment, useUpdateAppointment, getListAppointmentsQueryKey, AppointmentStatus, AppointmentType, useListUsers, useGetInspectionAvailability } from '@workspace/api-client-react';
import LeadSelect from '@/components/lead-select';
import ContactSelect from '@/components/contact-select';
import { Loader2, Plus, Calendar, Clock, Edit, AlertTriangle, X } from 'lucide-react';
import { getInspectionAvailabilityWarning } from '@workspace/inspection-availability';
import { canWrite } from '@/lib/permissions';
import { useGetMe } from '@workspace/api-client-react';
import { format } from 'date-fns';
import { updateAppointment as updateAppointmentRequest } from '@workspace/api-client-react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { toast as globalToast } from '@/hooks/use-toast';
import { ToastAction } from '@/components/ui/toast';
import { canAssignWork, localDateTime, scheduleTimezone } from '@/lib/contractor-schedule';

export default function Appointments() {
  const [date, setDate] = useState(() => localDateTime(new Date().toISOString()).slice(0, 10));
  const [days, setDays] = useState(7);
  const [assignedUserId, setAssignedUserId] = useState('');
  const { data: users } = useListUsers();
  const from = new Date(`${date || localDateTime(new Date().toISOString()).slice(0, 10)}T00:00`);
  const to = new Date(from); to.setDate(to.getDate() + days);
  const params = { leadId: undefined, from: from.toISOString(), to: to.toISOString(), assignedUserId: assignedUserId || undefined };
  const { data: appointments, isLoading, isError, refetch } = useListAppointments(params);
  const { data: me } = useGetMe();
  const queryClient = useQueryClient();
  
  const canEdit = canWrite(me?.role);

  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingAppt, setEditingAppt] = useState<any>(null);

  const openEdit = (appt: any) => {
    setEditingAppt(appt);
    setIsFormOpen(true);
  };

  const openCreate = () => {
    setEditingAppt(null);
    setIsFormOpen(true);
  };

  const updateAppt = useUpdateAppointment();

  const handleStatusChange = (id: string, status: AppointmentStatus) => {
    if(!canEdit) return;
    const original = appointments?.find(appointment => appointment.id === id);
    updateAppt.mutate({ id, data: { status, ...(original?.updatedAt ? { expectedUpdatedAt: original.updatedAt } : {}) } }, {
      onSuccess: () => queryClient.invalidateQueries({ queryKey: getListAppointmentsQueryKey() }),
      onError: () => { void refetch(); showApptStatusFailedToast(id, status, queryClient, original?.updatedAt); },
    });
  }

  // Sort by date ascending (upcoming first)
  const sortedAppts = [...(appointments || [])].sort((a,b) => new Date(a.scheduledStart).getTime() - new Date(b.scheduledStart).getTime());

  return (
    <div className="flex flex-col h-full bg-background overflow-hidden">
      <header className="px-4 py-3 md:px-6 md:py-4 border-b border-border flex items-center justify-between bg-card shrink-0 gap-4 sticky top-0 z-10">
        <div>
          <h1 className="text-xl md:text-2xl font-bold tracking-tight text-foreground">Appointments</h1>
          <p className="hidden md:block text-sm text-slate-600 dark:text-slate-300">Inspections and meetings.</p>
        </div>
        <div>
          {canEdit && (
            <button aria-label="Schedule appointment" data-testid="add-appointment" onClick={openCreate} className="bg-primary text-primary-foreground dark:text-slate-950 hover:bg-primary/90 px-4 py-2.5 md:px-3 md:py-2 rounded-xl text-sm font-semibold flex items-center gap-2 transition-transform active:scale-95 shadow-sm shadow-primary/20">
              <Plus className="w-4 h-4" /> <span className="hidden md:inline">Schedule</span>
            </button>
          )}
        </div>
      </header>

      <div className="flex-1 overflow-auto p-4 md:p-6 pb-20 md:pb-6">
        <div className="mx-auto mb-5 max-w-5xl space-y-2">
          <div className="flex flex-wrap items-end gap-3">
            <label className="min-w-0 text-sm">Start date<input type="date" className="block min-h-11 max-w-full rounded-lg border bg-background p-2 text-base" value={date} onChange={event => setDate(event.target.value)} /></label>
            <label className="text-sm">Show<select className="block min-h-11 rounded-lg border bg-background p-2 text-base" value={days} onChange={event => setDays(Number(event.target.value))}><option value={1}>One day</option><option value={7}>One week</option><option value={30}>30 days</option></select></label>
            <label className="min-w-0 text-sm">Team member<select className="block min-h-11 max-w-full rounded-lg border bg-background p-2 text-base" value={assignedUserId} onChange={event => setAssignedUserId(event.target.value)}><option value="">All team members</option>{users?.filter(canAssignWork).map(user => <option key={user.id} value={user.id}>{`${user.firstName ?? ''} ${user.lastName ?? ''}`.trim() || user.email}</option>)}</select></label>
          </div>
          <p className="text-sm text-slate-600 dark:text-slate-300">Times shown in {scheduleTimezone}. Office confirmation is required for website requests.</p>
          {(appointments?.length ?? 0) >= 200 && <p role="status" className="text-sm">Showing the first 200 appointments. Narrow the date range or choose a team member to see all results.</p>}
        </div>
        {isError ? <div role="alert" className="mx-auto max-w-5xl rounded-lg border p-4">Appointments could not be loaded. <button className="underline" onClick={() => void refetch()}>Try again</button></div> :
        isLoading ? (
          <div className="flex items-center justify-center py-12 h-full">
            <Loader2 className="w-8 h-8 animate-spin text-primary" />
          </div>
        ) : (
          <div className="space-y-4 max-w-5xl mx-auto w-full">
            {sortedAppts.map(appt => {
              const date = new Date(appt.scheduledStart);
              const isPast = date < new Date() && appt.status === 'scheduled';
              return (
                <div key={appt.id} className="bg-card border border-border rounded-2xl p-4 md:p-5 shadow-sm flex flex-col md:flex-row gap-4 md:gap-6 hover:shadow-md transition-all relative group">
                  
                  {/* Date Block */}
                  <div className="flex flex-row md:flex-col items-center justify-between md:justify-center w-full md:w-28 shrink-0 bg-muted/30 rounded-xl py-3 px-4 md:px-0 border border-border/50">
                    <div className="flex flex-col items-center md:items-center">
                       <span className="text-[10px] md:text-xs uppercase tracking-widest font-bold text-primary">{format(date, 'MMM')}</span>
                       <span className="text-2xl md:text-4xl font-bold text-foreground leading-none my-0.5">{format(date, 'dd')}</span>
                    </div>
                    <span className="text-xs md:text-[11px] font-mono font-bold text-slate-600 dark:text-slate-300 bg-background px-2 py-1 rounded-md border border-border/50 shadow-sm">{format(date, 'h:mm a')}</span>
                  </div>

                  {/* Details */}
                  <div className="flex-1 min-w-0">
                    <div className="flex flex-wrap items-center gap-2 md:gap-3 mb-2.5">
                      <span className={`px-2.5 py-1 rounded-md text-[10px] font-bold uppercase tracking-widest ${
                        appt.type === 'inspection' ? 'bg-blue-500/15 text-blue-600 dark:text-blue-400' :
                        appt.type === 'production' ? 'bg-secondary/15 text-secondary dark:text-secondary' :
                        'bg-primary/10 text-primary'
                      }`}>
                        {appt.type.replace('_', ' ')}
                      </span>
                      {isPast && (
                        <span className="text-[10px] font-bold uppercase tracking-widest bg-destructive/10 text-destructive px-2.5 py-1 rounded-md flex items-center gap-1">
                          <Clock className="w-3 h-3"/> Overdue
                        </span>
                      )}
                    </div>
                    
                    {appt.notes ? (
                       <p className="text-[15px] text-foreground font-medium mb-4 leading-snug">{appt.notes}</p>
                    ) : (
                       <p className="text-sm text-slate-600 dark:text-slate-300 italic mb-4">No notes provided.</p>
                    )}
                    
                    <div className="flex flex-col sm:flex-row gap-2 sm:gap-4 text-[11px] font-mono text-slate-600 dark:text-slate-300 bg-muted/20 p-2.5 rounded-lg border border-border/50">
                      {appt.leadId && <span className="flex items-center gap-1.5"><div className="w-1 h-1 rounded-full bg-primary" /> Lead: {appt.leadId.substring(0,8)}</span>}
                      {appt.assignedUserId && <span className="flex items-center gap-1.5">Assigned: {users?.find(user => user.id === appt.assignedUserId)?.firstName || 'Team member'}</span>}
                    </div>
                  </div>

                  {/* Actions */}
                  <div className="flex flex-row md:flex-col items-center md:items-end justify-between md:justify-start gap-3 shrink-0 mt-2 md:mt-0 pt-3 md:pt-0 border-t md:border-t-0 border-border">
                    {canEdit ? (
                      <select 
                        data-testid="appointment-status-select"
                        className={`text-[10px] md:text-xs rounded-lg py-2 md:py-1.5 px-3 md:px-2 font-bold uppercase tracking-widest appearance-none cursor-pointer focus:outline-none focus:ring-2 focus:ring-primary shadow-sm bg-[url('data:image/svg+xml;charset=US-ASCII,%3Csvg%20width%3D%2224%22%20height%3D%2224%22%20fill%3D%22none%22%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%3E%3Cpath%20d%3D%22M7%2010L12%2015L17%2010%22%20stroke%3D%22%236B7280%22%20stroke-width%3D%222%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%2F%3E%3C%2Fsvg%3E')] bg-[position:right_0.25rem_center] bg-no-repeat pr-8 ${
                          appt.status === 'completed' ? 'bg-green-500/15 text-green-700 dark:text-green-400 border border-green-500/30' :
                          appt.status === 'cancelled' || appt.status === 'no_show' ? 'bg-destructive/15 text-destructive border border-destructive/30' :
                          'bg-background border border-border text-foreground'
                        }`}
                        aria-label="Appointment status" value={appt.status}
                        onChange={(e) => handleStatusChange(appt.id, e.target.value as AppointmentStatus)}
                      >
                        <option value="scheduled">Scheduled</option>
                        <option value="confirmed">Confirmed</option>
                        <option value="completed">Completed</option>
                        <option value="no_show">No Show</option>
                        <option value="cancelled">Cancelled</option>
                      </select>
                    ) : (
                      <span className="text-[10px] font-bold uppercase tracking-widest text-slate-600 dark:text-slate-300 bg-muted/50 px-3 py-1.5 rounded-lg border border-border">{appt.status.replace('_', ' ')}</span>
                    )}
                    
                    {canEdit && (
                      <button data-testid="edit-appointment" aria-label="Edit appointment" onClick={() => openEdit(appt)} className="md:opacity-0 md:group-hover:opacity-100 w-10 h-10 md:w-8 md:h-8 flex items-center justify-center text-slate-600 dark:text-slate-300 hover:text-primary transition-all rounded-full hover:bg-muted md:mt-auto active:scale-95 bg-muted/50 md:bg-transparent border border-border md:border-none shadow-sm md:shadow-none">
                        <Edit className="w-4 h-4 md:w-4 md:h-4" />
                      </button>
                    )}
                  </div>

                </div>
              );
            })}
            {!sortedAppts.length && (
              <div className="py-12 text-center text-slate-600 dark:text-slate-300 border-2 border-dashed border-border rounded-2xl bg-muted/10">
                No appointments scheduled.
              </div>
            )}
          </div>
        )}
      </div>

      {isFormOpen && (
        <ApptFormModal 
          appt={editingAppt} 
          onClose={() => setIsFormOpen(false)} 
        />
      )}
    </div>
  );
}

/**
 * Error toast with a Retry action for the one-shot appointment status change.
 * Module level (global toast store + plain fetch client) so retrying keeps
 * working across re-renders — same pattern as pipeline.tsx.
 */
function showApptStatusFailedToast(apptId: string, status: AppointmentStatus, queryClient: QueryClient, expectedUpdatedAt?: string) {
  const { dismiss } = globalToast({
    variant: 'destructive',
    title: 'Appointment not updated',
    description: `Marking the appointment "${status.replace(/_/g, ' ')}" failed. Retry below.`,
    action: (
      <ToastAction
        altText="Retry appointment status update"
        onClick={async () => {
          try {
            await updateAppointmentRequest(apptId, { status, ...(expectedUpdatedAt ? { expectedUpdatedAt } : {}) });
            queryClient.invalidateQueries({ queryKey: getListAppointmentsQueryKey() });
            dismiss();
          } catch {
            showApptStatusFailedToast(apptId, status, queryClient, expectedUpdatedAt);
          }
        }}
      >
        Retry
      </ToastAction>
    ),
  });
}
function ApptFormModal({ appt, onClose }: { appt?: any, onClose: () => void }) {
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    panel.current?.querySelector<HTMLElement>('select, input, button')?.focus();
    return () => previous?.focus();
  }, []);
  const [type, setType] = useState<AppointmentType>(appt?.type || 'inspection');
  const [status, setStatus] = useState<AppointmentStatus>(appt?.status || 'scheduled');
  
  // datetime-local input requires YYYY-MM-DDTHH:mm format
  const [start, setStart] = useState(localDateTime(appt?.scheduledStart));
  const [end, setEnd] = useState(localDateTime(appt?.scheduledEnd));
  const [notes, setNotes] = useState(appt?.notes || '');
  const [leadId, setLeadId] = useState(appt?.leadId || '');
  const [contactId, setContactId] = useState(appt?.contactId || '');
  const [assigneeId, setAssigneeId] = useState(appt?.assignedUserId || '');
  
  const { data: users } = useListUsers();
  const createAppt = useCreateAppointment();
  const updateAppt = useUpdateAppointment();
  const queryClient = useQueryClient();

  const isSubmitting = createAppt.isPending || updateAppt.isPending;
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Same availability source admins configure for concierge chat bookings —
  // warn (without blocking) when a manual inspection falls outside it.
  const { data: availability } = useGetInspectionAvailability();
  const availabilityWarning =
    type === 'inspection' && start && availability
      ? getInspectionAvailabilityWarning(new Date(start), availability)
      : null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!start) return;
    setSubmitError(null);
    if (end && new Date(end) <= new Date(start)) { setSubmitError('Set an end time after the start time.'); return; }

    // Mirror the server's guard (60s grace) so reps get instant feedback:
    // active appointments can't be scheduled at a time that already passed.
    if (
      (status === 'scheduled' || status === 'confirmed') &&
      new Date(start).getTime() < Date.now() - 60_000
    ) {
      setSubmitError('That start time has already passed. Pick a time in the future.');
      return;
    }

    const data = {
      type,
      status,
      scheduledStart: new Date(start).toISOString(),
      scheduledEnd: end ? new Date(end).toISOString() : new Date(new Date(start).getTime() + 2 * 3_600_000).toISOString(),
      notes: notes || (appt ? null : undefined),
      leadId: leadId || (appt ? null : undefined),
      contactId: contactId || (appt ? null : undefined),
      assignedUserId: assigneeId || (appt ? null : undefined),
      ...(appt?.updatedAt ? { expectedUpdatedAt: appt.updatedAt } : {}),
    };

    if (appt) {
      updateAppt.mutate({ id: appt.id, data }, {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListAppointmentsQueryKey() });
          onClose();
        },
        onError: (error: any) => {
          if (error?.status === 409) {
            setSubmitError(error?.data?.error || 'That inspection window is already fully booked. Pick another time.');
          } else {
            setSubmitError(error?.data?.error || 'Could not save the appointment. Please try again.');
          }
        }
      });
    } else {
      createAppt.mutate({ data: { ...data, notes: notes || undefined, leadId: leadId || undefined, contactId: contactId || undefined, assignedUserId: assigneeId || undefined } }, {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListAppointmentsQueryKey() });
          onClose();
        },
        onError: (error: any) => {
          if (error?.status === 409) {
            setSubmitError(error?.data?.error || 'That inspection window is already fully booked. Pick another time.');
          } else {
            setSubmitError(error?.data?.error || 'Could not save the appointment. Please try again.');
          }
        }
      });
    }
  };

  return (
    <div className="fixed inset-0 bg-background/90 backdrop-blur-sm z-50 flex items-end md:items-center justify-center p-0 md:p-4 animate-in fade-in duration-200 overflow-y-auto">
      <div ref={panel} role="dialog" aria-modal="true" aria-labelledby="appointment-form-title" onKeyDown={event => {
        if (event.key === 'Escape') onClose();
        if (event.key !== 'Tab') return;
        const controls = [...(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled)') ?? [])];
        if (event.shiftKey && document.activeElement === controls[0]) { event.preventDefault(); controls.at(-1)?.focus(); }
        else if (!event.shiftKey && document.activeElement === controls.at(-1)) { event.preventDefault(); controls[0]?.focus(); }
      }} className="bg-card border-t md:border border-border shadow-2xl md:rounded-2xl rounded-t-2xl w-full max-w-md overflow-hidden mt-auto md:my-auto animate-in slide-in-from-bottom-8 md:slide-in-from-bottom-0 md:zoom-in-95 duration-300 pb-safe md:pb-0">
        <div className="p-4 md:p-6 border-b border-border flex justify-between items-center bg-muted/20">
          <h2 id="appointment-form-title" className="text-lg font-bold text-foreground">{appt ? 'Edit Appointment' : 'New Appointment'}</h2>
          <button onClick={onClose} aria-label="Close" className="w-8 h-8 flex items-center justify-center rounded-full bg-muted text-slate-600 dark:text-slate-300 hover:bg-muted/80 hover:text-foreground active:scale-95 transition-all">
             <X className="w-4 h-4" />
          </button>
        </div>
        <form onSubmit={handleSubmit} className="p-4 md:p-6 space-y-4 md:space-y-5">
          
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label className="text-[10px] md:text-xs font-bold text-slate-600 dark:text-slate-300 uppercase tracking-widest">Type</label>
              <select className="w-full bg-background border border-border rounded-xl px-4 py-3 md:py-2.5 text-base md:text-sm focus:ring-2 focus:ring-primary focus:outline-none shadow-sm transition-all appearance-none bg-[url('data:image/svg+xml;charset=US-ASCII,%3Csvg%20width%3D%2224%22%20height%3D%2224%22%20fill%3D%22none%22%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%3E%3Cpath%20d%3D%22M7%2010L12%2015L17%2010%22%20stroke%3D%22%236B7280%22%20stroke-width%3D%222%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%2F%3E%3C%2Fsvg%3E')] bg-[position:right_0.5rem_center] bg-no-repeat pr-10" aria-label="Appointment type" value={type} onChange={e => setType(e.target.value as AppointmentType)}>
                <option value="inspection">Inspection</option>
                <option value="estimate_review">Estimate Review</option>
                <option value="production">Production</option>
                <option value="final_walkthrough">Final Walkthrough</option>
                <option value="other">Other</option>
              </select>
            </div>
            {appt && (
              <div className="space-y-1.5">
                <label className="text-[10px] md:text-xs font-bold text-slate-600 dark:text-slate-300 uppercase tracking-widest">Status</label>
                <select className="w-full bg-background border border-border rounded-xl px-4 py-3 md:py-2.5 text-base md:text-sm focus:ring-2 focus:ring-primary focus:outline-none shadow-sm transition-all appearance-none bg-[url('data:image/svg+xml;charset=US-ASCII,%3Csvg%20width%3D%2224%22%20height%3D%2224%22%20fill%3D%22none%22%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%3E%3Cpath%20d%3D%22M7%2010L12%2015L17%2010%22%20stroke%3D%22%236B7280%22%20stroke-width%3D%222%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%2F%3E%3C%2Fsvg%3E')] bg-[position:right_0.5rem_center] bg-no-repeat pr-10" aria-label="Appointment status" value={status} onChange={e => setStatus(e.target.value as AppointmentStatus)}>
                  <option value="scheduled">Scheduled</option>
                  <option value="confirmed">Confirmed</option>
                  <option value="completed">Completed</option>
                  <option value="no_show">No Show</option>
                  <option value="cancelled">Cancelled</option>
                </select>
              </div>
            )}
          </div>

          <div className="space-y-1.5">
            <label className="text-[10px] md:text-xs font-bold text-slate-600 dark:text-slate-300 uppercase tracking-widest">Start Time *</label>
            <input aria-label="Start time" required type="datetime-local" className="w-full bg-background border border-border rounded-xl px-4 py-3 md:py-2.5 text-base md:text-sm focus:ring-2 focus:ring-primary focus:outline-none font-mono shadow-sm transition-all" value={start} onChange={e => setStart(e.target.value)} />
            {availabilityWarning && (
              <div data-testid="availability-warning" className="flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-[13px] font-medium text-amber-800 dark:text-amber-400 mt-2">
                <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-amber-500" />
                <span>{availabilityWarning} You can still save it, but the crew may not be able to honor this slot.</span>
              </div>
            )}
          </div>
          <label className="block space-y-1.5 text-sm">End time<input aria-label="End time" type="datetime-local" className="block min-h-11 w-full min-w-0 rounded-xl border bg-background p-3 text-base" value={end} onChange={event => setEnd(event.target.value)} /><span className="block text-sm text-slate-600 dark:text-slate-300">Times use {scheduleTimezone}. A new appointment without an end uses a two-hour window.</span></label>

          <div className="space-y-1.5">
            <label className="text-[10px] md:text-xs font-bold text-slate-600 dark:text-slate-300 uppercase tracking-widest">Assignee</label>
            <select className="w-full bg-background border border-border rounded-xl px-4 py-3 md:py-2.5 text-base md:text-sm focus:ring-2 focus:ring-primary focus:outline-none shadow-sm transition-all appearance-none bg-[url('data:image/svg+xml;charset=US-ASCII,%3Csvg%20width%3D%2224%22%20height%3D%2224%22%20fill%3D%22none%22%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%3E%3Cpath%20d%3D%22M7%2010L12%2015L17%2010%22%20stroke%3D%22%236B7280%22%20stroke-width%3D%222%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%2F%3E%3C%2Fsvg%3E')] bg-[position:right_0.5rem_center] bg-no-repeat pr-10" aria-label="Assignee" value={assigneeId} onChange={e => setAssigneeId(e.target.value)}>
              <option value="">-- Unassigned --</option>
              {users?.filter(canAssignWork).map(u => (
                <option key={u.id} value={u.id}>{u.firstName} {u.lastName}</option>
              ))}
            </select>
          </div>

          <div className="space-y-1.5"><label className="block text-sm font-medium">Customer<ContactSelect value={contactId} onChange={setContactId} testId="appointment-contact" /></label><p className="text-sm text-slate-600 dark:text-slate-300">Choose a customer for a service visit. A related opportunity is optional.</p></div>
          <label className="block space-y-1.5">
            <span className="text-[10px] md:text-xs font-bold text-slate-600 dark:text-slate-300 uppercase tracking-widest">Related Lead</span>
            <div className="shadow-sm rounded-xl overflow-hidden">
               <LeadSelect value={leadId} onChange={setLeadId} />
            </div>
          </label>
          
          <div className="space-y-1.5">
            <label className="text-[10px] md:text-xs font-bold text-slate-600 dark:text-slate-300 uppercase tracking-widest">Notes</label>
            <textarea className="w-full bg-background border border-border rounded-xl px-4 py-3 md:py-2.5 text-base md:text-sm focus:ring-2 focus:ring-primary focus:outline-none min-h-[80px] resize-none shadow-sm transition-all" aria-label="Appointment notes" value={notes} onChange={e => setNotes(e.target.value)} />
          </div>
          
          {submitError && (
            <div className="text-[13px] font-medium text-destructive bg-destructive/10 border border-destructive/20 rounded-xl px-4 py-3 flex items-start gap-2" role="alert">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{submitError}</span>
            </div>
          )}

          <div className="pt-6 md:pt-4 flex flex-col-reverse md:flex-row justify-end gap-3">
            <button type="button" onClick={onClose} className="w-full md:w-auto px-4 py-3 md:py-2 text-base md:text-sm font-semibold hover:bg-muted rounded-xl border border-transparent hover:border-border transition-all active:scale-95">Cancel</button>
            <button type="submit" disabled={isSubmitting} className="w-full md:w-auto bg-primary text-primary-foreground dark:text-slate-950 px-6 py-3 md:py-2 rounded-xl text-base md:text-sm font-bold shadow-sm shadow-primary/20 hover:shadow-primary/40 hover:bg-primary/90 transition-all active:scale-95 disabled:opacity-50 flex items-center justify-center min-w-[120px]">
              {isSubmitting ? <Loader2 className="w-5 h-5 animate-spin" /> : 'Save Appt'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
