import { describe, expect, it } from "vitest";
import type { Estimate } from "@workspace/db";
import {
  assertEstimateInitialDraft,
  assertEstimateEmailMessageFits,
  estimateDeliveryFingerprint,
  estimateDeliverySendSchema,
  estimateDeliveryPreviewRequestSchema,
  estimateEmailSnapshotSchema,
  estimateEmailPreviewSchema,
  estimateEmailEvidenceSchema,
  renderEstimateEmail,
  type EstimateEmailDocument,
} from "./estimate-delivery-contract";
const id = "12345678-1234-4234-8234-123456789012";
const doc: EstimateEmailDocument = {
  estimateId: id,
  businessName: "Fictional Service",
  customerLabel: "Sample Customer",
  propertyLabel: "Sample property",
  title: "Saved quote",
  lineItems: [
    {
      description: "First item",
      quantity: 1.5,
      unitPriceCents: 101,
      totalCents: 152,
    },
    {
      description: "Second item",
      quantity: 2,
      unitPriceCents: 250,
      totalCents: 500,
    },
  ],
  subtotalCents: 652,
  taxCents: 48,
  totalCents: 700,
  notes: "Full recorded note\n" + "x".repeat(5000),
};
const draft = {
  ...doc,
  id,
  organizationId: id,
  leadId: id,
  customerWorkId: null,
  workVersion: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  status: "draft",
  sentAt: null,
  acceptedAt: null,
} as Estimate;
describe("initial estimate contract", () => {
  it("formats_large_saved_cents_exactly", () => {
    const large = {
      ...doc,
      lineItems: [
        {
          description: "Large JSON price",
          quantity: 1e-9,
          unitPriceCents: 9007199254740990,
          totalCents: 9007199,
        },
      ],
      subtotalCents: 9007199,
      taxCents: 0,
      totalCents: 9007199,
    };
    expect(renderEstimateEmail(large, "customer@example.test").body).toContain(
      "Unit price: USD 90071992547409.90",
    );
  });
  it("preserves_both_saved_fractional_rounding_rules", () => {
    for (const totalCents of [100, 101]) {
      const saved = {
        ...doc,
        lineItems: [
          {
            description: "Fractional item",
            quantity: 1.005,
            unitPriceCents: 100,
            totalCents,
          },
        ],
        subtotalCents: totalCents,
        taxCents: 0,
        totalCents,
      };
      expect(
        renderEstimateEmail(saved, "customer@example.test").body,
      ).toContain(`Line total: USD 1.${totalCents === 100 ? "00" : "01"}`);
    }
    const invalid = {
      ...doc,
      lineItems: [
        {
          description: "Fractional item",
          quantity: 1.005,
          unitPriceCents: 100,
          totalCents: 102,
        },
      ],
      subtotalCents: 102,
      taxCents: 0,
      totalCents: 102,
    };
    expect(() =>
      renderEstimateEmail(invalid, "customer@example.test"),
    ).toThrow();
  });
  it("enforces_saved_rounding_for_exact_estimate_lineage", () => {
    const saved = {
      ...draft,
      ...doc,
      id,
      leadId: id,
      customerWorkId: null,
      workVersion: null,
      lineItems: [
        {
          description: "Fractional item",
          quantity: 1.005,
          unitPriceCents: 100,
          totalCents: 100,
        },
      ],
      subtotalCents: 100,
      taxCents: 0,
      totalCents: 100,
    } as Estimate;
    expect(() => assertEstimateInitialDraft(saved)).not.toThrow();
    expect(() =>
      assertEstimateInitialDraft({
        ...saved,
        lineItems: [{ ...saved.lineItems[0], totalCents: 101 }],
        subtotalCents: 101,
        totalCents: 101,
      }),
    ).toThrow();
    const returning = {
      ...saved,
      leadId: null,
      customerWorkId: id,
      workVersion: 1,
      lineItems: [{ ...saved.lineItems[0], totalCents: 101 }],
      subtotalCents: 101,
      totalCents: 101,
    };
    expect(() => assertEstimateInitialDraft(returning)).not.toThrow();
    expect(() =>
      assertEstimateInitialDraft({
        ...returning,
        lineItems: saved.lineItems,
        subtotalCents: 100,
        totalCents: 100,
      }),
    ).toThrow();
  });
  it("complete_saved_quote", () => {
    const m = renderEstimateEmail(doc, "customer@example.test");
    expect(m.recipient).toBe("customer@example.test");
    for (const text of [
      "First item",
      "Second item",
      "1.5",
      "USD 1.52",
      "USD 6.52",
      "USD 0.48",
      "USD 7.00",
      "Sample property",
    ])
      expect(m.body).toContain(text);
    expect(m.body).not.toMatch(/deposit|financing|signature|guarantee/i);
  });
  it("full_customer_facing_notes", () =>
    expect(renderEstimateEmail(doc, "customer@example.test").body).toContain(
      `Customer-facing notes\n${doc.notes}`,
    ));
  it("invalid_totals", () => {
    for (const change of [
      { totalCents: 701 },
      { taxCents: NaN },
      { subtotalCents: Infinity },
      { taxCents: -1 },
      { totalCents: 7.5 },
      { lineItems: [{ ...doc.lineItems[0], totalCents: 151 }] },
    ])
      expect(() =>
        renderEstimateEmail({ ...doc, ...change }, "customer@example.test"),
      ).toThrow();
  });
  it("header_injection", () => {
    for (const recipient of [
      "customer@example.test\r\nBcc: bad@example.test",
      " customer@example.test",
      "bad",
    ])
      expect(() => renderEstimateEmail(doc, recipient)).toThrow();
    for (const title of ["quote\nBcc: bad", "quote\u0000"])
      expect(() =>
        renderEstimateEmail({ ...doc, title }, "customer@example.test"),
      ).toThrow();
  });
  it("historical_send_is_held", () => {
    expect(() => assertEstimateInitialDraft(draft)).not.toThrow();
    for (const patch of [
      { status: "sent" },
      { sentAt: new Date() },
      { acceptedAt: new Date() },
      { status: "accepted" },
      { status: "declined" },
    ])
      expect(() =>
        assertEstimateInitialDraft({ ...draft, ...patch } as Estimate),
      ).toThrow();
  });
  it("strict approval and preview inputs", () => {
    const send = {
      previewId: id,
      payloadSha256: "a".repeat(64),
      confirmed: true,
    };
    expect(estimateDeliverySendSchema.safeParse(send).success).toBe(true);
    for (const patch of [
      { recipient: "replacement@example.test" },
      { confirmed: false },
      { sender: "x" },
    ])
      expect(
        estimateDeliverySendSchema.safeParse({ ...send, ...patch }).success,
      ).toBe(false);
    expect(
      estimateDeliveryPreviewRequestSchema.safeParse({
        expectedUpdatedAt: new Date().toISOString(),
        expectedWorkVersion: null,
      }).success,
    ).toBe(true);
    expect(
      estimateDeliveryPreviewRequestSchema.safeParse({
        expectedUpdatedAt: new Date().toISOString(),
        expectedWorkVersion: 0,
      }).success,
    ).toBe(false);
  });
  it("ambiguous_lineage", () => {
    const snapshot = {
      organizationId: id,
      estimateId: id,
      actorUserId: id,
      leadId: id,
      customerWorkId: id,
      contactId: id,
      propertyId: null,
      estimateUpdatedAt: new Date().toISOString(),
      workVersion: 1,
      sourceSha256: "a".repeat(64),
      senderIdentitySha256: "b".repeat(64),
      document: doc,
      message: renderEstimateEmail(doc, "customer@example.test"),
      sender: {
        userId: id,
        source: "company_default",
        provider: "gmail",
        senderEmail: "sender@example.test",
      },
    };
    expect(estimateEmailSnapshotSchema.safeParse(snapshot).success).toBe(false);
    expect(
      estimateEmailSnapshotSchema.safeParse({
        ...snapshot,
        customerWorkId: null,
        workVersion: null,
      }).success,
    ).toBe(true);
    expect(
      estimateEmailSnapshotSchema.safeParse({
        ...snapshot,
        leadId: null,
        customerWorkId: null,
      }).success,
    ).toBe(false);
  });
  it("closed business projections", () => {
    const preview = {
      estimateId: id,
      previewId: id,
      payloadSha256: "a".repeat(64),
      expiresAt: new Date().toISOString(),
      document: doc,
      message: renderEstimateEmail(doc, "customer@example.test"),
      sender: {
        provider: "gmail",
        source: "company_default",
        senderEmail: "sender@example.test",
      },
    };
    expect(estimateEmailPreviewSchema.safeParse(preview).success).toBe(true);
    expect(
      estimateEmailPreviewSchema.safeParse({
        ...preview,
        sender: { ...preview.sender, userId: id },
      }).success,
    ).toBe(false);
    const evidence = {
      estimateId: id,
      integrity: "valid",
      state: "not_sent",
      executionId: null,
      canPrepare: true,
      detail: "Initial draft",
      document: null,
      message: null,
      provider: null,
      providerMessageId: null,
      providerRequestId: null,
      acceptedAt: null,
      deliveryConfirmed: false,
    };
    expect(estimateEmailEvidenceSchema.safeParse(evidence).success).toBe(true);
    expect(
      estimateEmailEvidenceSchema.safeParse({ ...evidence, previewId: id })
        .success,
    ).toBe(false);
    expect(
      estimateEmailEvidenceSchema.safeParse({
        ...evidence,
        payloadSha256: "a".repeat(64),
      }).success,
    ).toBe(false);
    expect(
      estimateEmailEvidenceSchema.safeParse({
        ...evidence,
        deliveryConfirmed: true,
      }).success,
    ).toBe(false);
  });
  it("Date aware canonical hashing", () => {
    const date = new Date("2026-10-13T00:00:00Z");
    expect(estimateDeliveryFingerprint({ b: 2, a: date })).toBe(
      estimateDeliveryFingerprint({ a: date.toISOString(), b: 2 }),
    );
    expect(estimateDeliveryFingerprint(date)).not.toBe(
      estimateDeliveryFingerprint(new Date("2026-10-14T00:00:00Z")),
    );
    expect(estimateDeliveryFingerprint([1, 2])).not.toBe(
      estimateDeliveryFingerprint([2, 1]),
    );
  });
  it("Microsoft exact limits without truncation", () => {
    const m = {
      recipient: "customer@example.test",
      subject: "s".repeat(1000),
      body: "b".repeat(1000000),
    };
    expect(() => assertEstimateEmailMessageFits("microsoft", m)).not.toThrow();
    expect(() =>
      assertEstimateEmailMessageFits("microsoft", {
        ...m,
        subject: m.subject + "s",
      }),
    ).toThrow();
    expect(() =>
      assertEstimateEmailMessageFits("microsoft", { ...m, body: m.body + "b" }),
    ).toThrow();
    expect(m.body.length).toBe(1000000);
  });
});
