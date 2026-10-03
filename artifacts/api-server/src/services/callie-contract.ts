import { createHash } from "node:crypto";
import { z } from "zod/v4";
import type { CalliePolicySettings, CalliePolicySnapshot } from "@workspace/db";

export const CALLIE_TEMPLATE_VERSION = "callie-intake.v1" as const;
export const CALLIE_CHALLENGE_MS = 15 * 60_000;
export const CALLIE_GRANT_MS = 24 * 60 * 60_000;
export const CALLIE_VOICE_MS = 10 * 60_000;
export const CALLIE_ACK_BODY = "We received your request about your missed call. Our office will review your service and callback preferences. A visit is not booked, and emergency dispatch is not confirmed. Please call our shop if you need to speak with the team.";
export const callieOperationKey = (callId: string) => `missed-call-care:${callId}:sms:v1`;
export const callieHash = (value: unknown) => createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
const owner = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/).nullable();
const clock = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
export const calliePolicySettingsSchema = z.object({
  enabled: z.boolean(),
  timezone: z.string().min(1).max(80).refine((value) => { try { new Intl.DateTimeFormat("en-US", { timeZone: value }); return true; } catch { return false; } }),
  days: z.array(z.number().int().min(1).max(7)).min(1).max(7).refine((values) => new Set(values).size === values.length),
  opensAt: clock, closesAt: clock,
  businessHoursOwnerId: owner, afterHoursOwnerId: owner,
  responseMinutes: z.number().int().min(5).max(1440),
}).strict().refine((p) => p.opensAt < p.closesAt, "Closing time must follow opening time")
  .refine((p) => !p.enabled || Boolean(p.businessHoursOwnerId && p.afterHoursOwnerId), "Enabled CALLIE needs accountable daytime and after-hours owners");
export const DEFAULT_CALLIE_POLICY: CalliePolicySettings = { enabled: false, timezone: "UTC", days: [1, 2, 3, 4, 5], opensAt: "09:00", closesAt: "18:00", businessHoursOwnerId: null, afterHoursOwnerId: null, responseMinutes: 30 };

export function buildCalliePolicySnapshot(settings: CalliePolicySettings, binding: CalliePolicySnapshot["binding"]): CalliePolicySnapshot {
  const policy = calliePolicySettingsSchema.parse(settings);
  const brand = binding?.businessName ?? "the shop";
  return {
    ...policy, templateVersion: CALLIE_TEMPLATE_VERSION, binding,
    prompts: {
      service: "We could not connect your call. This service does not provide emergency dispatch. For immediate danger, contact emergency services. For repair press 1, replacement press 2, maintenance press 3, or another service press 4.",
      request: "For a callback press 1. To request a visit press 2. Requesting a visit does not reserve or confirm an appointment.",
      window: "For a callback during business hours in the morning press 1, afternoon press 2, or no preference press 3. This is a preference, not a promised time.",
      disclosure: `${brand} can send one automated text acknowledging this call request, only if you request it by texting the code we provide from this same number. This is optional and is not marketing or permission for recurring texts. Message and data rates may apply. Reply STOP to opt out or HELP for help. No appointment or emergency dispatch is confirmed.`,
      consent: "To hear instructions for requesting that one text, press 1. To finish without a text, press 0.",
      instructions: `To request one acknowledgment from ${brand}, text CALLIE followed by the code {{code}} to {{sender}} from this same phone within 15 minutes. Your call request remains with the office whether or not you text. Goodbye.`,
    },
    acknowledgmentBody: CALLIE_ACK_BODY,
  };
}

/** Exact grammar only. Other text never becomes one-call authority. */
export function callieChallengeCode(body: string) {
  return /^CALLIE ([0-9]{8})$/i.exec(body.trim())?.[1] ?? null;
}
export const callieChallengeHash = (code: string) => callieHash(`CALLIE ${code}`);
export const callieTriggerHash = (input: { accountSid: string; from: string; to: string; messageSid: string; bodyHash: string }) =>
  callieHash({ accountSid: input.accountSid, from: input.from, to: input.to, messageSid: input.messageSid, bodyHash: input.bodyHash });
export function callieOwnerAt(settings: CalliePolicySettings, at: Date) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: settings.timezone, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(at);
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const day = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(part("weekday")) + 1;
  const clock = `${part("hour")}:${part("minute")}`;
  return settings.days.includes(day) && clock >= settings.opensAt && clock < settings.closesAt ? settings.businessHoursOwnerId : settings.afterHoursOwnerId;
}
