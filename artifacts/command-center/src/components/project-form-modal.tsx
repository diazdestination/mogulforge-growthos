import { useState } from 'react';
import {
  useCreateProject,
  useUpdateProject,
  useUpdateLead,
  updateLead as updateLeadRequest,
  getListProjectsQueryKey,
  getListLeadsQueryKey,
  useListEstimates,
  useListUsers,
  Project,
} from '@workspace/api-client-react';
import { Loader2 } from 'lucide-react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useToast, toast as globalToast } from '@/hooks/use-toast';
import { ToastAction } from '@/components/ui/toast';
import LeadSelect from '@/components/lead-select';
import { canAssignWork, localDateTime, scheduleTimezone } from '@/lib/contractor-schedule';

function toDateInput(value: string | null | undefined) {
  return localDateTime(value);
}

export interface ProjectFormDefaults {
  leadId?: string;
  /** Display label for the pre-selected lead (shown when `leadId` is fixed). */
  leadLabel?: string;
  estimateId?: string;
  name?: string;
  /** Show an option to advance the lead's status to production_scheduled after creation. */
  offerLeadAdvance?: boolean;
}

export default function ProjectFormModal({
  project,
  defaults,
  initialLeadId,
  onClose,
}: {
  project: Project | null;
  defaults?: ProjectFormDefaults;
  /** Seeds the lead selector (still editable), e.g. from a ?leadId= link. */
  initialLeadId?: string;
  onClose: () => void;
}) {
  const [name, setName] = useState(project?.name || defaults?.name || '');
  const [leadId, setLeadId] = useState(project?.leadId || defaults?.leadId || initialLeadId || '');
  const [estimateId, setEstimateId] = useState(project?.estimateId || defaults?.estimateId || '');
  const [start, setStart] = useState(toDateInput(project?.scheduledStart));
  const [end, setEnd] = useState(toDateInput(project?.scheduledEnd));
  const [crew, setCrew] = useState<string[]>(project?.crewUserIds || []);
  const [crewNotes, setCrewNotes] = useState(project?.crewNotes || '');
  const [advanceLead, setAdvanceLead] = useState(defaults?.offerLeadAdvance ?? false);
  const [formError, setFormError] = useState('');

  const { data: users } = useListUsers();
  const effectiveLeadId = project?.leadId || leadId;
  const { data: allEstimates } = useListEstimates();
  const estimates = effectiveLeadId
    ? allEstimates?.filter(e => e.leadId === effectiveLeadId)
    : [];
  const createProject = useCreateProject();
  const updateProject = useUpdateProject();
  const updateLead = useUpdateLead();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const isSubmitting = createProject.isPending || updateProject.isPending || updateLead.isPending;

  const toggleCrew = (userId: string) => {
    setCrew(prev => prev.includes(userId) ? prev.filter(id => id !== userId) : [...prev, userId]);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name || (!project && !leadId)) return;
    setFormError('');
    if ((end && (!start || new Date(end) <= new Date(start))) || (start && crew.length && !end)) { setFormError('Set an end time after the start time for assigned work.'); return; }

    const finish = () => {
      queryClient.invalidateQueries({ queryKey: getListProjectsQueryKey() });
      onClose();
    };

    const handleSaveError = (error: unknown) => {
      const serverMessage =
        error && typeof error === 'object' && 'data' in error
          ? (error as { data?: { error?: string } }).data?.error
          : undefined;
      toast({
        variant: 'destructive',
        title: project ? 'Project not saved' : 'Project not created',
        description:
          serverMessage ||
          'Saving the project failed. Check your connection and try again.',
      });
    };

    if (project) {
      updateProject.mutate({
        id: project.id,
        data: {
          name,
          estimateId: estimateId || null,
          scheduledStart: start ? new Date(start).toISOString() : null,
          scheduledEnd: end ? new Date(end).toISOString() : null,
          crewUserIds: crew,
          crewNotes: crewNotes || null,
          ...(project.updatedAt ? { expectedUpdatedAt: project.updatedAt } : {}),
        },
      }, { onSuccess: finish, onError: handleSaveError });
    } else {
      createProject.mutate({
        data: {
          leadId,
          name,
          estimateId: estimateId || undefined,
          scheduledStart: start ? new Date(start).toISOString() : undefined,
          scheduledEnd: end ? new Date(end).toISOString() : undefined,
          crewUserIds: crew,
          crewNotes: crewNotes || undefined,
        },
      }, {
        onSuccess: () => {
          if (defaults?.offerLeadAdvance && advanceLead) {
            updateLead.mutate(
              { id: leadId, data: { status: 'production_scheduled' } },
              {
                onSuccess: () => {
                  queryClient.invalidateQueries({ queryKey: getListLeadsQueryKey() });
                  finish();
                },
                onError: () => {
                  queryClient.invalidateQueries({ queryKey: getListLeadsQueryKey() });
                  showLeadAdvanceFailedToast(leadId, queryClient);
                  finish();
                },
              },
            );
          } else {
            finish();
          }
        },
        onError: handleSaveError,
      });
    }
  };

  return (
    <div className="fixed inset-0 bg-background/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-card border border-border shadow-xl rounded-xl w-full max-w-lg overflow-hidden max-h-[90vh] flex flex-col">
        <div className="p-6 border-b border-border flex justify-between items-center bg-muted/30 shrink-0">
          <h2 className="text-lg font-bold">{project ? 'Edit Project' : defaults?.offerLeadAdvance ? 'Start Project' : 'New Project'}</h2>
          <button aria-label="Close project form" onClick={onClose} className="min-h-11 min-w-11 text-muted-foreground hover:text-foreground">&times;</button>
        </div>
        <form onSubmit={handleSubmit} className="p-6 space-y-4 overflow-y-auto">
          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Name *</label>
            <input aria-label="Project name" required className="w-full bg-background border border-border rounded-md px-3 py-2 text-base focus:ring-2 focus:ring-primary focus:outline-none" value={name} onChange={e => setName(e.target.value)} />
          </div>

          {!project && (
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Lead *</label>
              {defaults?.leadId ? (
                <div className="w-full bg-muted/40 border border-border rounded-md px-3 py-2 text-sm text-muted-foreground">
                  {defaults.leadLabel || defaults.leadId.substring(0, 8)}
                </div>
              ) : (
                <LeadSelect required withStatus value={leadId} onChange={id => { setLeadId(id); setEstimateId(''); }} />
              )}
            </div>
          )}

          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Linked Estimate</label>
            <select aria-label="Linked estimate" className="w-full bg-background border border-border rounded-md px-3 py-2 text-base focus:ring-2 focus:ring-primary focus:outline-none" value={estimateId} onChange={e => setEstimateId(e.target.value)} disabled={!effectiveLeadId}>
              <option value="">-- None --</option>
              {estimates?.map(estimate => (
                <option key={estimate.id} value={estimate.id}>
                  {estimate.title} ({(estimate.totalCents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' })})
                </option>
              ))}
            </select>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Scheduled Start</label>
              <input aria-label="Scheduled start" type="datetime-local" className="min-w-0 w-full bg-background border border-border rounded-md px-3 py-2 text-base focus:ring-2 focus:ring-primary focus:outline-none" value={start} onChange={e => setStart(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Scheduled End</label>
              <input aria-label="Scheduled end" type="datetime-local" className="min-w-0 w-full bg-background border border-border rounded-md px-3 py-2 text-base focus:ring-2 focus:ring-primary focus:outline-none" value={end} onChange={e => setEnd(e.target.value)} />
            </div>
          </div>
          <p className="text-sm text-muted-foreground">Times use {scheduleTimezone}. The full window reserves the assigned crew, including multi-day jobs.</p>

          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Crew Assignment</label>
            <div className="border border-border rounded-md p-2 max-h-36 overflow-y-auto space-y-1 bg-background">
              {users?.filter(canAssignWork).map(user => (
                <label key={user.id} className="flex items-center gap-2 px-2 py-1 rounded hover:bg-muted cursor-pointer text-sm">
                  <input type="checkbox" checked={crew.includes(user.id)} onChange={() => toggleCrew(user.id)} className="accent-primary" />
                  <span>{`${user.firstName ?? ''} ${user.lastName ?? ''}`.trim() || user.email}</span>
                  <span className="text-[10px] font-mono text-muted-foreground uppercase ml-auto">{user.role}</span>
                </label>
              ))}
              {!users?.length && <div className="text-sm text-muted-foreground px-2 py-1">No team members found.</div>}
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Crew Notes</label>
            <textarea aria-label="Crew notes" className="w-full bg-background border border-border rounded-md px-3 py-2 text-base focus:ring-2 focus:ring-primary focus:outline-none min-h-[60px] resize-none" value={crewNotes} onChange={e => setCrewNotes(e.target.value)} />
          </div>

          {!project && defaults?.offerLeadAdvance && (
            <label className="flex items-center gap-2 text-sm cursor-pointer bg-muted/40 border border-border rounded-md px-3 py-2.5">
              <input type="checkbox" checked={advanceLead} onChange={e => setAdvanceLead(e.target.checked)} className="accent-primary" />
              <span>Advance lead status to <span className="font-semibold">Production Scheduled</span></span>
            </label>
          )}

          {formError && <p role="alert" className="text-sm text-destructive">{formError}</p>}
          <div className="pt-2 flex justify-end gap-3">
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm font-medium hover:bg-muted rounded-md transition-colors">Cancel</button>
            <button type="submit" disabled={isSubmitting} className="bg-primary text-primary-foreground px-4 py-2 rounded-md text-sm font-semibold hover:bg-primary/90 transition-colors disabled:opacity-50 min-w-[100px]">
              {isSubmitting ? <Loader2 className="w-4 h-4 animate-spin mx-auto" /> : defaults?.offerLeadAdvance ? 'Start Project' : 'Save'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/**
 * Shows the "Lead status not updated" toast with a Retry action.
 * Lives at module level (using the global toast store and the plain fetch
 * client) so retrying keeps working after the modal has closed.
 */
function showLeadAdvanceFailedToast(leadId: string, queryClient: QueryClient) {
  const { dismiss } = globalToast({
    variant: 'destructive',
    title: 'Lead status not updated',
    description:
      'The project was created, but advancing the lead to Production Scheduled failed. Retry below or update the lead manually from the Leads page.',
    action: (
      <ToastAction
        altText="Retry lead status update"
        onClick={async () => {
          try {
            await updateLeadRequest(leadId, { status: 'production_scheduled' });
            queryClient.invalidateQueries({ queryKey: getListLeadsQueryKey() });
            dismiss();
          } catch {
            queryClient.invalidateQueries({ queryKey: getListLeadsQueryKey() });
            showLeadAdvanceFailedToast(leadId, queryClient);
          }
        }}
      >
        Retry
      </ToastAction>
    ),
  });
}
