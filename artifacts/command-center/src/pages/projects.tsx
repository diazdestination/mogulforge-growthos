import { useEffect, useRef, useState } from 'react';
import { Link, useSearch } from 'wouter';
import ProjectFormModal from '@/components/project-form-modal';
import {
  useListProjects,
  useUpdateProject,
  useDeleteProject,
  getListProjectsQueryKey,
  useListUsers,
  getListUsersQueryKey,
  useGetMe,
  ProjectStatus,
  Project,
  type MemberProfile,
} from '@workspace/api-client-react';
import { Loader2, Plus, Trash2, Edit, HardHat, CheckCircle } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { canWrite, canDelete } from '@/lib/permissions';
import { format } from 'date-fns';
import { toast } from '@/hooks/use-toast';
import { memberAuthorityScope } from '@/lib/member-authority-scope';
import { customerWorkLocation, customerWorkPath } from '@/lib/customer-work-links';
import { customerWorkspacePath } from '@/lib/customer-workspace-links';
import { useExactCustomerWork } from '@/hooks/use-exact-customer-work';
import { returningProject, CustomerWorkForm } from '@/components/customer-work-form';

const STATUS_STYLES: Record<ProjectStatus, string> = {
  scheduled: 'bg-blue-500/10 text-blue-600 border-blue-500/20 dark:text-blue-400 dark:border-blue-500/30',
  in_progress: 'bg-secondary/15 text-secondary border-secondary/20 dark:border-secondary/30',
  on_hold: 'bg-muted text-muted-foreground border-border',
  completed: 'bg-green-500/10 text-green-700 border-green-500/20 dark:text-green-400 dark:border-green-500/30',
  cancelled: 'bg-destructive/10 text-destructive border-destructive/20 dark:border-destructive/30',
};

const STATUS_OPTIONS: { value: ProjectStatus; label: string }[] = [
  { value: 'scheduled', label: 'Scheduled' },
  { value: 'in_progress', label: 'In Progress' },
  { value: 'on_hold', label: 'On Hold' },
  { value: 'completed', label: 'Completed' },
  { value: 'cancelled', label: 'Cancelled' },
];

export default function Projects() {
  const search = useSearch();
  const profile = useGetMe();
  if (profile.isError) return <p role="alert" className="p-5">Company access could not be verified. No job record is shown.</p>;
  if (profile.isLoading) return <p role="status" className="p-5">Checking job access…</p>;
  if (!profile.data?.isActive || !profile.data.organization) return <p role="alert" className="p-5">Active company access is required.</p>;
  const scopeKey = memberAuthorityScope(profile.data);
  return <ProjectsContent key={`${scopeKey}:${search}`} me={profile.data} scopeKey={scopeKey} />;
}
function ProjectsContent({ me, scopeKey }: { me: MemberProfile; scopeKey: string }) {
  const search = useSearch();
  const target = customerWorkLocation('projects', search, me.organization!.id);
  const exact = useExactCustomerWork('projects', target.kind === 'record' ? target.id : undefined, me.organization!.id, scopeKey);
  const actor = { id: me.id, organizationId: me.organization!.id, scopeKey };
  const prefillLeadId = new URLSearchParams(search).get('leadId') || undefined;
  const highlightId = target.kind === 'record' ? target.id : new URLSearchParams(search).get('highlight') || undefined;
  const wantsEdit = new URLSearchParams(search).get('edit') === '1';
  const highlightRef = useRef<HTMLDivElement | null>(null);
  const hasScrolledToHighlight = useRef(false);
  const hasAutoOpenedEdit = useRef(false);
  const [statusFilter, setStatusFilter] = useState<ProjectStatus | ''>('');
  const params = { status: statusFilter || undefined };
  const { data: list, isLoading, isError } = useListProjects(params, { query: { queryKey: [...getListProjectsQueryKey(params), scopeKey], enabled: !['invalid', 'different-company'].includes(target.kind) } });
  const loadedProjects = exact.data && 'name' in exact.data ? [exact.data as Project, ...(list ?? []).filter(item => item.id !== exact.data!.id)] : list;
  const projects = loadedProjects?.filter(item => (!item.organizationId || item.organizationId === me.organization!.id) && (!(item.customerWorkId || item.leadId === null) || !!returningProject(item)));
  const { data: users } = useListUsers({ query: { queryKey: [...getListUsersQueryKey(), scopeKey], enabled: !['invalid', 'different-company'].includes(target.kind) } });
  const queryClient = useQueryClient();

  const canEdit = canWrite(me?.role);
  const canDel = canDelete(me?.role);

  const [isFormOpen, setIsFormOpen] = useState(!!prefillLeadId || target.kind === 'new');
  const [editingProject, setEditingProject] = useState<Project | null>(null);

  const updateProject = useUpdateProject();
  const deleteProject = useDeleteProject();
  const alive = useRef(true); useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  useEffect(() => {
    if (highlightId && !isLoading && highlightRef.current && !hasScrolledToHighlight.current) {
      hasScrolledToHighlight.current = true;
      highlightRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [highlightId, isLoading, projects]);

  useEffect(() => {
    if (!wantsEdit || !highlightId || hasAutoOpenedEdit.current) return;
    if (isLoading || !me) return;
    if (!canWrite(me.role)) return;
    const target = projects?.find(p => p.id === highlightId);
    if (!target) return;
    hasAutoOpenedEdit.current = true;
    setEditingProject(target);
    setIsFormOpen(true);
  }, [wantsEdit, highlightId, isLoading, me, projects]);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: getListProjectsQueryKey() });

  // Lead labels are resolved server-side on the project itself, so they stay
  // correct in orgs with more leads than the capped lead-list download.
  const leadLabel = (project: Project) =>
    returningProject(project)?.customerLabel || project.leadLabel || project.leadId?.substring(0, 8) || 'Returning customer work';

  const crewNames = (crewUserIds: string[]) =>
    crewUserIds
      .map(id => {
        const user = users?.find(u => u.id === id);
        return user ? `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim() || user.email : id.substring(0, 8);
      })
      .join(', ');

  const handleStatusChange = (project: Project, status: ProjectStatus) => {
    if (returningProject(project)) { setEditingProject(project); setIsFormOpen(true); return; }
    updateProject.mutate({ id: project.id, data: { status, ...(project.updatedAt ? { expectedUpdatedAt: project.updatedAt } : {}) } }, {
      onSuccess: () => { if (!alive.current) return; invalidate(); if (status === 'completed') toast({ title: 'Job completed', description: 'The office invoice preparation handoff is ready, unless an invoice is already prepared. No invoice was sent.' }); },
      onError: (error: any) => { if (!alive.current) return; invalidate(); toast({ variant: 'destructive', title: 'Job status not saved', description: error?.data?.error || 'Refresh the job and try again.' }); },
    });
  };

  const handleDelete = (id: string) => {
    if (!confirm('Delete this project?')) return;
    deleteProject.mutate({ id }, { onSuccess: invalidate });
  };

  if (target.kind === 'invalid' || target.kind === 'different-company') return <p role="alert" className="p-5">This job link is invalid or belongs to another company. No company was switched.</p>;
  return (
    <div className="flex flex-col h-full bg-background overflow-hidden">
      <header className="px-4 py-3 md:px-6 md:py-4 border-b border-border flex flex-col md:flex-row items-start md:items-center justify-between bg-card shrink-0 gap-4 sticky top-0 z-10">
        <div>
          <h1 className="text-xl md:text-2xl font-bold tracking-tight text-foreground">Projects</h1>
          <p className="hidden md:block text-sm text-muted-foreground">Track scheduled and returning-customer work.</p>
        </div>
        <div className="flex items-center gap-3 w-full md:w-auto">
          <select
            value={statusFilter}
            onChange={e => setStatusFilter(e.target.value as ProjectStatus | '')}
            className="flex-1 md:w-48 bg-muted/50 border border-border rounded-xl px-4 py-2.5 md:py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary shadow-sm appearance-none bg-[url('data:image/svg+xml;charset=US-ASCII,%3Csvg%20width%3D%2224%22%20height%3D%2224%22%20fill%3D%22none%22%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%3E%3Cpath%20d%3D%22M7%2010L12%2015L17%2010%22%20stroke%3D%22%236B7280%22%20stroke-width%3D%222%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%2F%3E%3C%2Fsvg%3E')] bg-[position:right_0.5rem_center] bg-no-repeat pr-10"
          >
            <option value="">All Statuses</option>
            {STATUS_OPTIONS.map(option => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
          {canEdit && (
            <button
              aria-label="New Project"
              onClick={() => { setEditingProject(null); setIsFormOpen(true); }}
              className="bg-primary text-primary-foreground hover:bg-primary/90 px-4 py-2.5 md:px-3 md:py-2 rounded-xl text-sm font-semibold flex items-center justify-center gap-2 transition-transform active:scale-95 shrink-0 shadow-sm shadow-primary/20"
            >
              <Plus className="w-4 h-4" /> <span className="hidden md:inline">New Project</span>
            </button>
          )}
        </div>
      </header>

      <div className="flex-1 overflow-auto p-4 md:p-6 pb-20 md:pb-6">
        {target.kind === 'record' && <section aria-label="Selected job" className="mx-auto mb-4 max-w-5xl rounded-lg border p-3">{exact.isPending ? <p role="status">Opening exact job…</p> : exact.isError ? <p role="alert">The exact job is unavailable. The list below is separate and has not replaced it.</p> : <p>Selected job: {'name' in exact.data! ? exact.data.name : ''}</p>}</section>}
        {isError && <p role="alert">The job list could not load. No empty result is assumed.</p>}
        {projects?.length !== loadedProjects?.length && <p role="alert">Some job source contexts could not be verified. No actions are available for those records.</p>}
        {isLoading ? (
          <div className="flex items-center justify-center py-12 h-full">
            <Loader2 className="w-8 h-8 animate-spin text-primary" />
          </div>
        ) : (
          <div className="space-y-4 max-w-5xl mx-auto w-full">
            {projects?.map(project => (
              <div
                key={project.id}
                ref={project.id === highlightId ? highlightRef : undefined}
                className={`bg-card border rounded-2xl p-4 md:p-5 shadow-sm hover:shadow-md transition-all flex flex-col ${
                  project.id === highlightId ? 'border-primary ring-2 ring-primary/20 bg-primary/5' : 'border-border'
                }`}
              >
                <div className="flex flex-col md:flex-row items-start justify-between gap-4">
                  <div className="flex items-start gap-3 min-w-0 w-full md:w-auto">
                    <div className="w-10 h-10 md:w-12 md:h-12 rounded-xl bg-muted/50 border border-border flex items-center justify-center shrink-0 mt-1 md:mt-0">
                      <HardHat className="w-5 h-5 md:w-6 md:h-6 text-muted-foreground" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-col md:flex-row md:items-center gap-2 mb-1.5">
                        <h3 className="font-bold text-base md:text-lg text-foreground truncate">{project.name}</h3>
                        <span className={`w-fit text-[10px] font-bold uppercase tracking-widest px-2.5 py-0.5 rounded-md border ${STATUS_STYLES[project.status]}`}>
                          {project.status.replace('_', ' ')}
                        </span>
                      </div>
                      <div className="text-sm font-medium text-muted-foreground mt-1 flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-2">
                        <span className="flex items-center gap-1.5"><div className="w-1 h-1 rounded-full bg-primary" /> {returningProject(project) ? 'Customer' : 'Lead'}: {leadLabel(project)}</span>
                        {project.crewUserIds.length > 0 && <><span className="hidden sm:inline opacity-40">•</span><span className="flex items-center gap-1.5"><div className="w-1 h-1 rounded-full bg-secondary" /> Crew: {crewNames(project.crewUserIds)}</span></>}
                      </div>
                      {returningProject(project) && <div className="mt-2 flex flex-wrap items-center gap-3 text-sm"><p>{returningProject(project)!.propertyLabel || 'No property linked'}</p><Link className="inline-flex min-h-11 items-center underline" href={customerWorkspacePath(returningProject(project)!.contactId, me.organization!.id, 'projects')!}>Customer history</Link><Link className="inline-flex min-h-11 items-center underline" href={`/invoices?projectId=${project.id}&organizationId=${me.organization!.id}`}>Open job invoices</Link></div>}
                      
                      <div className="flex flex-col sm:flex-row flex-wrap items-start sm:items-center gap-2 sm:gap-4 text-[11px] font-mono text-muted-foreground uppercase tracking-wider mt-3 bg-muted/20 p-2.5 rounded-lg border border-border/50">
                        {project.scheduledStart ? (
                          <div className="flex items-center gap-1.5">
                             <div className="w-1.5 h-1.5 rounded-full bg-blue-500/50" />
                             <span>Start: <span className="font-bold text-foreground">{format(new Date(project.scheduledStart), 'MMM d, yyyy')}</span></span>
                          </div>
                        ) : <span className="opacity-50 italic">Unscheduled</span>}
                        
                        {project.scheduledEnd && (
                          <div className="flex items-center gap-1.5">
                             <span className="hidden sm:inline opacity-30">|</span>
                             <div className="w-1.5 h-1.5 rounded-full bg-orange-500/50" />
                             <span>End: <span className="font-bold text-foreground">{format(new Date(project.scheduledEnd), 'MMM d, yyyy')}</span></span>
                          </div>
                        )}
                        
                        {project.completedAt && (
                          <div className="flex items-center gap-1.5 text-green-600 dark:text-green-400 font-bold bg-green-500/10 px-2 py-0.5 rounded ml-0 sm:ml-auto">
                            <CheckCircle className="w-3 h-3" /> Done {format(new Date(project.completedAt), 'MMM d, yy')}
                          </div>
                        )}
                      </div>
                      
                      {project.crewNotes && (
                        <div className="mt-3 bg-card border border-border/60 p-3 rounded-lg">
                           <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground mb-1">Crew Notes</p>
                           <p className="text-sm text-foreground font-medium leading-relaxed">{project.crewNotes}</p>
                        </div>
                      )}
                    </div>
                  </div>
                  
                  <div className="flex flex-row md:flex-col items-center md:items-end w-full md:w-auto gap-2 md:gap-3 shrink-0 pt-4 md:pt-0 border-t border-border md:border-none mt-2 md:mt-0">
                    {canEdit ? (
                      <select
                        aria-label={`Recorded status for ${project.name}`}
                        value={project.status}
                        onChange={e => handleStatusChange(project, e.target.value as ProjectStatus)}
                        className="flex-1 md:flex-none bg-muted/50 border border-border rounded-xl px-3 py-2.5 md:py-1.5 text-xs font-bold uppercase tracking-widest focus:outline-none focus:ring-2 focus:ring-primary shadow-sm appearance-none bg-[url('data:image/svg+xml;charset=US-ASCII,%3Csvg%20width%3D%2224%22%20height%3D%2224%22%20fill%3D%22none%22%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%3E%3Cpath%20d%3D%22M7%2010L12%2015L17%2010%22%20stroke%3D%22%236B7280%22%20stroke-width%3D%222%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%2F%3E%3C%2Fsvg%3E')] bg-[position:right_0.5rem_center] bg-no-repeat pr-8"
                      >
                        {STATUS_OPTIONS.map(option => (
                          <option key={option.value} value={option.value}>{option.label}</option>
                        ))}
                      </select>
                    ) : (
                       <span className="flex-1 md:flex-none text-[10px] font-bold uppercase tracking-widest text-muted-foreground bg-muted/50 px-3 py-2 rounded-lg border border-border text-center md:text-right">{project.status.replace('_', ' ')}</span>
                    )}
                    
                    <div className="flex gap-2 shrink-0">
                       {canEdit && (
                         <button aria-label={`Edit ${project.name}`} onClick={() => { setEditingProject(project); setIsFormOpen(true); }} className="w-10 h-10 md:w-8 md:h-8 flex items-center justify-center text-muted-foreground hover:text-primary transition-all rounded-xl md:rounded-full bg-muted/50 md:bg-transparent border border-border md:border-transparent hover:bg-muted active:scale-95 shadow-sm md:shadow-none">
                           <Edit className="w-4 h-4 md:w-4 md:h-4" />
                         </button>
                       )}
                       {canDel && !returningProject(project) && (
                         <button onClick={() => handleDelete(project.id)} className="w-10 h-10 md:w-8 md:h-8 flex items-center justify-center text-muted-foreground hover:text-destructive transition-all rounded-xl md:rounded-full bg-muted/50 md:bg-transparent border border-border md:border-transparent hover:bg-destructive/10 active:scale-95 shadow-sm md:shadow-none">
                           <Trash2 className="w-4 h-4 md:w-4 md:h-4" />
                         </button>
                       )}
                    </div>
                  </div>
                </div>
              </div>
            ))}
            {!projects?.length && (
              <div className="py-12 text-center text-muted-foreground border-2 border-dashed border-border rounded-2xl bg-muted/10">
                No jobs yet. Create one for an opportunity or an existing customer.
              </div>
            )}
          </div>
        )}
      </div>

      {isFormOpen && canEdit && (
        returningProject(editingProject) ? <CustomerWorkForm kind="projects" actor={actor} record={returningProject(editingProject)!} onClose={() => setIsFormOpen(false)} onSaved={() => { if (target.kind === 'record') void exact.refetch(); }} />
          : <ProjectFormModal key={`${scopeKey}:${search}:${editingProject?.id ?? 'new'}`} authority={actor} project={editingProject} initialContactId={!editingProject && target.kind === 'new' ? target.contactId : undefined} initialLeadId={editingProject ? undefined : prefillLeadId} onClose={() => setIsFormOpen(false)} />
      )}
    </div>
  );
}
