import { z } from "zod/v4";
const cents = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const header = z
  .string()
  .min(1)
  .refine((value) => !/[\u0000-\u001f\u007f\u2028\u2029]/.test(value));
const mailbox = header
  .refine((value) => value === value.trim())
  .pipe(z.email());
const provider = z.enum(["gmail", "microsoft"]);
export const estimateEmailDocumentSchema = z
  .object({
    estimateId: z.uuid(),
    businessName: header,
    customerLabel: z.string().min(1),
    propertyLabel: z.string().nullable(),
    title: header,
    lineItems: z.array(
      z
        .object({
          description: z.string(),
          quantity: z.number().positive(),
          unitPriceCents: cents,
          totalCents: cents,
        })
        .strict(),
    ),
    subtotalCents: cents,
    taxCents: cents,
    totalCents: cents,
    notes: z.string().nullable(),
  })
  .strict()
  .refine(
    (value) =>
      value.lineItems.reduce((sum, item) => sum + item.totalCents, 0) ===
        value.subtotalCents &&
      value.subtotalCents + value.taxCents === value.totalCents,
  );
const message = z
  .object({ recipient: mailbox, subject: header, body: z.string() })
  .strict();
export const estimateEmailPreviewSchema = z
  .object({
    estimateId: z.uuid(),
    previewId: z.uuid(),
    payloadSha256: z.string().regex(/^[a-f0-9]{64}$/),
    expiresAt: z.iso.datetime({ offset: true }),
    document: estimateEmailDocumentSchema,
    message,
    sender: z
      .object({
        provider,
        senderEmail: mailbox,
        source: z.enum(["lead_assignee", "company_default"]),
      })
      .strict(),
  })
  .strict()
  .refine((value) => value.estimateId === value.document.estimateId);
export const estimateEmailEvidenceSchema = z
  .object({
    estimateId: z.uuid(),
    integrity: z.enum(["valid", "unavailable"]),
    state: z.enum([
      "not_sent",
      "processing",
      "accepted",
      "held",
      "uncertain",
      "reconciled",
    ]),
    executionId: z.uuid().nullable(),
    canPrepare: z.boolean(),
    detail: z.string(),
    document: estimateEmailDocumentSchema.nullable(),
    message: message.nullable(),
    provider: provider.nullable(),
    providerMessageId: z.string().nullable(),
    providerRequestId: z.string().nullable(),
    acceptedAt: z.iso.datetime({ offset: true }).nullable(),
    deliveryConfirmed: z.literal(false),
  })
  .strict()
  .refine(
    (value) =>
      !value.document || value.document.estimateId === value.estimateId,
  );
export type EstimateEmailPreview = z.infer<typeof estimateEmailPreviewSchema>;
export const estimateDeliveryLabels = {
  not_sent: "Not sent",
  processing: "Send in progress",
  accepted: "Provider accepted",
  held: "Held — review required",
  uncertain: "Uncertain — check the original mailbox",
  reconciled: "Reconciliation recorded — no new send",
};

/** Format validated integer cents without floating-point currency division. */
export function formatEstimateDeliveryCents(cents: number): string {
  const exact = BigInt(cents);
  return `${exact / 100n}.${String(exact % 100n).padStart(2, "0")}`;
}
