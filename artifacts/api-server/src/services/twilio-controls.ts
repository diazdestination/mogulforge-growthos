import { createHash } from "node:crypto";
import type { Request } from "express";
import { validateRequest } from "twilio";

export const SMS_DISCLOSURE_VERSION = "mogulforge-sms-2026-09-27.v1";
export type SmsPurpose =
  "customer_care" | "appointments" | "marketing" | "authentication";
export type SmsSendContext = {
  organizationId: string;
  contactId: string;
  purpose: SmsPurpose;
  idempotencyKey: string;
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

export function twilioConfiguration() {
  const env = process.env;
  let origin = "";
  try {
    const url = new URL(env.TWILIO_PUBLIC_ORIGIN ?? "");
    if (url.protocol === "https:" && url.origin === env.TWILIO_PUBLIC_ORIGIN)
      origin = url.origin;
  } catch {
    /* disabled */
  }
  const organizationId = env.TWILIO_ORGANIZATION_ID ?? "";
  const configured = Boolean(
    origin &&
    /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(organizationId) &&
    sid("AC", env.TWILIO_ACCOUNT_SID) &&
    env.TWILIO_AUTH_TOKEN &&
    sid("MG", env.TWILIO_MESSAGING_SERVICE_SID) &&
    phoneE164(env.TWILIO_PHONE_NUMBER ?? "") === env.TWILIO_PHONE_NUMBER,
  );
  const dailyLimit = Number(env.TWILIO_DAILY_SMS_LIMIT ?? 0);
  const enabled =
    configured &&
    env.TWILIO_SMS_ENABLED === "true" &&
    env.TWILIO_REGISTRATION_APPROVED === "true" &&
    env.TWILIO_ADVANCED_OPT_OUT === "true" &&
    env.TWILIO_LAUNCH_APPROVED === "true" &&
    env.TWILIO_GEO_PERMISSIONS_REVIEWED === "true" &&
    sid("SK", env.TWILIO_API_KEY_SID) &&
    Boolean(env.TWILIO_API_KEY_SECRET) &&
    Number.isSafeInteger(dailyLimit) &&
    dailyLimit > 0 &&
    dailyLimit <= 1000;
  return { origin, organizationId, configured, enabled, dailyLimit };
}

export function twilioRequestValid(req: Request): boolean {
  const config = twilioConfiguration(),
    body = req.body;
  if (
    !config.configured ||
    !req.is("application/x-www-form-urlencoded") ||
    !body ||
    typeof body !== "object" ||
    Array.isArray(body)
  )
    return false;
  if (Object.values(body).some((value) => typeof value !== "string"))
    return false;
  if (
    body.AccountSid !== process.env.TWILIO_ACCOUNT_SID ||
    (body.MessagingServiceSid &&
      body.MessagingServiceSid !== process.env.TWILIO_MESSAGING_SERVICE_SID)
  )
    return false;
  const signature = req.headers["x-twilio-signature"];
  return (
    typeof signature === "string" &&
    validateRequest(
      process.env.TWILIO_AUTH_TOKEN!,
      signature,
      `${config.origin}${req.originalUrl}`,
      body,
    )
  );
}
