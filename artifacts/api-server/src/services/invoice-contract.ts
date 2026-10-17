import { z } from "zod/v4";
import type {
  HistoricalInvoiceSource,
  InvoiceDocument,
  InvoiceState,
} from "@workspace/db";
import { customerWorkSourceSchema, existingCustomerSourceSchema } from "./returning-customer-contract";

export const MAX_INVOICE_CENTS = 1_000_000_000;
export class InvoiceError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
const nullableText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .optional()
    .transform((v) => v || null);
const quantity = z
  .string()
  .regex(/^\d{1,6}(?:\.\d{1,3})?$/)
  .refine((v) => Number(v) > 0, "Quantity must be positive.")
  .transform((v) => {
    const [whole, fraction = ""] = v.split(".");
    const tail = fraction.replace(/0+$/, "");
    return `${BigInt(whole!)}${tail ? `.${tail}` : ""}`;
  });
const cents = z.number().int().min(0).max(MAX_INVOICE_CENTS);
export const invoiceDocumentInputSchema = z
  .object({
    title: z.string().trim().min(1).max(150),
    currency: z.literal("USD"),
    issuerName: z.string().trim().min(1).max(200),
    issuerAddress: nullableText(500),
    customerName: z.string().trim().min(1).max(200),
    customerAddress: nullableText(500),
    dueDate: z.iso
      .date()
      .nullable()
      .optional()
      .transform((v) => v ?? null),
    notes: nullableText(2000),
    lineItems: z
      .array(
        z
          .object({
            description: z.string().trim().min(1).max(1000),
            quantity,
            unitPriceCents: cents,
          })
          .strict(),
      )
      .max(100),
    taxCents: cents,
  })
  .strict();

/** Positive fixed-point arithmetic, rounding each extended line half-up to cents. */
export function invoiceDocument(
  input: z.output<typeof invoiceDocumentInputSchema>,
): InvoiceDocument {
  const lineItems = input.lineItems.map((line) => {
    const [whole, fraction = ""] = line.quantity.split(".");
    const thousandths =
      BigInt(whole!) * 1000n + BigInt(fraction.padEnd(3, "0"));
    const total = (thousandths * BigInt(line.unitPriceCents) + 500n) / 1000n;
    if (total > BigInt(MAX_INVOICE_CENTS))
      throw new InvoiceError(
        400,
        "invoice_invalid_request",
        "A line total exceeds the supported invoice amount.",
      );
    return { ...line, totalCents: Number(total) };
  });
  const subtotalCents = lineItems.reduce(
    (sum, line) => sum + line.totalCents,
    0,
  );
  const totalCents = subtotalCents + input.taxCents;
  if (totalCents > MAX_INVOICE_CENTS)
    throw new InvoiceError(
      400,
      "invoice_invalid_request",
      "The invoice total must not exceed 1,000,000,000 cents.",
    );
  return { ...input, lineItems, subtotalCents, totalCents };
}
const requestId = z.uuid();
const expectedVersion = z.number().int().min(1).max(2_147_483_646);
const confirmation = { requestId, expectedVersion, confirmed: z.literal(true) };
const reason = z.string().trim().min(10).max(500);
export const MAX_INVOICE_EQUIPMENT = 10;
/**
 * Staff choose recorded property assets; the server copies their current facts
 * into the draft. Optional and outside the document input so imports and older
 * request hashes are unchanged.
 */
export const invoiceEquipmentSelectionSchema = z
  .object({
    assetIds: z
      .array(z.uuid())
      .max(MAX_INVOICE_EQUIPMENT)
      .refine((ids) => new Set(ids).size === ids.length, "Choose each equipment record once."),
    warrantyTerms: nullableText(2000),
  })
  .strict();
export const legacyCreateInvoiceSchema = z
  .object({
    requestId,
    leadId: z.uuid(),
    projectId: z.uuid().nullable().optional(),
    estimateId: z.uuid().nullable().optional(),
    document: invoiceDocumentInputSchema,
    equipment: invoiceEquipmentSelectionSchema.optional(),
  })
  .strict();
export const createReturningInvoiceSchema = z.object({
  requestId, source: z.discriminatedUnion("kind", [customerWorkSourceSchema, existingCustomerSourceSchema]),
  projectId: z.uuid().nullable().optional(), estimateId: z.uuid().nullable().optional(), document: invoiceDocumentInputSchema,
  equipment: invoiceEquipmentSelectionSchema.optional(),
}).strict().refine(v => v.source.kind !== "existing_customer" || (!v.projectId && !v.estimateId), "A standalone invoice cannot borrow another work record.");
/** Preserve the literal old parse/normalization branch and its saved request hash. */
export const createInvoiceSchema = z.union([legacyCreateInvoiceSchema, createReturningInvoiceSchema]);
export const updateInvoiceSchema = z
  .object({ requestId, expectedVersion, document: invoiceDocumentInputSchema, equipment: invoiceEquipmentSelectionSchema.optional() })
  .strict();
export const issueInvoiceSchema = z.object(confirmation).strict();
export const voidInvoiceSchema = z.object({ ...confirmation, reason }).strict();
export const invoicePaymentSchema = z
  .object({
    ...confirmation,
    amountCents: cents.min(1),
    sourceReference: z.string().trim().min(5).max(160),
    occurredAt: z.iso.datetime({ offset: true }),
  })
  .strict()
  .refine(
    (v) => Date.parse(v.occurredAt) <= Date.now(),
    "A recorded receipt cannot be in the future.",
  );
export const invoiceAllocationSchema = z
  .object({
    ...confirmation,
    valueEntryId: z.uuid(),
    amountCents: cents.min(1),
  })
  .strict();
export const invoiceRefundSchema = z.object({ ...confirmation, originalPaymentValueEntryId: z.uuid(), amountCents: cents.min(1),
  sourceReference: z.string().trim().min(5).max(160), occurredAt: z.iso.datetime({ offset: true }), reason,
}).strict().refine(v => Date.parse(v.occurredAt) <= Date.now(), "A recorded refund cannot be in the future.");
export const reverseInvoiceAllocationSchema = z
  .object({ ...confirmation, reason })
  .strict();
export const invoiceListSchema = z
  .object({
    status: z.enum(["draft", "issued", "void"]).optional(),
    leadId: z.uuid().optional(),
    projectId: z.uuid().optional(),
    customerWorkId: z.uuid().optional(),
    contactId: z.uuid().optional(),
    page: z
      .string()
      .regex(/^\d{1,5}$/)
      .transform(Number)
      .refine((n) => n <= 10000)
      .optional()
      .default(0),
  })
  .strict();

export interface InvoiceSummary {
  id: string;
  organizationId: string;
  leadId: string | null;
  customerWorkId: string | null;
  contactId: string;
  propertyId: string | null;
  sourceKind: "lead" | "customer_work";
  projectId: string | null;
  estimateId: string | null;
  invoiceNumber: string | null;
  status: InvoiceState;
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
  balanceBasis: "full_history" | "opening_receivable";
  openingReceivableCents: number | null;
  openingAsOf: string | null;
  historicalSource: HistoricalInvoiceSource | null;
}
export interface InvoiceAllocation {
  id: string;
  valueEntryId: string;
  kind: "payment" | "refund";
  sourceReference: string;
  amountCents: number;
  occurredAt: string;
  allocatedAt: string;
  reversedAt: string | null;
  reversalReason: string | null;
  refundOfValueEntryId: string | null;
}
export interface InvoiceAvailableValueEntry {
  id: string;
  kind: "payment" | "refund";
  sourceReference: string;
  amountCents: number;
  availableCents: number;
  occurredAt: string;
  refundOfValueEntryId: string | null;
}
export interface InvoiceDetail extends InvoiceSummary {
  document: InvoiceDocument;
  allocations: InvoiceAllocation[];
  availableValueEntries: InvoiceAvailableValueEntry[];
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
  pageSize: 25;
}
export interface InvoiceMutation {
  invoice: InvoiceDetail;
  duplicate: boolean;
}
