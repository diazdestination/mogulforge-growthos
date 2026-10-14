/** Browser-safe original Service Care booking and scheduling contracts. */
import { z } from "zod";
import { digestSchema, isoSchema, schedulingMutationReviewSchema, schedulingPolicySchema, schedulingReviewContextSchema, userIdSchema, uuidSchema } from "@workspace/scheduling-core";

const command = {
  requestId: z.uuid(),
  expectedUpdatedAt: z.iso.datetime(),
};

export const serviceCareBookingSchema = z.object({
  ...command, responseId: z.uuid(), assignedUserId: z.string().min(1).max(200),
  scheduledStart: z.iso.datetime(), scheduledEnd: z.iso.datetime(),
  type: z.enum(["inspection", "other"]), customerConfirmed: z.literal(true),
  // Omitted historical review is part of the original hash. Fresh staff work
  // requires review only AFTER the original source receipt lookup.
  schedulingReview: schedulingMutationReviewSchema.optional(),
}).strict();
export type ServiceCareBookingInput = z.infer<typeof serviceCareBookingSchema>;

export const serviceCareSchedulingSourceSchema = z.strictObject({
  sourceKind: z.literal("direct_customer"), leadId: z.null(), contactId: uuidSchema,
  propertyId: uuidSchema.nullable(), estimateId: z.null(),
});
export const serviceCareSchedulingReadSchema = z.strictObject({
  organizationId: uuidSchema, actorUserId: userIdSchema.nullable(), obligationId: uuidSchema,
  expectedUpdatedAt: isoSchema, appointmentType: z.enum(["inspection", "other"]),
  source: serviceCareSchedulingSourceSchema,
  review: z.discriminatedUnion("state", [
    z.strictObject({ state: z.literal("ready"), policy: schedulingPolicySchema.nullable(), context: schedulingReviewContextSchema }),
    z.strictObject({ state: z.literal("held"), code: z.enum(["scheduling_reader_required", "invalid_scheduling_policy"]), message: z.string() }),
  ]),
}).superRefine((value, ctx) => {
  if (value.review.state !== "ready") return;
  const { context, policy } = value.review;
  if (value.actorUserId === null || context.organizationId !== value.organizationId ||
    careCanonicalJson(context.source) !== careCanonicalJson(value.source) ||
    context.targetVersion !== null || context.targetFingerprint !== null ||
    context.policyRevision !== (policy?.revision ?? 0) || context.policyDigest !== (policy?.digest ?? null) ||
    (policy !== null && context.companyTimeZone !== policy.timeZone) ||
    (value.appointmentType === "inspection") !== (context.inspection !== null)) {
    ctx.addIssue({ code: "custom", message: "Scheduling review must bind this reader, service source and selected booking scope" });
  }
});
export type ServiceCareSchedulingRead = z.infer<typeof serviceCareSchedulingReadSchema>;
export const serviceCareBookingOutcomeSchema = z.strictObject({
  formatVersion: z.literal(1), status: z.literal("committed"), organizationId: uuidSchema,
  actorUserId: userIdSchema, obligationId: uuidSchema, bookingId: uuidSchema, requestId: z.uuid(),
  // Original source command spelling (including historical sub-ms precision)
  // is retained; only server-created timestamps use the core ISO restriction.
  requestFingerprint: digestSchema, responseId: uuidSchema, expectedUpdatedAt: command.expectedUpdatedAt, appointmentId: uuidSchema,
});
export type ServiceCareBookingOutcome = z.infer<typeof serviceCareBookingOutcomeSchema>;
export const serviceCareBookingResultSchema = z.strictObject({
  appointmentId: uuidSchema, replayed: z.boolean(), bookingOutcome: serviceCareBookingOutcomeSchema,
}).refine(value => value.appointmentId === value.bookingOutcome.appointmentId, "Original booking target must agree");
export type ServiceCareBookingResult = z.infer<typeof serviceCareBookingResultSchema>;

// Matches durable-execution's canonical JSON representation; JSONB key order
// must not change the identity of an approved payload or execution receipt.
export function careCanonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(careCanonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${careCanonicalJson(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
