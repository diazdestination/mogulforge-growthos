import { z } from "zod";
import type { ServiceStandingSettings, ServiceStandingSnapshot } from "../../../../lib/db/src/schema/service-standing";
export type { ServiceStandingSettings, ServiceStandingSnapshot } from "../../../../lib/db/src/schema/service-standing";

const calendarDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const d = new Date(`${value}T12:00:00Z`); return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === value;
});
const note = z.string().trim().min(10).max(1000);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const serviceStandingSettingsSchema = z.object({
  enabled: z.boolean(), channel: z.enum(["email", "sms"]), agreementStartsOn: calendarDate, agreementEndsOn: calendarDate, agreementEvidence: note,
  sourceReview: z.object({ kind: z.enum(["native", "reconciled_import"]), verifiedAt: z.iso.datetime(), cutoverAt: z.iso.datetime().nullable(), evidence: note }).strict(),
}).strict().refine(value => value.agreementStartsOn <= value.agreementEndsOn, { message: "Agreement dates must be ordered." });
export const serviceStandingPreviewInputSchema = z.object({ expectedVersion: z.number().int().nonnegative(), expectedUpdatedAt: z.iso.datetime(), policy: serviceStandingSettingsSchema }).strict();
export const serviceStandingApprovalInputSchema = z.object({ expectedVersion: z.number().int().nonnegative(), expectedSnapshot: z.record(z.string(), z.unknown()), previewHash: hash, confirmed: z.literal(true) }).strict();
export const serviceStandingDisableInputSchema = z.object({ requestId: z.uuid(), expectedVersion: z.number().int().nonnegative(), reason: note, confirmed: z.literal(true) }).strict();
const recurrence = z.object({ mode: z.literal("calendar_months"), intervalMonths: z.number().int().min(1).max(60), anchorDate: calendarDate, endDate: calendarDate.nullable(), agreementNote: z.string().min(1).max(500), approvedByUserId: z.string().min(1), approvedAt: z.iso.datetime() }).strict();
const scope = z.object({ seriesRootObligationId: z.uuid(), anchorObligationId: z.uuid(), anchorUpdatedAt: z.iso.datetime(), anchorOccurrenceIndex: z.number().int().nonnegative(),
  reviewedObligationId: z.uuid(), reviewedUpdatedAt: z.iso.datetime(), reviewedOccurrenceIndex: z.number().int().nonnegative(),
  contactId: z.uuid(), propertyId: z.uuid().nullable(), kind: z.string(), equipmentLabel: z.string(), noticeDays: z.number().int(), source: z.string(), externalRef: z.string().nullable(), recurrence,
  coverageStartsOn: calendarDate.nullable(), coverageEndsOn: calendarDate.nullable(), coverageEvidence: z.string().nullable(), ownerUserId: z.string(), recipient: z.string(), businessName: z.string() }).strict();
export const serviceStandingSnapshotSchema = z.object({ schemaVersion: z.literal("service-standing-policy.v1"), settings: serviceStandingSettingsSchema, scope,
  seriesFingerprint: hash, sourceReviewFingerprint: hash, templateVersion: z.literal("service-care.v2"), template: z.object({ subject: z.string(), body: z.string() }).strict(),
  sender: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("email"), userId: z.string(), source: z.literal("company_default"), provider: z.enum(["gmail", "microsoft"]), senderEmail: z.email(), connectionId: z.uuid(), connectionRevision: z.iso.datetime(), accountId: z.string().nullable() }).strict(),
    z.object({ kind: z.literal("sms"), id: z.string(), accountSid: z.string(), sender: z.string(), messagingServiceSid: z.string(), disclosureVersion: z.string(), origin: z.string(), businessName: z.string() }).strict(),
  ]),
  sendingHours: z.object({ quietHoursEnabled: z.boolean(), timezone: z.string(), startHour: z.number().int(), endHour: z.number().int(), days: z.array(z.string()), maxTouchesPerDay: z.number().int().nonnegative() }).strict(),
}).strict();
export interface ServiceStandingPreviewSnapshot {
  schemaVersion: "service-standing-preview.v1"; organizationId: string; actorUserId: string; reviewId: string; enrollmentId: string;
  expectedVersion: number; issuedAt: string; expiresAt: string; policy: ServiceStandingSnapshot;
}
export const serviceStandingPreviewResponseSchema = z.object({ expectedVersion: z.number().int().nonnegative(), expectedSnapshot: z.object({ schemaVersion: z.literal("service-standing-preview.v1"), organizationId: z.uuid(), actorUserId: z.string(), reviewId: z.uuid(), enrollmentId: z.uuid(), expectedVersion: z.number().int().nonnegative(), issuedAt: z.iso.datetime(), expiresAt: z.iso.datetime(), policy: serviceStandingSnapshotSchema }).strict(), previewHash: hash, expiresAt: z.iso.datetime() }).strict();
export type ServiceStandingPreview = z.infer<typeof serviceStandingPreviewResponseSchema>;
export const serviceStandingViewSchema = z.object({ serviceObligationId: z.uuid(), expectedUpdatedAt: z.iso.datetime(), enrollmentId: z.uuid().nullable(), version: z.number().int().nonnegative(), revisionId: z.uuid().nullable(), anchorObligationId: z.uuid(), seriesRootObligationId: z.uuid(),
  policy: serviceStandingSettingsSchema.nullable(), approvedSnapshot: serviceStandingSnapshotSchema.nullable(),
  sourceSummary: z.object({ source: z.string(), externalRef: z.string().nullable(), kind: z.string(), equipmentLabel: z.string(), dueDate: calendarDate, noticeDays: z.number().int(), recurrence: recurrence.nullable(), ownerUserId: z.string().nullable(), coverageStartsOn: calendarDate.nullable(), coverageEndsOn: calendarDate.nullable() }).strict(),
  readiness: z.object({ ready: z.boolean(), reason: z.string().nullable() }).strict(),
  occurrence: z.object({ eligible: z.boolean(), reason: z.string().nullable(), noticeAt: z.iso.datetime(), expiresAt: z.iso.datetime().nullable(), authorizationId: z.uuid().nullable(), scheduledActionId: z.uuid().nullable(), origin: z.enum(["individual", "standing"]).nullable(), receiptState: z.string().nullable() }).strict(),
}).strict();
export type ServiceStandingView = z.infer<typeof serviceStandingViewSchema>;
export type ServiceStandingPolicyInput = z.infer<typeof serviceStandingPreviewInputSchema>;
export type ServiceStandingApprovalInput = z.infer<typeof serviceStandingApprovalInputSchema>;
export type ServiceStandingDisableInput = z.infer<typeof serviceStandingDisableInputSchema>;
export const STANDING_PREVIEW_MS = 10 * 60_000;
export const STANDING_BATCH_SIZE = 20;
export const STANDING_LINEAGE_LIMIT = 256;
