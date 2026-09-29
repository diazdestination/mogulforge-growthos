import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useGetSession } from "@workspace/api-client-react";
import { Activity, RefreshCw } from "lucide-react";

interface RuntimeHealth {
  serverNow: string;
  health:
    "not_observed" | "stopped" | "stale" | "degraded" | "running" | "healthy";
  staleAfterSeconds: number;
  heartbeatAt: string | null;
  completedAt: string | null;
  currentStage: string | null;
  failedStages: string[];
  queue: {
    pending: number;
    due: number;
    failed: number;
    oldestDueAt: string | null;
  };
  executionsNeedingReview: number;
  failedWebhookDeliveries: number;
  boundary: string;
}
const labels = {
  not_observed: "No worker observed",
  stopped: "Worker stopped",
  stale: "Worker heartbeat overdue",
  degraded: "Background work needs attention",
  running: "Processing background work",
  healthy: "Background work is current",
};
const guidance = {
  not_observed:
    "No scheduler heartbeat has been recorded. Verify the schema and start the always-on application before onboarding a client.",
  stopped:
    "The worker shut down. Verify that the application has restarted before relying on scheduled follow-up.",
  stale:
    "Progress has not been recorded within five minutes. Check application health and logs. Do not replay an action with an uncertain result.",
  degraded:
    "One or more stages failed. Check the stage names below and the owning client's records before taking action.",
  running:
    "A cycle is in progress. This confirms background processing, not successful delivery to a customer.",
  healthy:
    "The latest cycle finished and its heartbeat is recent. Check overdue work and execution reviews separately.",
};
const displayTime = (value: string | null) =>
  value ? new Date(value).toLocaleString() : "Not recorded";

export function RuntimeHealthPanel() {
  const session = useGetSession();
  const admin = session.data?.isPlatformAdmin === true;
  const query = useQuery({
    // A previous administrator's aggregate data must not cross a session change.
    queryKey: ["platform-runtime", session.data?.id],
    enabled: admin,
    refetchInterval: 30_000,
    retry: false,
    queryFn: async ({ signal }) => {
      const response = await fetch("/api/v1/platform/runtime", {
        credentials: "include",
        cache: "no-store",
        signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
      });
      if (!response.ok) throw new Error("Runtime health is unavailable.");
      return (await response.json()) as RuntimeHealth;
    },
  });
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(timer);
  }, []);
  if (!admin) return null;
  const data = query.data;
  const unavailable =
    query.isError || (data && now - query.dataUpdatedAt > 90_000);
  // Age cached data using server time, so a clock difference on the operator's
  // laptop cannot create a false green heartbeat between refreshes.
  const heartbeatOld =
    data?.heartbeatAt &&
    Date.parse(data.serverNow) +
      Math.max(0, now - query.dataUpdatedAt) -
      Date.parse(data.heartbeatAt) >
      data.staleAfterSeconds * 1_000;
  const health =
    data && heartbeatOld && data.health !== "stopped" ? "stale" : data?.health;
  return (
    <section
      aria-labelledby="runtime-heading"
      className="space-y-4 rounded-xl border bg-card p-5"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="mb-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Platform operations
          </p>
          <h2
            id="runtime-heading"
            className="flex items-center gap-2 text-xl font-semibold"
          >
            <Activity size={20} aria-hidden="true" /> Follow-up reliability
          </h2>
        </div>
        <button
          type="button"
          onClick={() => void query.refetch()}
          disabled={query.isFetching}
          className="inline-flex min-h-10 items-center gap-2 rounded-lg border px-3 py-2 text-sm disabled:opacity-50"
        >
          <RefreshCw size={16} aria-hidden="true" /> Refresh runtime health
        </button>
      </div>
      {unavailable ? (
        <p
          role="alert"
          className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm"
        >
          Runtime health is unavailable or out of date. Last known results are
          hidden until a fresh check succeeds.
        </p>
      ) : !data || !health ? (
        <p role="status">Checking background work…</p>
      ) : (
        <>
          <div
            role="status"
            className={`rounded-lg border p-4 ${health === "healthy" || health === "running" ? "border-primary/30 bg-primary/5" : "border-amber-500/40 bg-amber-500/10"}`}
          >
            <h3 className="font-semibold">{labels[health]}</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              {guidance[health]}
            </p>
          </div>
          <dl className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {(
              [
                ["Due scheduled actions", data.queue.due],
                ["Executions needing review", data.executionsNeedingReview],
                ["Failed scheduled records", data.queue.failed],
                ["Failed webhook records", data.failedWebhookDeliveries],
              ] as const
            ).map(([label, value]) => (
              <div key={label} className="min-w-0 rounded-lg bg-muted/50 p-3">
                <dt className="text-xs text-muted-foreground">{label}</dt>
                <dd className="mt-1 text-2xl font-semibold tabular-nums">
                  {value.toLocaleString()}
                </dd>
              </div>
            ))}
          </dl>
          {data.executionsNeedingReview > 0 && (
            <p role="alert" className="text-sm">
              An action may already have happened. Use Client operations below
              to identify the workspace, then review its execution evidence in
              Revenue Desk. Do not send again until the result is reconciled.
            </p>
          )}
          <div className="grid gap-2 text-sm text-muted-foreground md:grid-cols-2">
            <p>Last progress: {displayTime(data.heartbeatAt)}</p>
            <p>Last completed cycle: {displayTime(data.completedAt)}</p>
            <p>Oldest due action: {displayTime(data.queue.oldestDueAt)}</p>
            <p>Current stage: {data.currentStage ?? "None"}</p>
          </div>
          {data.failedStages.length > 0 && (
            <p className="break-words text-sm">
              Stages needing attention: {data.failedStages.join(", ")}
            </p>
          )}
          <p className="border-t pt-3 text-xs text-muted-foreground">
            {data.boundary}
          </p>
        </>
      )}
    </section>
  );
}
