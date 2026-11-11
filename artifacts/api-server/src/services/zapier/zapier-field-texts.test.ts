import { randomUUID } from "node:crypto";
import {
  appointmentsTable,
  consentRecordsTable,
  contactsTable,
  db,
  invoicePaymentLinksTable,
  leadsTable,
  orgSettingsTable,
  organizationsTable,
  usersTable,
  zapierActionExecutionsTable,
  zapierCapabilityBindingsTable,
  zapierMcpConnectionsTable,
  zapierSpecialistPoliciesTable,
} from "@workspace/db";
import { companyDayBounds } from "@workspace/scheduling-core";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { encryptSecret } from "../../lib/token-encryption";
import { deleteTestOrgs } from "../../test-helpers/delete-test-orgs";
import { createInvoice, issueInvoice } from "../invoices";
import { FieldCollectError } from "../field-collect";
import { getZapierCapability } from "./zapier-capabilities";
import { approveZapierAction } from "./zapier-executions";
import { sha256Hex } from "./zapier-mcp-client";
import {
  apptRequestOnMyWayText,
  billRequestPayLinkText,
  buildOnMyWayTextInput,
  buildPayLinkTextInput,
  companyDateOf,
  OPT_OUT_LINE,
  rebuildZapierRequestInput,
} from "./zapier-specialist-flows";

/** In-memory Zapier MCP transport: records each dispatched tool call. */
const fake = vi.hoisted(() => ({ calls: [] as unknown[] }));
vi.mock("./zapier-mcp-client", async (original) => ({
  ...(await original<typeof import("./zapier-mcp-client")>()),
  withZapierMcpSession: async (_url: string, fn: (session: unknown) => Promise<unknown>) =>
    fn({
      callTool: async (_tool: string, args: unknown) => {
        fake.calls.push(args);
        return { value: { id: "synthetic" }, digest: "c".repeat(64), isError: false };
      },
    }),
}));

beforeEach(() => {
  fake.calls.length = 0;
  vi.stubEnv("OAUTH_TOKEN_ENCRYPTION_KEY", Buffer.alloc(32, 42).toString("base64"));
  vi.stubEnv("GROWTHOS_OUTBOUND_HOLD", "false");
});

const orgs: string[] = [];
afterAll(async () => {
  await deleteTestOrgs(...orgs);
});

type Execution = Parameters<typeof rebuildZapierRequestInput>[0];
const ZONE = "America/New_York";

async function fixture(options: { smsConsent?: boolean } = {}) {
  const [org] = await db
    .insert(organizationsTable)
    .values({ name: "Synthetic Field Co", slug: `test-zap-field-${randomUUID()}`, timezone: ZONE })
    .returning();
  orgs.push(org!.id);
  await db.insert(orgSettingsTable).values({ organizationId: org!.id, sendingHours: { quietHoursEnabled: false } });
  const [owner] = await db.insert(usersTable).values({ organizationId: org!.id, role: "owner", firstName: "Avery", emailVerifiedAt: new Date() }).returning();
  const [tech] = await db.insert(usersTable).values({ organizationId: org!.id, role: "production", firstName: "Sam", emailVerifiedAt: new Date() }).returning();
  const [contact] = await db
    .insert(contactsTable)
    .values({ organizationId: org!.id, firstName: "Dana", phone: "+14045550142", email: "dana@example.test" })
    .returning();
  if (options.smsConsent !== false) {
    await db.insert(consentRecordsTable).values({ organizationId: org!.id, contactId: contact!.id, channel: "sms", granted: true, disclosureVersion: "test" });
  }
  const [lead] = await db.insert(leadsTable).values({ organizationId: org!.id, contactId: contact!.id, assignedUserId: owner!.id }).returning();
  const appointment = async (overrides: Partial<typeof appointmentsTable.$inferInsert> = {}) =>
    (
      await db
        .insert(appointmentsTable)
        .values({
          organizationId: org!.id,
          leadId: lead!.id,
          contactId: contact!.id,
          assignedUserId: tech!.id,
          status: "scheduled",
          // Always overlaps the current company day, whatever hour the test runs.
          scheduledStart: new Date(Date.now() - 30 * 60_000),
          scheduledEnd: new Date(Date.now() + 60 * 60_000),
          ...overrides,
        })
        .returning()
    )[0]!;
  const invoice = async () => {
    const draft = (
      await createInvoice(org!.id, owner!.id, {
        requestId: randomUUID(),
        leadId: lead!.id,
        document: {
          title: "Synthetic repair",
          currency: "USD",
          issuerName: "Synthetic Field Co",
          customerName: "Dana",
          lineItems: [{ description: "Agreed work", quantity: "1", unitPriceCents: 10000 }],
          taxCents: 0,
        },
      })
    ).invoice;
    return (await issueInvoice(org!.id, owner!.id, draft.id, { requestId: randomUUID(), expectedVersion: draft.version, confirmed: true })).invoice;
  };
  const payLink = async (invoice: { id: string; version: number }, overrides: Partial<typeof invoicePaymentLinksTable.$inferInsert> = {}) =>
    (
      await db
        .insert(invoicePaymentLinksTable)
        .values({
          organizationId: org!.id,
          invoiceId: invoice.id,
          invoiceVersion: invoice.version,
          amountCents: 10000,
          stripeAccountId: "acct_synthetic",
          checkoutSessionId: `cs_test_${randomUUID().replace(/-/g, "")}`,
          checkoutUrl: "https://checkout.stripe.test/c/synthetic",
          state: "open",
          detail: "Waiting for payment in the Stripe sandbox.",
          createdByUserId: owner!.id,
          expiresAt: new Date(Date.now() + 86_400_000),
          ...overrides,
        })
        .returning()
    )[0]!;
  return { orgId: org!.id, owner: owner!, tech: tech!, contact: contact!, lead: lead!, appointment, invoice, payLink };
}

async function connect(org: string, capability: "appt.sms.on_my_way" | "bill.sms.payment_link", mode: "auto" | "approve" | null = "approve") {
  const url = `https://mcp.zapier.com/api/mcp/s/synthetic-field-${randomUUID()}/mcp`;
  const specialistId = capability.startsWith("appt") ? "appt" : "bill";
  await db.insert(zapierMcpConnectionsTable).values({ organizationId: org, encryptedServerUrl: encryptSecret(url, `${org}:zapier-mcp`), serverUrlFingerprint: sha256Hex(url), serverHost: "mcp.zapier.com", serverMode: "managed" }).onConflictDoNothing();
  await db.insert(zapierCapabilityBindingsTable).values({ organizationId: org, capability, specialistId, direction: "write", zapierApp: "OpenPhoneCLIAPI", zapierAppName: "Quo", zapierAction: "send_message", zapierActionName: "Send Message", bindingConfig: { from: "+14045550100" } });
  if (mode) await db.insert(zapierSpecialistPoliciesTable).values({ organizationId: org, capability, specialistId, mode, dailyBudget: 20 });
}

describe("APPT On My Way text", () => {
  it("names the assigned tech, the company and the chosen ETA, and rebuilds the same text for approval", async () => {
    const f = await fixture();
    const visit = await f.appointment();
    const built = await buildOnMyWayTextInput(f.orgId, visit.id, { etaMinutes: 15, requestedByUserId: f.owner.id });
    const date = companyDateOf(new Date(), ZONE);
    expect(built.idempotencyKey).toBe(`appt-omw:${visit.id}:${date}`);
    expect(built.input).toEqual({
      toPhone: "+14045550142",
      body: `Hi Dana, Sam from Synthetic Field Co is on the way, about 15 minutes away. ${OPT_OUT_LINE}`,
      etaMinutes: 15,
    });
    const execution = { capability: "appt.sms.on_my_way", organizationId: f.orgId, idempotencyKey: built.idempotencyKey, linkedEntityId: visit.id, requestSummary: { toPhone: "+14045550142", etaMinutes: 15 }, requestedByUserId: f.owner.id } as unknown as Execution;
    expect(await rebuildZapierRequestInput(execution)).toEqual(built.input);

    const noEta = await buildOnMyWayTextInput(f.orgId, visit.id, { requestedByUserId: f.owner.id });
    expect(noEta.input.body).toBe(`Hi Dana, Sam from Synthetic Field Co is on the way. ${OPT_OUT_LINE}`);
  });

  it("refuses without consent, for another day, for another company and for a cancelled visit", async () => {
    const noConsent = await fixture({ smsConsent: false });
    const visit = await noConsent.appointment();
    await expect(buildOnMyWayTextInput(noConsent.orgId, visit.id, { requestedByUserId: null })).rejects.toMatchObject({ code: "invalid_input", message: expect.stringMatching(/not agreed to receive texts/) });

    const f = await fixture();
    const bounds = companyDayBounds(companyDateOf(new Date(), ZONE), ZONE);
    const tomorrow = await f.appointment({ scheduledStart: new Date(Date.parse(bounds.to) + 3 * 60 * 60_000), scheduledEnd: new Date(Date.parse(bounds.to) + 4 * 60 * 60_000) });
    await expect(buildOnMyWayTextInput(f.orgId, tomorrow.id, { requestedByUserId: null })).rejects.toMatchObject({ message: expect.stringMatching(/today's appointments/) });

    const today = await f.appointment();
    await expect(buildOnMyWayTextInput(f.orgId, today.id, { requestedByUserId: null, expectedDate: "2020-01-01" })).rejects.toMatchObject({ message: expect.stringMatching(/earlier day/) });
    await expect(buildOnMyWayTextInput(noConsent.orgId, today.id, { requestedByUserId: null })).rejects.toMatchObject({ code: "not_found" });
    await expect(buildOnMyWayTextInput(f.orgId, today.id, { requestedByUserId: null, etaMinutes: 0 })).rejects.toMatchObject({ code: "invalid_input" });

    const cancelled = await f.appointment({ status: "cancelled" });
    await expect(buildOnMyWayTextInput(f.orgId, cancelled.id, { requestedByUserId: null })).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("parks for approval once per appointment per day, then sends exactly the approved copy", async () => {
    const f = await fixture();
    await connect(f.orgId, "appt.sms.on_my_way");
    const visit = await f.appointment();
    const pending = await apptRequestOnMyWayText({ organizationId: f.orgId, appointmentId: visit.id, actorUserId: f.tech.id, etaMinutes: 20 });
    expect(pending.execution.state).toBe("pending_approval");
    expect(pending.execution.requestSummary).toMatchObject({ etaMinutes: 20 });
    // The identical request is idempotent; a different ETA the same day is refused.
    const replay = await apptRequestOnMyWayText({ organizationId: f.orgId, appointmentId: visit.id, actorUserId: f.tech.id, etaMinutes: 20 });
    expect(replay.execution.id).toBe(pending.execution.id);
    await expect(apptRequestOnMyWayText({ organizationId: f.orgId, appointmentId: visit.id, actorUserId: f.tech.id, etaMinutes: 45 })).rejects.toMatchObject({ code: "conflict" });
    expect(fake.calls).toHaveLength(0);

    const done = await approveZapierAction({ organizationId: f.orgId, executionId: pending.execution.id, userId: f.owner.id });
    expect(done.state).toBe("succeeded");
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]).toMatchObject({ from: "+14045550100", to_number: "+14045550142", body: expect.stringContaining("about 20 minutes away") });
  });

  it("blocks approval when the visit was cancelled or consent withdrawn after the request", async () => {
    const f = await fixture();
    await connect(f.orgId, "appt.sms.on_my_way");
    const visit = await f.appointment();
    const pending = await apptRequestOnMyWayText({ organizationId: f.orgId, appointmentId: visit.id, actorUserId: f.tech.id });
    await db.update(appointmentsTable).set({ status: "cancelled" }).where(eq(appointmentsTable.id, visit.id));
    await expect(approveZapierAction({ organizationId: f.orgId, executionId: pending.execution.id, userId: f.owner.id })).rejects.toMatchObject({ code: "invalid_input" });

    const second = await f.appointment();
    const another = await apptRequestOnMyWayText({ organizationId: f.orgId, appointmentId: second.id, actorUserId: f.tech.id });
    await db.update(contactsTable).set({ doNotContactSms: true }).where(eq(contactsTable.id, f.contact.id));
    await expect(approveZapierAction({ organizationId: f.orgId, executionId: another.execution.id, userId: f.owner.id })).rejects.toMatchObject({ message: expect.stringMatching(/do not text/) });
    expect(fake.calls).toHaveLength(0);
  });
});

describe("BILL pay link text", () => {
  it("says who it is from, the invoice number, balance and the open pay link, and rebuilds for approval", async () => {
    const f = await fixture();
    const invoice = await f.invoice();
    const link = await f.payLink(invoice);
    const built = await buildPayLinkTextInput(f.orgId, invoice.id, f.owner.id);
    expect(built.idempotencyKey).toBe(`bill-paylink-text:${link.id}:v${invoice.version}:10000`);
    expect(built.input.toPhone).toBe("+14045550142");
    expect(built.input.body).toBe(
      `Hi Dana, this is Synthetic Field Co. Invoice ${invoice.invoiceNumber} has a balance of $100.00. Pay securely here: https://checkout.stripe.test/c/synthetic ${OPT_OUT_LINE}`,
    );
    const execution = { capability: "bill.sms.payment_link", organizationId: f.orgId, idempotencyKey: built.idempotencyKey, linkedEntityId: link.id, requestSummary: {}, requestedByUserId: f.owner.id } as unknown as Execution;
    expect(await rebuildZapierRequestInput(execution)).toEqual(built.input);

    await expect(buildPayLinkTextInput(f.orgId, invoice.id, f.owner.id, { linkId: link.id, version: invoice.version, amountCents: 5000 })).rejects.toMatchObject({ message: expect.stringMatching(/balance changed/) });
  });

  it("refuses without an open pay link, without consent, without invoice access and across companies", async () => {
    const f = await fixture();
    const invoice = await f.invoice();
    await expect(buildPayLinkTextInput(f.orgId, invoice.id, f.owner.id)).rejects.toMatchObject({ message: expect.stringMatching(/Create a pay link/) });
    await f.payLink(invoice, { expiresAt: new Date(Date.now() - 1000) });
    await expect(buildPayLinkTextInput(f.orgId, invoice.id, f.owner.id)).rejects.toMatchObject({ message: expect.stringMatching(/Create a pay link/) });
    await f.payLink(invoice);
    await expect(buildPayLinkTextInput(f.orgId, invoice.id, f.tech.id)).rejects.toMatchObject({ code: "invalid_input" });

    const other = await fixture();
    await expect(buildPayLinkTextInput(other.orgId, invoice.id, other.owner.id)).rejects.toMatchObject({ code: "not_found" });

    const noConsent = await fixture({ smsConsent: false });
    const unconsented = await noConsent.invoice();
    await noConsent.payLink(unconsented);
    await expect(buildPayLinkTextInput(noConsent.orgId, unconsented.id, noConsent.owner.id)).rejects.toMatchObject({ message: expect.stringMatching(/not agreed to receive texts/) });
  });

  it("parks for approval, is idempotent per link, and refuses approval once the link is no longer open", async () => {
    const f = await fixture();
    await connect(f.orgId, "bill.sms.payment_link");
    const invoice = await f.invoice();
    const link = await f.payLink(invoice);
    const pending = await billRequestPayLinkText({ organizationId: f.orgId, invoiceId: invoice.id, actorUserId: f.owner.id });
    expect(pending.execution).toMatchObject({ state: "pending_approval", capability: "bill.sms.payment_link", specialistId: "bill", linkedEntityId: link.id });
    const replay = await billRequestPayLinkText({ organizationId: f.orgId, invoiceId: invoice.id, actorUserId: f.owner.id });
    expect(replay.execution.id).toBe(pending.execution.id);

    await db.update(invoicePaymentLinksTable).set({ state: "expired" }).where(eq(invoicePaymentLinksTable.id, link.id));
    await expect(approveZapierAction({ organizationId: f.orgId, executionId: pending.execution.id, userId: f.owner.id })).rejects.toMatchObject({ message: expect.stringMatching(/no longer open/) });
    const [row] = await db.select().from(zapierActionExecutionsTable).where(eq(zapierActionExecutionsTable.id, pending.execution.id));
    expect(row!.state).toBe("pending_approval");
    expect(fake.calls).toHaveLength(0);
  });

  it("sends the approved pay link text once", async () => {
    const f = await fixture();
    await connect(f.orgId, "bill.sms.payment_link");
    const invoice = await f.invoice();
    await f.payLink(invoice);
    const pending = await billRequestPayLinkText({ organizationId: f.orgId, invoiceId: invoice.id, actorUserId: f.owner.id });
    const done = await approveZapierAction({ organizationId: f.orgId, executionId: pending.execution.id, userId: f.owner.id });
    expect(done.state).toBe("succeeded");
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]).toMatchObject({ to_number: "+14045550142", body: expect.stringContaining("https://checkout.stripe.test/c/synthetic") });
    const again = await billRequestPayLinkText({ organizationId: f.orgId, invoiceId: invoice.id, actorUserId: f.owner.id });
    expect(again.execution.id).toBe(pending.execution.id);
    expect(fake.calls).toHaveLength(1);
  });
});

describe("tap-sent field texts: Automatic by default, Approve each still parks", () => {
  const recommended = (key: "appt.sms.on_my_way" | "bill.sms.payment_link") => getZapierCapability(key)!.defaultMode;

  it("defaults both field texts to Automatic, and leaves every other customer text on Approve each", () => {
    expect(recommended("appt.sms.on_my_way")).toBe("auto");
    expect(recommended("bill.sms.payment_link")).toBe("auto");
    expect(getZapierCapability("appt.sms.send")!.defaultMode).toBe("approve");
    expect(getZapierCapability("maintain.sms.send")!.defaultMode).toBe("approve");
  });

  it("sends a tech's On My Way tap straight to the phone app under the default policy; Approve each parks it", async () => {
    const f = await fixture();
    await connect(f.orgId, "appt.sms.on_my_way", recommended("appt.sms.on_my_way"));
    const visit = await f.appointment();
    const sent = await apptRequestOnMyWayText({ organizationId: f.orgId, appointmentId: visit.id, actorUserId: f.tech.id, etaMinutes: 10 });
    expect(sent.execution.state).toBe("succeeded");
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]).toMatchObject({ to_number: "+14045550142", body: expect.stringContaining("about 10 minutes away") });
    // Still one per appointment per day.
    expect((await apptRequestOnMyWayText({ organizationId: f.orgId, appointmentId: visit.id, actorUserId: f.tech.id, etaMinutes: 10 })).execution.id).toBe(sent.execution.id);
    expect(fake.calls).toHaveLength(1);

    const approve = await fixture();
    await connect(approve.orgId, "appt.sms.on_my_way", "approve");
    const parked = await apptRequestOnMyWayText({ organizationId: approve.orgId, appointmentId: (await approve.appointment()).id, actorUserId: approve.tech.id });
    expect(parked.execution.state).toBe("pending_approval");
    expect(fake.calls).toHaveLength(1);
  });

  it("keeps consent and the owner's on/off choice: no consent or no policy chosen sends nothing", async () => {
    const noConsent = await fixture({ smsConsent: false });
    await connect(noConsent.orgId, "appt.sms.on_my_way", "auto");
    await expect(apptRequestOnMyWayText({ organizationId: noConsent.orgId, appointmentId: (await noConsent.appointment()).id, actorUserId: noConsent.tech.id })).rejects.toMatchObject({ message: expect.stringMatching(/not agreed to receive texts/) });

    const unchosen = await fixture();
    await connect(unchosen.orgId, "appt.sms.on_my_way", null);
    const blocked = await apptRequestOnMyWayText({ organizationId: unchosen.orgId, appointmentId: (await unchosen.appointment()).id, actorUserId: unchosen.tech.id });
    expect(blocked.execution).toMatchObject({ state: "blocked", errorCode: "policy_off" });
    expect(fake.calls).toHaveLength(0);
  });

  it("lets a tech text the pay link for an invoice linked to their own job, straight out under the default policy", async () => {
    const f = await fixture();
    await connect(f.orgId, "bill.sms.payment_link", recommended("bill.sms.payment_link"));
    const visit = await f.appointment();
    const invoice = await f.invoice();
    await f.payLink(invoice);
    const sent = await billRequestPayLinkText({ organizationId: f.orgId, invoiceId: invoice.id, actorUserId: f.tech.id, field: { appointmentId: visit.id } });
    expect(sent.execution).toMatchObject({ state: "succeeded", requestedByUserId: f.tech.id });
    expect(fake.calls).toHaveLength(1);

    // Someone else's job, or a job whose lead has no such invoice, is refused before anything is requested.
    const [otherTech] = await db.insert(usersTable).values({ organizationId: f.orgId, role: "production", firstName: "Lee", emailVerifiedAt: new Date() }).returning();
    await expect(billRequestPayLinkText({ organizationId: f.orgId, invoiceId: invoice.id, actorUserId: otherTech!.id, field: { appointmentId: visit.id } })).rejects.toBeInstanceOf(FieldCollectError);
    const [otherLead] = await db.insert(leadsTable).values({ organizationId: f.orgId, contactId: f.contact.id }).returning();
    const unrelated = await f.appointment({ leadId: otherLead!.id });
    await expect(billRequestPayLinkText({ organizationId: f.orgId, invoiceId: invoice.id, actorUserId: f.tech.id, field: { appointmentId: unrelated.id } })).rejects.toMatchObject({ status: 403, code: "field_invoice_not_linked" });
    expect(fake.calls).toHaveLength(1);
  });

  it("re-checks a tech's queued pay link text against their jobs when the office approves it", async () => {
    const f = await fixture();
    await connect(f.orgId, "bill.sms.payment_link", "approve");
    const visit = await f.appointment();
    const invoice = await f.invoice();
    await f.payLink(invoice);
    const parked = await billRequestPayLinkText({ organizationId: f.orgId, invoiceId: invoice.id, actorUserId: f.tech.id, field: { appointmentId: visit.id } });
    expect(parked.execution.state).toBe("pending_approval");
    // Reassigning the job away from the tech makes the queued text stale.
    await db.update(appointmentsTable).set({ assignedUserId: f.owner.id }).where(eq(appointmentsTable.id, visit.id));
    await expect(approveZapierAction({ organizationId: f.orgId, executionId: parked.execution.id, userId: f.owner.id })).rejects.toMatchObject({ code: "invalid_input" });
    await db.update(appointmentsTable).set({ assignedUserId: f.tech.id }).where(eq(appointmentsTable.id, visit.id));
    expect((await approveZapierAction({ organizationId: f.orgId, executionId: parked.execution.id, userId: f.owner.id })).state).toBe("succeeded");
    expect(fake.calls).toHaveLength(1);
  });
});
