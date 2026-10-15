import { z } from "zod/v4";
import { manualSourceRefSchema, schedulingMutationReviewSchema, schedulingPolicySchema, schedulingReviewContextSchema, userIdSchema } from "@workspace/scheduling-core";

export const CALLIE_PAGE_SIZE = 25;
export const callieListQuery = z.object({
  scope: z.enum(["attention", "waiting", "history"]).default("attention"),
  offset: z.coerce.number().int().min(0).max(100000).default(0),
}).strict();
const command = {
  requestId: z.uuid(),
  expectedVersion: z.number().int().positive(),
  expectedFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
};
export const callieOfficeActionSchema = z.discriminatedUnion("action", [
  z.object({ ...command, action: z.literal("assign"), assignedUserId: z.string().min(1).max(200), note: z.string().trim().min(10).max(1000) }).strict(),
  z.object({ ...command, action: z.enum(["resolved", "cancelled"]), note: z.string().trim().min(10).max(1000), staffConfirmed: z.literal(true) }).strict(),
]);
export const callieBookingSchema = z.object({
  ...command,
  contactId: z.uuid(),
  leadId: z.uuid().nullable(),
  propertyId: z.uuid().nullable(),
  assignedUserId: z.string().min(1).max(200),
  type: z.enum(["inspection", "other"]),
  scheduledStart: z.iso.datetime(),
  scheduledEnd: z.iso.datetime(),
  confirmationNote: z.string().trim().min(10).max(1000),
  customerConfirmed: z.literal(true),
  schedulingReview: schedulingMutationReviewSchema.optional(),
}).strict();

/** Preserve CALLIE's original parsed-input hash; this module is browser safe. */
function sourceCanonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(sourceCanonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${sourceCanonical(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
export function canonicalCallieBookingInput(input: unknown): string {
  return sourceCanonical(callieBookingSchema.parse(input));
}
export const callieSchedulingContextQuerySchema = z.object({ appointmentType: z.enum(["inspection", "other"]), propertyId: z.uuid().optional() }).strict();
export const callieSchedulingContextReadSchema = z.object({
  organizationId: z.uuid(), actorUserId: userIdSchema, intakeId: z.uuid(),
  expectedVersion: command.expectedVersion, expectedFingerprint: command.expectedFingerprint,
  appointmentType: z.enum(["inspection", "other"]), source: manualSourceRefSchema.nullable(),
  review: z.discriminatedUnion("state", [
    z.object({ state: z.literal("ready"), policy: schedulingPolicySchema.nullable(), context: schedulingReviewContextSchema }).strict(),
    z.object({ state: z.literal("held"), code: z.enum(["caller_review_required", "invalid_scheduling_policy"]), message: z.string().min(1).max(1000) }).strict(),
  ]),
}).strict().superRefine((value, ctx) => {
  const source = value.source;
  if (source && (!source.contactId || source.estimateId !== null || source.sourceKind !== (source.leadId ? "lead" : "direct_customer"))) ctx.addIssue({ code: "custom", message: "Invalid CALLIE customer source." });
  if (value.review.state === "ready") {
    const { context, policy } = value.review;
    if (!source || context.organizationId !== value.organizationId || sourceCanonical(context.source) !== sourceCanonical(source) || context.targetVersion !== null || context.targetFingerprint !== null ||
      (value.appointmentType === "inspection" ? !context.inspection || context.applicableRules.inspectionCeiling === null : context.inspection !== null || context.applicableRules.inspectionCeiling !== null) ||
      context.policyRevision !== (policy?.revision ?? 0) || context.policyDigest !== (policy?.digest ?? null) || (policy && policy.timeZone !== context.companyTimeZone) ||
      context.applicableRules.newTravelGapMinutes !== (policy?.enabled ? policy.minimumTravelGapMinutes : 0) || context.applicableRules.companyCeiling !== (policy?.enabled ? policy.maxConcurrentReservations : null)) ctx.addIssue({ code: "custom", message: "Mismatched CALLIE scheduling context." });
  } else if ((value.review.code === "caller_review_required") !== (source === null)) ctx.addIssue({ code: "custom", message: "Mismatched CALLIE source hold." });
});
export const callieBookingOutcomeSchema = z.object({
  formatVersion: z.literal(1), status: z.literal("committed"), organizationId: z.uuid(), actorUserId: userIdSchema,
  intakeId: z.uuid(), bookingId: z.uuid(), requestId: z.uuid(), requestFingerprint: command.expectedFingerprint,
  expectedVersion: command.expectedVersion, expectedFingerprint: command.expectedFingerprint,
  customerConfirmed: z.literal(true), appointmentId: z.uuid(),
}).strict();
export type CallieSchedulingContextQuery = z.infer<typeof callieSchedulingContextQuerySchema>;
export type CallieSchedulingContextRead = z.infer<typeof callieSchedulingContextReadSchema>;
export type CallieBookingOutcome = z.infer<typeof callieBookingOutcomeSchema>;
export const callieCallerReviewSchema = z.discriminatedUnion("action", [
  z.object({ ...command, action: z.literal("link_contact"), contactId: z.uuid(), staffConfirmed: z.literal(true) }).strict(),
  z.object({ ...command, action: z.literal("create_opportunity"), contactId: z.uuid().optional(), firstName: z.string().trim().min(1).max(100).optional(),
    lastName: z.string().trim().max(100).optional(), serviceType: z.string().trim().max(100).optional(), staffConfirmed: z.literal(true) }).strict(),
]);

export type CallieListQuery = z.infer<typeof callieListQuery>;
export type CallieOfficeAction = z.infer<typeof callieOfficeActionSchema>;
export type CallieBooking = z.infer<typeof callieBookingSchema>;
export type CallieCallerReview = z.infer<typeof callieCallerReviewSchema>;
