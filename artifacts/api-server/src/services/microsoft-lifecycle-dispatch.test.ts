import { randomUUID } from "node:crypto";
import { db, organizationsTable, usersTable, microsoftConnectionsTable, emailSenderPreferencesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { encryptSecret } from "../lib/token-encryption";
import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";
import { transitionCustomerLifecycle } from "./customer-lifecycle";
import { getMicrosoftConnection, sendMicrosoftForUser } from "./microsoft-oauth";
import { sendEmailForUser } from "./user-email";

const organizations: string[] = [];
const fetchMock = vi.fn<typeof fetch>();
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const tokens = () => json({ token_type: "Bearer", access_token: "synthetic-access", refresh_token: "synthetic-refreshed", scope: "Mail.Send User.Read" });
const mailbox = () => json({ id: "synthetic-account", mail: "office@example.invalid" });

beforeEach(() => {
  vi.stubEnv("MICROSOFT_OAUTH_CLIENT_ID", "synthetic-client");
  vi.stubEnv("MICROSOFT_OAUTH_CLIENT_SECRET", "synthetic-secret");
  vi.stubEnv("MICROSOFT_OAUTH_TENANT_ID", "common");
  vi.stubEnv("APP_ORIGIN", "https://growthos.example.invalid");
  vi.stubEnv("OAUTH_TOKEN_ENCRYPTION_KEY", Buffer.alloc(32, 23).toString("base64"));
  vi.stubEnv("GROWTHOS_OUTBOUND_HOLD", "false");
  vi.stubEnv("FLY_APP_NAME", "");
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
afterAll(async () => { await deleteTestOrgs(...organizations); });

async function fixture() {
  const [org] = await db.insert(organizationsTable).values({ name: "Synthetic Microsoft dispatch", slug: `ms-dispatch-${randomUUID()}` }).returning();
  organizations.push(org.id);
  const [user] = await db.insert(usersTable).values({ organizationId: org.id, role: "owner", email: `owner-${randomUUID()}@example.invalid` }).returning();
  await db.insert(microsoftConnectionsTable).values({ organizationId: org.id, userId: user.id,
    accountId: "synthetic-account", email: "office@example.invalid", grantedScopes: ["mail.send", "user.read"],
    encryptedRefreshToken: encryptSecret("synthetic-refresh", `${org.id}:${user.id}:microsoft`) });
  await db.insert(emailSenderPreferencesTable).values({ organizationId: org.id, userId: user.id, provider: "microsoft" });
  return { organizationId: org.id, userId: user.id, to: "recipient@example.invalid", subject: "Synthetic dispatch check", body: "No real provider is contacted." };
}
async function pause(input: Awaited<ReturnType<typeof fixture>>) {
  await transitionCustomerLifecycle(input.organizationId, input.userId, { action: "pause", expectedVersion: 0, reason: "Synthetic pause during mailbox preparation" });
}

it("blocks a newly held company at the direct Microsoft sender before any provider request", async () => {
  const input = await fixture();
  await pause(input);
  fetchMock.mockResolvedValueOnce(tokens()).mockResolvedValueOnce(mailbox()).mockResolvedValueOnce(new Response(null, { status: 202 }));
  await expect(sendMicrosoftForUser(input)).rejects.toMatchObject({ code: "customer_lifecycle_paused" });
  expect(fetchMock).not.toHaveBeenCalled();
});

it.each(["refresh", "mailbox"])("does not dispatch a customer email when pause commits during %s preparation", async boundary => {
  const input = await fixture();
  fetchMock.mockImplementationOnce(async () => {
    if (boundary === "refresh") await pause(input);
    return tokens();
  }).mockImplementationOnce(async () => {
    if (boundary === "mailbox") await pause(input);
    return mailbox();
  }).mockResolvedValueOnce(new Response(null, { status: 202 }));
  await expect(sendEmailForUser(input)).rejects.toMatchObject({ code: "customer_lifecycle_paused" });
  expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/sendMail"))).toBe(false);
  // A company operating hold is not credential revocation or a provider failure.
  const connection = await getMicrosoftConnection(input.organizationId, input.userId);
  expect(connection).toMatchObject({ revokedAt: null, lastErrorCode: null, lastUsedAt: null });
});

it("still accepts an active company's explicit Microsoft sender once without changing its identity", async () => {
  const input = await fixture();
  fetchMock.mockResolvedValueOnce(tokens()).mockResolvedValueOnce(mailbox()).mockResolvedValueOnce(new Response(null, { status: 202 }));
  expect(await sendEmailForUser(input)).toMatchObject({ id: null, provider: "microsoft", senderEmail: "office@example.invalid", acceptance: "accepted" });
  expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/sendMail"))).toHaveLength(1);
});

it("preserves acceptance evidence if the company pauses after the request was handed to Microsoft", async () => {
  const input = await fixture();
  fetchMock.mockResolvedValueOnce(tokens()).mockResolvedValueOnce(mailbox()).mockImplementationOnce(async () => {
    await pause(input);
    return new Response(null, { status: 202 });
  });
  expect(await sendEmailForUser(input)).toMatchObject({ provider: "microsoft", acceptance: "accepted" });
  expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/sendMail"))).toHaveLength(1);
  expect((await getMicrosoftConnection(input.organizationId, input.userId))?.lastUsedAt).toBeInstanceOf(Date);
});

it("still prevents dispatch if the sender is deactivated during refresh", async () => {
  const input = await fixture();
  fetchMock.mockImplementationOnce(async () => {
    await db.update(usersTable).set({ isActive: false }).where(eq(usersTable.id, input.userId));
    return tokens();
  }).mockResolvedValueOnce(mailbox()).mockResolvedValueOnce(new Response(null, { status: 202 }));
  await expect(sendEmailForUser(input)).rejects.toThrow();
  expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/sendMail"))).toBe(false);
});
