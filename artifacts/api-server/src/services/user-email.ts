import { db, emailSenderPreferencesTable, usersTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { hasPermission } from "../lib/permissions";
import { getGmailStatus, sendGmailForUser } from "./gmail-oauth";
import { getMicrosoftStatus, sendMicrosoftForUser } from "./microsoft-oauth";
import { assertOutboundDeliveryAllowed } from "./outbound-hold";
import { signOutboundReplyEvidence, type OutboundReplyContext } from "./reply-evidence";

export type UserEmailProvider = "gmail" | "microsoft";
export interface UserEmailResult {
  id: string | null;
  provider: UserEmailProvider;
  senderEmail: string;
  acceptance: "accepted";
  providerRequestId?: string | null;
  clientRequestId?: string;
}

async function senderActive(organizationId: string, userId: string) {
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
  return Boolean(user && hasPermission(user.role, "crm.write"));
}

export async function getUserEmailStatus(
  organizationId: string,
  userId: string,
) {
  const active = await senderActive(organizationId, userId);
  const [preference] = await db
    .select()
    .from(emailSenderPreferencesTable)
    .where(
      and(
        eq(emailSenderPreferencesTable.organizationId, organizationId),
        eq(emailSenderPreferencesTable.userId, userId),
      ),
    );
  const [gmail, microsoft] = await Promise.all([
    getGmailStatus(organizationId, userId),
    getMicrosoftStatus(organizationId, userId),
  ]);
  // Preserve existing Gmail-only users. A newly connected Microsoft mailbox
  // must be explicitly selected; connecting never switches the sending identity.
  const provider: UserEmailProvider | null = preference
    ? preference.provider === "gmail" || preference.provider === "microsoft"
      ? preference.provider
      : null
    : microsoft.connected
      ? null
      : "gmail";
  const selected =
    provider === "gmail" ? gmail : provider === "microsoft" ? microsoft : null;
  return {
    provider,
    explicitSelection: Boolean(preference),
    senderActive: active,
    configured: Boolean(selected?.configured),
    connected: Boolean(active && selected?.connected),
    email: active ? (selected?.email ?? null) : null,
    reason: !active
      ? "The selected sender is not an active authorized staff member of this company."
      : !provider
        ? "Choose Gmail or Microsoft 365 / Outlook as your sending account in My Profile."
        : !selected?.configured || !selected.connected
          ? `Connect or reconnect your selected ${provider === "gmail" ? "Gmail" : "Microsoft 365 / Outlook"} account in My Profile. No other mailbox will be used.`
          : null,
    gmail: {
      configured: gmail.configured,
      connected: active && gmail.connected,
      email: active ? gmail.email : null,
    },
    microsoft: {
      configured: microsoft.configured,
      connected: active && microsoft.connected,
      email: active ? microsoft.email : null,
    },
  };
}

export async function selectUserEmailProvider(
  organizationId: string,
  userId: string,
  provider: UserEmailProvider,
) {
  if (!(await senderActive(organizationId, userId)))
    throw new Error(
      "An active authorized company member must select their own sender.",
    );
  if (provider !== "gmail" && provider !== "microsoft")
    throw new Error("Unsupported email provider.");
  const selected =
    provider === "gmail"
      ? await getGmailStatus(organizationId, userId)
      : await getMicrosoftStatus(organizationId, userId);
  if (!selected.configured || !selected.connected)
    throw new Error("Connect this mailbox before selecting it as your sender.");
  await db
    .insert(emailSenderPreferencesTable)
    .values({ organizationId, userId, provider })
    .onConflictDoUpdate({
      target: [
        emailSenderPreferencesTable.organizationId,
        emailSenderPreferencesTable.userId,
      ],
      set: { provider, updatedAt: new Date() },
    });
  return getUserEmailStatus(organizationId, userId);
}

export async function sendEmailForUser(input: {
  organizationId: string;
  userId: string;
  to: string;
  subject: string;
  body: string;
}): Promise<UserEmailResult> {
  const { assertCustomerLifecycleActive } = await import("./customer-lifecycle");
  await assertCustomerLifecycleActive(input.organizationId);
  assertOutboundDeliveryAllowed({ channel: "email", recipient: input.to });
  const status = await getUserEmailStatus(input.organizationId, input.userId);
  if (!status.connected || !status.configured || !status.provider)
    throw new Error(
      status.reason ?? "The selected email sender is unavailable.",
    );
  await assertCustomerLifecycleActive(input.organizationId);
  if (status.provider === "microsoft") return sendMicrosoftForUser(input);
  return { ...(await sendGmailForUser(input)), acceptance: "accepted" };
}

/** Correlation IDs are not mailbox message IDs and never imply delivery. */
export function emailAcceptanceEvidence(result: {
  id: string | null;
  provider: string;
  providerRequestId?: string | null;
  clientRequestId?: string;
  senderEmail?: string;
}, context?: OutboundReplyContext) {
  return {
    provider: result.provider,
    providerMessageId: result.id,
    ...(result.senderEmail ? { senderEmail: result.senderEmail.trim().toLowerCase() } : {}),
    ...(context ? signOutboundReplyEvidence(result, context) : {}),
    ...(result.providerRequestId
      ? { providerRequestId: result.providerRequestId }
      : {}),
    ...(result.clientRequestId
      ? { clientRequestId: result.clientRequestId }
      : {}),
    acceptance: "accepted",
    deliveryConfirmed: false,
  };
}
