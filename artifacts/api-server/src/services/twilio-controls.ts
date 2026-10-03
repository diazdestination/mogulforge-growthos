import { createHash } from "node:crypto";
import type { Request } from "express";
import { and, eq } from "drizzle-orm";
import { validateRequest } from "twilio";
import { db, twilioClientBindingsTable } from "@workspace/db";

export const SMS_DISCLOSURE_VERSION = "mogulforge-sms-2026-09-27.v1";
/** Created only by the local purpose gate before reserving or posting an SMS. */
export class TwilioPurposeNotEnabledError extends Error {
  readonly code = "sms_purpose_not_enabled";
  readonly effectNotAttempted = true;
  constructor() { super("This SMS purpose is not enabled for the initial program"); }
}
export type SmsPurpose =
  "customer_care" | "appointments" | "marketing" | "authentication";
export type SmsSendContext = {
  organizationId: string;
  contactId: string;
  purpose: SmsPurpose;
  idempotencyKey: string;
  /** Typed service parent only; it cannot grant generic SMS consent. */
  serviceSmsParentId?: string;
  /** Exact original automation allowance, not an opt-in or sender override. */
  contactTouch?: { logicalKey: string; payloadHash: string };
};
export const phoneE164 = (phone: string) => {
  const digits = phone.replace(/\D/g, "");
  return /^1[2-9]\d{9}$/.test(digits)
    ? `+${digits}`
    : /^[2-9]\d{9}$/.test(digits)
      ? `+1${digits}`
      : null;
};
const sid = (prefix: string, value = "") =>
  new RegExp(`^${prefix}[a-fA-F0-9]{32}$`).test(value);
export const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");

type Binding = typeof twilioClientBindingsTable.$inferSelect;
const secretReference = (name: string | null, suffix: string) =>
  name && new RegExp(`^TWILIO_CLIENT_[A-Z0-9_]+_${suffix}$`).test(name)
    ? process.env[name] ?? ""
    : "";
const validOrigin = (raw: string) => {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && url.origin === raw ? url.origin : "";
  } catch {
    return "";
  }
};
function hydrate(binding: Binding) {
  const origin = validOrigin(binding.publicOrigin);
  const authToken = secretReference(binding.authTokenSecretRef, "AUTH_TOKEN");
  const apiKeySecret = secretReference(binding.apiKeySecretRef, "API_KEY_SECRET");
  const voiceConfigured = Boolean(
    origin && sid("AC", binding.accountSid) && authToken &&
    phoneE164(binding.phoneNumber) === binding.phoneNumber,
  );
  const smsConfigured = Boolean(
    voiceConfigured && sid("MG", binding.messagingServiceSid ?? "") &&
    binding.smsDisclosureVersion && binding.smsDisclosureVersion.length <= 120,
  );
  const businessName = binding.businessName.trim();
  const validBusinessName = businessName.length > 0 && businessName.length <= 120 &&
    !/[\u0000-\u001f\u007f]/.test(businessName);
  const apiConfigured = Boolean(sid("SK", binding.apiKeySid ?? "") && apiKeySecret);
  const active = binding.revokedAt === null && binding.launchApproved;
  const voiceEnabled = Boolean(
    active && voiceConfigured && apiConfigured && validBusinessName &&
    binding.voiceEnabled && binding.voiceApproved && binding.geoPermissionsReviewed &&
    phoneE164(binding.staffPhone ?? "") === binding.staffPhone &&
    binding.staffPhone !== binding.phoneNumber &&
    Number.isSafeInteger(binding.dailyCallLimit) &&
    binding.dailyCallLimit > 0 && binding.dailyCallLimit <= 100,
  );
  const smsEnabled = Boolean(
    active && smsConfigured && apiConfigured && validBusinessName &&
    binding.smsEnabled && binding.registrationApproved &&
    binding.advancedOptOut && binding.geoPermissionsReviewed &&
    Number.isSafeInteger(binding.dailySmsLimit) &&
    binding.dailySmsLimit > 0 && binding.dailySmsLimit <= 1000,
  );
  return {
    ...binding, origin, authToken, apiKeySecret, businessName,
    voiceConfigured, smsConfigured, voiceEnabled, smsEnabled,
  };
}
export type TwilioClientBinding = ReturnType<typeof hydrate>;
export async function twilioForOrganization(organizationId: string, reader: Pick<typeof db, "select"> = db): Promise<TwilioClientBinding | null> {
  const [binding] = await reader.select().from(twilioClientBindingsTable)
    .where(eq(twilioClientBindingsTable.organizationId, organizationId)).limit(1);
  return binding ? hydrate(binding) : null;
}
export async function twilioForInbound(accountSid: string, phoneNumber: string): Promise<TwilioClientBinding | null> {
  if (!sid("AC", accountSid) || phoneE164(phoneNumber) !== phoneNumber) return null;
  const [binding] = await db.select().from(twilioClientBindingsTable)
    .where(and(
      eq(twilioClientBindingsTable.accountSid, accountSid),
      eq(twilioClientBindingsTable.phoneNumber, phoneNumber),
    )).limit(1);
  return binding ? hydrate(binding) : null;
}
export async function twilioForPublicProgram(token: unknown): Promise<TwilioClientBinding | null> {
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{24,128}$/.test(token)) return null;
  const [binding] = await db.select().from(twilioClientBindingsTable)
    .where(eq(twilioClientBindingsTable.publicEnrollmentToken, token)).limit(1);
  return binding ? hydrate(binding) : null;
}
/** Only a candidate selected by account/number or existing operation is verified. */
export function twilioRequestValid(
  req: Request,
  binding: TwilioClientBinding | null,
  channel: "sms" | "voice" = "sms",
): boolean {
  const body = req.body;
  if (
    !binding || !(channel === "voice" ? binding.voiceConfigured : binding.smsConfigured) ||
    !req.is("application/x-www-form-urlencoded") || !body ||
    typeof body !== "object" || Array.isArray(body) ||
    Object.values(body).some((value) => typeof value !== "string") ||
    body.AccountSid !== binding.accountSid ||
    (body.MessagingServiceSid && body.MessagingServiceSid !== binding.messagingServiceSid)
  ) return false;
  const signature = req.headers["x-twilio-signature"];
  return typeof signature === "string" && validateRequest(
    binding.authToken, signature, `${binding.origin}${req.originalUrl}`, body,
  );
}
