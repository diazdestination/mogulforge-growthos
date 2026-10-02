import { randomBytes } from "node:crypto";

import {
  db,
  gmailConnectionsTable,
  oauthTransactionsTable,
  usersTable,
  type GmailConnection,
} from "@workspace/db";
import { and, eq, gt, isNull } from "drizzle-orm";
import { CodeChallengeMethod, OAuth2Client } from "google-auth-library";

import {
  decryptSecret,
  encryptSecret,
  sha256Base64Url,
} from "../lib/token-encryption";
import { isSafeMailbox } from "./providers";
import { assertOutboundDeliveryAllowed } from "./outbound-hold";
import { hasPermission } from "../lib/permissions";
import { assertCustomerLifecycleActive } from "./customer-lifecycle";
import { EmailDispatchBlockedError, runEmailDispatchGuard, type EmailDispatchGuard } from "./email-dispatch-guard";

const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";
const IDENTITY_SCOPES = ["openid", "email", "profile"];
const OAUTH_TTL_MS = 10 * 60 * 1000;
export const GMAIL_REAUTH_REQUIRED = "gmail_reauthorization_required";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function errorText(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number") return String(value);
  return null;
}

export function classifyGmailProviderError(error: unknown): {
  code: string;
  reconnectRequired: boolean;
} {
  const root = asRecord(error);
  const response = asRecord(root?.response);
  const data = asRecord(response?.data);
  const providerError = asRecord(data?.error);
  const fragments = [
    error instanceof Error ? error.name : null,
    error instanceof Error ? error.message : null,
    errorText(root?.code),
    errorText(response?.status),
    errorText(data?.error),
    errorText(data?.error_description),
    errorText(data?.message),
    errorText(providerError?.code),
    errorText(providerError?.status),
    errorText(providerError?.message),
  ].filter((value): value is string => Boolean(value));
  const normalized = fragments.join(" ").toLowerCase();
  const status = Number(response?.status ?? root?.code ?? providerError?.code);
  const reconnectRequired =
    status === 401 ||
    [
      "invalid_grant",
      "invalid_token",
      "unauthenticated",
      "insufficient_scope",
      "insufficientpermissions",
      "token has been expired or revoked",
      "token has been revoked",
      "login required",
    ].some((marker) => normalized.includes(marker));
  const providerCode =
    errorText(data?.error) ??
    errorText(providerError?.status) ??
    errorText(root?.code) ??
    (error instanceof Error ? error.name : null) ??
    "gmail_send_failed";
  return {
    code: reconnectRequired ? GMAIL_REAUTH_REQUIRED : providerCode.slice(0, 120),
    reconnectRequired,
  };
}

function oauthConfig() {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET?.trim();
  const appBaseUrl = (process.env.APP_BASE_URL ?? process.env.APP_ORIGIN)
    ?.trim()
    .replace(/\/$/, "");
  const redirectUri =
    process.env.GOOGLE_OAUTH_REDIRECT_URI?.trim() ||
    (appBaseUrl ? `${appBaseUrl}/api/v1/integrations/gmail/callback` : undefined);
  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error(
      "Gmail OAuth is not configured (GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, and APP_BASE_URL/APP_ORIGIN or GOOGLE_OAUTH_REDIRECT_URI are required)",
    );
  }
  return { clientId, clientSecret, redirectUri };
}

function client(): OAuth2Client {
  const config = oauthConfig();
  return new OAuth2Client(config.clientId, config.clientSecret, config.redirectUri);
}

function credentialContext(organizationId: string, userId: string): string {
  return `${organizationId}:${userId}:gmail`;
}

function safeReturnPath(value: string | undefined): string {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return "/settings";
  return value.slice(0, 500);
}

export function gmailOAuthConfigured(): boolean {
  try {
    oauthConfig();
    return Boolean(process.env.OAUTH_TOKEN_ENCRYPTION_KEY?.trim());
  } catch {
    return false;
  }
}

export async function getGmailConnection(
  organizationId: string,
  userId: string,
): Promise<GmailConnection | null> {
  const [connection] = await db
    .select()
    .from(gmailConnectionsTable)
    .where(
      and(
        eq(gmailConnectionsTable.organizationId, organizationId),
        eq(gmailConnectionsTable.userId, userId),
        isNull(gmailConnectionsTable.revokedAt),
      ),
    );
  return connection ?? null;
}

async function getStoredGmailConnection(
  organizationId: string,
  userId: string,
): Promise<GmailConnection | null> {
  const [connection] = await db
    .select()
    .from(gmailConnectionsTable)
    .where(
      and(
        eq(gmailConnectionsTable.organizationId, organizationId),
        eq(gmailConnectionsTable.userId, userId),
      ),
    );
  return connection ?? null;
}

export async function getGmailStatus(organizationId: string, userId: string) {
  const [connection, sender] = await Promise.all([
    getStoredGmailConnection(organizationId, userId),
    db
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(
        and(
          eq(usersTable.id, userId),
          eq(usersTable.organizationId, organizationId),
          eq(usersTable.isActive, true),
        ),
      )
      .then((rows) => rows[0] ?? null),
  ]);
  const senderActive = Boolean(sender);
  return {
    configured: gmailOAuthConfigured(),
    connected: Boolean(
      senderActive && connection?.encryptedRefreshToken && !connection.revokedAt && connection.grantedScopes.includes(GMAIL_SEND_SCOPE),
    ),
    senderActive,
    email: connection?.email ?? null,
    connectedAt: connection?.connectedAt ?? null,
    lastUsedAt: connection?.lastUsedAt ?? null,
    lastErrorAt: connection?.lastErrorAt ?? null,
    lastErrorCode: connection?.lastErrorCode ?? null,
    scope: GMAIL_SEND_SCOPE,
  };
}

export async function beginGmailOAuth(input: {
  organizationId: string;
  userId: string;
  returnPath?: string;
}): Promise<string> {
  return beginGoogleOAuth({ ...input, module: "gmail_send", scopes: [GMAIL_SEND_SCOPE] });
}

export async function beginGoogleOAuth(input: {
  organizationId: string;
  userId: string;
  module: string;
  scopes: string[];
  returnPath?: string;
}): Promise<string> {
  const oauth = client();
  // Reading the encryption key now fails before we create an unusable flow.
  const context = credentialContext(input.organizationId, input.userId);
  const state = randomBytes(32).toString("base64url");
  const codeVerifier = randomBytes(64).toString("base64url");
  const codeChallenge = sha256Base64Url(codeVerifier);
  await db.insert(oauthTransactionsTable).values({
    organizationId: input.organizationId,
    userId: input.userId,
    provider: "gmail",
    module: input.module,
    requestedScopes: input.scopes,
    stateHash: sha256Base64Url(state),
    encryptedCodeVerifier: encryptSecret(codeVerifier, `${context}:oauth`),
    returnPath: safeReturnPath(input.returnPath),
    expiresAt: new Date(Date.now() + OAUTH_TTL_MS),
  });
  return oauth.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: true,
    scope: [...IDENTITY_SCOPES, ...input.scopes],
    state,
    code_challenge: codeChallenge,
    code_challenge_method: CodeChallengeMethod.S256,
  });
}

export async function completeGmailOAuth(input: {
  organizationId: string;
  userId: string;
  state: string;
  code: string;
}): Promise<{ email: string; returnPath: string; module: string }> {
  const now = new Date();
  const [transaction] = await db
    .select()
    .from(oauthTransactionsTable)
    .where(
      and(
        eq(oauthTransactionsTable.stateHash, sha256Base64Url(input.state)),
        eq(oauthTransactionsTable.provider, "gmail"),
        eq(oauthTransactionsTable.organizationId, input.organizationId),
        eq(oauthTransactionsTable.userId, input.userId),
        isNull(oauthTransactionsTable.consumedAt),
        gt(oauthTransactionsTable.expiresAt, now),
      ),
    );
  if (!transaction) throw new Error("Gmail connection request expired or was already used");

  // Consume before the provider exchange. A failed exchange must be restarted,
  // preventing the same authorization response from being replayed.
  await db
    .update(oauthTransactionsTable)
    .set({ consumedAt: now })
    .where(eq(oauthTransactionsTable.id, transaction.id));

  const config = oauthConfig();
  const oauth = client();
  const context = credentialContext(input.organizationId, input.userId);
  const codeVerifier = decryptSecret(
    transaction.encryptedCodeVerifier,
    `${context}:oauth`,
  );
  const { tokens } = await oauth.getToken({
    code: input.code,
    codeVerifier,
    redirect_uri: config.redirectUri,
  });
  if (!tokens.id_token) throw new Error("Google did not return an identity token");
  const ticket = await oauth.verifyIdToken({
    idToken: tokens.id_token,
    audience: config.clientId,
  });
  const identity = ticket.getPayload();
  const email = identity?.email?.toLowerCase();
  if (!email || identity?.email_verified !== true || !isSafeMailbox(email)) {
    throw new Error("Google account email could not be verified");
  }

  const existing = await getGmailConnection(input.organizationId, input.userId);
  const encryptedRefreshToken = tokens.refresh_token
    ? encryptSecret(tokens.refresh_token, context)
    : existing?.encryptedRefreshToken;
  if (!encryptedRefreshToken) {
    throw new Error("Google did not issue offline access; disconnect the app in Google and try again");
  }
  const grantedScopes = Array.from(new Set([
    ...(existing?.grantedScopes ?? []),
    ...(tokens.scope ?? [...IDENTITY_SCOPES, ...transaction.requestedScopes].join(" "))
    .split(/\s+/)
    .filter(Boolean),
  ]));
  if (!transaction.requestedScopes.every((scope) => grantedScopes.includes(scope))) {
    throw new Error("The requested Google permission was not granted");
  }

  await db
    .insert(gmailConnectionsTable)
    .values({
      organizationId: input.organizationId,
      userId: input.userId,
      email,
      encryptedRefreshToken,
      grantedScopes,
      connectedAt: now,
      revokedAt: null,
      lastErrorAt: null,
      lastErrorCode: null,
    })
    .onConflictDoUpdate({
      target: [gmailConnectionsTable.organizationId, gmailConnectionsTable.userId],
      set: {
        email,
        encryptedRefreshToken,
        grantedScopes,
        connectedAt: now,
        revokedAt: null,
        lastErrorAt: null,
        lastErrorCode: null,
        updatedAt: now,
      },
    });
  return {
    email,
    returnPath: safeReturnPath(transaction.returnPath),
    module: transaction.module,
  };
}

export async function sendGmailForUser(input: {
  organizationId: string;
  userId: string;
  to: string;
  subject: string;
  body: string;
  beforeDispatch?: EmailDispatchGuard;
}): Promise<{ id: string; provider: "gmail"; senderEmail: string }> {
  assertOutboundDeliveryAllowed({ channel: "email", recipient: input.to });
  if (!isSafeMailbox(input.to)) throw new Error("Refusing to send email: invalid recipient address");
  const [sender] = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(
      and(
        eq(usersTable.id, input.userId),
        eq(usersTable.organizationId, input.organizationId),
        eq(usersTable.isActive, true),
      ),
    );
  if (!sender) {
    throw new Error("Gmail sender account is not active");
  }
  const connection = await getGmailConnection(input.organizationId, input.userId);
  if (!connection?.encryptedRefreshToken || !connection.grantedScopes.includes(GMAIL_SEND_SCOPE)) {
    throw new Error("Connect your Gmail account before sending this BIE action");
  }
  const oauth = client();
  oauth.setCredentials({
    refresh_token: decryptSecret(
      connection.encryptedRefreshToken,
      credentialContext(input.organizationId, input.userId),
    ),
  });
  const raw = Buffer.from(
    [
      `From: ${connection.email}`,
      `To: ${input.to}`,
      `Subject: =?UTF-8?B?${Buffer.from(input.subject, "utf8").toString("base64")}?=`,
      "MIME-Version: 1.0",
      'Content-Type: text/plain; charset="UTF-8"',
      "Content-Transfer-Encoding: 8bit",
      "",
      input.body,
    ].join("\r\n"),
    "utf8",
  ).toString("base64url");
  try {
    // Finish token refresh before the final guard, not after its approval.
    const { token: accessToken } = await oauth.getAccessToken();
    if (!accessToken) throw new EmailDispatchBlockedError();
    await runEmailDispatchGuard(input.beforeDispatch, { provider: "gmail", senderEmail: connection.email });
    const current = await getGmailConnection(input.organizationId, input.userId);
    const [member] = await db.select({ role: usersTable.role }).from(usersTable).where(and(
      eq(usersTable.id, input.userId), eq(usersTable.organizationId, input.organizationId), eq(usersTable.isActive, true),
    ));
    if (!current || current.id !== connection.id || current.email !== connection.email ||
        current.encryptedRefreshToken !== connection.encryptedRefreshToken ||
        !current.grantedScopes.includes(GMAIL_SEND_SCOPE) || !member || !hasPermission(member.role, "crm.write"))
      throw new EmailDispatchBlockedError();
    await assertCustomerLifecycleActive(input.organizationId);
    assertOutboundDeliveryAllowed({ channel: "email", recipient: input.to });
    // OAuth2Client.request has its own 401/403 refresh-and-replay loop, outside
    // Gaxios's retry:false setting. Irreversible sends must not enter that loop
    // or acquire a new token after the final approval. Dispatch the frozen token
    // exactly once through the bare transport; redirects are retries too.
    const response = await oauth.transporter.request<{ id?: string }>({
      url: "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}` },
      data: { raw },
      retry: false,
      maxRedirects: 0,
      timeout: 10_000,
    });
    if (!response.data.id) throw new Error("Gmail returned no message id");
    await db
      .update(gmailConnectionsTable)
      .set({ lastUsedAt: new Date(), lastErrorAt: null, lastErrorCode: null })
      .where(eq(gmailConnectionsTable.id, connection.id));
    return { id: response.data.id, provider: "gmail", senderEmail: connection.email };
  } catch (error) {
    if (error instanceof EmailDispatchBlockedError) throw error;
    const failure = classifyGmailProviderError(error);
    const failedAt = new Date();
    await db
      .update(gmailConnectionsTable)
      .set(
        failure.reconnectRequired
          ? {
              encryptedRefreshToken: null,
              revokedAt: failedAt,
              lastErrorAt: failedAt,
              lastErrorCode: failure.code,
              updatedAt: failedAt,
            }
          : { lastErrorAt: failedAt, lastErrorCode: failure.code, updatedAt: failedAt },
      )
      .where(eq(gmailConnectionsTable.id, connection.id));
    if (failure.reconnectRequired) {
      throw new Error("Gmail authorization expired or was revoked. Reconnect Gmail and try again.");
    }
    throw error;
  }
}

export async function disconnectGmail(
  organizationId: string,
  userId: string,
): Promise<boolean> {
  const connection = await getGmailConnection(organizationId, userId);
  if (!connection) return false;
  if (connection.encryptedRefreshToken) {
    try {
      const oauth = client();
      await oauth.revokeToken(
        decryptSecret(
          connection.encryptedRefreshToken,
          credentialContext(organizationId, userId),
        ),
      );
    } catch (error) {
      // Local credential removal is mandatory even if Google is unavailable.
      console.warn(
        "[gmail] Google token revocation failed; removing local credential:",
        error instanceof Error ? error.message : error,
      );
    }
  }
  await db
    .update(gmailConnectionsTable)
    .set({
      encryptedRefreshToken: null,
      revokedAt: new Date(),
      lastErrorAt: null,
      lastErrorCode: null,
      updatedAt: new Date(),
    })
    .where(eq(gmailConnectionsTable.id, connection.id));
  return true;
}
