import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  customerLifecycleTable,
  db,
  emailSenderPreferencesTable,
  microsoftConnectionsTable,
  oauthTransactionsTable,
  organizationsTable,
  usersTable,
} from "@workspace/db";
import {
  mailboxConnectorsTable as connectors,
  mailboxReceiptsTable as receipts,
} from "../../../../lib/db/src/schema/mailbox-connectors";
import { decryptSecret, encryptSecret } from "../lib/token-encryption";
import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";
import {
  assertMailboxIdentityCurrent,
  beginMailboxOAuth,
  completeMailboxOAuth,
  disableMailboxConnector,
  getMailboxStatus,
  getMicrosoftMailboxIdentity,
  processMailboxConnectors,
  getLeadMonitoringApproval,
  assertLeadMonitoringApproval,
  setLeadMonitoringApproval,
} from "./mailbox-connector";
import { MAILBOX_READ_SCOPES } from "./mailbox-contract";
import { MICROSOFT_SCOPES, disconnectMicrosoft } from "./microsoft-oauth";
vi.mock("./mailbox-communication", () => ({
  bindMailboxSentParent: vi.fn(async () => ({
    matched: true,
    reason: "synthetic_observed",
  })),
  isMailboxReplyCandidate: vi.fn(async () => true),
  ingestMailboxReply: vi.fn(async () => ({
    state: "processed",
    reason: "synthetic_review",
  })),
}));
import {
  bindMailboxSentParent,
  ingestMailboxReply,
  isMailboxReplyCandidate,
} from "./mailbox-communication";

let org: string, user: string;
const actor = () => ({ organizationId: org, userId: user });
const profile = { id: "synthetic_account", mail: "staff@example.invalid" };
const tokens = {
  token_type: "Bearer",
  access_token: "synthetic-access",
  refresh_token: "synthetic-read-refresh",
  scope: "Mail.Read User.Read",
};
const respond = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status });
const connector = async () =>
  (
    await db.select().from(connectors).where(eq(connectors.organizationId, org))
  )[0];
const readAad = (row: Awaited<ReturnType<typeof connector>>) =>
  `${org}:${row.id}:${row.version}:mailbox-read`;
const next = (folder: string, token = "delta") =>
  `https://graph.microsoft.com/v1.0/me/mailFolders/${folder}/messages/delta?$deltatoken=${token}`;
const message = (folder: "inbox" | "sentitems", id = `${folder}_message`) => ({
  id,
  internetMessageId: `<${id}@example.invalid>`,
  from: {
    emailAddress: {
      address: folder === "inbox" ? "customer@example.invalid" : profile.mail,
    },
  },
  toRecipients: [
    {
      emailAddress: {
        address: folder === "inbox" ? profile.mail : "customer@example.invalid",
      },
    },
  ],
  subject: "Synthetic care",
  body: {
    contentType: "text",
    content: "Synthetic message; no instructions are executed.",
  },
  sentDateTime: new Date(Date.now() + 1000).toISOString(),
  receivedDateTime: new Date(Date.now() + 1000).toISOString(),
  internetMessageHeaders:
    folder === "inbox"
      ? [{ name: "In-Reply-To", value: "<sentitems_message@example.invalid>" }]
      : [{ name: "x-growthos-parent-id", value: "a".repeat(64) }],
});
async function start() {
  return new URL(
    await beginMailboxOAuth(actor(), {
      expectedVersion: (await connector())?.version ?? 0,
      readAcknowledged: true,
      retentionAcknowledged: true,
      returnPath: "/account",
    }),
  ).searchParams.get("state")!;
}
async function activate() {
  const state = await start();
  const transport = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(respond(tokens))
    .mockResolvedValueOnce(respond(profile))
    .mockResolvedValueOnce(respond({ id: "inbox_id" }))
    .mockResolvedValueOnce(respond({ id: "sent_id" }));
  await completeMailboxOAuth(actor(), state, "synthetic-code", transport);
  return transport;
}
function poll(sent: unknown[] = [], inbox: unknown[] = []) {
  const transport = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(respond(tokens))
    .mockResolvedValueOnce(respond(profile))
    .mockResolvedValueOnce(
      respond({ value: sent, "@odata.deltaLink": next("sent_id") }),
    )
    .mockResolvedValueOnce(
      respond({ value: inbox, "@odata.deltaLink": next("inbox_id") }),
    );
  for (const full of inbox) transport.mockResolvedValueOnce(respond(full));
  return transport;
}
beforeEach(async () => {
  vi.stubEnv("MICROSOFT_MAILBOX_READ_ENABLED", "true");
  vi.stubEnv("MICROSOFT_OAUTH_CLIENT_ID", "synthetic-client");
  vi.stubEnv("MICROSOFT_OAUTH_CLIENT_SECRET", "synthetic-secret");
  vi.stubEnv("APP_ORIGIN", "https://growth.example");
  vi.stubEnv("OAUTH_TOKEN_ENCRYPTION_KEY", "a".repeat(64));
  [org] = (
    await db
      .insert(organizationsTable)
      .values({ name: "Synthetic read company", slug: randomUUID() })
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
  await db.insert(microsoftConnectionsTable).values({
    ...actor(),
    accountId: profile.id,
    email: profile.mail,
    encryptedRefreshToken: encryptSecret(
      "synthetic-send-refresh",
      `${org}:${user}:microsoft`,
    ),
    grantedScopes: ["mail.send", "user.read"],
  });
  await db
    .insert(emailSenderPreferencesTable)
    .values({ ...actor(), provider: "microsoft" });
  vi.mocked(bindMailboxSentParent).mockClear();
  vi.mocked(ingestMailboxReply).mockClear();
  vi.mocked(isMailboxReplyCandidate).mockReset().mockResolvedValue(true);
});
afterEach(async () => {
  await deleteTestOrgs(org);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("separate explicit Microsoft read opt-in", () => {
  it("leaves send-only scopes unchanged and requires explicit confirmations/version", async () => {
    expect(MICROSOFT_SCOPES.some((v) => /Mail.Read/.test(v))).toBe(false);
    expect(
      MAILBOX_READ_SCOPES.some((v) => /Mail.ReadWrite|Mail.Send/.test(v)),
    ).toBe(false);
    await expect(
      beginMailboxOAuth(actor(), { expectedVersion: 0 }),
    ).rejects.toThrow();
    const state = await start(),
      row = await connector();
    expect(row.state).toBe("pending");
    expect(row.encryptedRefreshToken).toBeNull();
    const [flow] = await db
      .select()
      .from(oauthTransactionsTable)
      .where(eq(oauthTransactionsTable.organizationId, org));
    expect(flow.requestedScopes).toEqual(MAILBOX_READ_SCOPES);
    expect(flow.provider).toBe("microsoft_mailbox");
    expect(state.length).toBeGreaterThan(30);
  });
  it("does no provider work with global switch off, company pause, or wrong/unverified member", async () => {
    const transport = vi.fn<typeof fetch>();
    vi.stubEnv("MICROSOFT_MAILBOX_READ_ENABLED", "false");
    await expect(start()).rejects.toMatchObject({
      code: "mailbox_feature_disabled",
    });
    expect(await processMailboxConnectors(org, { transport })).toMatchObject({
      disabled: true,
    });
    vi.stubEnv("MICROSOFT_MAILBOX_READ_ENABLED", "true");
    await db
      .update(usersTable)
      .set({ emailVerifiedAt: null })
      .where(eq(usersTable.id, user));
    await expect(start()).rejects.toMatchObject({
      code: "mailbox_staff_required",
    });
    expect(transport).not.toHaveBeenCalled();
  });
  it("pins the current mailbox/revision and cancels an in-flight read approval on disconnect", async () => {
    const state = await start();
    await disconnectMicrosoft(org, user);
    const transport = vi.fn<typeof fetch>();
    await expect(
      completeMailboxOAuth(actor(), state, "synthetic", transport),
    ).rejects.toMatchObject({ code: "mailbox_oauth_expired" });
    expect(transport).not.toHaveBeenCalled();
    expect((await connector()).state).toBe("disabled");
  });
  it("rechecks a pause after initial approval before exchanging its callback", async () => {
    const state = await start();
    await db.insert(customerLifecycleTable).values({
      organizationId: org,
      state: "paused",
      version: 1,
      reason: "Synthetic hold",
    });
    const transport = vi.fn<typeof fetch>();
    await expect(
      completeMailboxOAuth(actor(), state, "synthetic", transport),
    ).rejects.toMatchObject({ code: "mailbox_company_paused" });
    expect(transport).not.toHaveBeenCalled();
    expect((await connector()).state).toBe("pending");
  });
  it("rejects a different read mailbox without changing the send credential", async () => {
    const state = await start();
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(respond(tokens))
      .mockResolvedValueOnce(
        respond({ id: "different_account", mail: profile.mail }),
      );
    await expect(
      completeMailboxOAuth(actor(), state, "synthetic", transport),
    ).rejects.toMatchObject({ code: "mailbox_sender_changed" });
    const [send] = await db
      .select()
      .from(microsoftConnectionsTable)
      .where(eq(microsoftConnectionsTable.organizationId, org));
    expect(
      decryptSecret(send.encryptedRefreshToken!, `${org}:${user}:microsoft`),
    ).toBe("synthetic-send-refresh");
  });
  it("keeps a distinct encrypted credential and revokes stale exact identity/foreign company", async () => {
    await activate();
    const identity = await getMicrosoftMailboxIdentity(org, user);
    expect(identity).not.toBeNull();
    await expect(
      assertMailboxIdentityCurrent({
        ...identity!,
        organizationId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "mailbox_grant_changed" });
    await db
      .update(microsoftConnectionsTable)
      .set({ connectedAt: new Date(Date.now() + 5000) })
      .where(eq(microsoftConnectionsTable.organizationId, org));
    await expect(assertMailboxIdentityCurrent(identity!)).rejects.toMatchObject(
      { code: "mailbox_sender_changed" },
    );
    const transport = vi.fn<typeof fetch>();
    await processMailboxConnectors(org, { transport });
    expect(transport).not.toHaveBeenCalled();
    expect((await connector()).state).toBe("revoked");
  });
});

describe("durable bounded mailbox cursors", () => {
  it("observes exact Sent Items before Inbox and deduplicates read-state redelivery", async () => {
    await activate();
    const sent = message("sentitems"),
      inbox = message("inbox");
    await processMailboxConnectors(org, { transport: poll([sent], [inbox]) });
    expect(bindMailboxSentParent).toHaveBeenCalledOnce();
    expect(ingestMailboxReply).toHaveBeenCalledOnce();
    expect(
      vi.mocked(bindMailboxSentParent).mock.invocationCallOrder[0],
    ).toBeLessThan(vi.mocked(ingestMailboxReply).mock.invocationCallOrder[0]);
    const row = await connector();
    expect(
      JSON.parse(decryptSecret(row.encryptedCursors!, `${readAad(row)}:cursor`))
        .inbox.continuation,
    ).toBe(next("inbox_id"));
    await processMailboxConnectors(org, { transport: poll([sent], [inbox]) });
    expect(ingestMailboxReply).toHaveBeenCalledOnce();
    expect(
      await db.select().from(receipts).where(eq(receipts.organizationId, org)),
    ).toHaveLength(2);
    expect(JSON.stringify(await getMailboxStatus(org, user))).not.toContain(
      "synthetic-read-refresh",
    );
  });
  it("holds changed-payload redelivery and cursor gaps without advancing/resetting history", async () => {
    await activate();
    const inbox = message("inbox");
    await processMailboxConnectors(org, { transport: poll([], [inbox]) });
    await processMailboxConnectors(org, {
      transport: poll([], [{ ...inbox, subject: "Changed payload" }]),
    });
    expect((await connector()).state).toBe("gap");
    expect(ingestMailboxReply).toHaveBeenCalledOnce();
    const transport = vi.fn<typeof fetch>();
    await processMailboxConnectors(org, { transport });
    expect(transport).not.toHaveBeenCalled();
  });
  it("preserves the prior continuation when downstream intake fails, and never resets on 410", async () => {
    await activate();
    const before = await connector();
    vi.mocked(bindMailboxSentParent).mockRejectedValueOnce(
      new Error("Synthetic failure"),
    );
    await processMailboxConnectors(org, {
      transport: poll([message("sentitems")], []),
    });
    const after = await connector();
    expect(after.encryptedCursors).toBe(before.encryptedCursors);
    expect(after.state).toBe("gap");
    await activate();
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(respond(tokens))
      .mockResolvedValueOnce(respond(profile))
      .mockResolvedValueOnce(respond({}, 410));
    await processMailboxConnectors(org, { transport });
    expect((await connector()).lastErrorCode).toBe("mailbox_cursor_gap");
    expect(transport).toHaveBeenCalledTimes(3);
  });
  it("retains an unmatched reply for exact-ID bounded retry, not a new send", async () => {
    await activate();
    const inbox = message("inbox");
    vi.mocked(ingestMailboxReply).mockResolvedValueOnce({
      state: "unmatched",
      reason: "parent_not_observed",
    });
    const transport = poll([], [inbox])
      .mockResolvedValueOnce(respond(inbox))
      .mockResolvedValueOnce(respond(inbox));
    await processMailboxConnectors(org, { transport });
    expect(ingestMailboxReply).toHaveBeenCalledTimes(2);
    expect(String(transport.mock.calls[4][0])).toContain(
      "/mailFolders/inbox_id/messages/inbox_message?",
    );
    expect(
      (
        await db.select().from(receipts).where(eq(receipts.organizationId, org))
      )[0].state,
    ).toBe("processed");
  });
  it("honors pause/disable/lease before reading and serializes independent ticks", async () => {
    await activate();
    await db.insert(customerLifecycleTable).values({
      organizationId: org,
      state: "paused",
      version: 1,
      reason: "Synthetic hold",
    });
    const transport = vi.fn<typeof fetch>();
    await processMailboxConnectors(org, { transport });
    expect(transport).not.toHaveBeenCalled();
    await db
      .update(customerLifecycleTable)
      .set({ state: "active", version: 2 })
      .where(eq(customerLifecycleTable.organizationId, org));
    await db
      .update(connectors)
      .set({
        leaseToken: randomUUID(),
        leaseExpiresAt: new Date(Date.now() + 60_000),
      })
      .where(eq(connectors.organizationId, org));
    await processMailboxConnectors(org, { transport });
    expect(transport).not.toHaveBeenCalled();
    await disableMailboxConnector(actor(), {
      expectedVersion: (await connector()).version,
      confirmed: true,
    });
    await processMailboxConnectors(org, { transport });
    expect(transport).not.toHaveBeenCalled();
    expect((await connector()).encryptedRefreshToken).toBeNull();
  });
  it("does not fetch unrelated bodies and reviews unsupported known IDs without gapping later messages", async () => {
    await activate();
    const unrelated = message("inbox", "unrelated"),
      oversized = {
        ...message("inbox", "oversized"),
        body: { contentType: "text", content: "é".repeat(40_000) },
      };
    const malformed = {
      ...message("inbox", "malformed"),
      receivedDateTime: "invalid",
    };
    const good = message("inbox", "good");
    vi.mocked(isMailboxReplyCandidate).mockResolvedValueOnce(false);
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(respond(tokens))
      .mockResolvedValueOnce(respond(profile))
      .mockResolvedValueOnce(
        respond({ value: [], "@odata.deltaLink": next("sent_id") }),
      )
      .mockResolvedValueOnce(
        respond({
          value: [unrelated, oversized, malformed, good].map(
            ({ body: _body, ...metadata }) => metadata,
          ),
          "@odata.deltaLink": next("inbox_id"),
        }),
      )
      .mockResolvedValueOnce(respond(oversized))
      .mockResolvedValueOnce(respond(good));
    await processMailboxConnectors(org, { transport });
    expect((await connector()).state).toBe("active");
    expect(ingestMailboxReply).toHaveBeenCalledOnce();
    expect(
      transport.mock.calls.some(([url]) =>
        String(url).includes("/messages/unrelated?"),
      ),
    ).toBe(false);
    expect((await getMailboxStatus(org, user)).reviewCount).toBe(2);
    const stored = await db
      .select()
      .from(receipts)
      .where(eq(receipts.organizationId, org));
    expect(stored).toHaveLength(4);
    expect(JSON.stringify(stored)).not.toContain("Synthetic message");
  });
  it("turns a missing pending immutable ID into visible review without killing the connector", async () => {
    await activate();
    const inbox = message("inbox");
    vi.mocked(ingestMailboxReply).mockResolvedValueOnce({
      state: "unmatched",
      reason: "parent_not_observed",
    });
    await processMailboxConnectors(org, {
      transport: poll([], [inbox]).mockResolvedValueOnce(respond({}, 404)),
    });
    expect((await connector()).state).toBe("active");
    expect((await getMailboxStatus(org, user)).reviewCount).toBe(1);
  });
  it("only one of overlapping workers can refresh/read a leased mailbox", async () => {
    await activate();
    let entered!: () => void, release!: (response: Response) => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const transport = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(async () => {
        entered();
        return new Promise<Response>((resolve) => {
          release = resolve;
        });
      })
      .mockResolvedValueOnce(respond(profile))
      .mockResolvedValueOnce(
        respond({ value: [], "@odata.deltaLink": next("sent_id") }),
      )
      .mockResolvedValueOnce(
        respond({ value: [], "@odata.deltaLink": next("inbox_id") }),
      );
    const first = processMailboxConnectors(org, { transport });
    await started;
    const secondTransport = vi.fn<typeof fetch>();
    try {
      expect(
        await processMailboxConnectors(org, { transport: secondTransport }),
      ).toMatchObject({ checked: 0 });
      expect(secondTransport).not.toHaveBeenCalled();
    } finally {
      release(respond(tokens));
      await first;
    }
    expect(transport).toHaveBeenCalledTimes(4);
    expect((await connector()).leaseToken).toBeNull();
  });
});
describe("explicit tracked lead context", () => {
  const command = async (enabled: boolean) => ({
    expectedConnectorVersion: (await connector()).version,
    expectedLeadMonitoringVersion: (await connector()).leadMonitoringVersion,
    enabled,
    leadContextAcknowledged: true,
  });
  it("defaults to service-only and preserves exact service identity/cursor when lead context changes", async () => {
    await activate();
    const before = await connector(),
      original = (await getMicrosoftMailboxIdentity(org, user))!;
    expect(await getLeadMonitoringApproval(original)).toBeNull();
    await setLeadMonitoringApproval(actor(), await command(true));
    const approval = await getLeadMonitoringApproval(original);
    expect(approval).toMatchObject({ version: 1 });
    expect(await getMicrosoftMailboxIdentity(org, user)).toEqual(original);
    const after = await connector();
    expect(after.encryptedCursors).toBe(before.encryptedCursors);
    expect(after.version).toBe(before.version);
    expect(after.startedAt).toEqual(before.startedAt);
    await assertLeadMonitoringApproval(original, approval!);
    await setLeadMonitoringApproval(actor(), await command(false));
    await expect(
      assertLeadMonitoringApproval(original, approval!),
    ).rejects.toMatchObject({ code: "mailbox_lead_approval_changed" });
    await setLeadMonitoringApproval(actor(), await command(true));
    expect((await getLeadMonitoringApproval(original))?.version).toBe(3);
    await expect(
      assertLeadMonitoringApproval(original, approval!),
    ).rejects.toMatchObject({ code: "mailbox_lead_approval_changed" });
  });
  it("rejects missing confirmation, stale versions, foreign owner and inactive connector", async () => {
    await activate();
    const input = await command(true);
    await expect(
      setLeadMonitoringApproval(actor(), {
        ...input,
        leadContextAcknowledged: false,
      }),
    ).rejects.toThrow();
    await expect(
      setLeadMonitoringApproval(
        { ...actor(), organizationId: randomUUID() },
        input,
      ),
    ).rejects.toMatchObject({ code: "mailbox_staff_required" });
    await expect(
      setLeadMonitoringApproval(actor(), {
        ...input,
        expectedConnectorVersion: input.expectedConnectorVersion + 1,
      }),
    ).rejects.toMatchObject({ code: "mailbox_lead_version_changed" });
    await setLeadMonitoringApproval(actor(), input);
    await expect(
      setLeadMonitoringApproval(actor(), input),
    ).rejects.toMatchObject({ code: "mailbox_lead_version_changed" });
    await setLeadMonitoringApproval(actor(), await command(false));
    await disableMailboxConnector(actor(), {
      expectedVersion: (await connector()).version,
      confirmed: true,
    });
    await expect(
      setLeadMonitoringApproval(actor(), await command(true)),
    ).rejects.toMatchObject({ code: "mailbox_grant_changed" });
  });
  it("allows local lead revoke while globally held and a new read opt-in starts service-only", async () => {
    await activate();
    await setLeadMonitoringApproval(actor(), await command(true));
    vi.stubEnv("MICROSOFT_MAILBOX_READ_ENABLED", "false");
    const status = await setLeadMonitoringApproval(
      actor(),
      await command(false),
    );
    expect(status.leadMonitoringEnabled).toBe(false);
    await expect(
      setLeadMonitoringApproval(actor(), await command(true)),
    ).rejects.toMatchObject({ code: "mailbox_feature_disabled" });
    vi.stubEnv("MICROSOFT_MAILBOX_READ_ENABLED", "true");
    await setLeadMonitoringApproval(actor(), await command(true));
    await activate();
    expect((await getMailboxStatus(org, user)).leadMonitoringEnabled).toBe(
      false,
    );
  });
  it("rechecks a pending candidate before body fetch while valid service pending evidence continues", async () => {
    await activate();
    const lead = message("inbox", "lead_pending"),
      service = message("inbox", "service_pending");
    vi.mocked(ingestMailboxReply)
      .mockResolvedValueOnce({
        state: "unmatched",
        reason: "parent_not_observed",
      })
      .mockResolvedValueOnce({
        state: "unmatched",
        reason: "parent_not_observed",
      });
    vi.mocked(isMailboxReplyCandidate)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const transport = poll([], [lead, service])
      .mockResolvedValueOnce(respond(lead))
      .mockResolvedValueOnce(respond(service))
      .mockResolvedValueOnce(respond(service));
    await processMailboxConnectors(org, { transport });
    const reads = transport.mock.calls.filter(([url]) =>
      String(url).includes("/messages/"),
    );
    const leadReads = reads.filter(([url]) =>
      String(url).includes("/lead_pending?"),
    );
    expect(leadReads).toHaveLength(2);
    expect(String(leadReads[0][0])).toContain(",body");
    expect(String(leadReads[1][0])).not.toContain(",body");
    expect(ingestMailboxReply).toHaveBeenCalledTimes(3);
    expect((await connector()).state).toBe("active");
  });
});
