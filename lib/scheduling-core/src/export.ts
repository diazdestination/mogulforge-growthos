import { z } from "zod/v4";
import { schedulingPolicySchema, timeZoneSchema, isoSchema, userIdSchema, uuidSchema, durationChoiceSchema } from "./models";
import { manualSourceRefSchema } from "./models";
const exportTargetSchema = z.strictObject({ kind: z.enum(["appointment", "project"]), id: uuidSchema });
const exportReasonSchema = z.string().min(1).max(80).regex(/^[a-z][a-z0-9_]*$/);
export const closedPolicyExportSchema = schedulingPolicySchema.omit({
  digest: true,
  updatedByUserId: true,
});
export type ClosedPolicyExport = z.infer<typeof closedPolicyExportSchema>;
export const closedReservationExportSchema = z.strictObject({
  reservationRevision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  approvedTimeZone: timeZoneSchema,
  inspection: z.strictObject({ ruleTimeZone: timeZoneSchema }).nullable(),
  startAt: isoSchema,
  endAt: isoSchema,
  resourceUserIds: z.array(userIdSchema),
  minimumTravelGapMinutes: z.number().int().min(0).max(1440),
  duration: durationChoiceSchema,
  target: exportTargetSchema,
});
export type ClosedReservationExport = z.infer<
  typeof closedReservationExportSchema
>;
export const closedBusinessSchedulingSummarySchema = z.strictObject({
  event: z.enum([
    "policy_updated",
    "reservation_admitted",
    "reservation_released",
    "reservation_deleted",
    "operation_committed",
    "operation_refused",
  ]),
  occurredAt: isoSchema,
  target: exportTargetSchema
    .extend({ available: z.boolean() })
    .nullable(),
  source: manualSourceRefSchema.nullable(),
  before: z
    .union([closedReservationExportSchema, closedPolicyExportSchema])
    .nullable(),
  after: z
    .union([closedReservationExportSchema, closedPolicyExportSchema])
    .nullable(),
  reasonCode: exportReasonSchema.nullable(),
});
export type ClosedBusinessSchedulingSummary = z.infer<
  typeof closedBusinessSchedulingSummarySchema
>;
