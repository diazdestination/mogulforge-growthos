import express from "express";
import cookieParser from "cookie-parser";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
import {
  db,
  emailSenderPreferencesTable,
  microsoftConnectionsTable,
  organizationsTable,
  usersTable,
} from "@workspace/db";
import { createSession, deleteSession } from "../../lib/auth";
import { encryptSecret } from "../../lib/token-encryption";
import { authMiddleware } from "../../middlewares/authMiddleware";
import { createApiKey } from "../../services/api-keys";
import { deleteTestOrgs } from "../../test-helpers/delete-test-orgs";
import router from "./mailbox-integrations";
const httpFetch = fetch;
let server: Server,
  base: string,
  org: string,
  owner: string,
  office: string,
  key: string;
const sessions: string[] = [];
const input = {
  expectedVersion: 0,
  readAcknowledged: true,
  retentionAcknowledged: true,
  returnPath: "/account",
};
beforeAll(async () => {
  vi.stubEnv("OAUTH_TOKEN_ENCRYPTION_KEY", "a".repeat(64));
  [org] = (
    await db
      .insert(organizationsTable)
      .values({ name: "Synthetic mailbox HTTP", slug: randomUUID() })
      .returning()
  ).map((v) => v.id);
  const people = await db
    .insert(usersTable)
    .values([
      { organizationId: org, role: "owner", emailVerifiedAt: new Date() },
      { organizationId: org, role: "viewer", emailVerifiedAt: new Date() },
    ])
    .returning();
  owner = people[0].id;
  office = people[1].id;
  for (const id of [owner, office])
    sessions.push(
      await createSession({
        user: {
          id,
          email: null,
          firstName: null,
          lastName: null,
          profileImageUrl: null,
        },
        access_token: "synthetic",
      }),
    );
  await db
    .insert(microsoftConnectionsTable)
    .values({
      organizationId: org,
      userId: owner,
      accountId: "synthetic_account",
      email: "staff@example.invalid",
      grantedScopes: ["mail.send", "user.read"],
      encryptedRefreshToken: encryptSecret(
        "synthetic",
        `${org}:${owner}:microsoft`,
      ),
    });
  await db
    .insert(emailSenderPreferencesTable)
    .values({ organizationId: org, userId: owner, provider: "microsoft" });
  key = (
    await createApiKey({
      organizationId: org,
      createdByUserId: owner,
      name: "Synthetic read key",
      role: "owner",
    })
  ).key;
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(authMiddleware);
  app.use("/api/v1", router);
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/mailbox/microsoft`;
});
beforeEach(() => {
  vi.stubEnv("OAUTH_TOKEN_ENCRYPTION_KEY", "a".repeat(64));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const id of sessions) await deleteSession(id);
  await deleteTestOrgs(org);
});
const auth = () => ({
  authorization: `Bearer ${sessions[0]}`,
  "content-type": "application/json",
});
it("requires accepted staff session and read status is no-store without credentials", async () => {
  expect((await httpFetch(base)).status).toBe(401);
  expect(
    (
      await httpFetch(base, {
        headers: { authorization: `Bearer ${sessions[1]}` },
      })
    ).status,
  ).toBe(403);
  expect(
    (await httpFetch(base, { headers: { "x-api-key": key } })).status,
  ).toBe(403);
  const response = await httpFetch(base, { headers: auth() });
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(
    (await httpFetch(base, { headers: { cookie: `sid=${sessions[0]}` } }))
      .status,
  ).toBe(200);
  const body = JSON.stringify(await response.json());
  expect(body).not.toContain("synthetic");
  expect(body).not.toContain("RefreshToken");
});
it("rejects cross-origin Basic/cookie and malformed explicit consent before provider work", async () => {
  const provider = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", provider);
  vi.stubEnv("MICROSOFT_MAILBOX_READ_ENABLED", "true");
  vi.stubEnv("APP_ORIGIN", "https://growth.example");
  for (const headers of [
    { ...auth(), origin: "https://foreign.example" },
    {
      "content-type": "application/json",
      authorization: "Basic arbitrary",
      cookie: `sid=${sessions[0]}`,
    },
    { ...auth(), "sec-fetch-site": "same-site" },
  ])
    expect(
      (
        await httpFetch(`${base}/connect`, {
          method: "POST",
          headers,
          body: JSON.stringify(input),
        })
      ).status,
    ).toBe(403);
  expect(
    (
      await httpFetch(`${base}/connect`, {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({ ...input, organizationId: randomUUID() }),
      })
    ).status,
  ).toBe(400);
  expect(provider).not.toHaveBeenCalled();
});
it("keeps global read opt-in disabled separately from sending access", async () => {
  vi.stubEnv("MICROSOFT_MAILBOX_READ_ENABLED", "false");
  const response = await httpFetch(`${base}/connect`, {
    method: "POST",
    headers: auth(),
    body: JSON.stringify(input),
  });
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({
    code: "mailbox_feature_disabled",
  });
});
it("begins only the explicit read flow for the exact authenticated current sender", async () => {
  vi.stubEnv("MICROSOFT_MAILBOX_READ_ENABLED", "true");
  vi.stubEnv("MICROSOFT_OAUTH_CLIENT_ID", "synthetic-client");
  vi.stubEnv("MICROSOFT_OAUTH_CLIENT_SECRET", "synthetic-secret");
  vi.stubEnv("APP_ORIGIN", "https://growth.example");
  const response = await httpFetch(`${base}/connect`, {
    method: "POST",
    headers: { ...auth(), origin: "https://growth.example" },
    body: JSON.stringify(input),
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { authorizationUrl: string };
  const url = new URL(body.authorizationUrl);
  expect(url.searchParams.get("scope")).toContain("Mail.Read");
  expect(url.searchParams.get("scope")).not.toContain("Mail.ReadWrite");
  expect(url.searchParams.get("scope")).not.toContain("Mail.Send");
  expect(url.searchParams.get("redirect_uri")).toBe(
    "https://growth.example/api/v1/mailbox/microsoft/callback",
  );
});
