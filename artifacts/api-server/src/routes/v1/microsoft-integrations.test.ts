import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import {
  db,
  organizationsTable,
  usersTable,
  microsoftConnectionsTable,
  oauthTransactionsTable,
  emailSenderPreferencesTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
import { authMiddleware } from "../../middlewares/authMiddleware";
import { createSession } from "../../lib/auth";
import { createApiKey } from "../../services/api-keys";
import { encryptSecret } from "../../lib/token-encryption";
import { deleteTestOrgs } from "../../test-helpers/delete-test-orgs";
import router from "./microsoft-integrations";

const httpFetch = globalThis.fetch;
const providerFetch = vi.fn<typeof fetch>();
let server: Server,
  base: string,
  orgA: string,
  orgB: string,
  userA: string,
  userB: string,
  viewer: string;
const sessions = new Map<string, string>();
async function call(path: string, user = userA, init: RequestInit = {}) {
  return httpFetch(`${base}${path}`, {
    ...init,
    redirect: "manual",
    headers: {
      "content-type": "application/json",
      ...(user ? { authorization: `Bearer ${sessions.get(user)}` } : {}),
      ...init.headers,
    },
  });
}
beforeAll(async () => {
  const stamp = randomUUID();
  const orgs = await db
    .insert(organizationsTable)
    .values([
      { name: "MS route A", slug: `ms-route-a-${stamp}` },
      { name: "MS route B", slug: `ms-route-b-${stamp}` },
    ])
    .returning();
  orgA = orgs[0].id;
  orgB = orgs[1].id;
  userA = `ms-route-a-${stamp}`;
  userB = `ms-route-b-${stamp}`;
  viewer = `ms-route-viewer-${stamp}`;
  for (const [id, organizationId, role] of [
    [userA, orgA, "owner"],
    [userB, orgB, "owner"],
    [viewer, orgA, "viewer"],
  ] as const) {
    await db
      .insert(usersTable)
      .values({ id, organizationId, role, email: `${id}@example.invalid` });
    sessions.set(
      id,
      await createSession({
        user: {
          id,
          email: `${id}@example.invalid`,
          firstName: null,
          lastName: null,
          profileImageUrl: null,
        },
        access_token: "synthetic-only",
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      }),
    );
  }
  const app = express();
  app.use(express.json());
  app.use(authMiddleware);
  app.use("/api/v1", router);
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((done) => server.once("listening", done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
});
beforeEach(async () => {
  vi.stubEnv("MICROSOFT_OAUTH_CLIENT_ID", "synthetic-client");
  vi.stubEnv("MICROSOFT_OAUTH_CLIENT_SECRET", "synthetic-secret");
  vi.stubEnv("MICROSOFT_OAUTH_TENANT_ID", "common");
  vi.stubEnv("APP_ORIGIN", "https://growthos.example.invalid");
  vi.stubEnv(
    "OAUTH_TOKEN_ENCRYPTION_KEY",
    Buffer.alloc(32, 27).toString("base64"),
  );
  providerFetch.mockReset();
  vi.stubGlobal("fetch", providerFetch);
  for (const table of [
    microsoftConnectionsTable,
    oauthTransactionsTable,
    emailSenderPreferencesTable,
  ])
    await db.delete(table).where(eq(table.organizationId, orgA));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
afterAll(async () => {
  await new Promise<void>((done, reject) =>
    server.close((error) => (error ? reject(error) : done())),
  );
  await deleteTestOrgs(orgA, orgB);
});

it("requires a signed-in sender and rejects viewer authorization", async () => {
  expect(
    (
      await call("/integrations/microsoft/connect", "", {
        method: "POST",
        body: "{}",
      })
    ).status,
  ).toBe(401);
  expect(
    (
      await call("/integrations/microsoft/connect", viewer, {
        method: "POST",
        body: "{}",
      })
    ).status,
  ).toBe(403);
  expect(providerFetch).not.toHaveBeenCalled();
});

it("rejects valid API-key access even when the key creator can write CRM data", async () => {
  const { key } = await createApiKey({
    organizationId: orgA,
    createdByUserId: userA,
    role: "sales_rep",
    name: "Synthetic connection isolation",
  });
  for (const [path, method, body] of [
    ["/integrations/microsoft", "GET", undefined],
    ["/integrations/microsoft/connect", "POST", "{}"],
    [
      "/integrations/microsoft/callback?code=synthetic&state=synthetic",
      "GET",
      undefined,
    ],
    ["/integrations/microsoft", "DELETE", undefined],
    ["/integrations/email-sender", "GET", undefined],
    [
      "/integrations/email-sender",
      "PUT",
      JSON.stringify({ provider: "microsoft" }),
    ],
  ]) {
    const response = await call(path!, "", {
      method,
      body,
      headers: { "x-api-key": key },
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: expect.stringContaining("Sign in with your own account"),
    });
  }
  expect(providerFetch).not.toHaveBeenCalled();
});
it("binds connect and callback to the authenticated actor/company, ignoring supplied identity fields", async () => {
  const begun = await call("/integrations/microsoft/connect", userA, {
    method: "POST",
    body: JSON.stringify({
      organizationId: orgB,
      userId: userB,
      returnPath: "https://evil.example",
    }),
  });
  expect(begun.status).toBe(200);
  const url = new URL(
    ((await begun.json()) as { authorizationUrl: string }).authorizationUrl,
  );
  const [row] = await db
    .select()
    .from(oauthTransactionsTable)
    .where(eq(oauthTransactionsTable.organizationId, orgA));
  expect(row.userId).toBe(userA);
  expect(row.returnPath).toBe("/account");
  const denied = await call(
    `/integrations/microsoft/callback?code=synthetic&state=${url.searchParams.get("state")}`,
    userB,
  );
  expect(denied.status).toBe(302);
  expect(denied.headers.get("location")).toBe("/account?microsoft=failed");
  expect(providerFetch).not.toHaveBeenCalled();
});
it("never reflects provider error descriptions or callback secrets into redirects", async () => {
  const denied = await call(
    "/integrations/microsoft/callback?error=denied&error_description=private-secret&code=private-code",
  );
  expect(denied.headers.get("location")).toBe("/account?microsoft=denied");
  expect(denied.headers.get("cache-control")).toBe("no-store");
  expect(denied.headers.get("referrer-policy")).toBe("no-referrer");
});
it("exposes no credentials, does not leak another tenant, and selects only the actor's connected provider", async () => {
  await db.insert(microsoftConnectionsTable).values({
    organizationId: orgA,
    userId: userA,
    accountId: "synthetic-a",
    email: "a@example.invalid",
    encryptedRefreshToken: encryptSecret(
      "private-synthetic-token",
      `${orgA}:${userA}:microsoft`,
    ),
    grantedScopes: ["mail.send", "user.read"],
  });
  const status = await call("/integrations/microsoft");
  const body = (await status.json()) as { connected: boolean };
  expect(body.connected).toBe(true);
  expect(JSON.stringify(body)).not.toMatch(
    /encrypted|private-synthetic|accountId/,
  );
  expect(
    await (await call("/integrations/microsoft", userB)).json(),
  ).toMatchObject({ connected: false, email: null });
  expect(
    (
      await call("/integrations/email-sender", userA, {
        method: "PUT",
        body: JSON.stringify({ provider: "yahoo" }),
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await call("/integrations/email-sender", userA, {
        method: "PUT",
        body: JSON.stringify({
          provider: "microsoft",
          organizationId: orgB,
          userId: userB,
        }),
      })
    ).status,
  ).toBe(200);
  const rows = await db
    .select()
    .from(emailSenderPreferencesTable)
    .where(eq(emailSenderPreferencesTable.organizationId, orgA));
  expect(rows[0].userId).toBe(userA);
  expect(
    await (
      await call("/integrations/microsoft", userA, { method: "DELETE" })
    ).json(),
  ).toMatchObject({ disconnected: true, remoteConsentRevoked: false });
  expect(await (await call("/integrations/email-sender")).json()).toMatchObject(
    { provider: "microsoft", connected: false },
  );
  expect(providerFetch).not.toHaveBeenCalled();
});
