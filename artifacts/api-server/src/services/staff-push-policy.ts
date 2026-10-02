import { createECDH } from "node:crypto";
import { z } from "zod/v4";
import type { StaffPushPolicy } from "@workspace/db";
import { isStagingEnvironment, outboundDeliveryHeld } from "./outbound-hold";

const userIds = z.array(z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/)).min(1).max(20)
  .refine((ids) => new Set(ids).size === ids.length, "Duplicate recipients");
const time = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
export const staffPushPolicySchema = z.object({
  enabled: z.boolean(),
  serviceAlertsEnabled: z.boolean().default(false),
  timezone: z.string().min(1).max(80).refine((value) => {
    try { new Intl.DateTimeFormat("en-US", { timeZone: value }); return true; } catch { return false; }
  }, "Valid IANA time zone required"),
  days: z.array(z.number().int().min(1).max(7)).min(1).max(7)
    .refine((days) => new Set(days).size === days.length, "Duplicate weekdays"),
  opensAt: time,
  closesAt: time,
  businessHoursUserIds: userIds,
  afterHoursUserIds: userIds,
}).strict().refine((policy) => policy.opensAt < policy.closesAt, "Closing time must follow opening time on the same day");

/** The lead's creation instant selects coverage, using DST-aware local time. */
export function staffPushRecipients(policy: unknown, at: Date): string[] {
  const parsed = staffPushPolicySchema.safeParse(policy);
  if (!parsed.success || !parsed.data.enabled || !Number.isFinite(at.getTime())) return [];
  const value: StaffPushPolicy = parsed.data;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: value.timezone, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(at);
  const part = (key: string) => parts.find((p) => p.type === key)?.value ?? "";
  const day = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(part("weekday")) + 1;
  const clock = `${part("hour")}:${part("minute")}`;
  return value.days.includes(day) && clock >= value.opensAt && clock < value.closesAt
    ? value.businessHoursUserIds : value.afterHoursUserIds;
}

function canonicalBase64(value: string | undefined, length: number): boolean {
  if (!value || !/^[A-Za-z0-9_-]+$/.test(value)) return false;
  const bytes = Buffer.from(value, "base64url");
  return bytes.length === length && bytes.toString("base64url") === value;
}

export function pushConfiguration(env: NodeJS.ProcessEnv = process.env) {
  const publicKey = env.WEB_PUSH_VAPID_PUBLIC_KEY;
  const privateKey = env.WEB_PUSH_VAPID_PRIVATE_KEY;
  const subject = env.WEB_PUSH_VAPID_SUBJECT;
  if (!canonicalBase64(publicKey, 65) || !canonicalBase64(privateKey, 32) || !subject) return null;
  try {
    const contact = new URL(subject);
    if (!((contact.protocol === "mailto:" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact.pathname)) ||
      (contact.protocol === "https:" && !contact.username && !contact.password && !contact.hash && !contact.search))) return null;
    const key = createECDH("prime256v1");
    key.setPrivateKey(Buffer.from(privateKey!, "base64url"));
    if (key.getPublicKey().toString("base64url") !== publicKey) return null;
    const encryption = env.OAUTH_TOKEN_ENCRYPTION_KEY?.trim() ?? "";
    if (!encryption || (Buffer.from(encryption, /^[a-f\d]{64}$/i.test(encryption) ? "hex" : "base64").length !== 32)) return null;
    return { publicKey: publicKey!, privateKey: privateKey!, subject };
  } catch { return null; }
}

/** No missing flag, malformed flag or staging alias may turn on staff sends. */
export function staffPushAllowed(userId?: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.WEB_PUSH_ENABLED !== "true" || !pushConfiguration(env)) return false;
  try { if (outboundDeliveryHeld(env.GROWTHOS_OUTBOUND_HOLD, env)) return false; } catch { return false; }
  const staging = isStagingEnvironment(env) || env.GROWTHOS_ENVIRONMENT === "staging";
  if (!staging) return true;
  if (env.GROWTHOS_OUTBOUND_HOLD !== "false" || env.STAGING_OUTBOUND_APPROVED !== "true") return false;
  const ids = (env.STAGING_PUSH_USER_ALLOWLIST ?? "").split(",").map((id) => id.trim());
  if (ids.length > 20 || ids.some((id) => !/^[A-Za-z0-9_-]{1,128}$/.test(id))) return false;
  return userId === undefined ? ids.length > 0 : ids.includes(userId);
}

/** Narrow provider allowlist; never a caller-controlled generic URL fetcher. */
export function isPushEndpointAllowed(endpoint: string): boolean {
  if (endpoint.length > 2048 || endpoint.trim() !== endpoint || /[\s\\]/.test(endpoint)) return false;
  try {
    const url = new URL(endpoint);
    if (url.protocol !== "https:" || url.port || url.username || url.password || url.hash || url.search) return false;
    // Reject normalization tricks, encoded slashes/dots, trailing-dot hosts and noncanonical casing.
    if (url.href !== endpoint) return false;
    if (url.hostname === "web.push.apple.com") return /^\/[A-Za-z0-9_-]{20,1800}$/.test(url.pathname);
    if (url.hostname === "fcm.googleapis.com") return /^\/fcm\/send\/[A-Za-z0-9_:-]{20,1800}$/.test(url.pathname);
    if (url.hostname === "updates.push.services.mozilla.com") return /^\/wpush\/v2\/[A-Za-z0-9_-]{20,1800}$/.test(url.pathname);
    return false;
  } catch { return false; }
}

export const pushSubscriptionSchema = z.object({
  endpoint: z.string().refine(isPushEndpointAllowed, "Unsupported push provider endpoint"),
  expirationTime: z.number().finite().nonnegative().nullable().optional(),
  keys: z.object({
    p256dh: z.string().refine((value) => {
      if (!canonicalBase64(value, 65)) return false;
      try { const key = createECDH("prime256v1"); key.generateKeys(); key.computeSecret(Buffer.from(value, "base64url")); return true; } catch { return false; }
    }, "Invalid device encryption key"),
    auth: z.string().refine((value) => canonicalBase64(value, 16), "Invalid device authentication key"),
  }).strict(),
}).strict();
export type DevicePushSubscription = z.infer<typeof pushSubscriptionSchema>;

/** Opaque IDs are navigation context, never authorization. No CRM content on lock screens. */
export function staffLeadPayload(organizationId: string, leadId: string) {
  return { title: "GrowthOS", body: "A new lead is ready for your team.", organizationId, leadId,
    url: `/leads/${leadId}?organizationId=${organizationId}`, tag: `lead-${leadId}` };
}

/** Service work is not an acquisition lead; never manufacture a lead to notify staff. */
export function staffServicePayload(organizationId: string, serviceObligationId: string) {
  return { title: "GrowthOS", body: "A service follow-up needs your attention.", organizationId, serviceObligationId,
    url: `/service?serviceObligationId=${serviceObligationId}&organizationId=${organizationId}`, tag: `service-${serviceObligationId}` };
}
