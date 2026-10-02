import { randomBytes, randomUUID } from "node:crypto";
import {
  db,
  microsoftConnectionsTable,
  oauthTransactionsTable,
  usersTable,
  type MicrosoftConnection,
} from "@workspace/db";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import {
  decryptSecret,
  encryptSecret,
  sha256Base64Url,
} from "../lib/token-encryption";
import { hasPermission } from "../lib/permissions";
import { isSafeMailbox } from "./providers";
import { assertOutboundDeliveryAllowed } from "./outbound-hold";
import { assertCustomerLifecycleActive, CustomerLifecycleHoldError } from "./customer-lifecycle";
import { EmailDispatchBlockedError, runEmailDispatchGuard, type EmailDispatchGuard } from "./email-dispatch-guard";

export const MICROSOFT_SCOPES = [
  "https://graph.microsoft.com/Mail.Send",
  "https://graph.microsoft.com/User.Read",
  "offline_access",
];
export const MICROSOFT_REAUTH_REQUIRED = "microsoft_reauthorization_required";
const TIMEOUT_MS = 10_000;
const GRAPH = "https://graph.microsoft.com/v1.0";
const TTL_MS = 10 * 60_000;
type Actor = { organizationId: string; userId: string };
const context = ({ organizationId, userId }: Actor) =>
  `${organizationId}:${userId}:microsoft`;
const returnPath = (value?: string | null) =>
  value === "/settings" ? "/settings" : "/account";
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};

export class MicrosoftMailError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly reconnectRequired = false,
    public readonly outcomeUnknown = false,
  ) {
    super(message);
    this.name = "MicrosoftMailError";
  }
}
const unavailable = () =>
  new MicrosoftMailError(
    "microsoft_unavailable",
    "Microsoft email is unavailable. No alternative mailbox was used.",
  );
const revoked = () =>
  new MicrosoftMailError(
    MICROSOFT_REAUTH_REQUIRED,
    "Microsoft authorization is unavailable or revoked. Reconnect the selected account.",
    true,
  );

export function microsoftOAuthConfig() {
  const clientId = process.env.MICROSOFT_OAUTH_CLIENT_ID?.trim();
  const clientSecret = process.env.MICROSOFT_OAUTH_CLIENT_SECRET?.trim();
  const tenant = process.env.MICROSOFT_OAUTH_TENANT_ID?.trim() || "common";
  let origin: URL;
  try {
    origin = new URL(process.env.APP_ORIGIN ?? "");
  } catch {
    throw unavailable();
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(
    origin.hostname,
  );
  if (
    !clientId ||
    !clientSecret ||
    !/^(common|organizations|consumers|[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12})$/i.test(
      tenant,
    ) ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash ||
    (origin.protocol !== "https:" &&
      !(
        origin.protocol === "http:" &&
        loopback &&
        process.env.NODE_ENV !== "production"
      ))
  )
    throw unavailable();
  return {
    clientId,
    clientSecret,
    authority: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0`,
    redirectUri: `${origin.origin}/api/v1/integrations/microsoft/callback`,
  };
}

export function microsoftOAuthConfigured() {
  try {
    microsoftOAuthConfig();
    encryptSecret("configuration-check", "microsoft:configuration");
    return true;
  } catch {
    return false;
  }
}

async function activeMember(
  actor: Actor,
  executor: Pick<typeof db, "select"> = db,
) {
  const [user] = await executor
    .select({ role: usersTable.role })
    .from(usersTable)
    .where(
      and(
        eq(usersTable.id, actor.userId),
        eq(usersTable.organizationId, actor.organizationId),
        eq(usersTable.isActive, true),
      ),
    );
  return Boolean(user && hasPermission(user.role, "crm.write"));
}
async function requireMember(
  actor: Actor,
  executor: Pick<typeof db, "select"> = db,
) {
  if (!(await activeMember(actor, executor)))
    throw new MicrosoftMailError(
      "microsoft_sender_inactive",
      "The selected sender is not an active authorized member of this company.",
    );
}
const connectionWhere = (actor: Actor) =>
  and(
    eq(microsoftConnectionsTable.organizationId, actor.organizationId),
    eq(microsoftConnectionsTable.userId, actor.userId),
  );
const transactionWhere = (actor: Actor) =>
  and(
    eq(oauthTransactionsTable.organizationId, actor.organizationId),
    eq(oauthTransactionsTable.userId, actor.userId),
    eq(oauthTransactionsTable.provider, "microsoft"),
  );
const lock = (actor: Actor) =>
  sql`SELECT pg_advisory_xact_lock(hashtext(${`microsoft-oauth:${actor.organizationId}:${actor.userId}`}))`;
const scopesFrom = (value: string) => [
  ...new Set(
    value
      .split(/\s+/)
      .filter(Boolean)
      .map((scope) =>
        scope.replace(/^https:\/\/graph\.microsoft\.com\//i, "").toLowerCase(),
      ),
  ),
];
const scopesValid = (scopes: string[]) =>
  ["mail.send", "user.read"].every((scope) => scopes.includes(scope));

export async function getMicrosoftConnection(
  organizationId: string,
  userId: string,
) {
  const [connection] = await db
    .select()
    .from(microsoftConnectionsTable)
    .where(
      and(
        connectionWhere({ organizationId, userId }),
        isNull(microsoftConnectionsTable.revokedAt),
      ),
    );
  return connection ?? null;
}
export async function getMicrosoftStatus(
  organizationId: string,
  userId: string,
) {
  const actor = { organizationId, userId };
  const senderActive = await activeMember(actor);
  const [connection] = senderActive
    ? await db
        .select()
        .from(microsoftConnectionsTable)
        .where(connectionWhere(actor))
    : [];
  return {
    configured: microsoftOAuthConfigured(),
    senderActive,
    connected: Boolean(
      connection?.encryptedRefreshToken &&
      !connection.revokedAt &&
      scopesValid(connection.grantedScopes),
    ),
    email: connection?.email ?? null,
    connectedAt: connection?.connectedAt ?? null,
    lastUsedAt: connection?.lastUsedAt ?? null,
    lastErrorAt: connection?.lastErrorAt ?? null,
    lastErrorCode: connection?.lastErrorCode ?? null,
    scopes: ["Mail.Send", "User.Read", "offline_access"],
  };
}

export async function beginMicrosoftOAuth(
  input: Actor & { returnPath?: string },
) {
  await requireMember(input);
  const config = microsoftOAuthConfig();
  const state = randomBytes(32).toString("base64url");
  const verifier = randomBytes(64).toString("base64url");
  const encryptedCodeVerifier = encryptSecret(
    verifier,
    `${context(input)}:oauth`,
  );
  await db.transaction(async (tx) => {
    await tx.execute(lock(input));
    await requireMember(input, tx);
    // Superseding a pending flow also prevents an older in-flight callback from
    // reconnecting a mailbox after the user starts a newer flow/disconnects.
    await tx.delete(oauthTransactionsTable).where(transactionWhere(input));
    await tx
      .insert(oauthTransactionsTable)
      .values({
        ...input,
        provider: "microsoft",
        module: "mail_send",
        requestedScopes: MICROSOFT_SCOPES,
        stateHash: sha256Base64Url(state),
        encryptedCodeVerifier,
        returnPath: returnPath(input.returnPath),
        expiresAt: new Date(Date.now() + TTL_MS),
      });
  });
  const url = new URL(`${config.authority}/authorize`);
  url.search = new URLSearchParams({
    client_id: config.clientId,
    response_type: "code",
    response_mode: "query",
    redirect_uri: config.redirectUri,
    scope: MICROSOFT_SCOPES.join(" "),
    state,
    code_challenge: sha256Base64Url(verifier),
    code_challenge_method: "S256",
    prompt: "select_account",
  }).toString();
  return url.toString();
}

async function request(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw unavailable();
  }
}
async function json(response: Response) {
  try {
    return record(await response.json());
  } catch {
    throw unavailable();
  }
}
async function exchangeToken(fields: Record<string, string>) {
  const config = microsoftOAuthConfig();
  const response = await request(`${config.authority}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      scope: MICROSOFT_SCOPES.join(" "),
      ...fields,
    }),
  });
  const tokens = await json(response);
  if (!response.ok) {
    if (
      ["invalid_grant", "interaction_required", "invalid_scope"].includes(
        String(tokens.error),
      ) ||
      response.status === 401
    )
      throw revoked();
    throw unavailable();
  }
  if (
    typeof tokens.access_token !== "string" ||
    !tokens.access_token ||
    tokens.access_token.length > 30_000 ||
    String(tokens.token_type).toLowerCase() !== "bearer"
  )
    throw unavailable();
  const scopes = scopesFrom(
    typeof tokens.scope === "string"
      ? tokens.scope
      : MICROSOFT_SCOPES.join(" "),
  );
  if (!scopesValid(scopes)) throw revoked();
  return {
    accessToken: tokens.access_token,
    refreshToken:
      typeof tokens.refresh_token === "string" &&
      tokens.refresh_token.length <= 30_000
        ? tokens.refresh_token
        : null,
    scopes,
  };
}
async function mailbox(accessToken: string) {
  const response = await request(
    `${GRAPH}/me?$select=id,mail,userPrincipalName`,
    { headers: { authorization: `Bearer ${accessToken}` } },
  );
  if (!response.ok) {
    if ([401, 403].includes(response.status)) throw revoked();
    throw unavailable();
  }
  const profile = await json(response);
  const email = (
    typeof profile.mail === "string"
      ? profile.mail
      : typeof profile.userPrincipalName === "string"
        ? profile.userPrincipalName
        : ""
  )
    .trim()
    .toLowerCase();
  if (
    typeof profile.id !== "string" ||
    !/^[a-z\d_-]{1,256}$/i.test(profile.id) ||
    !isSafeMailbox(email)
  )
    throw unavailable();
  return { accountId: profile.id, email };
}

export async function completeMicrosoftOAuth(
  input: Actor & { state: string; code: string },
) {
  await requireMember(input);
  if (
    !input.state ||
    input.state.length > 512 ||
    !input.code ||
    input.code.length > 10_000
  )
    throw unavailable();
  const now = new Date();
  // Atomic consume, not select-then-update: concurrent callbacks cannot exchange twice.
  const [transaction] = await db
    .update(oauthTransactionsTable)
    .set({ consumedAt: now })
    .where(
      and(
        transactionWhere(input),
        eq(oauthTransactionsTable.module, "mail_send"),
        eq(oauthTransactionsTable.stateHash, sha256Base64Url(input.state)),
        isNull(oauthTransactionsTable.consumedAt),
        gt(oauthTransactionsTable.expiresAt, now),
      ),
    )
    .returning();
  if (!transaction)
    throw new MicrosoftMailError(
      "microsoft_oauth_expired",
      "Microsoft connection request expired or was already used. Start a new connection.",
    );
  const verifier = decryptSecret(
    transaction.encryptedCodeVerifier,
    `${context(input)}:oauth`,
  );
  const tokens = await exchangeToken({
    grant_type: "authorization_code",
    code: input.code,
    code_verifier: verifier,
    redirect_uri: microsoftOAuthConfig().redirectUri,
  });
  if (!tokens.refreshToken)
    throw new MicrosoftMailError(
      "microsoft_offline_access_missing",
      "Microsoft did not grant offline access. Restart the connection and grant the requested permissions.",
    );
  const identity = await mailbox(tokens.accessToken);
  const encryptedRefreshToken = encryptSecret(
    tokens.refreshToken,
    context(input),
  );
  await db.transaction(async (tx) => {
    await tx.execute(lock(input));
    await requireMember(input, tx);
    const [current] = await tx
      .select({ id: oauthTransactionsTable.id })
      .from(oauthTransactionsTable)
      .where(
        and(
          eq(oauthTransactionsTable.id, transaction.id),
          transactionWhere(input),
          eq(oauthTransactionsTable.consumedAt, now),
        ),
      );
    if (!current)
      throw new MicrosoftMailError(
        "microsoft_oauth_cancelled",
        "This Microsoft connection was cancelled or replaced. Start a new connection.",
      );
    const values = {
      ...identity,
      encryptedRefreshToken,
      grantedScopes: tokens.scopes,
      connectedAt: now,
      revokedAt: null,
      lastErrorAt: null,
      lastErrorCode: null,
      updatedAt: now,
    };
    await tx
      .insert(microsoftConnectionsTable)
      .values({
        organizationId: input.organizationId,
        userId: input.userId,
        ...values,
      })
      .onConflictDoUpdate({
        target: [
          microsoftConnectionsTable.organizationId,
          microsoftConnectionsTable.userId,
        ],
        set: values,
      });
    await tx
      .delete(oauthTransactionsTable)
      .where(eq(oauthTransactionsTable.id, transaction.id));
  });
  return {
    email: identity.email,
    returnPath: returnPath(transaction.returnPath),
  };
}

export async function disconnectMicrosoft(
  organizationId: string,
  userId: string,
) {
  const actor = { organizationId, userId };
  return db.transaction(async (tx) => {
    await tx.execute(lock(actor));
    await tx.delete(oauthTransactionsTable).where(transactionWhere(actor));
    const removed = await tx
      .update(microsoftConnectionsTable)
      .set({
        encryptedRefreshToken: null,
        revokedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(connectionWhere(actor))
      .returning({ id: microsoftConnectionsTable.id });
    return {
      disconnected: removed.length > 0,
      remoteConsentRevoked: false as const,
    };
  });
}

export async function sendMicrosoftForUser(
  input: Actor & { to: string; subject: string; body: string; beforeDispatch?: EmailDispatchGuard },
) {
  assertOutboundDeliveryAllowed({ channel: "email", recipient: input.to });
  if (
    !isSafeMailbox(input.to) ||
    !input.subject.trim() ||
    input.subject.length > 1000 ||
    !input.body.trim() ||
    input.body.length > 1_000_000
  )
    throw new MicrosoftMailError(
      "microsoft_invalid_message",
      "Email recipient, subject, or body is invalid.",
    );
  await requireMember(input);
  await assertCustomerLifecycleActive(input.organizationId);
  const connection = await getMicrosoftConnection(
    input.organizationId,
    input.userId,
  );
  if (
    !connection?.encryptedRefreshToken ||
    !scopesValid(connection.grantedScopes)
  )
    throw revoked();
  let selected: MicrosoftConnection = connection;
  let dispatched = false;
  try {
    const tokens = await exchangeToken({
      grant_type: "refresh_token",
      refresh_token: decryptSecret(
        connection.encryptedRefreshToken,
        context(input),
      ),
    });
    const identity = await mailbox(tokens.accessToken);
    if (
      identity.accountId !== connection.accountId ||
      identity.email !== connection.email
    )
      throw revoked();
    const encryptedRefreshToken = tokens.refreshToken
      ? encryptSecret(tokens.refreshToken, context(input))
      : connection.encryptedRefreshToken;
    const [updated] = await db
      .update(microsoftConnectionsTable)
      .set({
        encryptedRefreshToken,
        grantedScopes: tokens.scopes,
        updatedAt: new Date(),
      })
      .where(
        and(
          connectionWhere(input),
          eq(microsoftConnectionsTable.id, connection.id),
          eq(
            microsoftConnectionsTable.encryptedRefreshToken,
            connection.encryptedRefreshToken,
          ),
          isNull(microsoftConnectionsTable.revokedAt),
        ),
      )
      .returning();
    if (!updated) throw revoked();
    selected = updated;
    await runEmailDispatchGuard(input.beforeDispatch, { provider: "microsoft", senderEmail: selected.email });
    await requireMember(input);
    const current = await getMicrosoftConnection(
      input.organizationId,
      input.userId,
    );
    if (
      !current ||
      current.encryptedRefreshToken !== selected.encryptedRefreshToken
    )
      throw revoked();
    // Recheck holds immediately at dispatch; no fallback or automatic send retry.
    // Token refresh and mailbox validation can outlive a company's pause request.
    // They are preparation, not acceptance of the customer email by Microsoft.
    await assertCustomerLifecycleActive(input.organizationId);
    assertOutboundDeliveryAllowed({ channel: "email", recipient: input.to });
    const clientRequestId = randomUUID();
    dispatched = true;
    const response = await request(`${GRAPH}/me/sendMail`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${tokens.accessToken}`,
        "content-type": "application/json",
        "client-request-id": clientRequestId,
        "return-client-request-id": "true",
      },
      body: JSON.stringify({
        message: {
          subject: input.subject,
          body: { contentType: "Text", content: input.body },
          toRecipients: [{ emailAddress: { address: input.to } }],
        },
        saveToSentItems: true,
      }),
    });
    if (response.status !== 202) {
      if ([401, 403].includes(response.status)) throw revoked();
      throw new MicrosoftMailError(
        response.status === 429
          ? "microsoft_rate_limited"
          : "microsoft_send_not_accepted",
        "Microsoft did not confirm acceptance. Check the selected mailbox before attempting another send.",
        false,
        response.status >= 500,
      );
    }
    await db
      .update(microsoftConnectionsTable)
      .set({ lastUsedAt: new Date(), lastErrorAt: null, lastErrorCode: null })
      .where(
        and(
          eq(microsoftConnectionsTable.id, selected.id),
          eq(
            microsoftConnectionsTable.encryptedRefreshToken,
            selected.encryptedRefreshToken!,
          ),
        ),
      );
    const requestId = response.headers.get("request-id");
    return {
      id: null,
      provider: "microsoft" as const,
      senderEmail: selected.email,
      acceptance: "accepted" as const,
      providerRequestId:
        requestId && /^[a-f\d-]{36}$/i.test(requestId) ? requestId : null,
      clientRequestId,
    };
  } catch (error) {
    if (error instanceof EmailDispatchBlockedError) throw error;
    if (error instanceof CustomerLifecycleHoldError) throw error;
    const failure = error instanceof MicrosoftMailError ? error : unavailable();
    const code =
      dispatched && failure.code === "microsoft_unavailable"
        ? "microsoft_send_outcome_unknown"
        : failure.code;
    const now = new Date();
    await db
      .update(microsoftConnectionsTable)
      .set({
        lastErrorAt: now,
        lastErrorCode: code,
        updatedAt: now,
        ...(failure.reconnectRequired
          ? { encryptedRefreshToken: null, revokedAt: now }
          : {}),
      })
      .where(
        and(
          eq(microsoftConnectionsTable.id, selected.id),
          eq(
            microsoftConnectionsTable.encryptedRefreshToken,
            selected.encryptedRefreshToken!,
          ),
        ),
      );
    if (code === "microsoft_send_outcome_unknown")
      throw new MicrosoftMailError(
        code,
        "Microsoft email send outcome is unknown. Check Sent Items before trying again; GrowthOS did not retry.",
        false,
        true,
      );
    throw failure;
  }
}
