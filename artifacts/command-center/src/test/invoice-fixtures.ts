import type { InvoiceDetail } from "@/lib/invoice-ui";

export const invoiceId = "00000000-0000-4000-8000-000000000111";
export const invoiceLeadId = "00000000-0000-4000-8000-000000000222";
export const invoiceProjectId = "00000000-0000-4000-8000-000000000333";
export function sampleInvoice(
  overrides: Partial<InvoiceDetail> = {},
): InvoiceDetail {
  return {
    id: invoiceId,
    leadId: invoiceLeadId,
    projectId: null,
    estimateId: null,
    invoiceNumber: null,
    status: "draft",
    version: 1,
    title: "Synthetic service work",
    customerName: "Synthetic Customer",
    currency: "USD",
    subtotalCents: 10000,
    taxCents: 0,
    totalCents: 10000,
    dueDate: "2026-10-15",
    issuedAt: null,
    voidedAt: null,
    voidReason: null,
    createdAt: "2026-10-01T12:00:00Z",
    updatedAt: "2026-10-01T12:00:00Z",
    recordedPaidCents: 0,
    recordedBalanceCents: 10000,
    balanceDueCents: null,
    paymentState: "unpaid",
    reconciliationRequired: false,
    unallocatedRefundCents: 0,
    document: {
      title: "Synthetic service work",
      currency: "USD",
      issuerName: "Synthetic Contractor",
      issuerAddress: null,
      customerName: "Synthetic Customer",
      customerAddress: null,
      dueDate: "2026-10-15",
      notes: null,
      lineItems: [
        {
          description: "Approved service",
          quantity: "1",
          unitPriceCents: 10000,
          totalCents: 10000,
        },
      ],
      subtotalCents: 10000,
      taxCents: 0,
      totalCents: 10000,
    },
    allocations: [],
    availableValueEntries: [],
    availableValueEntriesTruncated: false,
    events: [
      {
        id: "event-1",
        action: "invoice.created",
        version: 1,
        reason: null,
        createdAt: "2026-10-01T12:00:00Z",
      },
    ],
    ...overrides,
  };
}
