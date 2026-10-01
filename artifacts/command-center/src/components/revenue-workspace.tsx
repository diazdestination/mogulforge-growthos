import { useRef, useState, type FormEvent, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { useGetMe, type UserRole } from "@workspace/api-client-react";
import {
  ArrowUpRight,
  CheckCircle2,
  Clock3,
  FileCheck2,
  ShieldCheck,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import { canManageSettings, canWrite } from "@/lib/permissions";

export async function revenueRequest<T>(
  path: string,
  body?: unknown,
  method = body ? "POST" : "GET",
): Promise<T> {
  const response = await fetch(`/api/v1${path}`, {
    method,
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const value = await response.json();
  if (!response.ok)
    throw new Error(
      value.error || "The workspace could not complete this request.",
    );
  return value;
}
const button =
  "inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border border-border bg-background px-3 py-2 text-sm font-medium hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-50";
const input =
  "w-full min-w-0 rounded-lg border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40";
const money = (cents: number) =>
  (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
const date = (value?: string | null) =>
  value ? new Date(value).toLocaleString() : "Not recorded";
export function parseRecordedCents(value: string) {
  if (!/^\d{1,8}(\.\d{1,2})?$/.test(value))
    throw new Error("Enter a positive dollar amount with up to two decimals.");
  const [whole, decimal = ""] = value.split(".");
  const cents = Number(whole) * 100 + Number(decimal.padEnd(2, "0"));
  if (cents <= 0 || cents > 1_000_000_000)
    throw new Error("Amount must be between $0.01 and $10,000,000.");
  return cents;
}
interface LeadRecord {
  id: string;
  summary: string | null;
  status: string;
}
interface Proposal {
  id: string;
  leadId: string;
  title: string;
  actionType: string;
  status: string;
  rationale: string;
  executionDetail: string | null;
  payload: { subject?: string; body?: string };
}
interface Profile {
  version: number;
  content: Record<string, string>;
  createdAt: string;
}
interface Execution {
  id: string;
  kind: string;
  state: string;
  detail: string | null;
  expiresAt: string;
  createdAt: string;
}
interface Desk {
  queue: {
    leadId: string;
    contactName: string;
    title: string;
    reasons: string[];
    assignedUserId: string | null;
    receivedAt: string;
    source: string | null;
    proposals: Proposal[];
  }[];
  records: LeadRecord[];
  proposals: Proposal[];
  profile: Profile | null;
  executions: Execution[];
  staff: {
    id: string;
    firstName: string | null;
    lastName: string | null;
    isActive: boolean;
  }[];
  followup: {
    summary: { unassigned: number; overdue: number; awaitingAttempt: number };
    pending: { leadId: string; dueAt: string | null }[];
  };
  boundary: string;
}
interface Room {
  leadId: string;
  customerPath: string;
  estimates: {
    id: string;
    title: string;
    status: string;
    totalCents: number;
  }[];
  versions: {
    id: string;
    title: string;
    version: number;
    scope: string;
    warranty: string;
    estimateTotalCents: number;
    isCurrent: boolean;
    options: { name: string; description: string }[];
  }[];
}
interface Ledger {
  entryCount: number;
  acceptedEstimateCount: number;
  acceptedEstimateCents: number;
  completedProjectCount: number;
  netReceiptsCents: number;
  netDirectCostsCents: number;
  receiptEntryCount: number;
  costEntryCount: number;
  recordedContributionCents: number | null;
  boundary: string;
  entries: {
    id: string;
    leadId: string;
    kind: string;
    amountCents: number;
    sourceReference: string;
    occurredAt: string;
  }[];
}
interface Growth {
  projects: { id: string; leadId: string; name: string; completedAt: string }[];
  stories: {
    id: string;
    projectId: string;
    version: number;
    title: string;
    body: string;
    serviceArea: string;
    state: string;
  }[];
  boundary: string;
}
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block min-w-0 space-y-1.5 text-sm font-medium">
      {label}
      {children}
    </label>
  );
}
function Note({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-lg bg-muted/60 p-3 text-xs leading-relaxed text-foreground">
      {children}
    </p>
  );
}
function Stat({
  label,
  value,
  detail,
}: {
  label: string;
  value: string | number;
  detail?: string;
}) {
  return (
    <div className="rounded-xl border bg-card p-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-2 text-2xl font-semibold tracking-tight">{value}</p>
      {detail && <p className="mt-2 text-xs text-muted-foreground">{detail}</p>}
    </div>
  );
}
function LeadPicker({
  records,
  value,
  onChange,
}: {
  records: LeadRecord[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <Field label="Customer project">
      <select
        required
        className={input}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">Select a project</option>
        {records.map((l) => (
          <option key={l.id} value={l.id}>
            {l.summary || `Inquiry ${l.id.slice(0, 8)}`} ·{" "}
            {l.status.replaceAll("_", " ")}
          </option>
        ))}
      </select>
    </Field>
  );
}

export function RevenueWorkspace() {
  const [tab, setTab] = useState("today");
  const { data: me } = useGetMe();
  const cache = useQueryClient();
  const desk = useQuery({
    queryKey: ["revenue", "desk"],
    queryFn: () => revenueRequest<Desk>("/revenue/desk"),
  });
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const working = useRef(false);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const stale = desk.isError || refreshFailed;
  const refreshQueries = async () => {
    const results = await Promise.allSettled([
      cache.invalidateQueries(
        { queryKey: ["revenue"] },
        { throwOnError: true },
      ),
      cache.invalidateQueries({ queryKey: ["bie"] }, { throwOnError: true }),
    ]);
    return results.every((result) => result.status === "fulfilled");
  };
  const refresh = async () => {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const refreshed = await refreshQueries();
      setRefreshFailed(!refreshed);
      if (refreshed) setMessage("Workspace refreshed.");
      else
        setError(
          "The workspace could not refresh. Try Refresh workspace again.",
        );
    } finally {
      working.current = false;
      setBusy(false);
    }
  };
  const work = async (
    operation: () => Promise<unknown>,
    success = "Action completed.",
  ) => {
    if (working.current || stale) return;
    working.current = true;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await operation();
      setMessage(success);
      const refreshed = await refreshQueries();
      setRefreshFailed(!refreshed);
      if (!refreshed)
        setError(
          "The action completed, but updated data could not be loaded. Refresh the workspace before taking another action.",
        );
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "The operation could not be completed.",
      );
    } finally {
      working.current = false;
      setBusy(false);
    }
  };
  if (desk.isError && !desk.data)
    return (
      <section
        className="rounded-xl border border-destructive/30 p-5"
        role="alert"
      >
        <p>
          Revenue Desk is unavailable. No empty totals have been substituted.
        </p>
        <button className={`${button} mt-3`} onClick={() => desk.refetch()}>
          Retry Revenue Desk
        </button>
      </section>
    );
  if (!desk.data) return <p role="status">Loading your revenue workspace…</p>;
  const data = desk.data;
  const manager = canManageSettings(me?.role as UserRole);
  const writer = canWrite(me?.role as UserRole);
  return (
    <section aria-label="Revenue Desk workspace" className="min-w-0 space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-widest text-primary">
            From opportunity to outcome
          </p>
          <h2 className="mt-1 text-xl font-semibold">
            Your working day, connected.
          </h2>
        </div>
        <button className={button} disabled={busy} onClick={refresh}>
          <RefreshCw className="h-4 w-4" />
          Refresh workspace
        </button>
      </div>
      {stale && (
        <p
          role="alert"
          className="rounded-lg border border-destructive/30 p-3 text-sm"
        >
          Last loaded data is shown and may be out of date. Actions are paused
          until Refresh workspace succeeds.
        </p>
      )}
      <fieldset disabled={busy || stale} className="min-w-0 space-y-5">
        <legend className="sr-only">Revenue Desk controls</legend>
        <nav aria-label="Revenue Desk views" className="flex flex-wrap gap-2">
          {[
            ["today", "Today’s priorities"],
            ["room", "Customer decision room"],
            ["value", "Value ledger"],
            ["growth", "Project stories"],
            ["profile", "Business knowledge"],
          ].map(([key, label]) => (
            <button
              key={key}
              aria-pressed={tab === key}
              className={`${button} ${tab === key ? "border-primary/40 bg-primary/10 text-primary" : ""}`}
              onClick={() => {
                setTab(key);
                setError("");
                setMessage("");
              }}
            >
              {label}
            </button>
          ))}
        </nav>
        {error && (
          <p
            role="alert"
            className="rounded-lg border border-destructive/30 p-3 text-sm text-foreground"
          >
            {error}
          </p>
        )}
        {message && (
          <p
            role="status"
            className="rounded-lg border border-emerald-500/30 p-3 text-sm"
          >
            {message}
          </p>
        )}
        {tab === "today" && (
          <>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <Stat
                label="Inquiries needing an owner"
                value={data.followup.summary.unassigned}
                detail="Smart Site records"
              />
              <Stat
                label="Past first-response target"
                value={data.followup.summary.overdue}
                detail="Elapsed internal target, not a promise"
              />
              <Stat
                label="Suggestions to review"
                value={
                  data.proposals.filter((p) => p.status === "proposed").length
                }
                detail="Within the latest 200 proposals"
              />
              <Stat
                label="Execution review"
                value={
                  data.executions.filter(
                    (e) =>
                      e.state === "indeterminate" ||
                      (e.state === "processing" &&
                        Date.parse(e.expiresAt) < Date.now()),
                  ).length
                }
                detail="Within the latest 100 executions"
              />
            </div>
            <Note>
              {data.boundary} Recommendations show up to 50 prioritized leads.
              Financial results and source evidence are available in Value
              ledger.
            </Note>
            {writer && (
              <button
                className={button}
                disabled={busy}
                onClick={() =>
                  work(
                    () => revenueRequest("/bie/actions/generate", {}),
                    "Recovery proposals prepared for review. Nothing was sent.",
                  )
                }
              >
                <Sparkles className="h-4 w-4" />
                Prepare recovery proposals
              </button>
            )}
            {!data.queue.length && (
              <Note>
                No current recommendations. New inquiries and eligible
                follow-ups will appear from your CRM records.
              </Note>
            )}
            <div className="grid gap-3 lg:grid-cols-2">
              {data.queue.map((item) => {
                const owner = data.staff.find(
                  (s) => s.id === item.assignedUserId,
                );
                const due = data.followup.pending.find(
                  (p) => p.leadId === item.leadId,
                )?.dueAt;
                return (
                  <article
                    aria-label={`Priority for ${item.contactName || "customer"}`}
                    key={item.leadId}
                    className="min-w-0 rounded-xl border bg-card p-4"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <Link
                          className="font-semibold text-primary hover:underline"
                          href={`/leads/${item.leadId}`}
                        >
                          {item.contactName || "Customer inquiry"}
                        </Link>
                        <p className="mt-1 text-sm font-medium">{item.title}</p>
                      </div>
                      <ArrowUpRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                    </div>
                    <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                      {item.reasons.join(" · ")}
                    </p>
                    <p className="mt-3 text-xs">
                      Owner:{" "}
                      {owner
                        ? `${owner.firstName || "Team"} ${owner.lastName || ""}${owner.isActive ? "" : " (inactive)"}`
                        : "Unassigned"}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Source: {item.source || "Not recorded"} · Received{" "}
                      {date(item.receivedAt)}
                    </p>
                    {due && (
                      <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">
                        First-attempt target: {date(due)}
                      </p>
                    )}
                    <div className="mt-3 flex flex-wrap gap-2">
                      {writer && !item.assignedUserId && (
                        <button
                          className={button}
                          disabled={busy}
                          onClick={() =>
                            work(
                              () =>
                                revenueRequest(
                                  `/revenue/leads/${item.leadId}/claim`,
                                  { confirmed: true },
                                ),
                              "You now own this inquiry. No contact attempt was recorded.",
                            )
                          }
                        >
                          Claim for me
                        </button>
                      )}
                      <Link className={button} href={`/leads/${item.leadId}`}>
                        Open customer & next step
                      </Link>
                    </div>
                  </article>
                );
              })}
            </div>
            <h3 className="text-lg font-semibold">
              Prepared actions & receipts
            </h3>
            {!data.proposals.length && (
              <Note>
                No proposals yet. Preparing the queue creates reviewable actions
                without sending them.
              </Note>
            )}
            <div className="space-y-3">
              {data.proposals.slice(0, 30).map((p) => (
                <ProposalCard
                  key={p.id}
                  proposal={p}
                  busy={busy}
                  writer={writer}
                  work={work}
                />
              ))}
            </div>
            <ExecutionReview
              executions={data.executions}
              manager={manager}
              busy={busy}
              work={work}
            />
          </>
        )}
        {tab === "room" && (
          <DecisionRoom
            records={data.records}
            manager={manager}
            busy={busy}
            work={work}
          />
        )}
        {tab === "value" && (
          <ValueLedger
            records={data.records}
            manager={manager}
            busy={busy}
            work={work}
          />
        )}
        {tab === "growth" && (
          <ProjectGrowth
            manager={manager}
            writer={writer}
            busy={busy}
            work={work}
          />
        )}
        {tab === "profile" && (
          <BusinessProfile
            key={data.profile?.version ?? 0}
            profile={data.profile}
            manager={manager}
            busy={busy}
            work={work}
          />
        )}
      </fieldset>
    </section>
  );
}
type Work = (
  operation: () => Promise<unknown>,
  success?: string,
) => Promise<void>;
function ProposalCard({
  proposal: p,
  writer,
  busy,
  work,
}: {
  proposal: Proposal;
  writer: boolean;
  busy: boolean;
  work: Work;
}) {
  // An untouched editor follows the saved payload. Local edits retain the
  // payload they started from so a refresh cannot silently replace their basis.
  const [draft, setDraft] = useState<{
    source: string;
    subject: string;
    body: string;
  } | null>(null);
  const savedSubject = p.payload.subject || "";
  const savedBody = p.payload.body || "";
  const savedPayload = JSON.stringify(p.payload);
  const subject = draft?.subject ?? savedSubject;
  const body = draft?.body ?? savedBody;
  const dirty = subject !== savedSubject || body !== savedBody;
  // A successful save (or reverting all edits) returns the editor to following
  // server content. Reset during render to avoid one stale actionable frame.
  if (draft && !dirty) setDraft(null);
  const needsReview =
    !!draft &&
    dirty &&
    (draft.source !== savedPayload || p.status !== "proposed");
  const edit = (change: { subject?: string; body?: string }) =>
    setDraft({
      source: draft?.source ?? savedPayload,
      subject,
      body,
      ...change,
    });
  return (
    <article className="min-w-0 rounded-xl border bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <Link
          href={`/leads/${p.leadId}`}
          className="font-medium hover:underline"
        >
          {p.title}
        </Link>
        <span className="rounded-full bg-muted px-2 py-1 text-xs">
          {p.status.replaceAll("_", " ")}
        </span>
      </div>
      <p className="mt-2 text-sm text-muted-foreground">{p.rationale}</p>
      {needsReview && (
        <div
          role="alert"
          className="mt-3 space-y-3 rounded-lg border border-destructive/30 p-3 text-sm"
        >
          <p>
            The saved action changed while you were editing. Your local text is
            preserved below. Copy any edits you want to keep, then load the
            saved message and review it before continuing.
          </p>
          <button
            className={button}
            disabled={busy}
            onClick={() => setDraft(null)}
          >
            Discard local edits and load saved message
          </button>
        </div>
      )}
      {p.actionType === "send_email" && (
        <details className="mt-3">
          <summary className="cursor-pointer text-sm text-primary">
            Review message content
          </summary>
          <div className="mt-3 space-y-3">
            <Field label="Email subject">
              <input
                className={input}
                value={subject}
                onChange={(e) => edit({ subject: e.target.value })}
                readOnly={
                  busy || needsReview || !writer || p.status !== "proposed"
                }
              />
            </Field>
            <Field label="Email body">
              <textarea
                className={input}
                rows={5}
                value={body}
                onChange={(e) => edit({ body: e.target.value })}
                readOnly={
                  busy || needsReview || !writer || p.status !== "proposed"
                }
              />
            </Field>
            {writer && p.status === "proposed" && (
              <button
                className={button}
                disabled={busy || needsReview || !dirty}
                onClick={() =>
                  work(
                    () =>
                      revenueRequest(
                        `/revenue/proposals/${p.id}`,
                        { subject, body },
                        "PATCH",
                      ),
                    "Draft updated. Review it before approval.",
                  )
                }
              >
                Save draft edits
              </button>
            )}
          </div>
        </details>
      )}
      {p.executionDetail && <p className="mt-3 text-sm">{p.executionDetail}</p>}
      <div className="mt-3 flex flex-wrap gap-2">
        {writer && p.status === "proposed" && (
          <>
            <button
              className={button}
              disabled={busy || needsReview || dirty}
              onClick={() =>
                work(
                  () =>
                    revenueRequest(`/bie/actions/${p.id}/approve`, {
                      expectedPayload: p.payload,
                    }),
                  "Action approved; not yet executed.",
                )
              }
            >
              <CheckCircle2 className="h-4 w-4" />
              Approve saved action
            </button>
            <button
              className={button}
              disabled={busy}
              onClick={() =>
                work(() => revenueRequest(`/bie/actions/${p.id}/reject`, {}))
              }
            >
              Dismiss proposal
            </button>
          </>
        )}
        {writer && p.status === "approved" && (
          <button
            className={button}
            disabled={busy || needsReview}
            onClick={() =>
              work(
                () => revenueRequest(`/bie/actions/${p.id}/execute`, {}),
                "Execution checked. Read the action receipt for the actual result.",
              )
            }
          >
            {p.actionType === "send_email"
              ? "Send approved email"
              : "Execute approved action"}
          </button>
        )}
      </div>
    </article>
  );
}
function ExecutionReview({
  executions,
  manager,
  busy,
  work,
}: {
  executions: Execution[];
  manager: boolean;
  busy: boolean;
  work: Work;
}) {
  const [selected, setSelected] = useState("");
  const [evidence, setEvidence] = useState("");
  const [outcome, setOutcome] = useState("confirmed_succeeded");
  const [confirmed, setConfirmed] = useState(false);
  const uncertain = executions.filter(
    (e) =>
      e.state === "indeterminate" ||
      (e.state === "processing" && Date.parse(e.expiresAt) < Date.now()),
  );
  return (
    <details className="rounded-xl border p-4">
      <summary className="cursor-pointer font-medium">
        Execution history · {executions.length} recent records
      </summary>
      <div className="mt-3 space-y-3">
        {executions.map((e) => (
          <div key={e.id} className="rounded-lg bg-muted/50 p-3 text-sm">
            <strong>{e.kind.replaceAll("_", " ")}</strong> ·{" "}
            {e.state.replaceAll("_", " ")}
            <p className="mt-1 text-xs text-muted-foreground">
              {date(e.createdAt)} ·{" "}
              {e.detail || "A worker currently owns this action."}
            </p>
          </div>
        ))}
        {!executions.length && <Note>No executions recorded.</Note>}
        {manager && uncertain.length > 0 && (
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              void work(
                () =>
                  revenueRequest(`/revenue/executions/${selected}/reconcile`, {
                    outcome,
                    evidence,
                    confirmed,
                  }),
                "Reconciliation recorded. No action was replayed.",
              );
            }}
          >
            <Field label="Interrupted execution">
              <select
                className={input}
                required
                value={selected}
                onChange={(e) => setSelected(e.target.value)}
              >
                <option value="">Select execution</option>
                {uncertain.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.kind} · {date(e.createdAt)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Observed outcome">
              <select
                className={input}
                value={outcome}
                onChange={(e) => setOutcome(e.target.value)}
              >
                <option value="confirmed_succeeded">
                  I confirmed the action occurred
                </option>
                <option value="confirmed_not_performed">
                  I confirmed it did not occur
                </option>
              </select>
            </Field>
            <Field label="Reconciliation evidence">
              <textarea
                className={input}
                required
                minLength={20}
                maxLength={900}
                value={evidence}
                onChange={(e) => setEvidence(e.target.value)}
              />
            </Field>
            <label className="flex gap-2 text-sm">
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
              />
              I checked the underlying system. This is my recorded confirmation,
              not an automatic provider verification.
            </label>
            <button className={button} disabled={busy || !confirmed}>
              Record reconciliation without replay
            </button>
          </form>
        )}
      </div>
    </details>
  );
}

function BusinessProfile({
  profile,
  manager,
  busy,
  work,
}: {
  profile: Profile | null;
  manager: boolean;
  busy: boolean;
  work: Work;
}) {
  const fields = [
    ["services", "Services offered"],
    ["serviceArea", "Service area"],
    ["businessHours", "Business hours"],
    ["escalation", "Human escalation and response policy"],
    ["materials", "Approved materials and brands"],
    ["warranties", "Verified warranty terms"],
    ["pricingBoundaries", "Pricing and commitment boundaries"],
    ["sourceReference", "Approval source / reference"],
  ];
  const [content, setContent] = useState<Record<string, string>>(
    profile?.content || Object.fromEntries(fields.map(([k]) => [k, ""])),
  );
  const [confirmed, setConfirmed] = useState(false);
  return (
    <form
      className="space-y-4 rounded-xl border bg-card p-5"
      onSubmit={(e) => {
        e.preventDefault();
        void work(
          () =>
            revenueRequest("/revenue/profile", {
              expectedVersion: profile?.version ?? 0,
              content,
              confirmed,
            }),
          "A new approved business-knowledge version was saved. External agents have not been reconfigured.",
        );
      }}
    >
      <h3 className="text-xl font-semibold">One approved business reference</h3>
      <Note>
        {profile
          ? `Version ${profile.version} · Approved ${date(profile.createdAt)}`
          : "No approved profile yet. Nothing is inferred from another client."}{" "}
        Keep secrets and customer personal data out. Saving does not update an
        external voice agent or authorize sending.
      </Note>
      <div className="grid gap-4 md:grid-cols-2">
        {fields.map(([key, label]) => (
          <Field key={key} label={label}>
            <textarea
              className={input}
              required
              minLength={key === "sourceReference" ? 5 : 2}
              maxLength={key === "sourceReference" ? 160 : 2000}
              rows={key === "sourceReference" ? 2 : 3}
              value={content[key]}
              disabled={!manager}
              onChange={(e) =>
                setContent({ ...content, [key]: e.target.value })
              }
            />
          </Field>
        ))}
      </div>
      {manager && (
        <>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-1"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
            />
            I have client approval for these facts, policies and warranty
            statements.
          </label>
          <button className={button} disabled={busy || !confirmed}>
            <ShieldCheck className="h-4 w-4" />
            Approve knowledge version
          </button>
        </>
      )}
    </form>
  );
}

function DecisionRoom({
  records,
  manager,
  busy,
  work,
}: {
  records: LeadRecord[];
  manager: boolean;
  busy: boolean;
  work: Work;
}) {
  const [leadId, setLeadId] = useState("");
  const room = useQuery({
    queryKey: ["revenue", "room", leadId],
    queryFn: () => revenueRequest<Room>(`/revenue/rooms/${leadId}`),
    enabled: !!leadId,
  });
  const [estimateId, setEstimateId] = useState("");
  const [title, setTitle] = useState("");
  const [scope, setScope] = useState("");
  const [warranty, setWarranty] = useState("");
  const [sourceReference, setSource] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [options, setOptions] = useState([{ name: "", description: "" }]);
  return (
    <div className="space-y-4">
      <h3 className="text-xl font-semibold">
        Help the customer make a clear decision.
      </h3>
      <LeadPicker
        records={records}
        value={leadId}
        onChange={(v) => {
          setLeadId(v);
          setEstimateId("");
          setConfirmed(false);
          setTitle("");
          setScope("");
          setWarranty("");
          setSource("");
          setOptions([{ name: "", description: "" }]);
        }}
      />
      <Note>
        Only explicitly approved content is available to that customer’s
        authenticated portal. Internal notes and draft estimates stay private.
        Material comparisons are explanatory; this screen does not sign a
        contract or collect a payment.
      </Note>
      {room.isError && (
        <p role="alert">
          Decision room could not load. Refresh before sharing.
        </p>
      )}
      {leadId && room.isPending && (
        <p role="status">Loading project context…</p>
      )}
      {room.data && (
        <>
          <a
            className={button}
            href={room.data.customerPath}
            target="_blank"
            rel="noreferrer"
          >
            Open private customer sign-in
          </a>
          <div className="space-y-3">
            {room.data.versions.map((v) => (
              <article key={v.id} className="rounded-xl border bg-card p-5">
                <div className="flex flex-wrap justify-between gap-2">
                  <h4 className="font-semibold">
                    {v.title} · v{v.version}
                  </h4>
                  <span className="text-xs text-muted-foreground">
                    {v.isCurrent
                      ? "Matches current estimate"
                      : "Estimate changed — historical snapshot"}
                  </span>
                </div>
                <p className="mt-3 whitespace-pre-wrap text-sm">{v.scope}</p>
                <p className="mt-3 font-semibold">
                  Estimate snapshot: {money(v.estimateTotalCents)}
                </p>
                <div className="mt-3 grid gap-3 md:grid-cols-3">
                  {v.options.map((o) => (
                    <div key={o.name} className="rounded-lg bg-muted/60 p-3">
                      <p className="font-medium">{o.name}</p>
                      <p className="mt-1 text-sm text-muted-foreground">
                        {o.description}
                      </p>
                    </div>
                  ))}
                </div>
                <p className="mt-3 text-sm">Warranty: {v.warranty}</p>
              </article>
            ))}
          </div>
          {!room.data.versions.length && (
            <Note>
              No approved decision package has been shared for this project.
            </Note>
          )}
          {manager && (
            <form
              className="space-y-4 rounded-xl border bg-card p-5"
              onSubmit={(e) => {
                e.preventDefault();
                void work(
                  () =>
                    revenueRequest(`/revenue/rooms/${leadId}`, {
                      expectedVersion: room.data!.versions[0]?.version ?? 0,
                      estimateId,
                      title,
                      scope,
                      warranty,
                      sourceReference,
                      options: options.filter((o) => o.name || o.description),
                      confirmed,
                    }),
                  "Approved decision package saved for this customer’s portal. No notification was sent.",
                );
              }}
            >
              <h4 className="font-semibold">Approve a new decision package</h4>
              <Field label="Source estimate">
                <select
                  className={input}
                  required
                  value={estimateId}
                  onChange={(e) => setEstimateId(e.target.value)}
                >
                  <option value="">Select a sent or accepted estimate</option>
                  {room.data.estimates
                    .filter((e) => ["sent", "accepted"].includes(e.status))
                    .map((e) => (
                      <option key={e.id} value={e.id}>
                        {e.title} · {money(e.totalCents)}
                      </option>
                    ))}
                </select>
              </Field>
              <Field label="Package title">
                <input
                  className={input}
                  required
                  minLength={3}
                  maxLength={150}
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                />
              </Field>
              <Field label="Approved project scope">
                <textarea
                  className={input}
                  required
                  rows={4}
                  maxLength={2000}
                  value={scope}
                  onChange={(e) => setScope(e.target.value)}
                />
              </Field>
              {options.map((o, i) => (
                <div key={i} className="grid gap-3 md:grid-cols-2">
                  <Field label={`Option ${i + 1} name`}>
                    <input
                      className={input}
                      maxLength={80}
                      value={o.name}
                      onChange={(e) =>
                        setOptions(
                          options.map((x, n) =>
                            n === i ? { ...x, name: e.target.value } : x,
                          ),
                        )
                      }
                    />
                  </Field>
                  <Field label={`Option ${i + 1} explanation`}>
                    <textarea
                      className={input}
                      maxLength={2000}
                      value={o.description}
                      onChange={(e) =>
                        setOptions(
                          options.map((x, n) =>
                            n === i ? { ...x, description: e.target.value } : x,
                          ),
                        )
                      }
                    />
                  </Field>
                </div>
              ))}
              {options.length < 3 && (
                <button
                  type="button"
                  className={button}
                  onClick={() =>
                    setOptions([...options, { name: "", description: "" }])
                  }
                >
                  Add comparison option
                </button>
              )}
              <Field label="Verified warranty terms">
                <textarea
                  className={input}
                  required
                  maxLength={2000}
                  value={warranty}
                  onChange={(e) => setWarranty(e.target.value)}
                />
              </Field>
              <Field label="Approval source reference">
                <input
                  className={input}
                  required
                  minLength={5}
                  maxLength={160}
                  value={sourceReference}
                  onChange={(e) => setSource(e.target.value)}
                />
              </Field>
              <label className="flex gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={(e) => setConfirmed(e.target.checked)}
                />
                I approve this exact content for this customer’s private portal.
              </label>
              <button className={button} disabled={busy || !confirmed}>
                <FileCheck2 className="h-4 w-4" />
                Approve customer package
              </button>
            </form>
          )}
        </>
      )}
    </div>
  );
}

export function ValueLedger({
  records = [],
  manager = false,
  busy = false,
  work,
}: {
  records?: LeadRecord[];
  manager?: boolean;
  busy?: boolean;
  work?: Work;
}) {
  const ledger = useQuery({
    queryKey: ["revenue", "value"],
    queryFn: () => revenueRequest<Ledger>("/revenue/value"),
  });
  const [leadId, setLeadId] = useState("");
  const [amount, setAmount] = useState("");
  const [kind, setKind] = useState("payment");
  const [source, setSource] = useState("");
  const [occurredAt, setOccurredAt] = useState(
    new Date().toISOString().slice(0, 10),
  );
  const [confirmed, setConfirmed] = useState(false);
  const [evidenceId, setEvidenceId] = useState("");
  const evidence = useQuery({
    queryKey: ["revenue", "evidence", evidenceId],
    queryFn: () =>
      revenueRequest<{
        source: string;
        status: string;
        activity: { id: string; title: string; type: string }[];
        estimates: { id: string; title: string; status: string }[];
        appointments: { id: string; status: string }[];
        projects: { id: string; name: string; status: string }[];
        payments: { id: string; kind: string; amountCents: number }[];
      }>(`/revenue/evidence/${evidenceId}`),
    enabled: !!evidenceId,
  });
  if (ledger.isError)
    return (
      <p role="alert">
        The value ledger could not load. No zero-value substitute is shown.{" "}
        <button className={button} onClick={() => ledger.refetch()}>
          Retry ledger
        </button>
      </p>
    );
  if (!ledger.data) return <p role="status">Loading recorded value…</p>;
  const data = ledger.data;
  return (
    <section aria-label="Value ledger" className="space-y-4">
      <div>
        <h3 className="text-xl font-semibold">
          Trace the value. See the evidence.
        </h3>
        <p className="mt-1 text-sm text-muted-foreground">
          All-time USD records · {data.entryCount} financial entries · latest
          200 shown
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Stat
          label="Accepted estimates"
          value={money(data.acceptedEstimateCents)}
          detail={`${data.acceptedEstimateCount} accepted estimates; not collected cash`}
        />
        <Stat
          label="Recorded net receipts"
          value={
            data.receiptEntryCount
              ? money(data.netReceiptsCents)
              : "Not recorded"
          }
          detail="Staff-entered payments minus refunds"
        />
        <Stat
          label="Recorded direct costs"
          value={
            data.costEntryCount
              ? money(data.netDirectCostsCents)
              : "Not recorded"
          }
          detail="Costs minus cost refunds"
        />
        <Stat
          label="Recorded contribution"
          value={
            data.recordedContributionCents != null
              ? money(data.recordedContributionCents)
              : "Not available"
          }
          detail="Not a profit or causal ROI claim"
        />
      </div>
      <Note>{data.boundary}</Note>
      {records.length > 0 && (
        <div className="space-y-3 rounded-xl border p-4">
          <h4 className="font-semibold">Follow a customer’s evidence chain</h4>
          <LeadPicker
            records={records}
            value={evidenceId}
            onChange={setEvidenceId}
          />
          {evidence.isError && (
            <p role="alert">This evidence could not be loaded.</p>
          )}
          {evidence.data && (
            <>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                {[
                  ["Appointments", evidence.data.appointments],
                  ["Estimates", evidence.data.estimates],
                  ["Projects", evidence.data.projects],
                  ["Financial entries", evidence.data.payments],
                ].map(([label, rows]) => (
                  <Stat
                    key={String(label)}
                    label={String(label)}
                    value={(rows as unknown[]).length}
                  />
                ))}
              </div>
              <Link className={button} href={`/leads/${evidenceId}`}>
                Open source customer record
              </Link>
              <div className="space-y-1">
                {evidence.data.activity.slice(0, 8).map((a) => (
                  <p key={a.id} className="text-sm text-muted-foreground">
                    {a.title} · {a.type.replaceAll("_", " ")}
                  </p>
                ))}
              </div>
            </>
          )}
        </div>
      )}
      {manager && work && (
        <details className="rounded-xl border p-4">
          <summary className="cursor-pointer font-medium">
            Record a financial event
          </summary>
          <form
            className="mt-4 space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              void work(
                () =>
                  revenueRequest("/revenue/value", {
                    leadId,
                    amountCents: parseRecordedCents(amount),
                    kind,
                    sourceReference: source,
                    occurredAt: new Date(
                      `${occurredAt}T00:00:00.000Z`,
                    ).toISOString(),
                    confirmed,
                  }),
                "Financial entry recorded once against its source reference. No payment was initiated.",
              );
            }}
          >
            <LeadPicker records={records} value={leadId} onChange={setLeadId} />
            <div className="grid gap-3 md:grid-cols-2">
              <Field label="Entry type">
                <select
                  className={input}
                  value={kind}
                  onChange={(e) => setKind(e.target.value)}
                >
                  <option value="payment">Payment received</option>
                  <option value="refund">Customer refund</option>
                  <option value="direct_cost">Direct job cost</option>
                  <option value="cost_refund">
                    Direct cost refund / reversal
                  </option>
                </select>
              </Field>
              <Field label="Amount in USD">
                <input
                  className={input}
                  inputMode="decimal"
                  required
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                />
              </Field>
              <Field label="Event date (UTC)">
                <input
                  className={input}
                  type="date"
                  max={new Date().toISOString().slice(0, 10)}
                  required
                  value={occurredAt}
                  onChange={(e) => setOccurredAt(e.target.value)}
                />
              </Field>
              <Field label="Unique accounting / receipt reference">
                <input
                  className={input}
                  required
                  minLength={5}
                  maxLength={160}
                  value={source}
                  onChange={(e) => setSource(e.target.value)}
                />
              </Field>
            </div>
            <label className="flex gap-2 text-sm">
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
              />
              I checked the source record. This records a historical event and
              does not move money.
            </label>
            <button className={button} disabled={busy || !confirmed}>
              Record entry
            </button>
          </form>
        </details>
      )}
      <div className="space-y-2">
        {data.entries.map((e) => (
          <div
            key={e.id}
            className="flex flex-wrap justify-between gap-2 rounded-lg border p-3 text-sm"
          >
            <div>
              <Link
                className="text-primary hover:underline"
                href={`/leads/${e.leadId}`}
              >
                {e.sourceReference}
              </Link>
              <p className="text-xs text-muted-foreground">
                {e.kind.replaceAll("_", " ")} · {new Date(e.occurredAt).toLocaleDateString("en-US", { timeZone: "UTC" })} (UTC)
              </p>
            </div>
            <strong>{money(e.amountCents)}</strong>
          </div>
        ))}
      </div>
    </section>
  );
}

function ProjectGrowth({
  manager,
  writer,
  busy,
  work,
}: {
  manager: boolean;
  writer: boolean;
  busy: boolean;
  work: Work;
}) {
  const query = useQuery({
    queryKey: ["revenue", "growth"],
    queryFn: () => revenueRequest<Growth>("/revenue/growth"),
  });
  const [projectId, setProjectId] = useState("");
  const [title, setTitle] = useState("");
  const [area, setArea] = useState("");
  const [body, setBody] = useState("");
  const [source, setSource] = useState("");
  const [permitted, setPermitted] = useState<Record<string, boolean>>({});
  if (query.isError)
    return (
      <p role="alert">
        Project stories could not load.{" "}
        <button className={button} onClick={() => query.refetch()}>
          Retry stories
        </button>
      </p>
    );
  if (!query.data) return <p role="status">Loading completed projects…</p>;
  const data = query.data;
  return (
    <div className="space-y-4">
      <h3 className="text-xl font-semibold">
        Let finished work tell the next customer’s story.
      </h3>
      <Note>
        {data.boundary} Use broad service locations and permissioned facts. Do
        not add customer addresses, invented reviews, or unsupported warranty
        claims.
      </Note>
      {!data.projects.length && (
        <Note>
          No completed projects are recorded yet. Complete the real project
          workflow before creating a project story.
        </Note>
      )}
      {writer && data.projects.length > 0 && (
        <form
          className="space-y-3 rounded-xl border bg-card p-5"
          onSubmit={(e) => {
            e.preventDefault();
            void work(
              () =>
                revenueRequest("/revenue/growth", {
                  projectId,
                  expectedVersion: Math.max(
                    0,
                    ...data.stories
                      .filter((s) => s.projectId === projectId)
                      .map((s) => s.version),
                  ),
                  title,
                  serviceArea: area,
                  body,
                  sourceReference: source,
                }),
              "Project story saved as a draft. Approval and external publication remain separate.",
            );
          }}
        >
          <Field label="Completed source project">
            <select
              className={input}
              required
              value={projectId}
              onChange={(e) => {
                setProjectId(e.target.value);
                setTitle("");
                setBody("");
                setSource("");
                setArea("");
              }}
            >
              <option value="">Select completed project</option>
              {data.projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </Field>
          <button
            type="button"
            className={button}
            disabled={!projectId}
            onClick={() => {
              const p = data.projects.find((p) => p.id === projectId)!;
              setTitle(`Project spotlight: ${p.name}`.slice(0, 150));
              setBody(
                `Our team completed ${p.name} on ${new Date(p.completedAt).toLocaleDateString()}.\n\nAdd the approved scope, selected materials and useful homeowner questions from the project record before requesting review.`,
              );
              setSource(`GrowthOS project ${p.id}`);
            }}
          >
            Prepare a source-based outline
          </button>
          <Field label="Story title">
            <input
              className={input}
              required
              minLength={3}
              maxLength={150}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </Field>
          <Field label="Broad service location">
            <input
              className={input}
              required
              maxLength={120}
              value={area}
              onChange={(e) => setArea(e.target.value)}
            />
          </Field>
          <Field label="Project story draft">
            <textarea
              className={input}
              required
              minLength={30}
              maxLength={5000}
              rows={6}
              value={body}
              onChange={(e) => setBody(e.target.value)}
            />
          </Field>
          <Field label="Evidence / approval reference">
            <input
              className={input}
              required
              minLength={5}
              maxLength={160}
              value={source}
              onChange={(e) => setSource(e.target.value)}
            />
          </Field>
          <button className={button} disabled={busy}>
            Save story draft
          </button>
        </form>
      )}
      <div className="space-y-3">
        {data.stories.map((s) => (
          <article key={s.id} className="rounded-xl border bg-card p-5">
            <h4 className="font-semibold">
              {s.title} · v{s.version}
            </h4>
            <p className="mt-1 text-xs text-muted-foreground">
              {s.serviceArea} ·{" "}
              {s.state === "approved"
                ? "Approved draft — not published"
                : "Needs review"}
            </p>
            <p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed">
              {s.body}
            </p>
            {manager && s.state === "draft" && (
              <div className="mt-4 space-y-3">
                <label className="flex gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={!!permitted[s.id]}
                    onChange={(e) =>
                      setPermitted({ ...permitted, [s.id]: e.target.checked })
                    }
                  />
                  I verified the facts and client permission for this content.
                  Publishing needs a separate action.
                </label>
                <button
                  className={button}
                  disabled={busy || !permitted[s.id]}
                  onClick={() =>
                    work(
                      () =>
                        revenueRequest(`/revenue/growth/${s.id}/approve`, {
                          confirmedContentPermission: true,
                        }),
                      "Draft approved. Nothing was published or sent.",
                    )
                  }
                >
                  Approve story draft
                </button>
              </div>
            )}
          </article>
        ))}
      </div>
    </div>
  );
}

export function ClientOperations() {
  const query = useQuery({
    queryKey: ["revenue", "client-health"],
    queryFn: () =>
      revenueRequest<{
        clients: {
          id: string;
          name: string;
          profileVersion: number | null;
          executionsNeedingReview: number;
          inquiries: { unowned: number; overdue: number };
          readiness: {
            staffing: { activeManagers: number; activeResponders: number };
            sites: {
              id: string;
              name: string;
              isActive: boolean;
              credentialCheckedAt: string | null;
              lastSavedAt: string | null;
            }[];
          };
        }[];
        boundary: string;
      }>("/platform/clients/health"),
  });
  return (
    <section className="space-y-4 rounded-xl border bg-card p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-xl font-semibold">Client operations pulse</h2>
        <button className={button} onClick={() => query.refetch()}>
          Refresh client health
        </button>
      </div>
      {query.isError && (
        <p role="alert">
          Client health is unavailable. No green status has been substituted.
        </p>
      )}
      {query.isPending && (
        <p role="status">Reading isolated client readiness…</p>
      )}
      {query.data && (
        <>
          <Note>{query.data.boundary}</Note>
          <div className="grid gap-3 md:grid-cols-2">
            {query.data.clients.map((c) => (
              <article key={c.id} className="rounded-lg border p-4">
                <h3 className="font-semibold">{c.name}</h3>
                <p className="mt-2 text-sm text-muted-foreground">
                  Approved knowledge:{" "}
                  {c.profileVersion ? `v${c.profileVersion}` : "Not recorded"} ·
                  Execution reviews: {c.executionsNeedingReview}
                </p>
                <p className="mt-2 text-sm">
                  {c.readiness.staffing.activeManagers} managers ·{" "}
                  {c.readiness.staffing.activeResponders} responders ·{" "}
                  {c.readiness.sites.length} site connections
                </p>
                <p className="mt-2 text-sm">
                  {c.inquiries.unowned} unowned inquiries ·{" "}
                  {c.inquiries.overdue} past response target
                </p>
                <ul className="mt-3 space-y-2 text-xs text-muted-foreground">
                  {c.readiness.sites.map((s) => (
                    <li key={s.id} className="rounded-md bg-muted p-3">
                      <strong className="text-foreground">{s.name}</strong> ·{" "}
                      {s.isActive ? "Capture enabled" : "Capture paused"}
                      <p>
                        Credential proof:{" "}
                        {s.credentialCheckedAt
                          ? new Date(s.credentialCheckedAt).toLocaleString()
                          : "Not recorded"}
                        {s.isActive &&
                        (!s.credentialCheckedAt ||
                          Date.now() -
                            new Date(s.credentialCheckedAt).getTime() >
                            86400000)
                          ? " — recheck needed"
                          : ""}
                      </p>
                      <p>
                        Latest saved inquiry:{" "}
                        {s.lastSavedAt
                          ? new Date(s.lastSavedAt).toLocaleString()
                          : "Not recorded"}
                      </p>
                    </li>
                  ))}
                </ul>
                <p className="mt-2 text-xs text-muted-foreground">
                  Readiness is not release approval. Use the launchpad below to
                  review this client’s setup.
                </p>
              </article>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
