import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  invoiceDocument,
  invoiceDocumentInputSchema,
} from "./invoice-contract";
import {
  invoiceDeliveryPreviewSchema,
  invoiceDeliverySendSchema,
  renderInvoiceEmail,
} from "./invoice-delivery-contract";

describe("explicit invoice recovery review contracts", () => {
  it("preserves an initial-only older preview request without inferring recovery", () => {
    expect(invoiceDeliveryPreviewSchema.parse({ expectedVersion: 2 })).toEqual({
      expectedVersion: 2,
      intent: "initial",
      expectedLatestExecutionId: null,
      reason: null,
    });
  });
  it.each(["retry_not_dispatched", "additional_copy"])(
    "requires an exact predecessor and meaningful fresh reason for %s",
    (intent) => {
      expect(
        invoiceDeliveryPreviewSchema.safeParse({ expectedVersion: 2, intent })
          .success,
      ).toBe(false);
      expect(
        invoiceDeliveryPreviewSchema.safeParse({
          expectedVersion: 2,
          intent,
          expectedLatestExecutionId: randomUUID(),
          reason: "short",
        }).success,
      ).toBe(false);
      expect(
        invoiceDeliveryPreviewSchema.safeParse({
          expectedVersion: 2,
          intent,
          expectedLatestExecutionId: randomUUID(),
          reason: "Customer requested this exact document.",
        }).success,
      ).toBe(true);
    },
  );
  it.each([
    { expectedVersion: 2, reason: "Cannot silently infer a resend." },
    { expectedVersion: 2, expectedLatestExecutionId: randomUUID() },
    { expectedVersion: 2, duplicateCopyAcknowledged: true },
    { expectedVersion: 2, intent: "automatic_retry" },
    { expectedVersion: 2, to: "different@example.invalid" },
    { expectedVersion: 2, eligible: true },
  ])("refuses unreviewed or inferred dispatch authority %#", (request) => {
    expect(invoiceDeliveryPreviewSchema.safeParse(request).success).toBe(false);
  });
  it("send can acknowledge a displayed copy but cannot change its frozen intent or recipient", () => {
    const input = {
      previewId: randomUUID(),
      payloadSha256: "a".repeat(64),
      confirmed: true,
    };
    expect(invoiceDeliverySendSchema.safeParse(input).success).toBe(true);
    expect(
      invoiceDeliverySendSchema.safeParse({
        ...input,
        duplicateCopyAcknowledged: true,
      }).success,
    ).toBe(true);
    expect(
      invoiceDeliverySendSchema.safeParse({
        ...input,
        intent: "additional_copy",
      }).success,
    ).toBe(false);
    expect(
      invoiceDeliverySendSchema.safeParse({
        ...input,
        duplicateCopyAcknowledged: false,
      }).success,
    ).toBe(false);
  });
  it("renders a COPY of the same immutable invoice with no second charge or live balance claim", () => {
    const document = invoiceDocument(
      invoiceDocumentInputSchema.parse({
        title: "Synthetic repair",
        currency: "USD",
        issuerName: "Synthetic shop",
        customerName: "Synthetic customer",
        lineItems: [
          {
            description: "Recorded scope",
            quantity: "1",
            unitPriceCents: 5000,
          },
        ],
        taxCents: 0,
      }),
    );
    const rendered = renderInvoiceEmail({
      invoiceNumber: "INV-000042",
      issuedAt: "2026-10-02T12:00:00Z",
      document,
      additionalCopy: true,
    });
    expect(rendered.subject).toBe(
      "COPY of invoice INV-000042 from Synthetic shop",
    );
    expect(rendered.body).toContain("COPY of invoice INV-000042");
    expect(rendered.body).toContain("not a new bill or charge");
    expect(rendered.body).toContain("Invoice total: USD 50.00");
    expect(rendered.body).toContain(
      "not a live account balance or payment receipt",
    );
    expect(rendered.body).not.toMatch(/https?:|pay now|paid in full/i);
  });
});
