import { Temporal } from '@js-temporal/polyfill';
import { z } from 'zod';

/** Wire instants retain their validated RFC3339 spelling for command custody. */
export type ISO = string;
export type UUID = string;
export type UserId = string;

// Pinned to lib/db/src/schema/enums.ts without loading database code in browsers.
export const appointmentTypes = ['inspection', 'estimate_review', 'production', 'final_walkthrough', 'other'] as const;
export const appointmentStatuses = ['scheduled', 'confirmed', 'completed', 'cancelled', 'no_show'] as const;
export const projectStatuses = ['scheduled', 'in_progress', 'on_hold', 'completed', 'cancelled'] as const;
export type AppointmentType = typeof appointmentTypes[number];
export type AppointmentStatus = typeof appointmentStatuses[number];
export type ProjectStatus = typeof projectStatuses[number];

export const uuidSchema = z.uuid().refine(value => value === value.toLowerCase(), 'UUID must be canonical lowercase');
export const userIdSchema = z.string().min(1).max(200).refine(value => value.trim().length > 0, 'Staff ID must be nonblank');
export const isoSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/).refine(value => {
  try {
    // Temporal rejects calendar rollover; explicit offsets are required above.
    Temporal.Instant.from(value);
    return !/:60(?:\.|Z|[+-])/.test(value);
  } catch { return false; }
}, 'Invalid RFC3339 instant');
export const timeZoneSchema = z.string().min(1).refine(value => {
  try { new Intl.DateTimeFormat('en', { timeZone: value }); return !/^[+-]/.test(value); }
  catch { return false; }
}, 'Invalid IANA time zone');
export const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const revisionSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const zeroRevisionSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const gapSchema = z.number().int().min(0).max(1440);
const ceilingSchema = z.number().int().min(1).max(100).nullable();
const labelSchema = z.string().min(1).max(80).refine(value => value.trim().length > 0, 'Label must be nonblank');
const elapsedSchema = z.number().int().min(1).max(1440);

export const durationPresetSchema = z.strictObject({ id: uuidSchema, label: labelSchema, elapsedMinutes: elapsedSchema });
export type DurationPreset = z.infer<typeof durationPresetSchema>;

function uniquePresets(presets: { id: string | null; label: string }[], ctx: z.RefinementCtx) {
  const ids = new Set<string>();
  const labels = new Set<string>();
  for (const [index, preset] of presets.entries()) {
    if (preset.id !== null && ids.has(preset.id)) ctx.addIssue({ code: 'custom', path: [index, 'id'], message: 'Duplicate preset ID' });
    if (labels.has(preset.label.trim())) ctx.addIssue({ code: 'custom', path: [index, 'label'], message: 'Duplicate preset label' });
    if (preset.id !== null) ids.add(preset.id);
    labels.add(preset.label.trim());
  }
}
const presetsSchema = z.array(durationPresetSchema).max(50).superRefine(uniquePresets);
export const schedulingPolicySchema = z.strictObject({
  formatVersion: z.literal(1), revision: revisionSchema, enabled: z.boolean(), timeZone: timeZoneSchema,
  minimumTravelGapMinutes: gapSchema, maxConcurrentReservations: ceilingSchema,
  durationPresets: presetsSchema, digest: digestSchema, updatedAt: isoSchema, updatedByUserId: userIdSchema,
});
export type SchedulingPolicy = z.infer<typeof schedulingPolicySchema>;

export const inspectionContextSchema = z.strictObject({
  ruleTimeZone: timeZoneSchema, availabilityDigest: digestSchema,
  sourceState: z.enum(['recorded', 'legacy_default', 'legacy_normalized']),
});
export type InspectionContext = z.infer<typeof inspectionContextSchema>;
export const manualSourceRefSchema = z.strictObject({
  sourceKind: z.enum(['lead', 'direct_customer', 'unlinked_manual']), leadId: uuidSchema.nullable(),
  contactId: uuidSchema.nullable(), propertyId: uuidSchema.nullable(), estimateId: uuidSchema.nullable(),
}).superRefine((value, ctx) => {
  const valid = value.sourceKind === 'lead' ? value.leadId !== null
    : value.sourceKind === 'direct_customer' ? value.contactId !== null && value.leadId === null
    : value.leadId === null && value.contactId === null && value.propertyId === null && value.estimateId === null;
  if (!valid) ctx.addIssue({ code: 'custom', message: 'Incoherent source lineage' });
});
export type ManualSourceRef = z.infer<typeof manualSourceRefSchema>;
export const schedulingReviewContextSchema = z.strictObject({
  organizationId: uuidSchema, policyRevision: zeroRevisionSchema, policyDigest: digestSchema.nullable(),
  companyTimeZone: timeZoneSchema, inspection: inspectionContextSchema.nullable(),
  applicableRules: z.strictObject({ newTravelGapMinutes: gapSchema, companyCeiling: ceilingSchema, inspectionCeiling: ceilingSchema }),
  source: manualSourceRefSchema.nullable(), targetVersion: isoSchema.nullable(), targetFingerprint: digestSchema.nullable(),
}).superRefine((value, ctx) => {
  if ((value.policyRevision === 0) !== (value.policyDigest === null)) ctx.addIssue({ code: 'custom', message: 'Policy revision/digest must agree' });
  if ((value.targetVersion === null) !== (value.targetFingerprint === null)) ctx.addIssue({ code: 'custom', message: 'Target version/fingerprint must be paired' });
});
export type SchedulingReviewContext = z.infer<typeof schedulingReviewContextSchema>;
export const localDateTimeSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::[0-5]\d(?:\.\d{1,3})?)?$/).refine(value => {
  try { Temporal.PlainDateTime.from(value, { overflow: 'reject' }); return true; }
  catch { return false; }
}, 'Invalid local date and time');
export const wallTimeEvidenceSchema = z.strictObject({
  localDateTime: localDateTimeSchema,
  offset: z.string().regex(/^[+-](?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/),
  timeZone: timeZoneSchema,
});
export type WallTimeEvidence = z.infer<typeof wallTimeEvidenceSchema>;
export const durationChoiceSchema = z.strictObject({
  kind: z.enum(['explicit', 'preserved_interval', 'inspection_interval', 'preset']), preset: durationPresetSchema.nullable(),
}).superRefine((value, ctx) => {
  if ((value.kind === 'preset') !== (value.preset !== null)) ctx.addIssue({ code: 'custom', message: 'Preset choice must include exactly one preset' });
});
export type DurationChoice = z.infer<typeof durationChoiceSchema>;
export const reservationSnapshotSchema = z.strictObject({
  formatVersion: z.literal(1), reservationRevision: revisionSchema,
  sourcePolicyRevision: revisionSchema, sourcePolicyDigest: digestSchema,
  approvedTimeZone: timeZoneSchema, inspection: inspectionContextSchema.nullable(),
  startAt: isoSchema, endAt: isoSchema, resourceUserIds: z.array(userIdSchema),
  minimumTravelGapMinutes: gapSchema, duration: durationChoiceSchema,
  admittedAt: isoSchema, admittedByUserId: userIdSchema.nullable(),
  target: z.strictObject({ kind: z.enum(['appointment', 'project']), id: uuidSchema }),
  lastTransition: z.strictObject({ kind: z.enum(['admission', 'release']), actorUserId: userIdSchema.nullable(), at: isoSchema }),
}).superRefine((value, ctx) => {
  if (isoSchema.safeParse(value.startAt).success && isoSchema.safeParse(value.endAt).success && Temporal.Instant.compare(value.endAt, value.startAt) <= 0) ctx.addIssue({ code: 'custom', path: ['endAt'], message: 'End must follow start' });
});
export type ReservationSnapshot = z.infer<typeof reservationSnapshotSchema>;
export const effectiveReservationSchema = z.strictObject({
  kind: z.enum(['appointment', 'project']), id: uuidSchema, startAt: isoSchema, endAt: isoSchema,
  resourceUserIds: z.array(userIdSchema), savedGapMinutes: gapSchema,
}).superRefine((value, ctx) => {
  if (isoSchema.safeParse(value.startAt).success && isoSchema.safeParse(value.endAt).success && Temporal.Instant.compare(value.endAt, value.startAt) <= 0) ctx.addIssue({ code: 'custom', path: ['endAt'], message: 'End must follow start' });
});
export type EffectiveReservation = z.infer<typeof effectiveReservationSchema>;
export const schedulingCandidateSchema = z.strictObject({
  kind: z.enum(['appointment', 'project']), id: uuidSchema, startAt: isoSchema.nullable(), endAt: isoSchema.nullable(),
  resourceUserIds: z.array(userIdSchema), type: z.string(), status: z.string(),
  source: manualSourceRefSchema, reservation: reservationSnapshotSchema.nullable(),
});
export type SchedulingCandidate = z.infer<typeof schedulingCandidateSchema>;
export const schedulingMutationReviewSchema = z.strictObject({
  context: schedulingReviewContextSchema, duration: durationChoiceSchema,
  startWallTime: wallTimeEvidenceSchema.nullable(), endWallTime: wallTimeEvidenceSchema.nullable(),
});
export type SchedulingMutationReview = z.infer<typeof schedulingMutationReviewSchema>;
export const nativeAppointmentCreateInputSchema = z.strictObject({
  scheduledStart: isoSchema, scheduledEnd: isoSchema.optional(), leadId: uuidSchema.optional(),
  contactId: uuidSchema.optional(), propertyId: uuidSchema.nullable().optional(), assignedUserId: userIdSchema.optional(),
  type: z.enum(appointmentTypes).optional(), status: z.enum(appointmentStatuses).optional(), notes: z.string().optional(),
});
export type NativeAppointmentCreateInput = z.infer<typeof nativeAppointmentCreateInputSchema>;
export const nativeProjectCreateInputSchema = z.strictObject({
  leadId: uuidSchema, name: z.string().min(1), estimateId: uuidSchema.optional(), status: z.enum(projectStatuses).optional(),
  scheduledStart: isoSchema.optional(), scheduledEnd: isoSchema.optional(), crewUserIds: z.array(userIdSchema).optional(), crewNotes: z.string().optional(),
});
export type NativeProjectCreateInput = z.infer<typeof nativeProjectCreateInputSchema>;
export const manualSchedulingCommandSchema = z.discriminatedUnion('kind', [
  z.strictObject({ operationId: uuidSchema, review: schedulingMutationReviewSchema, kind: z.literal('appointment_create'), body: nativeAppointmentCreateInputSchema }),
  z.strictObject({ operationId: uuidSchema, review: schedulingMutationReviewSchema, kind: z.literal('project_create'), body: nativeProjectCreateInputSchema }),
]).superRefine((value, ctx) => {
  if (value.review.context.source === null) ctx.addIssue({ code: 'custom', message: 'Staff command requires reviewed source' });
});
export type ManualSchedulingCommand = z.infer<typeof manualSchedulingCommandSchema>;
export const manualSchedulingAckSchema = z.strictObject({
  operationId: uuidSchema, organizationId: uuidSchema, actorUserId: userIdSchema,
  kind: z.enum(['appointment_create', 'project_create']), source: manualSourceRefSchema, payloadSha256: digestSchema,
  outcome: z.enum(['committed', 'no_commit_refused']),
  target: z.strictObject({ kind: z.enum(['appointment', 'project']), id: uuidSchema, available: z.boolean() }).nullable(),
  refusalCode: z.string().min(1).nullable(),
}).superRefine((value, ctx) => {
  const committed = value.outcome === 'committed';
  if (committed ? value.target === null || value.refusalCode !== null : value.target !== null || value.refusalCode === null) ctx.addIssue({ code: 'custom', message: 'Incoherent terminal outcome' });
  if (value.target && value.target.kind !== (value.kind === 'appointment_create' ? 'appointment' : 'project')) ctx.addIssue({ code: 'custom', message: 'Target kind must match command' });
});
export type ManualSchedulingAck = z.infer<typeof manualSchedulingAckSchema>;
export const policySaveInputSchema = z.strictObject({
  expectedRevision: zeroRevisionSchema, expectedCompanyTimeZone: timeZoneSchema, enabled: z.boolean(),
  minimumTravelGapMinutes: gapSchema, maxConcurrentReservations: ceilingSchema,
  durationPresets: z.array(z.strictObject({ id: uuidSchema.nullable(), label: labelSchema, elapsedMinutes: elapsedSchema })).max(50).superRefine(uniquePresets),
});
export type PolicySaveInput = z.infer<typeof policySaveInputSchema>;
export type PolicyReadResult = { policy: SchedulingPolicy | null; context: SchedulingReviewContext };
