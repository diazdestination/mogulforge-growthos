import { OAuth2Client } from "google-auth-library";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  db,
  estimatesTable,
  leadsTable,
  orgSettingsTable,
  emailSenderPreferencesTable,
  gmailConnectionsTable,
  microsoftConnectionsTable,
  contactsTable,
  usersTable,
  customerLifecycleTable,
  revenueExecutionsTable,
  revenueExecutionEventsTable,
  auditEventsTable,
  emailResponseReviewsTable,
  emailIntelligenceSourcesTable,
} from "@workspace/db";
import { randomUUID } from "node:crypto";
import { encryptSecret } from "../lib/token-encryption";
import {
  returningCustomerFixture,
  returningEstimateDraft,
} from "../test-helpers/returning-customer-fixture";
import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";
import { createEstimate } from "./crm";
import { createCustomerWorkEstimate } from "./returning-customer";
import {
  previewEstimateEmail,
  sendEstimateEmail,
  getEstimateEmailEvidence,
} from "./estimate-delivery";
import * as kernel from "./estimate-delivery-execution";
import * as lifecycle from "./customer-lifecycle";
import { sendEmailForUser } from "./user-email";

const orgs: string[] = [],
  transporter = Object.getPrototypeOf(new OAuth2Client().transporter);
let posts = 0,
  refreshes = 0,
  afterRefresh: (() => Promise<void>) | undefined,
  beforeAck: (() => Promise<void>) | undefined,
  lostAck = false;
const json = (data: unknown) =>
  new Response(JSON.stringify(data), {
    headers: { "content-type": "application/json" },
  });
beforeEach(() => {
  posts = 0;
  refreshes = 0;
  afterRefresh = undefined;
  beforeAck = undefined;
  lostAck = false;
  vi.stubEnv("OAUTH_TOKEN_ENCRYPTION_KEY", "ab".repeat(32));
  vi.stubEnv("GOOGLE_OAUTH_CLIENT_ID", "synthetic");
  vi.stubEnv("GOOGLE_OAUTH_CLIENT_SECRET", "synthetic");
  vi.stubEnv("MICROSOFT_OAUTH_CLIENT_ID", "synthetic");
  vi.stubEnv("MICROSOFT_OAUTH_CLIENT_SECRET", "synthetic");
  vi.stubEnv("APP_ORIGIN", "https://growth.example");
  vi.stubEnv("GROWTHOS_OUTBOUND_HOLD", "false");
  vi.spyOn(OAuth2Client.prototype, "getAccessToken").mockImplementation(
    async () => {
      refreshes++;
      await afterRefresh?.();
      return { token: "synthetic-frozen-access" };
    },
  );
  vi.spyOn(transporter, "request").mockImplementation(async (input: any) => {
    if (
      input.url !==
        "https://gmail.googleapis.com/gmail/v1/users/me/messages/send" ||
      input.method !== "POST"
    )
      throw Error("Unexpected Gmail operation");
    posts++;
    expect(input.retry).toBe(false);
    expect(input.maxRedirects).toBe(0);
    expect(input.headers.Authorization).toBe("Bearer synthetic-frozen-access");
    await beforeAck?.();
    if (lostAck) throw Error("Synthetic lost acknowledgement");
    return { data: { id: "synthetic-gmail-message" } };
  });
  vi.stubGlobal(
    "fetch",
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (
        url.startsWith("https://login.microsoftonline.com/") &&
        url.endsWith("/token")
      ) {
        refreshes++;
        return json({
          token_type: "Bearer",
          access_token: "synthetic-frozen-access",
          refresh_token: "synthetic-rotated-refresh",
          scope: "Mail.Send User.Read",
        });
      }
      if (url.startsWith("https://graph.microsoft.com/v1.0/me?")) {
        await afterRefresh?.();
        return json({ id: "synthetic-mailbox", mail: "office@example.test" });
      }
      if (
        url === "https://graph.microsoft.com/v1.0/me/sendMail" &&
        init?.method === "POST"
      ) {
        posts++;
        expect(
          JSON.parse(String(init.body)).message.internetMessageHeaders,
        ).toBeUndefined();
        await beforeAck?.();
        if (lostAck) throw Error("Synthetic lost acknowledgement");
        return new Response(null, {
          status: 202,
          headers: { "request-id": "synthetic-request" },
        });
      }
      throw Error("Unexpected synthetic transport; no network permitted");
    },
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
afterAll(async () => deleteTestOrgs(...orgs));
async function fixture(provider: "gmail" | "microsoft", returning: boolean) {
  const f = await returningCustomerFixture();
  orgs.push(f.org);
  await db
    .insert(orgSettingsTable)
    .values({ organizationId: f.org, customerEmailSenderUserId: f.office.id });
  await db
    .insert(emailSenderPreferencesTable)
    .values({ organizationId: f.org, userId: f.office.id, provider });
  const encryptedRefreshToken = encryptSecret(
    "synthetic-refresh",
    `${f.org}:${f.office.id}:${provider}`,
  );
  if (provider === "gmail")
    await db.insert(gmailConnectionsTable).values({
      organizationId: f.org,
      userId: f.office.id,
      email: "office@example.test",
      encryptedRefreshToken,
      grantedScopes: ["https://www.googleapis.com/auth/gmail.send"],
    });
  else
    await db.insert(microsoftConnectionsTable).values({
      organizationId: f.org,
      userId: f.office.id,
      accountId: "synthetic-mailbox",
      email: "office@example.test",
      encryptedRefreshToken,
      grantedScopes: ["mail.send", "user.read"],
    });
  const [lead] = await db
    .insert(leadsTable)
    .values({
      organizationId: f.org,
      contactId: f.contact.id,
      propertyId: f.secondProperty.id,
      source: "manual",
    })
    .returning();
  const draft = returningEstimateDraft(f);
  const estimate = returning
    ? (await createCustomerWorkEstimate(f.org, f.actor, draft)).estimate
    : (await createEstimate(
        f.org,
        {
          leadId: lead.id,
          title: draft.title,
          lineItems: draft.lineItems.map((x) => ({ ...x, totalCents: 10000 })),
          notes: draft.notes,
        },
        f.actor,
      ))!;
  return { ...f, estimate, lead, provider };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function review(f: Fixture) {
  const p = await previewEstimateEmail(f.org, f.actor, f.estimate.id, {
    expectedUpdatedAt: new Date(f.estimate.updatedAt).toISOString(),
    expectedWorkVersion: f.estimate.workVersion,
  });
  return {
    previewId: p.previewId,
    payloadSha256: p.payloadSha256,
    confirmed: true as const,
  };
}
const matrix = (["gmail", "microsoft"] as const).flatMap((provider) =>
  [false, true].map((returning) => ({ provider, returning })),
);
it.each(matrix)(
  "uses actual $provider POST once for returning=$returning",
  async ({ provider, returning }) => {
    const f = await fixture(provider, returning),
      raw = await review(f),
      e = await sendEstimateEmail(f.org, f.actor, f.estimate.id, raw);
    expect(e).toMatchObject({
      state: "accepted",
      provider,
      canPrepare: false,
      deliveryConfirmed: false,
    });
    expect(posts).toBe(1);
    expect(refreshes).toBe(1);
    await expect(
      sendEstimateEmail(f.org, f.actor, f.estimate.id, raw),
    ).rejects.toBeDefined();
    expect(posts).toBe(1);
  },
);
it.each(
  matrix.flatMap((m) =>
    [
      "source",
      "sender",
      "role",
      "suppression",
      "reply",
      "company",
      "outbound",
      "expiry",
    ].map((kind) => ({ ...m, kind })),
  ),
)(
  "blocks $provider after $kind changes during OAuth returning=$returning and retains permanent ownership",
  async ({ provider, returning, kind }) => {
    const f = await fixture(provider, returning),
      raw = await review(f);
    afterRefresh = async () => {
      if (kind === "source")
        await db
          .update(estimatesTable)
          .set({ notes: "Changed after review" })
          .where(eq(estimatesTable.id, f.estimate.id));
      if (kind === "sender") {
        const table =
          provider === "gmail"
            ? gmailConnectionsTable
            : microsoftConnectionsTable;
        await db
          .update(table)
          .set({ email: "changed@example.test" })
          .where(eq(table.userId, f.office.id));
      }
      if (kind === "role")
        await db
          .update(usersTable)
          .set({ role: "viewer" })
          .where(eq(usersTable.id, f.actor.userId));
      if (kind === "suppression")
        await db
          .update(contactsTable)
          .set({ doNotContact: true })
          .where(eq(contactsTable.id, f.contact.id));
      if (kind === "reply") {
        const [source] = await db
          .insert(emailIntelligenceSourcesTable)
          .values({ organizationId: f.org, intakeAlias: randomUUID() })
          .returning();
        await db.insert(emailResponseReviewsTable).values({
          organizationId: f.org,
          sourceId: source.id,
          externalMessageId: randomUUID(),
          payloadSha256: "a".repeat(64),
          reason: "Synthetic reply",
          state: "confirmed",
          leadId: f.lead.id,
          contactId: f.contact.id,
          holdActive: true,
        });
      }
      if (kind === "company")
        await db.insert(customerLifecycleTable).values({
          organizationId: f.org,
          state: "paused",
          reason: "Synthetic hold",
        });
      if (kind === "outbound") vi.stubEnv("GROWTHOS_OUTBOUND_HOLD", "true");
      if (kind === "expiry") {
        const [r] = await db
          .select()
          .from(auditEventsTable)
          .where(eq(auditEventsTable.id, raw.previewId));
        vi.spyOn(Date, "now").mockReturnValue(r.createdAt.getTime() + 600000);
      }
    };
    const e = await sendEstimateEmail(f.org, f.actor, f.estimate.id, raw);
    expect(e.canPrepare).toBe(false);
    expect(["held", "uncertain"]).toContain(e.state);
    expect(posts).toBe(0);
    afterRefresh = undefined;
    vi.stubEnv("GROWTHOS_OUTBOUND_HOLD", "false");
    await expect(
      sendEstimateEmail(f.org, f.actor, f.estimate.id, raw),
    ).rejects.toBeDefined();
    expect(posts).toBe(0);
  },
);
it.each(matrix)(
  "lost $provider acknowledgment never retries returning=$returning",
  async ({ provider, returning }) => {
    const f = await fixture(provider, returning),
      raw = await review(f);
    lostAck = true;
    expect(
      await sendEstimateEmail(f.org, f.actor, f.estimate.id, raw),
    ).toMatchObject({
      state: "uncertain",
      canPrepare: false,
      acceptedAt: null,
    });
    expect(posts).toBe(1);
    await expect(
      sendEstimateEmail(f.org, f.actor, f.estimate.id, raw),
    ).rejects.toBeDefined();
    expect(posts).toBe(1);
  },
);
it.each(matrix)(
  "$provider finalization failure keeps one owned effect returning=$returning",
  async ({ provider, returning }) => {
    const f = await fixture(provider, returning),
      raw = await review(f);
    vi.spyOn(kernel, "finalizeEstimateEmail").mockRejectedValue(
      Error("Synthetic private finalization failure"),
    );
    const e = await sendEstimateEmail(f.org, f.actor, f.estimate.id, raw);
    expect(e).toMatchObject({
      state: "uncertain",
      canPrepare: false,
      acceptedAt: null,
    });
    expect(posts).toBe(1);
    await expect(
      sendEstimateEmail(f.org, f.actor, f.estimate.id, raw),
    ).rejects.toBeDefined();
    expect(posts).toBe(1);
    expect(
      (await getEstimateEmailEvidence(f.org, f.estimate.id)).canPrepare,
    ).toBe(false);
  },
);
it.each(matrix)(
  "$provider retains uncertainty when acceptance finalization fails once returning=$returning",
  async ({ provider, returning }) => {
    const f = await fixture(provider, returning),
      raw = await review(f),
      original = kernel.finalizeEstimateEmail;
    vi.spyOn(kernel, "finalizeEstimateEmail")
      .mockRejectedValueOnce(Error("Synthetic atomic acceptance rollback"))
      .mockImplementation(original);
    const e = await sendEstimateEmail(f.org, f.actor, f.estimate.id, raw);
    expect(e).toMatchObject({
      state: "uncertain",
      acceptedAt: null,
      canPrepare: false,
    });
    expect(await getEstimateEmailEvidence(f.org, f.estimate.id)).toMatchObject({
      state: "uncertain",
      canPrepare: false,
    });
    expect(posts).toBe(1);
  },
);
it.each(
  matrix.flatMap((m) =>
    ["review", "execution"].map((deadlineKind) => ({ ...m, deadlineKind })),
  ),
)(
  "$provider cannot POST when a subsequent async lifecycle check crosses $deadlineKind expiry returning=$returning",
  async ({ provider, returning, deadlineKind }) => {
    const f = await fixture(provider, returning),
      raw = await review(f);
    const [reviewRow] = await db
      .select()
      .from(auditEventsTable)
      .where(eq(auditEventsTable.id, raw.previewId));
    const deadline =
      reviewRow.createdAt.getTime() +
      (deadlineKind === "review" ? 600000 : 300000);
    if (deadlineKind === "execution")
      afterRefresh = async () => {
        await db
          .update(revenueExecutionsTable)
          .set({ expiresAt: new Date(deadline) })
          .where(eq(revenueExecutionsTable.organizationId, f.org));
      };
    vi.spyOn(Date, "now").mockReturnValue(deadline - 1);
    let kernelPassed = false;
    const originalGuard = kernel.assertEstimateEmailDispatch,
      originalLifecycle = lifecycle.assertCustomerLifecycleActive;
    vi.spyOn(kernel, "assertEstimateEmailDispatch").mockImplementation(
      async (claim) => {
        await originalGuard(claim);
        kernelPassed = true;
      },
    );
    vi.spyOn(lifecycle, "assertCustomerLifecycleActive").mockImplementation(
      async (...args) => {
        await originalLifecycle(...args);
        if (kernelPassed) {
          await Promise.resolve();
          vi.mocked(Date.now).mockReturnValue(deadline);
        }
      },
    );
    const e = await sendEstimateEmail(f.org, f.actor, f.estimate.id, raw);
    expect(kernelPassed).toBe(true);
    expect(posts).toBe(0);
    expect(e).toMatchObject({ state: "held", canPrepare: false });
  },
);
it.each(["gmail", "microsoft"] as const)(
  "unchanged legacy %s caller retains exactly one early callback",
  async (provider) => {
    const f = await fixture(provider, false),
      guard = vi.fn(async () => {});
    await sendEmailForUser({
      organizationId: f.org,
      userId: f.office.id,
      to: f.contact.email!,
      subject: "Synthetic legacy email",
      body: "Synthetic body",
      beforeDispatch: guard,
    });
    expect(guard).toHaveBeenCalledOnce();
    expect(posts).toBe(1);
  },
);
it.each(
  matrix.flatMap((m) =>
    ["role", "suppression", "outbound", "source", "sender"].map((kind) => ({
      ...m,
      kind,
    })),
  ),
)(
  "$provider holds $kind changed in async tail checks returning=$returning",
  async ({ provider, returning, kind }) => {
    const f = await fixture(provider, returning),
      raw = await review(f);
    let kernelPassed = false,
      changed = false;
    const originalGuard = kernel.assertEstimateEmailDispatch,
      originalLifecycle = lifecycle.assertCustomerLifecycleActive;
    vi.spyOn(kernel, "assertEstimateEmailDispatch").mockImplementation(
      async (claim) => {
        await originalGuard(claim);
        kernelPassed = true;
      },
    );
    vi.spyOn(lifecycle, "assertCustomerLifecycleActive").mockImplementation(
      async (...args) => {
        await originalLifecycle(...args);
        if (!kernelPassed || changed) return;
        changed = true;
        if (kind === "role")
          await db
            .update(usersTable)
            .set({ role: "viewer" })
            .where(eq(usersTable.id, f.actor.userId));
        if (kind === "suppression")
          await db
            .update(contactsTable)
            .set({ doNotContact: true })
            .where(eq(contactsTable.id, f.contact.id));
        if (kind === "outbound") vi.stubEnv("GROWTHOS_OUTBOUND_HOLD", "true");
        if (kind === "source")
          await db
            .update(estimatesTable)
            .set({ notes: "Synthetic tail change" })
            .where(eq(estimatesTable.id, f.estimate.id));
        if (kind === "sender") {
          const table =
            provider === "gmail"
              ? gmailConnectionsTable
              : microsoftConnectionsTable;
          await db
            .update(table)
            .set({ connectedAt: new Date(Date.now() + 1000) })
            .where(eq(table.userId, f.office.id));
        }
      },
    );
    const e = await sendEstimateEmail(f.org, f.actor, f.estimate.id, raw);
    expect(changed).toBe(true);
    expect(posts).toBe(0);
    expect(e.canPrepare).toBe(false);
    expect(["held", "uncertain"]).toContain(e.state);
  },
);
it.each(matrix)(
  "late $provider acknowledgment retains original evidence and operator reconciliation returning=$returning",
  async ({ provider, returning }) => {
    const f = await fixture(provider, returning),
      raw = await review(f);
    beforeAck = async () => {
      const [execution] = await db
        .select()
        .from(revenueExecutionsTable)
        .where(eq(revenueExecutionsTable.organizationId, f.org));
      await db
        .update(revenueExecutionsTable)
        .set({ state: "confirmed_not_performed", completedAt: new Date() })
        .where(eq(revenueExecutionsTable.id, execution.id));
      await db.insert(revenueExecutionEventsTable).values({
        organizationId: f.org,
        executionId: execution.id,
        state: "confirmed_not_performed",
        actorUserId: f.actor.userId,
        detail: "Synthetic operator reconciliation",
      });
      await db
        .update(estimatesTable)
        .set({
          title: "Changed after external POST",
          notes: "Changed original quote",
        })
        .where(eq(estimatesTable.id, f.estimate.id));
      await db.insert(customerLifecycleTable).values({
        organizationId: f.org,
        state: "paused",
        reason: "Synthetic pause after POST",
      });
    };
    const e = await sendEstimateEmail(f.org, f.actor, f.estimate.id, raw);
    expect(e).toMatchObject({
      state: "reconciled",
      provider,
      canPrepare: false,
      document: { title: f.estimate.title },
    });
    expect(Boolean(e.acceptedAt)).toBe(true);
    expect(posts).toBe(1);
    const [current] = await db
      .select()
      .from(estimatesTable)
      .where(eq(estimatesTable.id, f.estimate.id));
    expect(current.title).toBe("Changed after external POST");
    expect(current.status).toBe("draft");
    await expect(
      sendEstimateEmail(f.org, f.actor, f.estimate.id, raw),
    ).rejects.toBeDefined();
    expect(posts).toBe(1);
  },
);
