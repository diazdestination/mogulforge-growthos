import { createHash } from "node:crypto";
import {
  db,
  emailSenderPreferencesTable,
  gmailConnectionsTable,
  microsoftConnectionsTable,
  usersTable,
} from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";
import { hasPermission } from "../lib/permissions";
import {
  getGmailStatus,
  gmailOAuthConfigured,
  sendGmailForUser,
} from "./gmail-oauth";
import {
  getMicrosoftStatus,
  microsoftOAuthConfigured,
  sendMicrosoftForUser,
} from "./microsoft-oauth";
import { assertOutboundDeliveryAllowed } from "./outbound-hold";
import {
  signOutboundReplyEvidence,
  type OutboundReplyContext,
} from "./reply-evidence";
import {
  EmailDispatchBlockedError,
  type EmailDispatchIdentity,
  type EmailDispatchGuard,
} from "./email-dispatch-guard";

export type UserEmailProvider = "gmail" | "microsoft";
export interface UserEmailResult {
  id: string | null;
  provider: UserEmailProvider;
  senderEmail: string;
  acceptance: "accepted";
  providerRequestId?: string | null;
  clientRequestId?: string;
}

export type EmailIdentityReader = Pick<typeof db, "select">;

/**
 * SELECT-only identity read for exact returning-invoice admission. It never
 * refreshes OAuth, decrypts tokens, seeds settings or re-enters the connection
 * pool. An explicit preference gives admission a real row to retain/lock;
 * legacy getUserEmailStatus keeps its existing implicit Gmail behavior.
 */
export async function readUserEmailIdentity(
  reader: EmailIdentityReader,
  organizationId: string,
  userId: string,
  lockRows = false,
) {
  if (lockRows && reader === db) throw new EmailDispatchBlockedError();
  const memberQuery = reader
    .select({
      id: usersTable.id,
      role: usersTable.role,
      verified: usersTable.emailVerifiedAt,
      active: usersTable.isActive,
    })
    .from(usersTable)
    .where(
      and(
        eq(usersTable.organizationId, organizationId),
        eq(usersTable.id, userId),
      ),
    );
  const [member] = await (lockRows ? memberQuery.for("share") : memberQuery);
  if (
    !member?.active ||
    !member.verified ||
    userId.startsWith("invite:") ||
    !hasPermission(member.role, "crm.write")
  )
    throw new EmailDispatchBlockedError();
  const preferenceQuery = reader
    .select()
    .from(emailSenderPreferencesTable)
    .where(
      and(
        eq(emailSenderPreferencesTable.organizationId, organizationId),
        eq(emailSenderPreferencesTable.userId, userId),
      ),
    );
  const [preference] = await (lockRows
    ? preferenceQuery.for("share")
    : preferenceQuery);
  if (!preference || !["gmail", "microsoft"].includes(preference.provider))
    throw new EmailDispatchBlockedError();
  const provider = preference.provider as UserEmailProvider;
  const table =
    provider === "gmail" ? gmailConnectionsTable : microsoftConnectionsTable;
  const connectionQuery = reader
    .select({
      id: table.id,
      email: table.email,
      scopes: table.grantedScopes,
      connectedAt: table.connectedAt,
      revokedAt: table.revokedAt,
      tokenPresent: sql<boolean>`${table.encryptedRefreshToken} is not null and ${table.encryptedRefreshToken} <> ''`,
      accountId:
        provider === "microsoft"
          ? microsoftConnectionsTable.accountId
          : sql<string | null>`null`,
    })
    .from(table)
    .where(
      and(eq(table.organizationId, organizationId), eq(table.userId, userId)),
    );
  const [connection] = await (lockRows
    ? connectionQuery.for("share")
    : connectionQuery);
  const configured =
    provider === "gmail" ? gmailOAuthConfigured() : microsoftOAuthConfigured();
  const scopesValid =
    connection &&
    (provider === "gmail"
      ? connection.scopes.includes("https://www.googleapis.com/auth/gmail.send")
      : ["mail.send", "user.read"].every((scope) =>
          connection.scopes.includes(scope),
        ));
  if (
    !configured ||
    !connection?.tokenPresent ||
    connection.revokedAt ||
    !scopesValid ||
    !connection.email
  )
    throw new EmailDispatchBlockedError();
  const senderEmail = connection.email.trim().toLowerCase();
  // A token refresh is not a mailbox replacement. Do not pin token bytes,
  // updatedAt or lastUsedAt, which the transport legitimately changes itself.
  const identitySha256 = createHash("sha256")
    .update(
      JSON.stringify({
        organizationId,
        userId,
        preferenceId: preference.id,
        provider,
        connectionId: connection.id,
        accountId: connection.accountId,
        senderEmail,
        connectedAt: connection.connectedAt.toISOString(),
        scopes: [...connection.scopes].sort(),
      }),
    )
    .digest("hex");
  return { userId, provider, senderEmail, identitySha256 };
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
  expectedSender?: EmailDispatchIdentity;
  beforeDispatch?: () => Promise<void>;
  /** Opt-in read-only approval check at the transport's last awaited boundary. */
  beforeFinalDispatch?: EmailDispatchGuard;
  /** Server-reserved communication identity; never accepted from message content. */
  outboundParentId?: string;
}): Promise<UserEmailResult> {
  const { assertCustomerLifecycleActive } =
    await import("./customer-lifecycle");
  await assertCustomerLifecycleActive(input.organizationId);
  assertOutboundDeliveryAllowed({ channel: "email", recipient: input.to });
  const status = await getUserEmailStatus(input.organizationId, input.userId);
  if (!status.connected || !status.configured || !status.provider)
    throw new Error(
      status.reason ?? "The selected email sender is unavailable.",
    );
  const expected = input.expectedSender ?? {
    provider: status.provider,
    senderEmail: status.email!,
  };
  const matches = (identity: EmailDispatchIdentity) =>
    identity.provider === expected.provider &&
    identity.senderEmail.trim().toLowerCase() ===
      expected.senderEmail.trim().toLowerCase();
  if (
    !status.email ||
    !matches({ provider: status.provider, senderEmail: status.email })
  )
    throw new EmailDispatchBlockedError();
  const beforeDispatch: EmailDispatchGuard = async (actual) => {
    await input.beforeDispatch?.();
    const current = await getUserEmailStatus(
      input.organizationId,
      input.userId,
    );
    if (
      !matches(actual) ||
      !current.connected ||
      !current.configured ||
      !current.provider ||
      !current.email ||
      !matches({ provider: current.provider, senderEmail: current.email })
    )
      throw new EmailDispatchBlockedError();
    await assertCustomerLifecycleActive(input.organizationId);
    assertOutboundDeliveryAllowed({ channel: "email", recipient: input.to });
  };
  const dispatch = { ...input, beforeDispatch };
  await assertCustomerLifecycleActive(input.organizationId);
  if (status.provider === "microsoft") return sendMicrosoftForUser(dispatch);
  return { ...(await sendGmailForUser(dispatch)), acceptance: "accepted" };
}

/** Correlation IDs are not mailbox message IDs and never imply delivery. */
export function emailAcceptanceEvidence(
  result: {
    id: string | null;
    provider: string;
    providerRequestId?: string | null;
    clientRequestId?: string;
    senderEmail?: string;
  },
  context?: OutboundReplyContext,
) {
  return {
    provider: result.provider,
    providerMessageId: result.id,
    ...(result.senderEmail
      ? { senderEmail: result.senderEmail.trim().toLowerCase() }
      : {}),
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
