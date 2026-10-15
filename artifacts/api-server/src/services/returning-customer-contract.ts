import { z } from "zod/v4";
import {
  digestSchema,
  reservationSnapshotSchema,
  schedulingMutationReviewSchema,
  userIdSchema,
} from "@workspace/scheduling-core";

/** Exact source command serialization, shared with browser custody. */
export function canonicalCustomerWorkValue(value: unknown): string {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(canonicalCustomerWorkValue).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([,v]) => v !== undefined).sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => `${JSON.stringify(k)}:${canonicalCustomerWorkValue(v)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

/** Browser/codegen safe. Native records remain the only work and billing state. */
export class CustomerWorkError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
const id = z.uuid(),
  instant = z.iso.datetime(),
  version = z.number().int().min(1).max(2_147_483_646);
const text = (max: number) => z.string().trim().min(1).max(max);
const cents = z.number().int().min(0).max(1_000_000_000);
export const existingCustomerSourceSchema = z
  .object({
    kind: z.literal("existing_customer"),
    contactId: id,
    propertyId: id.nullable(),
  })
  .strict();
export const customerWorkSourceSchema = z
  .object({ kind: z.literal("customer_work"), customerWorkId: id })
  .strict();
export const acceptedEstimateSourceSchema = z
  .object({
    kind: z.literal("estimate"),
    estimateId: id,
    expectedWorkVersion: version,
  })
  .strict();
export const customerWorkLineItemInputSchema = z
  .object({
    description: text(1000),
    quantity: z
      .number()
      .positive()
      .max(999999)
      .refine(
        (v) => /^\d+(?:\.\d{1,3})?$/.test(String(v)),
        "Use at most three decimal places.",
      ),
    unitPriceCents: cents,
  })
  .strict();
const estimateFields = {
  title: text(150),
  lineItems: z.array(customerWorkLineItemInputSchema).max(100),
  taxCents: cents,
  notes: z.string().trim().max(2000).nullable(),
};
export const createCustomerWorkEstimateSchema = z
  .object({
    requestId: id,
    confirmed: z.literal(true),
    source: existingCustomerSourceSchema,
    ...estimateFields,
  })
  .strict();
export const updateCustomerWorkEstimateSchema = z
  .object({
    requestId: id,
    confirmed: z.literal(true),
    expectedWorkVersion: version,
    ...estimateFields,
    status: z.enum(["draft", "sent", "accepted", "declined"]),
  })
  .strict();
const projectFields = {
  name: text(200),
  status: z.enum([
    "scheduled",
    "in_progress",
    "on_hold",
    "completed",
    "cancelled",
  ]),
  scheduledStart: instant.nullable(),
  scheduledEnd: instant.nullable(),
  crewUserIds: z
    .array(text(200))
    .max(50)
    .refine((v) => new Set(v).size === v.length),
  crewNotes: z.string().trim().max(4000).nullable(),
};
// No defaults: historical omitted fields must keep their original command hash.
export const createCustomerWorkProjectSchema = z
  .object({
    requestId: id,
    confirmed: z.literal(true),
    source: z.discriminatedUnion("kind", [
      existingCustomerSourceSchema,
      acceptedEstimateSourceSchema,
    ]),
    ...projectFields,
    schedulingReview: schedulingMutationReviewSchema.optional(),
  })
  .strict();
export const updateCustomerWorkProjectSchema = z
  .object({
    requestId: id,
    confirmed: z.literal(true),
    expectedWorkVersion: version,
    ...projectFields,
    schedulingReview: schedulingMutationReviewSchema.optional(),
    expectedTargetFingerprint: digestSchema.optional(),
  })
  .strict();
export const CUSTOMER_WORK_ACTIONS = [
  "estimate_created",
  "estimate_updated",
  "project_created",
  "project_updated",
] as const;
export const customerWorkCommandSchema = z
  .object({
    requestId: id,
    action: z.enum(CUSTOMER_WORK_ACTIONS),
    customerWorkId: id,
    targetId: id,
    version,
    duplicate: z.boolean(),
  })
  .strict();
export const nativeWorkContextFields = {
  organizationId: id,
  leadId: id.nullable(),
  customerWorkId: id.nullable(),
  contactId: id,
  propertyId: id.nullable(),
  sourceKind: z.enum(["lead", "customer_work"]),
  customerLabel: text(500),
  propertyLabel: z.string().nullable(),
  leadLabel: z.string().nullable(),
  workVersion: version.nullable(),
};
const contextCoherent = (v: {
  sourceKind: string;
  leadId: string | null;
  customerWorkId: string | null;
  workVersion: number | null;
}) =>
  v.sourceKind === "lead"
    ? v.leadId !== null && v.customerWorkId === null && v.workVersion === null
    : v.leadId === null && v.customerWorkId !== null && v.workVersion !== null;
export const customerWorkEstimateSchema = z
  .object({
    id,
    ...nativeWorkContextFields,
    title: text(150),
    status: z.enum(["draft", "sent", "accepted", "declined"]),
    lineItems: z
      .array(customerWorkLineItemInputSchema.extend({ totalCents: cents }))
      .max(100),
    subtotalCents: cents,
    taxCents: cents,
    totalCents: cents,
    notes: z.string().nullable(),
    sentAt: instant.nullable(),
    acceptedAt: instant.nullable(),
    createdAt: instant,
    updatedAt: instant,
  })
  .strict()
  .refine(contextCoherent);
export const customerWorkProjectSchema = z
  .object({
    id,
    ...nativeWorkContextFields,
    estimateId: id.nullable(),
    ...projectFields,
    completedAt: instant.nullable(),
    createdAt: instant,
    updatedAt: instant,
    schedulingReservation: reservationSnapshotSchema.nullable(),
    schedulingEvidence: z.enum(["legacy", "versioned", "invalid"]),
    schedulingTargetFingerprint: digestSchema,
  })
  .strict()
  .refine(contextCoherent);
export const customerWorkProjectOutcomeSchema = z
  .object({
    formatVersion: z.literal(1),
    organizationId: id,
    actorUserId: userIdSchema,
    requestId: id,
    action: z.enum(["project_created", "project_updated"]),
    payloadSha256: digestSchema,
    customerWorkId: id,
    target: z
      .object({ kind: z.literal("project"), id, available: z.boolean() })
      .strict(),
    resultWorkVersion: version,
    outcome: z.literal("committed"),
  })
  .strict();
export type CustomerWorkProjectOutcome = z.infer<
  typeof customerWorkProjectOutcomeSchema
>;
export const customerWorkProjectUnavailableSchema = z
  .object({
    error: z.string(),
    code: z.literal("customer_work_result_unavailable"),
    commandOutcome: customerWorkProjectOutcomeSchema,
  })
  .strict()
  .refine((v) => !v.commandOutcome.target.available);
/** Only an already committed original command may produce this acknowledgement. */
export class CustomerWorkProjectResultUnavailableError extends CustomerWorkError {
  constructor(readonly commandOutcome: CustomerWorkProjectOutcome) {
    super(
      409,
      "customer_work_result_unavailable",
      "The original job command committed, but its current display is unavailable. Retain the original command; do not recreate it.",
    );
    customerWorkProjectUnavailableSchema.parse({
      error: this.message,
      code: this.code,
      commandOutcome,
    });
  }
}
export const customerWorkEstimateMutationSchema = z
  .object({
    organizationId: id,
    estimate: customerWorkEstimateSchema,
    command: customerWorkCommandSchema,
  })
  .strict();
export const customerWorkProjectMutationSchema = z
  .object({
    organizationId: id,
    project: customerWorkProjectSchema,
    command: customerWorkCommandSchema,
    commandOutcome: customerWorkProjectOutcomeSchema,
  })
  .strict();
export type CustomerWorkEstimate = z.infer<typeof customerWorkEstimateSchema>;
export type CustomerWorkProject = z.infer<typeof customerWorkProjectSchema>;
export type CustomerWorkEstimateMutation = z.infer<
  typeof customerWorkEstimateMutationSchema
>;
export type CustomerWorkProjectMutation = z.infer<
  typeof customerWorkProjectMutationSchema
>;
