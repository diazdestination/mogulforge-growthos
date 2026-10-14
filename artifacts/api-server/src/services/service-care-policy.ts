import { createHash } from "node:crypto";
import { z } from "zod";
import { digestSchema, isoSchema, schedulingMutationReviewSchema, schedulingPolicySchema, schedulingReviewContextSchema, userIdSchema, uuidSchema } from "@workspace/scheduling-core";
import type { CustomerEmailSender } from "./customer-email";
import type { MailboxIdentity } from "./mailbox-contract";

export type ServiceCareSnapshot = {
  obligationId: string; updatedAt: string; contactId: string; recipient: string;
  channel: "email" | "sms"; subject: string; body: string; noticeAt: string;
  sender: CustomerEmailSender | null; smsBinding: string | null;
  mailboxIdentity?: MailboxIdentity;
  smsReply?: { version: 1; reference: string };
};
export type ServiceCareAuthorization = { origin: "individual"; version: 1 } | {
  origin: "standing"; version: 1; policyRevisionId: string; anchorObligationId: string;
  policyHash: string; seriesFingerprint: string; sourceReviewFingerprint: string;
  admittedAt: string; expiresAt: string;
};
/** Missing legacy authorization remains individual; it is never a standing grant. */
export type ServiceCareApproval = {
  snapshot: ServiceCareSnapshot; scheduledActionId: string; agreementNote: string;
  requestId?: string; requestFingerprint?: string; authorization?: ServiceCareAuthorization;
};

export const careChannel = z.enum(["email", "sms"]);
const command = {
  requestId: z.uuid(),
  expectedUpdatedAt: z.iso.datetime(),
};
export const approveServiceCareSchema = z.object({
  ...command, channel: careChannel, previewFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  agreementNote: z.string().trim().min(10).max(1000),
  expectedServiceConfirmed: z.literal(true),
}).strict();
export const serviceCareResponseSchema = z.object({
  ...command, channel: z.enum(["phone", "email", "sms", "in_person"]),
  outcome: z.enum(["ready_to_book", "follow_up", "declined"]),
  respondedAt: z.iso.datetime(), note: z.string().trim().min(10).max(1000),
  staffAttested: z.literal(true),
}).strict();
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
export const careFingerprint = (value: unknown) => createHash("sha256").update(careCanonicalJson(value)).digest("hex");

/** Fixed expected-service copy: never infers warranty terms or promotes work. */
export function serviceCareMessage(input: { businessName: string; equipmentLabel: string; kind: string; dueDate: string }) {
  const kind = input.kind === "warranty_check" ? "warranty check" : input.kind === "service_plan" ? "service-plan visit" : "maintenance visit";
  return {
    subject: `${input.businessName}: arrange your recorded service visit`,
    body: `${input.businessName}: Our records show a ${kind} for ${input.equipmentLabel} due ${input.dueDate}. Please reply or contact our office to arrange a convenient time. No appointment is booked yet. If these details are no longer correct, please let us know. This reminder does not determine warranty coverage.`,
  };
}
