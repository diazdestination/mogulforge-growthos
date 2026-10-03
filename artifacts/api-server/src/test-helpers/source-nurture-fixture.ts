import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { contactsTable, db, emailSenderPreferencesTable, leadsTable, microsoftConnectionsTable, organizationsTable, orgSettingsTable, usersTable } from "@workspace/db";
import { mailboxConnectorsTable as connectors } from "../../../../lib/db/src/schema/mailbox-connectors";
import { encryptSecret } from "../lib/token-encryption";
import { approveSourceAdoption, getSourceAdoption, previewSourceAdoption, recordSourceEmailPermission } from "../services/source-adoption";
import { getMicrosoftMailboxIdentity, processMailboxConnectors, setNurtureMonitoringApproval } from "../services/mailbox-connector";
import { approveSourceNurture, previewSourceNurture, startSourceNurture } from "../services/source-nurture";

export const nurtureJson = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
export const nurtureTokens = (scope = "Mail.Read User.Read") => ({ token_type: "Bearer", access_token: "synthetic-nurture-access", refresh_token: "synthetic-nurture-refresh", scope });

/** Synthetic-only, caller selects an isolated test database and encryption env. */
export async function sourceNurtureFixture(options: { organizationId?: string; ownerUserId?: string; contactId?: string; recipient?: string } = {}) {
  const at = new Date(), old = new Date(at.getTime() - 86_400_000);
  const [company] = options.organizationId ? await db.select().from(organizationsTable).where(eq(organizationsTable.id, options.organizationId))
    : await db.insert(organizationsTable).values({ name: "Synthetic nurture contractor", slug: `nurture-${randomUUID()}`, createdAt: old }).returning();
  if (!company) throw new Error("Synthetic company missing");
  const [owner] = options.ownerUserId ? await db.select().from(usersTable).where(and(eq(usersTable.organizationId, company.id), eq(usersTable.id, options.ownerUserId)))
    : await db.insert(usersTable).values({ organizationId: company.id, role: "owner", firstName: "Synthetic", lastName: "Owner", emailVerifiedAt: old }).returning();
  if (!owner) throw new Error("Synthetic owner missing");
  const [contact] = options.contactId ? await db.select().from(contactsTable).where(and(eq(contactsTable.organizationId, company.id), eq(contactsTable.id, options.contactId)))
    : await db.insert(contactsTable).values({ organizationId: company.id, firstName: "Synthetic prospect", email: options.recipient ?? "nurture-prospect@example.invalid", createdAt: old, updatedAt: old }).returning();
  if (!contact) throw new Error("Synthetic contact missing");
  const history = { version: 1 as const, kind: "csv_snapshot" as const, originalCreatedAt: old.toISOString(), sourceUpdatedAt: old.toISOString(), statusChangedAt: null, lastContactAt: null,
    snapshotAsOf: old.toISOString(), firstImportedAt: old.toISOString(), lastImportedAt: old.toISOString(), externalCustomerId: `customer-${contact.id}`, externalEstimateId: randomUUID(),
    currency: "USD" as const, fingerprint: "a".repeat(64), appliedFingerprint: "b".repeat(64), mappedFields: ["firstName", "email", "externalOpportunityId"] };
  const [lead] = await db.insert(leadsTable).values({ organizationId: company.id, contactId: contact.id, assignedUserId: owner.id, status: "follow_up", creationMethod: "import",
    importSourceKey: "synthetic-source-account", externalOpportunityId: randomUUID(), importedHistory: history, summary: "Synthetic adopted estimate", createdAt: old, updatedAt: old }).returning();
  const actor = { organizationId: company.id, userId: owner.id };
  let [connection] = await db.select().from(microsoftConnectionsTable).where(and(eq(microsoftConnectionsTable.organizationId, company.id), eq(microsoftConnectionsTable.userId, owner.id)));
  if (!connection) [connection] = await db.insert(microsoftConnectionsTable).values({ ...actor, accountId: `synthetic-${owner.id}`, email: "nurture-office@example.invalid", connectedAt: old,
    encryptedRefreshToken: encryptSecret("synthetic-nurture-send", `${company.id}:${owner.id}:microsoft`), grantedScopes: ["mail.send", "user.read"] }).returning();
  await db.insert(emailSenderPreferencesTable).values({ ...actor, provider: "microsoft" }).onConflictDoNothing();
  await db.insert(orgSettingsTable).values({ organizationId: company.id, customerEmailSenderUserId: owner.id, sendingHours: { quietHoursEnabled: false, maxTouchesPerDay: 1 } }).onConflictDoNothing();
  let [connector] = await db.select().from(connectors).where(and(eq(connectors.organizationId, company.id), eq(connectors.userId, owner.id)));
  if (!connector) {
    const id = randomUUID(), aad = `${company.id}:${id}:1:mailbox-read`;
    [connector] = await db.insert(connectors).values({ id, ...actor, provider: "microsoft", connectionId: connection.id, connectionRevision: connection.connectedAt.toISOString(), mailboxAccountId: connection.accountId,
      mailboxEmail: connection.email, state: "active", version: 1, grantedScopes: ["mail.read", "user.read"], startedAt: old,
      encryptedRefreshToken: encryptSecret("synthetic-nurture-read", aad), encryptedCursors: encryptSecret(JSON.stringify({
        sentitems: { folderId: "sent_nurture", continuation: null, complete: false }, inbox: { folderId: "inbox_nurture", continuation: null, complete: false },
      }), `${aad}:cursor`) }).returning();
    await setNurtureMonitoringApproval(actor, { expectedConnectorVersion: connector.version, expectedNurtureMonitoringVersion: 0, enabled: true, nurtureContextAcknowledged: true });
    [connector] = await db.select().from(connectors).where(eq(connectors.id, id));
  }
  const identity = (await getMicrosoftMailboxIdentity(company.id, owner.id))!;
  const current = await getSourceAdoption(company.id, lead.id);
  const preview = await previewSourceAdoption(company.id, owner.id, lead.id, { expectedVersion: 0, sourceAsOf: old.toISOString(), cutoverAt: old.toISOString(), expiresAt: new Date(at.getTime() + 14 * 86_400_000).toISOString(),
    evidence: "Synthetic source reconciled with current work and the previous writer stopped.", sourceWriterStopped: true, currentStatusVerified: true, noUnreviewedReplies: true });
  await approveSourceAdoption(company.id, owner.id, lead.id, { previewId: preview.previewId, payloadSha256: preview.payloadSha256, confirmed: true });
  // Do not create a second permission record for the same contact: doing so
  // would intentionally invalidate a previously frozen exact permission ID.
  if (!current.marketingPermission) await recordSourceEmailPermission(company.id, owner.id, lead.id, { expectedSourceSha256: current.sourceSha256, expectedRecipient: current.recipient,
    expectedConsentId: current.consentId, granted: true, observedAt: at.toISOString(), evidence: "Synthetic separately evidenced promotional email permission for this address.", marketingPermissionConfirmed: true });
  const fixture = { org: company.id, company, owner, actor, contact, lead, connector, identity, profile: { id: connection.accountId, mail: connection.email } };
  await completeNurtureScan(fixture);
  return fixture;
}
export type SourceNurtureFixture = Awaited<ReturnType<typeof sourceNurtureFixture>>;

/** Only recognized synthetic reader URLs are served; there is no network fallback. */
export function nurtureReadTransport(f: { profile: { id: string; mail: string } }, options: { sent?: unknown[]; inbox?: unknown[] } = {}): typeof fetch {
  const next = (folder: string) => `https://graph.microsoft.com/v1.0/me/mailFolders/${folder}/messages/delta?$deltatoken=synthetic-nurture`;
  return async input => {
    const url = String(input);
    if (url.endsWith("/token")) return nurtureJson(nurtureTokens());
    if (url.startsWith("https://graph.microsoft.com/v1.0/me?")) return nurtureJson(f.profile);
    if (url.includes("/mailFolders/sent_nurture/messages/delta?")) return nurtureJson({ value: options.sent ?? [], "@odata.deltaLink": next("sent_nurture") });
    if (url.includes("/mailFolders/inbox_nurture/messages/delta?")) return nurtureJson({ value: (options.inbox ?? []).map(value => { const { body: _body, ...metadata } = value as Record<string, unknown>; return metadata; }), "@odata.deltaLink": next("inbox_nurture") });
    for (const message of options.inbox ?? []) if (url.includes(`/mailFolders/inbox_nurture/messages/${encodeURIComponent(String((message as { id: string }).id))}?`)) return nurtureJson(message);
    throw new Error("Unexpected synthetic nurture reader URL; no external fallback");
  };
}
export async function completeNurtureScan(f: { org: string; profile: { id: string; mail: string } }, options: { sent?: unknown[]; inbox?: unknown[] } = {}) {
  return processMailboxConnectors(f.org, { transport: nurtureReadTransport(f, options) });
}
export function sourceNurtureDraft(f: Pick<SourceNurtureFixture, "lead" | "company">) {
  return { leadIds: [f.lead.id], businessName: f.company.name, mailingAddress: "123 Synthetic Lane, Test City, GA 30000", steps: [
    { subject: "Your estimate and next steps", body: "Would you like our office to help with the estimate you requested?" },
    { subject: "Final follow-up on your estimate", body: "Our office can answer questions. Please reply if you would like to discuss next steps." },
  ], startNotBefore: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 10 * 86_400_000).toISOString(),
    timezone: "America/New_York", days: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"], startHour: 8, endHour: 20, dailyLimit: 10 };
}
export async function startNurtureFixture(f: SourceNurtureFixture, changes: Partial<ReturnType<typeof sourceNurtureDraft>> = {}) {
  const preview = await previewSourceNurture(f.org, f.owner.id, { ...sourceNurtureDraft(f), ...changes });
  const approved = await approveSourceNurture(f.org, f.owner.id, preview.id, { expectedVersion: preview.version, payloadSha256: preview.payloadSha256, confirmed: true });
  return (await startSourceNurture(f.org, f.owner.id, preview.id, { requestId: randomUUID(), expectedVersion: approved.detail.version, payloadSha256: preview.payloadSha256, confirmed: true })).detail;
}
