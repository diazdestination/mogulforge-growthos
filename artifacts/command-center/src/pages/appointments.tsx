import { useEffect, useRef, useState } from 'react';
import {
  useListAppointments,
  createAppointment,
  useUpdateAppointment,
  getListAppointmentsQueryKey,
  AppointmentStatus,
  AppointmentType,
  useListUsers,
  getListUsersQueryKey,
  type Appointment,
  type MemberProfile,
} from '@workspace/api-client-react';
import { Link, useSearch } from 'wouter';
import LeadSelect from '@/components/lead-select';
import ContactSelect from '@/components/contact-select';
import CustomerPropertySelect from '@/components/customer-property-select';
import AppointmentLinkedCard from '@/components/appointment-linked-card';
import { Loader2, Plus, Clock, Edit, X } from 'lucide-react';
import { getInspectionAvailabilityWarning } from '@workspace/inspection-availability';
import { canWrite } from '@/lib/permissions';
import { useGetMe } from '@workspace/api-client-react';
import {
  companyDayBounds,
  formatSchedulingWallTime,
  classifyReservationTransition,
  manualSourceRefSchema,
  reservationSnapshotSchema,
  schedulingReviewContextSchema,
  type ManualSourceRef,
  type SchedulingCandidate,
} from '@workspace/scheduling-core';
import {
  getSchedulingReviewContext,
  getSchedulingPolicy,
  reconcileSchedulingOperation,
} from '@workspace/api-client-react';
import { SchedulingIntervalFields } from '@/components/scheduling-interval-fields';
import { SchedulingIntervalReview } from '@/components/scheduling-interval-review';
import { SchedulingReservationSummary } from '@/components/scheduling-reservation-summary';
import {
  useSchedulingAuthority,
  useSchedulingContext,
  useSchedulingReview,
} from '@/hooks/use-scheduling-review';
import { useManualSchedulingCommand } from '@/hooks/use-manual-scheduling-command';
import {
  manualSchedulingSourceKey,
  parseManualSchedulingCustody,
  buildSchedulingProposalView,
} from '@/lib/scheduling-command';
import type {
  IntervalInput,
  SchedulingDraft,
} from '@/lib/scheduling-ui-contract';
import { useQueryClient } from '@tanstack/react-query';
import { canAssignWork } from '@/lib/contractor-schedule';
import { memberAuthorityScope } from '@/lib/member-authority-scope';

export default function Appointments() {
  const profile = useGetMe();
  if (profile.isError)
    return (
      <div role="alert" className="p-4">
        Company access could not be verified. Appointment controls are
        unavailable until access is checked again.{' '}
        <button
          className="min-h-11 underline"
          onClick={() => void profile.refetch()}
        >
          Check appointment access
        </button>
      </div>
    );
  if (profile.isLoading)
    return (
      <p role="status" className="p-4">
        Confirming company access before opening appointments…
      </p>
    );
  if (!profile.data?.isActive || !profile.data.organization)
    return (
      <p role="alert" className="p-4">
        Active company access is required to open appointments.
      </p>
    );
  const scopeKey = memberAuthorityScope(profile.data);
  return (
    <AppointmentsContent key={scopeKey} me={profile.data} scopeKey={scopeKey} />
  );
}

function AppointmentsContent({
  me,
  scopeKey,
}: {
  me: MemberProfile;
  scopeKey: string;
}) {
  const [date, setDate] = useState(() =>
    companyDate(new Date().toISOString(), me.organization!.timezone),
  );
  const [days, setDays] = useState(7);
  const [assignedUserId, setAssignedUserId] = useState('');
  const { data: users } = useListUsers({
    query: { queryKey: [...getListUsersQueryKey(), scopeKey] },
  });
  const zone = me.organization!.timezone;
  let bounds: { from: string; to: string } | null = null;
  try {
    const first = companyDayBounds(date, zone);
    let last = first;
    for (let index = 1; index < days; index++)
      last = companyDayBounds(companyDate(last.to, zone), zone);
    bounds = { from: first.from, to: last.to };
  } catch {
    /* Missing company zone/date holds the range instead of guessing browser time. */
  }
  const params = {
    leadId: undefined,
    from: bounds?.from,
    to: bounds?.to,
    assignedUserId: assignedUserId || undefined,
  };
  const {
    data: appointments,
    isLoading,
    isError,
    refetch,
  } = useListAppointments(params, {
    query: {
      queryKey: [...getListAppointmentsQueryKey(params), scopeKey, zone],
      enabled: bounds !== null,
    },
  });
  const queryClient = useQueryClient();
  const search = useSearch();
  const viewKey = JSON.stringify([search, date, days, assignedUserId]);
  const currentView = useRef(viewKey);
  currentView.current = viewKey;
  const [linkedRevision, setLinkedRevision] = useState(0);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const canEdit = canWrite(me?.role);

  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingAppt, setEditingAppt] = useState<Appointment | null>(null);
  const [statusReview, setStatusReview] = useState<{
    id: string;
    status: AppointmentStatus;
  } | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [reviewError, setReviewError] = useState('');
  useEffect(() => {
    setIsFormOpen(false);
    setEditingAppt(null);
    setStatusReview(null);
    setReviewError('');
    setReviewing(false);
  }, [viewKey]);

  const openEdit = (appt: Appointment) => {
    setEditingAppt(appt);
    setIsFormOpen(true);
  };

  const openCreate = () => {
    setEditingAppt(null);
    setIsFormOpen(true);
  };

  const updateAppt = useUpdateAppointment();

  const handleStatusChange = (id: string, status: AppointmentStatus) => {
    if (!canEdit || statusReview || updateAppt.isPending) return;
    const original = appointments?.find((appointment) => appointment.id === id);
    updateAppt.mutate(
      {
        id,
        data: {
          status,
          ...(original?.updatedAt
            ? { expectedUpdatedAt: original.updatedAt }
            : {}),
        },
      },
      {
        onSuccess: () => {
          if (alive.current) setLinkedRevision((value) => value + 1);
          return queryClient.invalidateQueries({
            queryKey: getListAppointmentsQueryKey(),
          });
        },
        onError: () => {
          if (alive.current && currentView.current === viewKey) {
            setReviewError('');
            setStatusReview({ id, status });
          }
        },
      },
    );
  };

  async function reviewStatusChange() {
    if (!statusReview || !canEdit || reviewing) return;
    setReviewing(true);
    setReviewError('');
    try {
      const result = await refetch();
      if (!alive.current || currentView.current !== viewKey) return;
      if (result.isError)
        throw new Error(
          'The current appointment could not be loaded. No change has been retried.',
        );
      const current = result.data?.find(
        (appointment) => appointment.id === statusReview.id,
      );
      if (!current)
        throw new Error(
          'This appointment is not in the selected range. Adjust the date or team filter, then refresh and review again. No change has been retried.',
        );
      // Review the actual saved record, not the earlier desired status. A lost
      // acknowledgement may already have committed that command.
      setEditingAppt(current);
      setIsFormOpen(true);
      setStatusReview(null);
    } catch (error) {
      if (alive.current && currentView.current === viewKey)
        setReviewError(
          error instanceof Error
            ? error.message
            : 'Refresh failed. No change has been retried.',
        );
    } finally {
      if (alive.current && currentView.current === viewKey) setReviewing(false);
    }
  }

  // Sort by date ascending (upcoming first)
  const sortedAppts = [...(appointments || [])].sort(
    (a, b) =>
      new Date(a.scheduledStart).getTime() -
      new Date(b.scheduledStart).getTime(),
  );
  const selectedParams = new URLSearchParams(search);
  const selectedNative =
    !isError && selectedParams.get('organizationId') === me.organization!.id
      ? appointments?.find(
          (appointment) =>
            appointment.id === selectedParams.get('appointmentId') &&
            appointment.organizationId === me.organization!.id,
        )
      : undefined;
  const selectedReservation = selectedNative?.updatedAt
    ? {
        appointmentId: selectedNative.id,
        updatedAt: selectedNative.updatedAt,
        interval: appointmentInterval(selectedNative),
        resources: (users ?? [])
          .filter(canAssignWork)
          .map((user) => ({
            id: user.id,
            label:
              [user.firstName, user.lastName].filter(Boolean).join(' ') ||
              user.email ||
              user.id,
          })),
      }
    : null;

  return (
    <div className="flex flex-col h-full bg-background overflow-hidden">
      <header className="px-4 py-3 md:px-6 md:py-4 border-b border-border flex items-center justify-between bg-card shrink-0 gap-4 sticky top-0 z-10">
        <div>
          <h1 className="text-xl md:text-2xl font-bold tracking-tight text-foreground">
            Appointments
          </h1>
          <p className="hidden md:block text-sm text-slate-600 dark:text-slate-300">
            Inspections and meetings.
          </p>
        </div>
        <div>
          {canEdit && (
            <button
              aria-label="Schedule appointment"
              data-testid="add-appointment"
              onClick={openCreate}
              className="bg-primary text-primary-foreground dark:text-slate-950 hover:bg-primary/90 px-4 py-2.5 md:px-3 md:py-2 rounded-xl text-sm font-semibold flex items-center gap-2 transition-transform active:scale-95 shadow-sm shadow-primary/20"
            >
              <Plus className="w-4 h-4" />{' '}
              <span className="hidden md:inline">Schedule</span>
            </button>
          )}
        </div>
      </header>

      <div className="flex-1 overflow-auto p-4 md:p-6 pb-20 md:pb-6">
        <AppointmentLinkedCard
          companyTimeZone={zone}
          reservationView={selectedReservation}
          search={search}
          organizationId={me.organization!.id}
          scopeKey={scopeKey}
          refreshKey={linkedRevision}
          onShowDay={(start) => {
            setDate(companyDate(start, zone));
            setDays(1);
            setAssignedUserId('');
          }}
          onWorkCompleted={() => {
            if (alive.current)
              void queryClient.invalidateQueries({
                queryKey: [
                  ...getListAppointmentsQueryKey(params),
                  scopeKey,
                  zone,
                ],
                exact: true,
              });
          }}
        />
        {statusReview && (
          <div
            role="alert"
            className="mx-auto mb-5 max-w-5xl space-y-2 rounded-lg border border-destructive p-4"
          >
            <p className="font-semibold">Appointment update needs review</p>
            <p className="text-sm">
              The requested change to {statusReview.status.replaceAll('_', ' ')}{' '}
              was not confirmed. It may already have saved, or another team
              member may have changed the record. Review the current appointment
              before deciding what to do next. No change is retried
              automatically.
            </p>
            {statusReview.status === 'completed' && (
              <p className="text-sm">
                Visits with required structured work must be completed through
                their reviewed work record.{' '}
                <Link
                  className="inline-flex min-h-11 items-center underline"
                  href={`/appointments?appointmentId=${statusReview.id}&organizationId=${me.organization!.id}`}
                >
                  Open visit work
                </Link>
              </p>
            )}
            {reviewError && <p className="text-sm">{reviewError}</p>}
            {canEdit && (
              <button
                type="button"
                disabled={reviewing}
                className="min-h-11 rounded border px-3 py-2 text-sm disabled:opacity-50"
                onClick={() => void reviewStatusChange()}
              >
                Refresh and review appointment
              </button>
            )}
          </div>
        )}
        <div className="mx-auto mb-5 max-w-5xl space-y-2">
          <div className="flex flex-wrap items-end gap-3">
            <label className="min-w-0 text-sm">
              Start date
              <input
                type="date"
                className="block min-h-11 max-w-full rounded-lg border bg-background p-2 text-base"
                value={date}
                onChange={(event) => setDate(event.target.value)}
              />
            </label>
            <label className="text-sm">
              Show
              <select
                className="block min-h-11 rounded-lg border bg-background p-2 text-base"
                value={days}
                onChange={(event) => setDays(Number(event.target.value))}
              >
                <option value={1}>One day</option>
                <option value={7}>One week</option>
                <option value={30}>30 days</option>
              </select>
            </label>
            <label className="min-w-0 text-sm">
              Team member
              <select
                className="block min-h-11 max-w-full rounded-lg border bg-background p-2 text-base"
                value={assignedUserId}
                onChange={(event) => setAssignedUserId(event.target.value)}
              >
                <option value="">All team members</option>
                {users?.filter(canAssignWork).map((user) => (
                  <option key={user.id} value={user.id}>
                    {`${user.firstName ?? ''} ${user.lastName ?? ''}`.trim() ||
                      user.email}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <p className="text-sm text-slate-600 dark:text-slate-300">
            Times shown in {zone}. Office confirmation is required for website
            requests.
          </p>
          {(appointments?.length ?? 0) >= 200 && (
            <p role="status" className="text-sm">
              Showing the first 200 appointments. Narrow the date range or
              choose a team member to see all results.
            </p>
          )}
        </div>
        {isError ? (
          <div role="alert" className="mx-auto max-w-5xl rounded-lg border p-4">
            Appointments could not be loaded.{' '}
            <button className="underline" onClick={() => void refetch()}>
              Try again
            </button>
          </div>
        ) : isLoading ? (
          <div className="flex items-center justify-center py-12 h-full">
            <Loader2 className="w-8 h-8 animate-spin text-primary" />
          </div>
        ) : (
          <div className="space-y-4 max-w-5xl mx-auto w-full">
            {sortedAppts.map((appt) => {
              const date = new Date(appt.scheduledStart);
              const isPast = date < new Date() && appt.status === 'scheduled';
              return (
                <div
                  key={appt.id}
                  className="bg-card border border-border rounded-2xl p-4 md:p-5 shadow-sm flex flex-col md:flex-row gap-4 md:gap-6 hover:shadow-md transition-all relative group"
                >
                  {/* Date Block */}
                  <div className="flex flex-row md:flex-col items-center justify-between md:justify-center w-full md:w-28 shrink-0 bg-muted/30 rounded-xl py-3 px-4 md:px-0 border border-border/50">
                    <div className="flex flex-col items-center md:items-center">
                      <span className="text-[10px] md:text-xs uppercase tracking-widest font-bold text-primary">
                        {companyLabel(appt.scheduledStart, zone, {
                          month: 'short',
                        })}
                      </span>
                      <span className="text-2xl md:text-4xl font-bold text-foreground leading-none my-0.5">
                        {companyLabel(appt.scheduledStart, zone, {
                          day: '2-digit',
                        })}
                      </span>
                    </div>
                    <span className="text-xs md:text-[11px] font-mono font-bold text-slate-600 dark:text-slate-300 bg-background px-2 py-1 rounded-md border border-border/50 shadow-sm">
                      {companyLabel(appt.scheduledStart, zone, {
                        hour: 'numeric',
                        minute: '2-digit',
                        timeZoneName: 'longOffset',
                      })}
                    </span>
                  </div>

                  {/* Details */}
                  <div className="flex-1 min-w-0">
                    <p className="mb-2 break-words text-base font-semibold">
                      {appt.leadLabel || 'Customer not recorded'}
                    </p>
                    <div className="flex flex-wrap items-center gap-2 md:gap-3 mb-2.5">
                      <span
                        className={`px-2.5 py-1 rounded-md text-[10px] font-bold uppercase tracking-widest ${
                          appt.type === 'inspection'
                            ? 'bg-blue-500/15 text-blue-600 dark:text-blue-400'
                            : appt.type === 'production'
                              ? 'bg-secondary/15 text-secondary dark:text-secondary'
                              : 'bg-primary/10 text-primary'
                        }`}
                      >
                        {appt.type.replace('_', ' ')}
                      </span>
                      {isPast && (
                        <span className="text-[10px] font-bold uppercase tracking-widest bg-destructive/10 text-destructive px-2.5 py-1 rounded-md flex items-center gap-1">
                          <Clock className="w-3 h-3" /> Overdue
                        </span>
                      )}
                    </div>

                    <SchedulingReservationSummary
                      companyTimeZone={zone}
                      interval={appointmentInterval(appt)}
                      proposal={null}
                      resources={[]}
                      conflict={null}
                    />
                    {appt.notes ? (
                      <p className="text-[15px] text-foreground font-medium mb-4 leading-snug">
                        {appt.notes}
                      </p>
                    ) : (
                      <p className="text-sm text-slate-600 dark:text-slate-300 italic mb-4">
                        No notes provided.
                      </p>
                    )}

                    <div className="flex flex-col sm:flex-row gap-2 sm:gap-4 text-[11px] font-mono text-slate-600 dark:text-slate-300 bg-muted/20 p-2.5 rounded-lg border border-border/50">
                      {appt.leadId && (
                        <span className="flex items-center gap-1.5">
                          <div className="w-1 h-1 rounded-full bg-primary" />{' '}
                          Lead: {appt.leadId.substring(0, 8)}
                        </span>
                      )}
                      {appt.assignedUserId && (
                        <span className="flex items-center gap-1.5">
                          Assigned:{' '}
                          {users?.find(
                            (user) => user.id === appt.assignedUserId,
                          )?.firstName || 'Team member'}
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Actions */}
                  <div className="flex flex-row md:flex-col items-center md:items-end justify-between md:justify-start gap-3 shrink-0 mt-2 md:mt-0 pt-3 md:pt-0 border-t md:border-t-0 border-border">
                    {canEdit ? (
                      <select
                        data-testid="appointment-status-select"
                        className={`text-[10px] md:text-xs rounded-lg py-2 md:py-1.5 px-3 md:px-2 font-bold uppercase tracking-widest appearance-none cursor-pointer focus:outline-none focus:ring-2 focus:ring-primary shadow-sm bg-[url('data:image/svg+xml;charset=US-ASCII,%3Csvg%20width%3D%2224%22%20height%3D%2224%22%20fill%3D%22none%22%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%3E%3Cpath%20d%3D%22M7%2010L12%2015L17%2010%22%20stroke%3D%22%236B7280%22%20stroke-width%3D%222%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%2F%3E%3C%2Fsvg%3E')] bg-[position:right_0.25rem_center] bg-no-repeat pr-8 ${
                          appt.status === 'completed'
                            ? 'bg-green-500/15 text-green-700 dark:text-green-400 border border-green-500/30'
                            : appt.status === 'cancelled' ||
                                appt.status === 'no_show'
                              ? 'bg-destructive/15 text-destructive border border-destructive/30'
                              : 'bg-background border border-border text-foreground'
                        }`}
                        aria-label="Appointment status"
                        value={appt.status}
                        disabled={!!statusReview || updateAppt.isPending}
                        onChange={(e) =>
                          handleStatusChange(
                            appt.id,
                            e.target.value as AppointmentStatus,
                          )
                        }
                      >
                        <option value="scheduled">Scheduled</option>
                        <option value="confirmed">Confirmed</option>
                        <option value="completed">Completed</option>
                        <option value="no_show">No Show</option>
                        <option value="cancelled">Cancelled</option>
                      </select>
                    ) : (
                      <span className="text-[10px] font-bold uppercase tracking-widest text-slate-600 dark:text-slate-300 bg-muted/50 px-3 py-1.5 rounded-lg border border-border">
                        {appt.status.replace('_', ' ')}
                      </span>
                    )}

                    {canEdit && (
                      <button
                        data-testid="edit-appointment"
                        aria-label="Edit appointment"
                        disabled={!!statusReview || updateAppt.isPending}
                        onClick={() => openEdit(appt)}
                        className="md:opacity-0 md:group-hover:opacity-100 w-10 h-10 md:w-8 md:h-8 flex items-center justify-center text-slate-600 dark:text-slate-300 hover:text-primary transition-all rounded-full hover:bg-muted md:mt-auto active:scale-95 bg-muted/50 md:bg-transparent border border-border md:border-none shadow-sm md:shadow-none disabled:opacity-50"
                      >
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

      {isFormOpen && canEdit && (
        <ApptFormModal
          appt={editingAppt}
          scopeKey={scopeKey}
          organizationId={me.organization!.id}
          actorUserId={me.id}
          onClose={() => {
            setIsFormOpen(false);
            setLinkedRevision((value) => value + 1);
          }}
        />
      )}
    </div>
  );
}

function companyDate(instant: string, zone: string) {
  try {
    return formatSchedulingWallTime(instant, zone).localDateTime.slice(0, 10);
  } catch {
    return '';
  }
}
function companyLabel(
  instant: string,
  zone: string,
  options: Intl.DateTimeFormatOptions,
) {
  try {
    return new Intl.DateTimeFormat('en-US', {
      ...options,
      timeZone: zone,
    }).format(new Date(instant));
  } catch {
    return 'Company time unavailable';
  }
}
function appointmentInterval(appt?: Appointment | null): IntervalInput {
  const raw = appt?.schedulingReservation;
  const parsed = reservationSnapshotSchema.safeParse(raw);
  const valid =
    parsed.success &&
    parsed.data.target.kind === 'appointment' &&
    parsed.data.target.id === appt?.id;
  const evidence = !appt
    ? 'legacy'
    : appt.schedulingEvidence === 'versioned' && valid
      ? 'versioned'
      : appt.schedulingEvidence === 'legacy' && raw == null
        ? 'legacy'
        : 'invalid';
  let legacyEffectiveEnd: string | null = null;
  if (appt?.scheduledStart && !appt.scheduledEnd && evidence === 'legacy')
    try {
      legacyEffectiveEnd = new Date(
        Date.parse(appt.scheduledStart) + 120 * 60_000,
      ).toISOString();
    } catch {
      /* Retain invalid evidence without guessing. */
    }
  return {
    startAt: appt?.scheduledStart ?? null,
    endAt: appt?.scheduledEnd ?? null,
    legacyEffectiveEnd,
    reservation: valid ? parsed.data : null,
    evidence,
  };
}
// Read-only bounded discovery within the existing namespace. Never select another
// customer's pending operation just because the new form has no selected source.
async function retainedAppointmentSource(
  scope: { organizationId: string; actorUserId: string },
  source: ManualSourceRef,
  recoverUntouchedProperty: boolean,
) {
  const prefix = `growthos.scheduling.pending.v1:${scope.organizationId}:${scope.actorUserId}:appointment_create:`;
  const matching = () => {
    const entries: { key: string; sourceKey: string; bytes: string }[] = [];
    for (let index = 0; index < sessionStorage.length; index++) {
      const key = sessionStorage.key(index);
      if (!key?.startsWith(prefix)) continue;
      const sourceKey = key.slice(prefix.length),
        tuple: unknown = JSON.parse(sourceKey);
      if (!Array.isArray(tuple) || tuple.length !== 5)
        throw new Error('Invalid original source tuple');
      const candidate = manualSourceRefSchema.parse({
        sourceKind: tuple[0],
        leadId: tuple[1],
        contactId: tuple[2],
        propertyId: tuple[3],
        estimateId: tuple[4],
      });
      if (
        candidate.sourceKind !== source.sourceKind ||
        candidate.leadId !== source.leadId ||
        (source.contactId !== null &&
          candidate.contactId !== source.contactId) ||
        candidate.estimateId !== null
      )
        continue;
      if (manualSchedulingSourceKey(candidate) !== sourceKey)
        throw new Error('Invalid original source key');
      const bytes = sessionStorage.getItem(key);
      if (bytes === null) throw new Error('Original custody missing');
      entries.push({ key, sourceKey, bytes });
    }
    return entries.sort((a, b) => a.key.localeCompare(b.key));
  };
  const entries = matching();
  if (entries.length > 1)
    throw new Error('Ambiguous original appointment custody');
  if (entries[0]) {
    const saved = await parseManualSchedulingCustody(
      entries[0].bytes,
      scope,
      'appointment_create',
      entries[0].sourceKey,
    );
    if (
      saved.command.review.context.source!.propertyId !== source.propertyId &&
      !(recoverUntouchedProperty && source.propertyId === null)
    )
      throw new Error(
        'Original property differs from the deliberate current selection',
      );
  }
  if (JSON.stringify(matching()) !== JSON.stringify(entries))
    throw new Error('Original custody changed');
  return entries[0]?.sourceKey ?? null;
}
function ApptFormModal({
  appt,
  onClose,
  scopeKey,
  organizationId,
  actorUserId,
}: {
  appt?: Appointment | null;
  onClose: () => void;
  scopeKey: string;
  organizationId: string;
  actorUserId: string;
}) {
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    panel.current?.querySelector<HTMLElement>('button')?.focus();
    return () => {
      previous?.focus();
    };
  }, []);
  const authority = useSchedulingAuthority({
    organizationId,
    actorUserId,
    scopeKey,
  });
  const [type, setType] = useState<AppointmentType>(appt?.type ?? 'inspection'),
    [status, setStatus] = useState<AppointmentStatus>(
      appt?.status ?? 'scheduled',
    );
  const [notes, setNotes] = useState(appt?.notes ?? ''),
    [leadId, setLeadId] = useState(appt?.leadId ?? ''),
    [contactId, setContactId] = useState(appt?.contactId ?? ''),
    [propertyId, setPropertyId] = useState('');
  const [propertyTouched, setPropertyTouched] = useState(false);
  const [patchState, setPatchState] = useState<'idle' | 'saving' | 'unknown'>(
      'idle',
    ),
    [submitError, setSubmitError] = useState('');
  const queryClient = useQueryClient(),
    updateAppt = useUpdateAppointment({ mutation: { retry: false } });
  const { data: users } = useListUsers({
    query: {
      queryKey: [...getListUsersQueryKey(), scopeKey],
      enabled: authority.allowed,
    },
  });
  const source: ManualSourceRef = {
    sourceKind: leadId
      ? 'lead'
      : contactId
        ? 'direct_customer'
        : 'unlinked_manual',
    leadId: leadId || null,
    contactId: contactId || null,
    propertyId: appt?.propertyId ?? (propertyId || null),
    estimateId: null,
  };
  const selection = JSON.stringify([
    appt?.id ?? 'new',
    leadId,
    contactId,
    propertyId,
    type,
    appt?.updatedAt,
    appt?.schedulingTargetFingerprint,
  ]);
  const read = useSchedulingContext({
    authority,
    identity: selection,
    enabled: authority.allowed,
    load: async () => {
      const [raw, policy] = await Promise.all([
        getSchedulingReviewContext({
          sourceKind: source.sourceKind,
          ...(leadId || contactId ? { sourceId: leadId || contactId } : {}),
          ...(source.propertyId ? { propertyId: source.propertyId } : {}),
          reservationKind: 'appointment',
          appointmentType: type,
          ...(appt ? { targetKind: 'appointment', targetId: appt.id } : {}),
        }),
        getSchedulingPolicy(),
      ]);
      const context = schedulingReviewContextSchema.parse(raw),
        actual = context.source;
      if (
        context.companyTimeZone !== authority.profile?.organization?.timezone ||
        !actual ||
        actual.sourceKind !== source.sourceKind ||
        actual.leadId !== source.leadId ||
        (contactId && actual.contactId !== contactId) ||
        actual.propertyId !== source.propertyId ||
        actual.estimateId !== null ||
        (appt
          ? context.targetVersion !== appt.updatedAt ||
            context.targetFingerprint !== appt.schedulingTargetFingerprint
          : context.targetVersion !== null ||
            context.targetFingerprint !== null)
      )
        throw new Error('Appointment source/target changed');
      return { context, policy: policy.policy };
    },
  });
  const context = read.value?.context ?? null,
    interval = appointmentInterval(appt);
  const draftRef = useRef<SchedulingDraft>({
    startAt: interval.startAt,
    endAt: interval.endAt,
    resourceUserIds: appt?.assignedUserId ? [appt.assignedUserId] : [],
  });
  const review = useSchedulingReview({
    authority,
    identity: selection,
    context,
    interval,
    initialDraft: draftRef.current,
    transition: 'admission',
  });
  draftRef.current = review.draft;
  const endpointsUnchanged =
    review.draft.startAt === interval.startAt &&
    review.draft.endAt === interval.endAt;
  const resourcesUnchanged =
    JSON.stringify(review.draft.resourceUserIds) ===
    JSON.stringify(appt?.assignedUserId ? [appt.assignedUserId] : []);
  const resourcesOnlyRemoved =
    !resourcesUnchanged &&
    review.draft.resourceUserIds.every(
      (resourceId) => resourceId === appt?.assignedUserId,
    );
  const sourceUnchanged =
    leadId === (appt?.leadId ?? '') &&
    contactId === (appt?.contactId ?? '') &&
    type === appt?.type;
  let transition: 'admission' | 'release' | 'preserve' = 'admission';
  if (appt)
    try {
      const before: SchedulingCandidate = {
        kind: 'appointment',
        id: appt.id,
        startAt: interval.startAt,
        endAt: interval.endAt,
        resourceUserIds: appt.assignedUserId ? [appt.assignedUserId] : [],
        type: appt.type,
        status: appt.status,
        source: {
          sourceKind: appt.leadId
            ? 'lead'
            : appt.contactId
              ? 'direct_customer'
              : 'unlinked_manual',
          leadId: appt.leadId ?? null,
          contactId: appt.contactId ?? null,
          propertyId: appt.propertyId ?? null,
          estimateId: null,
        },
        reservation: interval.reservation,
      };
      transition = classifyReservationTransition(before, {
        ...before,
        ...review.draft,
        type,
        status,
        source,
      });
    } catch {
      /* Invalid material evidence cannot grant admission authority. */
    }
  const historical =
    !!appt &&
    !!appt.updatedAt &&
    endpointsUnchanged &&
    sourceUnchanged &&
    transition !== 'admission' &&
    (resourcesUnchanged ||
      (resourcesOnlyRemoved && !!appt.schedulingTargetFingerprint)) &&
    (interval.evidence !== 'invalid' ||
      resourcesUnchanged ||
      !['scheduled', 'confirmed'].includes(status));
  const custodyIdentity = JSON.stringify([
    organizationId,
    actorUserId,
    !!appt,
    leadId,
    contactId,
    propertyId,
    propertyTouched,
  ]);
  const retainedRef = useRef({
    identity: custodyIdentity,
    sourceKey: null as string | null,
    original: false,
  });
  if (retainedRef.current.identity !== custodyIdentity)
    retainedRef.current = {
      identity: custodyIdentity,
      sourceKey: null,
      original: false,
    };
  const retained = retainedRef.current;
  const [discovery, setDiscovery] = useState<{
    identity: string;
    authority: string;
    blocked: boolean;
  } | null>(null);
  useEffect(() => {
    if (appt || !authority.isCurrent()) return;
    let cancelled = false;
    const current = () =>
      !cancelled && retainedRef.current === retained && authority.isCurrent();
    void (async () => {
      try {
        const key = await retainedAppointmentSource(
          { organizationId, actorUserId },
          source,
          !propertyTouched,
        );
        if (!current()) return;
        if (key) {
          retained.sourceKey = key;
          retained.original = true;
        } else if (retained.original)
          throw new Error('Original custody disappeared');
        setDiscovery({
          identity: custodyIdentity,
          authority: authority.identity,
          blocked: false,
        });
      } catch {
        if (current())
          setDiscovery({
            identity: custodyIdentity,
            authority: authority.identity,
            blocked: true,
          });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [custodyIdentity, authority.identity]);
  const discoveryReady =
    !!appt ||
    (discovery?.identity === custodyIdentity &&
      discovery.authority === authority.identity);
  const discoveryBlocked =
    !!discoveryReady && !appt && discovery?.blocked === true;
  if (!retained.original && context?.source)
    retained.sourceKey = manualSchedulingSourceKey(context.source);
  const sourceKey =
    retained.sourceKey ??
    JSON.stringify(['unready', leadId, contactId, propertyId]);
  const manual = useManualSchedulingCommand({
    scope:
      authority.allowed &&
      !discoveryBlocked &&
      (discoveryReady || retained.original)
        ? { organizationId, actorUserId, canWrite: true }
        : null,
    kind: 'appointment_create',
    sourceKey,
    dispatch: async (command) => {
      const current = authority.isCurrent;
      if (!current() || command.kind !== 'appointment_create')
        throw new Error('Appointment authority changed');
      try {
        return await createAppointment({
          ...command.body,
          operationId: command.operationId,
          schedulingReview: command.review,
        });
      } finally {
        if (!current()) throw new Error('Appointment authority changed');
      }
    },
    reconcile: async (command) => {
      const current = authority.isCurrent;
      if (!current()) throw new Error('Appointment authority changed');
      try {
        return await reconcileSchedulingOperation(command);
      } finally {
        if (!current()) throw new Error('Appointment authority changed');
      }
    },
  });
  if (!appt && manual.state.command) {
    retained.sourceKey = manualSchedulingSourceKey(
      manual.state.command.review.context.source!,
    );
    retained.original = true;
  }
  const refreshedOperation = useRef<string | null>(null);
  useEffect(() => {
    if (
      appt ||
      manual.state.kind !== 'committed' ||
      !manual.state.ack ||
      refreshedOperation.current === manual.state.ack.operationId ||
      !authority.isCurrent()
    )
      return;
    refreshedOperation.current = manual.state.ack.operationId;
    void queryClient.invalidateQueries({
      queryKey: getListAppointmentsQueryKey(),
    });
  }, [manual.state.kind, manual.state.ack, authority.identity]);
  const nativeHeld = !appt && manual.state.kind !== 'idle';
  const busy =
    patchState === 'saving' ||
    (!appt &&
      (['submitting', 'reconciling'].includes(manual.state.kind) ||
        (manual.state.kind === 'preparing' && !!manual.state.command)));
  const locked =
    !authority.allowed ||
    !discoveryReady ||
    discoveryBlocked ||
    busy ||
    nativeHeld ||
    patchState === 'unknown';
  const controlsLocked =
    !authority.allowed ||
    discoveryBlocked ||
    busy ||
    patchState === 'unknown' ||
    (!appt && !!manual.state.command && manual.state.kind !== 'idle');
  const zone = authority.profile?.organization?.timezone ?? null;
  const proposal = context
    ? buildSchedulingProposalView({
        context,
        interval,
        draft: review.draft,
        transition,
      })
    : null;
  const resources = (users ?? []).filter(canAssignWork).map((user) => ({
    id: user.id,
    label:
      [user.firstName, user.lastName].filter(Boolean).join(' ') ||
      user.email ||
      user.id,
  }));
  const changeSource = (change: () => void) => {
    if (controlsLocked) return;
    review.invalidate();
    change();
  };
  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (
      locked ||
      !authority.isCurrent() ||
      review.draft.resourceUserIds.length > 1 ||
      (!historical &&
        (!review.review || !review.current() || !review.draft.startAt))
    )
      return;
    setSubmitError('');
    if (appt) {
      const current = authority.isCurrent;
      setPatchState('saving');
      try {
        await updateAppt.mutateAsync({
          id: appt.id,
          data: {
            type,
            status,
            notes: notes || null,
            leadId: leadId || null,
            contactId: contactId || null,
            assignedUserId: review.draft.resourceUserIds[0] ?? null,
            scheduledStart: review.draft.startAt ?? appt.scheduledStart,
            ...(interval.endAt !== null || review.draft.endAt !== null
              ? { scheduledEnd: review.draft.endAt }
              : {}),
            expectedUpdatedAt: appt.updatedAt,
            ...(appt.schedulingTargetFingerprint
              ? { expectedTargetFingerprint: appt.schedulingTargetFingerprint }
              : {}),
            ...(!historical && review.review
              ? { schedulingReview: review.review }
              : {}),
          },
        });
        if (current()) {
          void queryClient.invalidateQueries({
            queryKey: getListAppointmentsQueryKey(),
          });
          onClose();
        }
      } catch {
        if (current()) {
          setPatchState('unknown');
          setSubmitError(
            'The appointment update is unconfirmed. Read the original record before another deliberate change. No automatic retry was made.',
          );
        }
      }
      return;
    }
    if (!review.review || !review.draft.startAt || !review.draft.endAt) return;
    await manual.submit({
      operationId: crypto.randomUUID(),
      kind: 'appointment_create',
      body: {
        type,
        status,
        scheduledStart: review.draft.startAt,
        scheduledEnd: review.draft.endAt,
        ...(notes ? { notes } : {}),
        ...(leadId ? { leadId } : {}),
        ...(contactId ? { contactId } : {}),
        propertyId: propertyId || null,
        ...(review.draft.resourceUserIds[0]
          ? { assignedUserId: review.draft.resourceUserIds[0] }
          : {}),
      },
      review: review.review,
    });
  }
  if (!authority.allowed)
    return (
      <p role="status">
        Checking current appointment access. Reopen the appointment after access
        changes.
      </p>
    );
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-background/90 p-0 md:items-center md:p-4">
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby="appointment-form-title"
        className="max-h-[95dvh] w-full min-w-0 max-w-2xl overflow-y-auto rounded-t-2xl border bg-card p-4 md:rounded-2xl md:p-6"
        onKeyDown={(event) => {
          if (event.key === 'Escape') onClose();
          if (event.key !== 'Tab') return;
          const controls = [
            ...(panel.current?.querySelectorAll<HTMLElement>(
              'button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href]',
            ) ?? []),
          ].filter((control) => !control.closest('fieldset:disabled'));
          if (event.shiftKey && document.activeElement === controls[0]) {
            event.preventDefault();
            controls.at(-1)?.focus();
          } else if (
            !event.shiftKey &&
            document.activeElement === controls.at(-1)
          ) {
            event.preventDefault();
            controls[0]?.focus();
          }
        }}
      >
        <div className="flex items-center justify-between">
          <h2 id="appointment-form-title">
            {appt ? 'Edit Appointment' : 'New Appointment'}
          </h2>
          <button
            type="button"
            className="min-h-11 min-w-11"
            aria-label="Close"
            onClick={onClose}
          >
            <X />
          </button>
        </div>
        {!appt && (
          <div role="status" className="my-3 space-y-2 break-words">
            {discoveryBlocked || manual.state.kind === 'blocked_custody' ? (
              <p>
                Original command custody is unavailable. Booking held; retain
                this tab and recover the original command before proceeding.
              </p>
            ) : manual.state.kind === 'unknown' ? (
              <p>
                Original appointment result is unknown. No booking will be
                retried. Reconcile the retained original command.
              </p>
            ) : manual.state.kind === 'committed' ? (
              <p>
                Original appointment committed
                {manual.state.ack?.target?.available === false
                  ? '; its target is unavailable.'
                  : '.'}{' '}
                Another booking is held.
              </p>
            ) : manual.state.kind === 'refused' ? (
              <p>
                Original appointment was refused with authoritative no-commit
                proof. Its original operation remains terminal.
              </p>
            ) : busy ? (
              <p>Retaining and checking the original appointment command…</p>
            ) : null}
            {manual.state.command?.kind === 'appointment_create' && (
              <p>
                Retained original service:{' '}
                {manual.state.command.body.scheduledStart} to{' '}
                {manual.state.command.body.scheduledEnd ?? 'Stored empty end'}.
                Original property:{' '}
                {manual.state.command.review.context.source?.propertyId ??
                  'No property linked'}
                . The controls below do not replace this original command.
              </p>
            )}
            {manual.state.kind === 'unknown' && (
              <button
                type="button"
                className="min-h-11 rounded border px-3"
                onClick={() => void manual.reconcileOriginal()}
              >
                Reconcile original appointment
              </button>
            )}
            {manual.state.kind === 'committed' &&
              manual.state.ack?.target?.available && (
                <Link
                  className="inline-flex min-h-11 items-center underline"
                  href={`/appointments?appointmentId=${manual.state.ack.target.id}&organizationId=${organizationId}`}
                >
                  Open original appointment
                </Link>
              )}
            {manual.state.kind === 'refused' && (
              <button
                type="button"
                className="min-h-11 rounded border px-3"
                onClick={() => {
                  manual.acknowledgeRefusal();
                  review.invalidate();
                }}
              >
                Acknowledge refusal and review a new appointment
              </button>
            )}
          </div>
        )}
        <form
          onSubmit={(event) => void handleSubmit(event)}
          className="mt-4 space-y-4"
        >
          <fieldset disabled={controlsLocked} className="min-w-0 space-y-4">
            <label className="block">
              Type
              <select
                aria-label="Appointment type"
                className="block min-h-11 w-full border bg-background p-2"
                value={type}
                onChange={(event) =>
                  changeSource(() =>
                    setType(event.target.value as AppointmentType),
                  )
                }
              >
                {Object.values(AppointmentType).map((value) => (
                  <option key={value} value={value}>
                    {value.replaceAll('_', ' ')}
                  </option>
                ))}
              </select>
            </label>
            {appt && (
              <label className="block">
                Status
                <select
                  aria-label="Appointment status"
                  className="block min-h-11 w-full border bg-background p-2"
                  value={status}
                  onChange={(event) => {
                    review.invalidate();
                    setStatus(event.target.value as AppointmentStatus);
                  }}
                >
                  {Object.values(AppointmentStatus).map((value) => (
                    <option key={value} value={value}>
                      {value.replaceAll('_', ' ')}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <SchedulingIntervalFields
              {...review.fields}
              resources={resources}
              presets={
                read.value?.policy?.enabled
                  ? read.value.policy.durationPresets
                  : []
              }
              disabled={controlsLocked}
            />
            {review.draft.resourceUserIds.length > 1 && (
              <p role="alert">
                Appointments support one assigned staff member. Choose a single
                resource before saving.
              </p>
            )}
            {appt?.assignedUserId && (
              <button
                type="button"
                className="min-h-11 rounded border px-3"
                disabled={
                  interval.evidence === 'invalid' &&
                  ['scheduled', 'confirmed'].includes(status)
                }
                onClick={() => {
                  review.fields.onReviewChange(null);
                  review.fields.onDraftChange({
                    ...review.draft,
                    resourceUserIds: [],
                  });
                }}
              >
                Remove assigned resource
              </button>
            )}
            <SchedulingIntervalReview
              companyTimeZone={zone}
              interval={interval}
              proposal={proposal}
              resources={resources}
              conflict={null}
            />
            {appt && (
              <SchedulingReservationSummary
                companyTimeZone={zone}
                interval={interval}
                proposal={proposal}
                resources={resources}
                conflict={null}
              />
            )}
            <label className="block">
              Customer
              <ContactSelect
                queryScope={scopeKey}
                value={contactId}
                onChange={(id) =>
                  changeSource(() => {
                    setContactId(id);
                    setPropertyId('');
                    setPropertyTouched(false);
                  })
                }
                testId="appointment-contact"
              />
            </label>
            <p>
              Choose a customer for a service visit. A related opportunity is
              optional.
            </p>
            <label className="block">
              Related Lead
              <LeadSelect
                queryScope={scopeKey}
                value={leadId}
                onChange={(id) =>
                  changeSource(() => {
                    setLeadId(id);
                    setPropertyId('');
                    setPropertyTouched(false);
                  })
                }
              />
            </label>
            {!appt && (
              <CustomerPropertySelect
                organizationId={organizationId}
                contactId={contactId}
                scopeKey={JSON.stringify([scopeKey, leadId])}
                value={propertyId}
                onChange={(id) => {
                  if (id !== propertyId)
                    changeSource(() => {
                      setPropertyId(id);
                      setPropertyTouched(true);
                    });
                }}
                purpose="appointment"
                disabled={controlsLocked}
              />
            )}
            <label className="block">
              Notes
              <textarea
                aria-label="Appointment notes"
                className="block min-h-20 w-full border bg-background p-2 text-base"
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
              />
            </label>
          </fieldset>
          {read.error && <p role="alert">{read.error}</p>}
          <button
            type="button"
            className="min-h-11 rounded border px-3"
            disabled={busy}
            onClick={() => void read.refresh()}
          >
            Refresh scheduling review
          </button>
          {submitError && <p role="alert">{submitError}</p>}
          {submitError && appt && status === 'completed' && (
            <p>
              Required visit work must be reviewed and completed on its exact
              work record.{' '}
              <Link
                className="inline-flex min-h-11 items-center underline"
                onClick={onClose}
                href={`/appointments?appointmentId=${appt.id}&organizationId=${organizationId}`}
              >
                Open visit work
              </Link>
            </p>
          )}
          <div className="flex flex-wrap gap-3">
            <button
              type="submit"
              disabled={
                locked ||
                review.draft.resourceUserIds.length > 1 ||
                (!historical && !review.review)
              }
              className="min-h-11 rounded border px-4 disabled:opacity-50"
            >
              Save Appt
            </button>
            <button
              type="button"
              className="min-h-11 rounded border px-4"
              onClick={onClose}
            >
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
