import { z } from "zod/v4";

/** Browser/codegen safe. Native records remain the only work and billing state. */
export class CustomerWorkError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
const id = z.uuid(), instant = z.iso.datetime(), version = z.number().int().min(1).max(2_147_483_646);
const text = (max: number) => z.string().trim().min(1).max(max);
const cents = z.number().int().min(0).max(1_000_000_000);
export const existingCustomerSourceSchema = z.object({ kind: z.literal("existing_customer"), contactId: id, propertyId: id.nullable() }).strict();
export const customerWorkSourceSchema = z.object({ kind: z.literal("customer_work"), customerWorkId: id }).strict();
export const acceptedEstimateSourceSchema = z.object({ kind: z.literal("estimate"), estimateId: id, expectedWorkVersion: version }).strict();
export const customerWorkLineItemInputSchema = z.object({ description: text(1000), quantity: z.number().positive().max(999999).refine(v => /^\d+(?:\.\d{1,3})?$/.test(String(v)), "Use at most three decimal places."), unitPriceCents: cents }).strict();
const estimateFields = { title: text(150), lineItems: z.array(customerWorkLineItemInputSchema).max(100), taxCents: cents, notes: z.string().trim().max(2000).nullable() };
export const createCustomerWorkEstimateSchema = z.object({ requestId: id, confirmed: z.literal(true), source: existingCustomerSourceSchema, ...estimateFields }).strict();
export const updateCustomerWorkEstimateSchema = z.object({ requestId: id, confirmed: z.literal(true), expectedWorkVersion: version, ...estimateFields, status: z.enum(["draft", "sent", "accepted", "declined"]) }).strict();
const projectFields = { name: text(200), status: z.enum(["scheduled", "in_progress", "on_hold", "completed", "cancelled"]), scheduledStart: instant.nullable(), scheduledEnd: instant.nullable(), crewUserIds: z.array(text(200)).max(50).refine(v => new Set(v).size === v.length), crewNotes: z.string().trim().max(4000).nullable() };
export const createCustomerWorkProjectSchema = z.object({ requestId: id, confirmed: z.literal(true), source: z.discriminatedUnion("kind", [existingCustomerSourceSchema, acceptedEstimateSourceSchema]), ...projectFields }).strict();
export const updateCustomerWorkProjectSchema = z.object({ requestId: id, confirmed: z.literal(true), expectedWorkVersion: version, ...projectFields }).strict();
export const CUSTOMER_WORK_ACTIONS = ["estimate_created", "estimate_updated", "project_created", "project_updated"] as const;
export const customerWorkCommandSchema = z.object({ requestId: id, action: z.enum(CUSTOMER_WORK_ACTIONS), customerWorkId: id, targetId: id, version, duplicate: z.boolean() }).strict();
export const nativeWorkContextFields = { organizationId: id, leadId: id.nullable(), customerWorkId: id.nullable(), contactId: id, propertyId: id.nullable(), sourceKind: z.enum(["lead", "customer_work"]), customerLabel: text(500), propertyLabel: z.string().nullable(), leadLabel: z.string().nullable(), workVersion: version.nullable() };
const contextCoherent = (v: { sourceKind: string; leadId: string | null; customerWorkId: string | null; workVersion: number | null }) => v.sourceKind === "lead" ? v.leadId !== null && v.customerWorkId === null && v.workVersion === null : v.leadId === null && v.customerWorkId !== null && v.workVersion !== null;
export const customerWorkEstimateSchema = z.object({ id, ...nativeWorkContextFields, title: text(150), status: z.enum(["draft", "sent", "accepted", "declined"]), lineItems: z.array(customerWorkLineItemInputSchema.extend({ totalCents: cents })).max(100), subtotalCents: cents, taxCents: cents, totalCents: cents, notes: z.string().nullable(), sentAt: instant.nullable(), acceptedAt: instant.nullable(), createdAt: instant, updatedAt: instant }).strict().refine(contextCoherent);
export const customerWorkProjectSchema = z.object({ id, ...nativeWorkContextFields, estimateId: id.nullable(), ...projectFields, completedAt: instant.nullable(), createdAt: instant, updatedAt: instant }).strict().refine(contextCoherent);
export const customerWorkEstimateMutationSchema = z.object({ organizationId: id, estimate: customerWorkEstimateSchema, command: customerWorkCommandSchema }).strict();
export const customerWorkProjectMutationSchema = z.object({ organizationId: id, project: customerWorkProjectSchema, command: customerWorkCommandSchema }).strict();
export type CustomerWorkEstimate = z.infer<typeof customerWorkEstimateSchema>;
export type CustomerWorkProject = z.infer<typeof customerWorkProjectSchema>;
export type CustomerWorkEstimateMutation = z.infer<typeof customerWorkEstimateMutationSchema>;
export type CustomerWorkProjectMutation = z.infer<typeof customerWorkProjectMutationSchema>;
