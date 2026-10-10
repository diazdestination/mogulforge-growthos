import { z } from "zod/v4";

export const DETAIL_CORRECTION_ACTION = "customer.details.corrected";
export const DETAIL_CORRECTION_SCHEMA_VERSION = "customer-detail-correction.v1";
export const DETAIL_CORRECTION_FIELDS = ["firstName", "lastName", "email", "phone", "property.addressLine1", "property.addressLine2", "property.city", "property.state", "property.postalCode"] as const;
export type DetailCorrectionChangedField = typeof DETAIL_CORRECTION_FIELDS[number];

export type DetailCorrectionErrorCode = "detail_correction_invalid_request" | "detail_correction_access_denied" | "detail_correction_contact_not_found" | "detail_correction_property_not_found" | "detail_correction_property_parent_changed" | "detail_correction_stale_version" | "detail_correction_request_conflict" | "detail_correction_snapshot_unavailable" | "detail_correction_receipt_unavailable";
export class DetailCorrectionError extends Error {
  constructor(readonly status: number, readonly code: DetailCorrectionErrorCode) {
    super({ detail_correction_invalid_request: "Review the allowed customer details and exact saved version.", detail_correction_access_denied: "An active, accepted office, admin or owner staff session is required.", detail_correction_contact_not_found: "Customer not found in this company.", detail_correction_property_not_found: "Selected property not found in this company.", detail_correction_property_parent_changed: "The selected property's customer changed. Refresh before continuing.", detail_correction_stale_version: "These details changed. Refresh and review before saving.", detail_correction_request_conflict: "This request ID already belongs to different saved work.", detail_correction_snapshot_unavailable: "Customer detail evidence is unavailable. No correction was saved.", detail_correction_receipt_unavailable: "The original correction receipt needs review. Do not resave blindly." }[code]);
  }
}

export const detailCorrectionIdSchema = z.uuid().transform(value => value.toLowerCase());
const digest = z.string().length(64).regex(/^[a-f0-9]{64}$/);
const instant = z.iso.datetime({ offset: true }).transform(value => new Date(value).toISOString());
const noControls = (value: string) => !/[\x00-\x1f\x7f]/.test(value);
const suppliedText = (max: number) => z.string().max(max + 256).refine(noControls, "Control characters are not allowed.").transform(value => value.trim()).pipe(z.string().min(1).max(max));
const clearableText = (max: number) => z.union([z.string().max(max + 256).refine(noControls, "Control characters are not allowed.").transform(value => value.trim() || null), z.null()]).pipe(z.string().max(max).nullable());
const email = clearableText(320).refine(value => value === null || z.email().safeParse(value).success, "Use a valid email address.");
const phone = clearableText(64).refine(value => value === null || (/^(?:\+?[0-9(][0-9 ().-]*[0-9])(?:\s*(?:x|ext\.?)\s*\d{1,8})?$/i.test(value) && (value.match(/\d/g)?.length ?? 0) >= 5 && (value.match(/\d/g)?.length ?? 0) <= 23), "Use a bounded phone number; its supplied country/format is preserved.");

export const detailCorrectionVersionSchema = z.object({ contactUpdatedAt: instant, propertyUpdatedAt: instant.nullable(), fingerprint: digest }).strict();
const propertyChanges = z.object({ addressLine1: suppliedText(300).optional(), addressLine2: clearableText(300).optional(), city: suppliedText(128).optional(), state: suppliedText(128).optional(), postalCode: suppliedText(32).optional() }).strict().refine(value => Object.values(value).some(item => item !== undefined), "Supply at least one address field.");
export const detailCorrectionChangesSchema = z.object({ firstName: suppliedText(128).optional(), lastName: clearableText(128).optional(), email: email.optional(), phone: phone.optional(), property: propertyChanges.optional() }).strict().refine(value => Object.values(value).some(item => item !== undefined), "Supply at least one customer detail.");
export const detailCorrectionInputSchema = z.object({ requestId: detailCorrectionIdSchema, propertyId: detailCorrectionIdSchema.nullable(), expectedVersion: detailCorrectionVersionSchema, changes: detailCorrectionChangesSchema }).strict().superRefine((value, context) => {
  if ((value.propertyId === null) !== (value.expectedVersion.propertyUpdatedAt === null)) context.addIssue({ code: "custom", path: ["expectedVersion", "propertyUpdatedAt"], message: "The exact selected property and version must agree." });
  if (value.propertyId === null && value.changes.property !== undefined) context.addIssue({ code: "custom", path: ["changes", "property"], message: "Explicitly choose the property before correcting its address." });
});
export type DetailCorrectionInput = z.output<typeof detailCorrectionInputSchema>;

// Existing values are preserved verbatim, not normalized by the correction input
// validators. The bound refuses oversized legacy evidence instead of truncating it.
const storedText = z.string().max(4096);
export const customerDetailSnapshotSchema = z.object({ organizationId: detailCorrectionIdSchema, contactId: detailCorrectionIdSchema, propertyId: detailCorrectionIdSchema.nullable(), details: z.object({ firstName: storedText, lastName: storedText.nullable(), email: storedText.nullable(), phone: storedText.nullable(), property: z.object({ addressLine1: storedText, addressLine2: storedText.nullable(), city: storedText, state: storedText, postalCode: storedText }).strict().nullable() }).strict(), version: detailCorrectionVersionSchema }).strict().refine(value => (value.propertyId === null) === (value.details.property === null) && (value.propertyId === null) === (value.version.propertyUpdatedAt === null), "Snapshot property binding is inconsistent.");
export type CustomerDetailSnapshot = z.output<typeof customerDetailSnapshotSchema>;
const changedFields = z.array(z.enum(DETAIL_CORRECTION_FIELDS)).max(DETAIL_CORRECTION_FIELDS.length).refine(value => new Set(value).size === value.length);
export const customerDetailCorrectionReceiptSchema = z.object({ requestId: detailCorrectionIdSchema, status: z.enum(["saved", "unchanged"]), committedAt: instant, changedFields, snapshot: customerDetailSnapshotSchema }).strict().refine(value => (value.status === "saved") === (value.changedFields.length > 0));
export type CustomerDetailCorrectionReceipt = z.output<typeof customerDetailCorrectionReceiptSchema>;
export const detailCorrectionAuditMetadataSchema = z.object({ schemaVersion: z.literal(DETAIL_CORRECTION_SCHEMA_VERSION), requestDigest: digest, propertyId: detailCorrectionIdSchema.nullable(), before: customerDetailSnapshotSchema, after: customerDetailSnapshotSchema, changedFields, status: z.enum(["saved", "unchanged"]), committedAt: instant }).strict().refine(value => value.before.organizationId === value.after.organizationId && value.before.contactId === value.after.contactId && value.before.propertyId === value.propertyId && value.after.propertyId === value.propertyId && (value.status === "saved") === (value.changedFields.length > 0));

/** Stable allowed-field order; spelling/JSON key order is not a new command. */
export function canonicalDetailCorrectionPayload(organizationId: string, contactId: string, actorUserId: string, input: DetailCorrectionInput): string {
  const changes: Record<string, unknown> = {};
  for (const field of ["firstName", "lastName", "email", "phone"] as const) if (input.changes[field] !== undefined) changes[field] = input.changes[field];
  if (input.changes.property !== undefined) {
    const property: Record<string, unknown> = {};
    for (const field of ["addressLine1", "addressLine2", "city", "state", "postalCode"] as const) if (input.changes.property[field] !== undefined) property[field] = input.changes.property[field];
    changes.property = property;
  }
  return JSON.stringify({ schemaVersion: DETAIL_CORRECTION_SCHEMA_VERSION, organizationId, contactId, actorUserId, requestId: input.requestId, propertyId: input.propertyId, expectedVersion: { contactUpdatedAt: input.expectedVersion.contactUpdatedAt, propertyUpdatedAt: input.expectedVersion.propertyUpdatedAt, fingerprint: input.expectedVersion.fingerprint }, changes });
}

export const detailCorrectionReceiptSchema = customerDetailCorrectionReceiptSchema;
export type DetailCorrectionReceipt = CustomerDetailCorrectionReceipt;
export const detailCorrectionSaveResultSchema = z.object({ receipt: detailCorrectionReceiptSchema, replayed: z.boolean() }).strict();
export type DetailCorrectionSaveResult = z.output<typeof detailCorrectionSaveResultSchema>;
