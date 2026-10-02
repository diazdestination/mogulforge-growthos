import { createHash } from "node:crypto";
import { z } from "zod/v4";
import type { InvoiceDocument } from "@workspace/db";

export const invoiceDeliveryPreviewSchema = z
  .object({
    expectedVersion: z.number().int().positive(),
  })
  .strict();
export const invoiceDeliverySendSchema = z
  .object({
    previewId: z.uuid(),
    payloadSha256: z.string().regex(/^[a-f0-9]{64}$/),
    confirmed: z.literal(true),
  })
  .strict();

export const invoiceDeliveryKey = (invoiceId: string) =>
  `invoice-delivery:${invoiceId}`;
export function deliveryFingerprint(value: unknown): string {
  const canonical = (item: unknown): string => {
    if (Array.isArray(item)) return `[${item.map(canonical).join(",")}]`;
    if (item && typeof item === "object")
      return `{${Object.entries(item)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
        .join(",")}}`;
    return JSON.stringify(item) ?? "null";
  };
  return createHash("sha256").update(canonical(value)).digest("hex");
}

/** Text is the existing adapters' canonical format. Every issued field is
 * included, without links, attachments, live balances or invented payment terms. */
export function renderInvoiceEmail(input: {
  invoiceNumber: string;
  issuedAt: string;
  document: InvoiceDocument;
}) {
  const doc = input.document;
  const dollars = (cents: number) => `USD ${(cents / 100).toFixed(2)}`;
  return {
    subject: `Invoice ${input.invoiceNumber} from ${doc.issuerName}`,
    body: [
      `Invoice ${input.invoiceNumber}`,
      doc.title,
      `Issued: ${input.issuedAt.slice(0, 10)}`,
      `Due date: ${doc.dueDate ?? "Not specified"}`,
      "",
      `From: ${doc.issuerName}`,
      ...(doc.issuerAddress ? [doc.issuerAddress] : []),
      "",
      `Bill to: ${doc.customerName}`,
      ...(doc.customerAddress ? [doc.customerAddress] : []),
      "",
      "Invoice items:",
      ...doc.lineItems.flatMap((line, i) => [
        `${i + 1}. ${line.description}`,
        `   Quantity: ${line.quantity} | Unit price: ${dollars(line.unitPriceCents)} | Line total: ${dollars(line.totalCents)}`,
      ]),
      "",
      `Subtotal: ${dollars(doc.subtotalCents)}`,
      `Tax: ${dollars(doc.taxCents)}`,
      `Invoice total: ${dollars(doc.totalCents)}`,
      ...(doc.notes ? ["", "Invoice notes:", doc.notes] : []),
      "",
      "This is the document as issued, not a live account balance or payment receipt.",
      "For questions or payment arrangements, reply to this email. This message does not collect an online payment.",
    ].join("\n"),
  };
}

export interface InvoiceDeliveryEvidence {
  invoiceId: string;
  state:
    | "not_sent"
    | "processing"
    | "accepted"
    | "held"
    | "uncertain"
    | "reconciled";
  executionId: string | null;
  detail: string;
  provider: "gmail" | "microsoft" | null;
  providerMessageId: string | null;
  providerRequestId: string | null;
  acceptedAt: string | null;
  deliveryConfirmed: false;
  deliveryDetail: string;
  canPrepare: boolean;
}
