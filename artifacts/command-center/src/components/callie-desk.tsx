import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useSearch } from "wouter";
import { getGetMeQueryKey, useGetMe } from "@workspace/api-client-react";
import { canManageSettings, canWrite } from "@/lib/permissions";
import { memberAuthorityScope } from "@/lib/member-authority-scope";
import CalliePolicyPanel from "./callie-policy-panel";
import CallieCasePanel from "./callie-case-panel";
import { callieButton as button, callieLabel, callieRequest, requestLabel, type CalliePage } from "./callie-contract";

export function CallieDesk({ refreshToken = 0 }: { refreshToken?: number }) {
  const me = useGetMe({ query: { queryKey: getGetMeQueryKey(), refetchOnMount: false } });
  if (me.isError || !me.data?.isActive || !me.data.organization) return null;
  const scopeKey = memberAuthorityScope(me.data);
  return <CalliePanel key={scopeKey} scopeKey={scopeKey} refreshToken={refreshToken} edit={canWrite(me.data.role)} manage={canManageSettings(me.data.role)} />;
}
function CalliePanel({ scopeKey, refreshToken, edit, manage }: { scopeKey: string; refreshToken: number; edit: boolean; manage: boolean }) {
  const [scope, setScope] = useState("attention"), [offset, setOffset] = useState(0), [page, setPage] = useState<CalliePage | null>(null), [loading, setLoading] = useState(true), [error, setError] = useState(""), [revision, setRevision] = useState(0);
  const generation = useRef(0), mounted = useRef(true), [, navigate] = useLocation();
  const selected = new URLSearchParams(useSearch()).get("callieId");
  const selectedValid = !!selected && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(selected);
  useEffect(() => {
    mounted.current = true; const run = ++generation.current, abort = new AbortController(); setLoading(true); setPage(null); setError("");
    void callieRequest<CalliePage>(`?scope=${scope}&offset=${offset}`, undefined, abort.signal).then(value => { if (mounted.current && generation.current === run) setPage(value); }).catch(failure => { if (!abort.signal.aborted && mounted.current && generation.current === run) setError(failure instanceof Error ? failure.message : "CALLIE work could not be loaded."); }).finally(() => { if (mounted.current && generation.current === run) setLoading(false); });
    return () => { mounted.current = false; generation.current++; abort.abort(); };
  }, [scope, offset, refreshToken, revision]);
  const refresh = () => setRevision(value => value + 1);
  return <section className="min-w-0 space-y-4 rounded-lg border bg-card p-4 md:p-5" aria-label="CALLIE automatic intake">
    <header className="space-y-2"><h2 className="text-lg font-semibold">CALLIE · Missed-call office desk</h2><p className="text-sm text-muted-foreground">See what the caller requested, who owns the response and what needs your attention. This is bounded keypad intake and one-call recovery, not a freeform AI receptionist.</p></header>
    <CalliePolicyPanel scopeKey={scopeKey} manage={manage} refreshToken={refreshToken} />
    <div className="flex flex-wrap items-end justify-between gap-3"><label className="text-sm">CALLIE worklist<select className="ml-2 min-h-11 rounded border bg-background p-2 text-base" value={scope} onChange={event => { setScope(event.target.value); setOffset(0); }}><option value="attention">Needs attention</option><option value="waiting">Waiting</option><option value="history">History</option></select></label><button className={button} disabled={loading} onClick={refresh}>Refresh CALLIE work</button></div>
    {error && <p role="alert" className="break-words text-sm text-destructive">{error}</p>}{loading && <p>Loading CALLIE work…</p>}
    {page && !loading && <>
      {page.companyHeld && <p role="status" className="rounded border p-3 text-sm">Company work is held. Reviewing this list does not resume customer contact.</p>}
      <p className="text-xs text-muted-foreground">{page.boundary} {scope === "history" ? "Most recently changed first." : "Oldest follow-up deadline first."} Showing up to {page.pageSize} on this page.</p>
      {!page.items.length ? <p className="text-sm">No CALLIE requests on this page. Older individually reviewed calls remain in the separate manual recovery section.</p> : <ul className="space-y-3">{page.items.map(item => <li className="min-w-0 space-y-2 rounded border p-3" key={item.id}>
        <div className="flex flex-wrap items-start justify-between gap-2"><h3 className="font-medium">{item.phone}</h3><span className="text-sm font-medium">{callieLabel(item.state)}</span></div>
        <p className="text-sm">{requestLabel(item)}{item.serviceIntent ? ` · ${callieLabel(item.serviceIntent)}` : ""}</p>
        <p className="text-sm">{item.owner.eligible ? item.owner.label : "Owner unavailable — assignment needs attention"} · due {new Date(item.dueAt).toLocaleString()}{item.overdue ? " · overdue" : ""}</p>
        <p className="text-xs text-muted-foreground">{item.callerReviewed ? "Staff caller review recorded" : "Caller identity unreviewed"} · {callieLabel(item.smsProof)}</p>
        <div className="flex flex-wrap gap-3 text-sm"><Link className="inline-flex min-h-11 items-center underline" href={`/calls?callieId=${item.id}`}>Review CALLIE request</Link><Link className="inline-flex min-h-11 items-center underline" href={`/tasks?taskId=${item.task.id}`}>Open callback task</Link>{item.leadId && <Link className="inline-flex min-h-11 items-center underline" href={`/leads/${item.leadId}`}>Open opportunity</Link>}</div>
      </li>)}</ul>}
      <div className="flex flex-wrap items-center justify-between gap-3"><button className={button} disabled={loading || !offset} onClick={() => setOffset(value => Math.max(0, value - page.pageSize))}>Previous CALLIE page</button><span className="text-xs">Page {Math.floor(offset / page.pageSize) + 1} · no whole-company count inferred</span><button className={button} disabled={loading || !page.hasMore} onClick={() => setOffset(value => value + page.pageSize)}>Next CALLIE page</button></div>
    </>}
    {selected && !selectedValid && <p role="alert">This CALLIE request link is invalid. Choose a saved request from the list.</p>}
    {selectedValid && <CallieCasePanel key={`${selected}:${refreshToken}`} scopeKey={scopeKey} id={selected!} editable={edit} onChanged={refresh} onClose={() => navigate("/calls")} />}
  </section>;
}
