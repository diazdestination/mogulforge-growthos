import { useState } from "react";
import { Link } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useGetMe } from "@workspace/api-client-react";
import { contractorRequest, ContractorApiError } from "@/lib/contractor-api";
import {
  invoiceButton,
  invoiceControl,
  invoicePrimary,
  money,
  type InvoiceDocument,
} from "@/lib/invoice-ui";

type Source = {
  format: "growthos-financial-migration";
  version: 1;
  sourceSystem: string;
  sourceAccount: string;
  cutoffAt: string;
  invoices: {
    externalId: string;
    invoiceNumber: string;
    leadId: string;
    issuedAt: string;
    basis: "full_history" | "opening_receivable";
    balanceAtCutoffCents: number;
    document: InvoiceDocument;
  }[];
  receipts: {
    externalId: string;
    leadId: string;
    kind: "payment" | "refund";
    amountCents: number;
    occurredAt: string;
    evidence: string;
    allocations: { externalInvoiceId: string; amountCents: number }[];
  }[];
  controlTotals: {
    invoiceCount: number;
    documentTotalCents: number;
    openingReceivableCents: number;
    balanceDueCents: number;
    paymentCents: number;
    refundCents: number;
  };
};
type Review = {
  id: string;
  digest: string;
  rawSha256: string;
  state: "review" | "committed";
  source: Source;
  mappings: { leadId: string; contactId: string; customerName: string }[];
  duplicateInvoices: number;
  duplicateReceipts: number;
  expiresAt: string;
  createdAt: string;
  committedAt: string | null;
  result: {
    importedInvoices: number;
    importedReceipts: number;
    duplicateInvoices: number;
    duplicateReceipts: number;
    invoiceIds: string[];
  } | null;
};
type Issue = { path: string; message: string };
type Preview =
  { valid: false; issues: Issue[] } | { valid: true; review: Review };
function message(error: unknown) {
  if (!(error instanceof ContractorApiError))
    return "The request could not be confirmed. Check the saved review before retrying.";
  const messages: Record<string, string> = {
    financial_manager_required:
      "An active company owner or administrator must review financial records.",
    financial_mapping_unavailable:
      "An opportunity/customer mapping is missing or belongs to another company. Correct the normalized source.",
    financial_mapping_changed:
      "A customer or opportunity changed after review. Prepare a new review; no local records were replaced.",
    financial_review_changed:
      "The review does not match your approval. Load the exact saved review.",
    financial_source_conflict:
      "This source identity or invoice number conflicts with retained history. Reconcile it; changing file names cannot replace it.",
    financial_review_expired:
      "This review expired. Upload and review the source again.",
    financial_company_held:
      "This company is paused or offboarding. Financial migration is held.",
    financial_reconciliation_failed:
      "Balances did not reconcile. The entire commit was rolled back; ask your operator to review existing receipts/refunds.",
  };
  return (
    messages[error.code] ??
    "The request could not be confirmed. Check this same saved review before retrying."
  );
}
export default function FinancialMigrations() {
  const { data: me, isLoading, isError } = useGetMe();
  if (isLoading)
    return (
      <main className="p-6" role="status">
        Checking financial review access…
      </main>
    );
  if (
    isError ||
    !me?.organization ||
    !me.isActive ||
    !["owner", "admin"].includes(me.role ?? "")
  )
    return (
      <main className="p-6">
        <h1 className="text-xl font-semibold">
          Financial migration is restricted
        </h1>
        <p className="mt-2">
          Sign in as an active company owner or administrator. No financial
          records were loaded.
        </p>
        <Link href="/" className={invoiceButton}>
          Back to Today
        </Link>
      </main>
    );
  return (
    <MigrationDesk
      key={`${me.organization.id}:${me.id}`}
      organizationId={me.organization.id}
      actorId={me.id}
    />
  );
}
function MigrationDesk({
  organizationId,
  actorId,
}: {
  organizationId: string;
  actorId: string;
}) {
  const client = useQueryClient();
  const [sourceJson, setSourceJson] = useState(""),
    [review, setReview] = useState<Review | null>(null),
    [issues, setIssues] = useState<Issue[]>([]);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [approved, setApproved] = useState(false),
    [frozen, setFrozen] = useState(false),
    [uncertain, setUncertain] = useState(false);
  const key = ["financial-migrations", organizationId, actorId];
  const list = useQuery({
    queryKey: key,
    queryFn: () =>
      contractorRequest<{
        items: Pick<Review, "id" | "state" | "createdAt">[];
        limit: number;
      }>("/financial-migrations"),
    retry: false,
  });
  const resetApproval = () => {
    setApproved(false);
    setFrozen(false);
  };
  async function prepare() {
    if (busy || uncertain || !sourceJson.trim()) return;
    setBusy(true);
    setError("");
    setIssues([]);
    setReview(null);
    resetApproval();
    try {
      const result = await contractorRequest<Preview>(
        "/financial-migrations/preview",
        { method: "POST", body: { sourceJson } },
      );
      if (result.valid) {
        setReview(result.review);
        void client.invalidateQueries({ queryKey: key });
      } else setIssues(result.issues);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  async function load(id: string) {
    if (busy) return;
    setBusy(true);
    setError("");
    resetApproval();
    try {
      setReview(await contractorRequest<Review>(`/financial-migrations/${id}`));
      setUncertain(false);
      setIssues([]);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  async function commit() {
    if (
      !review ||
      busy ||
      uncertain ||
      !approved ||
      !frozen ||
      review.state === "committed"
    )
      return;
    setBusy(true);
    setError("");
    try {
      setReview(
        await contractorRequest<Review>(
          `/financial-migrations/${review.id}/commit`,
          {
            method: "POST",
            body: {
              expectedDigest: review.digest,
              confirmed: true,
              sourceFrozen: true,
            },
          },
        ),
      );
      resetApproval();
      void client.invalidateQueries({ queryKey: key });
      void client.invalidateQueries({ queryKey: ["invoices"] });
    } catch (e) {
      setError(message(e));
      setUncertain(true);
      resetApproval();
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="mx-auto max-w-5xl space-y-6 p-4 sm:p-6">
      <header className="space-y-2">
        <Link href="/invoices" className={invoiceButton}>
          Back to invoices
        </Link>
        <h1 className="text-2xl font-semibold">Bring over invoice history</h1>
        <p className="text-muted-foreground">
          Review original invoices, evidenced receipts or an opening receivable.
          Nothing sends an email, charges a customer, creates a lead or grants
          consent.
        </p>
      </header>
      <aside className="rounded-xl border border-amber-500/40 p-4 text-sm">
        <strong>
          Normalized records only—not a Housecall Pro CSV adapter.
        </strong>
        <p className="mt-2">
          Your operator must map an approved export to the version 1 contract
          with existing customer/opportunity IDs. Up to 50 invoices, 200 fully
          allocated receipts and 512,000 bytes. Credits, write-offs, negative
          lines, unsupported rounding, unapplied cash and cross-opportunity
          receipts need separate reconciliation.
        </p>
        <p className="mt-2">
          An opening receivable is a balance as of a cutoff, not a payment.
          Historical payments stay unknown. Import is not bank verification or
          new recovered revenue. Keep the old system until each company accepts
          the complete cutover.
        </p>
      </aside>
      {error && (
        <p role="alert" className="rounded-lg border border-destructive p-3">
          {error}
        </p>
      )}
      {uncertain && (
        <p role="alert" className="rounded-lg border p-3">
          Commit acknowledgement is unavailable. Do not re-import under another
          identity. Check this saved review; the server deduplicates the same
          original records.
        </p>
      )}
      <section
        className="space-y-3 rounded-xl border p-4"
        aria-label="Normalized financial source"
      >
        <h2 className="text-lg font-semibold">1. Load normalized source</h2>
        <label className="block text-sm">
          Normalized JSON file
          <input
            type="file"
            accept="application/json,.json"
            className={`${invoiceControl} mt-1`}
            disabled={busy || uncertain}
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              resetApproval();
              setReview(null);
              setIssues([]);
              if (file.size > 512000) {
                setError(
                  "The normalized file exceeds 512,000 bytes. Ask for a reconciled bounded batch.",
                );
                return;
              }
              setBusy(true);
              try {
                setSourceJson(await file.text());
                setReview(null);
                resetApproval();
                setError("");
              } catch {
                setError(
                  "The file could not be read. No preview or import was performed.",
                );
              } finally {
                setBusy(false);
              }
            }}
          />
        </label>
        <label className="block text-sm">
          Normalized source JSON
          <textarea
            value={sourceJson}
            spellCheck={false}
            className={`${invoiceControl} mt-1 min-h-40 font-mono`}
            disabled={busy || uncertain}
            onChange={(e) => {
              setSourceJson(e.target.value);
              setReview(null);
              setIssues([]);
              resetApproval();
            }}
          />
        </label>
        <button
          className={invoicePrimary}
          disabled={busy || uncertain || !sourceJson.trim()}
          onClick={() => void prepare()}
        >
          {busy ? "Working…" : "Preview and reconcile"}
        </button>
        {issues.length > 0 && (
          <div role="alert">
            <h3 className="font-semibold">Not ready to import</h3>
            <ul className="mt-2 space-y-2">
              {issues.map((issue, i) => (
                <li key={i} className="break-words">
                  <strong>{issue.path}:</strong> {issue.message}
                </li>
              ))}
            </ul>
            <p className="mt-2">
              No invoices or receipts were imported. Correct the source;
              unsupported data is not silently skipped.
            </p>
          </div>
        )}
      </section>
      {review && (
        <section
          className="space-y-4 rounded-xl border p-4"
          aria-label="Exact financial review"
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-lg font-semibold">
              2. Review the exact records
            </h2>
            <button
              className={invoiceButton}
              disabled={busy}
              onClick={() => void load(review.id)}
            >
              Check saved review
            </button>
          </div>
          <p className="break-words">
            {review.source.sourceSystem} / {review.source.sourceAccount} ·
            Cutoff {review.source.cutoffAt}
          </p>
          <dl className="grid gap-3 sm:grid-cols-2">
            <div>
              <dt>Original document totals</dt>
              <dd>{money(review.source.controlTotals.documentTotalCents)}</dd>
            </div>
            <div>
              <dt>Outstanding at cutoff</dt>
              <dd>{money(review.source.controlTotals.balanceDueCents)}</dd>
            </div>
            <div>
              <dt>Non-cash opening receivables</dt>
              <dd>
                {money(review.source.controlTotals.openingReceivableCents)}
              </dd>
            </div>
            <div>
              <dt>Evidenced historical receipts / refunds</dt>
              <dd>
                {money(review.source.controlTotals.paymentCents)} /{" "}
                {money(review.source.controlTotals.refundCents)}
              </dd>
            </div>
          </dl>
          <p>
            {review.source.invoices.length} invoices;{" "}
            {review.source.receipts.length} receipts. Already imported:{" "}
            {review.duplicateInvoices} invoices and {review.duplicateReceipts}{" "}
            receipts. These remain unchanged.
          </p>
          <div className="space-y-3">
            {review.source.invoices.map((row) => (
              <article
                key={row.externalId}
                className="space-y-2 rounded-lg border p-3"
              >
                <h3 className="break-words font-semibold">
                  {row.invoiceNumber} · {row.document.customerName}
                </h3>
                <p className="text-sm">
                  Mapped customer:{" "}
                  {review.mappings.find((m) => m.leadId === row.leadId)
                    ?.customerName ?? "Unavailable"}
                </p>
                <p className="text-sm">
                  {row.basis === "opening_receivable"
                    ? "Opening receivable — prior cash unknown"
                    : "Full evidenced history"}{" "}
                  · Balance {money(row.balanceAtCutoffCents)}
                </p>
                <details>
                  <summary className="min-h-11 cursor-pointer py-2">
                    Original document and exact record
                  </summary>
                  <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-3 text-xs">
                    {JSON.stringify(row, null, 2)}
                  </pre>
                </details>
              </article>
            ))}
          </div>
          <details>
            <summary className="min-h-11 cursor-pointer py-2">
              Exact receipt evidence and allocations
            </summary>
            <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-3 text-xs">
              {JSON.stringify(review.source.receipts, null, 2)}
            </pre>
          </details>
          <p className="break-all text-xs text-muted-foreground">
            Review digest: {review.digest}
            <br />
            Raw source SHA-256: {review.rawSha256}
            <br />
            Review expires: {review.expiresAt}
          </p>
          {review.state === "committed" ? (
            <div role="status" className="space-y-2 rounded-lg border p-3">
              <h3 className="font-semibold">Financial migration committed</h3>
              <p>
                {review.result?.importedInvoices} invoices and{" "}
                {review.result?.importedReceipts} evidenced receipts imported.
                Duplicates retained without another cash entry. No messages sent
                or money moved.
              </p>
              <div className="flex flex-wrap gap-2">
                {review.result?.invoiceIds.map((id, i) => (
                  <Link
                    key={id}
                    href={`/invoices/${id}`}
                    className={invoiceButton}
                  >
                    Open invoice {i + 1}
                  </Link>
                ))}
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <label className="flex min-h-11 items-start gap-3">
                <input
                  type="checkbox"
                  checked={approved}
                  disabled={busy || uncertain}
                  onChange={(e) => setApproved(e.target.checked)}
                  className="mt-1 size-5 shrink-0"
                />
                <span>
                  I reviewed the original documents, mappings, exact balances
                  and receipt evidence. Opening balances do not establish
                  historical payments.
                </span>
              </label>
              <label className="flex min-h-11 items-start gap-3">
                <input
                  type="checkbox"
                  checked={frozen}
                  disabled={busy || uncertain}
                  onChange={(e) => setFrozen(e.target.checked)}
                  className="mt-1 size-5 shrink-0"
                />
                <span>
                  The source financial records are frozen at this cutoff, one
                  system is the agreed writer, and the company approved this
                  exact migration. Later deltas will be reconciled separately.
                </span>
              </label>
              <button
                className={invoicePrimary}
                disabled={
                  busy ||
                  uncertain ||
                  !approved ||
                  !frozen ||
                  Date.parse(review.expiresAt) <= Date.now()
                }
                onClick={() => void commit()}
              >
                Approve and import exact review
              </button>
              <p className="text-sm text-muted-foreground">
                All rows commit together or roll back. Once committed, history
                is retained; corrections require explicit reconciliation. There
                is no delete-import or automatic refund.
              </p>
            </div>
          )}
        </section>
      )}
      <section className="space-y-3" aria-label="Saved financial reviews">
        <h2 className="text-lg font-semibold">Your recent reviews</h2>
        {list.isLoading ? (
          <p role="status">Loading reviews…</p>
        ) : list.isError ? (
          <p role="alert">
            Review history could not load. Refresh before assuming an earlier
            import failed.
          </p>
        ) : list.data?.items.length ? (
          <ul className="space-y-2">
            {list.data.items.map((item) => (
              <li key={item.id}>
                <button
                  className={`${invoiceButton} w-full justify-start break-all text-left`}
                  disabled={busy}
                  onClick={() => void load(item.id)}
                >
                  {item.state === "committed" ? "Committed" : "Review"} ·{" "}
                  {item.createdAt} · {item.id.slice(0, 8)}
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p>No financial reviews yet.</p>
        )}
      </section>
    </main>
  );
}
