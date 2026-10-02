import { randomUUID } from "node:crypto";
import {
  db,
  organizationsTable,
  usersTable,
  microsoftConnectionsTable,
  emailSenderPreferencesTable,
  oauthTransactionsTable,
  gmailConnectionsTable,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  decryptSecret,
  encryptSecret,
  sha256Base64Url,
} from "../lib/token-encryption";
import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";
const gmailSend = vi.hoisted(() => vi.fn());
vi.mock("./gmail-oauth", async (original) => ({
  ...(await original<typeof import("./gmail-oauth")>()),
  sendGmailForUser: gmailSend,
}));
import {
  beginMicrosoftOAuth,
  completeMicrosoftOAuth,
  disconnectMicrosoft,
  getMicrosoftConnection,
  getMicrosoftStatus,
  microsoftOAuthConfigured,
  MICROSOFT_SCOPES,
  sendMicrosoftForUser,
} from "./microsoft-oauth";
import {
  emailAcceptanceEvidence,
  getUserEmailStatus,
  selectUserEmailProvider,
  sendEmailForUser,
} from "./user-email";

let orgA: string, orgB: string, userA: string, userB: string;
const fetchMock = vi.fn<typeof fetch>();
const actor = () => ({ organizationId: orgA, userId: userA });
const context = () => `${orgA}:${userA}:microsoft`;
const message = () => ({
  ...actor(),
  to: "customer@example.invalid",
  subject: "Synthetic service reminder",
  body: "Synthetic-only acceptance.",
});
const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
const token = () => ({
  token_type: "Bearer",
  access_token: "synthetic-access",
  refresh_token: "synthetic-rotated-refresh",
  scope: "Mail.Send User.Read",
});
const profile = () => ({
  id: "synthetic-account-a",
  mail: "sender-a@example.invalid",
});
async function seedMicrosoft() {
  await db
    .insert(microsoftConnectionsTable)
    .values({
      ...actor(),
      ...{ accountId: profile().id, email: profile().mail },
      encryptedRefreshToken: encryptSecret("synthetic-refresh", context()),
      grantedScopes: ["mail.send", "user.read"],
    });
}
async function seedGmail() {
  vi.stubEnv("GOOGLE_OAUTH_CLIENT_ID", "synthetic-google-client");
  vi.stubEnv("GOOGLE_OAUTH_CLIENT_SECRET", "synthetic-google-secret");
  await db
    .insert(gmailConnectionsTable)
    .values({
      ...actor(),
      email: "gmail-a@example.invalid",
      encryptedRefreshToken: "synthetic-mocked-gmail-token",
      grantedScopes: ["https://www.googleapis.com/auth/gmail.send"],
    });
}
function mockExchange() {
  fetchMock
    .mockResolvedValueOnce(response(token()))
    .mockResolvedValueOnce(response(profile()));
}
async function start() {
  return new URL(
    await beginMicrosoftOAuth({ ...actor(), returnPath: "/account" }),
  ).searchParams.get("state")!;
}

beforeAll(async () => {
  const stamp = randomUUID();
  const orgs = await db
    .insert(organizationsTable)
    .values([
      { name: "Microsoft synthetic A", slug: `ms-a-${stamp}` },
      { name: "Microsoft synthetic B", slug: `ms-b-${stamp}` },
    ])
    .returning();
  orgA = orgs[0].id;
  orgB = orgs[1].id;
  userA = `ms-a-${stamp}`;
  userB = `ms-b-${stamp}`;
  await db.insert(usersTable).values([
    {
      id: userA,
      organizationId: orgA,
      email: `${userA}@example.invalid`,
      role: "owner",
    },
    {
      id: userB,
      organizationId: orgB,
      email: `${userB}@example.invalid`,
      role: "owner",
    },
  ]);
});
beforeEach(async () => {
  vi.stubEnv("MICROSOFT_OAUTH_CLIENT_ID", "synthetic-client");
  vi.stubEnv("MICROSOFT_OAUTH_CLIENT_SECRET", "synthetic-secret");
  vi.stubEnv("MICROSOFT_OAUTH_TENANT_ID", "common");
  vi.stubEnv("APP_ORIGIN", "https://growthos.example.invalid");
  vi.stubEnv(
    "OAUTH_TOKEN_ENCRYPTION_KEY",
    Buffer.alloc(32, 21).toString("base64"),
  );
  vi.stubEnv("GROWTHOS_OUTBOUND_HOLD", "false");
  vi.stubEnv("FLY_APP_NAME", "");
  for (const table of [
    microsoftConnectionsTable,
    emailSenderPreferencesTable,
    oauthTransactionsTable,
    gmailConnectionsTable,
  ])
    await db.delete(table).where(eq(table.organizationId, orgA));
  await db
    .update(usersTable)
    .set({ isActive: true, role: "owner", organizationId: orgA })
    .where(eq(usersTable.id, userA));
  fetchMock.mockReset();
  gmailSend
    .mockReset()
    .mockResolvedValue({
      id: "synthetic-gmail-id",
      provider: "gmail",
      senderEmail: "gmail-a@example.invalid",
    });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
afterAll(async () => {
  await deleteTestOrgs(orgA, orgB);
});

describe("Microsoft delegated authorization", () => {
  it("uses exact least-privilege scopes, PKCE, encrypted actor-bound state and fixed origin redirect", async () => {
    const url = new URL(
      await beginMicrosoftOAuth({
        ...actor(),
        returnPath: "//evil.example/redirect",
      }),
    );
    expect(url.origin).toBe("https://login.microsoftonline.com");
    expect(url.searchParams.get("scope")?.split(" ")).toEqual(MICROSOFT_SCOPES);
    expect(url.searchParams.get("scope")).not.toMatch(
      /Mail.Read|Mail.Send.Shared/,
    );
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://growthos.example.invalid/api/v1/integrations/microsoft/callback",
    );
    const [row] = await db
      .select()
      .from(oauthTransactionsTable)
      .where(eq(oauthTransactionsTable.organizationId, orgA));
    expect(row.returnPath).toBe("/account");
    expect(row.stateHash).toBe(sha256Base64Url(url.searchParams.get("state")!));
    const verifier = decryptSecret(
      row.encryptedCodeVerifier,
      `${context()}:oauth`,
    );
    expect(sha256Base64Url(verifier)).toBe(
      url.searchParams.get("code_challenge"),
    );
    expect(() =>
      decryptSecret(
        row.encryptedCodeVerifier,
        `${orgB}:${userA}:microsoft:oauth`,
      ),
    ).toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each([
    "http://evil.example",
    "https://user:secret@example.invalid",
    "https://growthos.example.invalid/path",
  ])("rejects unsafe APP_ORIGIN %s", async (origin) => {
    vi.stubEnv("APP_ORIGIN", origin);
    expect(microsoftOAuthConfigured()).toBe(false);
    await expect(start()).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("rejects foreign actors and read-only members before authorization", async () => {
    await expect(
      beginMicrosoftOAuth({ organizationId: orgB, userId: userA }),
    ).rejects.toThrow(/active authorized/);
    await db
      .update(usersTable)
      .set({ role: "viewer" })
      .where(eq(usersTable.id, userA));
    await expect(start()).rejects.toThrow(/active authorized/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("consumes a callback atomically once; another tenant cannot claim its state", async () => {
    const state = await start();
    await expect(
      completeMicrosoftOAuth({
        organizationId: orgB,
        userId: userB,
        state,
        code: "synthetic-code",
      }),
    ).rejects.toThrow(/expired/);
    mockExchange();
    const results = await Promise.allSettled(
      [1, 2].map(() =>
        completeMicrosoftOAuth({ ...actor(), state, code: "synthetic-code" }),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const connection = await getMicrosoftConnection(orgA, userA);
    expect(connection?.email).toBe(profile().mail);
    expect(connection?.encryptedRefreshToken).not.toContain(
      "synthetic-rotated-refresh",
    );
    expect(decryptSecret(connection!.encryptedRefreshToken!, context())).toBe(
      "synthetic-rotated-refresh",
    );
    expect(await getMicrosoftConnection(orgB, userA)).toBeNull();
  });
  it("refuses expired state before contacting Microsoft", async () => {
    const state = await start();
    await db
      .update(oauthTransactionsTable)
      .set({ expiresAt: new Date(0) })
      .where(eq(oauthTransactionsTable.organizationId, orgA));
    await expect(
      completeMicrosoftOAuth({ ...actor(), state, code: "synthetic" }),
    ).rejects.toThrow(/expired/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("does not reconnect after a local disconnect cancels an in-flight callback", async () => {
    const state = await start();
    let finish!: (value: Response) => void;
    fetchMock
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValueOnce(response(profile()));
    const pending = completeMicrosoftOAuth({
      ...actor(),
      state,
      code: "synthetic",
    });
    const rejected = expect(pending).rejects.toThrow(/cancelled or replaced/);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    await disconnectMicrosoft(orgA, userA);
    finish(response(token()));
    await rejected;
    expect(await getMicrosoftConnection(orgA, userA)).toBeNull();
  });
  it("rechecks membership after provider authorization and refuses missing mail consent", async () => {
    const state = await start();
    fetchMock.mockResolvedValueOnce(
      response({ ...token(), scope: "User.Read" }),
    );
    await expect(
      completeMicrosoftOAuth({ ...actor(), state, code: "synthetic" }),
    ).rejects.toThrow(/authorization/);
    expect(await getMicrosoftConnection(orgA, userA)).toBeNull();
    const nextState = await start();
    mockExchange();
    fetchMock
      .mockReset()
      .mockResolvedValueOnce(response(token()))
      .mockImplementationOnce(async () => {
        await db
          .update(usersTable)
          .set({ isActive: false })
          .where(eq(usersTable.id, userA));
        return response(profile());
      });
    await expect(
      completeMicrosoftOAuth({
        ...actor(),
        state: nextState,
        code: "synthetic",
      }),
    ).rejects.toThrow(/active authorized/);
    expect(await getMicrosoftConnection(orgA, userA)).toBeNull();
  });
});

describe("Microsoft sending and provider selection", () => {
  it("checks the workflow after token refresh and stops before sendMail when approval changed", async () => {
    await seedMicrosoft(); mockExchange();
    const guard = vi.fn(async () => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
      throw new Error("Synthetic cancelled invoice");
    });
    await expect(sendMicrosoftForUser({ ...message(), beforeDispatch: guard })).rejects.toMatchObject({ code: "email_dispatch_blocked", effectNotAttempted: true });
    expect(guard).toHaveBeenCalledWith({ provider: "microsoft", senderEmail: profile().mail });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((await getMicrosoftStatus(orgA, userA)).connected).toBe(true);
  });

  it("does not send from a newly selected provider after preparation began", async () => {
    await seedMicrosoft(); await seedGmail(); await selectUserEmailProvider(orgA, userA, "microsoft");
    mockExchange();
    await expect(sendEmailForUser({ ...message(), beforeDispatch: async () => {
      await selectUserEmailProvider(orgA, userA, "gmail");
    } })).rejects.toMatchObject({ code: "email_dispatch_blocked" });
    expect(fetchMock).toHaveBeenCalledTimes(2); expect(gmailSend).not.toHaveBeenCalled();
  });

  it("refreshes encrypted credentials, sends only as /me, and distinguishes acceptance/correlation from message IDs", async () => {
    await seedMicrosoft();
    mockExchange();
    fetchMock.mockResolvedValueOnce(
      new Response(null, {
        status: 202,
        headers: { "request-id": "e22cd6b4-821b-4b1f-8eb7-2b079684e96a" },
      }),
    );
    const result = await sendMicrosoftForUser(message());
    expect(result).toMatchObject({
      id: null,
      provider: "microsoft",
      acceptance: "accepted",
      senderEmail: profile().mail,
      providerRequestId: "e22cd6b4-821b-4b1f-8eb7-2b079684e96a",
    });
    expect(result.clientRequestId).toMatch(/^[a-f\d-]{36}$/);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const [url, init] = fetchMock.mock.calls[2];
    expect(url).toBe("https://graph.microsoft.com/v1.0/me/sendMail");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(init?.redirect).toBe("error");
    const payload = JSON.parse(String(init?.body));
    expect(payload.message.from).toBeUndefined();
    expect(payload.message.body.contentType).toBe("Text");
    expect(emailAcceptanceEvidence(result)).toMatchObject({
      providerMessageId: null,
      providerRequestId: result.providerRequestId,
      clientRequestId: result.clientRequestId,
      deliveryConfirmed: false,
    });
    const current = await getMicrosoftConnection(orgA, userA);
    expect(decryptSecret(current!.encryptedRefreshToken!, context())).toBe(
      "synthetic-rotated-refresh",
    );
  });
  it("does not silently switch Gmail users when Microsoft is connected", async () => {
    await seedGmail();
    expect(await getUserEmailStatus(orgA, userA)).toMatchObject({
      provider: "gmail",
      connected: true,
    });
    await seedMicrosoft();
    expect(await getUserEmailStatus(orgA, userA)).toMatchObject({
      provider: null,
      connected: false,
    });
    await expect(sendEmailForUser(message())).rejects.toThrow(
      /Choose Gmail or Microsoft/,
    );
    expect(gmailSend).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    await selectUserEmailProvider(orgA, userA, "microsoft");
    mockExchange();
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 202 }));
    expect((await sendEmailForUser(message())).provider).toBe("microsoft");
    expect(gmailSend).not.toHaveBeenCalled();
  });
  it("preserves selected Microsoft identity after disconnect instead of falling back to healthy Gmail", async () => {
    await seedGmail();
    await seedMicrosoft();
    await selectUserEmailProvider(orgA, userA, "microsoft");
    expect(await disconnectMicrosoft(orgA, userA)).toEqual({
      disconnected: true,
      remoteConsentRevoked: false,
    });
    expect(await getUserEmailStatus(orgA, userA)).toMatchObject({
      provider: "microsoft",
      connected: false,
    });
    await expect(sendEmailForUser(message())).rejects.toThrow(
      /selected Microsoft/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(gmailSend).not.toHaveBeenCalled();
  });
  it("explicit Gmail selection stays selected after Microsoft connection", async () => {
    await seedGmail();
    await selectUserEmailProvider(orgA, userA, "gmail");
    await seedMicrosoft();
    expect((await sendEmailForUser(message())).provider).toBe("gmail");
    expect(gmailSend).toHaveBeenCalledOnce();
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("rejects foreign/inactive senders and does not disclose their mailbox", async () => {
    await seedMicrosoft();
    await expect(
      sendMicrosoftForUser({ ...message(), organizationId: orgB }),
    ).rejects.toThrow(/active authorized/);
    await db
      .update(usersTable)
      .set({ isActive: false })
      .where(eq(usersTable.id, userA));
    expect(await getMicrosoftStatus(orgA, userA)).toMatchObject({
      connected: false,
      email: null,
    });
    await expect(sendMicrosoftForUser(message())).rejects.toThrow(
      /active authorized/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("revoked authorization is visible, removes the credential, and never calls sendMail", async () => {
    await seedMicrosoft();
    fetchMock.mockResolvedValueOnce(
      response(
        {
          error: "invalid_grant",
          error_description: "secret provider payload",
        },
        400,
      ),
    );
    await expect(sendMicrosoftForUser(message())).rejects.toThrow(
      /authorization is unavailable or revoked/,
    );
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(await getMicrosoftConnection(orgA, userA)).toBeNull();
    expect(await getMicrosoftStatus(orgA, userA)).toMatchObject({
      connected: false,
      lastErrorCode: "microsoft_reauthorization_required",
    });
  });
  it("refuses a refreshed token that identifies a different mailbox", async () => {
    await seedMicrosoft();
    fetchMock
      .mockResolvedValueOnce(response(token()))
      .mockResolvedValueOnce(
        response({ id: "other-account", mail: "other@example.invalid" }),
      );
    await expect(sendMicrosoftForUser(message())).rejects.toThrow(
      /authorization/,
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it("does not restore a disconnected credential during token refresh", async () => {
    await seedMicrosoft();
    fetchMock
      .mockResolvedValueOnce(response(token()))
      .mockImplementationOnce(async () => {
        await disconnectMicrosoft(orgA, userA);
        return response(profile());
      });
    await expect(sendMicrosoftForUser(message())).rejects.toThrow(
      /authorization/,
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(await getMicrosoftConnection(orgA, userA)).toBeNull();
  });
  it("keeps ambiguous sends visible and performs no retry", async () => {
    await seedMicrosoft();
    mockExchange();
    fetchMock.mockRejectedValueOnce(
      new Error("private network token and recipient"),
    );
    await expect(sendMicrosoftForUser(message())).rejects.toMatchObject({
      code: "microsoft_send_outcome_unknown",
      outcomeUnknown: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(await getMicrosoftStatus(orgA, userA)).toMatchObject({
      lastErrorCode: "microsoft_send_outcome_unknown",
    });
  });
  it.each([429, 503])("does not retry a %s send response", async (status) => {
    await seedMicrosoft();
    mockExchange();
    fetchMock.mockResolvedValueOnce(
      response({ error: "private body" }, status),
    );
    await expect(sendMicrosoftForUser(message())).rejects.toThrow(
      /did not confirm acceptance/,
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
  it("enforces the outbound hold and exact staging recipient allowlist before provider calls", async () => {
    await seedMicrosoft();
    vi.stubEnv("GROWTHOS_OUTBOUND_HOLD", "true");
    await expect(sendMicrosoftForUser(message())).rejects.toThrow(
      /safety hold/,
    );
    vi.stubEnv("GROWTHOS_OUTBOUND_HOLD", "false");
    vi.stubEnv("FLY_APP_NAME", "mogulforge-growthos-staging");
    vi.stubEnv("STAGING_OUTBOUND_APPROVED", "true");
    vi.stubEnv("STAGING_EMAIL_RECIPIENT_ALLOWLIST", "staff@example.invalid");
    await expect(sendMicrosoftForUser(message())).rejects.toThrow(
      /not approved/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("rechecks the outbound hold after refreshing and rejects invalid recipients", async () => {
    await seedMicrosoft();
    await expect(
      sendMicrosoftForUser({
        ...message(),
        to: "a@example.invalid\r\nBcc: other@example.invalid",
      }),
    ).rejects.toThrow(/invalid/);
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock
      .mockResolvedValueOnce(response(token()))
      .mockImplementationOnce(async () => {
        vi.stubEnv("GROWTHOS_OUTBOUND_HOLD", "true");
        return response(profile());
      });
    await expect(sendMicrosoftForUser(message())).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
