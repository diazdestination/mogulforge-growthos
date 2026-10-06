export interface InvoiceDraft {
  title: string;
  currency: "USD";
  issuerName: string;
  issuerAddress: string | null;
  customerName: string;
  customerAddress: string | null;
  dueDate: string | null;
  notes: string | null;
  lineItems: {
    description: string;
    quantity: string;
    unitPriceCents: number;
  }[];
  taxCents: number;
}
export interface InvoiceDocument extends Omit<InvoiceDraft, "lineItems"> {
  lineItems: (InvoiceDraft["lineItems"][number] & { totalCents: number })[];
  subtotalCents: number;
  totalCents: number;
}
export interface InvoiceSummary {
  id: string;
  leadId: string | null;
  organizationId?: string;
  customerWorkId?: string | null;
  contactId?: string;
  propertyId?: string | null;
  sourceKind?: "lead" | "customer_work";
  projectId: string | null;
  estimateId: string | null;
  invoiceNumber: string | null;
  status: "draft" | "issued" | "void";
  version: number;
  title: string;
  customerName: string;
  currency: "USD";
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  dueDate: string | null;
  issuedAt: string | null;
  voidedAt: string | null;
  voidReason: string | null;
  createdAt: string;
  updatedAt: string;
  recordedPaidCents: number;
  recordedBalanceCents: number;
  balanceDueCents: number | null;
  paymentState: "unpaid" | "partial" | "paid" | "reconciliation_required";
  reconciliationRequired: boolean;
  unallocatedRefundCents: number;
  balanceBasis?: "full_history" | "opening_receivable";
  openingReceivableCents?: number | null;
  openingAsOf?: string | null;
  historicalSource?: {
    sourceSystem: string;
    sourceAccount: string;
    externalId: string;
    cutoffAt: string;
    recordSha256: string;
  } | null;
}
export interface InvoiceAllocation {
  id: string;
  valueEntryId: string;
  refundOfValueEntryId?: string | null;
  kind: "payment" | "refund";
  sourceReference: string;
  amountCents: number;
  occurredAt: string;
  allocatedAt: string;
  reversedAt: string | null;
  reversalReason: string | null;
}
export interface InvoiceDetail extends InvoiceSummary {
  document: InvoiceDocument;
  allocations: InvoiceAllocation[];
  availableValueEntries: {
    id: string;
    refundOfValueEntryId?: string | null;
    kind: "payment" | "refund";
    sourceReference: string;
    amountCents: number;
    availableCents: number;
    occurredAt: string;
  }[];
  availableValueEntriesTruncated: boolean;
  events: {
    id: string;
    action: string;
    version: number;
    reason: string | null;
    createdAt: string;
  }[];
}
export interface InvoiceList {
  items: InvoiceSummary[];
  total: number;
  page: number;
  pageSize: number;
}
export interface InvoiceMutation {
  invoice: InvoiceDetail;
  duplicate: boolean;
}

export const invoiceControl =
  "min-h-11 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";
export const invoiceButton =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-input bg-background px-4 py-2 text-sm font-medium text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";
export const invoicePrimary = `${invoiceButton} border-transparent bg-primary text-primary-foreground hover:bg-primary/90 dark:text-background`;
export const money = (cents: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
    cents / 100,
  );
/** Exact decimal-to-cents conversion; never coerce an invalid amount to zero. */
export function dollarsToCents(value: string): number | null {
  if (!/^\d{1,8}(?:\.\d{1,2})?$/.test(value.trim())) return null;
  const [whole, fraction = ""] = value.trim().split(".");
  const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
  return cents <= 1_000_000_000n ? Number(cents) : null;
}
export function draftDocument(document: InvoiceDocument): InvoiceDraft {
  const {
    subtotalCents: _subtotal,
    totalCents: _total,
    lineItems,
    ...rest
  } = document;
  return {
    ...rest,
    lineItems: lineItems.map(({ totalCents: _lineTotal, ...line }) => line),
  };
}
export function paymentLabel(invoice: InvoiceSummary): string {
  if (
    invoice.reconciliationRequired ||
    invoice.paymentState === "reconciliation_required"
  )
    return "Needs reconciliation";
  if (invoice.status === "draft") return "Draft";
  if (invoice.status === "void") return "Void";
  if (invoice.balanceBasis === "opening_receivable")
    return invoice.recordedBalanceCents === 0
      ? "Opening balance cleared"
      : "Opening receivable";
  return (
    {
      unpaid: "Unpaid",
      partial: "Partially recorded",
      paid: "Recorded paid",
    } as const
  )[invoice.paymentState];
}

/** Print only the saved document, in normal multi-page flow, without app navigation. */
export function printInvoiceDocument(element: HTMLElement) {
  const frame = document.createElement("iframe");
  frame.title = "Customer invoice print document";
  frame.setAttribute("aria-hidden", "true");
  frame.style.cssText =
    "position:fixed;left:-10000px;top:0;width:800px;height:1px;border:0";
  document.body.append(frame);
  try {
    const printer = frame.contentWindow;
    const doc = frame.contentDocument;
    if (!printer || !doc) throw new Error("Print preview unavailable");
    // outerHTML is the already escaped, rendered React document; no raw field interpolation.
    doc.open();
    doc.write(
      "<!doctype html><html><head><title>Customer invoice</title><style>@page{margin:16mm}body{font:14px/1.5 Arial,sans-serif;color:#000;background:#fff}article{width:100%}article>div{margin-bottom:24px}article>div:first-child{display:flex;justify-content:space-between;gap:24px}h3{font-size:20px;margin:0 0 8px}p{margin:4px 0;overflow-wrap:anywhere;white-space:pre-wrap}table{width:100%;border-collapse:collapse;font-size:12px}th,td{padding:8px;text-align:left;border-bottom:1px solid #bbb;vertical-align:top;overflow-wrap:anywhere}th:not(:first-child),td:not(:first-child){text-align:right}thead{display:table-header-group}tr{break-inside:avoid}caption{font-size:12px;text-align:left}dl{max-width:280px;margin-left:auto}dl>div{display:flex;justify-content:space-between;gap:24px}dt,dd{margin:0}.sr-only{display:none}</style></head><body>" +
        element.outerHTML +
        "</body></html>",
    );
    doc.close();
    printer.addEventListener("afterprint", () => frame.remove(), {
      once: true,
    });
    printer.focus();
    printer.print();
  } catch (error) {
    frame.remove();
    throw error;
  }
}
