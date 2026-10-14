import { createHash } from "node:crypto";
import { z } from "zod";
import { careCanonicalJson } from "./service-care-booking-contract";
export { careCanonicalJson, serviceCareBookingSchema, serviceCareSchedulingSourceSchema, serviceCareSchedulingReadSchema, serviceCareBookingOutcomeSchema, serviceCareBookingResultSchema } from "./service-care-booking-contract";
export type { ServiceCareBookingInput, ServiceCareSchedulingRead, ServiceCareBookingOutcome, ServiceCareBookingResult } from "./service-care-booking-contract";
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
export const careFingerprint = (value: unknown) => createHash("sha256").update(careCanonicalJson(value)).digest("hex");

/** Fixed expected-service copy: never infers warranty terms or promotes work. */
export function serviceCareMessage(input: { businessName: string; equipmentLabel: string; kind: string; dueDate: string }) {
  const kind = input.kind === "warranty_check" ? "warranty check" : input.kind === "service_plan" ? "service-plan visit" : "maintenance visit";
  return {
    subject: `${input.businessName}: arrange your recorded service visit`,
    body: `${input.businessName}: Our records show a ${kind} for ${input.equipmentLabel} due ${input.dueDate}. Please reply or contact our office to arrange a convenient time. No appointment is booked yet. If these details are no longer correct, please let us know. This reminder does not determine warranty coverage.`,
  };
}
