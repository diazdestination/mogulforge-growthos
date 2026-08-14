import {
  db,
  gmailConnectionsTable,
  organizationsTable,
  usersTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const googleMocks = vi.hoisted(() => ({
  generateAuthUrl: vi.fn(),
  getToken: vi.fn(),
  request: vi.fn(),
  revokeToken: vi.fn(),
  setCredentials: vi.fn(),
  verifyIdToken: vi.fn(),
}));

vi.mock("google-auth-library", () => ({
  CodeChallengeMethod: { S256: "S256" },
  OAuth2Client: class {
    generateAuthUrl = googleMocks.generateAuthUrl;
    getToken = googleMocks.getToken;
    request = googleMocks.request;
    revokeToken = googleMocks.revokeToken;
    setCredentials = googleMocks.setCredentials;
    verifyIdToken = googleMocks.verifyIdToken;
  },
}));

import { encryptSecret } from "../lib/token-encryption";
import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";
import {
  beginGmailOAuth,
  classifyGmailProviderError,
  completeGmailOAuth,
  disconnectGmail,
  getGmailConnection,
  getGmailStatus,
  GMAIL_REAUTH_REQUIRED,
  sendGmailForUser,
} from "./gmail-oauth";
import { listGoogleModules } from "./google-business-graph";

const previousEncryptionKey = process.env.OAUTH_TOKEN_ENCRYPTION_KEY;
const previousClientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
const previousClientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
const previousRedirectUri = process.env.GOOGLE_OAUTH_REDIRECT_URI;
const orgIds: string[] = [];
const userIds: string[] = [];

beforeAll(async () => {
  process.env.OAUTH_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 19).toString("base64");
  process.env.GOOGLE_OAUTH_CLIENT_ID = "gmail-test-client";
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = "gmail-test-secret";
  process.env.GOOGLE_OAUTH_REDIRECT_URI = "https://growthos.example.test/api/v1/integrations/gmail/callback";
  const nonce = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  for (const suffix of ["a", "b"]) {
    const [org] = await db
      .insert(organizationsTable)
      .values({ name: `Gmail tenant ${suffix}`, slug: `test-gmail-${suffix}-${nonce}` })
      .returning();
    const userId = `gmail-user-${suffix}-${nonce}`;
    await db.insert(usersTable).values({
      id: userId,
      email: `gmail-${suffix}-${nonce}@example.test`,
      organizationId: org.id,
      role: "owner",
    });
    orgIds.push(org.id);
    userIds.push(userId);
  }
  await db.insert(gmailConnectionsTable).values({
    organizationId: orgIds[0],
    userId: userIds[0],
    email: "sender-a@example.test",
    encryptedRefreshToken: encryptSecret(
      "tenant-a-refresh-token",
      `${orgIds[0]}:${userIds[0]}:gmail`,
    ),
    grantedScopes: ["https://www.googleapis.com/auth/gmail.send"],
  });
});

beforeEach(() => {
  googleMocks.generateAuthUrl.mockReset().mockImplementation(
    (options: { state: string }) =>
      `https://accounts.google.test/o/oauth2/v2/auth?state=${encodeURIComponent(options.state)}`,
  );
  googleMocks.getToken.mockReset();
  googleMocks.request.mockReset();
  googleMocks.revokeToken.mockReset().mockResolvedValue(undefined);
  googleMocks.setCredentials.mockReset();
  googleMocks.verifyIdToken.mockReset();
});

afterAll(async () => {
  for (let index = 0; index < userIds.length; index += 1) {
    await db
      .update(usersTable)
      .set({ organizationId: null })
      .where(eq(usersTable.id, userIds[index]!));
    await deleteTestOrgs(orgIds[index]!);
    await db.delete(usersTable).where(eq(usersTable.id, userIds[index]!));
  }
  if (previousEncryptionKey === undefined) delete process.env.OAUTH_TOKEN_ENCRYPTION_KEY;
  else process.env.OAUTH_TOKEN_ENCRYPTION_KEY = previousEncryptionKey;
  if (previousClientId === undefined) delete process.env.GOOGLE_OAUTH_CLIENT_ID;
  else process.env.GOOGLE_OAUTH_CLIENT_ID = previousClientId;
  if (previousClientSecret === undefined) delete process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  else process.env.GOOGLE_OAUTH_CLIENT_SECRET = previousClientSecret;
  if (previousRedirectUri === undefined) delete process.env.GOOGLE_OAUTH_REDIRECT_URI;
  else process.env.GOOGLE_OAUTH_REDIRECT_URI = previousRedirectUri;
});

describe("per-user Gmail connection isolation", () => {
  it("returns only a connection matching both organization and user", async () => {
    expect(await getGmailConnection(orgIds[0]!, userIds[0]!)).toMatchObject({
      email: "sender-a@example.test",
      organizationId: orgIds[0],
      userId: userIds[0],
    });
    expect(await getGmailConnection(orgIds[1]!, userIds[0]!)).toBeNull();
    expect(await getGmailConnection(orgIds[0]!, userIds[1]!)).toBeNull();
  });

  it("does not report another tenant's sender in connection status", async () => {
    expect(await getGmailStatus(orgIds[0]!, userIds[0]!)).toMatchObject({
      connected: true,
      senderActive: true,
      email: "sender-a@example.test",
    });
    expect(await getGmailStatus(orgIds[1]!, userIds[1]!)).toMatchObject({
      connected: false,
      email: null,
    });
  });

  it("reports optional modules without inventing granted access", async () => {
    const modules = await listGoogleModules(orgIds[0]!, userIds[0]!);
    expect(modules.find((module) => module.id === "gmail_send")).toMatchObject({
      permissionGranted: true,
      enabled: false,
      maturity: "available",
    });
    expect(modules.find((module) => module.id === "drive_selected_files")).toMatchObject({
      permissionGranted: false,
      enabled: false,
      access: "selected_files",
    });
    expect(modules.find((module) => module.id === "gmail_intelligence")).toMatchObject({
      permissionGranted: false,
      maturity: "deferred_restricted",
      risk: "restricted",
    });
  });
});

describe("Gmail authorization lifecycle", () => {
  const restoreActiveConnection = async () => {
    await db
      .update(gmailConnectionsTable)
      .set({
        email: "sender-a@example.test",
        encryptedRefreshToken: encryptSecret(
          "tenant-a-refresh-token",
          `${orgIds[0]}:${userIds[0]}:gmail`,
        ),
        grantedScopes: ["https://www.googleapis.com/auth/gmail.send"],
        revokedAt: null,
        lastErrorAt: null,
        lastErrorCode: null,
      })
      .where(eq(gmailConnectionsTable.userId, userIds[0]!));
  };

  it("classifies expired grants separately from transient provider failures", () => {
    expect(
      classifyGmailProviderError({
        response: { status: 400, data: { error: "invalid_grant" } },
      }),
    ).toEqual({ code: GMAIL_REAUTH_REQUIRED, reconnectRequired: true });
    expect(
      classifyGmailProviderError({
        response: { status: 429, data: { error: { status: "RESOURCE_EXHAUSTED" } } },
      }),
    ).toEqual({ code: "RESOURCE_EXHAUSTED", reconnectRequired: false });
  });

  it("blocks a deactivated sender before contacting Google", async () => {
    await db
      .update(usersTable)
      .set({ isActive: false })
      .where(eq(usersTable.id, userIds[0]!));
    try {
      expect(await getGmailStatus(orgIds[0]!, userIds[0]!)).toMatchObject({
        connected: false,
        senderActive: false,
        email: "sender-a@example.test",
      });
      await expect(
        sendGmailForUser({
          organizationId: orgIds[0]!,
          userId: userIds[0]!,
          to: "recipient@example.com",
          subject: "Deactivated sender test",
          body: "No provider request should be made.",
        }),
      ).rejects.toThrow("Gmail sender account is not active");
      expect(googleMocks.setCredentials).not.toHaveBeenCalled();
      expect(googleMocks.request).not.toHaveBeenCalled();
    } finally {
      await db
        .update(usersTable)
        .set({ isActive: true })
        .where(eq(usersTable.id, userIds[0]!));
    }
  });

  it("fails closed and requires reconnect when Google rejects a revoked grant", async () => {
    googleMocks.request.mockRejectedValueOnce(
      Object.assign(new Error("Token has been expired or revoked"), {
        response: { status: 400, data: { error: "invalid_grant" } },
      }),
    );
    try {
      await expect(
        sendGmailForUser({
          organizationId: orgIds[0]!,
          userId: userIds[0]!,
          to: "recipient@example.com",
          subject: "Authorization lifecycle test",
          body: "No provider message is sent by this mocked test.",
        }),
      ).rejects.toThrow("Gmail authorization expired or was revoked");
      expect(await getGmailConnection(orgIds[0]!, userIds[0]!)).toBeNull();
      expect(await getGmailStatus(orgIds[0]!, userIds[0]!)).toMatchObject({
        connected: false,
        email: "sender-a@example.test",
        lastErrorCode: GMAIL_REAUTH_REQUIRED,
      });
      const [stored] = await db
        .select()
        .from(gmailConnectionsTable)
        .where(eq(gmailConnectionsTable.userId, userIds[0]!));
      expect(stored?.encryptedRefreshToken).toBeNull();
      expect(stored?.revokedAt).toBeInstanceOf(Date);
    } finally {
      await restoreActiveConnection();
    }
  });

  it("removes the local credential even when Google revocation is unavailable", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    googleMocks.revokeToken.mockRejectedValueOnce(new Error("provider unavailable"));
    try {
      await expect(disconnectGmail(orgIds[0]!, userIds[0]!)).resolves.toBe(true);
      expect(googleMocks.revokeToken).toHaveBeenCalledWith("tenant-a-refresh-token");
      expect(await getGmailStatus(orgIds[0]!, userIds[0]!)).toMatchObject({
        connected: false,
        lastErrorAt: null,
        lastErrorCode: null,
      });
    } finally {
      warning.mockRestore();
      await restoreActiveConnection();
    }
  });

  it("reconnects a revoked row only after Google returns a fresh offline token", async () => {
    await db
      .update(gmailConnectionsTable)
      .set({
        encryptedRefreshToken: null,
        revokedAt: new Date(),
        lastErrorAt: new Date(),
        lastErrorCode: GMAIL_REAUTH_REQUIRED,
      })
      .where(eq(gmailConnectionsTable.userId, userIds[0]!));
    googleMocks.getToken.mockResolvedValueOnce({
      tokens: {
        id_token: "verified-id-token",
        refresh_token: "fresh-refresh-token",
        scope: "openid email profile https://www.googleapis.com/auth/gmail.send",
      },
    });
    googleMocks.verifyIdToken.mockResolvedValueOnce({
      getPayload: () => ({ email: "reconnected@example.com", email_verified: true }),
    });
    try {
      const authorizationUrl = await beginGmailOAuth({
        organizationId: orgIds[0]!,
        userId: userIds[0]!,
        returnPath: "/account",
      });
      const state = new URL(authorizationUrl).searchParams.get("state");
      expect(state).toBeTruthy();
      await expect(
        completeGmailOAuth({
          organizationId: orgIds[0]!,
          userId: userIds[0]!,
          state: state!,
          code: "single-use-code",
        }),
      ).resolves.toMatchObject({ email: "reconnected@example.com", returnPath: "/account" });
      expect(await getGmailStatus(orgIds[0]!, userIds[0]!)).toMatchObject({
        connected: true,
        email: "reconnected@example.com",
        lastErrorAt: null,
        lastErrorCode: null,
      });
    } finally {
      await restoreActiveConnection();
    }
  });
});
