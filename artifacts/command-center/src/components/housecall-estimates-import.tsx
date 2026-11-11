import { useId, useState } from "react";
import { parseCsvPreview } from "@/lib/csv-preview";
import { ESTIMATE_FIELD_ALIASES, suggestMapping, type EstimateImportField } from "@/lib/housecall-jobs";
import { money } from "@/lib/invoice-ui";
import { ProblemList, errorText, localToday, post, readText, type Problem } from "@/components/housecall-jobs-import";

const MAX_BYTES = 5_000_000;
const button = "inline-flex min-h-10 items-center justify-center rounded-md border px-3 text-sm font-medium disabled:opacity-50";
const primary = `${button} border-primary bg-primary text-primary-foreground`;
const control = "mt-1 block min-h-10 w-full rounded-md border border-input bg-background px-2 text-sm";

const MAIN_FIELDS: { key: EstimateImportField; label: string; hint?: string }[] = [
  { key: "estimateId", label: "Estimate ID (HCP Id)", hint: "required" },
  { key: "estimateNumber", label: "Estimate number" },
  { key: "status", label: "Estimate status", hint: "if your export has one" },
  { key: "email", label: "Customer email" },
  { key: "phone", label: "Customer mobile phone" },
  { key: "amount", label: "Estimate total", hint: "if your export has one" },
  { key: "createdAt", label: "Created date" },
  { key: "scheduledStart", label: "Estimate visit date" },
];
const MORE_FIELDS: { key: EstimateImportField; label: string }[] = [
  { key: "scheduledEnd", label: "Estimate visit end time" },
  { key: "customerName", label: "Customer name" },
  { key: "firstName", label: "Customer first name" },
  { key: "lastName", label: "Customer last name" },
  { key: "homePhone", label: "Customer home phone" },
  { key: "street", label: "Service street" },
  { key: "street2", label: "Service unit / line 2" },
  { key: "city", label: "Service city" },
  { key: "state", label: "Service state" },
  { key: "postalCode", label: "Service ZIP" },
  { key: "customerTags", label: "Customer tags" },
  { key: "tax", label: "Tax" },
  { key: "description", label: "Description" },
  { key: "employees", label: "Assigned employees" },
];

export type EstimatesResult = {
  dryRun: boolean; totalRows: number; openEstimates: number; sent: number; drafts: number;
  decidedHistory: number; approved: number; declined: number; closed: number;
  alreadyImported: number; changedSinceImport: number; visitsToBook: number; missingAmounts: number; propertiesCreated: number;
  unmatched: Problem[]; problems: Problem[]; listsTruncated: boolean;
  sample: { row: number; estimateNumber: string | null; customer: string; status: string; totalCents: number | null; action: string }[];
};

/**
 * Housecall Pro estimates report → open estimates ready for follow-up and
 * decided estimates as customer history. Preview first; nothing is sent.
 */
export function HousecallEstimatesImport() {
  const prefix = useId();
  const [file, setFile] = useState<{ name: string; text: string; header: string[]; samples: string[][] } | null>(null);
  const [mapping, setMapping] = useState<Partial<Record<EstimateImportField, number>>>({});
  const [openEstimatesAre, setOpenEstimatesAre] = useState<"" | "sent" | "draft">("");
  const [exportedOn, setExportedOn] = useState(localToday);
  const [timeZone, setTimeZone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone || "America/New_York");
  const [preview, setPreview] = useState<{ key: string; result: EstimatesResult } | null>(null);
  const [reviewed, setReviewed] = useState(false);
  const [done, setDone] = useState<EstimatesResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const request = file && { csv: file.text, fileName: file.name, mapping, exportedOn, timeZone, ...(openEstimatesAre ? { openEstimatesAre } : {}) };
  const key = request ? JSON.stringify({ ...request, csv: `${file!.text.length}:${file!.text.slice(0, 2000)}` }) : "";
  const missing = mapping.estimateId === undefined || (mapping.email === undefined && mapping.phone === undefined && mapping.homePhone === undefined) ||
    (mapping.status === undefined && !openEstimatesAre) || !exportedOn;
  const reset = () => { setPreview(null); setReviewed(false); };

  async function load(selected: File | undefined) {
    setError(""); reset(); setDone(null); setFile(null); setMapping({}); setOpenEstimatesAre("");
    if (!selected) return;
    if (/\.xlsx?$/i.test(selected.name)) { setError("This is an Excel file. Open it in Excel or Google Sheets, save or download it as CSV, then upload the CSV."); return; }
    if (selected.size > MAX_BYTES) { setError("The file is larger than 5 MB. Export a shorter date range and import each file."); return; }
    try {
      const text = await readText(selected);
      const [header = [], ...samples] = parseCsvPreview(text, 6);
      if (header.length < 2) { setError("No columns were found. Upload the estimates report CSV."); return; }
      setFile({ name: selected.name, text, header, samples });
      setMapping(suggestMapping(header, ESTIMATE_FIELD_ALIASES));
    } catch {
      setError("The CSV could not be read. Check that it is a valid CSV file and upload it again. Nothing was imported.");
    }
  }
  const choose = (field: EstimateImportField, value: number | undefined) => {
    reset();
    setMapping((current) => {
      const next = { ...current };
      for (const k of Object.keys(next) as EstimateImportField[]) if (next[k] === value) delete next[k];
      if (value === undefined) delete next[field]; else next[field] = value;
      return next;
    });
  };
  async function run(dryRun: boolean) {
    if (!request || busy) return;
    setBusy(true); setError("");
    if (dryRun) setReviewed(false);
    try {
      const result = await post<EstimatesResult>("/housecall-import/estimates", { ...request, dryRun });
      if (dryRun) setPreview({ key, result }); else { setDone(result); reset(); }
    } catch (err) {
      setError(errorText(err, !dryRun));
      if (!dryRun) reset();
    } finally { setBusy(false); }
  }
  const select = (field: { key: EstimateImportField; label: string; hint?: string }) => {
    const index = mapping[field.key];
    const sample = index === undefined || !file ? "" : file.samples.map((row) => row[index] ?? "").filter(Boolean).slice(0, 2).join(", ");
    return (
      <label key={field.key} className="block">
        <span className="font-medium">{field.label}{field.hint ? ` (${field.hint})` : ""}</span>
        <select className={control} value={index ?? ""} disabled={busy} onChange={(e) => choose(field.key, e.target.value === "" ? undefined : Number(e.target.value))}>
          <option value="">Not imported</option>
          {file!.header.map((name, i) => <option key={i} value={i}>{name || `Column ${i + 1}`}</option>)}
        </select>
        {sample && <span className="mt-1 block truncate text-xs text-muted-foreground">e.g. {sample}</span>}
      </label>
    );
  };
  const p = preview?.key === key ? preview.result : null;

  return (
    <div className="space-y-4 text-sm" data-testid="hcp-estimates-import">
      <section aria-labelledby={`${prefix}-export`} className="space-y-2">
        <h3 id={`${prefix}-export`} className="font-medium">1. Export your estimates from Housecall Pro</h3>
        <ol className="list-decimal space-y-1 pl-5 text-muted-foreground">
          <li>On the Housecall Pro dashboard, open <strong>Open Estimates</strong> and click <strong>See all estimates</strong>.</li>
          <li>Under <strong>Table Columns</strong>, select every column, then export.</li>
          <li>If the file ends in .xlsx, open it and save or download it as <strong>CSV</strong>.</li>
        </ol>
        <p className="text-muted-foreground">Import your customer list first, so every estimate can be matched to its customer by email or phone.</p>
      </section>
      <section aria-labelledby={`${prefix}-upload`} className="space-y-2">
        <h3 id={`${prefix}-upload`} className="font-medium">2. Upload the estimates CSV</h3>
        <input type="file" accept=".csv,text/csv,.xlsx,.xls" aria-label="Housecall Pro estimates CSV" onChange={(e) => void load(e.target.files?.[0])} disabled={busy} />
      </section>
      {file && (
        <section aria-labelledby={`${prefix}-map`} className="space-y-3">
          <h3 id={`${prefix}-map`} className="font-medium">3. Check each column</h3>
          <div className="grid gap-3 sm:grid-cols-2">
            {MAIN_FIELDS.map(select)}
            <label className="block">
              <span className="font-medium">Date you exported the file</span>
              <input type="date" className={control} value={exportedOn} max={localToday()} onChange={(e) => { reset(); setExportedOn(e.target.value); }} disabled={busy} />
            </label>
            <label className="block">
              <span className="font-medium">Company time zone (times in the file)</span>
              <input className={control} value={timeZone} onChange={(e) => { reset(); setTimeZone(e.target.value); }} disabled={busy} />
            </label>
          </div>
          <fieldset className="space-y-1">
            <legend className="font-medium">
              {mapping.status === undefined ? "This file has no status column. Were these open estimates already sent to customers?" : "Rows with a blank status were…"}
            </legend>
            <label className="flex items-center gap-2"><input type="radio" name={`${prefix}-open`} checked={openEstimatesAre === "sent"} onChange={() => { reset(); setOpenEstimatesAre("sent"); }} disabled={busy} /> Sent, awaiting the customer's decision</label>
            <label className="flex items-center gap-2"><input type="radio" name={`${prefix}-open`} checked={openEstimatesAre === "draft"} onChange={() => { reset(); setOpenEstimatesAre("draft"); }} disabled={busy} /> Not sent yet (drafts)</label>
          </fieldset>
          <details>
            <summary className="font-medium">More columns (address, tags, tax…)</summary>
            <div className="mt-2 grid gap-3 sm:grid-cols-2">{MORE_FIELDS.map(select)}</div>
          </details>
          {missing && <p role="alert" className="text-destructive">Choose the estimate ID and an email or phone column{mapping.status === undefined ? ", and say whether these estimates were sent" : ""}.</p>}
          <button type="button" className={button} disabled={busy || missing} onClick={() => void run(true)}>
            {busy && !p ? "Checking…" : "Preview estimates"}
          </button>
        </section>
      )}
      {p && (
        <section className="space-y-2" data-testid="hcp-estimates-preview">
          <h3 className="font-medium">4. Review estimates before importing (nothing saved yet)</h3>
          <ul className="grid gap-1 sm:grid-cols-3">
            <li>{p.totalRows} rows in file</li>
            <li>{p.openEstimates} open estimates</li>
            <li>{p.sent} sent, awaiting a decision</li>
            <li>{p.drafts} drafts</li>
            <li>{p.decidedHistory} approved, declined or closed (history only)</li>
            <li>{p.alreadyImported} already imported</li>
            <li>{p.visitsToBook} estimate visits to book</li>
            <li>{p.missingAmounts} without an amount</li>
            <li>{p.unmatched.length} not matched to a customer</li>
          </ul>
          {p.sample.length > 0 && (
            <div className="overflow-x-auto">
              <table className="min-w-full text-left text-xs">
                <thead><tr><th className="pr-3">Row</th><th className="pr-3">Estimate</th><th className="pr-3">Customer</th><th className="pr-3">Status</th><th className="pr-3">Total</th><th>Becomes</th></tr></thead>
                <tbody>{p.sample.map((s) => (
                  <tr key={s.row}><td className="pr-3">{s.row}</td><td className="pr-3">{s.estimateNumber ?? "—"}</td><td className="pr-3">{s.customer}</td><td className="pr-3">{s.status}</td><td className="pr-3">{s.totalCents === null ? "—" : money(s.totalCents)}</td><td>{s.action}</td></tr>
                ))}</tbody>
              </table>
            </div>
          )}
          <ProblemList title="Not matched to a customer" rows={p.unmatched} truncated={p.listsTruncated} testId="hcp-estimates-unmatched" noun="estimate" />
          <ProblemList title="Rows that will not be imported as-is" rows={p.problems} truncated={p.listsTruncated} testId="hcp-estimates-problems" noun="estimate" />
          <p className="text-muted-foreground">
            Open estimates appear under Estimates on each customer and in your follow-up list. Approved, declined and closed estimates are kept as read-only history on the customer. Nothing is sent to customers; your team decides any follow-up.
          </p>
          <label className="flex items-start gap-2">
            <input type="checkbox" className="mt-1" checked={reviewed} onChange={(e) => setReviewed(e.target.checked)} disabled={busy} />
            <span>I reviewed this preview and want to import these estimates.</span>
          </label>
          <button type="button" className={primary} disabled={busy || !reviewed || p.openEstimates + p.decidedHistory === 0} onClick={() => void run(false)}>
            {busy ? "Importing…" : "Import estimates"}
          </button>
        </section>
      )}
      {done && (
        <p role="status" data-testid="hcp-estimates-done">
          Imported {done.openEstimates} open estimates ({done.sent} sent, {done.drafts} drafts) and {done.decidedHistory} as history; {done.unmatched.length} were not matched to a customer. Nothing was sent to customers.
        </p>
      )}
      {error && <p role="alert" className="text-destructive">{error}</p>}
    </div>
  );
}
