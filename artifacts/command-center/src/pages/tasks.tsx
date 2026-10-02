import { useMemo, useState } from 'react';
import { Loader2, Plus, CheckSquare, Trash2, Edit, CheckCircle, Link2, X } from 'lucide-react';
import { Link, useLocation, useSearch } from 'wouter';
import { canWrite, canDelete } from '@/lib/permissions';
import { useGetMe } from '@workspace/api-client-react';
import { format } from 'date-fns';
import LeadSelect from '@/components/lead-select';
import { useListTasks, useCreateTask, useUpdateTask, useDeleteTask, getListTasksQueryKey, TaskStatus, Urgency, useListUsers, updateTask as updateTaskRequest, deleteTask as deleteTaskRequest } from '@workspace/api-client-react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { ToastAction } from '@/components/ui/toast';
import { useToast, toast as globalToast } from '@/hooks/use-toast';
import { TaskDeepLink } from '@/components/task-deep-link';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';

export default function Tasks() {
  const [, navigate] = useLocation();
  const search = new URLSearchParams(useSearch());
  const selectedTaskId = search.get('taskId');
  const closeSelectedTask = () => {
    search.delete('taskId');
    navigate(`/tasks${search.size ? `?${search}` : ''}`, { replace: true });
  };
  const [statusFilter, setStatusFilter] = useState<TaskStatus | ''>('');
  
  const { data: tasks, isLoading } = useListTasks({ status: statusFilter || undefined });
  const { data: me } = useGetMe();
  const queryClient = useQueryClient();
  
  const canEdit = canWrite(me?.role);
  const canDel = canDelete(me?.role);

  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingTask, setEditingTask] = useState<any>(null);

  const updateTask = useUpdateTask();
  const deleteTask = useDeleteTask();

  const handleStatusToggle = (task: any) => {
    if (!canEdit) return;
    const newStatus = task.status === 'done' ? 'open' : 'done';
    updateTask.mutate({ id: task.id, data: { status: newStatus } }, {
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: getListTasksQueryKey() });
        void queryClient.invalidateQueries({ queryKey: ['task-detail'] });
        void queryClient.invalidateQueries({ queryKey: ['contractor-day'] });
      },
      onError: () => showTaskStatusFailedToast(task.id, newStatus, queryClient),
    });
  };

  const handleDelete = (id: string) => {
    if (!confirm('Delete this task?')) return;
    deleteTask.mutate({ id }, {
      onSuccess: () => queryClient.invalidateQueries({ queryKey: getListTasksQueryKey() }),
      onError: () => showTaskDeleteFailedToast(id, queryClient),
    });
  };

  const openEdit = (task: any) => {
    setEditingTask(task);
    setIsFormOpen(true);
  };

  const openCreate = () => {
    setEditingTask(null);
    setIsFormOpen(true);
  };

  return (
    <div className="flex flex-col h-full bg-background overflow-hidden">
      <header className="px-4 py-3 md:px-6 md:py-4 border-b border-border flex flex-col md:flex-row items-start md:items-center justify-between bg-card shrink-0 gap-4 sticky top-0 z-10">
        <div>
          <h1 className="text-xl md:text-2xl font-bold tracking-tight text-foreground">Tasks</h1>
          <p className="hidden md:block text-sm text-muted-foreground">Manage your action items.</p>
        </div>
        <div className="flex items-center gap-3 w-full md:w-auto">
          <select 
            aria-label="Task status"
            value={statusFilter}
            onChange={e => setStatusFilter(e.target.value as any)}
            className="flex-1 md:w-48 bg-muted/50 border border-border rounded-xl px-4 py-2.5 md:py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary shadow-sm appearance-none bg-[url('data:image/svg+xml;charset=US-ASCII,%3Csvg%20width%3D%2224%22%20height%3D%2224%22%20fill%3D%22none%22%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%3E%3Cpath%20d%3D%22M7%2010L12%2015L17%2010%22%20stroke%3D%22%236B7280%22%20stroke-width%3D%222%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%2F%3E%3C%2Fsvg%3E')] bg-[position:right_0.5rem_center] bg-no-repeat pr-10"
          >
            <option value="">All Statuses</option>
            <option value="open">Open</option>
            <option value="in_progress">In Progress</option>
            <option value="done">Done</option>
            <option value="cancelled">Cancelled</option>
          </select>
          {canEdit && (
            <button aria-label="Add task" data-testid="add-task" onClick={openCreate} className="bg-primary text-primary-foreground hover:bg-primary/90 px-4 py-2.5 md:px-3 md:py-2 rounded-xl text-sm font-semibold flex items-center justify-center gap-2 transition-transform active:scale-95 shrink-0 shadow-sm shadow-primary/20">
              <Plus className="w-4 h-4" /> <span className="hidden md:inline">Add Task</span>
            </button>
          )}
        </div>
      </header>

      <div className="flex-1 overflow-auto p-4 md:p-6 pb-20 md:pb-6">
        {isLoading ? (
          <div className="flex items-center justify-center py-12 h-full">
            <Loader2 className="w-8 h-8 animate-spin text-primary" />
          </div>
        ) : (
          <div className="space-y-4 max-w-4xl mx-auto w-full">
            {tasks?.map(task => (
              <div key={task.id} className={`bg-card border border-border rounded-2xl p-4 md:p-5 flex flex-col md:flex-row items-start gap-4 transition-all shadow-sm ${task.status === 'done' ? 'opacity-70 bg-muted/30 border-dashed' : 'hover:shadow-md relative group'}`}>
                
                <div className="flex w-full md:w-auto items-start gap-4">
                  <button 
                    data-testid="toggle-task-status"
                    aria-label={task.status === 'done' ? `Mark "${task.title}" as open` : `Mark "${task.title}" as done`}
                    onClick={() => handleStatusToggle(task)}
                    disabled={!canEdit}
                    className={`mt-0.5 md:mt-1 w-7 h-7 md:w-6 md:h-6 rounded-lg md:rounded flex items-center justify-center border shrink-0 transition-all active:scale-95 shadow-sm ${
                      task.status === 'done' ? 'bg-green-500 border-green-500 text-primary-foreground' : 'bg-background border-border text-transparent hover:border-primary focus:ring-2 focus:ring-primary focus:outline-none'
                    }`}
                  >
                    <CheckSquare className="w-4 h-4 md:w-3.5 md:h-3.5" />
                  </button>
                  
                  <div className="flex-1 min-w-0 md:hidden">
                    <h3 className={`font-bold text-[15px] leading-tight ${task.status === 'done' ? 'line-through text-muted-foreground' : 'text-foreground'}`}>
                      {task.title}
                    </h3>
                  </div>
                  
                  <div className="md:hidden flex gap-2 shrink-0">
                     {canEdit && (
                       <button data-testid="edit-task" aria-label={`Edit task "${task.title}"`} onClick={() => openEdit(task)} className="w-8 h-8 flex items-center justify-center text-muted-foreground hover:text-primary transition-all rounded-full bg-muted/50 border border-border active:scale-95 shadow-sm">
                         <Edit className="w-4 h-4" />
                       </button>
                     )}
                     {canDel && (
                       <button data-testid="delete-task" aria-label={`Delete task "${task.title}"`} onClick={() => handleDelete(task.id)} className="w-8 h-8 flex items-center justify-center text-muted-foreground hover:text-destructive transition-all rounded-full bg-muted/50 border border-border active:scale-95 shadow-sm">
                         <Trash2 className="w-4 h-4" />
                       </button>
                     )}
                  </div>
                </div>
                
                <div className="flex-1 min-w-0 w-full md:w-auto ml-11 md:ml-0">
                  <div className="hidden md:flex justify-between items-start mb-1.5">
                    <h3 className={`font-bold text-base leading-tight ${task.status === 'done' ? 'line-through text-muted-foreground' : 'text-foreground'}`}>
                      {task.title}
                    </h3>
                    <div className="flex items-center gap-2 shrink-0 ml-4">
                      {task.priority !== 'normal' && (
                        <span className={`text-[10px] font-bold uppercase tracking-widest px-2.5 py-0.5 rounded-md border ${
                          task.priority === 'emergency' ? 'bg-destructive/10 text-destructive border-destructive/20' :
                          task.priority === 'high' ? 'bg-secondary/15 text-secondary border-secondary/30' : 'bg-muted text-muted-foreground border-border/50'
                        }`}>
                          {task.priority}
                        </span>
                      )}
                    </div>
                  </div>
                  
                  {/* Mobile Priority Badge */}
                  <div className="md:hidden mb-2">
                     {task.priority !== 'normal' && (
                        <span className={`text-[10px] font-bold uppercase tracking-widest px-2.5 py-0.5 rounded-md border ${
                          task.priority === 'emergency' ? 'bg-destructive/10 text-destructive border-destructive/20' :
                          task.priority === 'high' ? 'bg-secondary/15 text-secondary border-secondary/30' : 'bg-muted text-muted-foreground border-border/50'
                        }`}>
                          {task.priority}
                        </span>
                      )}
                  </div>
                  
                  {task.description && (
                    <p className={`text-sm mb-3 line-clamp-2 leading-relaxed ${task.status === 'done' ? 'text-muted-foreground/70' : 'text-muted-foreground'}`}>{task.description}</p>
                  )}

                  {task.leadId && (
                    <Link
                      href={`/leads/${task.leadId}`}
                      data-testid={`task-lead-link-${task.id}`}
                      className="inline-flex items-center gap-1.5 text-[13px] font-bold text-primary hover:text-primary/80 transition-colors mb-3 bg-primary/5 px-2.5 py-1 rounded-lg border border-primary/10 active:scale-[0.98]"
                    >
                      <Link2 className="w-3.5 h-3.5" />
                      {task.leadLabel || 'View lead'}
                    </Link>
                  )}
                  
                  <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4 text-[11px] font-mono text-muted-foreground uppercase tracking-wider bg-muted/20 p-2.5 rounded-lg border border-border/50 mt-1">
                    {task.dueAt && (
                      <div className={`flex items-center gap-1.5 ${new Date(task.dueAt) < new Date() && task.status !== 'done' ? 'text-destructive font-bold' : ''}`}>
                         <span className="opacity-50">Due:</span> 
                         <span className={new Date(task.dueAt) < new Date() && task.status !== 'done' ? '' : 'text-foreground font-medium'}>{format(new Date(task.dueAt), 'MMM d, yyyy')}</span>
                      </div>
                    )}
                    {task.status !== 'open' && task.status !== 'done' && (
                      <div className="flex items-center gap-1.5">
                         <span className="hidden sm:inline opacity-30">|</span>
                         <span className="opacity-50">Status:</span>
                         <span className="text-foreground font-medium">{task.status.replace('_', ' ')}</span>
                      </div>
                    )}
                  </div>
                </div>
                
                <div className="hidden md:flex flex-col gap-2 shrink-0 ml-4">
                  {canEdit && (
                    <button data-testid="edit-task" aria-label={`Edit task "${task.title}"`} onClick={() => openEdit(task)} className="opacity-0 group-hover:opacity-100 p-2 text-muted-foreground hover:text-primary transition-all rounded-lg hover:bg-muted active:scale-95">
                      <Edit className="w-4 h-4" />
                    </button>
                  )}
                  {canDel && (
                    <button data-testid="delete-task" aria-label={`Delete task "${task.title}"`} onClick={() => handleDelete(task.id)} className="opacity-0 group-hover:opacity-100 p-2 text-muted-foreground hover:text-destructive transition-all rounded-lg hover:bg-muted active:scale-95">
                      <Trash2 className="w-4 h-4" />
                    </button>
                  )}
                </div>
              </div>
            ))}
            {!tasks?.length && (
              <div className="py-12 text-center text-muted-foreground border-2 border-dashed border-border rounded-2xl bg-muted/10">
                No tasks found.
              </div>
            )}
          </div>
        )}
      </div>

      {selectedTaskId && me?.organization && !isFormOpen && (
        <TaskDeepLink
          key={`${me.id}:${me.organization.id}:${selectedTaskId}`}
          taskId={selectedTaskId}
          organizationId={me.organization.id}
          role={me.role}
          busy={updateTask.isPending}
          onClose={closeSelectedTask}
          onEdit={openEdit}
          onToggle={handleStatusToggle}
        />
      )}
      {isFormOpen && canEdit && (
        <TaskFormModal 
          task={editingTask} 
          onClose={() => setIsFormOpen(false)} 
        />
      )}
    </div>
  );
}

/**
 * Error toasts with a Retry action for the page's one-shot mutations. Module
 * level (global toast store + plain fetch client) so retrying keeps working
 * across re-renders — same pattern as showStatusChangeFailedToast in pipeline.tsx.
 */
function showTaskStatusFailedToast(taskId: string, status: 'open' | 'done', queryClient: QueryClient) {
  const { dismiss } = globalToast({
    variant: 'destructive',
    title: 'Task not updated',
    description: `Marking the task as ${status} failed. Retry below.`,
    action: (
      <ToastAction
        altText="Retry task status update"
        onClick={async () => {
          try {
            await updateTaskRequest(taskId, { status });
            queryClient.invalidateQueries({ queryKey: getListTasksQueryKey() });
            queryClient.invalidateQueries({ queryKey: ['task-detail'] });
            queryClient.invalidateQueries({ queryKey: ['contractor-day'] });
            dismiss();
          } catch {
            showTaskStatusFailedToast(taskId, status, queryClient);
          }
        }}
      >
        Retry
      </ToastAction>
    ),
  });
}
function TaskFormModal({ task, onClose }: { task?: any, onClose: () => void }) {
  const [title, setTitle] = useState(task?.title || '');
  const [desc, setDesc] = useState(task?.description || '');
  const [priority, setPriority] = useState<Urgency>(task?.priority || 'normal');
  const [dueAt, setDueAt] = useState(task?.dueAt ? new Date(task.dueAt).toISOString().split('T')[0] : '');
  const [leadId, setLeadId] = useState(task?.leadId || '');
  const [assigneeId, setAssigneeId] = useState(task?.assignedUserId || '');
  
  const { data: users } = useListUsers();
  const createTask = useCreateTask();
  const updateTask = useUpdateTask();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const isSubmitting = createTask.isPending || updateTask.isPending;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title) return;

    const data = {
      title,
      description: desc || undefined,
      priority,
      dueAt: dueAt ? new Date(dueAt).toISOString() : undefined,
      leadId: leadId || undefined,
      assignedUserId: assigneeId || undefined,
    };

    const handleSaveError = (error: unknown) => {
      const serverMessage =
        error && typeof error === 'object' && 'data' in error
          ? (error as { data?: { error?: string } }).data?.error
          : undefined;
      toast({
        variant: 'destructive',
        title: task ? 'Task not saved' : 'Task not created',
        description: serverMessage || 'Saving the task failed. Check your connection and try again.',
      });
    };

    if (task) {
      updateTask.mutate({ id: task.id, data }, {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListTasksQueryKey() });
          queryClient.invalidateQueries({ queryKey: ['task-detail'] });
          queryClient.invalidateQueries({ queryKey: ['contractor-day'] });
          onClose();
        },
        onError: handleSaveError,
      });
    } else {
      createTask.mutate({ data }, {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListTasksQueryKey() });
          onClose();
        },
        onError: handleSaveError,
      });
    }
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !isSubmitting) onClose(); }}>
      <DialogContent className="max-w-md bg-card p-0 text-card-foreground">
        <div className="p-4 md:p-6 border-b border-border flex justify-between items-center bg-muted/20">
          <DialogTitle className="text-lg font-bold text-foreground">{task ? 'Edit Task' : 'New Task'}</DialogTitle>
          <DialogDescription className="sr-only">Review the task details before saving.</DialogDescription>
        </div>
        <form onSubmit={handleSubmit} className="p-4 md:p-6 space-y-4 md:space-y-5">
          <div className="space-y-1.5">
            <label className="text-[10px] md:text-xs font-bold text-muted-foreground uppercase tracking-widest">Title *</label>
            <input aria-label="Title" required className="w-full bg-background border border-border rounded-xl px-4 py-3 md:py-2.5 text-base md:text-sm focus:ring-2 focus:ring-primary focus:outline-none shadow-sm transition-all" value={title} onChange={e => setTitle(e.target.value)} />
          </div>
          
          <div className="space-y-1.5">
            <label className="text-[10px] md:text-xs font-bold text-muted-foreground uppercase tracking-widest">Description</label>
            <textarea aria-label="Description" className="w-full bg-background border border-border rounded-xl px-4 py-3 md:py-2.5 text-base md:text-sm focus:ring-2 focus:ring-primary focus:outline-none min-h-[80px] resize-none shadow-sm transition-all" value={desc} onChange={e => setDesc(e.target.value)} />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label className="text-[10px] md:text-xs font-bold text-muted-foreground uppercase tracking-widest">Priority</label>
              <select aria-label="Priority" className="w-full bg-background border border-border rounded-xl px-4 py-3 md:py-2.5 text-base md:text-sm focus:ring-2 focus:ring-primary focus:outline-none shadow-sm transition-all appearance-none bg-[url('data:image/svg+xml;charset=US-ASCII,%3Csvg%20width%3D%2224%22%20height%3D%2224%22%20fill%3D%22none%22%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%3E%3Cpath%20d%3D%22M7%2010L12%2015L17%2010%22%20stroke%3D%22%236B7280%22%20stroke-width%3D%222%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%2F%3E%3C%2Fsvg%3E')] bg-[position:right_0.5rem_center] bg-no-repeat pr-10" value={priority} onChange={e => setPriority(e.target.value as Urgency)}>
                <option value="low">Low</option>
                <option value="normal">Normal</option>
                <option value="high">High</option>
                <option value="emergency">Emergency</option>
              </select>
            </div>
            <div className="space-y-1.5">
              <label className="text-[10px] md:text-xs font-bold text-muted-foreground uppercase tracking-widest">Due Date</label>
              <input aria-label="Due date" type="date" className="w-full bg-background border border-border rounded-xl px-4 py-3 md:py-2.5 text-base md:text-sm focus:ring-2 focus:ring-primary focus:outline-none font-mono shadow-sm transition-all" value={dueAt} onChange={e => setDueAt(e.target.value)} />
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="text-[10px] md:text-xs font-bold text-muted-foreground uppercase tracking-widest">Assignee</label>
            <select aria-label="Assignee" className="w-full bg-background border border-border rounded-xl px-4 py-3 md:py-2.5 text-base md:text-sm focus:ring-2 focus:ring-primary focus:outline-none shadow-sm transition-all appearance-none bg-[url('data:image/svg+xml;charset=US-ASCII,%3Csvg%20width%3D%2224%22%20height%3D%2224%22%20fill%3D%22none%22%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%3E%3Cpath%20d%3D%22M7%2010L12%2015L17%2010%22%20stroke%3D%22%236B7280%22%20stroke-width%3D%222%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%2F%3E%3C%2Fsvg%3E')] bg-[position:right_0.5rem_center] bg-no-repeat pr-10" value={assigneeId} onChange={e => setAssigneeId(e.target.value)}>
              <option value="">-- Unassigned --</option>
              {users?.map(u => (
                <option key={u.id} value={u.id}>{u.firstName} {u.lastName}</option>
              ))}
            </select>
          </div>

          <div className="space-y-1.5">
            <label className="text-[10px] md:text-xs font-bold text-muted-foreground uppercase tracking-widest">Related Lead</label>
            <div className="shadow-sm rounded-xl overflow-hidden border border-border focus-within:ring-2 focus-within:ring-primary focus-within:border-primary transition-all">
               <LeadSelect label="Related lead" value={leadId} onChange={setLeadId} />
            </div>
          </div>
          
          <div className="pt-6 md:pt-4 flex flex-col-reverse md:flex-row justify-end gap-3">
            <button type="button" onClick={onClose} className="w-full md:w-auto px-4 py-3 md:py-2 text-base md:text-sm font-semibold hover:bg-muted rounded-xl border border-transparent hover:border-border transition-all active:scale-95">Cancel</button>
            <button type="submit" disabled={isSubmitting} className="w-full md:w-auto bg-primary text-primary-foreground dark:text-background px-6 py-3 md:py-2 rounded-xl text-base md:text-sm font-bold shadow-sm shadow-primary/20 hover:shadow-primary/40 hover:bg-primary/90 transition-all active:scale-95 disabled:opacity-50 flex items-center justify-center min-w-[120px]">
              {isSubmitting ? <Loader2 className="w-5 h-5 animate-spin" /> : 'Save Task'}
            </button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function showTaskDeleteFailedToast(taskId: string, queryClient: QueryClient) {
  const { dismiss } = globalToast({
    variant: 'destructive',
    title: 'Task not deleted',
    description: 'Deleting the task failed. Retry below.',
    action: (
      <ToastAction
        altText="Retry task delete"
        onClick={async () => {
          try {
            await deleteTaskRequest(taskId);
            queryClient.invalidateQueries({ queryKey: getListTasksQueryKey() });
            dismiss();
          } catch {
            showTaskDeleteFailedToast(taskId, queryClient);
          }
        }}
      >
        Retry
      </ToastAction>
    ),
  });
}
