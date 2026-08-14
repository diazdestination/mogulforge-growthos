import { logger } from "../lib/logger";

import { isSafeMailbox, transactionalEmailProvider } from "./providers";

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
}): Promise<{ id: string; provider: string }> {
  if (!isSafeMailbox(params.to)) {
    throw new Error("Refusing to send identity email to an invalid mailbox");
  }
  return transactionalEmailProvider.send(
    params.to,
    params.subject,
    params.body,
  );
}

export async function sendEmailVerification(params: {
  to: string;
  token: string;
  firstName?: string | null;
}): Promise<{ id: string; provider: string }> {
  const url = identityActionUrl("/verify-email", params.token);
  return sendIdentityEmail({
    to: params.to,
    subject: "Verify your MogulForge GrowthOS email",
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
  firstName?: string | null;
}): Promise<{ id: string; provider: string }> {
  const url = identityActionUrl("/reset-password", params.token);
  return sendIdentityEmail({
    to: params.to,
    subject: "Reset your MogulForge GrowthOS password",
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
    { purpose, errorName: error instanceof Error ? error.name : typeof error },
    "identity email delivery failed",
  );
}
