import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import type { CrmTask, UserRole } from "@workspace/api-client-react";
import { contractorRequest } from "@/lib/contractor-api";
import { canWrite } from "@/lib/permissions";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

const button =
  "inline-flex min-h-11 items-center justify-center rounded-lg border border-input bg-background px-4 py-2 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";
export const taskDetailKey = (organizationId: string, taskId: string) => [
  "task-detail",
  organizationId,
  taskId,
];

/** Load the exact linked record, independently of the recent tasks list. */
export function TaskDeepLink({
  taskId,
  organizationId,
  role,
  busy,
  onClose,
  onEdit,
  onToggle,
}: {
  taskId: string;
  organizationId: string;
  role: UserRole;
  busy: boolean;
  onClose: () => void;
  onEdit: (task: CrmTask) => void;
  onToggle: (task: CrmTask) => void;
}) {
  const validId =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      taskId,
    );
  const detail = useQuery({
    queryKey: taskDetailKey(organizationId, taskId),
    queryFn: async ({ signal }) => {
      const task = await contractorRequest<CrmTask>(
        `/tasks/${encodeURIComponent(taskId)}`,
        { signal },
      );
      if (task.id !== taskId || task.organizationId !== organizationId)
        throw new Error("Task context changed");
      return task;
    },
    enabled: validId,
    retry: false,
    staleTime: 0,
  });
  const task = detail.data;
  const unavailable = !validId || detail.isError;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-w-xl bg-card text-card-foreground">
        <DialogHeader>
          <DialogTitle className="pr-5 leading-snug break-words">
            Task details
          </DialogTitle>
          <DialogDescription>
            Review the exact task opened from your work day.
          </DialogDescription>
        </DialogHeader>
        {unavailable ? (
          <div role="alert" className="space-y-3">
            <p>
              This task is unavailable. It may have been removed, or your access
              may have changed.
            </p>
            {validId && (
              <button
                className={button}
                disabled={detail.isFetching}
                onClick={() => void detail.refetch()}
              >
                Retry task lookup
              </button>
            )}
          </div>
        ) : detail.isPending ? (
          <p role="status">Loading task…</p>
        ) : task ? (
          <div className="min-w-0 space-y-4">
            <h2 className="break-words text-xl font-semibold">{task.title}</h2>
            {task.description && (
              <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">
                {task.description}
              </p>
            )}
            <dl className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <dt className="text-muted-foreground">Status</dt>
                <dd>{task.status.replaceAll("_", " ")}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Priority</dt>
                <dd>{task.priority}</dd>
              </div>
              <div className="col-span-2">
                <dt className="text-muted-foreground">Due</dt>
                <dd>
                  {task.dueAt
                    ? new Intl.DateTimeFormat("en-US", {
                        dateStyle: "medium",
                        timeStyle: "short",
                      }).format(new Date(task.dueAt))
                    : "Not scheduled"}
                  {task.dueAt && (
                    <span className="ml-1 text-muted-foreground">
                      ({Intl.DateTimeFormat().resolvedOptions().timeZone})
                    </span>
                  )}
                </dd>
              </div>
            </dl>
            {task.leadId && (
              <Link
                href={`/leads/${encodeURIComponent(task.leadId)}`}
                className={`${button} underline`}
                onClick={onClose}
              >
                {task.leadLabel || "Open customer opportunity"}
              </Link>
            )}
            {canWrite(role) && (
              <div className="flex flex-wrap gap-2 border-t border-border pt-4">
                <button
                  className={button}
                  disabled={busy || detail.isFetching}
                  onClick={() => onEdit(task)}
                >
                  Edit this task
                </button>
                {task.status !== "cancelled" && (
                  <button
                    className={button}
                    disabled={busy || detail.isFetching}
                    onClick={() => onToggle(task)}
                  >
                    {task.status === "done" ? "Reopen task" : "Mark task done"}
                  </button>
                )}
              </div>
            )}
            {detail.isFetching && (
              <p role="status" className="text-sm text-muted-foreground">
                Refreshing task status…
              </p>
            )}
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
