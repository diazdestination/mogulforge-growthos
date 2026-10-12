import { useId, useState } from "react";
import { importLeadsCsv, type LeadImport, type LeadImportPreview } from "@workspace/api-client-react";
import { parseCsvPreview, suggestCustomerMapping, type CustomerImportField } from "@/lib/csv-preview";

const FIELDS: { key: CustomerImportField; label: string; required?: boolean }[] = [
  { key: "firstName", label: "First name", required: true },
  { key: "lastName", label: "Last name" },
  { key: "email", label: "Email" },
  { key: "phone", label: "Phone" },
  { key: "externalCustomerId", label: "Housecall Pro customer ID" },
];
const SOURCE_KEY = "housecall-pro";
const MAX_BYTES = 5_000_000;
const button = "inline-flex min-h-10 items-center justify-center rounded-md border px-3 text-sm font-medium disabled:opacity-50";
const primary = `${button} border-primary bg-primary text-primary-foreground`;
const control = "mt-1 block min-h-10 w-full rounded-md border border-input bg-background px-2 text-sm";

type Loaded = { name: string; text: string; header: string[]; samples: string[][] };

function readText(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}
function errorText(err: unknown, dryRun: boolean) {
  const data = (err as { data?: { error?: unknown } } | null)?.data;
  const status = (err as { status?: unknown } | null)?.status;
  // A rejected request (4xx with a reason) saved nothing; anything else after an
  // import was sent may have saved some rows.
  if (typeof data?.error === "string" && typeof status === "number" && status >= 400 && status < 500) return data.error;
  return dryRun
    ? "The file could not be checked. Nothing was imported."
    : "We could not confirm the import result. Some customers may have been saved. Check your import history before trying again.";
}

/**
 * Onboarding: the contractor exports their own Housecall Pro customer list,
 * uploads it, confirms each column, previews the result (nothing saved) and
 * only then imports. Uses the existing reviewed customer/lead import.
 */
export function HousecallCustomerImport({ onImported }: { onImported: (result: LeadImport) => void }) {
  const prefix = useId();
  const [file, setFile] = useState<Loaded | null>(null);
  const [mapping, setMapping] = useState<Partial<Record<CustomerImportField, number>>>({});
  const [exportedOn, setExportedOn] = useState("");
  const [preview, setPreview] = useState<{ key: string; result: LeadImportPreview } | null>(null);
  const [reviewed, setReviewed] = useState(false);
  const [done, setDone] = useState<LeadImport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const request = file && {
    csv: file.text,
    fileName: file.name,
    hasHeader: true,
    mapping,
    sourceKey: SOURCE_KEY,
    mode: "customers" as const,
    ...(exportedOn ? { snapshotAsOf: exportedOn } : {}),
  };
  // A preview only authorizes the import of exactly what it checked.
  const requestKey = request ? JSON.stringify({ ...request, csv: `${file!.text.length}:${file!.text.slice(0, 2000)}` }) : "";
  const previewCurrent = !!preview && preview.key === requestKey;
  const missing = mapping.firstName === undefined || (mapping.email === undefined && mapping.phone === undefined);

  async function load(selected: File | undefined) {
    setError(""); setPreview(null); setDone(null); setReviewed(false); setFile(null); setMapping({});
    if (!selected) return;
    if (/\.xlsx?$/i.test(selected.name)) {
      setError("This is an Excel file. Open it in Excel or Google Sheets, save or download it as CSV, then upload the CSV.");
      return;
    }
    if (selected.size > MAX_BYTES) { setError("The file is larger than 5 MB. Contact us and we will help split it."); return; }
    const text = await readText(selected);
    const [header = [], ...samples] = parseCsvPreview(text, 6);
    if (header.length < 2) { setError("No columns were found. Upload the CSV file from the Housecall Pro email."); return; }
    setFile({ name: selected.name, text, header, samples });
    setMapping(suggestCustomerMapping(header));
  }

  async function run(dryRun: boolean) {
    if (!request || busy) return;
    setBusy(true); setError("");
    // Each preview needs its own explicit review.
    if (dryRun) setReviewed(false);
    try {
      const result = await importLeadsCsv({ ...request, dryRun });
      if ("dryRun" in result) setPreview({ key: requestKey, result });
      else { setDone(result); onImported(result); }
    } catch (err) {
      setError(errorText(err, dryRun));
      // Some rows may now be saved, so the old preview no longer describes the
      // next import. Staff check history and preview again before any retry.
      if (!dryRun) { setPreview(null); setReviewed(false); }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-3 space-y-4 text-sm" data-testid="hcp-customer-import">
      <section aria-labelledby={`${prefix}-export`} className="space-y-2">
        <h3 id={`${prefix}-export`} className="font-medium">1. Export your customers from Housecall Pro</h3>
        <ol className="list-decimal space-y-1 pl-5 text-muted-foreground">
          <li>Sign in to Housecall Pro as an admin (only admins can export).</li>
          <li>Open <strong>Customers</strong> and clear any filters so every customer is included.</li>
          <li>Click <strong>Actions</strong> (some accounts show <strong>More</strong>) in the top right, then <strong>Export</strong> or <strong>Download customer list</strong>, then <strong>Send file</strong>.</li>
          <li>Housecall Pro emails the file from notifications@housecallpro.com. It can take up to an hour; check spam.</li>
          <li>If the file ends in .xlsx, open it and save or download it as <strong>CSV</strong>.</li>
        </ol>
      </section>

      <section aria-labelledby={`${prefix}-upload`} className="space-y-2">
        <h3 id={`${prefix}-upload`} className="font-medium">2. Upload the CSV</h3>
        <input
          type="file"
          accept=".csv,text/csv,.xlsx,.xls"
          aria-label="Housecall Pro customer CSV"
          onChange={(event) => void load(event.target.files?.[0])}
          disabled={busy}
        />
      </section>

      {file && (
        <section aria-labelledby={`${prefix}-map`} className="space-y-2">
          <h3 id={`${prefix}-map`} className="font-medium">3. Check each column</h3>
          <p className="text-muted-foreground">
            We suggested matches from your column names. Check every one; choose “Not imported” for anything that doesn't fit.
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            {FIELDS.map((field) => {
              const index = mapping[field.key];
              const sample = index === undefined ? "" : file.samples.map((row) => row[index] ?? "").filter(Boolean).slice(0, 2).join(", ");
              return (
                <label key={field.key} className="block">
                  <span className="font-medium">{field.label}{field.required ? " (required)" : ""}</span>
                  <select
                    className={control}
                    value={index ?? ""}
                    disabled={busy}
                    onChange={(event) => {
                      const value = event.target.value === "" ? undefined : Number(event.target.value);
                      setReviewed(false);
                      setMapping((current) => {
                        const next = { ...current };
                        for (const key of Object.keys(next) as CustomerImportField[]) if (next[key] === value) delete next[key];
                        if (value === undefined) delete next[field.key]; else next[field.key] = value;
                        return next;
                      });
                    }}
                  >
                    <option value="">Not imported</option>
                    {file.header.map((name, i) => <option key={i} value={i}>{name || `Column ${i + 1}`}</option>)}
                  </select>
                  {sample && <span className="mt-1 block truncate text-xs text-muted-foreground">e.g. {sample}</span>}
                </label>
              );
            })}
            <label className="block">
              <span className="font-medium">Date you exported the file</span>
              <input type="date" className={control} value={exportedOn} onChange={(event) => { setReviewed(false); setExportedOn(event.target.value); }} disabled={busy} />
            </label>
          </div>
          {missing && <p role="alert" className="text-destructive">Choose a first name column and an email or phone column.</p>}
          <button type="button" className={button} disabled={busy || missing} onClick={() => void run(true)}>
            {busy && !previewCurrent ? "Checking…" : "Preview import"}
          </button>
        </section>
      )}

      {preview && previewCurrent && !done && (
        <section aria-labelledby={`${prefix}-preview`} className="space-y-2" data-testid="hcp-import-preview">
          <h3 id={`${prefix}-preview`} className="font-medium">4. Review before importing (nothing saved yet)</h3>
          <ul className="grid gap-1 sm:grid-cols-3">
            <li>{preview.result.totalRows} rows in file</li>
            <li>{preview.result.imported} new</li>
            <li>{preview.result.duplicates} already in GrowthOS</li>
            <li>{preview.result.updated} updates</li>
            <li>{preview.result.conflicts} need review</li>
            <li>{preview.result.skipped} skipped</li>
          </ul>
          {preview.result.errors.length > 0 && (
            <details open={preview.result.errors.length <= 10}>
              <summary>Rows that will not be imported as-is ({preview.result.conflicts + preview.result.skipped})</summary>
              <ul className="mt-1 max-h-48 list-disc overflow-auto pl-5 text-muted-foreground">
                {preview.result.errors.map((message) => <li key={message}>{message}</li>)}
              </ul>
              {preview.result.errorsTruncated && <p className="text-muted-foreground">More rows have problems than are listed here.</p>}
            </details>
          )}
          <p className="text-muted-foreground">
            Customers are added as existing customers, not sales leads, and are not contacted automatically. Matching people are never merged by guess; rows that need review are left out.
          </p>
          <label className="flex items-start gap-2">
            <input type="checkbox" className="mt-1" checked={reviewed} onChange={(event) => setReviewed(event.target.checked)} disabled={busy} />
            <span>I reviewed this preview and want to import these customers.</span>
          </label>
          <button type="button" className={primary} disabled={busy || !reviewed || preview.result.imported + preview.result.updated + preview.result.duplicates === 0} onClick={() => void run(false)}>
            {busy ? "Importing…" : "Import customers"}
          </button>
        </section>
      )}

      {done && (
        <p role="status" data-testid="hcp-import-done">
          Imported {done.imported} new and updated {done.updated}; {done.conflicts} need review and {done.skipped} were skipped. This import is recorded in your import history.
        </p>
      )}
      {error && <p role="alert" className="text-destructive">{error}</p>}
    </div>
  );
}
