import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useSearch } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { useGetMe, type MemberProfile } from "@workspace/api-client-react";
import { ArrowLeft, MapPin, Phone, RefreshCw } from "lucide-react";
import VisitWorkPanel from "@/components/visit-work-panel";
import { contractorRequest } from "@/lib/contractor-api";
import { money } from "@/lib/invoice-ui";
import { memberAuthorityScope } from "@/lib/member-authority-scope";
import { canWrite } from "@/lib/permissions";

/**
 * Phone-first "My day" for the person doing the work: today's assigned jobs,
 * tap-to-call, directions, On My Way, the visit checklist/photos/completion,
 * and collecting the invoice balance in person (sandbox pay link + QR).
 */

export type MyDayInvoice = { id: string; invoiceNumber: string | null; title: string; totalCents: number; balanceDueCents: number | null; paymentState: string };
export type MyDayJob = {
  id: string;
  type: string;
  status: string;
  scheduledStart: string;
  scheduledEnd: string | null;
  notes: string | null;
  leadId: string | null;
  contactId: string | null;
  customerName: string | null;
  customerPhone: string | null;
  propertyId: string | null;
  address: string | null;
  directionsUrl: string | null;
  invoices: MyDayInvoice[] | null;
  onMyWay: { state: string; etaMinutes: number | null } | null;
};
export type MyDay = {
  organizationId: string;
  userId: string;
  generatedAt: string;
  date: string;
  timeZone: string;
  canReadInvoices: boolean;
  canCollectPayments: boolean;
  texting: { onMyWay: boolean; payLink: boolean };
  today: MyDayJob[];
  upcoming: MyDayJob[];
};
type PayLink = { id: string; amountCents: number; url: string | null; state: string; expiresAt: string | null };
type FlowOutcome = { execution?: { state?: string; detail?: string }; error?: string; code?: string };

const big = "inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-lg px-4 py-3 text-base font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";
const primary = `${big} bg-primary text-primary-foreground`;
const secondary = `${big} border border-input bg-background text-foreground`;
const card = "min-w-0 space-y-3 rounded-xl border bg-card p-4 text-card-foreground";
const ETA_CHOICES = [10, 15, 20, 30, 45, 60];
const human = (value: string) => value.replaceAll("_", " ");

function timeWindow(job: MyDayJob, timeZone: string, withDay = false) {
  const format = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit", ...(withDay ? { weekday: "short", month: "short", day: "numeric" } : {}) });
  const start = format.format(new Date(job.scheduledStart));
  if (!job.scheduledEnd) return start;
  const end = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" }).format(new Date(job.scheduledEnd));
  return `${start} – ${end}`;
}

async function flow(path: string, body: Record<string, unknown>): Promise<{ status: number; outcome: FlowOutcome | null }> {
  try {
    const response = await fetch(`/api/v1/integrations/zapier/flows/${path}`, { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, outcome: (await response.json().catch(() => null)) as FlowOutcome | null };
  } catch {
    return { status: 0, outcome: null };
  }
}

/**
 * Reading the ledger state honestly. With the Automatic policy your tap sends the
 * text straight to Zapier; with Approve each it waits for the office. "succeeded"
 * means Zapier accepted it for your phone app, not that the customer read it.
 */
function textResult(status: number, outcome: FlowOutcome | null): { message: string; hold: boolean } {
  const state = outcome?.execution?.state;
  if (!state && (status === 400 || status === 403 || status === 404) && typeof outcome?.error === "string") return { message: `Not sent: ${outcome.error}`, hold: false };
  if (!state && status === 409 && typeof outcome?.error === "string") return { message: outcome.error, hold: true };
  if (state === "pending_approval") return { message: "Waiting for approval. Not sent yet.", hold: true };
  if (state === "succeeded") return { message: "Sent to Zapier. Your phone app sends it from your business number.", hold: true };
  if (state === "executing") return { message: "Sending…", hold: true };
  if (state === "blocked" || state === "failed" || state === "rejected") return { message: `Not sent: ${outcome?.execution?.detail || "the text did not go out."}`, hold: false };
  return { message: "We could not confirm whether the text went out. Check recent actions in Settings before trying again.", hold: true };
}

function onMyWayLabel(state: string) {
  if (state === "pending_approval") return "On My Way waiting for approval";
  if (state === "succeeded") return "On My Way sent to Zapier";
  if (state === "executing") return "On My Way sending";
  if (state === "indeterminate") return "On My Way being checked";
  return `On My Way ${human(state)}`;
}

export default function TechDay() {
  const profile = useGetMe();
  if (profile.isError) return <div role="alert" className="p-4">Company access could not be verified. <button className="min-h-11 underline" onClick={() => void profile.refetch()}>Try again</button></div>;
  if (profile.isLoading) return <p role="status" className="p-4">Opening your day…</p>;
  if (!profile.data?.isActive || !profile.data.organization) return <p role="alert" className="p-4">Active company access is required to open your day.</p>;
  const scopeKey = memberAuthorityScope(profile.data);
  return <TechContent key={scopeKey} me={profile.data} scopeKey={scopeKey} />;
}

function TechContent({ me, scopeKey }: { me: MemberProfile; scopeKey: string }) {
  const companyId = me.organization!.id;
  const search = useSearch();
  const [, navigate] = useLocation();
  const selectedId = new URLSearchParams(search).get("job");
  const day = useQuery({
    queryKey: ["my-day", scopeKey],
    queryFn: async ({ signal }) => {
      const result = await contractorRequest<MyDay>("/contractor/my-day", { signal });
      if (result.organizationId !== companyId || result.userId !== me.id) throw new Error("Workspace response mismatch");
      return result;
    },
    retry: false,
  });
  const data = day.data;
  const selected = data ? [...data.today, ...data.upcoming].find((job) => job.id === selectedId) ?? null : null;

  return (
    <div className="flex-1 bg-background p-4 text-foreground md:p-6">
      <div className="mx-auto max-w-xl space-y-4">
        {selected && data ? (
          <JobDetail key={selected.id} job={selected} day={data} me={me} scopeKey={scopeKey} onBack={() => navigate("/tech")} onChanged={() => void day.refetch()} />
        ) : (
          <>
            <header className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h1 className="text-2xl font-bold tracking-tight">My day</h1>
                <p className="text-sm text-muted-foreground">{data ? new Intl.DateTimeFormat("en-US", { timeZone: data.timeZone, weekday: "long", month: "long", day: "numeric" }).format(new Date(`${data.date}T12:00:00Z`)) : "Your assigned jobs"}</p>
              </div>
              <button type="button" className="inline-flex min-h-12 min-w-12 items-center justify-center rounded-lg border" aria-label="Refresh my day" disabled={day.isFetching} onClick={() => void day.refetch()}>
                <RefreshCw className={day.isFetching ? "h-5 w-5 animate-spin" : "h-5 w-5"} aria-hidden />
              </button>
            </header>
            {day.isLoading && <p role="status">Loading your jobs…</p>}
            {day.isError && <p role="alert" className={card}>Your jobs could not be loaded. Check your connection and refresh.</p>}
            {selectedId && data && !selected && <p role="alert" className={card}>That job is not on your schedule for these days.</p>}
            {data && (
              <>
                <section aria-label="Today's jobs" className="space-y-3">
                  {data.today.length === 0 ? <p className={card}>No jobs assigned to you today. The office can assign appointments to you from the Schedule.</p> : data.today.map((job) => <JobCard key={job.id} job={job} timeZone={data.timeZone} />)}
                </section>
                <details className="rounded-xl border p-4">
                  <summary className="min-h-11 cursor-pointer text-base font-semibold">Next few days ({data.upcoming.length})</summary>
                  <div className="mt-3 space-y-3">
                    {data.upcoming.length === 0 ? <p className="text-sm text-muted-foreground">Nothing assigned yet.</p> : data.upcoming.map((job) => <JobCard key={job.id} job={job} timeZone={data.timeZone} withDay />)}
                  </div>
                </details>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function ContactLinks({ job }: { job: MyDayJob }) {
  return (
    <div className="grid grid-cols-2 gap-2">
      {job.customerPhone ? (
        <a className={secondary} href={`tel:${job.customerPhone.replace(/[^\d+]/g, "")}`} aria-label={`Call ${job.customerName ?? "customer"}`}>
          <Phone className="h-5 w-5" aria-hidden /> Call
        </a>
      ) : (
        <span className={`${secondary} opacity-60`}>No phone</span>
      )}
      {job.directionsUrl ? (
        <a className={secondary} href={job.directionsUrl} target="_blank" rel="noreferrer" aria-label={`Directions to ${job.address}`}>
          <MapPin className="h-5 w-5" aria-hidden /> Directions
        </a>
      ) : (
        <span className={`${secondary} opacity-60`}>No address</span>
      )}
    </div>
  );
}

function JobCard({ job, timeZone, withDay = false }: { job: MyDayJob; timeZone: string; withDay?: boolean }) {
  return (
    <article className={card} aria-label={`${job.customerName ?? "Customer"} ${human(job.type)}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-lg font-semibold">{timeWindow(job, timeZone, withDay)}</p>
        <span className="rounded-full border px-2 py-0.5 text-xs capitalize">{human(job.status)}</span>
      </div>
      <div className="min-w-0">
        <p className="break-words text-base font-medium">{job.customerName ?? "No customer linked"} · <span className="capitalize">{human(job.type)}</span></p>
        <p className="break-words text-sm text-muted-foreground">{job.address ?? "No address on file"}</p>
        {job.notes && <p className="mt-1 line-clamp-2 break-words text-sm">{job.notes}</p>}
        {job.onMyWay && <p className="mt-1 text-sm font-medium">{onMyWayLabel(job.onMyWay.state)}</p>}
      </div>
      <ContactLinks job={job} />
      <Link className={primary} href={`/tech?job=${job.id}`}>Open job</Link>
    </article>
  );
}

function JobDetail({ job, day, me, scopeKey, onBack, onChanged }: { job: MyDayJob; day: MyDay; me: MemberProfile; scopeKey: string; onBack: () => void; onChanged: () => void }) {
  const isToday = day.today.some((item) => item.id === job.id);
  return (
    <div className="space-y-4">
      <button type="button" className={secondary} onClick={onBack}><ArrowLeft className="h-5 w-5" aria-hidden /> Back to my day</button>
      <section className={card} aria-label="Job details">
        <h1 className="break-words text-2xl font-bold">{job.customerName ?? "No customer linked"}</h1>
        <p className="text-base">{timeWindow(job, day.timeZone, !isToday)} · <span className="capitalize">{human(job.type)}</span> · <span className="capitalize">{human(job.status)}</span></p>
        <p className="break-words text-base">{job.address ?? "No address on file"}</p>
        {job.customerPhone && <p className="text-base">{job.customerPhone}</p>}
        <ContactLinks job={job} />
        {job.notes && <div><h2 className="text-sm font-semibold">Notes</h2><p className="whitespace-pre-wrap break-words text-base">{job.notes}</p></div>}
      </section>
      {isToday && canWrite(me.role) && <OnMyWay job={job} ready={day.texting.onMyWay} onChanged={onChanged} />}
      <VisitWorkPanel organizationId={day.organizationId} appointmentId={job.id} scopeKey={scopeKey} onCompleted={onChanged} />
      <CollectPayment job={job} day={day} />
    </div>
  );
}

function OnMyWay({ job, ready, onChanged }: { job: MyDayJob; ready: boolean; onChanged: () => void }) {
  const [eta, setEta] = useState<string>("15");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ message: string; hold: boolean } | null>(null);
  const existing = job.onMyWay;
  const locked = busy || result?.hold === true || (existing !== null && existing.state !== "blocked");
  async function send() {
    if (locked) return;
    setBusy(true);
    setResult({ message: "Sending…", hold: true });
    const response = await flow(`appointments/${job.id}/on-my-way`, { etaMinutes: eta ? Number(eta) : null });
    setResult(textResult(response.status, response.outcome));
    setBusy(false);
    onChanged();
  }
  return (
    <section className={card} aria-label="On My Way">
      <h2 className="text-lg font-semibold">On My Way</h2>
      {!ready ? (
        <p className="text-sm">On My Way texts are not set up. An owner or admin can connect your phone app in Settings → Connections → Zapier Connected Apps (APPT · Text On My Way).</p>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">Texts {job.customerName ?? "the customer"} from your business number that you're on the way. Only customers who agreed to texts get one, once per job per day. Your company's setting decides whether your tap sends it right away or the office approves it first.</p>
          {existing && <p className="text-sm font-medium">{onMyWayLabel(existing.state)}{existing.etaMinutes ? ` · about ${existing.etaMinutes} minutes` : ""}</p>}
          <label className="block text-sm font-medium" htmlFor={`eta-${job.id}`}>Arriving in about</label>
          <select id={`eta-${job.id}`} className="min-h-12 w-full rounded-lg border border-input bg-background px-3 text-base" value={eta} disabled={locked} onChange={(event) => setEta(event.target.value)}>
            <option value="">No ETA</option>
            {ETA_CHOICES.map((minutes) => <option key={minutes} value={String(minutes)}>{minutes} minutes</option>)}
          </select>
          <button type="button" className={primary} disabled={locked} onClick={() => void send()}>{busy ? "Sending…" : "Send On My Way"}</button>
        </>
      )}
      {result && <p role="status" className="text-sm font-medium">{result.message}</p>}
    </section>
  );
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/v1${path}`, { credentials: "include", cache: "no-store", ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `Request failed (${response.status})`);
  return body;
}

function CollectPayment({ job, day }: { job: MyDayJob; day: MyDay }) {
  const invoice = job.invoices?.find((item) => (item.balanceDueCents ?? 0) > 0) ?? null;
  const [links, setLinks] = useState<PayLink[] | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [textOutcome, setTextOutcome] = useState<{ message: string; hold: boolean } | null>(null);
  const current = useRef(invoice?.id);
  current.current = invoice?.id;
  // Field collection is scoped to this job: the server checks the invoice is linked to an appointment assigned to you.
  const jobInvoicePath = invoice ? `/appointments/${job.id}/invoices/${invoice.id}` : "";

  async function loadLinks() {
    if (!invoice) return;
    try {
      const list = await api<{ links?: PayLink[] }>(`${jobInvoicePath}/payment-links`);
      if (current.current === invoice.id) setLinks(Array.isArray(list.links) ? list.links : []);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Pay links could not be loaded.");
    }
  }
  useEffect(() => { void loadLinks(); }, [invoice?.id]);

  if (job.invoices === null) {
    return <section className={card} aria-label="Collect payment"><h2 className="text-lg font-semibold">Collect payment</h2><p className="text-sm">Collecting payment here needs field collection access for this job. Ask the office to send the customer a pay link.</p></section>;
  }
  if (!invoice) {
    const paid = job.invoices.find((item) => item.paymentState === "paid");
    return (
      <section className={card} aria-label="Collect payment">
        <h2 className="text-lg font-semibold">Collect payment</h2>
        {paid ? <p className="text-base">Invoice {paid.invoiceNumber ?? ""} is paid in full.</p> : <p className="text-sm">No issued invoice with a balance is linked to this job yet. The office creates and issues the invoice for this job's lead or customer before you can collect.</p>}
        {day.canReadInvoices && <Link className={secondary} href={job.leadId ? `/invoices?leadId=${job.leadId}` : "/invoices"}>Open invoices</Link>}
      </section>
    );
  }
  const balance = invoice.balanceDueCents ?? 0;
  const open = links?.find((link) => link.state === "open" && !!link.url && link.amountCents === balance && (!link.expiresAt || Date.parse(link.expiresAt) > Date.now())) ?? null;
  const pending = links?.some((link) => ["processing", "needs_reconciliation"].includes(link.state)) ?? false;

  async function createLink() {
    setBusy(true); setError(null);
    try { await api(`${jobInvoicePath}/payment-links`, { method: "POST", body: "{}" }); await loadLinks(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not create the pay link."); }
    finally { setBusy(false); }
  }
  async function showQr() {
    if (!open) return;
    setBusy(true); setError(null);
    try { const result = await api<{ qrDataUrl: string; linkId: string }>(`${jobInvoicePath}/payment-links/${open.id}/qr`); if (result.linkId === open.id && result.qrDataUrl.startsWith("data:image/png;base64,")) setQr(result.qrDataUrl); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "The QR code could not be shown."); }
    finally { setBusy(false); }
  }
  async function textLink() {
    if (textOutcome?.hold) return;
    setBusy(true);
    setTextOutcome({ message: "Sending…", hold: true });
    const response = await flow(`appointments/${job.id}/invoices/${invoice!.id}/pay-link-text`, {});
    setTextOutcome(textResult(response.status, response.outcome));
    setBusy(false);
  }

  return (
    <section className={card} aria-label="Collect payment">
      <h2 className="text-lg font-semibold">Collect payment</h2>
      <p className="text-base">Invoice {invoice.invoiceNumber ?? ""} · Balance due <strong>{money(balance)}</strong></p>
      <p className="text-xs text-muted-foreground">Stripe test mode (sandbox): no real cards are charged. Payment is recorded on the invoice when Stripe confirms it.</p>
      {links === null && !error && <p role="status" className="text-sm">Checking pay links…</p>}
      {pending && <p className="text-sm">A payment is clearing or needs review. Check the invoice before collecting again.</p>}
      {links !== null && !open && !pending && (day.canCollectPayments
        ? <button type="button" className={primary} disabled={busy} onClick={() => void createLink()}>Create pay link for {money(balance)}</button>
        : <p className="text-sm">Ask the office to create a pay link for this balance.</p>)}
      {open && (
        <div className="space-y-2">
          {qr ? (
            <figure className="flex flex-col items-center gap-2 rounded-lg bg-white p-3">
              <img src={qr} alt={`QR code to pay ${money(balance)}`} className="h-auto w-full max-w-[280px]" />
              <figcaption className="text-center text-sm text-black">Have the customer scan this with their phone camera to pay {money(balance)}.</figcaption>
            </figure>
          ) : (
            <button type="button" className={primary} disabled={busy} onClick={() => void showQr()}>Show QR code</button>
          )}
          <a className={secondary} href={open.url!} target="_blank" rel="noreferrer">Open pay page on this phone</a>
          {day.texting.payLink
            ? <button type="button" className={secondary} disabled={busy || textOutcome?.hold === true} onClick={() => void textLink()}>Text pay link</button>
            : <p className="text-sm text-muted-foreground">Texting pay links is not set up. An owner or admin can turn on BILL · Text invoice pay links in Settings → Connections.</p>}
        </div>
      )}
      <button type="button" className={secondary} disabled={busy} onClick={() => { setQr(null); void loadLinks(); }}>Refresh payment status</button>
      {textOutcome && <p role="status" className="text-sm font-medium">{textOutcome.message}</p>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    </section>
  );
}
