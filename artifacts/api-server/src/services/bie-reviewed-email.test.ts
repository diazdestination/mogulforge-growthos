import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { activitiesTable, bieActionProposalsTable, contactsTable, customerLifecycleTable, db, DEFAULT_SENDING_HOURS, emailSenderPreferencesTable,
  leadsTable, microsoftConnectionsTable, organizationsTable, revenueExecutionsTable, usersTable } from "@workspace/db";
import { mailboxConnectorsTable as connectors } from "../../../../lib/db/src/schema/mailbox-connectors";
import { mailboxCommunicationParentsTable as parents } from "../../../../lib/db/src/schema/mailbox-communication";
import { encryptSecret } from "../lib/token-encryption";
import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";
import { executeBieProposal, prepareBieEmailProposal, reviewBieProposal } from "./bie";
import { updateOrgSettings } from "./settings";

const orgs: string[] = [];
const transport = vi.fn<typeof fetch>();
let onRefresh: (() => Promise<void>) | undefined, postCount = 0, unknown = false;
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const mailbox = { id: "synthetic-bie-mailbox", mail: "reviewed-office@example.invalid" };
beforeEach(() => {
  vi.stubEnv("MICROSOFT_OAUTH_CLIENT_ID", "synthetic-client"); vi.stubEnv("MICROSOFT_OAUTH_CLIENT_SECRET", "synthetic-secret");
  vi.stubEnv("MICROSOFT_MAILBOX_READ_ENABLED", "true"); vi.stubEnv("APP_ORIGIN", "https://growth.example");
  vi.stubEnv("OAUTH_TOKEN_ENCRYPTION_KEY", "ab".repeat(32)); vi.stubEnv("EMAIL_INTELLIGENCE_ENCRYPTION_KEY", "cd".repeat(32));
  vi.stubEnv("GROWTHOS_OUTBOUND_HOLD", "false");
  postCount = 0; unknown = false; onRefresh = undefined;
  transport.mockReset().mockImplementation(async (input) => {
    const url = String(input);
    if (url.startsWith("https://login.microsoftonline.com/") && url.endsWith("/token")) return response({ token_type: "Bearer", access_token: "synthetic-access", refresh_token: "synthetic-rotated", scope: "Mail.Send User.Read" });
    if (url.startsWith("https://graph.microsoft.com/v1.0/me?")) { await onRefresh?.(); return response(mailbox); }
    if (url === "https://graph.microsoft.com/v1.0/me/sendMail") { postCount++; if (unknown) throw new Error("Synthetic unknown effect, never retry"); return new Response(null, { status: 202 }); }
    throw new Error("Unexpected synthetic transport operation");
  });
  vi.stubGlobal("fetch", transport);
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
afterAll(async () => { await deleteTestOrgs(...orgs); });
async function fixture(tracking = true, legacy = false) {
  const [org] = await db.insert(organizationsTable).values({ name: "Synthetic reviewed BIE", slug: randomUUID() }).returning(); orgs.push(org.id);
  const [user] = await db.insert(usersTable).values({ organizationId: org.id, role: "owner", email: `staff-${randomUUID()}@example.invalid`, emailVerifiedAt: new Date() }).returning();
  const [contact] = await db.insert(contactsTable).values({ organizationId: org.id, firstName: "Synthetic", email: `${randomUUID()}@example.invalid` }).returning();
  const [lead] = await db.insert(leadsTable).values({ organizationId: org.id, contactId: contact.id, assignedUserId: user.id, creationMethod: "form", status: "follow_up" }).returning();
  const [connection] = await db.insert(microsoftConnectionsTable).values({ organizationId: org.id, userId: user.id, accountId: mailbox.id, email: mailbox.mail,
    encryptedRefreshToken: encryptSecret("synthetic-refresh", `${org.id}:${user.id}:microsoft`), grantedScopes: ["mail.send", "user.read"] }).returning();
  await db.insert(emailSenderPreferencesTable).values({ organizationId: org.id, userId: user.id, provider: "microsoft" });
  const startedAt = new Date(Date.now() - 1000);
  const [connector] = await db.insert(connectors).values({ organizationId: org.id, userId: user.id, connectionId: connection.id, connectionRevision: connection.connectedAt.toISOString(),
    mailboxAccountId: mailbox.id, mailboxEmail: mailbox.mail, state: "active", encryptedRefreshToken: "synthetic-read", encryptedCursors: "synthetic-cursors",
    grantedScopes: ["mail.read", "user.read"], startedAt, leadMonitoringEnabled: tracking, leadMonitoringVersion: tracking ? 1 : 0,
    leadMonitoringApprovedAt: tracking ? startedAt : null, leadMonitoringChangedAt: tracking ? startedAt : null }).returning();
  await updateOrgSettings(org.id, { sendingHours: { ...DEFAULT_SENDING_HOURS, quietHoursEnabled: false, maxTouchesPerDay: 0 } });
  const [proposal] = await db.insert(bieActionProposalsTable).values({ organizationId: org.id, leadId: lead.id, actionType: "send_email", status: legacy ? "approved" : "proposed",
    title: "Synthetic follow-up", rationale: "Local test only", payload: { subject: "Exact reviewed subject", body: "Exact reviewed text" }, createdByUserId: user.id,
    reviewedByUserId: legacy ? user.id : null, reviewedAt: legacy ? new Date() : null }).returning();
  return { org: org.id, user: user.id, contact, lead, proposal, connection, connector };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const prepare = (f: Fixture) => prepareBieEmailProposal(f.org, f.proposal.id, f.user, { expectedPayload: f.proposal.payload });
async function approve(f: Fixture) { const prepared = await prepare(f); expect(await reviewBieProposal(f.org, f.proposal.id, f.user, "approve", prepared.payload)).toMatchObject({ status: "approved" }); return prepared; }
const execute = (f: Fixture) => executeBieProposal(f.org, f.proposal.id, f.user);
async function receipt(f: Fixture) { return (await db.select().from(revenueExecutionsTable).where(and(eq(revenueExecutionsTable.organizationId, f.org), eq(revenueExecutionsTable.actionKey, `bie:${f.proposal.id}`))))[0]; }

describe("explicit reviewed BIE sender and optional original-mailbox context", () => {
  it("prepares exact displayed identity without approval or network; approves the complete saved snapshot and sends through the real guarded Microsoft adapter once", async () => {
    const f = await fixture(); const prepared = await prepare(f);
    expect(prepared.status).toBe("proposed"); expect(transport).not.toHaveBeenCalled();
    expect(prepared.payload.emailReview).toMatchObject({ version: 1, preparedByUserId: f.user, recipient: f.contact.email, sender: { provider: "microsoft", senderEmail: mailbox.mail } });
    expect(prepared.payload.deliverySnapshot).toMatchObject({ kind: "bie_lead_email", leadId: f.lead.id, contactId: f.contact.id, leadMonitoringApproval: { version: 1 } });
    expect(await reviewBieProposal(f.org, f.proposal.id, f.user, "approve", f.proposal.payload)).toBeNull();
    expect(await reviewBieProposal(f.org, f.proposal.id, f.user, "approve", prepared.payload)).toMatchObject({ status: "approved" });
    expect(await execute(f)).toMatchObject({ status: "executed" }); expect(postCount).toBe(1);
    const [parent] = await db.select().from(parents).where(eq(parents.organizationId, f.org));
    expect(parent).toMatchObject({ leadId: f.lead.id, contactId: f.contact.id, actionKey: `bie:${f.proposal.id}`, internetMessageId: null });
    expect(parent.dispatchStartedAt).toBeInstanceOf(Date); expect(parent.acceptedAt).toBeInstanceOf(Date);
    const sent = transport.mock.calls.find(([url]) => String(url).endsWith("/sendMail"))!;
    expect(JSON.parse(String(sent[1]?.body))).toMatchObject({ message: { subject: f.proposal.payload.subject, body: { content: f.proposal.payload.body },
      toRecipients: [{ emailAddress: { address: f.contact.email } }], internetMessageHeaders: [{ name: "x-growthos-parent-id", value: parent.correlationHeader }] } });
    await execute(f); expect(postCount).toBe(1); expect((await receipt(f)).state).toBe("succeeded");
  });
  it.each(["no tracking acknowledgement", "historical approved email"])("keeps %s explicitly untracked and never silently reserves a parent", async kind => {
    const f = await fixture(kind !== "no tracking acknowledgement", kind === "historical approved email");
    if (kind === "no tracking acknowledgement") { const prepared = await approve(f); expect(prepared.payload).not.toHaveProperty("deliverySnapshot"); }
    expect(await execute(f)).toMatchObject({ status: "executed" }); expect(postCount).toBe(1);
    expect(await db.select().from(parents).where(eq(parents.organizationId, f.org))).toHaveLength(0);
    const sent = transport.mock.calls.find(([url]) => String(url).endsWith("/sendMail"))!;
    expect(JSON.parse(String(sent[1]?.body)).message).not.toHaveProperty("internetMessageHeaders");
  });
  it("requires explicit prepare; caller metadata cannot be appended while approving", async () => {
    const f = await fixture(); expect(await reviewBieProposal(f.org, f.proposal.id, f.user, "approve", f.proposal.payload)).toBeNull();
    expect(await execute(f)).toMatchObject({ status: "proposed" }); expect(transport).not.toHaveBeenCalled();
  });
  it("another company staff member cannot consume the prepared sender's fixed execution slot", async () => {
    const f = await fixture(); await approve(f);
    const [other] = await db.insert(usersTable).values({ organizationId: f.org, role: "owner", emailVerifiedAt: new Date() }).returning();
    await expect(executeBieProposal(f.org, f.proposal.id, other.id)).rejects.toMatchObject({ status: 403, code: "reviewing_sender_required" });
    expect(await receipt(f)).toBeUndefined(); expect(transport).not.toHaveBeenCalled();
    expect(await execute(f)).toMatchObject({ status: "executed" }); expect(postCount).toBe(1);
  });
  it.each(["viewer", "unverified", "invited", "foreign", "import"])("rejects %s preparation without sending", async kind => {
    const f = await fixture(); let actor = f.user;
    if (kind === "viewer") await db.update(usersTable).set({ role: "viewer" }).where(eq(usersTable.id, f.user));
    if (kind === "unverified") await db.update(usersTable).set({ emailVerifiedAt: null }).where(eq(usersTable.id, f.user));
    if (kind === "invited") { const [invite] = await db.insert(usersTable).values({ id: `invite:${randomUUID()}`, organizationId: f.org, role: "owner", emailVerifiedAt: new Date() }).returning(); actor = invite.id; }
    if (kind === "foreign") actor = (await fixture()).user;
    if (kind === "import") await db.update(leadsTable).set({ creationMethod: "import" }).where(eq(leadsTable.id, f.lead.id));
    await expect(prepareBieEmailProposal(f.org, f.proposal.id, actor, { expectedPayload: f.proposal.payload })).rejects.toMatchObject({ status: kind === "import" ? 409 : 403 });
    expect(transport).not.toHaveBeenCalled();
  });
  it.each(["recipient", "sender", "lead", "monitoring", "content"])("rejects approval after prepared %s changes", async kind => {
    const f = await fixture(); const prepared = await prepare(f);
    if (kind === "recipient") await db.update(contactsTable).set({ email: "changed@example.invalid" }).where(eq(contactsTable.id, f.contact.id));
    if (kind === "sender") await db.update(microsoftConnectionsTable).set({ email: "changed-office@example.invalid" }).where(eq(microsoftConnectionsTable.id, f.connection.id));
    if (kind === "lead") await db.update(leadsTable).set({ summary: "Changed current workflow" }).where(eq(leadsTable.id, f.lead.id));
    if (kind === "monitoring") await db.update(connectors).set({ leadMonitoringEnabled: false, leadMonitoringVersion: 2, leadMonitoringApprovedAt: null }).where(eq(connectors.id, f.connector.id));
    if (kind === "content") await db.update(bieActionProposalsTable).set({ payload: { subject: "Edited", body: "Prepared state removed" } }).where(eq(bieActionProposalsTable.id, f.proposal.id));
    expect(await reviewBieProposal(f.org, f.proposal.id, f.user, "approve", prepared.payload)).toBeNull(); expect(transport).not.toHaveBeenCalled();
  });
  it.each(["recipient", "optout", "source", "reply", "company", "actor", "acknowledgement", "expired claim", "changed content"])("real adapter prevents the customer POST after %s changes during OAuth refresh", async kind => {
    const f = await fixture(); await approve(f);
    onRefresh = async () => {
      if (kind === "recipient") await db.update(contactsTable).set({ email: "changed@example.invalid" }).where(eq(contactsTable.id, f.contact.id));
      if (kind === "optout") await db.update(contactsTable).set({ doNotContactEmail: true }).where(eq(contactsTable.id, f.contact.id));
      if (kind === "source") await db.update(leadsTable).set({ creationMethod: "import" }).where(eq(leadsTable.id, f.lead.id));
      if (kind === "reply") await db.insert(activitiesTable).values({ organizationId: f.org, leadId: f.lead.id, contactId: f.contact.id, type: "customer_reply", title: "Synthetic late reply", occurredAt: new Date() });
      if (kind === "company") await db.insert(customerLifecycleTable).values({ organizationId: f.org, state: "paused", reason: "Synthetic manager hold" });
      if (kind === "actor") await db.update(usersTable).set({ isActive: false }).where(eq(usersTable.id, f.user));
      if (kind === "acknowledgement") await db.update(connectors).set({ leadMonitoringEnabled: false, leadMonitoringVersion: 2, leadMonitoringApprovedAt: null }).where(eq(connectors.id, f.connector.id));
      if (kind === "expired claim") await db.update(revenueExecutionsTable).set({ expiresAt: new Date(0) }).where(eq(revenueExecutionsTable.organizationId, f.org));
      if (kind === "changed content") await db.update(bieActionProposalsTable).set({ payload: { subject: "Changed after approval", body: "No dispatch" } }).where(eq(bieActionProposalsTable.id, f.proposal.id));
    };
    expect(await execute(f)).toMatchObject({ status: "blocked" }); expect(postCount).toBe(0); expect((await receipt(f)).state).toBe("blocked");
    const calls = transport.mock.calls.length; await execute(f); expect(transport).toHaveBeenCalledTimes(calls);
  });
  it("unknown Microsoft effect permanently owns the same proposal and parent, without automatic send replay", async () => {
    const f = await fixture(); await approve(f); unknown = true;
    expect(await execute(f)).toMatchObject({ status: "indeterminate" }); expect(postCount).toBe(1);
    expect((await receipt(f)).state).toBe("indeterminate"); const [parent] = await db.select().from(parents).where(eq(parents.organizationId, f.org));
    expect(parent.dispatchStartedAt).toBeTruthy(); expect(parent.acceptedAt).toBeNull();
    await execute(f); expect(postCount).toBe(1); await expect(prepare(f)).rejects.toMatchObject({ code: "proposal_changed" });
  });
});
