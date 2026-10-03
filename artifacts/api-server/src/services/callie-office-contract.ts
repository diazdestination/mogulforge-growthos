import { z } from "zod/v4";

export const CALLIE_PAGE_SIZE = 25;
export const callieListQuery = z.object({
  scope: z.enum(["attention", "waiting", "history"]).default("attention"),
  offset: z.coerce.number().int().min(0).max(100000).default(0),
}).strict();
const command = {
  requestId: z.uuid(),
  expectedVersion: z.number().int().positive(),
  expectedFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
};
export const callieOfficeActionSchema = z.discriminatedUnion("action", [
  z.object({ ...command, action: z.literal("assign"), assignedUserId: z.string().min(1).max(200), note: z.string().trim().min(10).max(1000) }).strict(),
  z.object({ ...command, action: z.enum(["resolved", "cancelled"]), note: z.string().trim().min(10).max(1000), staffConfirmed: z.literal(true) }).strict(),
]);
export const callieBookingSchema = z.object({
  ...command,
  contactId: z.uuid(),
  leadId: z.uuid().nullable(),
  propertyId: z.uuid().nullable(),
  assignedUserId: z.string().min(1).max(200),
  type: z.enum(["inspection", "other"]),
  scheduledStart: z.iso.datetime(),
  scheduledEnd: z.iso.datetime(),
  confirmationNote: z.string().trim().min(10).max(1000),
  customerConfirmed: z.literal(true),
}).strict();
export const callieCallerReviewSchema = z.discriminatedUnion("action", [
  z.object({ ...command, action: z.literal("link_contact"), contactId: z.uuid(), staffConfirmed: z.literal(true) }).strict(),
  z.object({ ...command, action: z.literal("create_opportunity"), contactId: z.uuid().optional(), firstName: z.string().trim().min(1).max(100).optional(),
    lastName: z.string().trim().max(100).optional(), serviceType: z.string().trim().max(100).optional(), staffConfirmed: z.literal(true) }).strict(),
]);

export type CallieListQuery = z.infer<typeof callieListQuery>;
export type CallieOfficeAction = z.infer<typeof callieOfficeActionSchema>;
export type CallieBooking = z.infer<typeof callieBookingSchema>;
export type CallieCallerReview = z.infer<typeof callieCallerReviewSchema>;
