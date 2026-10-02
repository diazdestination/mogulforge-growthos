import { z } from "zod/v4";

export const CARE_TEMPLATE_VERSION = "missed-call-care.v1" as const;
export const CARE_BODY = "Thanks for calling. We could not connect you with our team. Please reply with the service you need and the best time for a callback. This does not confirm an appointment.";
export const careOperationKey = (callId: string) => `missed-call-care:${callId}:sms:v1`;
export const isMissedInbound = (call: { direction: string; dialStatus: string | null }) =>
  call.direction === "inbound" && ["busy", "no-answer", "failed", "canceled"].includes(call.dialStatus ?? "");
const owner = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/).nullable();
const clock = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
export const missedCallCarePolicySchema = z.object({
  enabled: z.boolean(),
  timezone: z.string().min(1).max(80).refine((value) => { try { new Intl.DateTimeFormat("en-US", { timeZone: value }); return true; } catch { return false; } }),
  days: z.array(z.number().int().min(1).max(7)).min(1).max(7).refine((days) => new Set(days).size === days.length),
  opensAt: clock,
  closesAt: clock,
  businessHoursOwnerId: owner,
  afterHoursOwnerId: owner,
  responseMinutes: z.number().int().min(5).max(1440),
}).strict().refine((p) => p.opensAt < p.closesAt, "Closing time must follow opening time")
  .refine((p) => !p.enabled || Boolean(p.businessHoursOwnerId && p.afterHoursOwnerId), "Enabled recovery needs both accountable owners");
export type CarePolicyInput = z.infer<typeof missedCallCarePolicySchema>;
export const DEFAULT_CARE_POLICY: CarePolicyInput = { enabled: false, timezone: "UTC", days: [1, 2, 3, 4, 5], opensAt: "09:00", closesAt: "18:00", businessHoursOwnerId: null, afterHoursOwnerId: null, responseMinutes: 30 };
function windowTest(policy: CarePolicyInput) {
  const format = new Intl.DateTimeFormat("en-US", { timeZone: policy.timezone, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  return (at: Date) => {
    const parts = format.formatToParts(at), part = (name: string) => parts.find((p) => p.type === name)?.value ?? "";
    const day = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(part("weekday")) + 1;
    const time = `${part("hour")}:${part("minute")}`;
    return policy.days.includes(day) && time >= policy.opensAt && time < policy.closesAt;
  };
}
export function careOwnerAt(policy: CarePolicyInput, at: Date) {
  if (!missedCallCarePolicySchema.safeParse(policy).success || !Number.isFinite(at.getTime())) return null;
  return windowTest(policy)(at) ? policy.businessHoursOwnerId : policy.afterHoursOwnerId;
}
/** Customer SMS waits for the explicitly approved window, including after-hours calls. */
export function nextCareWindow(policy: CarePolicyInput, at: Date): Date | null {
  if (!missedCallCarePolicySchema.safeParse(policy).success || !Number.isFinite(at.getTime())) throw new Error("Invalid missed-call sending window");
  const allowed = windowTest(policy);
  if (allowed(at)) return null;
  const cursor = new Date(Math.floor(at.getTime() / 60_000) * 60_000);
  for (let minute = 0; minute < 8 * 24 * 60; minute++) {
    cursor.setTime(cursor.getTime() + 60_000);
    if (allowed(cursor)) return new Date(cursor);
  }
  throw new Error("No safe missed-call sending window");
}
