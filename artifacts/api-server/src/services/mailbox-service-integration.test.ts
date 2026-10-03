import { randomUUID } from "node:crypto";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { appointmentsTable, auditEventsTable, contactsTable, db, emailSenderPreferencesTable, leadsTable, microsoftConnectionsTable, organizationsTable, orgSettingsTable, revenueExecutionsTable, usersTable } from "@workspace/db";
import { mailboxCommunicationParentsTable as parents, mailboxServiceRepliesTable as replies } from "../../../../lib/db/src/schema/mailbox-communication";
import { mailboxConnectorsTable as connectors } from "../../../../lib/db/src/schema/mailbox-connectors";
import { encryptSecret } from "../lib/token-encryption";
import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";
import { beginMailboxOAuth, completeMailboxOAuth, disableMailboxConnector, getMicrosoftMailboxIdentity, processMailboxConnectors } from "./mailbox-connector";
import { approveServiceCare, getServiceCare } from "./service-care";
import { createServiceObligation } from "./service-obligations";
import { processDueScheduledActions } from "./automation";
import { listServiceMailboxReplies, reviewServiceMailboxReply } from "./mailbox-communication";
import { getServiceWatch, processServiceWatch } from "./service-watch";

// No module mocks: real scheduler, sender, connector, parent, review and watch code.
// Every provider response is synthetic and every transport rejects unknown URLs.
const orgs: string[] = [];
type PostedMessage = { subject: string; body: { content: string }; internetMessageHeaders: { name: string; value: string }[] };
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
afterAll(async () => { for (const org of orgs) { await db.delete(replies).where(eq(replies.organizationId, org)); await db.delete(parents).where(eq(parents.organizationId, org)); } await deleteTestOrgs(...orgs); });
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
it("runs actual approved scheduler send, observes the immutable original parent, queues exact reply review and retains it through read revocation", async () => {
  vi.stubEnv("MICROSOFT_MAILBOX_READ_ENABLED", "true"); vi.stubEnv("MICROSOFT_OAUTH_CLIENT_ID", "synthetic-client"); vi.stubEnv("MICROSOFT_OAUTH_CLIENT_SECRET", "synthetic-secret");
  vi.stubEnv("APP_ORIGIN", "https://growth.example"); vi.stubEnv("OAUTH_TOKEN_ENCRYPTION_KEY", "df".repeat(32)); vi.stubEnv("EMAIL_INTELLIGENCE_ENCRYPTION_KEY", "cf".repeat(32)); vi.stubEnv("GROWTHOS_OUTBOUND_HOLD", "false");
  const [org] = await db.insert(organizationsTable).values({ name: "Synthetic original-mailbox integration", slug: `mailbox-loop-${randomUUID()}` }).returning(); orgs.push(org.id);
  const [staff] = await db.insert(usersTable).values({ organizationId: org.id, role: "owner", emailVerifiedAt: new Date() }).returning();
  const [contact] = await db.insert(contactsTable).values({ organizationId: org.id, firstName: "Synthetic existing service customer", email: "customer@example.invalid" }).returning();
  const actor = { organizationId: org.id, userId: staff.id }, profile = { id: "synthetic_exact_mailbox", mail: "office@example.invalid" };
  await db.insert(microsoftConnectionsTable).values({ ...actor, accountId: profile.id, email: profile.mail, encryptedRefreshToken: encryptSecret("synthetic-send-refresh", `${org.id}:${staff.id}:microsoft`), grantedScopes: ["mail.send", "user.read"] });
  await db.insert(emailSenderPreferencesTable).values({ ...actor, provider: "microsoft" });
  await db.insert(orgSettingsTable).values({ organizationId: org.id, customerEmailSenderUserId: staff.id, sendingHours: { quietHoursEnabled: false } });
  const tokens = (scope: string) => ({ token_type: "Bearer", access_token: "synthetic-access", refresh_token: "synthetic-refreshed", scope });
  const state = new URL(await beginMailboxOAuth(actor, { expectedVersion: 0, readAcknowledged: true, retentionAcknowledged: true })).searchParams.get("state")!;
  const readSetup = vi.fn<typeof fetch>().mockResolvedValueOnce(json(tokens("Mail.Read User.Read"))).mockResolvedValueOnce(json(profile)).mockResolvedValueOnce(json({ id: "inbox_exact" })).mockResolvedValueOnce(json({ id: "sent_exact" }));
  await completeMailboxOAuth(actor, state, "synthetic-code", readSetup);
  const identity = (await getMicrosoftMailboxIdentity(org.id, staff.id))!; expect(identity).not.toBeNull();
  const service = await createServiceObligation(org.id, staff.id, { contactId: contact.id, kind: "warranty_check", equipmentLabel: "Synthetic HVAC warranty check", dueDate: "2026-01-01", noticeDays: 14, assignedUserId: staff.id });
  if ("error" in service) throw new Error(service.error);
  const preview = await getServiceCare(org.id, service.id); expect(preview.preview).not.toBeNull();
  await approveServiceCare(org.id, staff.id, service.id, { requestId: randomUUID(), expectedUpdatedAt: preview.expectedUpdatedAt, channel: "email", previewFingerprint: preview.preview!.fingerprint, agreementNote: "Staff inspected the synthetic current customer agreement; no warranty terms inferred.", expectedServiceConfirmed: true });
  let posted: PostedMessage | null = null;
  let sentAt: string | null = null;
  const sendTransport = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    if (url.endsWith("/token")) return json(tokens("Mail.Send User.Read"));
    if (url.startsWith("https://graph.microsoft.com/v1.0/me?")) return json(profile);
    if (url === "https://graph.microsoft.com/v1.0/me/sendMail" && init?.method === "POST") {
      const payload = JSON.parse(String(init.body)); posted = payload.message; sentAt = new Date().toISOString();
      const [parent] = await db.select().from(parents).where(eq(parents.organizationId, org.id));
      expect(parent.dispatchStartedAt).not.toBeNull(); expect(posted!.internetMessageHeaders).toEqual([{ name: "x-growthos-parent-id", value: parent.correlationHeader }]);
      return new Response(null, { status: 202 });
    }
    throw new Error("Unexpected synthetic send URL; no network fallback");
  });
  vi.stubGlobal("fetch", sendTransport);
  await processDueScheduledActions(org.id);
  expect(sendTransport.mock.calls.filter(([url]) => String(url).endsWith("/sendMail"))).toHaveLength(1);
  expect(posted).not.toBeNull();
  const [parent] = await db.select().from(parents).where(eq(parents.organizationId, org.id)); expect(parent.providerMessageId).toBeNull(); expect(parent.acceptedAt).not.toBeNull();
  const message = posted as unknown as PostedMessage;
  const sent = { id: "sent_service_immutable", internetMessageId: "<exact_service_parent@example.invalid>", from: { emailAddress: { address: profile.mail } }, toRecipients: [{ emailAddress: { address: contact.email! } }],
    subject: message.subject, body: { contentType: "text", content: message.body.content }, sentDateTime: sentAt, receivedDateTime: sentAt, internetMessageHeaders: message.internetMessageHeaders };
  const inbox = { id: "inbox_service_immutable", internetMessageId: "<exact_service_reply@example.invalid>", from: { emailAddress: { address: contact.email! } }, toRecipients: [{ emailAddress: { address: profile.mail } }],
    subject: `Re: ${message.subject}`, body: { contentType: "text", content: "Please call me to choose a visit time. <b>This remains untrusted plain text.</b>" }, sentDateTime: new Date().toISOString(), receivedDateTime: new Date().toISOString(), internetMessageHeaders: [{ name: "In-Reply-To", value: sent.internetMessageId }] };
  const next = (folder: string) => `https://graph.microsoft.com/v1.0/me/mailFolders/${folder}/messages/delta?$deltatoken=synthetic_only`;
  const metadata = <T extends { body: unknown }>(value: T) => { const { body: _body, ...rest } = value; return rest; };
  const unrelated = { ...metadata(inbox), id: "unrelated_immutable", internetMessageId: "<unrelated@example.invalid>", from: { emailAddress: { address: "unrelated@example.invalid" } } };
  const malformed = { ...unrelated, id: "malformed_unrelated_immutable", internetMessageId: "<bad>", internetMessageHeaders: [{ name: "In-Reply-To", value: "<bad-parent>" }] };
  const readTransport = vi.fn<typeof fetch>(async input => {
    const url = String(input);
    if (url.endsWith("/token")) return json(tokens("Mail.Read User.Read"));
    if (url.startsWith("https://graph.microsoft.com/v1.0/me?")) return json(profile);
    if (url.includes("/mailFolders/sent_exact/messages/delta?")) return json({ value: [metadata(sent)], "@odata.deltaLink": next("sent_exact") });
    if (url.includes("/mailFolders/inbox_exact/messages/delta?")) return json({ value: [malformed, metadata(inbox), unrelated], "@odata.deltaLink": next("inbox_exact") });
    if (url.includes("/mailFolders/inbox_exact/messages/inbox_service_immutable?")) return json(inbox);
    throw new Error("Unexpected synthetic reader URL; no network fallback");
  });
  expect(await processMailboxConnectors(org.id, { transport: readTransport })).toMatchObject({ checked: 1 });
  const [connection] = await db.select().from(connectors).where(eq(connectors.organizationId, org.id)); expect(connection.state).toBe("active"); expect(connection.encryptedRefreshToken).not.toBeNull();
  const page = await listServiceMailboxReplies(org.id, staff.id, service.id);
  expect(page.items).toHaveLength(1); expect(page.items[0]).toMatchObject({ state: "needs_review", holdActive: true, content: { text: inbox.body.content } });
  expect(readTransport.mock.calls.filter(([url]) => String(url).includes('/messages/inbox_service_immutable?'))).toHaveLength(1);
  expect(readTransport.mock.calls.some(([url]) => String(url).includes('/messages/unrelated_immutable?'))).toBe(false);
  await processMailboxConnectors(org.id, { transport: readTransport }); expect((await listServiceMailboxReplies(org.id, staff.id, service.id)).items).toHaveLength(1);
  await processServiceWatch(org.id); expect((await getServiceWatch(org.id, staff.id, service.id)).reasons).toContain("reply_received_review");
  expect(await db.select().from(leadsTable).where(eq(leadsTable.organizationId, org.id))).toHaveLength(0); expect(await db.select().from(appointmentsTable).where(eq(appointmentsTable.organizationId, org.id))).toHaveLength(0);
  expect((await db.select().from(auditEventsTable).where(eq(auditEventsTable.organizationId, org.id))).some(event => event.action === "service.care_response_recorded")).toBe(false);
  expect((await db.select().from(revenueExecutionsTable).where(eq(revenueExecutionsTable.organizationId, org.id)))[0].state).toBe("succeeded");
  await disableMailboxConnector(actor, { expectedVersion: connection.version, confirmed: true });
  await expect(reviewServiceMailboxReply(org.id, staff.id, service.id, page.items[0].id, { requestId: randomUUID(), expectedVersion: 1, decision: "office_follow_up", note: "Staff reviewed exact message after test-only local disconnection.", reviewed: true })).rejects.toMatchObject({ code: "mailbox_grant_changed" });
  expect((await listServiceMailboxReplies(org.id, staff.id, service.id)).items[0].holdActive).toBe(true);
  expect(sendTransport.mock.calls.filter(([url]) => String(url).endsWith("/sendMail"))).toHaveLength(1);
});
