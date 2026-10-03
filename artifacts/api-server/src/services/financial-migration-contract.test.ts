import { describe, expect, it } from "vitest";
import {
  financialHash,
  normalizeFinancialSource,
} from "./financial-migration-contract";

export function sourceFixture(
  leadId = "11111111-1111-4111-8111-111111111111",
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
describe("normalized historical financial contract", () => {
  it("retains original document, dates and exact cents; opening basis does not invent cash", () => {
    for (const basis of ["full_history", "opening_receivable"] as const) {
      const s = sourceFixture(undefined, basis),
        normalized = normalizeFinancialSource(JSON.stringify(s));
      expect(normalized.ok).toBe(true);
      if (!normalized.ok) return;
      expect(normalized.source.invoices[0]!.document).toEqual(
        s.invoices[0]!.document,
      );
      expect(normalized.source.receipts).toHaveLength(
        basis === "full_history" ? 1 : 0,
      );
    }
  });
  it("rejects tax/rounding mismatches, inferred receipts, unknown fields and unsupported credit rows", () => {
    const cases = [
      (s: ReturnType<typeof sourceFixture>) => {
        s.invoices[0]!.document.totalCents = 9999;
      },
      (s: ReturnType<typeof sourceFixture>) => {
        s.receipts = [];
      },
      (s: ReturnType<typeof sourceFixture>) => {
        Object.assign(s.invoices[0]!, { creditCents: 3000 });
      },
      (s: ReturnType<typeof sourceFixture>) => {
        s.invoices[0]!.document.lineItems[0]!.unitPriceCents = -1;
      },
      (s: ReturnType<typeof sourceFixture>) => {
        s.controlTotals.balanceDueCents = 6000;
      },
      (s: ReturnType<typeof sourceFixture>) => {
        s.receipts[0]!.amountCents = 3001;
      },
      (s: ReturnType<typeof sourceFixture>) => {
        s.receipts[0]!.allocations[0]!.externalInvoiceId = "unknown";
      },
      (s: ReturnType<typeof sourceFixture>) => {
        s.invoices[0]!.basis = "opening_receivable";
      },
      (s: ReturnType<typeof sourceFixture>) => {
        s.invoices[0]!.issuedAt = "01/08/2026";
      },
      (s: ReturnType<typeof sourceFixture>) => {
        s.invoices[0]!.invoiceNumber = "INV-2147483646";
      },
    ];
    for (const change of cases) {
      const s = sourceFixture();
      change(s);
      expect(normalizeFinancialSource(JSON.stringify(s)).ok).toBe(false);
    }
  });
  it("uses canonical object order but does not weaken financial identity", () => {
    expect(financialHash({ a: 1, b: 2 })).toBe(financialHash({ b: 2, a: 1 }));
    expect(financialHash({ amountCents: 1 })).not.toBe(
      financialHash({ amountCents: 2 }),
    );
    expect(financialHash({ updatedAt: new Date(1) })).not.toBe(
      financialHash({ updatedAt: new Date(2) }),
    );
  });
  it("reports malformed vendor files and bounded payloads without guessing", () => {
    expect(normalizeFinancialSource("invoice,amount\nI1,30")).toMatchObject({
      ok: false,
    });
    expect(normalizeFinancialSource(" ".repeat(512001))).toMatchObject({
      ok: false,
    });
  });
});
