import { z } from "zod";
import { importedOpportunityHistorySchema } from "@workspace/db/schema";

export class SourceNurtureError extends Error {
  constructor(readonly status: number, readonly code: string, message = code.replaceAll("_", " ")) { super(message); }
}
export function nurtureDeny(code: string, status = 409): never { throw new SourceNurtureError(status, code); }
export const NURTURE_MAX_RECIPIENTS = 10, NURTURE_SPACING_MS = 72 * 3_600_000, NURTURE_LIFETIME_MS = 14 * 86_400_000, NURTURE_REVIEW_MS = 10 * 60_000;
const uuid = z.uuid(), digest = z.string().regex(/^[a-f0-9]{64}$/), date = z.iso.datetime(), version = z.number().int().positive();
const textLine = (min: number, max: number) => z.string().trim().min(min).max(max).refine(value => !/[\r\n]/.test(value));
const message = z.object({ subject: textLine(3, 180), body: z.string().trim().min(10).max(4000) }).strict();
export const sourceNurtureSettingsSchema = z.object({
  businessName: textLine(2, 150), mailingAddress: z.string().trim().min(10).max(400), steps: z.tuple([message, message]),
  timezone: z.string().min(1).refine(value => { try { new Intl.DateTimeFormat("en", { timeZone: value }).format(); return true; } catch { return false; } }),
  days: z.array(z.enum(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"])).min(1).max(7).refine(value => new Set(value).size === value.length),
  startHour: z.number().int().min(8).max(19), endHour: z.number().int().min(9).max(20), dailyLimit: z.number().int().min(1).max(25),
}).strict();
export const sourceNurtureDraftSchema = sourceNurtureSettingsSchema.extend({ leadIds: z.array(uuid).min(1).max(10).refine(ids => new Set(ids).size === ids.length), startNotBefore: date, expiresAt: date }).strict()
  .refine(value => value.endHour > value.startHour && value.leadIds.length <= value.dailyLimit);
export const sourceNurtureApprovalSchema = z.object({ expectedVersion: version, payloadSha256: digest, confirmed: z.literal(true) }).strict();
export const sourceNurtureStartSchema = sourceNurtureApprovalSchema.extend({ requestId: uuid }).strict();
export const sourceNurtureStopSchema = sourceNurtureStartSchema.extend({ reason: z.string().trim().min(10).max(1000) }).strict();
export const sourceNurtureListQuerySchema = z.object({ bucket: z.enum(["attention", "waiting", "history"]).default("attention"), offset: z.coerce.number().int().min(0).max(100_000).default(0) }).strict();
export const nurtureMailboxIdentitySchema = z.object({ organizationId: uuid, senderUserId: z.string(), provider: z.literal("microsoft"), connectionId: uuid, connectionRevision: date,
  mailboxAccountId: z.string(), mailboxEmail: z.email(), connectorId: uuid, connectorVersion: version, policyVersion: z.literal(1), startedAt: date }).strict();
export const nurtureMonitoringApprovalSchema = z.object({ version, approvedAt: date }).strict();
const source = z.object({ leadId: uuid, contactId: uuid, importSourceKey: z.string(), externalOpportunityId: z.string(), importedHistory: importedOpportunityHistorySchema,
  sourceSha256: digest, operationalSha256: digest, recipient: z.string() }).strict();
const sender = z.object({ userId: z.string(), source: z.enum(["lead_assignee", "company_default"]), provider: z.literal("microsoft"), senderEmail: z.email() }).strict();
export const sourceNurtureItemSnapshotSchema = z.object({ version: z.literal(1), adoptionId: uuid, adoptionVersion: version, adoptionSha256: digest, adoption: source,
  permissionRecordId: uuid, ownerUserId: z.string(), propertyId: uuid.nullable(), leadCreatedAt: date, sender, mailboxIdentity: nurtureMailboxIdentitySchema, nurtureMonitoringApproval: nurtureMonitoringApprovalSchema }).strict();
const readiness = z.object({ ready: z.boolean(), reason: z.string().nullable(), nextCheckAt: date.nullable() }).strict();
export const nurtureMailboxSyncSchema = z.object({ ready: z.boolean(), reason: z.string().nullable(), completedCycleId: uuid.nullable(), startedAt: date.nullable(), completedAt: date.nullable() }).strict();
export const sourceNurtureStateSchema = z.enum(["draft", "approved", "running", "stopped", "finished", "expired"]);
export const sourceNurtureStepViewSchema = z.object({ id: uuid, stepIndex: z.union([z.literal(1), z.literal(2)]), subject: z.string(), body: z.string(), messageHash: digest,
  scheduledActionId: uuid.nullable(), notBefore: date.nullable(), expiresAt: date, claimedAt: date.nullable(), acceptedAt: date.nullable(),
  state: z.enum(["not_started", "waiting", "ready", "held", "processing", "accepted", "uncertain", "cancelled", "finished"]), reason: z.string().nullable(),
  executionId: uuid.nullable(), executionState: z.string().nullable(), parentId: uuid.nullable(), observedAt: date.nullable(), dispatchStartedAt: date.nullable(), deliveryConfirmed: z.literal(false) }).strict();
export const sourceNurtureDetailSchema = z.object({ organizationId: uuid, id: uuid, version, state: sourceNurtureStateSchema, payloadSha256: digest,
  settings: sourceNurtureSettingsSchema, reviewId: uuid, createdByUserId: z.string(), approvedByUserId: z.string().nullable(), createdAt: date, previewExpiresAt: date,
  startNotBefore: date, expiresAt: date, approvedAt: date.nullable(), startedAt: date.nullable(), stoppedAt: date.nullable(), stopReason: z.string().nullable(),
  readiness, limits: z.object({ maxRecipients: z.literal(10), steps: z.literal(2), minSpacingHours: z.literal(72), maxLifetimeDays: z.literal(14) }).strict(),
  items: z.array(z.object({ id: uuid, leadId: uuid, contactId: uuid, propertyId: uuid.nullable(), ownerUserId: z.string(), recipient: z.email(), snapshot: sourceNurtureItemSnapshotSchema,
    admittedAt: date.nullable(), stoppedAt: date.nullable(), stopReason: z.string().nullable(), readiness, mailboxSync: nurtureMailboxSyncSchema, steps: z.array(sourceNurtureStepViewSchema).length(2),
    outcomes: z.object({ leadStatus: z.string(), replyIds: z.array(uuid), taskIds: z.array(uuid), appointmentIds: z.array(uuid) }).strict() }).strict()).min(1).max(10),
}).strict();
export const sourceNurtureCommandResponseSchema = z.object({ detail: sourceNurtureDetailSchema, command: z.object({ action: z.enum(["approve", "start", "stop"]), requestId: uuid.nullable(), replayed: z.boolean(), appliedVersion: version }).strict() }).strict();
export const sourceNurtureListSchema = z.object({ organizationId: uuid, bucket: z.enum(["attention", "waiting", "history"]), offset: z.number().int().nonnegative(), limit: z.literal(25), hasMore: z.boolean(),
  items: z.array(z.object({ id: uuid, version, state: sourceNurtureStateSchema, payloadSha256: digest, createdAt: date, expiresAt: date, recipientCount: z.number().int().min(1).max(10),
    acceptedSteps: z.number().int().min(0).max(20), uncertainSteps: z.number().int().min(0).max(20), reason: z.string().nullable(), nextCheckAt: date.nullable() }).strict()).max(25) }).strict();
export type SourceNurtureDetail = z.infer<typeof sourceNurtureDetailSchema>;
export type SourceNurtureList = z.infer<typeof sourceNurtureListSchema>;
export type SourceNurtureCommandResponse = z.infer<typeof sourceNurtureCommandResponseSchema>;
