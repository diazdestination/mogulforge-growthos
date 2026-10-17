import { z } from 'zod/v4';
import { appointmentTypes, uuidSchema, userIdSchema, isoSchema, schedulingReviewContextSchema } from './models';
export const schedulingReviewQuerySchema = z
  .strictObject({
    sourceKind: z.enum(["lead", "direct_customer", "unlinked_manual"]),
    sourceId: uuidSchema.optional(),
    propertyId: uuidSchema.optional(),
    estimateId: uuidSchema.optional(),
    reservationKind: z.enum(["appointment", "project"]),
    appointmentType: z.enum(appointmentTypes).optional(),
    targetKind: z.enum(["appointment", "project"]).optional(),
    targetId: uuidSchema.optional(),
  })
  .superRefine((value, ctx) => {
    if (
      (value.sourceKind === "unlinked_manual"
        ? value.sourceId !== undefined ||
          value.propertyId !== undefined ||
          value.estimateId !== undefined
        : value.sourceId === undefined) ||
      !!value.targetKind !== !!value.targetId ||
      (value.targetKind && value.targetKind !== value.reservationKind) ||
      (value.reservationKind === "project" &&
        value.appointmentType !== undefined)
    )
      ctx.addIssue({
        code: "custom",
        message: "Choose consistent source, target and booking scope.",
      });
  });
export type SchedulingReviewQuery = z.infer<typeof schedulingReviewQuerySchema>;

export const schedulingConflictExplanationRequestSchema = z.strictObject({
  query: schedulingReviewQuerySchema,
  context: schedulingReviewContextSchema,
  interval: z.strictObject({ startAt: isoSchema, endAt: isoSchema, resourceUserIds: z.array(userIdSchema) }).refine(value => Date.parse(value.endAt) > Date.parse(value.startAt), 'End must follow start'),
});
export const schedulingConflictExplanationSchema = z.strictObject({
  basis: z.literal('current_schedule'), evaluatedAt: isoSchema, context: schedulingReviewContextSchema,
  conflict: z.strictObject({ reservationKind: z.enum(['appointment', 'project']), reservationId: uuidSchema, resourceUserId: userIdSchema, startAt: isoSchema, endAt: isoSchema, reason: z.enum(['resource_overlap', 'travel_gap']), requiredGapMinutes: z.number().int().min(0).max(1440) }).nullable(),
});
export type SchedulingConflictExplanationRequest = z.infer<typeof schedulingConflictExplanationRequestSchema>;
export type SchedulingConflictExplanation = z.infer<typeof schedulingConflictExplanationSchema>;
