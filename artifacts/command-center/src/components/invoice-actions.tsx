import { useEffect, useState, type FormEvent } from "react";
import { InvoicePaymentLinks } from "@/components/invoice-payment-links";
import type { useInvoiceCommand } from "@/hooks/use-invoice-command";
import { invoiceRefundSchema } from '../../../api-server/src/services/invoice-contract';
import {
  dollarsToCents,
  invoiceButton,
  invoiceControl,
  invoicePrimary,
  money,
  type InvoiceDetail,
} from "@/lib/invoice-ui";

type Action = "issue" | "void" | "payment" | "allocate" | "reverse" | "refund";
const labels: Record<Action, string> = {
  issue: "Issue invoice",
  void: "Void invoice",
  payment: "Record payment",
  allocate: "Apply existing record",
  reverse: "Reverse allocation",
  refund: "Record external refund correction",
};
const descriptions: Record<Action, string> = {
  refund: "Record a refund that already happened outside GrowthOS. Link it to its original receipt for this same work record. This appends a correction and allocation; it never sends money or changes the original receipt.",
  issue:
    "Review the saved document. Issuing assigns an invoice number and retains this version. It does not send an email or collect payment.",
  void: "Retain this document as void with a reason. Resolve any net allocations first. This does not return money to the customer.",
  payment:
    "Record an already received payment with its original source reference. This creates a recorded receipt and applies it to this invoice; it does not charge a customer.",
  allocate:
    "Apply a payment or refund already in the value ledger. This changes its invoice allocation without creating another cash entry.",
  reverse:
    "Remove an allocation from this invoice with a reason. The original receipt or refund remains in the value ledger. No money is refunded.",
};
function localTime(value: Date) {
  return new Date(value.getTime() - value.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 16);
}
function pendingAction(path?: string): Action | null {
  if (!path) return null;
  if (path.endsWith("/issue")) return "issue";
  if (path.endsWith("/void")) return "void";
  if (path.endsWith("/payments")) return "payment";
  if (path.endsWith("/refunds")) return "refund";
  if (path.endsWith("/reverse")) return "reverse";
  if (path.endsWith("/allocations")) return "allocate";
  return null;
}

export function InvoiceActions({
  invoice,
  command,
}: {
  invoice: InvoiceDetail;
  command: ReturnType<typeof useInvoiceCommand>;
}) {
  const saved = command.pending?.body;
  const [action, setAction] = useState<Action | null>(() =>
    pendingAction(command.pending?.path),
  );
  const [amount, setAmount] = useState(
    typeof saved?.amountCents === "number"
      ? (saved.amountCents / 100).toFixed(2)
      : "",
  );
  const [reference, setReference] = useState(
    typeof saved?.sourceReference === "string" ? saved.sourceReference : "",
  );
  const [occurredAt, setOccurredAt] = useState(
    localTime(
      typeof saved?.occurredAt === "string"
        ? new Date(saved.occurredAt)
        : new Date(),
    ),
  );
  const [entryId, setEntryId] = useState(
    typeof saved?.valueEntryId === "string" ? saved.valueEntryId : "",
  );
  const [allocationId, setAllocationId] = useState(
    command.pending?.path.match(/\/allocations\/([^/]+)\/reverse$/)?.[1] ?? "",
  );
  const [originalPayment, setOriginalPayment] = useState(typeof saved?.originalPaymentValueEntryId === 'string' ? saved.originalPaymentValueEntryId : '');
  const originalPayments = invoice.allocations.filter((entry, index, all) => entry.kind === 'payment' && !entry.reversedAt && all.findIndex(other => other.kind === 'payment' && !other.reversedAt && other.valueEntryId === entry.valueEntryId) === index);
  const [reason, setReason] = useState(
    typeof saved?.reason === "string" ? saved.reason : "",
  );
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    setConfirmed(false);
  }, [invoice.version]);
  useEffect(() => {
    if (command.completed > 0) {
      setAction(null);
      setConfirmed(false);
      setError("");
      setAmount("");
      setReference("");
      setEntryId("");
      setAllocationId("");
      setReason("");
      setOriginalPayment('');
    }
  }, [command.completed]);
  function choose(next: Action) {
    setAction(next);
    setConfirmed(false);
    setError("");
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!action || !confirmed || command.locked) return;
    const common = { expectedVersion: invoice.version, confirmed: true };
    let path = `/invoices/${invoice.id}/${action}`;
    let body: Record<string, unknown> = common;
    if (action === 'refund') {
      const amountCents = dollarsToCents(amount), timestamp = new Date(occurredAt);
      if (!invoice.customerWorkId || !originalPayments.some(entry => entry.valueEntryId === originalPayment) || !Number.isFinite(timestamp.getTime())) { setError('Choose the original receipt on this work and the actual external refund time.'); return; }
      const parsed = invoiceRefundSchema.safeParse({ ...common, requestId: crypto.randomUUID(), originalPaymentValueEntryId: originalPayment, amountCents, sourceReference: reference, occurredAt: timestamp.toISOString(), reason });
      if (!parsed.success) { setError('Enter a positive amount, original refund reference, actual past refund time and a reviewable correction reason of at least ten characters.'); return; }
      const { requestId: _requestId, ...input } = parsed.data;
      body = input; path = `/invoices/${invoice.id}/refunds`;
    }
    if (action === "payment" || action === "allocate") {
      const amountCents = dollarsToCents(amount);
      if (amountCents === null || amountCents <= 0) {
        setError("Enter a positive dollar amount with at most two decimals.");
        return;
      }
      if (action === "payment") {
        const timestamp = new Date(occurredAt);
        if (
          !Number.isFinite(timestamp.getTime()) ||
          timestamp.getTime() > Date.now()
        ) {
          setError("Enter the actual receipt time, no later than now.");
          return;
        }
        if (reference.trim().length < 5) {
          setError(
            "Enter an original source reference of at least five characters.",
          );
          return;
        }
        path = `/invoices/${invoice.id}/payments`;
        body = {
          ...common,
          amountCents,
          sourceReference: reference.trim(),
          occurredAt: timestamp.toISOString(),
        };
      } else {
        if (!entryId) {
          setError("Choose an existing payment or refund.");
          return;
        }
        path = `/invoices/${invoice.id}/allocations`;
        body = { ...common, amountCents, valueEntryId: entryId };
      }
    }
    if (action === "void" || action === "reverse") {
      if (reason.trim().length < 10) {
        setError("Give a reviewable reason of at least ten characters.");
        return;
      }
      if (action === "reverse" && !allocationId) {
        setError("Choose the allocation to reverse.");
        return;
      }
      if (action === "reverse")
        path = `/invoices/${invoice.id}/allocations/${allocationId}/reverse`;
      body = { ...common, reason: reason.trim() };
    }
    setError("");
    void command.submit(path, "POST", body, labels[action]);
  }

  if (invoice.status === "void" && !command.pending)
    return (
      <p className="text-sm text-muted-foreground">
        This invoice is void. Its document and history are retained.
      </p>
    );
  return (
    <section aria-label="Invoice actions" className="space-y-4">
      <h2 className="text-lg font-semibold">Next action</h2>
      <div className="flex flex-wrap gap-2">
        {invoice.status === "draft" && (
          <button
            className={invoicePrimary}
            disabled={
              command.locked ||
              invoice.totalCents <= 0 ||
              !invoice.document.lineItems.length
            }
            onClick={() => choose("issue")}
          >
            Review & issue
          </button>
        )}
        {invoice.status === "issued" && (
          <>
            {invoice.customerWorkId && <button className={invoiceButton} disabled={command.locked || !originalPayments.length} onClick={() => choose('refund')}>Record external refund correction</button>}
            <button
              className={invoiceButton}
              disabled={command.locked}
              onClick={() => choose("payment")}
            >
              Record payment
            </button>
            <button
              className={invoiceButton}
              disabled={command.locked || !invoice.availableValueEntries.length}
              onClick={() => choose("allocate")}
            >
              Apply existing record
            </button>
            <button
              className={invoiceButton}
              disabled={
                command.locked ||
                !invoice.allocations.some((item) => !item.reversedAt)
              }
              onClick={() => choose("reverse")}
            >
              Reverse allocation
            </button>
          </>
        )}
        <button
          className={invoiceButton}
          disabled={
            command.locked ||
            invoice.recordedPaidCents !== 0 ||
            invoice.status === "void"
          }
          onClick={() => choose("void")}
        >
          Void invoice
        </button>
      </div>
      {invoice.availableValueEntriesTruncated && (
        <p className="text-sm text-muted-foreground">
          Only the latest 50 eligible value records are available here. Review
          older records with the office before creating another payment entry.
        </p>
      )}
      {action && (
        <form
          aria-label={labels[action]}
          onSubmit={submit}
          className="space-y-4 rounded-xl border border-border bg-card p-4 md:p-5"
        >
          <div>
            <h3 className="font-semibold">{labels[action]}</h3>
            <p className="mt-2 max-w-prose text-sm leading-relaxed text-muted-foreground">
              {descriptions[action]}
            </p>
            <p className="mt-2 text-sm">
              Reviewing version {invoice.version} ·{" "}
              {invoice.invoiceNumber ?? "Draft"} · {money(invoice.totalCents)}
            </p>
          </div>
          <fieldset
            disabled={command.locked}
            className="min-w-0 space-y-4 disabled:opacity-70"
          >
            {action === 'refund' && <div><label htmlFor="invoice-original-payment" className="mb-1 block text-sm font-medium">Original receipt for this external refund</label><select id="invoice-original-payment" required className={invoiceControl} value={originalPayment} onChange={event => { setOriginalPayment(event.target.value); setConfirmed(false); }}><option value="">Choose the original payment</option>{originalPayments.map(entry => <option key={entry.valueEntryId} value={entry.valueEntryId}>{entry.sourceReference} · {money(entry.amountCents)} allocated</option>)}</select></div>}
            {action === "allocate" && (
              <div>
                <label
                  htmlFor="invoice-existing-record"
                  className="mb-1 block text-sm font-medium"
                >
                  Existing record
                </label>
                <select
                  id="invoice-existing-record"
                  required
                  className={invoiceControl}
                  value={entryId}
                  onChange={(event) => {
                    setConfirmed(false);
                    setEntryId(event.target.value);
                    const entry = invoice.availableValueEntries.find(
                      (item) => item.id === event.target.value,
                    );
                    if (entry)
                      setAmount((entry.availableCents / 100).toFixed(2));
                  }}
                >
                  <option value="">Choose a payment or refund</option>
                  {invoice.availableValueEntries.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.kind === "refund" ? "Refund" : "Payment"} ·{" "}
                      {entry.sourceReference} · {money(entry.availableCents)}{" "}
                      available
                    </option>
                  ))}
                </select>
              </div>
            )}
            {(action === "payment" || action === "allocate" || action === "refund") && (
              <div className="max-w-sm">
                <label
                  htmlFor="invoice-record-amount"
                  className="mb-1 block text-sm font-medium"
                >
                  Amount (USD)
                </label>
                <input
                  id="invoice-record-amount"
                  required
                  inputMode="decimal"
                  className={invoiceControl}
                  value={amount}
                  onChange={(event) => { setAmount(event.target.value); setConfirmed(false); }}
                />
              </div>
            )}
            {(action === "payment" || action === "refund") && (
              <>
                <div>
                  <label
                    htmlFor="invoice-receipt-reference"
                    className="mb-1 block text-sm font-medium"
                  >
                    Original source reference
                  </label>
                  <input
                    id="invoice-receipt-reference"
                    required
                    minLength={5}
                    maxLength={160}
                    className={invoiceControl}
                    value={reference}
                    onChange={(event) => { setReference(event.target.value); setConfirmed(false); }}
                  />
                  <p className="mt-1 text-xs text-muted-foreground">
                    Use the receipt, check or processor transaction reference.
                    Do not enter account or card details.
                  </p>
                </div>
                <div>
                  <label
                    htmlFor="invoice-received-time"
                    className="mb-1 block text-sm font-medium"
                  >
                    {action === 'refund' ? 'Refund occurred at' : 'Received at'} (
                    {Intl.DateTimeFormat().resolvedOptions().timeZone})
                  </label>
                  <input
                    id="invoice-received-time"
                    type="datetime-local"
                    required
                    max={localTime(new Date())}
                    className={invoiceControl}
                    value={occurredAt}
                    onChange={(event) => { setOccurredAt(event.target.value); setConfirmed(false); }}
                  />
                </div>
              </>
            )}
            {action === "reverse" && (
              <div>
                <label
                  htmlFor="invoice-reverse-allocation"
                  className="mb-1 block text-sm font-medium"
                >
                  Allocation to reverse
                </label>
                <select
                  id="invoice-reverse-allocation"
                  required
                  className={invoiceControl}
                  value={allocationId}
                  onChange={(event) => { setAllocationId(event.target.value); setConfirmed(false); }}
                >
                  <option value="">Choose an allocation</option>
                  {invoice.allocations
                    .filter((entry) => !entry.reversedAt)
                    .map((entry) => (
                      <option key={entry.id} value={entry.id}>
                        {entry.kind} · {entry.sourceReference} ·{" "}
                        {money(entry.amountCents)}
                      </option>
                    ))}
                </select>
              </div>
            )}
            {(action === "void" || action === "reverse" || action === "refund") && (
              <div>
                <label
                  htmlFor="invoice-action-reason"
                  className="mb-1 block text-sm font-medium"
                >
                  Reason for this change
                </label>
                <textarea
                  id="invoice-action-reason"
                  required
                  minLength={10}
                  maxLength={500}
                  rows={3}
                  className={invoiceControl}
                  value={reason}
                  onChange={(event) => { setReason(event.target.value); setConfirmed(false); }}
                />
              </div>
            )}
            <label className="flex min-h-11 items-start gap-3 rounded-lg bg-muted/40 p-3 text-sm leading-relaxed">
              <input
                type="checkbox"
                className="mt-1 h-4 w-4 shrink-0 accent-current"
                checked={confirmed}
                onChange={(event) => setConfirmed(event.target.checked)}
              />
              I reviewed this saved invoice and the details of this action.
            </label>
          </fieldset>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <button
              type="submit"
              className={invoicePrimary}
              disabled={!confirmed || command.locked}
            >
              {command.busy ? "Confirming…" : labels[action]}
            </button>
            <button
              type="button"
              className={invoiceButton}
              disabled={command.busy || !!command.pending}
              onClick={() => {
                setAction(null);
                setConfirmed(false);
              }}
            >
              Cancel action
            </button>
          </div>
        </form>
      )}
      {invoice.status === "issued" && <InvoicePaymentLinks invoice={invoice} canManage />}
    </section>
  );
}
