import { logger } from "../lib/logger";
import { createHash } from "node:crypto";
import { isSafeMailbox } from "./providers";
import { PlatformEmailDeliveryError, sendPlatformIdentityEmail, type PlatformEmailSource } from "./platform-email-delivery";

function appOrigin(): string {
  const origin = process.env.APP_ORIGIN?.trim() || process.env.APP_URL?.trim();
  if (!origin) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("APP_ORIGIN is required for identity email links");
    }
    return "http://localhost:5000";
  }
  return origin.replace(/\/$/, "");
}

export function identityActionUrl(
  path: "/verify-email" | "/reset-password",
  token: string,
): string {
  const url = new URL(path, `${appOrigin()}/`);
  url.searchParams.set("token", token);
  return url.toString();
}

async function sendIdentityEmail(params: {
  to: string;
  subject: string;
  body: string;
  source: PlatformEmailSource;
}) {
  if (!isSafeMailbox(params.to)) {
    throw new Error("Refusing to send identity email to an invalid mailbox");
  }
  const receipt = await sendPlatformIdentityEmail(params);
  if (receipt.outcome !== "accepted") throw new PlatformEmailDeliveryError(receipt.outcomeCode ?? "identity_delivery_unconfirmed");
  return receipt;
}

export async function sendEmailVerification(params: {
  to: string;
  token: string;
  tokenRecordId: string;
  firstName?: string | null;
}) {
  const url = identityActionUrl("/verify-email", params.token);
  return sendIdentityEmail({
    to: params.to,
    subject: "Verify your MogulForge GrowthOS email",
    source: { purpose: "email_verification", tokenRecordId: params.tokenRecordId, tokenDigest: createHash("sha256").update(params.token).digest("hex") },
    body: [
      `Hi ${params.firstName?.trim() || "there"},`,
      "",
      "Verify your email address to finish securing your MogulForge GrowthOS account:",
      url,
      "",
      "This single-use link expires in 24 hours.",
      "If you did not create this account, you can ignore this email.",
      "",
      "— MogulForge",
    ].join("\n"),
  });
}

export async function sendPasswordReset(params: {
  to: string;
  token: string;
  tokenRecordId: string;
  firstName?: string | null;
}) {
  const url = identityActionUrl("/reset-password", params.token);
  return sendIdentityEmail({
    to: params.to,
    subject: "Reset your MogulForge GrowthOS password",
    source: { purpose: "password_reset", tokenRecordId: params.tokenRecordId, tokenDigest: createHash("sha256").update(params.token).digest("hex") },
    body: [
      `Hi ${params.firstName?.trim() || "there"},`,
      "",
      "Use this secure link to choose a new MogulForge GrowthOS password:",
      url,
      "",
      "This single-use link expires in 60 minutes and invalidates all older reset links.",
      "If you did not request a password reset, you can ignore this email.",
      "",
      "— MogulForge",
    ].join("\n"),
  });
}

export function reportIdentityEmailFailure(
  purpose: "email_verification" | "password_reset",
  error: unknown,
): void {
  logger.error(
    { purpose, errorCode: error instanceof PlatformEmailDeliveryError ? error.code : "identity_delivery_unconfirmed" },
    "identity email delivery failed",
  );
}
