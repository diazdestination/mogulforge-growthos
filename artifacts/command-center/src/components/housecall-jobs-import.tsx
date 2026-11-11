import { useId, useState } from "react";
import { parseCsvPreview } from "@/lib/csv-preview";
import { suggestJobsMapping, type JobImportField } from "@/lib/housecall-jobs";
import { money } from "@/lib/invoice-ui";

const MAX_BYTES = 5_000_000;
const button = "inline-flex min-h-10 items-center justify-center rounded-md border px-3 text-sm font-medium disabled:opacity-50";
const primary = `${button} border-primary bg-primary text-primary-foreground`;
const control = "mt-1 block min-h-10 w-full rounded-md border border-input bg-background px-2 text-sm";

const MAIN_FIELDS: { key: JobImportField; label: string; hint?: string }[] = [
  { key: "jobId", label: "Job ID (HCP Id)", hint: "required" },
  { key: "jobNumber", label: "Invoice / job number", hint: "needed for invoices" },
  { key: "status", label: "Job status" },
  { key: "completedAt", label: "Finished date" },
  { key: "scheduledStart", label: "Scheduled date" },
  { key: "scheduledEnd", label: "Scheduled end time" },
  { key: "email", label: "Customer email" },
  { key: "phone", label: "Customer mobile phone" },
  { key: "amount", label: "Amount (job total)", hint: "needed for invoices" },
  { key: "paidAmount", label: "Paid amount", hint: "needed for invoices" },
  { key: "due", label: "Amount due", hint: "needed for invoices" },
];
const MORE_FIELDS: { key: JobImportField; label: string }[] = [
  { key: "createdAt", label: "Created date" },
  { key: "customerName", label: "Customer name" },
  { key: "firstName", label: "Customer first name" },
  { key: "lastName", label: "Customer last name" },
  { key: "homePhone", label: "Customer home phone" },
  { key: "customerId", label: "Housecall Pro customer ID" },
  { key: "street", label: "Service street" },
  { key: "street2", label: "Service unit / line 2" },
  { key: "city", label: "Service city" },
  { key: "state", label: "Service state" },
  { key: "postalCode", label: "Service ZIP" },
  { key: "description", label: "Job description" },
  { key: "lineItems", label: "Line items" },
  { key: "tax", label: "Tax" },
  { key: "paymentHistory", label: "Payment history" },
  { key: "employees", label: "Assigned employees" },
  { key: "invoiceSentAt", label: "Invoice sent date" },
  { key: "jobTags", label: "Job tags" },
  { key: "customerTags", label: "Customer tags" },
  { key: "leadSource", label: "Lead / booking source" },
];

export type Problem = { row: number; jobNumber: string | null; customer: string | null; reason: string; totalCents?: number | null };
export type JobsResult = {
  dryRun: boolean; batchId: string | null; totalRows: number; newJobs: number; updatedJobs: number; alreadyImported: number;
  completed: number; upcoming: number; canceled: number; appointmentsCreated: number; needsScheduling: number; propertiesCreated: number;
  unmatched: Problem[]; problems: Problem[]; listsTruncated: boolean;
  sample: { row: number; jobNumber: string | null; customer: string; status: string; date: string | null; totalCents: number | null; action: string }[];
};
export type InvoicePreview = {
  cutoffAt: string; file: { count: number; totalCents: number };
  ready: { count: number; totalCents: number; paidInFull: number; paymentCents: number; openBalances: number; openingReceivableCents: number; estimatedPaymentDates: number };
  alreadyImported: { count: number; totalCents: number }; notInvoiced: number;
  unmatched: Problem[]; unreconciled: Problem[]; listsTruncated: boolean;
  reviews: { id: string; digest: string; invoiceCount: number; documentTotalCents: number; expiresAt: string }[];
};
export type InvoiceCommit = {
  batchId: string | null; failure: { id: string; code: string; message: string } | null; remaining: number;
  totals: { reviews: number; invoices: number; receipts: number; documentTotalCents: number; openingReceivableCents: number; paymentCents: number };
};

export class RequestError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
export async function post<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`/api/v1${path}`, {
    method: "POST", credentials: "include", cache: "no-store", signal: AbortSignal.timeout(150_000),
    headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const value = await response.json().catch(() => null);
  if (!response.ok) throw new RequestError(response.status, typeof value?.error === "string" ? value.error : "");
  if (value === null) throw new RequestError(0, "");
  return value as T;
}
export const errorText = (err: unknown, saving: boolean) =>
  err instanceof RequestError && err.status >= 400 && err.status < 500 && err.message
    ? err.message
    : saving
      ? "We could not confirm the result. Some records may have been saved. Preview again before retrying; a repeat import never duplicates records."
      : "The file could not be checked. Nothing was imported.";
export function readText(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error);
    reader.onabort = () => reject(new Error("File read aborted"));
    reader.readAsText(file);
  });
}
export const localToday = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const date = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString() : "—");

export function ProblemList({ title, rows, truncated, testId, noun = "job" }: { title: string; rows: Problem[]; truncated: boolean; testId: string; noun?: string }) {
  if (!rows.length) return null;
  return (
    <details open={rows.length <= 10} data-testid={testId}>
      <summary className="font-medium">{title} ({rows.length}{truncated ? "+" : ""})</summary>
      <ul className="mt-1 max-h-56 list-disc space-y-1 overflow-auto pl-5 text-muted-foreground">
        {rows.map((r) => (
          <li key={`${r.row}-${r.reason}`}>
            Row {r.row}{r.jobNumber ? `, ${noun} ${r.jobNumber}` : ""}{r.customer ? ` (${r.customer})` : ""}{typeof r.totalCents === "number" ? `, ${money(r.totalCents)}` : ""}: {r.reason}
          </li>
        ))}
      </ul>
      {truncated && <p className="text-muted-foreground">More rows have problems than are listed here.</p>}
    </details>
  );
}

/**
 * Housecall Pro jobs report → job history, then the same file's invoice
 * columns → invoices and open balances. Each step previews first (nothing
 * saved) and needs an explicit confirmation. Nothing is sent to customers.
 */
export function HousecallJobsImport() {
  const prefix = useId();
  const [file, setFile] = useState<{ name: string; text: string; header: string[]; samples: string[][] } | null>(null);
  const [mapping, setMapping] = useState<Partial<Record<JobImportField, number>>>({});
  const [exportedOn, setExportedOn] = useState(localToday);
  const [timeZone, setTimeZone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone || "America/New_York");
  const [jobsPreview, setJobsPreview] = useState<{ key: string; result: JobsResult } | null>(null);
  const [jobsReviewed, setJobsReviewed] = useState(false);
  const [jobsDone, setJobsDone] = useState<JobsResult | null>(null);
  const [invoicePreview, setInvoicePreview] = useState<{ key: string; result: InvoicePreview } | null>(null);
  const [invoiceReviewed, setInvoiceReviewed] = useState(false);
  const [invoiceDone, setInvoiceDone] = useState<InvoiceCommit | null>(null);
  const [busy, setBusy] = useState<"" | "jobs" | "invoices">("");
  const [error, setError] = useState("");

  const request = file && { csv: file.text, fileName: file.name, mapping, exportedOn, timeZone };
  // A preview only authorizes exactly what it checked.
  const key = request ? JSON.stringify({ ...request, csv: `${file!.text.length}:${file!.text.slice(0, 2000)}` }) : "";
  const jobsCurrent = jobsPreview?.key === key;
  const invoicesCurrent = invoicePreview?.key === key;
  const missingJobs = mapping.jobId === undefined || (mapping.email === undefined && mapping.phone === undefined && mapping.homePhone === undefined && mapping.customerId === undefined) ||
    (mapping.status === undefined && mapping.completedAt === undefined) || !exportedOn;
  const missingInvoices = missingJobs || mapping.jobNumber === undefined || mapping.amount === undefined || mapping.paidAmount === undefined || mapping.due === undefined;

  const reset = () => { setJobsPreview(null); setJobsReviewed(false); setInvoicePreview(null); setInvoiceReviewed(false); };
  async function load(selected: File | undefined) {
    setError(""); reset(); setJobsDone(null); setInvoiceDone(null); setFile(null); setMapping({});
    if (!selected) return;
    if (/\.xlsx?$/i.test(selected.name)) { setError("This is an Excel file. Open it in Excel or Google Sheets, save or download it as CSV, then upload the CSV."); return; }
    if (selected.size > MAX_BYTES) { setError("The file is larger than 5 MB. Export a shorter date range (for example one year) and import each file."); return; }
    try {
      const text = await readText(selected);
      const [header = [], ...samples] = parseCsvPreview(text, 6);
      if (header.length < 2) { setError("No columns were found. Upload the jobs report CSV."); return; }
      setFile({ name: selected.name, text, header, samples });
      setMapping(suggestJobsMapping(header));
    } catch {
      setError("The CSV could not be read. Check that it is a valid CSV file and upload it again. Nothing was imported.");
    }
  }
  const choose = (field: JobImportField, value: number | undefined) => {
    reset();
    setMapping((current) => {
      const next = { ...current };
      for (const k of Object.keys(next) as JobImportField[]) if (next[k] === value) delete next[k];
      if (value === undefined) delete next[field]; else next[field] = value;
      return next;
    });
  };
  async function runJobs(dryRun: boolean) {
    if (!request || busy) return;
    setBusy("jobs"); setError("");
    if (dryRun) setJobsReviewed(false);
    try {
      const result = await post<JobsResult>("/housecall-import/jobs", { ...request, dryRun });
      if (dryRun) setJobsPreview({ key, result }); else { setJobsDone(result); setJobsPreview(null); setJobsReviewed(false); }
    } catch (err) {
      setError(errorText(err, !dryRun));
      if (!dryRun) { setJobsPreview(null); setJobsReviewed(false); }
    } finally { setBusy(""); }
  }
  async function previewInvoices() {
    if (!request || busy) return;
    setBusy("invoices"); setError(""); setInvoiceReviewed(false); setInvoiceDone(null);
    try { setInvoicePreview({ key, result: await post<InvoicePreview>("/housecall-import/invoices/preview", request) }); }
    catch (err) { setError(errorText(err, false)); }
    finally { setBusy(""); }
  }
  async function commitInvoices() {
    if (!invoicePreview || busy) return;
    setBusy("invoices"); setError("");
    try {
      const result = await post<InvoiceCommit>("/housecall-import/invoices/commit", {
        reviews: invoicePreview.result.reviews.map(({ id, digest }) => ({ id, digest })), confirmed: true, sourceFrozen: true,
      });
      setInvoiceDone(result);
      if (result.failure) setError(`${result.failure.message} Groups imported before this stopped are kept; preview again to continue.`);
    } catch (err) {
      setError(errorText(err, true));
    } finally { setBusy(""); setInvoicePreview(null); setInvoiceReviewed(false); }
  }

  const select = (field: { key: JobImportField; label: string; hint?: string }) => {
    const index = mapping[field.key];
    const sample = index === undefined || !file ? "" : file.samples.map((row) => row[index] ?? "").filter(Boolean).slice(0, 2).join(", ");
    return (
      <label key={field.key} className="block">
        <span className="font-medium">{field.label}{field.hint ? ` (${field.hint})` : ""}</span>
        <select className={control} value={index ?? ""} disabled={!!busy} onChange={(e) => choose(field.key, e.target.value === "" ? undefined : Number(e.target.value))}>
          <option value="">Not imported</option>
          {file!.header.map((name, i) => <option key={i} value={i}>{name || `Column ${i + 1}`}</option>)}
        </select>
        {sample && <span className="mt-1 block truncate text-xs text-muted-foreground">e.g. {sample}</span>}
      </label>
    );
  };
  const jp = jobsCurrent ? jobsPreview!.result : null;
  const ip = invoicesCurrent ? invoicePreview!.result : null;
  const listedCents = ip ? ip.ready.totalCents + ip.alreadyImported.totalCents + [...ip.unmatched, ...ip.unreconciled].reduce((n, r) => n + (r.totalCents ?? 0), 0) : 0;

  return (
    <div className="space-y-4 text-sm" data-testid="hcp-jobs-import">
      <section aria-labelledby={`${prefix}-export`} className="space-y-2">
        <h3 id={`${prefix}-export`} className="font-medium">1. Export your jobs report from Housecall Pro</h3>
        <ol className="list-decimal space-y-1 pl-5 text-muted-foreground">
          <li>On the Housecall Pro dashboard, click <strong>See all jobs</strong>.</li>
          <li>Set the date range from your first day on Housecall Pro to today (for a large history, one year per file).</li>
          <li>Under <strong>Table Columns</strong>, select every column, then export (Excel/CSV icon).</li>
          <li>If the file ends in .xlsx, open it and save or download it as <strong>CSV</strong>.</li>
        </ol>
        <p className="text-muted-foreground">Import your customer list first, so every job can be matched to its customer by email or phone.</p>
      </section>

      <section aria-labelledby={`${prefix}-upload`} className="space-y-2">
        <h3 id={`${prefix}-upload`} className="font-medium">2. Upload the jobs CSV</h3>
        <input type="file" accept=".csv,text/csv,.xlsx,.xls" aria-label="Housecall Pro jobs CSV" onChange={(e) => void load(e.target.files?.[0])} disabled={!!busy} />
      </section>

      {file && (
        <section aria-labelledby={`${prefix}-map`} className="space-y-3">
          <h3 id={`${prefix}-map`} className="font-medium">3. Check each column</h3>
          <p className="text-muted-foreground">We suggested matches from the Housecall Pro column names. Check every one; choose “Not imported” for anything that doesn't fit.</p>
          <div className="grid gap-3 sm:grid-cols-2">
            {MAIN_FIELDS.map(select)}
            <label className="block">
              <span className="font-medium">Date you exported the file</span>
              <input type="date" className={control} value={exportedOn} max={localToday()} onChange={(e) => { reset(); setExportedOn(e.target.value); }} disabled={!!busy} />
            </label>
            <label className="block">
              <span className="font-medium">Company time zone (times in the file)</span>
              <input className={control} value={timeZone} onChange={(e) => { reset(); setTimeZone(e.target.value); }} disabled={!!busy} />
            </label>
          </div>
          <details>
            <summary className="font-medium">More columns (address, description, employees, tags…)</summary>
            <div className="mt-2 grid gap-3 sm:grid-cols-2">{MORE_FIELDS.map(select)}</div>
          </details>
          {missingJobs && <p role="alert" className="text-destructive">Choose the job ID, the job status or finished date, and an email, phone or customer ID column.</p>}
          <button type="button" className={button} disabled={!!busy || missingJobs} onClick={() => void runJobs(true)}>
            {busy === "jobs" && !jobsCurrent ? "Checking…" : "Preview jobs"}
          </button>
        </section>
      )}

      {jp && (
        <section className="space-y-2" data-testid="hcp-jobs-preview">
          <h3 className="font-medium">4. Review jobs before importing (nothing saved yet)</h3>
          <ul className="grid gap-1 sm:grid-cols-3">
            <li>{jp.totalRows} rows in file</li>
            <li>{jp.newJobs} new jobs</li>
            <li>{jp.updatedJobs} updated</li>
            <li>{jp.alreadyImported} already imported</li>
            <li>{jp.completed} completed</li>
            <li>{jp.upcoming} open or upcoming</li>
            <li>{jp.canceled} canceled</li>
            <li>{jp.appointmentsCreated} calendar visits</li>
            <li>{jp.needsScheduling} need scheduling</li>
            <li>{jp.propertiesCreated} new service addresses</li>
            <li>{jp.unmatched.length} not matched to a customer</li>
          </ul>
          {jp.sample.length > 0 && (
            <div className="overflow-x-auto">
              <table className="min-w-full text-left text-xs">
                <thead><tr><th className="pr-3">Row</th><th className="pr-3">Job</th><th className="pr-3">Customer</th><th className="pr-3">Status</th><th className="pr-3">Date</th><th className="pr-3">Total</th><th>Becomes</th></tr></thead>
                <tbody>{jp.sample.map((s) => (
                  <tr key={s.row}><td className="pr-3">{s.row}</td><td className="pr-3">{s.jobNumber ?? "—"}</td><td className="pr-3">{s.customer}</td><td className="pr-3">{s.status}</td><td className="pr-3">{date(s.date)}</td><td className="pr-3">{s.totalCents === null ? "—" : money(s.totalCents)}</td><td>{s.action}</td></tr>
                ))}</tbody>
              </table>
            </div>
          )}
          <ProblemList title="Not matched to a customer" rows={jp.unmatched} truncated={jp.listsTruncated} testId="hcp-jobs-unmatched" />
          <ProblemList title="Rows that will not be imported as-is" rows={jp.problems} truncated={jp.listsTruncated} testId="hcp-jobs-problems" />
          <p className="text-muted-foreground">
            Past jobs become read-only job history on each customer. Future visits with a service address go on the calendar; others are flagged for you to schedule. No reminders, texts or emails are sent.
          </p>
          <label className="flex items-start gap-2">
            <input type="checkbox" className="mt-1" checked={jobsReviewed} onChange={(e) => setJobsReviewed(e.target.checked)} disabled={!!busy} />
            <span>I reviewed this preview and want to import these jobs.</span>
          </label>
          <button type="button" className={primary} disabled={!!busy || !jobsReviewed || jp.newJobs + jp.updatedJobs === 0} onClick={() => void runJobs(false)}>
            {busy === "jobs" ? "Importing…" : "Import jobs"}
          </button>
        </section>
      )}
      {jobsDone && (
        <p role="status" data-testid="hcp-jobs-done">
          Imported {jobsDone.newJobs} jobs and updated {jobsDone.updatedJobs}; {jobsDone.appointmentsCreated} calendar visits added, {jobsDone.needsScheduling} need scheduling, {jobsDone.unmatched.length} were not matched to a customer.
        </p>
      )}

      {file && (
        <section className="space-y-2 border-t pt-4" aria-labelledby={`${prefix}-inv`}>
          <h3 id={`${prefix}-inv`} className="font-medium">5. Invoices and open balances (owner or admin)</h3>
          <p className="text-muted-foreground">
            Uses the same file after the jobs are imported. Paid invoices come in as paid history with their payment; unpaid and partly paid invoices come in with the exact balance still due. Original invoice numbers and dates are kept, and no payment is invented.
          </p>
          {missingInvoices && <p className="text-muted-foreground">Choose the invoice number, amount, paid amount and amount due columns above.</p>}
          <button type="button" className={button} disabled={!!busy || missingInvoices} onClick={() => void previewInvoices()}>
            {busy === "invoices" && !invoicesCurrent ? "Checking…" : "Preview invoices"}
          </button>
        </section>
      )}
      {ip && (
        <section className="space-y-2" data-testid="hcp-invoice-preview">
          <h4 className="font-medium">Review the totals (no invoices created yet)</h4>
          <div className="overflow-x-auto">
            <table className="min-w-full text-left">
              <tbody>
                <tr><th className="pr-4 font-normal">Invoices in the file</th><td className="pr-4">{ip.file.count}</td><td>{money(ip.file.totalCents)}</td></tr>
                <tr><th className="pr-4 font-normal">Ready to import</th><td className="pr-4">{ip.ready.count}</td><td>{money(ip.ready.totalCents)}</td></tr>
                <tr><th className="pr-4 font-normal pl-3">paid in full</th><td className="pr-4">{ip.ready.paidInFull}</td><td>{money(ip.ready.paymentCents)} paid</td></tr>
                <tr><th className="pr-4 font-normal pl-3">open balances</th><td className="pr-4">{ip.ready.openBalances}</td><td>{money(ip.ready.openingReceivableCents)} still due</td></tr>
                <tr><th className="pr-4 font-normal">Already imported</th><td className="pr-4">{ip.alreadyImported.count}</td><td>{money(ip.alreadyImported.totalCents)}</td></tr>
                <tr><th className="pr-4 font-normal">Not matched</th><td className="pr-4">{ip.unmatched.length}</td><td>{money(ip.unmatched.reduce((n, r) => n + (r.totalCents ?? 0), 0))}</td></tr>
                <tr><th className="pr-4 font-normal">Need reconciliation by hand</th><td className="pr-4">{ip.unreconciled.length}</td><td>{money(ip.unreconciled.reduce((n, r) => n + (r.totalCents ?? 0), 0))}</td></tr>
              </tbody>
            </table>
          </div>
          <p data-testid="hcp-invoice-reconcile" className={listedCents === ip.file.totalCents && !ip.listsTruncated ? "text-muted-foreground" : "text-destructive"}>
            {listedCents === ip.file.totalCents && !ip.listsTruncated
              ? `Every invoice in the file is accounted for (${money(listedCents)}).`
              : "Some rows are not listed here; fix the file or import a shorter date range before relying on these totals."}
          </p>
          {ip.ready.estimatedPaymentDates > 0 && <p className="text-muted-foreground">{ip.ready.estimatedPaymentDates} paid invoices have no payment date in the export; their job's finished date is recorded as the payment date.</p>}
          <p className="text-muted-foreground">{ip.notInvoiced} jobs in the file have no invoice yet (open, canceled or $0).</p>
          {ip.alreadyImported.count > 0 && <p className="text-muted-foreground">Already imported invoices are left as they are. Record any payment taken in Housecall Pro after the first import on the invoice in GrowthOS.</p>}
          <ProblemList title="Not matched to an imported job" rows={ip.unmatched} truncated={ip.listsTruncated} testId="hcp-invoice-unmatched" />
          <ProblemList title="Need reconciliation by hand" rows={ip.unreconciled} truncated={ip.listsTruncated} testId="hcp-invoice-unreconciled" />
          {ip.reviews.length > 0 && (
            <>
              <label className="flex items-start gap-2">
                <input type="checkbox" className="mt-1" checked={invoiceReviewed} onChange={(e) => setInvoiceReviewed(e.target.checked)} disabled={!!busy} />
                <span>I reviewed these totals. The Housecall Pro amounts are final as of {new Date(ip.cutoffAt).toLocaleDateString()}, and I will stop collecting these invoices in Housecall Pro.</span>
              </label>
              <p className="text-muted-foreground">Confirm within 30 minutes of the preview.</p>
              <button type="button" className={primary} disabled={!!busy || !invoiceReviewed} onClick={() => void commitInvoices()}>
                {busy === "invoices" ? "Importing…" : `Import ${ip.ready.count} invoices`}
              </button>
            </>
          )}
        </section>
      )}
      {invoiceDone && (
        <p role="status" data-testid="hcp-invoice-done">
          Imported {invoiceDone.totals.invoices} invoices totaling {money(invoiceDone.totals.documentTotalCents)}, with {money(invoiceDone.totals.openingReceivableCents)} still due and {money(invoiceDone.totals.paymentCents)} of recorded past payments.
          {invoiceDone.remaining > 0 ? ` ${invoiceDone.remaining} groups were not imported.` : ""} Nothing was sent to customers.
        </p>
      )}
      {error && <p role="alert" className="text-destructive">{error}</p>}
    </div>
  );
}
