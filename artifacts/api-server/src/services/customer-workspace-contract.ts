import { z } from "zod/v4";

/** Read projections only: these schemas grant neither contact nor mutation authority. */
export const CUSTOMER_WORKSPACE_SECTIONS = [
  "properties",
  "appointments",
  "services",
  "leads",
  "projects",
  "estimates",
  "invoices",
  "tasks",
  "activity",
] as const;
export const customerWorkspaceSectionSchema = z.enum(
  CUSTOMER_WORKSPACE_SECTIONS,
);
export type CustomerWorkspaceSection = z.infer<
  typeof customerWorkspaceSectionSchema
>;
export const customerWorkspaceSectionQuerySchema = z
  .object({
    section: customerWorkspaceSectionSchema,
    cursor: z
      .string()
      .min(1)
      .max(2048)
      .regex(/^[A-Za-z0-9_-]+$/)
      .optional(),
  })
  .strict();

const id = z.uuid();
const time = z.iso.datetime();
const nullableTime = time.nullable();
const text = z.string();
const nullableText = text.nullable();
const base = { id, createdAt: time };
export const customerWorkspaceOwnerSchema = z
  .object({
    id: z.string().min(1).max(200),
    name: nullableText,
  })
  .strict();
export const customerWorkspacePropertyRefSchema = z
  .object({
    id,
    addressLine1: text,
    addressLine2: nullableText,
    city: text,
    state: text,
    postalCode: text,
    propertyType: nullableText,
  })
  .strict();
const property = customerWorkspacePropertyRefSchema.nullable();
const owner = customerWorkspaceOwnerSchema.nullable();
function nativeScope(
  row: {
    leadId: string | null;
    customerWorkId?: string | null;
    workVersion?: number | null;
  },
  ctx: z.RefinementCtx,
  versioned: boolean,
) {
  // Optional additions preserve literal legacy read fixtures, never permit a
  // leadless projection with an absent root/version to become a native target.
  if (
    row.leadId === null
      ? !row.customerWorkId || (versioned && !row.workVersion)
      : row.customerWorkId != null || row.workVersion != null
  )
    ctx.addIssue({
      code: "custom",
      message:
        "Exactly one saved opportunity or returning-work context is required.",
    });
}
export const customerWorkspaceContactSchema = z
  .object({
    id,
    firstName: text,
    lastName: nullableText,
    email: nullableText,
    phone: nullableText,
    preferredContactMethod: nullableText,
    doNotContact: z.boolean(),
    doNotContactEmail: z.boolean(),
    doNotContactSms: z.boolean(),
    createdAt: time,
    updatedAt: time,
  })
  .strict();
export const customerWorkspaceHeaderSchema = z
  .object({
    organizationId: id,
    contact: customerWorkspaceContactSchema,
    permissions: z
      .object({ canWrite: z.boolean(), canReadInvoices: z.boolean() })
      .strict(),
    availableSections: z.array(customerWorkspaceSectionSchema).max(9),
  })
  .strict();
export const customerWorkspacePropertySchema =
  customerWorkspacePropertyRefSchema
    .extend({
      kind: z.literal("property"),
      createdAt: time,
    })
    .strict();
export const customerWorkspaceLeadSchema = z
  .object({
    ...base,
    kind: z.literal("lead"),
    status: z.enum([
      "new",
      "ai_qualified",
      "contact_attempted",
      "inspection_scheduled",
      "inspection_completed",
      "estimate_preparing",
      "estimate_sent",
      "claim_pending",
      "follow_up",
      "won",
      "production_scheduled",
      "in_progress",
      "final_walkthrough",
      "completed",
      "review_requested",
      "nurture",
      "lost",
    ]),
    urgency: z.enum(["low", "normal", "high", "emergency"]),
    serviceType: nullableText,
    property,
    owner,
  })
  .strict();
export const customerWorkspaceAppointmentSchema = z
  .object({
    ...base,
    kind: z.literal("appointment"),
    type: z.enum([
      "inspection",
      "estimate_review",
      "production",
      "final_walkthrough",
      "other",
    ]),
    status: z.enum([
      "scheduled",
      "confirmed",
      "completed",
      "cancelled",
      "no_show",
    ]),
    scheduledStart: time,
    scheduledEnd: nullableTime,
    updatedAt: time,
    contactId: id.nullable(),
    leadId: id.nullable(),
    property,
    owner,
  })
  .strict();
export const customerWorkspaceAppointmentDetailSchema = z
  .object({
    organizationId: id,
    appointment: customerWorkspaceAppointmentSchema,
    permissions: z.object({ canWrite: z.boolean() }).strict(),
  })
  .strict();
export const customerWorkspaceServiceSchema = z
  .object({
    ...base,
    kind: z.literal("service"),
    serviceKind: z.enum(["warranty_check", "maintenance", "service_plan"]),
    equipmentLabel: text,
    status: z.enum(["active", "completed", "cancelled"]),
    dueAt: time,
    completedAt: nullableTime,
    coverageStartsOn: z.iso.date().nullable(),
    coverageEndsOn: z.iso.date().nullable(),
    occurrenceIndex: z.number().int().nonnegative(),
    predecessorObligationId: id.nullable(),
    taskId: id,
    appointmentId: id.nullable(),
    property,
    owner,
  })
  .strict();
export const customerWorkspaceProjectSchema = z
  .object({
    ...base,
    kind: z.literal("project"),
    name: text,
    status: z.enum([
      "scheduled",
      "in_progress",
      "on_hold",
      "completed",
      "cancelled",
    ]),
    scheduledStart: nullableTime,
    scheduledEnd: nullableTime,
    completedAt: nullableTime,
    leadId: id.nullable(),
    customerWorkId: id.nullable().optional(),
    workVersion: z.number().int().positive().nullable().optional(),
    estimateId: id.nullable(),
    property,
  })
  .strict()
  .superRefine((row, ctx) => nativeScope(row, ctx, true));
export const customerWorkspaceEstimateSchema = z
  .object({
    ...base,
    kind: z.literal("estimate"),
    title: text,
    status: z.enum(["draft", "sent", "accepted", "declined"]),
    leadId: id.nullable(),
    customerWorkId: id.nullable().optional(),
    workVersion: z.number().int().positive().nullable().optional(),
    property,
  })
  .strict()
  .superRefine((row, ctx) => nativeScope(row, ctx, true));
export const customerWorkspaceInvoiceSchema = z
  .object({
    ...base,
    kind: z.literal("invoice"),
    invoiceNumber: nullableText,
    title: text,
    status: z.enum(["draft", "issued", "void"]),
    issuedAt: nullableTime,
    leadId: id.nullable(),
    customerWorkId: id.nullable().optional(),
    projectId: id.nullable(),
    estimateId: id.nullable(),
    property,
  })
  .strict()
  .superRefine((row, ctx) => nativeScope(row, ctx, false));
export const customerWorkspaceTaskSchema = z
  .object({
    ...base,
    kind: z.literal("task"),
    title: text,
    status: z.enum(["open", "in_progress", "done", "cancelled"]),
    priority: z.enum(["low", "normal", "high", "emergency"]),
    dueAt: nullableTime,
    completedAt: nullableTime,
    leadId: id.nullable(),
    owner,
  })
  .strict();
export const customerWorkspaceActivitySchema = z
  .object({
    ...base,
    kind: z.literal("activity"),
    category: z.enum([
      "note",
      "lead",
      "appointment",
      "service",
      "task",
      "communication",
      "invoice",
    ]),
    label: z.enum([
      "Note recorded",
      "Opportunity updated",
      "Visit updated",
      "Service updated",
      "Task updated",
      "Communication event recorded",
      "Customer response recorded",
      "Invoice updated",
    ]),
    occurredAt: time,
    leadId: id.nullable(),
  })
  .strict();
export const customerWorkspaceItemSchema = z.discriminatedUnion("kind", [
  customerWorkspacePropertySchema,
  customerWorkspaceAppointmentSchema,
  customerWorkspaceServiceSchema,
  customerWorkspaceLeadSchema,
  customerWorkspaceProjectSchema,
  customerWorkspaceEstimateSchema,
  customerWorkspaceInvoiceSchema,
  customerWorkspaceTaskSchema,
  customerWorkspaceActivitySchema,
]);
const page = {
  organizationId: id,
  contactId: id,
  order: z.literal("created_desc"),
  limit: z.literal(25),
  nextCursor: z.string().min(1).max(2048).nullable(),
  hasMore: z.boolean(),
};
/** Section-specific arrays reject a valid record of the wrong selected section. */
export const customerWorkspacePageSchema = z.discriminatedUnion("section", [
  z
    .object({
      ...page,
      section: z.literal("properties"),
      items: z.array(customerWorkspacePropertySchema).max(25),
    })
    .strict(),
  z
    .object({
      ...page,
      section: z.literal("appointments"),
      items: z.array(customerWorkspaceAppointmentSchema).max(25),
    })
    .strict(),
  z
    .object({
      ...page,
      section: z.literal("services"),
      items: z.array(customerWorkspaceServiceSchema).max(25),
    })
    .strict(),
  z
    .object({
      ...page,
      section: z.literal("leads"),
      items: z.array(customerWorkspaceLeadSchema).max(25),
    })
    .strict(),
  z
    .object({
      ...page,
      section: z.literal("projects"),
      items: z.array(customerWorkspaceProjectSchema).max(25),
    })
    .strict(),
  z
    .object({
      ...page,
      section: z.literal("estimates"),
      items: z.array(customerWorkspaceEstimateSchema).max(25),
    })
    .strict(),
  z
    .object({
      ...page,
      section: z.literal("invoices"),
      items: z.array(customerWorkspaceInvoiceSchema).max(25),
    })
    .strict(),
  z
    .object({
      ...page,
      section: z.literal("tasks"),
      items: z.array(customerWorkspaceTaskSchema).max(25),
    })
    .strict(),
  z
    .object({
      ...page,
      section: z.literal("activity"),
      items: z.array(customerWorkspaceActivitySchema).max(25),
    })
    .strict(),
]);

export type CustomerWorkspaceHeader = z.infer<
  typeof customerWorkspaceHeaderSchema
>;
export type CustomerWorkspacePage = z.infer<typeof customerWorkspacePageSchema>;
export type CustomerWorkspaceItem = z.infer<typeof customerWorkspaceItemSchema>;
export type CustomerWorkspaceProperty = z.infer<
  typeof customerWorkspacePropertySchema
>;
export type CustomerWorkspaceAppointment = z.infer<
  typeof customerWorkspaceAppointmentSchema
>;
export type CustomerWorkspaceAppointmentDetail = z.infer<
  typeof customerWorkspaceAppointmentDetailSchema
>;
export type CustomerWorkspaceSectionQuery = z.infer<
  typeof customerWorkspaceSectionQuerySchema
>;
export class CustomerWorkspaceError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
