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
  invoicesTable,
  leadsTable,
  organizationsTable,
  revenueExecutionsTable,
  usersTable,
  valueEntriesTable,
} from "@workspace/db";
import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";
import {
  createInvoice,
  issueInvoice,
  recordInvoicePayment,
  voidInvoice,
} from "./invoices";
import {
  getInvoiceDelivery,
  previewInvoiceDelivery,
  sendInvoiceDelivery,
} from "./invoice-delivery";
import {
  deliveryFingerprint,
  invoiceDeliveryKey,
  renderInvoiceEmail,
  type InvoiceDeliveryIntent,
} from "./invoice-delivery-contract";
import {
  resolveCustomerEmailSender,
  sendCustomerEmail,
} from "./customer-email";
import { addSuppression } from "./send-gate";
import { EmailDispatchBlockedError } from "./email-dispatch-guard";
import {
  invoiceDocument,
  invoiceDocumentInputSchema,
} from "./invoice-contract";

vi.mock("./customer-email", () => ({
  resolveCustomerEmailSender: vi.fn(),
  sendCustomerEmail: vi.fn(),
}));
type Sender = Awaited<ReturnType<typeof resolveCustomerEmailSender>>;
const senders = new Map<string, Sender>();
const orgs: string[] = [];
const effects: string[] = [];
let lateChange: (() => Promise<void>) | null = null;
let lostReceipt = false;
const draft = {
  title: "Synthetic repair <not HTML>",
  currency: "USD" as const,
  issuerName: "Synthetic Contractor",
  issuerAddress: "1 Example Way",
  customerName: "Synthetic Customer",
  customerAddress: "2 Example Way",
  dueDate: "2026-10-30",
  notes: "Agreed invoice notes only.",
  lineItems: [
    { description: "Agreed repair", quantity: "1.25", unitPriceCents: 8000 },
  ],
  taxCents: 123,
};
async function fixture(issue = true) {
  const [org] = await db
    .insert(organizationsTable)
    .values({
      name: "Synthetic invoice delivery",
      slug: `invoice-mail-${randomUUID()}`,
    })
    .returning();
  orgs.push(org!.id);
  const [actor] = await db
    .insert(usersTable)
    .values({
      organizationId: org!.id,
      role: "owner",
      isActive: true,
      emailVerifiedAt: new Date(),
    })
    .returning();
  const [contact] = await db
    .insert(contactsTable)
    .values({
      organizationId: org!.id,
      firstName: "Synthetic",
      email: "customer@example.invalid",
    })
    .returning();
  const [lead] = await db
    .insert(leadsTable)
    .values({
      organizationId: org!.id,
      contactId: contact!.id,
      assignedUserId: actor!.id,
    })
    .returning();
  senders.set(org!.id, {
    userId: actor!.id,
    source: "lead_assignee",
    provider: "gmail",
    senderEmail: "office@example.invalid",
  });
  let invoice = (
    await createInvoice(org!.id, actor!.id, {
      requestId: randomUUID(),
      leadId: lead!.id,
      document: draft,
    })
  ).invoice;
  if (issue)
    invoice = (
      await issueInvoice(org!.id, actor!.id, invoice.id, {
        requestId: randomUUID(),
        expectedVersion: invoice.version,
        confirmed: true,
      })
    ).invoice;
  return {
    org: org!.id,
    actor: actor!.id,
    contact: contact!.id,
    lead: lead!.id,
    invoice,
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const preview = (f: Fixture) =>
  previewInvoiceDelivery(f.org, f.actor, f.invoice.id, {
    expectedVersion: f.invoice.version,
  });
const approve = (p: { previewId: string; payloadSha256: string }) => ({
  previewId: p.previewId,
  payloadSha256: p.payloadSha256,
  confirmed: true,
});
const send = (f: Fixture, p: { previewId: string; payloadSha256: string }) =>
  sendInvoiceDelivery(f.org, f.actor, f.invoice.id, approve(p));
const recover = (
  f: Fixture,
  intent: Exclude<InvoiceDeliveryIntent, "initial">,
  head: string,
) =>
  previewInvoiceDelivery(f.org, f.actor, f.invoice.id, {
    expectedVersion: f.invoice.version,
    intent,
    expectedLatestExecutionId: head,
    reason: "Synthetic staff reviewed the exact customer request.",
  });
const sendCopy = (
  f: Fixture,
  p: { previewId: string; payloadSha256: string },
) =>
  sendInvoiceDelivery(f.org, f.actor, f.invoice.id, {
    ...approve(p),
    duplicateCopyAcknowledged: true,
  });
beforeEach(() => {
  vi.stubEnv("GROWTHOS_OUTBOUND_HOLD", "false");
  vi.mocked(resolveCustomerEmailSender).mockImplementation(
    async ({ organizationId }) => {
      const sender = senders.get(organizationId);
      if (!sender) throw new Error("Selected sender unavailable");
      return { ...sender };
    },
  );
  vi.mocked(sendCustomerEmail).mockImplementation(async (input) => {
    await lateChange?.();
    await input.beforeDispatch?.();
    expect(input.expectedSender).toEqual(senders.get(input.organizationId));
    effects.push(input.organizationId);
    if (lostReceipt)
      throw new Error("Synthetic timeout after possible provider acceptance");
    const sender = senders.get(input.organizationId)!;
    return {
      id: sender.provider === "gmail" ? "synthetic-gmail-message" : null,
      provider: sender.provider,
      senderUserId: sender.userId,
      senderEmail: sender.senderEmail,
      acceptance: "accepted",
      ...(sender.provider === "microsoft"
        ? {
            providerRequestId: "synthetic-request-correlation",
            clientRequestId: "synthetic-client-correlation",
          }
        : {}),
    };
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  effects.length = 0;
  lateChange = null;
  lostReceipt = false;
});
afterAll(async () => {
  await deleteTestOrgs(...orgs);
});

describe("native invoice exact review and customer-safe content", () => {
  it("renders every canonical issued field without payment links, HTML interpretation or live-balance claims", () => {
    const document = invoiceDocument(invoiceDocumentInputSchema.parse(draft));
    const result = renderInvoiceEmail({
      document,
      invoiceNumber: "INV-000001",
      issuedAt: "2026-10-02T12:00:00Z",
    });
    for (const text of [
      draft.title,
      draft.issuerName,
      draft.issuerAddress,
      draft.customerName,
      draft.customerAddress,
      draft.dueDate,
      draft.notes,
      "Issued: 2026-10-02",
      "Quantity: 1.25",
      "Unit price: USD 80.00",
      "Line total: USD 100.00",
      "Subtotal: USD 100.00",
      "Tax: USD 1.23",
      "Invoice total: USD 101.23",
    ])
      expect(result.body).toContain(text);
    expect(result.subject).toBe("Invoice INV-000001 from Synthetic Contractor");
    expect(result.body).not.toMatch(/https?:|pay now|paid in full/i);
    expect(deliveryFingerprint({ b: 2, a: 1 })).toBe(
      deliveryFingerprint({ a: 1, b: 2 }),
    );
  });
  it("previews without sending or changing document/cash; retains hashes rather than message bodies in review audit", async () => {
    const f = await fixture();
    const p = await preview(f);
    expect(p).toMatchObject({
      invoiceId: f.invoice.id,
      invoiceVersion: 2,
      recipient: "customer@example.invalid",
      sender: senders.get(f.org),
    });
    expect(effects).toHaveLength(0);
    const [row] = await db
      .select()
      .from(auditEventsTable)
      .where(eq(auditEventsTable.id, p.previewId));
    expect(row!.metadata).toMatchObject({ payloadSha256: p.payloadSha256 });
    expect(row!.metadata).toMatchObject({
      reviewVersion: 2,
      duplicateCopyAcknowledged: false,
      context: { recipient: p.recipient, sender: p.sender },
    });
    expect(JSON.stringify(row!.metadata)).not.toMatch(
      /Agreed repair|Invoice items:|refreshToken/,
    );
    expect(
      await db
        .select()
        .from(valueEntriesTable)
        .where(eq(valueEntriesTable.organizationId, f.org)),
    ).toHaveLength(0);
    expect(
      await getInvoiceDelivery(f.org, f.actor, f.invoice.id),
    ).toMatchObject({
      state: "not_sent",
      canPrepare: true,
      deliveryConfirmed: false,
    });
  });
  it.each(["gmail", "microsoft"] as const)(
    "records truthful %s acceptance once, with no collection or delivery claim",
    async (provider) => {
      const f = await fixture();
      senders.get(f.org)!.provider = provider;
      const p = await preview(f);
      const first = await send(f, p);
      const second = await send(f, p);
      expect(first).toMatchObject({
        state: "accepted",
        provider,
        deliveryConfirmed: false,
        canPrepare: false,
      });
      expect(second.executionId).toBe(first.executionId);
      expect(effects).toEqual([f.org]);
      expect(first.providerMessageId).toBe(
        provider === "gmail" ? "synthetic-gmail-message" : null,
      );
      expect(first.providerRequestId).toBe(
        provider === "microsoft" ? "synthetic-request-correlation" : null,
      );
      const events = await db
        .select()
        .from(activitiesTable)
        .where(
          and(
            eq(activitiesTable.organizationId, f.org),
            eq(activitiesTable.type, "email_sent"),
          ),
        );
      expect(events).toHaveLength(1);
      expect(events[0]!.metadata).toMatchObject({
        invoiceId: f.invoice.id,
        acceptance: "accepted",
        deliveryConfirmed: false,
      });
      await expect(preview(f)).rejects.toMatchObject({
        code: "invoice_delivery_reserved",
      });
      expect(
        await db
          .select()
          .from(valueEntriesTable)
          .where(eq(valueEntriesTable.organizationId, f.org)),
      ).toHaveLength(0);
    },
  );
  it("rejects draft, void and stale invoice versions", async () => {
    const f = await fixture(false);
    await expect(preview(f)).rejects.toMatchObject({
      code: "invoice_delivery_not_issued",
    });
    const issued = await fixture();
    await expect(
      previewInvoiceDelivery(issued.org, issued.actor, issued.invoice.id, {
        expectedVersion: 1,
      }),
    ).rejects.toMatchObject({ code: "invoice_delivery_review_changed" });
    const p = await preview(issued);
    await voidInvoice(issued.org, issued.actor, issued.invoice.id, {
      requestId: randomUUID(),
      expectedVersion: 2,
      confirmed: true,
      reason: "Replaced scope per synthetic review.",
    });
    await expect(send(issued, p)).rejects.toMatchObject({
      code: "invoice_delivery_not_issued",
    });
    expect(effects).toHaveLength(0);
  });
  it("rejects a changed issued document even when the client repeats its approved hash", async () => {
    const f = await fixture();
    const p = await preview(f);
    await db
      .update(invoicesTable)
      .set({
        issuedDocument: {
          ...f.invoice.document,
          notes: "Forged changed document",
        },
      })
      .where(eq(invoicesTable.id, f.invoice.id));
    await expect(send(f, p)).rejects.toMatchObject({
      code: "invoice_unavailable",
    });
    expect(effects).toHaveLength(0);
  });
  it.each(["recipient", "sender", "source", "receipt"])(
    "rejects stale review after %s changes",
    async (kind) => {
      const f = await fixture();
      const p = await preview(f);
      if (kind === "recipient")
        await db
          .update(contactsTable)
          .set({ email: "changed@example.invalid" })
          .where(eq(contactsTable.id, f.contact));
      if (kind === "sender")
        senders.get(f.org)!.senderEmail = "different@example.invalid";
      if (kind === "source")
        await db
          .update(leadsTable)
          .set({
            source: "changed-source",
            updatedAt: new Date(Date.now() + 1000),
          })
          .where(eq(leadsTable.id, f.lead));
      if (kind === "receipt")
        await recordInvoicePayment(f.org, f.actor, f.invoice.id, {
          requestId: randomUUID(),
          expectedVersion: 2,
          confirmed: true,
          amountCents: 1,
          sourceReference: "Synthetic external receipt",
          occurredAt: new Date(Date.now() - 1000).toISOString(),
        });
      await expect(send(f, p)).rejects.toMatchObject({
        code: "invoice_delivery_review_changed",
      });
      expect(effects).toHaveLength(0);
    },
  );
  it("rejects expired/tampered reviews and arbitrary recipient or request-key overrides", async () => {
    const f = await fixture();
    const p = await preview(f);
    await expect(
      sendInvoiceDelivery(f.org, f.actor, f.invoice.id, {
        ...approve(p),
        to: "other@example.invalid",
      }),
    ).rejects.toBeDefined();
    await expect(
      sendInvoiceDelivery(f.org, f.actor, f.invoice.id, {
        ...approve(p),
        requestId: randomUUID(),
      }),
    ).rejects.toBeDefined();
    await expect(
      send(f, { ...p, payloadSha256: "a".repeat(64) }),
    ).rejects.toMatchObject({ code: "invoice_delivery_review_changed" });
    await db
      .update(auditEventsTable)
      .set({
        metadata: {
          payloadSha256: p.payloadSha256,
          expiresAt: new Date(Date.now() - 1).toISOString(),
        },
      })
      .where(eq(auditEventsTable.id, p.previewId));
    await expect(send(f, p)).rejects.toMatchObject({
      code: "invoice_delivery_review_changed",
    });
    expect(effects).toHaveLength(0);
  });
});

describe("invoice delivery holds, roles and unknown-effect ownership", () => {
  it.each(["unverified", "invited"])(
    "rejects an %s manager before preparing or reserving a send",
    async (kind) => {
      const f = await fixture();
      let actor = f.actor;
      if (kind === "unverified")
        await db
          .update(usersTable)
          .set({ emailVerifiedAt: null })
          .where(eq(usersTable.id, actor));
      else {
        const [invite] = await db
          .insert(usersTable)
          .values({
            id: `invite:${randomUUID()}`,
            organizationId: f.org,
            role: "owner",
            isActive: true,
            emailVerifiedAt: new Date(),
          })
          .returning();
        actor = invite!.id;
      }
      await expect(
        previewInvoiceDelivery(f.org, actor, f.invoice.id, {
          expectedVersion: 2,
        }),
      ).rejects.toMatchObject({ status: 403 });
      expect(effects).toHaveLength(0);
      expect(
        await db
          .select()
          .from(revenueExecutionsTable)
          .where(eq(revenueExecutionsTable.organizationId, f.org)),
      ).toHaveLength(0);
    },
  );
  it("recognizes the server-only no-effect dispatch error without releasing the send reservation", async () => {
    const f = await fixture();
    const p = await preview(f);
    lateChange = async () => {
      throw new EmailDispatchBlockedError();
    };
    expect(await send(f, p)).toMatchObject({
      state: "held",
      canPrepare: false,
    });
    expect(effects).toHaveLength(0);
    await expect(preview(f)).rejects.toMatchObject({
      code: "invoice_delivery_reserved",
    });
  });
  it("does not trust an arbitrary provider error's effectNotAttempted property as safe evidence", async () => {
    const f = await fixture();
    const p = await preview(f);
    vi.mocked(sendCustomerEmail).mockRejectedValueOnce(
      Object.assign(new Error("Untrusted provider error"), {
        effectNotAttempted: true,
      }),
    );
    expect(await send(f, p)).toMatchObject({
      state: "uncertain",
      canPrepare: false,
    });
    await expect(preview(f)).rejects.toMatchObject({
      code: "invoice_delivery_reserved",
    });
  });
  it("requires same-tenant active invoice managers and actor-owned reviews", async () => {
    const f = await fixture(),
      other = await fixture();
    const p = await preview(f);
    await expect(
      getInvoiceDelivery(other.org, other.actor, f.invoice.id),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      sendInvoiceDelivery(other.org, other.actor, other.invoice.id, approve(p)),
    ).rejects.toMatchObject({ code: "invoice_delivery_review_changed" });
    const [office, sales] = await db
      .insert(usersTable)
      .values([
        { organizationId: f.org, role: "office", isActive: true },
        { organizationId: f.org, role: "sales_manager", isActive: true },
      ])
      .returning();
    await expect(
      sendInvoiceDelivery(f.org, office!.id, f.invoice.id, approve(p)),
    ).rejects.toMatchObject({ code: "invoice_delivery_review_changed" });
    expect(
      (await getInvoiceDelivery(f.org, sales!.id, f.invoice.id)).state,
    ).toBe("not_sent");
    await expect(
      previewInvoiceDelivery(f.org, sales!.id, f.invoice.id, {
        expectedVersion: 2,
      }),
    ).rejects.toMatchObject({ status: 403 });
    await db
      .update(usersTable)
      .set({ isActive: false })
      .where(eq(usersTable.id, f.actor));
    await expect(send(f, p)).rejects.toMatchObject({ status: 403 });
    expect(effects).toHaveLength(0);
  });
  it.each([
    "suppression",
    "do_not_email",
    "lifecycle",
    "global_hold",
    "sender_missing",
  ])("blocks %s before a send slot is reserved", async (kind) => {
    const f = await fixture();
    const p = await preview(f);
    if (kind === "suppression")
      await addSuppression({
        organizationId: f.org,
        channel: "email",
        value: "customer@example.invalid",
        reason: "hard_bounce",
      });
    if (kind === "do_not_email")
      await db
        .update(contactsTable)
        .set({ doNotContactEmail: true })
        .where(eq(contactsTable.id, f.contact));
    if (kind === "lifecycle")
      await db.insert(customerLifecycleTable).values({
        organizationId: f.org,
        state: "paused",
        reason: "Synthetic pause",
      });
    if (kind === "global_hold") vi.stubEnv("GROWTHOS_OUTBOUND_HOLD", "true");
    if (kind === "sender_missing") senders.delete(f.org);
    await expect(send(f, p)).rejects.toBeDefined();
    expect(effects).toHaveLength(0);
    expect(
      await db
        .select()
        .from(revenueExecutionsTable)
        .where(eq(revenueExecutionsTable.organizationId, f.org)),
    ).toHaveLength(0);
  });
  it.each(["recipient", "sender", "permission", "hold", "void"])(
    "rechecks late %s changes at actual provider dispatch",
    async (kind) => {
      const f = await fixture();
      const p = await preview(f);
      lateChange = async () => {
        if (kind === "recipient")
          await db
            .update(contactsTable)
            .set({ email: "late@example.invalid" })
            .where(eq(contactsTable.id, f.contact));
        if (kind === "sender") senders.get(f.org)!.provider = "microsoft";
        if (kind === "permission")
          await db
            .update(usersTable)
            .set({ role: "sales_manager" })
            .where(eq(usersTable.id, f.actor));
        if (kind === "hold") vi.stubEnv("GROWTHOS_OUTBOUND_HOLD", "true");
        if (kind === "void")
          await voidInvoice(f.org, f.actor, f.invoice.id, {
            requestId: randomUUID(),
            expectedVersion: 2,
            confirmed: true,
            reason: "Late synthetic invoice cancellation.",
          });
      };
      expect(await send(f, p)).toMatchObject({
        state: "held",
        canPrepare: false,
      });
      expect(effects).toHaveLength(0);
    },
  );
  it("never lets a second preview, changed sender or reconciled/new key bypass an uncertain logical send", async () => {
    const f = await fixture();
    const a = await preview(f),
      b = await preview(f);
    lostReceipt = true;
    const result = await send(f, a);
    expect(result).toMatchObject({
      state: "uncertain",
      canPrepare: false,
      deliveryConfirmed: false,
    });
    expect(await send(f, b)).toMatchObject({
      state: "uncertain",
      executionId: result.executionId,
    });
    senders.get(f.org)!.senderEmail = "replacement@example.invalid";
    await expect(preview(f)).rejects.toMatchObject({
      code: "invoice_delivery_reserved",
    });
    expect(effects).toEqual([f.org]);
    await db
      .update(revenueExecutionsTable)
      .set({ state: "confirmed_not_performed" })
      .where(eq(revenueExecutionsTable.id, result.executionId!));
    expect(await send(f, b)).toMatchObject({
      state: "reconciled",
      canPrepare: false,
    });
    expect(effects).toHaveLength(1);
    expect(
      (
        await db
          .select()
          .from(revenueExecutionsTable)
          .where(eq(revenueExecutionsTable.organizationId, f.org))
      )[0]!.actionKey,
    ).toBe(invoiceDeliveryKey(f.invoice.id));
  });
  it("treats expired processing ownership as uncertain without reclaiming it", async () => {
    const f = await fixture();
    const p = await preview(f);
    await db.insert(revenueExecutionsTable).values({
      organizationId: f.org,
      actionKey: invoiceDeliveryKey(f.invoice.id),
      kind: "invoice_email",
      fingerprint: "unavailable-original-payload",
      expiresAt: new Date(Date.now() - 1),
    });
    expect(await send(f, p)).toMatchObject({
      state: "uncertain",
      canPrepare: false,
    });
    expect(effects).toHaveLength(0);
  });
});

describe("separately reviewed invoice recovery, without resetting history", () => {
  it("requires a fresh explicit review after typed pre-dispatch refusal and retains the original blocked receipt", async () => {
    const f = await fixture();
    const initial = await preview(f);
    lateChange = async () => {
      throw new EmailDispatchBlockedError();
    };
    const blocked = await send(f, initial);
    expect(blocked).toMatchObject({
      state: "held",
      attemptCount: 1,
      nextIntents: ["retry_not_dispatched"],
      integrity: "valid",
    });
    expect(blocked.attempts[0]).toMatchObject({
      ordinal: 1,
      proof: "not_dispatched",
      state: "blocked",
    });
    lateChange = null;
    await expect(
      recover(f, "additional_copy", blocked.executionId!),
    ).rejects.toMatchObject({ code: "invoice_delivery_reserved" });
    const retry = await recover(
      f,
      "retry_not_dispatched",
      blocked.executionId!,
    );
    expect(retry).toMatchObject({
      prospectiveAttemptNumber: 2,
      maxAttempts: 5,
      expectedLatestExecutionId: blocked.executionId,
    });
    expect(retry.subject).not.toContain("COPY");
    expect((await send(f, initial)).attemptCount).toBe(1);
    const accepted = await send(f, retry);
    expect(accepted).toMatchObject({
      state: "accepted",
      attemptCount: 2,
      nextIntents: ["additional_copy"],
    });
    expect(accepted.attempts[0]).toEqual(blocked.attempts[0]);
    expect(accepted.attempts[1]).toMatchObject({
      ordinal: 2,
      intent: "retry_not_dispatched",
      proof: "provider_accepted",
    });
    expect(effects).toEqual([f.org]);
    expect((await send(f, retry)).executionId).toBe(accepted.executionId);
    expect(effects).toHaveLength(1);
  });
  it("allows an additional COPY only after a fresh preview and a separate post-preview acknowledgement", async () => {
    const f = await fixture();
    const first = await send(f, await preview(f));
    expect(first.nextIntents).toEqual(["additional_copy"]);
    await expect(
      recover(f, "retry_not_dispatched", first.executionId!),
    ).rejects.toMatchObject({ code: "invoice_delivery_reserved" });
    const copy = await recover(f, "additional_copy", first.executionId!);
    expect(copy).toMatchObject({
      intent: "additional_copy",
      prospectiveAttemptNumber: 2,
      maxAttempts: 5,
    });
    expect(copy.subject).toContain("COPY of invoice");
    expect(copy.body).toContain("not a new bill or charge");
    await expect(send(f, copy)).rejects.toMatchObject({
      code: "invoice_delivery_copy_acknowledgement_required",
    });
    expect(effects).toHaveLength(1);
    const result = await sendCopy(f, copy);
    expect(result).toMatchObject({
      state: "accepted",
      attemptCount: 2,
      deliveryConfirmed: false,
    });
    expect(result.attempts[0]).toEqual(first.attempts[0]);
    expect(result.attempts[1]).toMatchObject({
      intent: "additional_copy",
      ordinal: 2,
    });
    expect(effects).toEqual([f.org, f.org]);
    expect((await sendCopy(f, copy)).executionId).toBe(result.executionId);
    expect(effects).toHaveLength(2);
    expect(
      await db
        .select()
        .from(valueEntriesTable)
        .where(eq(valueEntriesTable.organizationId, f.org)),
    ).toHaveLength(0);
  });
  it("does not turn an old untyped held receipt or reconciliation note into retry authority", async () => {
    const f = await fixture();
    const [legacy] = await db
      .insert(revenueExecutionsTable)
      .values({
        organizationId: f.org,
        actionKey: invoiceDeliveryKey(f.invoice.id),
        kind: "invoice_email",
        actorUserId: f.actor,
        fingerprint: "a".repeat(64),
        state: "blocked",
        detail: "No email was sent (legacy text is not typed proof)",
        expiresAt: new Date(),
      })
      .returning();
    expect(
      await getInvoiceDelivery(f.org, f.actor, f.invoice.id),
    ).toMatchObject({
      state: "held",
      nextIntents: [],
      attentionReason: "legacy_review_identity_unavailable",
    });
    await expect(
      recover(f, "retry_not_dispatched", legacy!.id),
    ).rejects.toMatchObject({ code: "invoice_delivery_reserved" });
    await db
      .update(revenueExecutionsTable)
      .set({ state: "confirmed_not_performed" })
      .where(eq(revenueExecutionsTable.id, legacy!.id));
    expect(
      await getInvoiceDelivery(f.org, f.actor, f.invoice.id),
    ).toMatchObject({ state: "reconciled", nextIntents: [] });
    await expect(
      recover(f, "retry_not_dispatched", legacy!.id),
    ).rejects.toMatchObject({ code: "invoice_delivery_reserved" });
    expect(effects).toHaveLength(0);
  });
  it("blocks every additional attempt once the latest copy becomes uncertain", async () => {
    const f = await fixture();
    const first = await send(f, await preview(f));
    const copyA = await recover(f, "additional_copy", first.executionId!);
    const copyB = await recover(f, "additional_copy", first.executionId!);
    lostReceipt = true;
    const uncertain = await sendCopy(f, copyA);
    expect(uncertain).toMatchObject({
      state: "uncertain",
      attemptCount: 2,
      nextIntents: [],
    });
    expect((await sendCopy(f, copyB)).executionId).toBe(uncertain.executionId);
    for (const intent of ["retry_not_dispatched", "additional_copy"] as const)
      await expect(
        recover(f, intent, uncertain.executionId!),
      ).rejects.toMatchObject({ code: "invoice_delivery_reserved" });
    expect(effects).toHaveLength(2);
  });
  it("caps all server attempts at five, including explicitly acknowledged copies", async () => {
    const f = await fixture();
    let latest = await send(f, await preview(f));
    for (let ordinal = 2; ordinal <= 5; ordinal++) {
      const copy = await recover(f, "additional_copy", latest.executionId!);
      expect(copy.prospectiveAttemptNumber).toBe(ordinal);
      latest = await sendCopy(f, copy);
    }
    expect(latest).toMatchObject({
      state: "accepted",
      attemptCount: 5,
      maxAttempts: 5,
      nextIntents: [],
      attentionReason: "attempt_limit_reached",
    });
    await expect(
      recover(f, "additional_copy", latest.executionId!),
    ).rejects.toMatchObject({ code: "invoice_delivery_reserved" });
    expect(effects).toHaveLength(5);
  });
  it("requires a fresh v2 review rather than adopting an old unconsumed preview", async () => {
    const f = await fixture();
    const p = await preview(f);
    await db
      .update(auditEventsTable)
      .set({
        metadata: {
          payloadSha256: p.payloadSha256,
          expiresAt: p.expiresAt,
          invoiceVersion: p.invoiceVersion,
          documentSha256: p.documentSha256,
        },
      })
      .where(eq(auditEventsTable.id, p.previewId));
    await expect(send(f, p)).rejects.toMatchObject({
      code: "invoice_delivery_review_changed",
    });
    expect(effects).toHaveLength(0);
  });
});

describe.skipIf(process.env.SCHEDULER_TEST_BACKEND === "pglite")(
  "independent PostgreSQL invoice email races",
  () => {
    it("reserves one logical effect across different reviewed requests", async () => {
      const f = await fixture();
      const a = await preview(f),
        b = await preview(f);
      await Promise.all([send(f, a), send(f, b)]);
      expect(effects).toEqual([f.org]);
      expect(
        (await getInvoiceDelivery(f.org, f.actor, f.invoice.id)).state,
      ).toBe("accepted");
    });
  },
);
