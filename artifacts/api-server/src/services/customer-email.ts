import { db, leadsTable, usersTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { hasPermission } from "../lib/permissions";
import { logger } from "../lib/logger";
import { recordAudit } from "./audit";
import {
  getUserEmailStatus,
  sendEmailForUser,
  emailAcceptanceEvidence,
} from "./user-email";
import { assertOutboundDeliveryAllowed } from "./outbound-hold";
import { getOrgSettings } from "./settings";

export interface CustomerEmailContext {
  organizationId: string;
  leadId?: string | null;
}

/** An admin may designate only an active, authorized member of this company. */
export async function assertCustomerEmailSender(
  organizationId: string,
  userId: string,
): Promise<void> {
  const [user] = await db
    .select({ role: usersTable.role })
    .from(usersTable)
    .where(
      and(
        eq(usersTable.id, userId),
        eq(usersTable.organizationId, organizationId),
        eq(usersTable.isActive, true),
      ),
    );
  if (!user || !hasPermission(user.role, "crm.write")) {
    throw new Error(
      "Customer email sender must be an active staff member of this company with permission to contact customers.",
    );
  }
  const status = await getUserEmailStatus(organizationId, userId);
  if (!status.configured || !status.connected) {
    throw new Error(
      status.reason ??
        "The selected customer email sender must connect Gmail or Microsoft 365 / Outlook with permission to send email.",
    );
  }
}

/**
 * An assigned lead keeps its identity even when that connection fails. The
 * explicit company default is used only for an unassigned lead or a send with
 * no lead (for example a portal sign-in code). Never pick an arbitrary member.
 */
async function resolveSender(context: CustomerEmailContext) {
  if (!context?.organizationId)
    throw new Error("Customer email requires a company context.");
  let userId: string | null = null;
  let source: "lead_assignee" | "company_default" = "company_default";
  if (context.leadId) {
    const [lead] = await db
      .select({ assignedUserId: leadsTable.assignedUserId })
      .from(leadsTable)
      .where(
        and(
          eq(leadsTable.id, context.leadId),
          eq(leadsTable.organizationId, context.organizationId),
        ),
      );
    if (!lead)
      throw new Error("Customer email lead is not available in this company.");
    userId = lead.assignedUserId;
    if (userId) source = "lead_assignee";
  }
  if (!userId)
    userId = (await getOrgSettings(context.organizationId))
      .customerEmailSenderUserId;
  if (!userId)
    throw new Error(
      "Choose a customer email sender in Settings > Automations, or assign this lead to a staff member with their selected email account connected.",
    );
  await assertCustomerEmailSender(context.organizationId, userId);
  return { userId, source };
}

export async function getCustomerEmailStatus(organizationId: string) {
  const settings = await getOrgSettings(organizationId);
  const userId = settings.customerEmailSenderUserId;
  if (!userId)
    return {
      provider: "disabled" as const,
      senderEmail: null,
      senderUserId: null,
      reason:
        "No company sender selected. Assigned leads use their assigned staff member's selected email account; portal codes and unassigned customer email remain blocked.",
    };
  try {
    await assertCustomerEmailSender(organizationId, userId);
    const status = await getUserEmailStatus(organizationId, userId);
    return {
      provider: status.provider!,
      senderEmail: status.email,
      senderUserId: userId,
      reason: null,
    };
  } catch (error) {
    return {
      provider: "disabled" as const,
      senderEmail: null,
      senderUserId: userId,
      reason:
        error instanceof Error
          ? error.message
          : "Customer email sender is unavailable.",
    };
  }
}

export async function sendCustomerEmail(
  input: CustomerEmailContext & {
    to: string;
    subject: string;
    body: string;
  },
) {
  assertOutboundDeliveryAllowed({ channel: "email", recipient: input.to });
  const sender = await resolveSender(input);
  // The lower-level adapter rechecks active org membership and the exact
  // credential at dispatch. Errors propagate; there is no alternate mailbox.
  const result = await sendEmailForUser({
    organizationId: input.organizationId,
    userId: sender.userId,
    to: input.to,
    subject: input.subject,
    body: input.body,
  });
  await recordAudit({
    organizationId: input.organizationId,
    actorUserId: sender.userId,
    action: "customer_email.provider_accepted",
    entityType: input.leadId ? "lead" : "organization",
    entityId: input.leadId ?? input.organizationId,
    metadata: {
      ...emailAcceptanceEvidence(result),
      senderUserId: sender.userId,
      senderSource: sender.source,
    },
  }).catch(() =>
    logger.error(
      { organizationId: input.organizationId, providerMessageId: result.id },
      "Customer email acceptance audit could not be recorded",
    ),
  );
  return { ...result, senderUserId: sender.userId };
}
