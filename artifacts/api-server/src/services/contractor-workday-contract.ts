import { z } from "zod/v4";

/** Browser/code-generation safe: no database, environment, crypto or provider imports. */
export class WorkdayError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
const id = z.uuid(), instant = z.iso.datetime(), version = z.number().int().min(1);
const note = z.string().trim().min(1).max(2000);
const short = z.string().trim().min(1).max(160);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v => {
  const d = new Date(`${v}T12:00:00Z`); return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === v;
});
export const workdayActingFields = { actingNote: z.string().trim().min(1).max(500).optional() };
export const workdayItemSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/), label: z.string().trim().min(1).max(200),
  kind: z.enum(["result", "text", "number", "photo"]), required: z.boolean(),
  allowNotApplicable: z.boolean(), unit: z.string().trim().min(1).max(30).nullable(),
}).strict().refine(v => v.kind === "number" ? v.unit !== null : v.unit === null, { message: "Only numeric observations require a reviewed unit." });
export const workdayDefinitionSchema = z.object({
  name: z.string().trim().min(1).max(120), trade: z.enum(["hvac", "roofing", "general"]),
  description: z.string().trim().max(1000), items: z.array(workdayItemSchema).min(1).max(50),
}).strict().refine(v => new Set(v.items.map(i => i.key)).size === v.items.length, { message: "Item keys must be unique." });
export type WorkdayDefinition = z.infer<typeof workdayDefinitionSchema>;
export const workdayStarterSchema = z.object({ id: z.string(), version: z.literal(1), title: z.string(), description: z.string(), sourceUrls: z.array(z.url({ protocol: /^https$/ })), definition: workdayDefinitionSchema }).strict();
const attributes = z.array(z.object({ label: z.string().trim().min(1).max(80), value: z.string().trim().min(1).max(300) }).strict()).max(20);
export const workdayAssetFields = {
  category: z.enum(["hvac_equipment", "roof_system", "other"]), label: short,
  manufacturer: z.string().trim().max(160).nullable(), model: z.string().trim().max(160).nullable(), serial: z.string().trim().max(160).nullable(),
  location: z.string().trim().max(300).nullable(), installedOn: date.nullable(), notes: z.string().trim().max(2000).nullable(),
  warrantyStartsOn: date.nullable(), warrantyEndsOn: date.nullable(), warrantySource: z.string().trim().max(1000).nullable(), attributes,
};
const assetContent = z.object(workdayAssetFields).strict();
export const createWorkdayAssetSchema = assetContent.extend({ requestId: id, propertyId: id }).strict();
export const updateWorkdayAssetSchema = assetContent.extend({ requestId: id, expectedVersion: version, status: z.enum(["active", "retired"]) }).strict();
export const workdayAssetSchema = assetContent.extend({
  id, organizationId: id, contactId: id, propertyId: id, version, status: z.enum(["active", "retired"]),
  createdAt: instant, updatedAt: instant, currentParentCoherent: z.boolean(), canEdit: z.boolean(),
}).strict();
export type WorkdayAsset = z.infer<typeof workdayAssetSchema>;
export const workdayAssetPageSchema = z.object({ organizationId: id, contactId: id, propertyId: id.nullable(), items: z.array(workdayAssetSchema).max(25), nextCursor: z.string().nullable(), hasMore: z.boolean(), limit: z.literal(25), canCreate: z.boolean() }).strict();
export const workdayAssetQuerySchema = z.object({ propertyId: id.optional(), cursor: z.string().max(1000).optional() }).strict();
export const workdayRevisionSchema = z.object({ id, templateId: id, version, definition: workdayDefinitionSchema, definitionSha256: z.string().regex(/^[a-f0-9]{64}$/), baselineId: z.string().nullable(), baselineVersion: z.number().int().nullable(), createdAt: instant, createdByUserId: z.string(), reviewedAt: instant.nullable(), reviewedByUserId: z.string().nullable() }).strict();
export const workdayTemplateSchema = z.object({ id, organizationId: id, version, status: z.enum(["draft", "reviewed", "retired"]), latestRevision: workdayRevisionSchema, approvedRevision: workdayRevisionSchema.nullable(), createdAt: instant, updatedAt: instant }).strict();
export type WorkdayTemplate = z.infer<typeof workdayTemplateSchema>;
export const workdayTemplateCatalogSchema = z.object({ organizationId: id, templates: z.array(workdayTemplateSchema).max(100), starters: z.array(workdayStarterSchema), canManage: z.boolean(), limit: z.literal(100), limitReached: z.boolean() }).strict();
export const createWorkdayTemplateSchema = z.object({ requestId: id, definition: workdayDefinitionSchema, baselineId: z.string().max(100).nullable().optional() }).strict();
export const reviseWorkdayTemplateSchema = z.object({ requestId: id, expectedVersion: version, definition: workdayDefinitionSchema }).strict();
export const previewWorkdayTemplateSchema = z.object({ expectedVersion: version, revisionId: id }).strict();
export const approveWorkdayTemplateSchema = z.object({ requestId: id, previewToken: z.string().min(1).max(10000), confirmed: z.literal(true) }).strict();
export const retireWorkdayTemplateSchema = z.object({ requestId: id, expectedVersion: version, reason: note, confirmed: z.literal(true) }).strict();
export const workdayTemplatePreviewSchema = z.object({ organizationId: id, templateId: id, expectedVersion: version, revision: workdayRevisionSchema, expiresAt: instant, previewToken: z.string() }).strict();
export const workdayAnswerSchema = z.object({ itemKey: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/), result: z.enum(["done", "needs_attention", "not_applicable"]), value: z.union([z.string().max(2000), z.number().finite()]).nullable(), reason: z.string().trim().max(1000).nullable() }).strict();
export type WorkdayAnswer = z.infer<typeof workdayAnswerSchema>;
export const createWorkdayEntrySchema = z.object({ requestId: id, expectedAppointmentUpdatedAt: instant, checklistRevisionId: id, assetId: id.nullable(), serviceObligationId: id.nullable(), ...workdayActingFields }).strict();
export const saveWorkdayEntrySchema = z.object({ requestId: id, expectedVersion: version, answers: z.array(workdayAnswerSchema).max(50), notes: z.string().trim().max(2000), ...workdayActingFields }).strict();
export const cancelWorkdayEntrySchema = z.object({ requestId: id, expectedVersion: version, reason: note, ...workdayActingFields }).strict();
export const workdayPhotoSchema = z.object({ id, entryId: id, itemKey: z.string().nullable(), caption: z.string(), state: z.enum(["reserved", "attached", "expired"]), contentType: z.enum(["image/jpeg", "image/png", "image/webp"]), sizeBytes: z.number().int().min(1).max(10485760), expiresAt: instant, attachedAt: instant.nullable(), contentPath: z.string().nullable(), available: z.boolean() }).strict();
export const requestWorkdayPhotoSchema = z.object({ requestId: id, expectedVersion: version, contentType: z.enum(["image/jpeg", "image/png", "image/webp"]), sizeBytes: z.number().int().min(1).max(10485760), itemKey: z.string().max(40).nullable(), caption: z.string().trim().max(500), ...workdayActingFields }).strict();
export const attachWorkdayPhotoSchema = z.object({ requestId: id, expectedVersion: version, photoId: id, ...workdayActingFields }).strict();
export const workdayEntrySchema = z.object({
  id, appointmentId: id, contactId: id, propertyId: id.nullable(), assetId: id.nullable(), serviceObligationId: id.nullable(),
  version, state: z.enum(["draft", "cancelled", "finalized"]), checklist: workdayRevisionSchema,
  assetSnapshot: assetContent.extend({ id, version }).strict().nullable(), answers: z.array(workdayAnswerSchema), notes: z.string(),
  photos: z.array(workdayPhotoSchema).max(50), completionId: id.nullable(), createdAt: instant, updatedAt: instant,
  holdReasons: z.array(z.string()),
}).strict();
export type WorkdayEntry = z.infer<typeof workdayEntrySchema>;
const followup = z.object({ assignedUserId: z.string().min(1).max(200), dueAt: instant, note }).strict();
export const previewWorkdayCompletionSchema = z.object({
  expectedAppointmentUpdatedAt: instant, entries: z.array(z.object({ id, version }).strict()).min(1).max(20),
  serviceObligationIds: z.array(id).max(20), performedAt: instant, summary: note,
  outcome: z.enum(["completed", "needs_followup"]), followup: followup.nullable(), ...workdayActingFields,
}).strict();
export const completeWorkdaySchema = z.object({ requestId: id, previewToken: z.string().min(1).max(30000), confirmed: z.literal(true) }).strict();
export const correctWorkdaySchema = z.object({ requestId: id, note, ...workdayActingFields }).strict();
export const workdayCompletionSchema = z.object({ id, appointmentId: id, contactId: id, propertyId: id.nullable(), requestId: id, performedAt: instant, recordedAt: instant, recordedByUserId: z.string(), performerUserId: z.string(), actingNote: z.string().nullable(), summary: z.string(), outcome: z.enum(["completed", "needs_followup"]), followupTaskId: id.nullable(), entries: z.array(z.object({ id, version, checklistRevisionId: id, assetId: id.nullable() }).strict()), services: z.array(z.object({ id, nextObligationId: id.nullable() }).strict()), nativeAppointmentStatus: z.literal("completed") }).strict();
export type WorkdayCompletion = z.infer<typeof workdayCompletionSchema>;
export const workdayCorrectionSchema = z.object({ id, originalCompletionId: id, note: z.string(), recordedAt: instant, recordedByUserId: z.string() }).strict();
const visit = z.object({ id, contactId: id.nullable(), propertyId: id.nullable(), leadId: id.nullable(), assignedUserId: z.string().nullable(), status: z.enum(["scheduled", "confirmed", "completed", "cancelled", "no_show"]), type: z.enum(["inspection", "estimate_review", "production", "final_walkthrough", "other"]), scheduledStart: instant, scheduledEnd: instant.nullable(), updatedAt: instant, notes: z.string().nullable(), customerLabel: z.string().nullable(), propertyLabel: z.string().nullable() }).strict();
export const appointmentWorkSchema = z.object({ organizationId: id, appointment: visit, entries: z.array(workdayEntrySchema).max(20), completion: workdayCompletionSchema.nullable(), corrections: z.array(workdayCorrectionSchema).max(25), correctionsHasMore: z.boolean(), linkedServices: z.array(z.object({ id, equipmentLabel: z.string(), status: z.enum(["active", "completed", "cancelled"]), updatedAt: instant }).strict()), capabilities: z.object({ canPrepare: z.boolean(), canEdit: z.boolean(), canCancel: z.boolean(), canComplete: z.boolean(), canCorrect: z.boolean(), requiresActingNote: z.boolean(), reasons: z.array(z.string()) }).strict() }).strict();
export type AppointmentWork = z.infer<typeof appointmentWorkSchema>;
export const workdayCompletionPreviewSchema = z.object({ organizationId: id, appointmentId: id, expiresAt: instant, previewToken: z.string(), entries: z.array(workdayEntrySchema), intent: previewWorkdayCompletionSchema, serviceVersions: z.array(z.object({ id, updatedAt: instant }).strict()), warning: z.literal("Staff-recorded work; not warranty coverage, customer acceptance, invoice delivery or payment.") }).strict();
export const workdayCommandReceiptSchema = z.object({ requestId: id, replayed: z.boolean() }).strict();
export const workdayAssetMutationSchema = z.object({ organizationId: id, asset: workdayAssetSchema, receipt: workdayCommandReceiptSchema }).strict();
export const workdayTemplateMutationSchema = z.object({ organizationId: id, template: workdayTemplateSchema, receipt: workdayCommandReceiptSchema }).strict();
export const workdayMutationSchema = z.object({ organizationId: id, work: appointmentWorkSchema, receipt: workdayCommandReceiptSchema }).strict();
export const workdayPhotoReservationSchema = workdayMutationSchema.extend({ photoId: id, uploadUrl: z.string().nullable(), uploadExpiresAt: instant }).strict();
