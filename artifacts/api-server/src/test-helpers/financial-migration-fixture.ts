export function financialSourceFixture(
  leadId: string,
  basis: "full_history" | "opening_receivable" = "full_history",
) {
  return {
    format: "growthos-financial-migration" as const,
    version: 1 as const,
    sourceSystem: "synthetic",
    sourceAccount: "sample-account",
    cutoffAt: "2026-09-01T00:00:00.000Z",
    invoices: [
      {
        externalId: "source-invoice-1",
        invoiceNumber: "OLD-0001",
        leadId,
        issuedAt: "2026-08-01T12:00:00.000Z",
        basis,
        balanceAtCutoffCents: 7000,
        document: {
          title: "Original synthetic invoice",
          currency: "USD" as const,
          issuerName: "Synthetic contractor",
          issuerAddress: null,
          customerName: "Synthetic Customer",
          customerAddress: null,
          dueDate: "2026-08-20",
          notes: "Original scope",
          lineItems: [
            {
              description: "Service",
              quantity: "1",
              unitPriceCents: 10000,
              totalCents: 10000,
            },
          ],
          subtotalCents: 10000,
          taxCents: 0,
          totalCents: 10000,
        },
      },
    ],
    receipts:
      basis === "full_history"
        ? [
            {
              externalId: "source-payment-1",
              leadId,
              kind: "payment" as "payment" | "refund",
              amountCents: 3000,
              occurredAt: "2026-08-02T12:00:00.000Z",
              evidence: "Source receipt P-1 reconciled by staff",
              allocations: [
                { externalInvoiceId: "source-invoice-1", amountCents: 3000 },
              ],
            },
          ]
        : [],
    controlTotals: {
      invoiceCount: 1,
      documentTotalCents: 10000,
      openingReceivableCents: basis === "opening_receivable" ? 7000 : 0,
      balanceDueCents: 7000,
      paymentCents: basis === "full_history" ? 3000 : 0,
      refundCents: 0,
    },
  };
}
