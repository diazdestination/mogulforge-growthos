import { randomBytes, randomUUID } from "node:crypto";
import { and, asc, eq, gt, isNull, lt, or, sql } from "drizzle-orm";
import {
  db,
  auditEventsTable,
  emailSenderPreferencesTable,
  microsoftConnectionsTable,
  oauthTransactionsTable,
  usersTable,
} from "@workspace/db";
import {
  mailboxConnectorsTable as connectors,
  mailboxReceiptsTable as receipts,
  type MailboxConnector,
} from "../../../../lib/db/src/schema/mailbox-connectors";
import {
  decryptSecret,
  encryptSecret,
  sha256Base64Url,
} from "../lib/token-encryption";
import { hasPermission } from "../lib/permissions";
import {
  microsoftOAuthConfig,
  microsoftOAuthConfigured,
} from "./microsoft-oauth";
import { getCustomerLifecycleStatus } from "./customer-lifecycle";
import {
  MAILBOX_READ_SCOPES,
  MAILBOX_PAGES_PER_FOLDER,
  MailboxError,
  mailboxConnectInput,
  mailboxDisableInput,
  mailboxDigest,
  leadMonitoringInput,
  type LeadMonitoringApproval,
  type MailboxIdentity,
  type MailboxMessage,
} from "./mailbox-contract";
import {
  mailboxJson,
  mailboxMetadataDigest,
  readMailboxDelta,
  readMailboxFolders,
  readMailboxPendingMessage,
  readMailboxProfile,
  type MailboxCursors,
  type MailboxFolder,
  type MailboxRejectedMessage,
} from "./mailbox-graph";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Reader = typeof db | Tx;
type Actor = { organizationId: string; userId: string };
const selected = (actor: Actor) =>
  and(
    eq(connectors.organizationId, actor.organizationId),
    eq(connectors.userId, actor.userId),
  );
const oauthWhere = (actor: Actor) =>
  and(
    eq(oauthTransactionsTable.organizationId, actor.organizationId),
    eq(oauthTransactionsTable.userId, actor.userId),
    eq(oauthTransactionsTable.provider, "microsoft_mailbox"),
  );
const aad = (row: { organizationId: string; id: string; version: number }) =>
  `${row.organizationId}:${row.id}:${row.version}:mailbox-read`;
const lock = (actor: Actor) =>
  sql`select pg_advisory_xact_lock(hashtextextended(${`mailbox-read:${actor.organizationId}:${actor.userId}`}, 0))`;
export const mailboxReadEnabled = () =>
  process.env.MICROSOFT_MAILBOX_READ_ENABLED === "true";
function requireEnabled() {
  if (!mailboxReadEnabled())
    throw new MailboxError("mailbox_feature_disabled", 503);
}
async function staff(reader: Reader, actor: Actor) {
  const query = reader
    .select()
    .from(usersTable)
    .where(
      and(
        eq(usersTable.organizationId, actor.organizationId),
        eq(usersTable.id, actor.userId),
      ),
    );
  const [user] = await (reader === db ? query : query.for("share"));
  if (
    !user ||
    !user.isActive ||
    !user.emailVerifiedAt ||
    user.id.startsWith("invite:") ||
    !hasPermission(user.role, "crm.write")
  )
    throw new MailboxError("mailbox_staff_required", 403);
}
async function sender(reader: Reader, actor: Actor) {
  await staff(reader, actor);
  const choiceQuery = reader
    .select()
    .from(emailSenderPreferencesTable)
    .where(
      and(
        eq(emailSenderPreferencesTable.organizationId, actor.organizationId),
        eq(emailSenderPreferencesTable.userId, actor.userId),
      ),
    );
  const [choice] = await (reader === db
    ? choiceQuery
    : choiceQuery.for("share"));
  const query = reader
    .select()
    .from(microsoftConnectionsTable)
    .where(
      and(
        eq(microsoftConnectionsTable.organizationId, actor.organizationId),
        eq(microsoftConnectionsTable.userId, actor.userId),
      ),
    );
  const [connection] = await (reader === db ? query : query.for("share"));
  if (
    choice?.provider !== "microsoft" ||
    !connection?.encryptedRefreshToken ||
    connection.revokedAt ||
    !connection.grantedScopes.includes("mail.send")
  )
    throw new MailboxError("mailbox_sender_changed");
  return connection;
}
function identity(row: MailboxConnector): MailboxIdentity {
  if (!row.startedAt) throw new MailboxError("mailbox_not_active");
  return {
    organizationId: row.organizationId,
    senderUserId: row.userId,
    provider: "microsoft",
    connectionId: row.connectionId,
    connectionRevision: row.connectionRevision,
    mailboxAccountId: row.mailboxAccountId,
    mailboxEmail: row.mailboxEmail,
    connectorId: row.id,
    connectorVersion: row.version,
    policyVersion: row.policyVersion,
    startedAt: row.startedAt.toISOString(),
  };
}
export async function assertMailboxIdentityCurrent(
  expected: MailboxIdentity,
  reader: Reader = db,
): Promise<void> {
  requireEnabled();
  const query = reader
    .select()
    .from(connectors)
    .where(
      and(
        eq(connectors.organizationId, expected.organizationId),
        eq(connectors.id, expected.connectorId),
      ),
    );
  const [row] = await (reader === db ? query : query.for("share"));
  if (
    !row ||
    row.state !== "active" ||
    !row.encryptedRefreshToken ||
    !row.grantedScopes.includes("mail.read") ||
    mailboxDigest(identity(row)) !== mailboxDigest(expected)
  )
    throw new MailboxError("mailbox_grant_changed");
  const current = await sender(reader, {
    organizationId: row.organizationId,
    userId: row.userId,
  });
  if (
    current.id !== row.connectionId ||
    current.connectedAt.toISOString() !== row.connectionRevision ||
    current.accountId !== row.mailboxAccountId ||
    current.email.toLowerCase() !== row.mailboxEmail
  )
    throw new MailboxError("mailbox_sender_changed");
  if (
    !(await getCustomerLifecycleStatus(row.organizationId, reader))
      .automationAllowed
  )
    throw new MailboxError("mailbox_company_paused", 423);
}
export async function getMicrosoftMailboxIdentity(
  organizationId: string,
  userId: string,
): Promise<MailboxIdentity | null> {
  if (!mailboxReadEnabled()) return null;
  const [row] = await db
    .select()
    .from(connectors)
    .where(selected({ organizationId, userId }));
  if (!row || row.state !== "active") return null;
  const value = identity(row);
  await assertMailboxIdentityCurrent(value);
  return value;
}
/** Local, explicitly approved lead context. Never broadens provider scope. */
export async function getLeadMonitoringApproval(
  expected: MailboxIdentity,
  reader: Reader = db,
): Promise<LeadMonitoringApproval | null> {
  await assertMailboxIdentityCurrent(expected, reader);
  const query = reader
    .select()
    .from(connectors)
    .where(
      and(
        eq(connectors.organizationId, expected.organizationId),
        eq(connectors.id, expected.connectorId),
        eq(connectors.version, expected.connectorVersion),
      ),
    );
  const [row] = await (reader === db ? query : query.for("share"));
  if (!row || !row.leadMonitoringEnabled || !row.leadMonitoringApprovedAt)
    return null;
  return {
    version: row.leadMonitoringVersion,
    approvedAt: row.leadMonitoringApprovedAt.toISOString(),
  };
}
export async function assertLeadMonitoringApproval(
  expected: MailboxIdentity,
  approval: LeadMonitoringApproval,
  reader: Reader = db,
): Promise<void> {
  const current = await getLeadMonitoringApproval(expected, reader);
  if (!current || mailboxDigest(current) !== mailboxDigest(approval))
    throw new MailboxError("mailbox_lead_approval_changed");
}
export async function setLeadMonitoringApproval(actor: Actor, raw: unknown) {
  const input = leadMonitoringInput.parse(raw);
  await db.transaction(async (tx) => {
    await tx.execute(lock(actor));
    await staff(tx, actor);
    const [row] = await tx
      .select()
      .from(connectors)
      .where(selected(actor))
      .for("update");
    if (
      !row ||
      row.version !== input.expectedConnectorVersion ||
      row.leadMonitoringVersion !== input.expectedLeadMonitoringVersion
    )
      throw new MailboxError("mailbox_lead_version_changed");
    if (row.leadMonitoringEnabled === input.enabled)
      throw new MailboxError("mailbox_lead_state_unchanged");
    if (input.enabled) await assertMailboxIdentityCurrent(identity(row), tx);
    const now = new Date();
    await tx
      .update(connectors)
      .set({
        leadMonitoringEnabled: input.enabled,
        leadMonitoringVersion: row.leadMonitoringVersion + 1,
        leadMonitoringApprovedAt: input.enabled ? now : null,
        leadMonitoringChangedAt: now,
      })
      .where(
        and(
          selected(actor),
          eq(connectors.version, row.version),
          eq(connectors.leadMonitoringVersion, row.leadMonitoringVersion),
        ),
      );
    await tx
      .insert(auditEventsTable)
      .values({
        organizationId: actor.organizationId,
        actorUserId: actor.userId,
        action: input.enabled
          ? "mailbox.lead_context_enabled"
          : "mailbox.lead_context_disabled",
        entityType: "mailbox_connector",
        entityId: row.id,
        metadata: {
          connectorVersion: row.version,
          priorLeadMonitoringVersion: row.leadMonitoringVersion,
          leadMonitoringVersion: row.leadMonitoringVersion + 1,
          scopesChanged: false,
          serviceIdentityChanged: false,
        },
      });
  });
  return getMailboxStatus(actor.organizationId, actor.userId);
}
export async function getMailboxStatus(organizationId: string, userId: string) {
  await staff(db, { organizationId, userId });
  const [row] = await db
    .select()
    .from(connectors)
    .where(selected({ organizationId, userId }));
  let usable = false,
    reason: string | null = row?.lastErrorCode ?? null;
  if (row?.state === "active")
    try {
      await assertMailboxIdentityCurrent(identity(row));
      usable = true;
    } catch (e) {
      reason =
        e instanceof MailboxError ? e.code : "mailbox_status_unavailable";
    }
  const [counts] = row
    ? await db
        .select({
          pending: sql<number>`count(*) filter (where ${receipts.state} = 'pending')::int`,
          review: sql<number>`count(*) filter (where ${receipts.state} = 'review')::int`,
        })
        .from(receipts)
        .where(
          and(
            eq(receipts.organizationId, organizationId),
            eq(receipts.connectorId, row.id),
          ),
        )
    : [];
  return {
    enabled: mailboxReadEnabled(),
    configured: microsoftOAuthConfigured(),
    version: row?.version ?? 0,
    state: row?.state ?? "disabled",
    usable,
    mailboxEmail: row?.mailboxEmail ?? null,
    startedAt: row?.startedAt ?? null,
    lastSuccessAt: row?.lastSuccessAt ?? null,
    lastErrorAt: row?.lastErrorAt ?? null,
    reason,
    pendingParentCount: counts?.pending ?? 0,
    reviewCount: counts?.review ?? 0,
    leadMonitoringEnabled: row?.leadMonitoringEnabled ?? false,
    leadMonitoringVersion: row?.leadMonitoringVersion ?? 0,
    leadMonitoringApprovedAt: row?.leadMonitoringApprovedAt ?? null,
    leadMonitoringChangedAt: row?.leadMonitoringChangedAt ?? null,
    scopes: ["Mail.Read", "User.Read", "offline_access"],
    folders: ["Inbox", "Sent Items"],
    historicalCrawl: false,
    attachmentsRead: false,
    remoteConsentRevoked: false,
  };
}
const redirectUri = () =>
  microsoftOAuthConfig().redirectUri.replace(
    "/integrations/microsoft/callback",
    "/mailbox/microsoft/callback",
  );
export async function beginMailboxOAuth(actor: Actor, raw: unknown) {
  requireEnabled();
  const input = mailboxConnectInput.parse(raw);
  const config = microsoftOAuthConfig();
  const state = randomBytes(32).toString("base64url"),
    verifier = randomBytes(64).toString("base64url");
  await db.transaction(async (tx) => {
    await tx.execute(lock(actor));
    const current = await sender(tx, actor);
    if (
      !(await getCustomerLifecycleStatus(actor.organizationId, tx))
        .automationAllowed
    )
      throw new MailboxError("mailbox_company_paused", 423);
    const [old] = await tx
      .select()
      .from(connectors)
      .where(selected(actor))
      .for("update");
    if ((old?.version ?? 0) !== input.expectedVersion)
      throw new MailboxError("mailbox_version_changed");
    const value = {
      ...actor,
      connectionId: current.id,
      connectionRevision: current.connectedAt.toISOString(),
      mailboxAccountId: current.accountId,
      mailboxEmail: current.email.toLowerCase(),
      version: (old?.version ?? 0) + 1,
      state: "pending" as const,
      encryptedRefreshToken: null,
      encryptedCursors: null,
      startedAt: null,
      leadMonitoringEnabled: false,
      leadMonitoringVersion: old ? old.leadMonitoringVersion + 1 : 0,
      leadMonitoringApprovedAt: null,
      leadMonitoringChangedAt: old ? new Date() : null,
      leaseToken: null,
      leaseExpiresAt: null,
      lastErrorAt: null,
      lastErrorCode: null,
    };
    const [row] = old
      ? await tx
          .update(connectors)
          .set(value)
          .where(eq(connectors.id, old.id))
          .returning()
      : await tx.insert(connectors).values(value).returning();
    await tx.delete(oauthTransactionsTable).where(oauthWhere(actor));
    await tx.insert(oauthTransactionsTable).values({
      ...actor,
      provider: "microsoft_mailbox",
      module: `${row.id}:${row.version}`,
      requestedScopes: MAILBOX_READ_SCOPES,
      stateHash: sha256Base64Url(state),
      encryptedCodeVerifier: encryptSecret(verifier, `${aad(row)}:oauth`),
      returnPath: input.returnPath,
      expiresAt: new Date(Date.now() + 10 * 60_000),
    });
  });
  const url = new URL(`${config.authority}/authorize`);
  url.search = new URLSearchParams({
    client_id: config.clientId,
    response_type: "code",
    response_mode: "query",
    redirect_uri: redirectUri(),
    scope: MAILBOX_READ_SCOPES.join(" "),
    state,
    code_challenge: sha256Base64Url(verifier),
    code_challenge_method: "S256",
    prompt: "consent",
  }).toString();
  return url.toString();
}
async function readToken(
  fields: Record<string, string>,
  transport: typeof fetch,
) {
  requireEnabled();
  const config = microsoftOAuthConfig();
  let response: Response;
  try {
    response = await transport(`${config.authority}/token`, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        scope: MAILBOX_READ_SCOPES.join(" "),
        ...fields,
      }),
    });
  } catch {
    throw new MailboxError("mailbox_provider_unavailable", 503);
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new MailboxError(
      [400, 401, 403].includes(response.status)
        ? "mailbox_read_revoked"
        : "mailbox_provider_unavailable",
      503,
    );
  }
  const raw = await mailboxJson(response, 65_536);
  const scopes =
    typeof raw.scope === "string"
      ? raw.scope
          .split(/\s+/)
          .map((s) =>
            s.replace(/^https:\/\/graph\.microsoft\.com\//i, "").toLowerCase(),
          )
      : [];
  if (
    !scopes.includes("mail.read") ||
    !scopes.includes("user.read") ||
    typeof raw.access_token !== "string" ||
    !raw.access_token ||
    raw.access_token.length > 30_000 ||
    String(raw.token_type).toLowerCase() !== "bearer" ||
    (raw.refresh_token != null &&
      (typeof raw.refresh_token !== "string" ||
        raw.refresh_token.length > 30_000))
  )
    throw new MailboxError("mailbox_read_scope_missing");
  return {
    access: raw.access_token,
    refresh:
      typeof raw.refresh_token === "string" && raw.refresh_token
        ? raw.refresh_token
        : null,
    scopes,
  };
}
export async function completeMailboxOAuth(
  actor: Actor,
  state: string,
  code: string,
  transport: typeof fetch = fetch,
) {
  requireEnabled();
  await staff(db, actor);
  if (!state || state.length > 512 || !code || code.length > 10_000)
    throw new MailboxError("mailbox_oauth_invalid");
  const consumedAt = new Date();
  const [flow] = await db
    .update(oauthTransactionsTable)
    .set({ consumedAt })
    .where(
      and(
        oauthWhere(actor),
        eq(oauthTransactionsTable.stateHash, sha256Base64Url(state)),
        isNull(oauthTransactionsTable.consumedAt),
        gt(oauthTransactionsTable.expiresAt, consumedAt),
      ),
    )
    .returning();
  const [row] = await db.select().from(connectors).where(selected(actor));
  if (
    !flow ||
    !row ||
    row.state !== "pending" ||
    flow.module !== `${row.id}:${row.version}`
  )
    throw new MailboxError("mailbox_oauth_expired");
  const before = await sender(db, actor);
  if (
    before.id !== row.connectionId ||
    before.connectedAt.toISOString() !== row.connectionRevision
  )
    throw new MailboxError("mailbox_sender_changed");
  const pendingGuard = async () => {
    requireEnabled();
    const current = await sender(db, actor);
    const [pending] = await db
      .select({ id: connectors.id })
      .from(connectors)
      .where(
        and(
          selected(actor),
          eq(connectors.version, row.version),
          eq(connectors.state, "pending"),
        ),
      );
    if (
      !pending ||
      current.id !== row.connectionId ||
      current.connectedAt.toISOString() !== row.connectionRevision ||
      current.accountId !== row.mailboxAccountId ||
      current.email.toLowerCase() !== row.mailboxEmail
    )
      throw new MailboxError("mailbox_sender_changed");
    if (
      !(await getCustomerLifecycleStatus(actor.organizationId))
        .automationAllowed
    )
      throw new MailboxError("mailbox_company_paused", 423);
  };
  await pendingGuard();
  const token = await readToken(
    {
      grant_type: "authorization_code",
      code,
      code_verifier: decryptSecret(
        flow.encryptedCodeVerifier,
        `${aad(row)}:oauth`,
      ),
      redirect_uri: redirectUri(),
    },
    transport,
  );
  if (!token.refresh) throw new MailboxError("mailbox_offline_access_missing");
  await pendingGuard();
  const stillSelected = await sender(db, actor);
  if (
    stillSelected.id !== row.connectionId ||
    stillSelected.connectedAt.toISOString() !== row.connectionRevision
  )
    throw new MailboxError("mailbox_sender_changed");
  const profile = await readMailboxProfile(token.access, transport);
  if (
    profile.accountId !== row.mailboxAccountId ||
    profile.email !== row.mailboxEmail
  )
    throw new MailboxError("mailbox_sender_changed");
  requireEnabled();
  const cursors = await readMailboxFolders(
      token.access,
      transport,
      pendingGuard,
    ),
    startedAt = new Date();
  await db.transaction(async (tx) => {
    await tx.execute(lock(actor));
    requireEnabled();
    const current = await sender(tx, actor);
    if (
      current.id !== row.connectionId ||
      current.connectedAt.toISOString() !== row.connectionRevision ||
      current.accountId !== row.mailboxAccountId ||
      current.email.toLowerCase() !== row.mailboxEmail ||
      !(await getCustomerLifecycleStatus(actor.organizationId, tx))
        .automationAllowed
    )
      throw new MailboxError("mailbox_sender_changed");
    const [still] = await tx
      .select()
      .from(oauthTransactionsTable)
      .where(
        and(
          eq(oauthTransactionsTable.id, flow.id),
          eq(oauthTransactionsTable.consumedAt, consumedAt),
        ),
      );
    if (!still) throw new MailboxError("mailbox_oauth_expired");
    const [updated] = await tx
      .update(connectors)
      .set({
        state: "active",
        encryptedRefreshToken: encryptSecret(token.refresh!, aad(row)),
        grantedScopes: token.scopes,
        encryptedCursors: encryptSecret(
          JSON.stringify(cursors),
          `${aad(row)}:cursor`,
        ),
        startedAt,
      })
      .where(
        and(
          selected(actor),
          eq(connectors.version, row.version),
          eq(connectors.state, "pending"),
        ),
      )
      .returning();
    if (!updated) throw new MailboxError("mailbox_grant_changed");
    await tx
      .delete(oauthTransactionsTable)
      .where(eq(oauthTransactionsTable.id, flow.id));
  });
  return {
    returnPath: flow.returnPath === "/settings" ? "/settings" : "/account",
  };
}
export async function disableMailboxConnector(actor: Actor, raw: unknown) {
  const input = mailboxDisableInput.parse(raw);
  await db.transaction(async (tx) => {
    await tx.execute(lock(actor));
    await staff(tx, actor);
    const [updated] = await tx
      .update(connectors)
      .set({
        state: "disabled",
        encryptedRefreshToken: null,
        leaseToken: null,
        leaseExpiresAt: null,
        version: input.expectedVersion + 1,
      })
      .where(
        and(selected(actor), eq(connectors.version, input.expectedVersion)),
      )
      .returning();
    if (!updated) throw new MailboxError("mailbox_version_changed");
    await tx.delete(oauthTransactionsTable).where(oauthWhere(actor));
  });
  return { disabled: true, remoteConsentRevoked: false };
}

/** Coordinator-owned scheduler invokes this bounded reader; no outbound effects. */
export async function processMailboxConnectors(
  organizationId?: string,
  options: { transport?: typeof fetch } = {},
) {
  if (!mailboxReadEnabled()) return { checked: 0, disabled: true };
  const transport = options.transport ?? fetch,
    deadline = Date.now() + 25_000;
  const candidates = await db
    .select()
    .from(connectors)
    .where(
      and(
        eq(connectors.state, "active"),
        organizationId
          ? eq(connectors.organizationId, organizationId)
          : undefined,
      ),
    )
    .orderBy(asc(connectors.lastCheckedAt), asc(connectors.id))
    .limit(5);
  let checked = 0;
  for (const candidate of candidates) {
    if (Date.now() >= deadline) break;
    // Rotate even held/failed connectors: an old blocked account must not starve
    // a later newly opted-in mailbox indefinitely.
    await db
      .update(connectors)
      .set({ lastCheckedAt: new Date() })
      .where(
        and(
          eq(connectors.id, candidate.id),
          eq(connectors.version, candidate.version),
        ),
      );
    const expected = identity(candidate),
      lease = randomUUID();
    try {
      await assertMailboxIdentityCurrent(expected);
    } catch (error) {
      if (
        error instanceof MailboxError &&
        ["mailbox_company_paused", "mailbox_feature_disabled"].includes(
          error.code,
        )
      )
        continue;
      await db
        .update(connectors)
        .set({
          state: "revoked",
          encryptedRefreshToken: null,
          lastErrorAt: new Date(),
          lastErrorCode:
            error instanceof MailboxError ? error.code : "mailbox_guard_failed",
        })
        .where(
          and(
            eq(connectors.id, candidate.id),
            eq(connectors.version, candidate.version),
          ),
        );
      continue;
    }
    const [claimed] = await db
      .update(connectors)
      .set({ leaseToken: lease, leaseExpiresAt: new Date(Date.now() + 90_000) })
      .where(
        and(
          eq(connectors.id, candidate.id),
          eq(connectors.version, candidate.version),
          eq(connectors.state, "active"),
          or(
            isNull(connectors.leaseExpiresAt),
            lt(connectors.leaseExpiresAt, new Date()),
          ),
        ),
      )
      .returning();
    if (!claimed) continue;
    const owned = () =>
      and(
        eq(connectors.id, claimed.id),
        eq(connectors.version, claimed.version),
        eq(connectors.leaseToken, lease),
        eq(connectors.state, "active"),
        gt(connectors.leaseExpiresAt, new Date()),
      );
    const guard = async () => {
      if (Date.now() >= deadline) throw new MailboxError("mailbox_tick_budget");
      await assertMailboxIdentityCurrent(expected);
      const [leaseRow] = await db
        .select({ id: connectors.id })
        .from(connectors)
        .where(
          and(
            eq(connectors.id, claimed.id),
            eq(connectors.leaseToken, lease),
            gt(connectors.leaseExpiresAt, new Date()),
          ),
        );
      if (!leaseRow) throw new MailboxError("mailbox_lease_lost");
    };
    try {
      await guard();
      const token = await readToken(
        {
          grant_type: "refresh_token",
          refresh_token: decryptSecret(
            claimed.encryptedRefreshToken!,
            aad(claimed),
          ),
        },
        transport,
      );
      await guard();
      const profile = await readMailboxProfile(token.access, transport);
      if (
        profile.accountId !== claimed.mailboxAccountId ||
        profile.email !== claimed.mailboxEmail
      )
        throw new MailboxError("mailbox_sender_changed");
      await guard();
      if (token.refresh)
        await db
          .update(connectors)
          .set({
            encryptedRefreshToken: encryptSecret(token.refresh, aad(claimed)),
            grantedScopes: token.scopes,
          })
          .where(owned());
      const cursors = JSON.parse(
        decryptSecret(claimed.encryptedCursors!, `${aad(claimed)}:cursor`),
      ) as MailboxCursors;
      const handlers = await import("./mailbox-communication");
      const reviewMessage = async (
        folder: MailboxFolder,
        item: MailboxRejectedMessage,
      ) => {
        await guard();
        await db
          .insert(receipts)
          .values({
            organizationId: claimed.organizationId,
            connectorId: claimed.id,
            connectorVersion: claimed.version,
            folder,
            providerMessageId: item.providerMessageId,
            contentSha256: item.contentSha256,
            state: "review",
            attempts: 1,
            lastAttemptAt: new Date(),
          })
          .onConflictDoUpdate({
            target: [
              receipts.organizationId,
              receipts.connectorId,
              receipts.folder,
              receipts.providerMessageId,
            ],
            set: { state: "review", lastAttemptAt: new Date() },
            setWhere: eq(receipts.state, "pending"),
          });
      };
      const boundedContentFailure = (error: unknown) =>
        error instanceof MailboxError &&
        [
          "mailbox_message_invalid",
          "mailbox_header_invalid",
          "mailbox_parent_header_invalid",
          "mailbox_message_missing",
          "mailbox_response_too_large",
        ].includes(error.code);
      const consume = async (
        folder: MailboxFolder,
        message: MailboxMessage,
        retry = false,
      ) => {
        await guard();
        const digest = mailboxMetadataDigest(message);
        const match = and(
          eq(receipts.organizationId, claimed.organizationId),
          eq(receipts.connectorId, claimed.id),
          eq(receipts.folder, folder),
          eq(receipts.providerMessageId, message.providerMessageId),
        );
        const [prior] = await db.select().from(receipts).where(match);
        if (prior && prior.contentSha256 !== digest)
          throw new MailboxError("mailbox_message_conflict");
        if (prior && (!retry || prior.state !== "pending")) return;
        let state: "processed" | "ignored" | "pending" | "review" = "ignored";
        if (
          Date.parse(message.receivedAt) >= claimed.startedAt!.getTime() &&
          Date.parse(message.sentAt) >= claimed.startedAt!.getTime() &&
          message.internetMessageId
        ) {
          if (
            folder === "sentitems" &&
            message.correlationHeader &&
            message.from === claimed.mailboxEmail
          ) {
            const result = await handlers.bindMailboxSentParent(expected, {
              providerMessageId: message.providerMessageId,
              internetMessageId: message.internetMessageId,
              correlationHeader: message.correlationHeader,
              from: message.from,
              to: message.to,
              subject: message.subject,
              sentAt: new Date(message.sentAt),
            });
            state = result.matched ? "processed" : "ignored";
          } else if (
            folder === "inbox" &&
            !message.automated &&
            message.to.includes(claimed.mailboxEmail) &&
            message.inReplyTo.length === 1
          ) {
            const normalized = {
              providerMessageId: message.providerMessageId,
              internetMessageId: message.internetMessageId,
              inReplyTo: message.inReplyTo,
              from: message.from,
              to: message.to,
              subject: message.subject,
              text: "",
              receivedAt: new Date(message.receivedAt),
              sentAt: new Date(message.sentAt),
            };
            if (await handlers.isMailboxReplyCandidate(expected, normalized)) {
              await guard();
              let full: MailboxMessage | null = null;
              try {
                full = await readMailboxPendingMessage(
                  token.access,
                  cursors.inbox.folderId,
                  message.providerMessageId,
                  transport,
                );
              } catch (error) {
                if (!boundedContentFailure(error)) throw error;
              }
              if (!full || mailboxMetadataDigest(full) !== digest)
                state = "review";
              else {
                await guard();
                const result = await handlers.ingestMailboxReply(expected, {
                  ...normalized,
                  text: full.text,
                });
                state =
                  result.state === "unmatched"
                    ? "pending"
                    : result.state === "ignored"
                      ? "ignored"
                      : "processed";
              }
            }
          }
        }
        const attempts = (prior?.attempts ?? 0) + 1;
        if (state === "pending" && attempts >= 10) state = "review";
        await guard();
        await db
          .insert(receipts)
          .values({
            organizationId: claimed.organizationId,
            connectorId: claimed.id,
            connectorVersion: claimed.version,
            folder,
            providerMessageId: message.providerMessageId,
            contentSha256: digest,
            state,
            attempts,
            lastAttemptAt: new Date(),
          })
          .onConflictDoUpdate({
            target: [
              receipts.organizationId,
              receipts.connectorId,
              receipts.folder,
              receipts.providerMessageId,
            ],
            set: { state, attempts, lastAttemptAt: new Date() },
          });
      };
      for (const folder of ["sentitems", "inbox"] as const) {
        if (folder === "inbox" && !cursors.sentitems.complete) break;
        for (
          let page = 0;
          page < MAILBOX_PAGES_PER_FOLDER && Date.now() < deadline;
          page++
        ) {
          await guard();
          const result = await readMailboxDelta(
            {
              token: token.access,
              accountId: claimed.mailboxAccountId,
              cursor: cursors[folder],
              startedAt: claimed.startedAt!.toISOString(),
            },
            transport,
          );
          for (const item of result.rejected) await reviewMessage(folder, item);
          for (const message of result.messages) await consume(folder, message);
          await guard();
          cursors[folder] = result.cursor;
          const [saved] = await db
            .update(connectors)
            .set({
              encryptedCursors: encryptSecret(
                JSON.stringify(cursors),
                `${aad(claimed)}:cursor`,
              ),
              lastSuccessAt: new Date(),
              lastErrorAt: null,
              lastErrorCode: null,
            })
            .where(owned())
            .returning({ id: connectors.id });
          if (!saved) throw new MailboxError("mailbox_lease_lost");
          if (result.cursor.complete) break;
        }
      }
      if (cursors.sentitems.complete) {
        const pending = await db
          .select()
          .from(receipts)
          .where(
            and(
              eq(receipts.connectorId, claimed.id),
              eq(receipts.connectorVersion, claimed.version),
              eq(receipts.state, "pending"),
            ),
          )
          .orderBy(asc(receipts.lastAttemptAt))
          .limit(5);
        for (const row of pending) {
          if (Date.now() >= deadline) break;
          await guard();
          let message: MailboxMessage | null = null;
          try {
            message = await readMailboxPendingMessage(
              token.access,
              cursors.inbox.folderId,
              row.providerMessageId,
              transport,
              true,
            );
          } catch (error) {
            if (!boundedContentFailure(error)) throw error;
          }
          if (message) await consume("inbox", message, true);
          else
            await reviewMessage("inbox", {
              providerMessageId: row.providerMessageId,
              contentSha256: row.contentSha256,
              reason: "mailbox_content_review",
            });
        }
      }
      checked++;
    } catch (error) {
      const code =
        error instanceof MailboxError
          ? error.code
          : "mailbox_processing_review_required";
      const temporary = [
        "mailbox_provider_unavailable",
        "mailbox_rate_limited",
        "mailbox_company_paused",
        "mailbox_lease_lost",
        "mailbox_feature_disabled",
        "mailbox_response_too_large",
        "mailbox_tick_budget",
      ].includes(code);
      await db
        .update(connectors)
        .set({
          lastErrorCode: code,
          lastErrorAt: new Date(),
          ...(!temporary
            ? {
                state:
                  code.includes("revoked") || code.includes("sender_changed")
                    ? ("revoked" as const)
                    : ("gap" as const),
                encryptedRefreshToken: null,
              }
            : {}),
        })
        .where(
          and(
            eq(connectors.id, claimed.id),
            eq(connectors.version, claimed.version),
            eq(connectors.leaseToken, lease),
          ),
        );
    } finally {
      await db
        .update(connectors)
        .set({ leaseToken: null, leaseExpiresAt: null })
        .where(
          and(eq(connectors.id, claimed.id), eq(connectors.leaseToken, lease)),
        );
    }
  }
  return { checked, disabled: false };
}
