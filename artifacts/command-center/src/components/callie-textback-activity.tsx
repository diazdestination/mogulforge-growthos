import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "wouter";

/**
 * CALLIE's own-number missed-call text-back activity: every text-back that was
 * sent, is waiting, or was skipped, with the plain reason it did not go.
 * Read-only; the reasons come from the server's execution ledger.
 */
type TextBackExecution = {
  id: string;
  state: string;
  detail: string;
  errorCode: string | null;
  linkedEntityType: string | null;
  linkedEntityId: string | null;
  requestSummary: Record<string, unknown>;
  createdAt: string;
  completedAt: string | null;
};

const STATE_LABEL: Record<string, string> = {
  succeeded: "Sent",
  pending_approval: "Waiting for approval",
  executing: "Sending",
  blocked: "Not sent",
  rejected: "Not sent · rejected",
  failed: "Not sent · failed",
  indeterminate: "Send result unknown",
};

const RECHECK_NOTE: Record<string, string> = {
  pending_approval: "Opt-outs, quiet hours, the per-caller limit and registration are checked again when someone approves.",
  indeterminate: "The phone app did not confirm the send. GrowthOS will not retry it; check the conversation in your phone app.",
};

export function CallieTextBackActivity({ refreshToken = 0 }: { refreshToken?: number }) {
  const [items, setItems] = useState<TextBackExecution[] | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const generation = useRef(0);
  const load = useCallback(async (signal: AbortSignal) => {
    const run = ++generation.current;
    setLoading(true); setError("");
    try {
      const response = await fetch("/api/v1/integrations/zapier/executions?capability=callie.sms.send&limit=25", { credentials: "include", signal });
      const body = await response.json().catch(() => ({})) as { executions?: TextBackExecution[]; error?: string };
      if (!response.ok) throw new Error(body.error ?? "Text-back activity could not be loaded.");
      if (generation.current === run) setItems(Array.isArray(body.executions) ? body.executions : []);
    } catch (failure) {
      if (!signal.aborted && generation.current === run) setError(failure instanceof Error ? failure.message : "Text-back activity could not be loaded.");
    } finally {
      if (!signal.aborted && generation.current === run) setLoading(false);
    }
  }, []);
  useEffect(() => {
    const abort = new AbortController();
    void load(abort.signal);
    return () => { abort.abort(); generation.current++; };
  }, [load, refreshToken, revision]);

  return <section className="min-w-0 space-y-3 rounded-lg border bg-card p-4 md:p-5" aria-label="CALLIE text-back activity">
    <header className="flex flex-wrap items-start justify-between gap-2">
      <div className="min-w-0 space-y-1">
        <h2 className="text-lg font-semibold">CALLIE · Missed-call text-back activity</h2>
        <p className="text-sm text-muted-foreground">Each missed call CALLIE read from your phone app, and whether a text-back went out. When one did not, the reason is shown; the callback task stays open either way.</p>
      </div>
      <button type="button" className="min-h-11 rounded border px-3 text-sm" disabled={loading} onClick={() => setRevision(value => value + 1)}>Refresh text-back activity</button>
    </header>
    {error && <p role="alert" className="break-words text-sm text-destructive">{error}</p>}
    {loading && !items && <p role="status" className="text-sm">Loading text-back activity…</p>}
    {items && !items.length && !error && <p className="text-sm">No missed-call text-backs yet. Text-back runs only after your texting registration is confirmed and its policy is switched on in Settings.</p>}
    {items && items.length > 0 && <ul className="space-y-2">{items.map(item => {
      const phone = typeof item.requestSummary?.toPhone === "string" ? item.requestSummary.toPhone : null;
      return <li key={item.id} className="min-w-0 space-y-1 rounded border p-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <span className="font-medium">{phone ?? "Caller number not on record"}</span>
          <span className={`text-sm font-medium ${item.state === "succeeded" ? "" : "text-muted-foreground"}`}>{STATE_LABEL[item.state] ?? item.state}</span>
        </div>
        {item.state !== "succeeded" && item.detail && <p className="break-words text-sm">{item.detail}</p>}
        {RECHECK_NOTE[item.state] && <p className="text-xs text-muted-foreground">{RECHECK_NOTE[item.state]}</p>}
        <div className="flex flex-wrap items-center gap-x-3 text-xs text-muted-foreground">
          <span>{new Date(item.completedAt ?? item.createdAt).toLocaleString()}</span>
          {item.linkedEntityType === "crm_task" && item.linkedEntityId && <Link className="inline-flex min-h-11 items-center underline" href={`/tasks?taskId=${item.linkedEntityId}`}>Open callback task</Link>}
        </div>
      </li>;
    })}</ul>}
  </section>;
}
