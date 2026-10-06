import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  GetInvoiceDeliveryResponse,
  ListInvoiceDeliveryWorklistResponse,
  PreviewInvoiceDeliveryResponse,
  SendInvoiceDeliveryResponse,
} from "@workspace/api-zod";
import {
  activitiesTable,
  auditEventsTable,
  contactsTable,
  customerLifecycleTable,
  db,
  emailIntelligenceSourcesTable,
  emailResponseReviewsTable,
  emailSenderPreferencesTable,
  gmailConnectionsTable,
  invoicesTable,
  leadsTable,
  microsoftConnectionsTable,
  orgSettingsTable,
  propertiesTable,
  projectsTable,
  revenueExecutionsTable,
  usersTable,
} from "@workspace/db";
import { customerWorkRootsTable } from "../../../../lib/db/src/schema/customer-work";
import { invoiceDeliveryAttemptsTable } from "../../../../lib/db/src/schema/invoice-delivery-attempts";
import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";
import {
  returningInvoiceDeliveryFixture,
  type ReturningInvoiceDeliveryFixture as Fixture,
} from "../test-helpers/returning-invoice-delivery-fixture";
import {
  getInvoiceDelivery,
  previewInvoiceDelivery,
  sendInvoiceDelivery,
} from "./invoice-delivery";
import {
  deliveryFingerprint,
  invoiceDeliveryKey,
} from "./invoice-delivery-contract";
import {
  invoiceAttemptReviewMetadataSchema,
  invoiceAttemptReviewV2MetadataSchema,
  invoiceAttemptReviewV3MetadataSchema,
} from "./invoice-delivery-attempts";
import { readCompanyEmailSender } from "./customer-email";
import { selectUserEmailProvider } from "./user-email";
import { getGmailConnection } from "./gmail-oauth";
import { getMicrosoftConnection } from "./microsoft-oauth";
import { updateContact, updateProperty } from "./crm";
import { addSuppression } from "./send-gate";
import { createInvoice, issueInvoice } from "./invoices";
import {
  createCustomerWorkProject,
  updateCustomerWorkProject,
} from "./returning-customer";
import { listInvoiceDeliveryWorklist } from "./invoice-delivery-worklist";
import { updateOrgSettings } from "./settings";

const gmailSend = vi.hoisted(() => vi.fn());
const microsoftSend = vi.hoisted(() => vi.fn());
const customerEmailHooks = vi.hoisted(() => ({
  beforeSend: null as (() => Promise<void>) | null,
}));
vi.mock("./customer-email", async (original) => {
  const actual = await original<typeof import("./customer-email")>();
  return {
    ...actual,
    sendCustomerEmail: async (
      input: Parameters<typeof actual.sendCustomerEmail>[0],
    ) => {
      if (customerEmailHooks.beforeSend) await customerEmailHooks.beforeSend();
      return actual.sendCustomerEmail(input);
    },
  };
});
vi.mock("./gmail-oauth", async (original) => ({
  ...(await original<typeof import("./gmail-oauth")>()),
  sendGmailForUser: gmailSend,
}));
vi.mock("./microsoft-oauth", async (original) => ({
  ...(await original<typeof import("./microsoft-oauth")>()),
  sendMicrosoftForUser: microsoftSend,
}));
const orgs: string[] = [],
  effects: { provider: string; to: string; body: string }[] = [];
let afterOAuth: (() => Promise<void>) | null = null,
  afterPost: (() => Promise<void>) | null = null;
let unknownAfterPost = false;
async function fixture(
  provider: "gmail" | "microsoft" = "gmail",
  property = true,
) {
  const f = await returningInvoiceDeliveryFixture(provider, property);
  orgs.push(f.org);
  return f;
}
const preview = async (f: Fixture) => {
  const p = await previewInvoiceDelivery(f.org, f.actor, f.invoice.id, {
    expectedVersion: f.invoice.version,
  });
  if (p.leadId !== null)
    throw Error("Expected the exact returning-work preview");
  return p;
};
const approval = (p: { previewId: string; payloadSha256: string }) => ({
  previewId: p.previewId,
  payloadSha256: p.payloadSha256,
  confirmed: true,
});
const send = (f: Fixture, p: { previewId: string; payloadSha256: string }) =>
  sendInvoiceDelivery(f.org, f.actor, f.invoice.id, approval(p));
const recover = (
  f: Fixture,
  intent: "retry_not_dispatched" | "additional_copy",
  executionId: string,
) =>
  previewInvoiceDelivery(f.org, f.actor, f.invoice.id, {
    expectedVersion: f.invoice.version,
    intent,
    expectedLatestExecutionId: executionId,
    reason: "Office reviewed this exact retained invoice and customer request.",
  });
async function transport(
  provider: "gmail" | "microsoft",
  input: Parameters<typeof import("./gmail-oauth").sendGmailForUser>[0],
) {
  const connection =
    provider === "gmail"
      ? await getGmailConnection(input.organizationId, input.userId)
      : await getMicrosoftConnection(input.organizationId, input.userId);
  if (!connection) throw Error("Synthetic selected connection unavailable");
  if (afterOAuth) {
    const change = afterOAuth;
    afterOAuth = null;
    await change();
  }
  await input.beforeDispatch?.({ provider, senderEmail: connection.email });
  effects.push({ provider, to: input.to, body: input.body });
  if (afterPost) {
    const change = afterPost;
    afterPost = null;
    await change();
  }
  if (unknownAfterPost)
    throw Error("Email dispatch guard rejected the changed review");
  return {
    provider,
    senderEmail: connection.email,
    id: provider === "gmail" ? `synthetic-message-${effects.length}` : null,
    ...(provider === "microsoft"
      ? {
          providerRequestId: "synthetic-provider-request",
          clientRequestId: "synthetic-client-request",
          acceptance: "accepted",
        }
      : {}),
  };
}
beforeEach(() => {
  vi.stubEnv("GOOGLE_OAUTH_CLIENT_ID", "synthetic-client");
  vi.stubEnv("GOOGLE_OAUTH_CLIENT_SECRET", "synthetic-secret");
  vi.stubEnv("MICROSOFT_OAUTH_CLIENT_ID", "synthetic-client");
  vi.stubEnv("MICROSOFT_OAUTH_CLIENT_SECRET", "synthetic-secret");
  vi.stubEnv(
    "OAUTH_TOKEN_ENCRYPTION_KEY",
    Buffer.alloc(32, 18).toString("base64"),
  );
  vi.stubEnv("APP_ORIGIN", "https://growthos.example.invalid");
  vi.stubEnv("GROWTHOS_OUTBOUND_HOLD", "false");
  vi.stubGlobal("fetch", async () => {
    throw Error("No real provider is allowed in invoice delivery tests");
  });
  effects.length = 0;
  customerEmailHooks.beforeSend = null;
  afterOAuth = null;
  afterPost = null;
  unknownAfterPost = false;
  gmailSend
    .mockReset()
    .mockImplementation((input) => transport("gmail", input));
  microsoftSend
    .mockReset()
    .mockImplementation((input) => transport("microsoft", input));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
afterAll(async () => {
  await deleteTestOrgs(...orgs);
});

it.each(["gmail", "microsoft"] as const)(
  "sends an exact v3 %s invoice with no invented lead or reply-monitor signature, using the original key",
  async (provider) => {
    const f = await fixture(provider),
      p = await preview(f);
    expect(p).toMatchObject({
      reviewVersion: 3,
      leadId: null,
      customerWorkId: f.invoice.customerWorkId,
      contactId: f.contact.id,
      propertyId: f.property!.id,
      sender: {
        userId: f.sender,
        source: "company_default",
        provider,
        senderEmail: f.mailbox,
      },
    });
    expect(
      PreviewInvoiceDeliveryResponse.parse(JSON.parse(JSON.stringify(p))),
    ).toMatchObject({
      reviewVersion: 3,
      customerWorkId: f.invoice.customerWorkId,
      leadId: null,
    });
    const [review] = await db
      .select()
      .from(auditEventsTable)
      .where(eq(auditEventsTable.id, p.previewId));
    expect(
      invoiceAttemptReviewV3MetadataSchema.parse(review.metadata).context,
    ).toMatchObject({
      leadId: null,
      customerWorkId: f.invoice.customerWorkId,
      sourceSha256: p.sourceSha256,
      senderIdentitySha256: p.senderIdentitySha256,
    });
    const result = await send(f, p);
    expect(result).toMatchObject({
      state: "accepted",
      deliveryConfirmed: false,
      attemptCount: 1,
      nextIntents: ["additional_copy"],
    });
    expect(
      SendInvoiceDeliveryResponse.parse(JSON.parse(JSON.stringify(result))),
    ).toMatchObject({ state: "accepted", deliveryConfirmed: false });
    expect(
      GetInvoiceDeliveryResponse.parse(
        JSON.parse(
          JSON.stringify(
            await getInvoiceDelivery(f.org, f.actor, f.invoice.id),
          ),
        ),
      ),
    ).toMatchObject({ state: "accepted", attemptCount: 1 });
    expect(result.attempts[0].actionKey).toBe(invoiceDeliveryKey(f.invoice.id));
    expect(effects).toHaveLength(1);
    expect(result.providerMessageId).toBe(
      provider === "microsoft" ? null : "synthetic-message-1",
    );
    if (provider === "microsoft")
      expect(result.providerRequestId).toBe("synthetic-provider-request");
    const [activity] = await db
      .select()
      .from(activitiesTable)
      .where(
        and(
          eq(activitiesTable.organizationId, f.org),
          eq(activitiesTable.type, "email_sent"),
        ),
      );
    expect(activity).toMatchObject({ leadId: null, contactId: f.contact.id });
    expect(activity.metadata).toMatchObject({
      leadId: null,
      customerWorkId: f.invoice.customerWorkId,
      propertyId: f.property!.id,
      recipient: f.contact.email,
      sourceSha256: p.sourceSha256,
      senderIdentitySha256: p.senderIdentitySha256,
    });
    expect(
      Object.keys(activity.metadata).some((key) =>
        key.startsWith("replyEvidence"),
      ),
    ).toBe(false);
    expect(
      await db
        .select()
        .from(leadsTable)
        .where(eq(leadsTable.organizationId, f.org)),
    ).toHaveLength(0);
    await send(f, p);
    expect(effects).toHaveLength(1);
  },
);

it("reads exact returning worklist context without writes or converting it to a lead", async () => {
  const f = await fixture(),
    foreign = await fixture();
  const before = await db
    .select()
    .from(auditEventsTable)
    .where(eq(auditEventsTable.organizationId, f.org));
  const page = await listInvoiceDeliveryWorklist(f.org, f.actor, {});
  expect(page.items).toHaveLength(1);
  expect(page.items[0]).toMatchObject({
    invoiceId: f.invoice.id,
    organizationId: f.org,
    sourceKind: "customer_work",
    leadId: null,
    customerWorkId: f.invoice.customerWorkId,
    contactId: f.contact.id,
    propertyId: f.property!.id,
    delivery: { integrity: "valid", nextIntents: ["initial"] },
  });
  expect(
    ListInvoiceDeliveryWorklistResponse.parse(JSON.parse(JSON.stringify(page)))
      .items[0],
  ).toMatchObject({
    organizationId: f.org,
    customerWorkId: f.invoice.customerWorkId,
    contactId: f.contact.id,
    propertyId: f.property!.id,
    leadId: null,
    sourceKind: "customer_work",
  });
  expect(page.items.some((item) => item.invoiceId === foreign.invoice.id)).toBe(
    false,
  );
  expect(
    await db
      .select()
      .from(auditEventsTable)
      .where(eq(auditEventsTable.organizationId, f.org)),
  ).toEqual(before);
  expect(
    await db
      .select()
      .from(leadsTable)
      .where(eq(leadsTable.organizationId, f.org)),
  ).toEqual([]);
  expect(effects).toHaveLength(0);
});

it("refuses a selected native job edit during OAuth without changing the issued document or sending", async () => {
  const base = await fixture();
  const fields = {
    name: "Original selected job",
    status: "scheduled" as const,
    scheduledStart: null,
    scheduledEnd: null,
    crewUserIds: [],
    crewNotes: null,
  };
  const { project } = await createCustomerWorkProject(
    base.org,
    { userId: base.actor },
    {
      requestId: randomUUID(),
      confirmed: true,
      source: {
        kind: "existing_customer",
        contactId: base.contact.id,
        propertyId: base.property!.id,
      },
      ...fields,
    },
  );
  const created = await createInvoice(base.org, base.actor, {
    requestId: randomUUID(),
    source: { kind: "customer_work", customerWorkId: project.customerWorkId },
    projectId: project.id,
    document: {
      title: base.invoice.document.title,
      currency: "USD",
      issuerName: base.invoice.document.issuerName,
      customerName: base.invoice.document.customerName,
      lineItems: base.invoice.document.lineItems.map(
        ({ description, quantity, unitPriceCents }) => ({
          description,
          quantity,
          unitPriceCents,
        }),
      ),
      taxCents: base.invoice.document.taxCents,
    },
  });
  const { invoice } = await issueInvoice(
    base.org,
    base.actor,
    created.invoice.id,
    {
      requestId: randomUUID(),
      expectedVersion: created.invoice.version,
      confirmed: true,
    },
  );
  const f = { ...base, invoice },
    p = await preview(f);
  afterOAuth = async () => {
    await updateCustomerWorkProject(f.org, { userId: f.actor }, project.id, {
      requestId: randomUUID(),
      expectedWorkVersion: project.workVersion,
      confirmed: true,
      ...fields,
      name: "Changed selected job",
    });
    await db
      .update(projectsTable)
      .set({ updatedAt: new Date(project.updatedAt) })
      .where(eq(projectsTable.id, project.id));
  };
  const result = await send(f, p);
  expect(result).toMatchObject({
    state: "held",
    nextIntents: ["retry_not_dispatched"],
    attempts: [{ proof: "not_dispatched", state: "blocked" }],
  });
  const [unchanged] = await db
    .select()
    .from(invoicesTable)
    .where(eq(invoicesTable.id, invoice.id));
  expect(unchanged.version).toBe(invoice.version);
  expect(unchanged.issuedDocument).toEqual(invoice.document);
  expect(effects).toHaveLength(0);
});

it("allows an explicit no-property invoice and rejects cross-company, actor and effective-role use before replay", async () => {
  const f = await fixture("gmail", false),
    other = await fixture(),
    p = await preview(f);
  expect(p).toMatchObject({ leadId: null, propertyId: null });
  await expect(
    previewInvoiceDelivery(
      f.org,
      f.actor,
      f.invoice.id,
      { expectedVersion: f.invoice.version },
      "viewer",
    ),
  ).rejects.toMatchObject({ code: "invoice_access_denied" });
  await expect(
    sendInvoiceDelivery(other.org, other.actor, f.invoice.id, approval(p)),
  ).rejects.toBeTruthy();
  await expect(
    sendInvoiceDelivery(f.org, f.sender, f.invoice.id, approval(p)),
  ).rejects.toMatchObject({ code: "invoice_delivery_review_changed" });
  await send(f, p);
  await expect(
    sendInvoiceDelivery(f.org, f.actor, f.invoice.id, approval(p), "sales_rep"),
  ).rejects.toMatchObject({ code: "invoice_access_denied" });
  expect(effects).toHaveLength(1);
});

it("requires a stored explicit company/default provider selection and uses the existing selection flow to restore readiness", async () => {
  const f = await fixture();
  await db
    .delete(emailSenderPreferencesTable)
    .where(eq(emailSenderPreferencesTable.organizationId, f.org));
  await expect(preview(f)).rejects.toMatchObject({
    code: "invoice_delivery_sender_unavailable",
  });
  expect(
    await db
      .select()
      .from(emailSenderPreferencesTable)
      .where(eq(emailSenderPreferencesTable.organizationId, f.org)),
  ).toHaveLength(0);
  await selectUserEmailProvider(f.org, f.sender, "gmail");
  await expect(preview(f)).resolves.toMatchObject({ reviewVersion: 3 });
  await db
    .update(orgSettingsTable)
    .set({ customerEmailSenderUserId: null })
    .where(eq(orgSettingsTable.organizationId, f.org));
  await expect(preview(f)).rejects.toMatchObject({
    code: "invoice_delivery_sender_unavailable",
  });
  expect(effects).toHaveLength(0);
});

it("reads v3 sender identity SELECT-only and ignores token refresh bookkeeping but not replacement identity", async () => {
  const f = await fixture();
  const first = await readCompanyEmailSender(db, f.org);
  await db.transaction(
    async (tx) => {
      expect(await readCompanyEmailSender(tx, f.org)).toEqual(first);
    },
    { accessMode: "read only" },
  );
  await expect(readCompanyEmailSender(db, f.org, true)).rejects.toBeTruthy();
  await db
    .update(gmailConnectionsTable)
    .set({
      encryptedRefreshToken: "synthetic-refreshed",
      updatedAt: new Date(),
      lastUsedAt: new Date(),
    })
    .where(eq(gmailConnectionsTable.organizationId, f.org));
  expect(await readCompanyEmailSender(db, f.org)).toEqual(first);
  await db
    .update(gmailConnectionsTable)
    .set({ connectedAt: new Date(Date.now() + 1000) })
    .where(eq(gmailConnectionsTable.organizationId, f.org));
  expect((await readCompanyEmailSender(db, f.org)).identitySha256).not.toBe(
    first.identitySha256,
  );
});

it.each([
  "customer",
  "address",
  "preference",
  "mailbox",
  "member",
  "sender",
  "hold",
  "reply",
] as const)(
  "records a typed no-dispatch proof for a post-OAuth %s change, allowing only separately reviewed recovery",
  async (mode) => {
    const f = await fixture(),
      p = await preview(f);
    afterOAuth = async () => {
      if (mode === "customer")
        await updateContact(f.org, f.contact.id, {
          firstName: "Changed exact name",
          updatedAt: f.contact.updatedAt,
        });
      if (mode === "address")
        await updateProperty(f.org, f.property!.id, {
          addressLine1: "Changed same-timestamp site",
          updatedAt: f.property!.updatedAt,
        });
      if (mode === "preference")
        await db
          .update(emailSenderPreferencesTable)
          .set({ provider: "microsoft" })
          .where(eq(emailSenderPreferencesTable.organizationId, f.org));
      if (mode === "mailbox")
        await db
          .update(gmailConnectionsTable)
          .set({ email: "replacement@example.invalid" })
          .where(eq(gmailConnectionsTable.organizationId, f.org));
      if (mode === "member")
        await db
          .update(usersTable)
          .set({ role: "sales_manager" })
          .where(eq(usersTable.id, f.actor));
      if (mode === "sender")
        await db
          .update(usersTable)
          .set({ isActive: false })
          .where(eq(usersTable.id, f.sender));
      if (mode === "hold") vi.stubEnv("GROWTHOS_OUTBOUND_HOLD", "true");
      if (mode === "reply") await replyHold(f);
    };
    const r = await send(f, p);
    expect(effects).toHaveLength(0);
    expect(r).toMatchObject({
      state: "held",
      nextIntents: ["retry_not_dispatched"],
      attempts: [{ proof: "not_dispatched", state: "blocked" }],
    });
    expect(r.attempts[0].actionKey).toBe(invoiceDeliveryKey(f.invoice.id));
  },
);

it.each(["coherent-history", "native-root"] as const)(
  "refuses a mismatched immutable v3 root after %s changes without trusting mutually matching proof",
  async (mode) => {
    const f = await fixture(),
      p = await preview(f);
    await send(f, p);
    const [otherRoot] = await db
      .insert(customerWorkRootsTable)
      .values({
        organizationId: f.org,
        contactId: f.contact.id,
        propertyId: f.property!.id,
        createdByUserId: f.actor,
      })
      .returning();
    if (mode === "native-root")
      await db
        .update(invoicesTable)
        .set({ customerWorkId: otherRoot.id })
        .where(eq(invoicesTable.id, f.invoice.id));
    else {
      const [review] = await db
        .select()
        .from(auditEventsTable)
        .where(eq(auditEventsTable.id, p.previewId));
      const metadata = invoiceAttemptReviewV3MetadataSchema.parse(
        review.metadata,
      );
      const altered = {
        ...metadata,
        context: { ...metadata.context, customerWorkId: otherRoot.id },
      };
      await db
        .update(auditEventsTable)
        .set({ metadata: altered })
        .where(eq(auditEventsTable.id, review.id));
      await db
        .update(invoiceDeliveryAttemptsTable)
        .set({ reviewSha256: deliveryFingerprint(altered) })
        .where(eq(invoiceDeliveryAttemptsTable.previewId, p.previewId));
      const [proof] = await db
        .select()
        .from(auditEventsTable)
        .where(
          and(
            eq(auditEventsTable.organizationId, f.org),
            eq(auditEventsTable.action, "invoice_delivery.provider_accepted"),
          ),
        );
      await db
        .update(auditEventsTable)
        .set({ metadata: { ...proof.metadata, customerWorkId: otherRoot.id } })
        .where(eq(auditEventsTable.id, proof.id));
    }
    expect(
      await getInvoiceDelivery(f.org, f.actor, f.invoice.id),
    ).toMatchObject({
      integrity: "unavailable",
      state: "uncertain",
      nextIntents: [],
    });
    expect(effects).toHaveLength(1);
  },
);

it("preserves genuine v3 history after mutable address and mailbox changes, while a fresh copy requires a fresh review", async () => {
  const f = await fixture(),
    p = await preview(f),
    sent = await send(f, p);
  await updateProperty(f.org, f.property!.id, {
    addressLine1: "Later legitimate address correction",
  });
  await db
    .update(gmailConnectionsTable)
    .set({ email: "later-sender@example.invalid" })
    .where(eq(gmailConnectionsTable.organizationId, f.org));
  expect(await getInvoiceDelivery(f.org, f.actor, f.invoice.id)).toMatchObject({
    integrity: "valid",
    state: "accepted",
    nextIntents: ["additional_copy"],
  });
  const fresh = await recover(f, "additional_copy", sent.executionId!);
  expect(fresh.sourceSha256).not.toBe(p.sourceSha256);
  expect(fresh.sender.senderEmail).toBe("later-sender@example.invalid");
  expect(effects).toHaveLength(1);
});
async function replyHold(f: Fixture) {
  const [source] = await db
    .insert(emailIntelligenceSourcesTable)
    .values({ organizationId: f.org, intakeAlias: `synthetic-${randomUUID()}` })
    .returning();
  await db.insert(emailResponseReviewsTable).values({
    organizationId: f.org,
    sourceId: source.id,
    externalMessageId: randomUUID(),
    payloadSha256: "a".repeat(64),
    reason: "Existing confirmed customer reply",
    state: "confirmed",
    contactId: f.contact.id,
    holdActive: true,
  });
}

it.each(["reply", "dnc", "suppression", "lifecycle", "expiry"] as const)(
  "refuses %s before acquiring any new execution",
  async (mode) => {
    const f = await fixture(),
      p = await preview(f);
    if (mode === "reply") await replyHold(f);
    if (mode === "dnc")
      await updateContact(f.org, f.contact.id, { doNotContactEmail: true });
    if (mode === "suppression")
      await addSuppression({
        organizationId: f.org,
        channel: "email",
        value: f.contact.email!,
        reason: "hard_bounce",
        source: "synthetic-test",
      });
    if (mode === "lifecycle")
      await db.insert(customerLifecycleTable).values({
        organizationId: f.org,
        state: "paused",
        version: 1,
        reason: "Synthetic paused company",
      });
    if (mode === "expiry") {
      const [row] = await db
        .select()
        .from(auditEventsTable)
        .where(eq(auditEventsTable.id, p.previewId));
      await db
        .update(auditEventsTable)
        .set({
          metadata: { ...row.metadata, expiresAt: "2000-01-01T00:00:00.000Z" },
        })
        .where(eq(auditEventsTable.id, p.previewId));
    }
    await expect(send(f, p)).rejects.toBeTruthy();
    expect(effects).toHaveLength(0);
    expect(
      await db
        .select()
        .from(revenueExecutionsTable)
        .where(eq(revenueExecutionsTable.organizationId, f.org)),
    ).toHaveLength(0);
  },
);

it("retains the original five-attempt chain through proven retry and separately acknowledged copies", async () => {
  const f = await fixture(),
    initial = await preview(f);
  afterOAuth = async () => {
    vi.stubEnv("GROWTHOS_OUTBOUND_HOLD", "true");
  };
  const blocked = await send(f, initial);
  vi.stubEnv("GROWTHOS_OUTBOUND_HOLD", "false");
  const retry = await recover(f, "retry_not_dispatched", blocked.executionId!);
  let last = await send(f, retry);
  expect(last).toMatchObject({ attemptCount: 2, state: "accepted" });
  while (last.attemptCount < 5) {
    const copy = await recover(f, "additional_copy", last.executionId!);
    expect(copy.subject).toMatch(/^COPY/);
    await expect(send(f, copy)).rejects.toMatchObject({
      code: "invoice_delivery_copy_acknowledgement_required",
    });
    last = await sendInvoiceDelivery(f.org, f.actor, f.invoice.id, {
      ...approval(copy),
      duplicateCopyAcknowledged: true,
    });
  }
  expect(last).toMatchObject({
    attemptCount: 5,
    nextIntents: [],
    attentionReason: "attempt_limit_reached",
  });
  expect(effects).toHaveLength(4);
  expect(last.attempts.map((a) => a.actionKey)).toEqual([
    invoiceDeliveryKey(f.invoice.id),
    ...[2, 3, 4, 5].map(
      (n) => `${invoiceDeliveryKey(f.invoice.id)}:attempt:${n}`,
    ),
  ]);
  await expect(
    recover(f, "additional_copy", last.executionId!),
  ).rejects.toMatchObject({ code: "invoice_delivery_reserved" });
});

it.each(["timeout", "lost-final-write"] as const)(
  "keeps permanent unknown ownership after %s, never retries the original or a new preview",
  async (mode) => {
    const f = await fixture(),
      p = await preview(f);
    if (mode === "timeout") unknownAfterPost = true;
    else
      afterPost = async () => {
        vi.spyOn(db, "transaction").mockRejectedValueOnce(
          new Error("Synthetic missing final commit"),
        );
      };
    const r = await send(f, p);
    expect(r).toMatchObject({
      state: "uncertain",
      nextIntents: [],
      attemptCount: 1,
    });
    expect(effects).toHaveLength(1);
    await send(f, p);
    await expect(preview(f)).rejects.toMatchObject({
      code: "invoice_delivery_reserved",
    });
    expect(effects).toHaveLength(1);
    expect(
      await db
        .select()
        .from(auditEventsTable)
        .where(
          and(
            eq(auditEventsTable.organizationId, f.org),
            eq(auditEventsTable.action, "invoice_delivery.not_dispatched"),
          ),
        ),
    ).toHaveLength(0);
  },
);

it("retains unknown ownership after a real sender-entry lookup refusal, even after configuration is restored", async () => {
  const f = await fixture(),
    p = await preview(f);
  let senderEntries = 0;
  customerEmailHooks.beforeSend = async () => {
    customerEmailHooks.beforeSend = null;
    senderEntries++;
    // The actual initial invoice checks have passed. Let the real helper read
    // the now-missing company default and throw its untyped preparation error.
    await updateOrgSettings(f.org, { customerEmailSenderUserId: null });
  };
  const result = await send(f, p);
  expect(senderEntries).toBe(1);
  expect(result).toMatchObject({
    integrity: "valid",
    state: "uncertain",
    attemptCount: 1,
    nextIntents: [],
    attempts: [{ state: "indeterminate", proof: "none", proofId: null }],
  });
  expect(effects).toHaveLength(0);
  expect(gmailSend).not.toHaveBeenCalled();
  expect(microsoftSend).not.toHaveBeenCalled();
  const receipts = () =>
    db
      .select()
      .from(revenueExecutionsTable)
      .where(eq(revenueExecutionsTable.organizationId, f.org));
  const originalReceipts = await receipts();
  expect(originalReceipts).toHaveLength(1);
  expect(originalReceipts[0]).toMatchObject({
    id: result.executionId,
    kind: "invoice_email",
    state: "indeterminate",
    actionKey: invoiceDeliveryKey(f.invoice.id),
  });
  expect(result.attempts[0].actionKey).toBe(invoiceDeliveryKey(f.invoice.id));

  await updateOrgSettings(f.org, { customerEmailSenderUserId: f.sender });
  expect(await readCompanyEmailSender(db, f.org)).toMatchObject({
    sender: p.sender,
    identitySha256: p.senderIdentitySha256,
  });
  expect(await send(f, p)).toMatchObject({
    executionId: result.executionId,
    state: "uncertain",
    attemptCount: 1,
    nextIntents: [],
    attempts: [{ state: "indeterminate", proof: "none", proofId: null }],
  });
  await expect(preview(f)).rejects.toMatchObject({
    code: "invoice_delivery_reserved",
  });
  expect(await receipts()).toEqual(originalReceipts);
  expect(senderEntries).toBe(1);
  expect(effects).toHaveLength(0);
  expect(gmailSend).not.toHaveBeenCalled();
  expect(microsoftSend).not.toHaveBeenCalled();
  expect(
    await db
      .select()
      .from(auditEventsTable)
      .where(
        and(
          eq(auditEventsTable.organizationId, f.org),
          eq(auditEventsTable.action, "invoice_delivery.not_dispatched"),
        ),
      ),
  ).toHaveLength(0);
});

it("late acceptance pins original participants after edits and preserves the held original execution", async () => {
  const f = await fixture(),
    p = await preview(f);
  afterPost = async () => {
    await updateContact(f.org, f.contact.id, {
      email: "later@example.invalid",
    });
    await db
      .update(revenueExecutionsTable)
      .set({ state: "confirmed_not_performed" })
      .where(
        and(
          eq(revenueExecutionsTable.organizationId, f.org),
          eq(
            revenueExecutionsTable.actionKey,
            invoiceDeliveryKey(f.invoice.id),
          ),
        ),
      );
    await db
      .update(usersTable)
      .set({ isActive: false })
      .where(eq(usersTable.id, f.sender));
  };
  const r = await send(f, p);
  expect(r).toMatchObject({
    state: "reconciled",
    nextIntents: [],
    attempts: [
      { state: "confirmed_not_performed", proof: "provider_accepted" },
    ],
  });
  const [proof] = await db
    .select()
    .from(auditEventsTable)
    .where(
      and(
        eq(auditEventsTable.organizationId, f.org),
        eq(auditEventsTable.action, "invoice_delivery.provider_accepted"),
      ),
    );
  expect(proof.metadata).toMatchObject({
    recipient: f.contact.email,
    customerWorkId: f.invoice.customerWorkId,
    senderIdentitySha256: p.senderIdentitySha256,
  });
  expect(effects).toHaveLength(1);
});

it.each([
  "customerWorkId",
  "propertyId",
  "sourceSha256",
  "senderIdentitySha256",
  "recipient",
] as const)(
  "withholds copy authority if retained v3 acceptance %s is mismatched",
  async (field) => {
    const f = await fixture(),
      p = await preview(f);
    await send(f, p);
    const [proof] = await db
      .select()
      .from(auditEventsTable)
      .where(
        and(
          eq(auditEventsTable.organizationId, f.org),
          eq(auditEventsTable.action, "invoice_delivery.provider_accepted"),
        ),
      );
    await db
      .update(auditEventsTable)
      .set({
        metadata: {
          ...proof.metadata,
          [field]: field.endsWith("Sha256")
            ? "f".repeat(64)
            : field === "recipient"
              ? "other@example.invalid"
              : randomUUID(),
        },
      })
      .where(eq(auditEventsTable.id, proof.id));
    expect(
      await getInvoiceDelivery(f.org, f.actor, f.invoice.id),
    ).toMatchObject({
      integrity: "unavailable",
      state: "uncertain",
      nextIntents: [],
    });
    expect(effects).toHaveLength(1);
  },
);

it("keeps literal v2 metadata parsing and hashing unchanged, rejecting cross-version fields", () => {
  const literal = {
    reviewVersion: 2 as const,
    payloadSha256: "a".repeat(64),
    expiresAt: "2026-10-06T09:00:00.000Z",
    invoiceVersion: 2,
    documentSha256: "b".repeat(64),
    intent: "initial" as const,
    expectedLatestExecutionId: null,
    reason: null,
    duplicateCopyAcknowledged: false as const,
    context: {
      leadId: "11111111-1111-4111-8111-111111111111",
      contactId: "22222222-2222-4222-8222-222222222222",
      invoiceNumber: "INV-000001",
      recipient: "customer@example.invalid",
      sender: {
        userId: "accepted-owner",
        source: "lead_assignee" as const,
        provider: "gmail" as const,
        senderEmail: "office@example.invalid",
      },
    },
  };
  expect(invoiceAttemptReviewMetadataSchema.parse(literal)).toEqual(literal);
  expect(
    JSON.stringify(invoiceAttemptReviewMetadataSchema.parse(literal)),
  ).toBe(JSON.stringify(invoiceAttemptReviewV2MetadataSchema.parse(literal)));
  expect(
    deliveryFingerprint(invoiceAttemptReviewMetadataSchema.parse(literal)),
  ).toBe(deliveryFingerprint(literal));
  expect(
    invoiceAttemptReviewMetadataSchema.safeParse({
      ...literal,
      context: { ...literal.context, customerWorkId: randomUUID() },
    }).success,
  ).toBe(false);
  expect(
    invoiceAttemptReviewV3MetadataSchema.safeParse({
      ...literal,
      reviewVersion: 3,
    }).success,
  ).toBe(false);
});
