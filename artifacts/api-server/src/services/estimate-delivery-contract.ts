import { createHash } from "node:crypto";
import { z } from "zod/v4";
import type { Estimate, EstimateLineItem, UserRole } from "@workspace/db";
import type { CustomerEmailSender } from "./customer-email";
import type { UserEmailProvider } from "./user-email";
export type EstimateDeliveryActor = {
  userId: string;
  effectiveRole?: UserRole;
};
export class EstimateDeliveryError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "EstimateDeliveryError";
  }
}
const cents = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const timestamp = z.iso.datetime({ offset: true });
const header = z
  .string()
  .min(1)
  .refine((v) => !/[\u0000-\u001f\u007f\u2028\u2029]/.test(v));
const mailbox = header.refine((v) => v === v.trim()).pipe(z.email());
const provider = z.enum(["gmail", "microsoft"]);
const source = z.enum(["lead_assignee", "company_default"]);
/** Matches returning-customer.ts's thousandths arithmetic, without changing saved cents. */
function returningLineTotal(
  line: Pick<EstimateLineItem, "quantity" | "unitPriceCents">,
): number | null {
  if (!/^\d+(?:\.\d{1,3})?$/.test(String(line.quantity))) return null;
  const [whole, fraction = ""] = String(line.quantity).split(".");
  const total =
    ((BigInt(whole) * 1000n + BigInt(fraction.padEnd(3, "0"))) *
      BigInt(line.unitPriceCents) +
      500n) /
    1000n;
  return total <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(total) : null;
}
const lineItemSchema = z
  .object({
    description: z.string(),
    quantity: z.number().positive(),
    unitPriceCents: cents,
    totalCents: cents,
  })
  .strict()
  .refine(
    (v) =>
      Math.round(v.quantity * v.unitPriceCents) === v.totalCents ||
      returningLineTotal(v) === v.totalCents,
    "Saved line total is invalid.",
  );
export const estimateEmailDocumentSchema = z
  .object({
    estimateId: z.uuid(),
    businessName: header,
    customerLabel: z.string().min(1),
    propertyLabel: z.string().nullable(),
    title: header,
    lineItems: z.array(lineItemSchema),
    subtotalCents: cents,
    taxCents: cents,
    totalCents: cents,
    notes: z.string().nullable(),
  })
  .strict()
  .refine(
    (v) =>
      v.lineItems.reduce((sum, item) => sum + item.totalCents, 0) ===
        v.subtotalCents && v.subtotalCents + v.taxCents === v.totalCents,
    "Saved quote totals are invalid.",
  );
export type EstimateEmailDocument = z.infer<typeof estimateEmailDocumentSchema>;
export const estimateEmailMessageSchema = z
  .object({ recipient: mailbox, subject: header, body: z.string() })
  .strict();
export type EstimateEmailMessage = z.infer<typeof estimateEmailMessageSchema>;
export const estimateDeliveryPreviewRequestSchema = z
  .object({
    expectedUpdatedAt: timestamp,
    expectedWorkVersion: z.number().int().positive().nullable(),
  })
  .strict();
export const estimateDeliverySendSchema = z
  .object({
    previewId: z.uuid(),
    payloadSha256: sha,
    confirmed: z.literal(true),
  })
  .strict();
const senderSchema = z
  .object({ userId: z.uuid(), source, provider, senderEmail: mailbox })
  .strict();
export const estimateEmailSnapshotSchema = z
  .object({
    organizationId: z.uuid(),
    estimateId: z.uuid(),
    actorUserId: z.uuid(),
    leadId: z.uuid().nullable(),
    customerWorkId: z.uuid().nullable(),
    contactId: z.uuid(),
    propertyId: z.uuid().nullable(),
    estimateUpdatedAt: timestamp,
    workVersion: z.number().int().positive().nullable(),
    sourceSha256: sha,
    senderIdentitySha256: sha,
    document: estimateEmailDocumentSchema,
    message: estimateEmailMessageSchema,
    sender: senderSchema,
  })
  .strict()
  .refine(
    (v) =>
      (v.leadId !== null &&
        v.customerWorkId === null &&
        v.workVersion === null) ||
      (v.leadId === null &&
        v.customerWorkId !== null &&
        v.workVersion !== null),
    "Estimate lineage is ambiguous.",
  )
  .refine(
    (v) => v.estimateId === v.document.estimateId,
    "Estimate identity differs.",
  );
export type EstimateEmailSnapshot = Omit<
  z.infer<typeof estimateEmailSnapshotSchema>,
  "sender"
> & { sender: CustomerEmailSender };
export const ESTIMATE_EMAIL_REVIEW_ACTION = "estimate_delivery.previewed";
export const ESTIMATE_EMAIL_PREVIEW_MS = 600_000;
export const estimateEmailReviewMetadataSchema = z
  .object({
    version: z.literal(1),
    payloadSha256: sha,
    expiresAt: timestamp,
    snapshot: estimateEmailSnapshotSchema,
  })
  .strict();
export const estimateEmailPreviewSchema = z
  .object({
    estimateId: z.uuid(),
    previewId: z.uuid(),
    payloadSha256: sha,
    expiresAt: timestamp,
    document: estimateEmailDocumentSchema,
    message: estimateEmailMessageSchema,
    sender: z.object({ provider, senderEmail: mailbox, source }).strict(),
  })
  .strict();
export type EstimateEmailPreview = z.infer<typeof estimateEmailPreviewSchema>;
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
    message: estimateEmailMessageSchema.nullable(),
    provider: provider.nullable(),
    providerMessageId: z.string().nullable(),
    providerRequestId: z.string().nullable(),
    acceptedAt: timestamp.nullable(),
    deliveryConfirmed: z.literal(false),
  })
  .strict();
export type EstimateEmailEvidence = z.infer<typeof estimateEmailEvidenceSchema>;
export function assertEstimateInitialDraft(estimate: Estimate): void {
  if (
    estimate.status !== "draft" ||
    estimate.sentAt !== null ||
    estimate.acceptedAt !== null
  )
    throw new EstimateDeliveryError(
      409,
      "estimate_not_initial_draft",
      "Only an initial unsent draft estimate can be prepared.",
    );
  assertEstimateSavedAmounts(estimate);
}
/** Full source records must satisfy their own writer's arithmetic, not the union
 * used by the source-neutral frozen document. Admission invokes this via the draft guard. */
export function assertEstimateSavedAmounts(estimate: Estimate): void {
  const amounts = z
    .object({
      lineItems: z.array(lineItemSchema),
      subtotalCents: cents,
      taxCents: cents,
      totalCents: cents,
    })
    .safeParse(estimate);
  const leadSource =
    estimate.leadId !== null &&
    estimate.customerWorkId === null &&
    estimate.workVersion === null;
  const returningSource =
    estimate.leadId === null &&
    estimate.customerWorkId !== null &&
    Number.isInteger(estimate.workVersion) &&
    (estimate.workVersion ?? 0) > 0;
  if (!amounts.success || (!leadSource && !returningSource))
    throw new EstimateDeliveryError(
      422,
      "invalid_estimate_amounts",
      "Saved estimate amounts or source are invalid.",
    );
  const validLines = amounts.data.lineItems.every((line) =>
    leadSource
      ? Math.round(line.quantity * line.unitPriceCents) === line.totalCents
      : line.quantity <= 999999 &&
        line.unitPriceCents <= 1_000_000_000 &&
        line.totalCents <= 1_000_000_000 &&
        returningLineTotal(line) === line.totalCents,
  );
  if (
    !validLines ||
    amounts.data.lineItems.reduce((sum, line) => sum + line.totalCents, 0) !==
      estimate.subtotalCents ||
    estimate.subtotalCents + estimate.taxCents !== estimate.totalCents ||
    (returningSource && estimate.totalCents > 1_000_000_000)
  )
    throw new EstimateDeliveryError(
      422,
      "invalid_estimate_amounts",
      "Saved estimate amounts do not match the source's rounding rule.",
    );
}
export function renderEstimateEmail(
  document: EstimateEmailDocument,
  recipient: string,
): EstimateEmailMessage {
  const parsed = estimateEmailDocumentSchema.safeParse(document);
  if (!parsed.success || !mailbox.safeParse(recipient).success)
    throw new EstimateDeliveryError(
      422,
      "invalid_estimate_email",
      "Saved quote or recipient is invalid.",
    );
  const money = (value: number) => {
    const saved = BigInt(value);
    return `USD ${saved / 100n}.${String(saved % 100n).padStart(2, "0")}`;
  };
  return {
    recipient,
    subject: `Estimate: ${document.title} from ${document.businessName}`,
    body: [
      `Estimate: ${document.title}`,
      `From: ${document.businessName}`,
      `Customer: ${document.customerLabel}`,
      ...(document.propertyLabel !== null
        ? [`Property: ${document.propertyLabel}`]
        : []),
      "",
      "Estimate items:",
      ...document.lineItems.flatMap((item, index) => [
        `${index + 1}. ${item.description}`,
        `   Quantity: ${item.quantity} | Unit price: ${money(item.unitPriceCents)} | Line total: ${money(item.totalCents)}`,
      ]),
      "",
      `Subtotal: ${money(document.subtotalCents)}`,
      `Tax: ${money(document.taxCents)}`,
      `Estimate total: ${money(document.totalCents)}`,
      ...(document.notes !== null
        ? ["", "Customer-facing notes", document.notes]
        : []),
    ].join("\n"),
  };
}
export function assertEstimateEmailMessageFits(
  selectedProvider: UserEmailProvider,
  message: EstimateEmailMessage,
): void {
  if (!estimateEmailMessageSchema.safeParse(message).success)
    throw new EstimateDeliveryError(
      422,
      "invalid_estimate_email",
      "Email headers are invalid.",
    );
  if (
    selectedProvider === "microsoft" &&
    (message.subject.length > 1000 || message.body.length > 1000000)
  )
    throw new EstimateDeliveryError(
      422,
      "estimate_email_too_large",
      "Complete estimate exceeds the selected provider limits.",
    );
}
export function estimateDeliveryFingerprint(value: unknown): string {
  const canonical = (item: unknown): string => {
    if (item instanceof Date) return JSON.stringify(item.toISOString());
    if (Array.isArray(item)) return `[${item.map(canonical).join(",")}]`;
    if (item && typeof item === "object")
      return `{${Object.keys(item)
        .sort()
        .map(
          (key) =>
            `${JSON.stringify(key)}:${canonical((item as Record<string, unknown>)[key])}`,
        )
        .join(",")}}`;
    return JSON.stringify(item) ?? "null";
  };
  return createHash("sha256").update(canonical(value)).digest("hex");
}
