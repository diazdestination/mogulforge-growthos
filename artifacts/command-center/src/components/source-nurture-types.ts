import { z } from "zod/v4";

// Browser-safe mirror of the frozen runtime contract. No server/DB imports.
const id = z.uuid(), date = z.iso.datetime(), digest = z.string().regex(/^[a-f0-9]{64}$/), version = z.number().int().positive();
const line = (min: number, max: number) => z.string().trim().min(min).max(max).refine(value => !/[\r\n]/.test(value));
const message = z.object({ subject: line(3, 180), body: z.string().trim().min(10).max(4000) }).strict();
export const nurtureSettingsSchema = z.object({
  businessName: line(2, 150), mailingAddress: z.string().trim().min(10).max(400), steps: z.tuple([message, message]),
  timezone: z.string().min(1).refine(value => { try { new Intl.DateTimeFormat("en", { timeZone: value }).format(); return true; } catch { return false; } }),
  days: z.array(z.enum(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"])).min(1).max(7).refine(value => new Set(value).size === value.length),
  startHour: z.number().int().min(8).max(19), endHour: z.number().int().min(9).max(20), dailyLimit: z.number().int().min(1).max(25),
}).strict();
export const nurtureDraftSchema = nurtureSettingsSchema.extend({ leadIds: z.array(id).min(1).max(10).refine(value => new Set(value).size === value.length), startNotBefore: date, expiresAt: date }).strict().refine(value => value.endHour > value.startHour && value.leadIds.length <= value.dailyLimit);
const importedHistory = z.object({ version: z.literal(1), kind: z.literal("csv_snapshot"), originalCreatedAt: date.nullable(), sourceUpdatedAt: date.nullable(), statusChangedAt: date.nullable(), lastContactAt: date.nullable(), snapshotAsOf: date.nullable(), firstImportedAt: date, lastImportedAt: date, externalCustomerId: z.string().min(1).max(200).nullable(), externalEstimateId: z.string().min(1).max(200).nullable(), currency: z.literal("USD").nullable(), fingerprint: digest, appliedFingerprint: digest, mappedFields: z.array(z.string().min(1).max(40)).max(30) }).strict();
const mailboxIdentity = z.object({ organizationId: id, senderUserId: z.string(), provider: z.literal("microsoft"), connectionId: id, connectionRevision: date, mailboxAccountId: z.string(), mailboxEmail: z.email(), connectorId: id, connectorVersion: version, policyVersion: z.literal(1), startedAt: date }).strict();
const snapshot = z.object({ version: z.literal(1), adoptionId: id, adoptionVersion: version, adoptionSha256: digest, adoption: z.object({ leadId: id, contactId: id, importSourceKey: z.string(), externalOpportunityId: z.string(), importedHistory, sourceSha256: digest, operationalSha256: digest, recipient: z.string() }).strict(), permissionRecordId: id, ownerUserId: z.string(), propertyId: id.nullable(), leadCreatedAt: date, sender: z.object({ userId: z.string(), source: z.enum(["lead_assignee", "company_default"]), provider: z.literal("microsoft"), senderEmail: z.email() }).strict(), mailboxIdentity, nurtureMonitoringApproval: z.object({ version, approvedAt: date }).strict() }).strict();
const readiness = z.object({ ready: z.boolean(), reason: z.string().nullable(), nextCheckAt: date.nullable() }).strict();
export const nurtureStateSchema = z.enum(["draft", "approved", "running", "stopped", "finished", "expired"]);
const stepSchema = z.object({ id, stepIndex: z.union([z.literal(1), z.literal(2)]), subject: z.string(), body: z.string(), messageHash: digest, scheduledActionId: id.nullable(), notBefore: date.nullable(), expiresAt: date, claimedAt: date.nullable(), acceptedAt: date.nullable(), state: z.enum(["not_started", "waiting", "ready", "held", "processing", "accepted", "uncertain", "cancelled", "finished"]), reason: z.string().nullable(), executionId: id.nullable(), executionState: z.string().nullable(), parentId: id.nullable(), observedAt: date.nullable(), dispatchStartedAt: date.nullable(), deliveryConfirmed: z.literal(false) }).strict();
export const nurtureDetailSchema = z.object({
  organizationId: id, id, version, state: nurtureStateSchema, payloadSha256: digest, settings: nurtureSettingsSchema, reviewId: id, createdByUserId: z.string(), approvedByUserId: z.string().nullable(), createdAt: date, previewExpiresAt: date, startNotBefore: date, expiresAt: date, approvedAt: date.nullable(), startedAt: date.nullable(), stoppedAt: date.nullable(), stopReason: z.string().nullable(), readiness,
  limits: z.object({ maxRecipients: z.literal(10), steps: z.literal(2), minSpacingHours: z.literal(72), maxLifetimeDays: z.literal(14) }).strict(),
  items: z.array(z.object({ id, leadId: id, contactId: id, propertyId: id.nullable(), ownerUserId: z.string(), recipient: z.email(), snapshot, admittedAt: date.nullable(), stoppedAt: date.nullable(), stopReason: z.string().nullable(), readiness,
    mailboxSync: z.object({ ready: z.boolean(), reason: z.string().nullable(), completedCycleId: id.nullable(), startedAt: date.nullable(), completedAt: date.nullable() }).strict(),
    steps: z.array(stepSchema).length(2), outcomes: z.object({ leadStatus: z.string(), replyIds: z.array(id), taskIds: z.array(id), appointmentIds: z.array(id) }).strict(),
  }).strict()).min(1).max(10),
}).strict();
export const nurtureCommandSchema = z.object({ detail: nurtureDetailSchema, command: z.object({ action: z.enum(["approve", "start", "stop"]), requestId: id.nullable(), replayed: z.boolean(), appliedVersion: version }).strict() }).strict();
export const nurtureListSchema = z.object({ organizationId: id, bucket: z.enum(["attention", "waiting", "history"]), offset: z.number().int().nonnegative(), limit: z.literal(25), hasMore: z.boolean(), items: z.array(z.object({ id, version, state: nurtureStateSchema, payloadSha256: digest, createdAt: date, expiresAt: date, recipientCount: z.number().int().min(1).max(10), acceptedSteps: z.number().int().min(0).max(20), uncertainSteps: z.number().int().min(0).max(20), reason: z.string().nullable(), nextCheckAt: date.nullable() }).strict()).max(25) }).strict();
export type NurtureDetail = z.infer<typeof nurtureDetailSchema>;
export type NurtureDraft = z.infer<typeof nurtureDraftSchema>;
export type NurtureList = z.infer<typeof nurtureListSchema>;
export type NurtureCommand = z.infer<typeof nurtureCommandSchema>;
export type NurtureBucket = NurtureList["bucket"];

/** Parse identity and relationships, not just a response-shaped object. */
export function parseNurtureDetail(raw: unknown, organizationId: string, planId?: string): NurtureDetail {
  const value = nurtureDetailSchema.parse(raw);
  if (value.organizationId !== organizationId || (planId && value.id !== planId) || new Set(value.items.map(item => item.id)).size !== value.items.length || new Set(value.items.map(item => item.leadId)).size !== value.items.length || new Set(value.items.map(item => item.recipient.toLowerCase())).size !== value.items.length || value.items.some(item => item.snapshot.adoption.leadId !== item.leadId || item.snapshot.adoption.contactId !== item.contactId || item.snapshot.ownerUserId !== item.ownerUserId || item.snapshot.propertyId !== item.propertyId || item.snapshot.adoption.recipient.toLowerCase() !== item.recipient.toLowerCase() || item.snapshot.mailboxIdentity.organizationId !== organizationId || item.steps[0].stepIndex !== 1 || item.steps[1].stepIndex !== 2 || item.steps[0].id === item.steps[1].id)) throw new Error("Nurture evidence did not match the current company and exact plan. Refresh before any decision.");
  return value;
}
const reasons: Record<string, string> = {
  nurture_not_started: "This plan is not started. Exact approval and a separate start are required; saving alone never sends.",
  nurture_not_due: "Waiting for the original eligible step time. No early follow-up is authorized.",
  nurture_quiet_hours: "Waiting for the approved sending window and the company's stricter quiet hours.",
  nurture_company_limit: "The reviewed company contact allowance is already occupied. No extra slot or replacement key is created.",
  nurture_microsoft_mailbox_required: "The selected sender must be the same connected Microsoft mailbox with separately approved nurture reply monitoring in Account.",
  nurture_owner_unavailable: "A current, accepted office owner is required. Review the lead's actual assignment before preparing a new plan.",
  nurture_owner_or_stage_changed: "The accountable owner or lead stage changed. This frozen review no longer authorizes a new send.",
  nurture_source_changed: "Current source facts or source approval no longer match this review. Review the original source; do not clone an existing send.",
  nurture_appointment_booked: "An appointment is already recorded for this lead. Remaining unclaimed follow-up is held; this is not a new booking.",
  nurture_predecessor_not_accepted: "Email one has no actual retained provider acceptance. Email two cannot advance from an unknown result or an operator attestation.",
  nurture_predecessor_observation_required: "The original first email has not been observed in the selected mailbox's Sent Items. Email two remains held.",
  nurture_unknown_original_effect: "The original send outcome is unknown. Reconcile its retained receipt; do not retry, clone or advance to email two.",
  nurture_original_effect_owned: "The original execution already owns this message. Its receipt cannot be replaced to retry it.",
  nurture_original_effect_requires_review: "An original execution requires office reconciliation. No new send or replacement key is authorized.",
  nurture_review_expired_or_changed: "This ten-minute actor-bound review expired or changed. Refresh the saved evidence and prepare a new review only if still eligible.",
  nurture_dates_invalid: "Choose a future start, more than 72 hours before expiry, and an expiry within 14 days and all source approvals.",
  source_review_expires_first: "A selected source approval expires before this plan. Shorten the plan or independently re-review that source first.",
  mailbox_sync_incomplete: "Both Sent Items and Inbox must finish the same bounded check before email two can advance.",
  mailbox_sync_in_progress: "The required bounded mailbox check is still in progress; partial pages are not complete evidence.",
  mailbox_sync_failed: "A mailbox check failed. The office must review continuity; a successful earlier page is insufficient.",
  mailbox_sync_stale: "The complete mailbox check is older than five minutes. Email two remains held until a fresh check completes.",
  mailbox_sync_predates_predecessor: "The completed check predates email one's acceptance or exact Sent Items observation. A later complete check is required.",
  mailbox_sync_receipts_unresolved: "Unresolved original-mailbox observations need review. Their absence from a confirmed reply list does not authorize sending.",
  mailbox_sync_continuity_warmup: "Waiting for a complete continuous mailbox cycle. New opt-in does not fill old gaps.",
  source_touch_reserved: "This opportunity or address already owns its original outreach. A new plan cannot release or retry it.",
  source_review_required: "Current source-management approval is missing, expired or changed. Review it separately above.",
  email_marketing_permission_required: "Record independent permission for this exact email address. Source adoption does not grant permission.",
  nurture_monitoring_disabled: "The selected Microsoft mailbox needs separate nurture reply permission in Account.",
  mailbox_scan_incomplete: "Sent Items and Inbox have not both completed the required bounded check.",
  nurture_sync_stale: "The complete mailbox check is no longer fresh enough. Step two remains held.",
  quiet_hours: "Waiting for an allowed sending window; no new send has been claimed.",
  frequency_cap: "Waiting for the current contact-frequency allowance; no new send has been claimed.",
  environment_outbound_hold: "Outbound sending is held in this environment. Saved approval is not delivery readiness.",
  capability_unavailable: "This company's current agreed scope does not include nurture execution.",
};
export const nurtureReason = (reason: string | null) => reason ? reasons[reason] ?? reason.replaceAll("_", " ") : "No additional hold reported; all guards are rechecked before dispatch.";
export const nurtureStepLabel = (state: NurtureDetail["items"][number]["steps"][number]["state"]) => ({ not_started: "Not started", waiting: "Waiting — no send confirmed", ready: "Eligible for processing — not sent", held: "Held — office review required", processing: "Original dispatch in progress — do not resend", accepted: "Provider accepted — delivery unconfirmed", uncertain: "Unknown result — do not retry or advance", cancelled: "Cancelled — retained original evidence", finished: "Finished — inspect original receipt" })[state];
