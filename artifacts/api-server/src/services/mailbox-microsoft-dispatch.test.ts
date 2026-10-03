import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  db,
  microsoftConnectionsTable,
  organizationsTable,
  usersTable,
} from "@workspace/db";
import { encryptSecret } from "../lib/token-encryption";
import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";
import type { MailboxIdentity } from "./mailbox-contract";
const boundary = vi.hoisted(() => ({
  identity: vi.fn<() => Promise<MailboxIdentity | null>>(),
  claim: vi.fn<() => Promise<{ name: string; value: string }>>(),
}));
vi.mock("./mailbox-connector", () => ({
  getMicrosoftMailboxIdentity: boundary.identity,
}));
vi.mock("./mailbox-communication", () => ({
  assertMailboxOutboundParentDispatch: boundary.claim,
}));
import { sendMicrosoftForUser } from "./microsoft-oauth";
let org: string, user: string;
const transport = vi.fn<typeof fetch>();
const header = { name: "x-growthos-parent-id", value: "a".repeat(64) };
const response = (value: unknown) => new Response(JSON.stringify(value));
const input = () => ({
  organizationId: org,
  userId: user,
  to: "customer@example.invalid",
  subject: "Synthetic exact reminder",
  body: "Synthetic body only",
  outboundParentId: randomUUID(),
});
beforeEach(async () => {
  vi.stubEnv("MICROSOFT_OAUTH_CLIENT_ID", "synthetic-client");
  vi.stubEnv("MICROSOFT_OAUTH_CLIENT_SECRET", "synthetic-secret");
  vi.stubEnv("MICROSOFT_OAUTH_TENANT_ID", "common");
  vi.stubEnv("APP_ORIGIN", "https://growth.example");
  vi.stubEnv("OAUTH_TOKEN_ENCRYPTION_KEY", "a".repeat(64));
  vi.stubEnv("GROWTHOS_OUTBOUND_HOLD", "false");
  vi.stubEnv("FLY_APP_NAME", "");
  [org] = (
    await db
      .insert(organizationsTable)
      .values({ name: "Synthetic parent dispatch", slug: randomUUID() })
      .returning()
  ).map((v) => v.id);
  [user] = (
    await db
      .insert(usersTable)
      .values({
        organizationId: org,
        role: "owner",
        emailVerifiedAt: new Date(),
      })
      .returning()
  ).map((v) => v.id);
  const [connection] = await db
    .insert(microsoftConnectionsTable)
    .values({
      organizationId: org,
      userId: user,
      accountId: "synthetic_account",
      email: "staff@example.invalid",
      grantedScopes: ["mail.send", "user.read"],
      encryptedRefreshToken: encryptSecret(
        "synthetic-refresh",
        `${org}:${user}:microsoft`,
      ),
    })
    .returning();
  boundary.identity
    .mockReset()
    .mockResolvedValue({
      organizationId: org,
      senderUserId: user,
      provider: "microsoft",
      connectionId: connection.id,
      connectionRevision: connection.connectedAt.toISOString(),
      mailboxAccountId: connection.accountId,
      mailboxEmail: connection.email,
      connectorId: randomUUID(),
      connectorVersion: 1,
      policyVersion: 1,
      startedAt: new Date().toISOString(),
    });
  boundary.claim.mockReset().mockResolvedValue(header);
  transport
    .mockReset()
    .mockResolvedValueOnce(
      response({
        token_type: "Bearer",
        access_token: "synthetic-access",
        scope: "Mail.Send User.Read",
      }),
    )
    .mockResolvedValueOnce(
      response({ id: connection.accountId, mail: connection.email }),
    )
    .mockResolvedValueOnce(new Response(null, { status: 202 }));
  vi.stubGlobal("fetch", transport);
});
afterEach(async () => {
  await deleteTestOrgs(org);
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
it("claims one frozen server header and dispatches once after both full approval guards", async () => {
  const beforeDispatch = vi.fn(async () => {}),
    message = input();
  const result = await sendMicrosoftForUser({ ...message, beforeDispatch });
  expect(result).toMatchObject({ id: null, acceptance: "accepted" });
  expect(beforeDispatch).toHaveBeenCalledTimes(2);
  expect(boundary.claim).toHaveBeenCalledOnce();
  expect(boundary.claim).toHaveBeenCalledWith(
    message.outboundParentId,
    expect.objectContaining({ organizationId: org }),
    { to: message.to, subject: message.subject, body: message.body },
  );
  const sent = transport.mock.calls.filter(([url]) =>
    String(url).endsWith("/sendMail"),
  );
  expect(sent).toHaveLength(1);
  expect(
    JSON.parse(String(sent[0][1]?.body)).message.internetMessageHeaders,
  ).toEqual([header]);
  expect(beforeDispatch.mock.invocationCallOrder[1]).toBeGreaterThan(
    boundary.claim.mock.invocationCallOrder[0],
  );
});
it("a late contact/consent change during the permanent parent claim blocks all POSTs as known no-effect", async () => {
  let allowed = true;
  boundary.claim.mockImplementationOnce(async () => {
    allowed = false;
    return header;
  });
  await expect(
    sendMicrosoftForUser({
      ...input(),
      beforeDispatch: async () => {
        if (!allowed) throw new Error("Synthetic private contact change");
      },
    }),
  ).rejects.toMatchObject({
    code: "email_dispatch_blocked",
    effectNotAttempted: true,
  });
  expect(boundary.claim).toHaveBeenCalledOnce();
  expect(transport).toHaveBeenCalledTimes(2);
});
it("a late selected credential change cannot send using the prepared old token", async () => {
  boundary.claim.mockImplementationOnce(async () => {
    await db
      .update(microsoftConnectionsTable)
      .set({ connectedAt: new Date(Date.now() + 5000) })
      .where(eq(microsoftConnectionsTable.organizationId, org));
    return header;
  });
  await expect(sendMicrosoftForUser(input())).rejects.toMatchObject({
    effectNotAttempted: true,
  });
  expect(transport).toHaveBeenCalledTimes(2);
});
it("a late global hold after the claim remains a no-effect block", async () => {
  boundary.claim.mockImplementationOnce(async () => {
    vi.stubEnv("GROWTHOS_OUTBOUND_HOLD", "true");
    return header;
  });
  await expect(sendMicrosoftForUser(input())).rejects.toMatchObject({
    effectNotAttempted: true,
  });
  expect(transport).toHaveBeenCalledTimes(2);
  expect(boundary.claim).toHaveBeenCalledOnce();
});
it("local read disable during the final approval cannot dispatch the already-claimed parent", async () => {
  boundary.claim.mockImplementationOnce(async () => {
    boundary.identity.mockResolvedValueOnce(null);
    return header;
  });
  await expect(sendMicrosoftForUser(input())).rejects.toMatchObject({
    effectNotAttempted: true,
  });
  expect(transport).toHaveBeenCalledTimes(2);
  expect(boundary.claim).toHaveBeenCalledOnce();
});
it("missing read identity cannot reserve a header or dispatch customer mail", async () => {
  boundary.identity.mockResolvedValueOnce(null);
  await expect(sendMicrosoftForUser(input())).rejects.toMatchObject({
    effectNotAttempted: true,
  });
  expect(boundary.claim).not.toHaveBeenCalled();
  expect(transport).toHaveBeenCalledTimes(2);
});
