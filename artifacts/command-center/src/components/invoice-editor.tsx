import { useId, useState, type FormEvent, type ReactNode } from "react";
import { Plus, Trash2 } from "lucide-react";
import {
  dollarsToCents,
  invoiceButton,
  invoiceControl,
  invoicePrimary,
  money,
  type InvoiceDraft,
} from "@/lib/invoice-ui";

type LineDraft = {
  key: string;
  description: string;
  quantity: string;
  price: string;
};
function extendedCents(line: LineDraft) {
  const price = dollarsToCents(line.price);
  if (
    price === null ||
    !/^\d{1,6}(?:\.\d{1,3})?$/.test(line.quantity) ||
    Number(line.quantity) <= 0
  )
    return null;
  const [whole, fraction = ""] = line.quantity.split(".");
  const total =
    ((BigInt(whole) * 1000n + BigInt(fraction.padEnd(3, "0"))) * BigInt(price) +
      500n) /
    1000n;
  return total <= 1_000_000_000n ? Number(total) : null;
}

export function InvoiceEditor({
  initial,
  disabled,
  busy,
  onSave,
  children,
}: {
  initial: InvoiceDraft;
  disabled: boolean;
  busy: boolean;
  onSave: (document: InvoiceDraft) => void;
  children?: ReactNode;
}) {
  const prefix = useId();
  const [fields, setFields] = useState(initial);
  const [tax, setTax] = useState((initial.taxCents / 100).toFixed(2));
  const [lines, setLines] = useState<LineDraft[]>(() =>
    initial.lineItems.map((line) => ({
      key: crypto.randomUUID(),
      description: line.description,
      quantity: line.quantity,
      price: (line.unitPriceCents / 100).toFixed(2),
    })),
  );
  const [error, setError] = useState("");
  const set = (name: keyof InvoiceDraft, value: string) =>
    setFields((current) => ({ ...current, [name]: value }));
  const updateLine = (key: string, patch: Partial<LineDraft>) =>
    setLines((current) =>
      current.map((line) => (line.key === key ? { ...line, ...patch } : line)),
    );
  const totals = lines.map(extendedCents);
  const taxCents = dollarsToCents(tax);
  const subtotal = totals.every((value) => value !== null)
    ? totals.reduce<number>((sum, value) => sum + (value ?? 0), 0)
    : null;
  const preview =
    subtotal !== null &&
    taxCents !== null &&
    subtotal + taxCents <= 1_000_000_000
      ? subtotal + taxCents
      : null;
  function save(event: FormEvent) {
    event.preventDefault();
    if (disabled) return;
    if (preview === null || lines.some((line) => !line.description.trim())) {
      setError(
        "Enter a description and valid positive quantity for each line, and dollar amounts with at most two decimals. The total cannot exceed $10,000,000.",
      );
      return;
    }
    setError("");
    onSave({
      ...fields,
      currency: "USD",
      title: fields.title.trim(),
      issuerName: fields.issuerName.trim(),
      customerName: fields.customerName.trim(),
      issuerAddress: fields.issuerAddress?.trim() || null,
      customerAddress: fields.customerAddress?.trim() || null,
      dueDate: fields.dueDate || null,
      notes: fields.notes?.trim() || null,
      taxCents: taxCents!,
      lineItems: lines.map((line) => ({
        description: line.description.trim(),
        quantity: line.quantity,
        unitPriceCents: dollarsToCents(line.price)!,
      })),
    });
  }
  function textField(
    name: "title" | "issuerName" | "customerName",
    label: string,
    maxLength: number,
  ) {
    return (
      <div>
        <label
          htmlFor={`${prefix}-${name}`}
          className="mb-1 block text-sm font-medium"
        >
          {label}
        </label>
        <input
          id={`${prefix}-${name}`}
          className={invoiceControl}
          required
          maxLength={maxLength}
          value={fields[name]}
          onChange={(event) => set(name, event.target.value)}
        />
      </div>
    );
  }
  return (
    <form aria-label="Invoice draft" onSubmit={save} className="space-y-5">
      <fieldset
        disabled={disabled}
        className="min-w-0 space-y-5 disabled:opacity-70"
      >
        {children}
        {textField("title", "Invoice title", 150)}
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-3">
            {textField("issuerName", "Your business name", 200)}
            <div>
              <label
                htmlFor={`${prefix}-issuer-address`}
                className="mb-1 block text-sm font-medium"
              >
                Business address (optional)
              </label>
              <textarea
                id={`${prefix}-issuer-address`}
                className={invoiceControl}
                rows={2}
                maxLength={500}
                value={fields.issuerAddress ?? ""}
                onChange={(event) => set("issuerAddress", event.target.value)}
              />
            </div>
          </div>
          <div className="space-y-3">
            {textField("customerName", "Bill to", 200)}
            <div>
              <label
                htmlFor={`${prefix}-customer-address`}
                className="mb-1 block text-sm font-medium"
              >
                Customer address (optional)
              </label>
              <textarea
                id={`${prefix}-customer-address`}
                className={invoiceControl}
                rows={2}
                maxLength={500}
                value={fields.customerAddress ?? ""}
                onChange={(event) => set("customerAddress", event.target.value)}
              />
            </div>
          </div>
        </div>
        <div className="max-w-xs">
          <label
            htmlFor={`${prefix}-due-date`}
            className="mb-1 block text-sm font-medium"
          >
            Due date (optional)
          </label>
          <input
            id={`${prefix}-due-date`}
            type="date"
            className={invoiceControl}
            value={fields.dueDate ?? ""}
            onChange={(event) => set("dueDate", event.target.value)}
          />
        </div>
        <section aria-label="Invoice line items" className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-semibold">Line items</h3>
            <button
              type="button"
              className={invoiceButton}
              disabled={lines.length >= 100}
              onClick={() =>
                setLines((current) => [
                  ...current,
                  {
                    key: crypto.randomUUID(),
                    description: "",
                    quantity: "1",
                    price: "",
                  },
                ])
              }
            >
              <Plus className="h-4 w-4" aria-hidden />
              Add line
            </button>
          </div>
          {!lines.length && (
            <p className="text-sm text-muted-foreground">
              A draft can start without line items. Add the work and approved
              prices before issuing.
            </p>
          )}
          {lines.map((line, index) => (
            <div
              key={line.key}
              className="grid items-end gap-3 border-b border-border pb-4 sm:grid-cols-[minmax(0,1fr)_5rem_7rem_auto]"
            >
              <div>
                <label
                  htmlFor={`${prefix}-${line.key}-description`}
                  className="mb-1 block text-sm font-medium"
                >
                  Description {index + 1}
                </label>
                <textarea
                  id={`${prefix}-${line.key}-description`}
                  rows={2}
                  required
                  maxLength={1000}
                  className={invoiceControl}
                  value={line.description}
                  onChange={(event) =>
                    updateLine(line.key, { description: event.target.value })
                  }
                />
              </div>
              <div>
                <label
                  htmlFor={`${prefix}-${line.key}-quantity`}
                  className="mb-1 block text-sm font-medium"
                >
                  Quantity {index + 1}
                </label>
                <input
                  id={`${prefix}-${line.key}-quantity`}
                  inputMode="decimal"
                  required
                  className={invoiceControl}
                  value={line.quantity}
                  onChange={(event) =>
                    updateLine(line.key, { quantity: event.target.value })
                  }
                />
              </div>
              <div>
                <label
                  htmlFor={`${prefix}-${line.key}-price`}
                  className="mb-1 block text-sm font-medium"
                >
                  Price {index + 1} (USD)
                </label>
                <input
                  id={`${prefix}-${line.key}-price`}
                  inputMode="decimal"
                  required
                  className={invoiceControl}
                  value={line.price}
                  onChange={(event) =>
                    updateLine(line.key, { price: event.target.value })
                  }
                />
              </div>
              <button
                type="button"
                aria-label={`Remove line ${index + 1}`}
                className={`${invoiceButton} self-end`}
                onClick={() =>
                  setLines((current) =>
                    current.filter((item) => item.key !== line.key),
                  )
                }
              >
                <Trash2 className="h-4 w-4" aria-hidden />
                <span className="sm:sr-only">Remove line</span>
              </button>
            </div>
          ))}
        </section>
        <div className="grid items-end gap-4 sm:grid-cols-2">
          <div>
            <label
              htmlFor={`${prefix}-tax`}
              className="mb-1 block text-sm font-medium"
            >
              Approved tax amount (USD)
            </label>
            <input
              id={`${prefix}-tax`}
              inputMode="decimal"
              required
              className={invoiceControl}
              value={tax}
              onChange={(event) => setTax(event.target.value)}
            />
            <p className="mt-1 text-xs text-muted-foreground">
              Enter the amount approved for this work. Tax rules are not
              calculated here.
            </p>
          </div>
          <p className="text-sm sm:text-right">
            Draft preview{" "}
            <strong className="ml-2 text-lg tabular-nums">
              {preview === null ? "Check amounts" : money(preview)}
            </strong>
          </p>
        </div>
        <div>
          <label
            htmlFor={`${prefix}-notes`}
            className="mb-1 block text-sm font-medium"
          >
            Customer notes (optional)
          </label>
          <textarea
            id={`${prefix}-notes`}
            rows={3}
            maxLength={2000}
            className={invoiceControl}
            value={fields.notes ?? ""}
            onChange={(event) => set("notes", event.target.value)}
          />
        </div>
      </fieldset>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" disabled={disabled} className={invoicePrimary}>
          {busy ? "Saving…" : "Save draft"}
        </button>
        <p className="text-xs text-muted-foreground">
          Saving does not issue or send the invoice.
        </p>
      </div>
    </form>
  );
}
