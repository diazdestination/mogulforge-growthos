import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  activitiesTable,
  auditEventsTable,
  contactsTable,
  customerLifecycleTable,
  db,
  emailSenderPreferencesTable,
  invoicesTable,
  leadsTable,
  microsoftConnectionsTable,
  revenueExecutionsTable,
  usersTable,
  valueEntriesTable,
} from "@workspace/db";
import { encryptSecret } from "../lib/token-encryption";
import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";
import { invoiceAttemptFixture } from "../test-helpers/invoice-attempt-fixture";
import {
  getInvoiceDelivery,
  previewInvoiceDelivery,
  sendInvoiceDelivery,
} from "./invoice-delivery";
import {
  deliveryFingerprint,
  invoiceDeliveryKey,
} from "./invoice-delivery-contract";
import { addSuppression } from "./send-gate";
import {
  GetInvoiceDeliveryResponse,
  ListInvoiceDeliveryWorklistResponse,
  PreviewInvoiceDeliveryResponse,
  SendInvoiceDeliveryResponse,
} from "@workspace/api-zod";
import { listInvoiceDeliveryWorklist } from "./invoice-delivery-worklist";

// Only the external transport is stubbed. Preview, atomic kernel, customer-email,
// user-email, OAuth preparation and Microsoft dispatch all run their real code.
const orgs: string[] = [];
const transport = vi.fn<typeof fetch>();
const mailbox = {
  id: "synthetic-invoice-mailbox",
  mail: "office@example.invalid",
};
let afterToken: (() => Promise<void>) | undefined;
let afterPost: (() => Promise<void>) | undefined;
let postCount = 0;
let postFailure: "timeout" | "lookalike_guard" | "http_error" | null = null;
const response = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
beforeEach(() => {
  vi.stubEnv("MICROSOFT_OAUTH_CLIENT_ID", "synthetic-client");
  vi.stubEnv("MICROSOFT_OAUTH_CLIENT_SECRET", "synthetic-secret");
  vi.stubEnv("APP_ORIGIN", "https://growth.example");
  vi.stubEnv("OAUTH_TOKEN_ENCRYPTION_KEY", "ab".repeat(32));
  vi.stubEnv("GROWTHOS_OUTBOUND_HOLD", "false");
  afterToken = undefined;
  afterPost = undefined;
  postCount = 0;
  postFailure = null;
  transport.mockReset().mockImplementation(async (input) => {
    const url = String(input);
    if (
      url.startsWith("https://login.microsoftonline.com/") &&
      url.endsWith("/token")
    )
      return response({
        token_type: "Bearer",
        access_token: "synthetic-access",
        refresh_token: "synthetic-rotated",
        scope: "Mail.Send User.Read",
      });
    if (url.startsWith("https://graph.microsoft.com/v1.0/me?")) {
      await afterToken?.();
      return response(mailbox);
    }
    if (url === "https://graph.microsoft.com/v1.0/me/sendMail") {
      postCount++;
      await afterPost?.();
      if (postFailure === "timeout")
        throw new Error(
          "Synthetic lost acknowledgement after possible acceptance",
        );
      if (postFailure === "lookalike_guard")
        throw Object.assign(
          new Error("Synthetic untrusted transport failure"),
          {
            name: "EmailDispatchBlockedError",
            code: "email_dispatch_blocked",
            effectNotAttempted: true,
          },
        );
      if (postFailure === "http_error")
        return response(
          {
            error: { code: "email_dispatch_blocked", effectNotAttempted: true },
          },
          503,
        );
      return new Response(null, {
        status: 202,
        headers: { "request-id": "7e761c05-e9c2-4c00-8200-decd76b5d840" },
      });
    }
    throw new Error(
      "Unexpected external URL in synthetic invoice adapter test",
    );
  });
  vi.stubGlobal("fetch", transport);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
afterAll(async () => {
  await deleteTestOrgs(...orgs);
});
async function fixture() {
  const f = await invoiceAttemptFixture();
  orgs.push(f.org);
  const [connection] = await db
    .insert(microsoftConnectionsTable)
    .values({
      organizationId: f.org,
      userId: f.actor,
      accountId: mailbox.id,
      email: mailbox.mail,
      encryptedRefreshToken: encryptSecret(
        "synthetic-refresh",
        `${f.org}:${f.actor}:microsoft`,
      ),
      grantedScopes: ["mail.send", "user.read"],
    })
    .returning();
  await db
    .insert(emailSenderPreferencesTable)
    .values({ organizationId: f.org, userId: f.actor, provider: "microsoft" });
  return { ...f, connection: connection! };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const preview = (f: Fixture) =>
  previewInvoiceDelivery(f.org, f.actor, f.invoice.id, {
    expectedVersion: f.invoice.version,
  });
const send = (
  f: Fixture,
  p: { previewId: string; payloadSha256: string },
  copy = false,
) =>
  sendInvoiceDelivery(f.org, f.actor, f.invoice.id, {
    previewId: p.previewId,
    payloadSha256: p.payloadSha256,
    confirmed: true,
    ...(copy ? { duplicateCopyAcknowledged: true } : {}),
  });
const receipts = (f: Fixture) =>
  db
    .select()
    .from(revenueExecutionsTable)
    .where(eq(revenueExecutionsTable.organizationId, f.org));
const proofs = (f: Fixture) =>
  db
    .select()
    .from(auditEventsTable)
    .where(
      and(
        eq(auditEventsTable.organizationId, f.org),
        eq(auditEventsTable.action, "invoice_delivery.not_dispatched"),
      ),
    );

describe("real invoice Microsoft adapter with synthetic external transport", () => {
  it("keeps real preview, evidence, send and worklist output aligned with generated OpenAPI contracts", async () => {
    const f = await fixture();
    const p = await preview(f);
    expect(PreviewInvoiceDeliveryResponse.safeParse(p).success).toBe(true);
    expect(
      GetInvoiceDeliveryResponse.safeParse(
        await getInvoiceDelivery(f.org, f.actor, f.invoice.id),
      ).success,
    ).toBe(true);
    expect(
      SendInvoiceDeliveryResponse.safeParse(await send(f, p)).success,
    ).toBe(true);
    const page = await listInvoiceDeliveryWorklist(f.org, f.actor, {});
    expect(ListInvoiceDeliveryWorklistResponse.safeParse(page).success).toBe(
      true,
    );
    expect(page.items[0].delivery.latestAttempt?.proof).toBe(
      "provider_accepted",
    );
    expect(postCount).toBe(1); // The transport is synthetic; no real mailbox is used.
  });
  it("previews without external calls, sends exact text once, then sends only an acknowledged COPY with retained receipts", async () => {
    const f = await fixture();
    const p = await preview(f);
    expect(transport).not.toHaveBeenCalled();
    const first = await send(f, p);
    expect(first).toMatchObject({
      state: "accepted",
      provider: "microsoft",
      providerMessageId: null,
      attemptCount: 1,
      nextIntents: ["additional_copy"],
      deliveryConfirmed: false,
    });
    expect(postCount).toBe(1);
    const post = transport.mock.calls.find(([url]) =>
      String(url).endsWith("/sendMail"),
    )!;
    expect(JSON.parse(String(post[1]?.body))).toEqual({
      message: {
        subject: p.subject,
        body: { contentType: "Text", content: p.body },
        toRecipients: [{ emailAddress: { address: p.recipient } }],
      },
      saveToSentItems: true,
    });
    const copy = await previewInvoiceDelivery(f.org, f.actor, f.invoice.id, {
      expectedVersion: 2,
      intent: "additional_copy",
      expectedLatestExecutionId: first.executionId,
      reason: "Synthetic customer requested another copy of this same invoice.",
    });
    const second = await send(f, copy, true);
    expect(second).toMatchObject({ state: "accepted", attemptCount: 2 });
    expect(second.attempts[0]).toEqual(first.attempts[0]);
    expect(postCount).toBe(2);
    expect(
      transport.mock.calls
        .filter(([url]) => String(url).endsWith("/sendMail"))
        .at(-1)![1]!.body,
    ).toContain("COPY of invoice");
    expect((await send(f, copy, true)).executionId).toBe(second.executionId);
    expect(postCount).toBe(2);
    expect(await proofs(f)).toHaveLength(0);
    expect(
      await db
        .select()
        .from(valueEntriesTable)
        .where(eq(valueEntriesTable.organizationId, f.org)),
    ).toHaveLength(0);
  });

  it.each([
    "recipient",
    "source",
    "assignment",
    "sender",
    "optout",
    "suppression",
    "company",
    "global hold",
    "actor",
    "unverified actor",
    "expired preview",
    "altered review",
    "expired claim",
    "changed claim state",
    "document",
  ])(
    "prevents the actual provider POST after %s changes during OAuth preparation",
    async (kind) => {
      const f = await fixture();
      const p = await preview(f);
      afterToken = async () => {
        if (kind === "recipient")
          await db
            .update(contactsTable)
            .set({ email: "changed@example.invalid" })
            .where(eq(contactsTable.id, f.contact));
        if (kind === "source")
          await db
            .update(leadsTable)
            .set({ source: "Changed source without a timestamp" })
            .where(eq(leadsTable.id, f.lead));
        if (kind === "assignment")
          await db
            .update(leadsTable)
            .set({ assignedUserId: null })
            .where(eq(leadsTable.id, f.lead));
        if (kind === "sender")
          await db
            .update(emailSenderPreferencesTable)
            .set({ provider: "gmail" })
            .where(eq(emailSenderPreferencesTable.organizationId, f.org));
        if (kind === "optout")
          await db
            .update(contactsTable)
            .set({ doNotContactEmail: true })
            .where(eq(contactsTable.id, f.contact));
        if (kind === "suppression")
          await addSuppression({
            organizationId: f.org,
            channel: "email",
            value: "customer@example.invalid",
            reason: "hard_bounce",
          });
        if (kind === "company")
          await db.insert(customerLifecycleTable).values({
            organizationId: f.org,
            state: "paused",
            reason: "Synthetic after-refresh hold",
          });
        if (kind === "global hold")
          vi.stubEnv("GROWTHOS_OUTBOUND_HOLD", "true");
        if (kind === "actor")
          await db
            .update(usersTable)
            .set({ role: "viewer" })
            .where(eq(usersTable.id, f.actor));
        if (kind === "unverified actor")
          await db
            .update(usersTable)
            .set({ emailVerifiedAt: null })
            .where(eq(usersTable.id, f.actor));
        if (kind === "expired preview" || kind === "altered review") {
          const [saved] = await db
            .select()
            .from(auditEventsTable)
            .where(eq(auditEventsTable.id, p.previewId));
          await db
            .update(auditEventsTable)
            .set({
              metadata: {
                ...saved!.metadata,
                ...(kind === "expired preview"
                  ? { expiresAt: new Date(0).toISOString() }
                  : { payloadSha256: "a".repeat(64) }),
              },
            })
            .where(eq(auditEventsTable.id, p.previewId));
        }
        if (kind === "expired claim")
          await db
            .update(revenueExecutionsTable)
            .set({ expiresAt: new Date(0) })
            .where(eq(revenueExecutionsTable.organizationId, f.org));
        if (kind === "changed claim state")
          await db
            .update(revenueExecutionsTable)
            .set({ state: "indeterminate" })
            .where(eq(revenueExecutionsTable.organizationId, f.org));
        if (kind === "document")
          await db
            .update(invoicesTable)
            .set({
              issuedDocument: {
                ...f.invoice.document,
                notes: "Changed issued content",
              },
            })
            .where(eq(invoicesTable.id, f.invoice.id));
      };
      // A concurrently revoked reader cannot receive invoice details; inspect
      // the synthetic retained receipt independently rather than restoring auth.
      await send(f, p).catch(() => undefined);
      expect(
        transport.mock.calls.some(([url]) => String(url).endsWith("/token")),
      ).toBe(true);
      expect(postCount).toBe(0);
      const [receipt] = await receipts(f);
      expect(receipt).toBeDefined();
      expect(receipt!.state).toBe(
        kind === "changed claim state" ? "indeterminate" : "blocked",
      );
      expect(await proofs(f)).toHaveLength(
        kind === "changed claim state" ? 0 : 1,
      );
    },
  );

  it("a safe retry after a real post-OAuth refusal needs a new exact preview", async () => {
    const f = await fixture();
    const p = await preview(f);
    afterToken = async () => {
      vi.stubEnv("GROWTHOS_OUTBOUND_HOLD", "true");
    };
    const refused = await send(f, p);
    expect(refused).toMatchObject({
      state: "held",
      nextIntents: ["retry_not_dispatched"],
    });
    expect(postCount).toBe(0);
    afterToken = undefined;
    vi.stubEnv("GROWTHOS_OUTBOUND_HOLD", "false");
    const retry = await previewInvoiceDelivery(f.org, f.actor, f.invoice.id, {
      expectedVersion: 2,
      intent: "retry_not_dispatched",
      expectedLatestExecutionId: refused.executionId,
      reason: "Synthetic hold corrected and exact invoice reviewed again.",
    });
    const result = await send(f, retry);
    expect(result).toMatchObject({ state: "accepted", attemptCount: 2 });
    expect(result.attempts[0]).toEqual(refused.attempts[0]);
    expect(postCount).toBe(1);
  });

  it.each(["timeout", "lookalike_guard", "http_error"] as const)(
    "never creates no-dispatch proof after the POST reaches transport and returns %s",
    async (failure) => {
      const f = await fixture();
      const p = await preview(f);
      postFailure = failure;
      const result = await send(f, p);
      expect(postCount).toBe(1);
      expect(result).toMatchObject({
        state: "uncertain",
        nextIntents: [],
        attemptCount: 1,
      });
      expect(await proofs(f)).toHaveLength(0);
      expect((await receipts(f))[0]!.state).toBe("indeterminate");
      await send(f, p);
      expect(postCount).toBe(1);
      for (const intent of ["retry_not_dispatched", "additional_copy"])
        await expect(
          previewInvoiceDelivery(f.org, f.actor, f.invoice.id, {
            expectedVersion: 2,
            intent,
            expectedLatestExecutionId: result.executionId,
            reason: "Synthetic note cannot resolve unknown provider effects.",
          }),
        ).rejects.toMatchObject({ code: "invoice_delivery_reserved" });
    },
  );

  it("retains accepted provider evidence when mutable company eligibility changes after the actual POST", async () => {
    const f = await fixture();
    const p = await preview(f);
    afterPost = async () => {
      await db.insert(customerLifecycleTable).values({
        organizationId: f.org,
        state: "paused",
        reason: "Synthetic hold after actual effect",
      });
    };
    expect(await send(f, p)).toMatchObject({
      state: "accepted",
      attemptCount: 1,
    });
    expect(postCount).toBe(1);
    expect(await proofs(f)).toHaveLength(0);
  });

  it("records late provider acceptance without turning interrupted ownership into copy permission", async () => {
    const f = await fixture();
    const p = await preview(f);
    afterPost = async () => {
      await db
        .update(revenueExecutionsTable)
        .set({ state: "indeterminate" })
        .where(eq(revenueExecutionsTable.organizationId, f.org));
    };
    const result = await send(f, p);
    expect(result).toMatchObject({
      state: "uncertain",
      nextIntents: [],
      attemptCount: 1,
    });
    expect(result.attempts[0]).toMatchObject({
      state: "indeterminate",
      proof: "provider_accepted",
    });
    expect(postCount).toBe(1);
    expect(await proofs(f)).toHaveLength(0);
    await send(f, p);
    expect(postCount).toBe(1);
  });

  it("refuses a copy when its approved predecessor proof no longer authorizes the chain after OAuth", async () => {
    const f = await fixture();
    const original = await send(f, await preview(f));
    const copy = await previewInvoiceDelivery(f.org, f.actor, f.invoice.id, {
      expectedVersion: 2,
      intent: "additional_copy",
      expectedLatestExecutionId: original.executionId,
      reason: "Synthetic customer requested another copy of the same invoice.",
    });
    afterToken = async () => {
      await db
        .update(revenueExecutionsTable)
        .set({ state: "confirmed_not_performed" })
        .where(eq(revenueExecutionsTable.id, original.executionId!));
    };
    expect(await send(f, copy, true)).toMatchObject({
      state: "uncertain",
      integrity: "unavailable",
      nextIntents: [],
    });
    expect(postCount).toBe(1); // Only the earlier accepted initial send.
    const rows = await receipts(f);
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.id !== original.executionId)!.state).toBe(
      "blocked",
    );
  });

  it("keeps transactional invoice authority independent of imported provenance and ordinary lead replies", async () => {
    const f = await fixture();
    const importedHistory = {
      version: 1 as const,
      kind: "csv_snapshot" as const,
      originalCreatedAt: null,
      sourceUpdatedAt: null,
      statusChangedAt: null,
      lastContactAt: null,
      snapshotAsOf: null,
      firstImportedAt: new Date().toISOString(),
      lastImportedAt: new Date().toISOString(),
      externalCustomerId: "synthetic-source-customer",
      externalEstimateId: null,
      currency: null,
      fingerprint: "a".repeat(64),
      appliedFingerprint: "b".repeat(64),
      mappedFields: ["firstName", "email"],
    };
    await db
      .update(leadsTable)
      .set({ creationMethod: "import", importedHistory })
      .where(eq(leadsTable.id, f.lead));
    await db.insert(activitiesTable).values({
      organizationId: f.org,
      leadId: f.lead,
      contactId: f.contact,
      type: "customer_reply",
      title:
        "Synthetic lead reply is not a universal transactional invoice ban",
    });
    expect(await send(f, await preview(f))).toMatchObject({
      state: "accepted",
    });
    expect(postCount).toBe(1);
    const [lead] = await db
      .select()
      .from(leadsTable)
      .where(eq(leadsTable.id, f.lead));
    expect(lead!.creationMethod).toBe("import");
    expect(lead!.importedHistory).toEqual(importedHistory);
  });

  it("retains old-format accepted history without inventing the missing original identity needed for a copy", async () => {
    const f = await fixture();
    const fresh = await preview(f);
    const legacyPayload = "b".repeat(64);
    const [oldPreview] = await db
      .insert(auditEventsTable)
      .values({
        organizationId: f.org,
        actorUserId: f.actor,
        action: "invoice_delivery.previewed",
        entityType: "invoice",
        entityId: f.invoice.id,
        metadata: {
          payloadSha256: legacyPayload,
          documentSha256: fresh.documentSha256,
          invoiceVersion: 2,
          expiresAt: new Date(0).toISOString(),
        },
      })
      .returning();
    const [original] = await db
      .insert(revenueExecutionsTable)
      .values({
        organizationId: f.org,
        actorUserId: f.actor,
        kind: "invoice_email",
        actionKey: invoiceDeliveryKey(f.invoice.id),
        state: "succeeded",
        fingerprint: deliveryFingerprint({
          invoiceId: f.invoice.id,
          previewId: oldPreview!.id,
          payloadSha256: legacyPayload,
        }),
        expiresAt: new Date(0),
        completedAt: new Date(),
      })
      .returning();
    await db.insert(auditEventsTable).values({
      organizationId: f.org,
      actorUserId: f.actor,
      action: "invoice_delivery.provider_accepted",
      entityType: "invoice",
      entityId: f.invoice.id,
      metadata: {
        invoiceId: f.invoice.id,
        invoiceNumber: fresh.invoiceNumber,
        previewId: oldPreview!.id,
        payloadSha256: legacyPayload,
        documentSha256: fresh.documentSha256,
        provider: "microsoft",
        providerMessageId: null,
        acceptance: "accepted",
        deliveryConfirmed: false,
        senderUserId: f.actor,
        senderEmail: mailbox.mail,
      },
    });
    const legacy = await getInvoiceDelivery(f.org, f.actor, f.invoice.id);
    expect(legacy).toMatchObject({
      state: "accepted",
      attemptCount: 1,
      nextIntents: [],
      attentionReason: "legacy_review_identity_unavailable",
    });
    expect(legacy.attempts[0]).toMatchObject({
      legacy: true,
      attemptId: null,
      ordinal: 1,
    });
    await expect(
      previewInvoiceDelivery(f.org, f.actor, f.invoice.id, {
        expectedVersion: 2,
        intent: "additional_copy",
        expectedLatestExecutionId: original!.id,
        reason: "Synthetic customer explicitly requested an additional copy.",
      }),
    ).rejects.toMatchObject({ code: "invoice_delivery_reserved" });
    expect(transport).not.toHaveBeenCalled();
    expect(postCount).toBe(0);
    expect((await receipts(f)).find((row) => row.id === original!.id)).toEqual(
      original,
    );
  });
});
