/**
 * Invite notification email: lets a newly invited teammate know they have
 * access and where to sign in. Send failures are reported to the inviting
 * admin (never silent) but do not roll back the invite itself.
 */
import { logger } from "../lib/logger";

import { isSafeMailbox, transactionalEmailProvider } from "./providers";
import { getOrgSettings } from "./settings";
import { createInviteToken } from "./invite-token";
import { ResendSendError } from "./resend-delivery";

/**
 * Absolute URL of the CRM app the invitee should sign in to.
 * APP_URL wins when set. APP_ORIGIN is the portable deployment-level base;
 * the Replit domain remains a backward-compatible fallback.
 */
export function crmAppUrl(): string {
  const override = process.env.APP_URL?.trim();
  if (override) return override.replace(/\/$/, "");
  const origin = process.env.APP_ORIGIN?.trim();
  if (origin) return origin.replace(/\/$/, "");
  const domain = process.env.REPLIT_DOMAINS?.split(",")[0]?.trim();
  if (domain) return `https://${domain}/crm/`;
  return "http://localhost:5000";
}

export function inviteSignupUrl(params: {
  invitedUserId: string;
  organizationId: string;
  email: string;
  tokenRevision?: string;
}): string {
  const base = crmAppUrl();
  const url = new URL("signup", base.endsWith("/") ? base : `${base}/`);
  url.searchParams.set(
    "invite",
    createInviteToken({
      inviteId: params.invitedUserId,
      organizationId: params.organizationId,
      email: params.email,
      tokenRevision: params.tokenRevision,
    }),
  );
  url.searchParams.set("email", params.email.trim().toLowerCase());
  return url.toString();
}

export interface InviteEmailResult {
  sent: boolean;
  error: string | null;
}

export async function sendInviteEmail(params: {
  invitedUserId: string;
  organizationId: string;
  to: string;
  inviteeFirstName?: string | null;
  inviterName: string;
  role: string;
  tokenRevision?: string;
  shouldSend?: () => Promise<boolean>;
}): Promise<InviteEmailResult> {
  try {
    if (!isSafeMailbox(params.to)) {
      return { sent: false, error: "Invalid recipient email address" };
    }
    const settings = await getOrgSettings(params.organizationId);
    const businessName =
      settings.businessProfile?.businessName?.trim() || "MogulForge";
    const url = inviteSignupUrl({
      invitedUserId: params.invitedUserId,
      organizationId: params.organizationId,
      email: params.to,
      tokenRevision: params.tokenRevision,
    });
    const roleLabel = params.role.replace(/_/g, " ");
    const body = [
      `Hi ${params.inviteeFirstName?.trim() || "there"},`,
      "",
      `${params.inviterName} invited you to join the ${businessName} team as ${roleLabel}.`,
      "",
      `Use this secure invitation link to create your account with ${params.to}:`,
      url,
      "",
      "For your protection, this link expires in 7 days. Your administrator can send a fresh one if needed.",
      "",
      `If you weren't expecting this invitation, you can ignore this email.`,
      "",
      `— ${businessName}`,
    ].join("\n");
    if (params.shouldSend && !(await params.shouldSend()))
      return {
        sent: false,
        error:
          "Invitation delivery is no longer authorized. Refresh the invitation status.",
      };
    await transactionalEmailProvider.send(
      params.to,
      `You've been invited to the ${businessName} team`,
      body,
    );
    return { sent: true, error: null };
  } catch (err) {
    const failure = err instanceof ResendSendError ? err : undefined;
    logger.error(
      {
        errorCode: failure?.code ?? "invite_email_unconfirmed",
        outcome: failure?.outcome ?? "unknown",
        httpStatus: failure?.httpStatus,
      },
      "invite: email delivery was not confirmed",
    );
    return {
      sent: false,
      error:
        failure?.message ??
        "Invitation email was not confirmed. Ask an administrator to check email configuration and delivery status before sending again.",
    };
  }
}
