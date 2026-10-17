import { z } from "zod/v4";
import { callieReceptionEvidenceSchema, callieReceptionPreviewSchema, callieReceptionViewSchema } from "../../../api-server/src/services/callie-reception-contract";
import { callieBookingOutcomeSchema, callieBookingSchema, callieSchedulingContextQuerySchema, callieSchedulingContextReadSchema, type CallieBooking, type CallieSchedulingContextQuery } from "../../../api-server/src/services/callie-office-contract";

const uuid = z.uuid(), date = z.iso.datetime(), hash = z.string().regex(/^[a-f0-9]{64}$/);
const member = z.string().min(1).max(128), label = z.string().max(1000), reason = z.string().max(160);
const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const settingsSchema = z.object({ enabled: z.boolean(), timezone: z.string().min(1).max(80), days: z.array(z.number().int().min(1).max(7)).min(1).max(7), opensAt: clock, closesAt: clock, businessHoursOwnerId: member.nullable(), afterHoursOwnerId: member.nullable(), responseMinutes: z.number().int().min(5).max(1440) }).strict();
const snapshotSchema = settingsSchema.extend({ templateVersion: z.literal("callie-intake.v1"), prompts: z.object({ service: label, request: label, window: label, disclosure: label, consent: label, instructions: label }).strict(), acknowledgmentBody: label, binding: z.object({ id: uuid, accountSid: z.string().regex(/^AC[a-f0-9]{32}$/i), sender: z.string().regex(/^\+1[2-9]\d{9}$/), messagingServiceSid: z.string().regex(/^MG[a-f0-9]{32}$/i), disclosureVersion: label, origin: z.url(), businessName: label }).strict().nullable() }).strict();
export const calliePolicySchema = z.object({ version: z.number().int().nonnegative(), revisionId: uuid.nullable(), policy: settingsSchema, snapshot: snapshotSchema, approvedAt: date.nullable(), readiness: z.object({ ready: z.boolean(), reason: reason.nullable() }).strict(), automaticUnknownCallerEnrollment: z.literal(false), callerInitiatedOneCallAcknowledgmentOnly: z.literal(true) }).strict();
const policyPreviewSchema = z.object({ expectedVersion: z.number().int().nonnegative(), expectedSnapshot: z.object({ schemaVersion: z.literal("callie-policy-preview.v1"), organizationId: uuid, actorUserId: member, reviewId: uuid, expectedVersion: z.number().int().nonnegative(), issuedAt: date, expiresAt: date, policy: snapshotSchema }).strict(), previewHash: hash, expiresAt: date }).strict();
const itemSchema = z.object({
  id: uuid, organizationId: uuid, mode: z.enum(["keypad", "conversation"]), callId: uuid, version: z.number().int().positive(),
  state: z.enum(["admitted", "collecting", "awaiting_sms", "confirmed", "deferred", "dispatching", "accepted", "blocked", "indeterminate", "resolved", "cancelled", "booked", "office_pending"]),
  stage: z.enum(["admitted", "service", "request", "window", "consent", "complete"]), reason, phone: z.string().min(1).max(40), createdAt: date, dueAt: date, overdue: z.boolean(),
  owner: z.object({ id: member, label, eligible: z.boolean() }).strict(), task: z.object({ id: uuid, status: z.enum(["open", "in_progress", "done", "cancelled"]) }).strict(), leadId: uuid.nullable(), callerReviewed: z.boolean(),
  serviceIntent: z.enum(["repair", "replacement", "maintenance", "other"]).nullable(), requestIntent: z.enum(["callback", "visit"]).nullable(), callbackWindow: z.enum(["morning", "afternoon", "any"]).nullable(),
  smsProof: z.enum(["single_call_confirmed", "confirmation_expired", "awaiting_caller_confirmation", "not_confirmed"]), confirmedAt: date.nullable(), appointmentId: uuid.nullable(),
}).strict();
const pageSchema = z.object({ scope: z.enum(["attention", "waiting", "history"]), offset: z.number().int().nonnegative(), pageSize: z.literal(25), hasMore: z.boolean(), items: z.array(itemSchema).max(25), companyHeld: z.boolean(), boundary: label }).strict();
const detailSchema = itemSchema.extend({ expectedFingerprint: hash, companyHeld: z.boolean(), timezone: z.string().min(1).max(80), identityReviewed: z.boolean(), contact: z.object({ id: uuid, name: label, phone: z.string().max(100).nullable() }).strict().nullable(), reviewedAt: date.nullable(),
  bookingOptions: z.object({ complete: z.boolean(), properties: z.array(z.object({ id: uuid, label }).strict()).max(100), staff: z.array(z.object({ id: member, label }).strict()).max(200) }).strict(),
  appointment: z.object({ id: uuid, status: reason, scheduledStart: date, scheduledEnd: date.nullable(), assignedUserId: member.nullable() }).strict().nullable(), delivery: z.object({ status: reason, providerSid: z.string().max(128).nullable(), updatedAt: date }).strict().nullable(), execution: z.object({ id: uuid, state: reason }).strict().nullable(),
  actions: z.object({ canReviewCaller: z.boolean(), canAssign: z.boolean(), canClose: z.boolean(), canBook: z.boolean(), blockReason: reason.nullable() }).strict(), evidence: z.literal("caller_choices_are_requests_not_identity_or_confirmed_appointments"), reception: callieReceptionEvidenceSchema.nullable(),
}).strict();
export type CallieSettings = z.infer<typeof settingsSchema>;
export type CallieSnapshot = z.infer<typeof snapshotSchema>;
export type CalliePolicy = z.infer<typeof calliePolicySchema>;
export type CalliePolicyPreview = z.infer<typeof policyPreviewSchema>;
export type CallieItem = z.infer<typeof itemSchema>;
export type CalliePage = z.infer<typeof pageSchema>;
export type CallieDetail = z.infer<typeof detailSchema>;
function validModeEvidence(value: CallieItem) {
  if (value.mode === "keypad") return value.state !== "office_pending";
  return ["admitted", "office_pending", "blocked", "resolved", "cancelled", "booked"].includes(value.state) && ["admitted", "complete"].includes(value.stage) && value.smsProof === "not_confirmed" && value.confirmedAt === null;
}
export const calliePageFor = (org: string, scope: string, offset: number) => pageSchema.refine(value => value.scope === scope && value.offset === offset && value.items.every(item => item.organizationId === org && validModeEvidence(item)));
export const callieDetailFor = (org: string, id: string) => detailSchema.refine(value => value.organizationId === org && value.id === id && validModeEvidence(value) && (!value.appointment || value.appointment.id === value.appointmentId) && (value.mode === "conversation" ? value.delivery === null && value.execution === null : value.reception === null));
export const callieCommandFor = (org: string, id: string) => z.object({ detail: callieDetailFor(org, id), replayed: z.boolean() }).strict();
/** Match original command custody, never a freshly refreshed case or actor. */
export function callieBookingFor(org: string, actor: string, id: string, originalParsedBody: CallieBooking, originalRequestFingerprint: string) {
  const original = callieBookingSchema.parse(originalParsedBody), fingerprint = hash.parse(originalRequestFingerprint);
  return z.object({ detail: callieDetailFor(org, id).nullable(), replayed: z.boolean(), bookingOutcome: callieBookingOutcomeSchema }).strict().refine(value => {
    const outcome = value.bookingOutcome;
    return outcome.organizationId === org && outcome.actorUserId === actor && outcome.intakeId === id && outcome.requestId === original.requestId && outcome.requestFingerprint === fingerprint &&
      outcome.expectedVersion === original.expectedVersion && outcome.expectedFingerprint === original.expectedFingerprint && outcome.customerConfirmed === original.customerConfirmed &&
      (!value.detail || value.detail.appointmentId === outcome.appointmentId && value.detail.appointment?.id === outcome.appointmentId) && (value.replayed || value.detail !== null);
  });
}
export function callieSchedulingContextFor(org: string, actor: string, id: string, selected: CallieSchedulingContextQuery) {
  const query = callieSchedulingContextQuerySchema.parse(selected);
  return callieSchedulingContextReadSchema.refine(value => value.organizationId === org && value.actorUserId === actor && value.intakeId === id && value.appointmentType === query.appointmentType &&
    (value.source === null || value.source.propertyId === (query.propertyId ?? null)));
}
export const receptionViewFor = (org: string) => callieReceptionViewSchema.refine(value => value.organizationId === org);
export const samePolicyFields = (saved: object, draft: object) => Object.entries(draft).every(([key, value]) => JSON.stringify((saved as Record<string, unknown>)[key]) === JSON.stringify(value));
export const policyPreviewFor = (org: string, actor: string, version: number, policy: CallieSettings) => policyPreviewSchema.refine(value => value.expectedVersion === version && value.expectedSnapshot.expectedVersion === version && value.expectedSnapshot.organizationId === org && value.expectedSnapshot.actorUserId === actor && value.expiresAt === value.expectedSnapshot.expiresAt && samePolicyFields(value.expectedSnapshot.policy, policy));
export const receptionPreviewFor = (org: string, actor: string, version: number, policy: object) => callieReceptionPreviewSchema.refine(value => value.organizationId === org && value.expectedSnapshot.organizationId === org && value.expectedSnapshot.actorUserId === actor && value.expectedVersion === version && value.expectedSnapshot.expectedVersion === version && value.expiresAt === value.expectedSnapshot.expiresAt && samePolicyFields(value.expectedSnapshot.policy, policy));
export const callieField = "mt-1 block min-h-11 w-full min-w-0 rounded-lg border bg-background p-2 text-base";
export const callieButton = "min-h-11 rounded-lg border px-3 py-2 text-sm font-medium disabled:opacity-50";
const labels: Record<string, string> = {
  office_pending: "Office response needed", off: "Off", setup_incomplete: "Setup incomplete", approved_but_held: "Approved but held", approved_for_future_eligible_calls: "Approved for future eligible calls",
  reception_binding_identity_required: "Setup incomplete: the reviewed company voice line and agent identities are required.",
  reception_policy_disabled_or_revised: "Conversational reception is off or its approval has changed.",
  reception_binding_changed: "The reviewed phone or agent binding changed. Prepare a fresh exact policy review.",
  reception_provider_not_approved: "The company voice line or reception binding has not been approved for use.",
  reception_credentials_unavailable: "Provider credentials or webhook signing are not installed. Owner setup is still required.",
  reception_configuration_not_verified: "The installed agent configuration has not been verified against the reviewed version.",
  reception_storage_unavailable: "Protected caller-content storage is not configured. Reception remains held.",
  stale_binding: "Another person changed the agent connection. Refresh setup and review it again.",
  invalid_or_expired_preview: "The exact preview expired or changed. Prepare a fresh review.",
  transfer_loop: "This handoff number could route back to the caller or company line. Review a safe staff target.",
  request_changed: "The saved action no longer matches this review. Refresh before another action.",
  admitted: "Waiting for call outcome", collecting: "Caller intake in progress", awaiting_sms: "Waiting for caller's text confirmation", confirmed: "Single-call acknowledgment ready", deferred: "Waiting for an allowed sending window", dispatching: "Provider handoff in progress — do not resend", accepted: "Provider accepted — delivery unconfirmed", blocked: "Office attention required", indeterminate: "Unknown send result — do not resend", resolved: "Handled by staff", cancelled: "CALLIE stopped — callback task retained", booked: "Office-confirmed appointment",
  single_call_confirmed: "Single-call text confirmation received", confirmation_expired: "Text confirmation expired — no new send", awaiting_caller_confirmation: "Caller asked for text instructions — confirmation pending", not_confirmed: "No single-call text permission confirmed",
  owner_review_required: "The callback task owner changed or is unavailable. Explicitly assign this CALLIE request before reviewing the caller, booking or closing it.",
  owner_changed_office_only: "Owner reassigned — automated acknowledgment held", provider_reconciliation_required: "An owner must reconcile the original send before closing or booking this request.", dispatch_in_progress: "Wait for the saved provider result before changing this request.", company_held: "Company work is on hold.", office_work_closed: "This office request is closed.", stale_review: "The call, customer, staff or saved request changed. Refresh and review again.", policy_disabled_or_revised: "Standing recovery is disabled or its approval changed.", provider_not_approved: "The company voice/SMS provider still needs approval.", environment_outbound_hold: "Outbound sending is held in this environment.", binding_identity_required: "The actual company phone and messaging program must be configured before enabling standing recovery.", owner_unavailable: "Choose accepted active staff for both owner roles.", stale_policy: "Another person changed this policy. Refresh and review it again.", stale_policy_preview: "This policy preview expired or changed. Prepare a fresh preview.", customer_lifecycle_paused: "Company work is on hold.", binding_changed: "The configured company phone or program changed. Review a fresh policy.", policy_approver_unavailable: "The policy approver no longer has active owner/admin access.", preview_signing_unavailable: "Policy approval is unavailable until the application's secure signing setup is complete.",
};
export const callieLabel = (value: string) => labels[value] ?? value.replaceAll("_", " ");
export const requestLabel = (item: { requestIntent: string | null; appointmentId: string | null }) => item.appointmentId ? "Office-confirmed appointment recorded" : item.requestIntent === "visit" ? "Visit requested — not booked" : item.requestIntent === "callback" ? "Callback requested" : "Incomplete caller request";
export async function callieRequest<T>(schema: z.ZodType<T>, suffix: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api/v1/communications/callie${suffix}`, { credentials: "include", signal, ...(body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) });
  const result = await response.json();
  if (!response.ok) throw new Error(typeof result?.code === "string" && /^[a-z0-9_]{1,120}$/.test(result.code) ? callieLabel(result.code) : "CALLIE result could not be confirmed.");
  const parsed = schema.safeParse(result);
  if (!parsed.success) throw new Error("CALLIE returned an unverified or mismatched response. Refresh before taking action.");
  return parsed.data;
}
