import { z } from "zod";
import type { ServiceWatchReason } from "../../../../lib/db/src/schema/service-watch";

const command = {
  requestId: z.uuid(), expectedVersion: z.number().int().min(0),
  expectedFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  assignedUserId: z.string().trim().min(1).max(200),
  note: z.string().trim().min(10).max(1000),
};
export const serviceWatchCommand = z.discriminatedUnion("action", [
  z.object({ ...command, action: z.literal("assign") }).strict(),
  z.object({ ...command, action: z.literal("acknowledge"), nextActionAt: z.iso.datetime(), reviewed: z.literal(true) }).strict(),
]);
export const serviceWatchQuery = z.object({
  scope: z.enum(["attention", "history", "all"]).default("attention"),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
}).strict();
export const WATCH_PAGE_SIZE = 50;
export const WATCH_BATCH_SIZE = 25;
export const RESPONSE_REVIEW_MS = 3 * 86_400_000;
export type WatchFacts = {
  active: boolean; dueDate: string; today: string; noticeAt: Date;
  booked: boolean; appointmentStatus: string | null;
  approval: boolean; approvalChanged: boolean; scheduledState: string | null;
  receiptState: string | null; receiptExpiresAt: Date | null;
  acceptedAt: Date | null; responseRecorded: boolean; ownerValid: boolean;
  nextActionAt: Date | null;
};

/** Dates/statuses only. This never classifies inbox text, warranty terms or permission. */
export function serviceWatchReasons(f: WatchFacts, now: Date): ServiceWatchReason[] {
  const reasons: ServiceWatchReason[] = [];
  if (f.receiptState === "indeterminate" || (f.receiptState === "processing" && !!f.receiptExpiresAt && f.receiptExpiresAt <= now)) reasons.push("send_unknown");
  if (f.active) {
    if (f.dueDate < f.today) reasons.push("service_overdue");
    if (!f.booked) {
      if (f.appointmentStatus === "cancelled") reasons.push("visit_cancelled");
      if (f.appointmentStatus === "no_show") reasons.push("visit_no_show");
      if (f.responseRecorded) reasons.push("response_needs_action");
      else if (f.acceptedAt && f.acceptedAt.getTime() + RESPONSE_REVIEW_MS <= now.getTime()) reasons.push("no_response_recorded");
      else if (!f.approval && f.noticeAt <= now) reasons.push("reminder_needs_review");
      if (f.approval && !f.responseRecorded && (f.approvalChanged || ["blocked", "failed", "confirmed_not_performed"].includes(f.receiptState ?? "") || (!f.receiptState && (!f.scheduledState || ["failed", "cancelled"].includes(f.scheduledState))))) reasons.push("reminder_blocked");
    }
  }
  if (reasons.length && f.nextActionAt && f.nextActionAt <= now) reasons.push("next_action_overdue");
  if (reasons.length && !f.ownerValid) reasons.push("owner_required");
  return reasons;
}
