/**
 * Delivery/suppression path: provider webhooks record delivered / bounced /
 * unsubscribed per touch, hard bounces and opt-outs flip the contact's
 * per-channel do-not-contact flag + suppress the address, the send gate
 * refuses that channel afterwards, and the event lands on the lead timeline.
 */
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createHmac } from "node:crypto";

import {
  activitiesTable,
  contactsTable,
  db,
  leadsTable,
  organizationsTable,
  playbookEnrollmentsTable,
  playbookTouchesTable,
  playbooksTable,
  suppressionsTable,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import app from "../app";
import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";
import {
  handleBounce,
  isPermanentTwilioError,
  recordContactOptOut,
  recordTouchDelivery,
} from "./delivery-events";
import { checkSendEligibility, getSuppression } from "./send-gate";
import { recordTouch } from "./playbook-learning";

let server: Server;
let baseUrl: string;
let org: { id: string };
let otherOrg: { id: string };
let playbookId: string;
let otherPlaybookId: string;
const webhookSecret = `whsec_${Buffer.from("synthetic-resend-signing-secret-only").toString("base64")}`;

const resendCorrelation = (providerMessageId: string, address: string) => ({
  provider: "resend" as const,
  channel: "email" as const,
  providerMessageId,
  address,
});

function signedHeaders(body: string) {
  const id = "msg_synthetic_delivery_test";
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = createHmac(
    "sha256",
    Buffer.from(webhookSecret.slice(6), "base64"),
  )
    .update(`${id}.${timestamp}.${body}`)
    .digest("base64");
  return {
    "content-type": "application/json",
    "svix-id": id,
    "svix-timestamp": timestamp,
    "svix-signature": `v1,${signature}`,
  };
}

async function makeContactLead(input: {
  email?: string;
  phone?: string;
  organizationId?: string;
}) {
  const [contact] = await db
    .insert(contactsTable)
    .values({
      organizationId: input.organizationId ?? org.id,
      firstName: "Delivery",
      email: input.email ?? null,
      phone: input.phone ?? null,
    })
    .returning();
  const [lead] = await db
    .insert(leadsTable)
    .values({
      organizationId: input.organizationId ?? org.id,
      contactId: contact.id,
      source: "test",
    })
    .returning();
  return { contact, lead };
}

async function makeTouch(input: {
  leadId: string;
  channel: "email" | "sms";
  providerMessageId: string;
  provider?: string;
  organizationId?: string;
}) {
  const organizationId = input.organizationId ?? org.id;
  const scopedPlaybookId =
    organizationId === org.id ? playbookId : otherPlaybookId;
  const [enrollment] = await db
    .insert(playbookEnrollmentsTable)
    .values({
      organizationId,
      playbookId: scopedPlaybookId,
      leadId: input.leadId,
      status: "completed",
      currentStep: 1,
    })
    .returning();
  await recordTouch({
    organizationId,
    playbookId: scopedPlaybookId,
    enrollmentId: enrollment.id,
    leadId: input.leadId,
    stepIndex: 0,
    variantKey: "default",
    channel: input.channel,
    provider:
      input.provider ?? (input.channel === "email" ? "resend" : "twilio"),
    providerMessageId: input.providerMessageId,
  });
  const [touch] = await db
    .select()
    .from(playbookTouchesTable)
    .where(
      and(
        eq(playbookTouchesTable.providerMessageId, input.providerMessageId),
        eq(playbookTouchesTable.leadId, input.leadId),
      ),
    );
  return touch;
}

async function getTouch(providerMessageId: string) {
  const [touch] = await db
    .select()
    .from(playbookTouchesTable)
    .where(eq(playbookTouchesTable.providerMessageId, providerMessageId));
  return touch;
}

beforeAll(async () => {
  vi.stubEnv("RESEND_WEBHOOK_SECRET", webhookSecret);
  const [o] = await db
    .insert(organizationsTable)
    .values({ name: "Delivery Test Org", slug: `test-delivery-${Date.now()}` })
    .returning();
  org = o;
  const [pb] = await db
    .insert(playbooksTable)
    .values({
      organizationId: org.id,
      name: "Delivery test playbook",
      isActive: true,
      enrollmentRules: {},
      steps: [{ channel: "email", delayMinutes: 1, prompt: "test" }],
    })
    .returning();
  playbookId = pb.id;
  const [second] = await db
    .insert(organizationsTable)
    .values({
      name: "Other Delivery Test Org",
      slug: `test-delivery-other-${Date.now()}`,
    })
    .returning();
  otherOrg = second;
  const [otherPb] = await db
    .insert(playbooksTable)
    .values({
      organizationId: second.id,
      name: "Other delivery test playbook",
      steps: [],
    })
    .returning();
  otherPlaybookId = otherPb.id;
  server = app.listen(0);
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  if (server)
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  await deleteTestOrgs(org.id, otherOrg.id);
  vi.unstubAllEnvs();
});

describe("recordTouchDelivery", () => {
  it("records delivered, and never lets delivered overwrite a bounce", async () => {
    const { lead } = await makeContactLead({ email: "d1@example.com" });
    await makeTouch({
      leadId: lead.id,
      channel: "email",
      providerMessageId: "re-d1",
    });

    await recordTouchDelivery({
      ...resendCorrelation("re-d1", "d1@example.com"),
      signal: "delivered",
    });
    expect((await getTouch("re-d1")).delivery).toBe("delivered");

    await recordTouchDelivery({
      ...resendCorrelation("re-d1", "d1@example.com"),
      signal: "bounced",
    });
    expect((await getTouch("re-d1")).delivery).toBe("bounced");

    // delivered arriving late does not downgrade the bounce
    await recordTouchDelivery({
      ...resendCorrelation("re-d1", "d1@example.com"),
      signal: "delivered",
    });
    expect((await getTouch("re-d1")).delivery).toBe("bounced");
  });

  it("puts bounces on the lead timeline", async () => {
    const { lead } = await makeContactLead({ email: "d2@example.com" });
    await makeTouch({
      leadId: lead.id,
      channel: "email",
      providerMessageId: "re-d2",
    });
    await recordTouchDelivery({
      ...resendCorrelation("re-d2", "d2@example.com"),
      signal: "bounced",
    });
    const rows = await db
      .select()
      .from(activitiesTable)
      .where(
        and(
          eq(activitiesTable.leadId, lead.id),
          eq(activitiesTable.type, "message_bounced"),
        ),
      );
    expect(rows.length).toBe(1);
    expect(rows[0].title).toMatch(/bounced/i);
  });

  it("is a no-op for unknown message ids", async () => {
    expect(
      await recordTouchDelivery({
        ...resendCorrelation("re-nope", "unknown@example.com"),
        signal: "delivered",
      }),
    ).toBeNull();
  });

  it("does not accept a Resend callback for another provider or recipient", async () => {
    const { contact, lead } = await makeContactLead({
      email: "gmail@example.com",
    });
    await makeTouch({
      leadId: lead.id,
      channel: "email",
      provider: "gmail",
      providerMessageId: "foreign-provider-id",
    });
    await handleBounce({
      ...resendCorrelation("foreign-provider-id", "gmail@example.com"),
      reason: "hard_bounce",
      source: "resend_webhook",
    });
    expect((await getTouch("foreign-provider-id")).delivery).toBeNull();
    const [gmailContact] = await db
      .select()
      .from(contactsTable)
      .where(eq(contactsTable.id, contact.id));
    expect(gmailContact.doNotContactEmail).toBe(false);

    await makeTouch({
      leadId: lead.id,
      channel: "email",
      providerMessageId: "recipient-bound-id",
    });
    await handleBounce({
      ...resendCorrelation("recipient-bound-id", "unrelated@example.com"),
      reason: "hard_bounce",
      source: "resend_webhook",
    });
    expect((await getTouch("recipient-bound-id")).delivery).toBeNull();
    expect(
      await getSuppression(org.id, "email", "gmail@example.com"),
    ).toBeNull();
  });

  it("rejects ambiguous provider IDs shared by different tenants", async () => {
    const a = await makeContactLead({ email: "duplicate@example.com" });
    const b = await makeContactLead({
      email: "duplicate@example.com",
      organizationId: otherOrg.id,
    });
    const first = await makeTouch({
      leadId: a.lead.id,
      channel: "email",
      providerMessageId: "duplicate-resend-id",
    });
    const second = await makeTouch({
      leadId: b.lead.id,
      organizationId: otherOrg.id,
      channel: "email",
      providerMessageId: "duplicate-resend-id",
    });
    await handleBounce({
      ...resendCorrelation("duplicate-resend-id", "duplicate@example.com"),
      reason: "hard_bounce",
      source: "resend_webhook",
    });
    for (const touch of [first, second]) {
      const [unchanged] = await db
        .select()
        .from(playbookTouchesTable)
        .where(eq(playbookTouchesTable.id, touch.id));
      expect(unchanged.delivery).toBeNull();
    }
    expect(
      await getSuppression(org.id, "email", "duplicate@example.com"),
    ).toBeNull();
    expect(
      await getSuppression(otherOrg.id, "email", "duplicate@example.com"),
    ).toBeNull();
  });

  it("binds Twilio delivery to the authenticated dispatch organization", async () => {
    const { lead } = await makeContactLead({ phone: "+1 (555) 200-0050" });
    await makeTouch({
      leadId: lead.id,
      channel: "sms",
      providerMessageId: "SM-scoped",
    });
    const receipt = {
      provider: "twilio" as const,
      channel: "sms" as const,
      providerMessageId: "SM-scoped",
      address: "+15552000050",
      signal: "delivered" as const,
    };
    expect(
      await recordTouchDelivery({ ...receipt, organizationId: otherOrg.id }),
    ).toBeNull();
    expect((await getTouch("SM-scoped")).delivery).toBeNull();
    await recordTouchDelivery({ ...receipt, organizationId: org.id });
    expect((await getTouch("SM-scoped")).delivery).toBe("delivered");
  });

  it("allows delivery to recover a temporary failure without suppression", async () => {
    const { lead } = await makeContactLead({ email: "temporary@example.com" });
    await makeTouch({
      leadId: lead.id,
      channel: "email",
      providerMessageId: "re-temporary",
    });
    const correlation = resendCorrelation(
      "re-temporary",
      "temporary@example.com",
    );
    await recordTouchDelivery({ ...correlation, signal: "delayed" });
    expect((await getTouch("re-temporary")).delivery).toBe("delayed");
    await recordTouchDelivery({ ...correlation, signal: "failed" });
    await recordTouchDelivery({ ...correlation, signal: "delivered" });
    await recordTouchDelivery({ ...correlation, signal: "delayed" });
    expect((await getTouch("re-temporary")).delivery).toBe("delivered");
    expect(
      await getSuppression(org.id, "email", "temporary@example.com"),
    ).toBeNull();
  });
});

describe("hard bounce → per-channel DNC + suppression → gate blocks", () => {
  it("email bounce stops future email but leaves SMS eligible", async () => {
    const { contact, lead } = await makeContactLead({
      email: "bounce@example.com",
      phone: "+1 (555) 200-0001",
    });
    await makeTouch({
      leadId: lead.id,
      channel: "email",
      providerMessageId: "re-b1",
    });

    await handleBounce({
      provider: "resend",
      providerMessageId: "re-b1",
      channel: "email",
      address: "bounce@example.com",
      reason: "hard_bounce",
      source: "resend_webhook",
    });

    expect((await getTouch("re-b1")).delivery).toBe("bounced");
    const [updated] = await db
      .select()
      .from(contactsTable)
      .where(eq(contactsTable.id, contact.id));
    expect(updated.doNotContactEmail).toBe(true);
    expect(updated.doNotContactSms).toBe(false);
    const suppression = await getSuppression(
      org.id,
      "email",
      "bounce@example.com",
    );
    expect(suppression?.reason).toBe("hard_bounce");

    const gate = await checkSendEligibility({
      organizationId: org.id,
      contact: updated,
      channel: "email",
      kind: "outreach",
    });
    expect(gate).toMatchObject({ ok: false, reason: "do_not_contact_email" });
  });

  it("never suppresses any tenant by address when no touch correlates", async () => {
    const { contact } = await makeContactLead({ email: "orphan@example.com" });
    const { contact: foreign } = await makeContactLead({
      email: "orphan@example.com",
      organizationId: otherOrg.id,
    });
    await handleBounce({
      provider: "resend",
      providerMessageId: "re-unknown-id",
      channel: "email",
      address: "Orphan@Example.com",
      reason: "hard_bounce",
      source: "resend_webhook",
    });
    const [updated] = await db
      .select()
      .from(contactsTable)
      .where(eq(contactsTable.id, contact.id));
    expect(updated.doNotContactEmail).toBe(false);
    expect(
      await getSuppression(org.id, "email", "orphan@example.com"),
    ).toBeNull();
    const [untouched] = await db
      .select()
      .from(contactsTable)
      .where(eq(contactsTable.id, foreign.id));
    expect(untouched.doNotContactEmail).toBe(false);
    expect(
      await getSuppression(otherOrg.id, "email", "orphan@example.com"),
    ).toBeNull();
  });

  it("suppresses only the correlated tenant and records one activity for a replay", async () => {
    const { lead } = await makeContactLead({ email: "shared@example.com" });
    const other = await makeContactLead({
      email: "shared@example.com",
      organizationId: otherOrg.id,
    });
    await makeTouch({
      leadId: lead.id,
      channel: "email",
      providerMessageId: "re-scoped",
    });
    const callback = {
      ...resendCorrelation("re-scoped", "shared@example.com"),
      reason: "hard_bounce" as const,
      source: "resend_webhook",
    };
    await handleBounce(callback);
    await handleBounce(callback);
    expect(
      await getSuppression(org.id, "email", "shared@example.com"),
    ).not.toBeNull();
    expect(
      await getSuppression(otherOrg.id, "email", "shared@example.com"),
    ).toBeNull();
    const [foreign] = await db
      .select()
      .from(contactsTable)
      .where(eq(contactsTable.id, other.contact.id));
    expect(foreign.doNotContactEmail).toBe(false);
    const activities = await db
      .select()
      .from(activitiesTable)
      .where(
        and(
          eq(activitiesTable.leadId, lead.id),
          eq(activitiesTable.type, "message_bounced"),
        ),
      );
    expect(activities).toHaveLength(1);
  });

  it("does not suppress a replacement address after a contact was edited", async () => {
    const { contact, lead } = await makeContactLead({
      email: "old@example.com",
    });
    await makeTouch({
      leadId: lead.id,
      channel: "email",
      providerMessageId: "re-edited",
    });
    await db
      .update(contactsTable)
      .set({ email: "replacement@example.com" })
      .where(eq(contactsTable.id, contact.id));
    await handleBounce({
      ...resendCorrelation("re-edited", "old@example.com"),
      reason: "hard_bounce",
      source: "resend_webhook",
    });
    expect((await getTouch("re-edited")).delivery).toBeNull();
    const [unchanged] = await db
      .select()
      .from(contactsTable)
      .where(eq(contactsTable.id, contact.id));
    expect(unchanged.doNotContactEmail).toBe(false);
    expect(
      await getSuppression(org.id, "email", "replacement@example.com"),
    ).toBeNull();
  });

  it("rolls back the delivery state and contact block if suppression persistence fails", async () => {
    const { contact, lead } = await makeContactLead({
      email: "rollback@example.com",
    });
    await makeTouch({
      leadId: lead.id,
      channel: "email",
      providerMessageId: "re-rollback",
    });
    const original = db.transaction.bind(db);
    const spy = vi
      .spyOn(db, "transaction")
      .mockImplementationOnce((callback, config) =>
        original(async (tx) => {
          const insert = tx.insert.bind(tx);
          vi.spyOn(tx, "insert").mockImplementation(((
            table: Parameters<typeof insert>[0],
          ) => {
            if (table === suppressionsTable)
              throw new Error("synthetic suppression storage failure");
            return insert(table);
          }) as typeof tx.insert);
          return callback(tx);
        }, config),
      );
    try {
      await expect(
        handleBounce({
          ...resendCorrelation("re-rollback", "rollback@example.com"),
          reason: "hard_bounce",
          source: "resend_webhook",
        }),
      ).rejects.toThrow("synthetic suppression storage failure");
    } finally {
      spy.mockRestore();
    }
    expect((await getTouch("re-rollback")).delivery).toBeNull();
    const [unchanged] = await db
      .select()
      .from(contactsTable)
      .where(eq(contactsTable.id, contact.id));
    expect(unchanged.doNotContactEmail).toBe(false);
    const activities = await db
      .select()
      .from(activitiesTable)
      .where(eq(activitiesTable.leadId, lead.id));
    expect(activities).toHaveLength(0);
  });
});

describe("per-channel DNC in the send gate", () => {
  it("sms flag blocks sms only", async () => {
    const { contact } = await makeContactLead({
      email: "chan@example.com",
      phone: "+1 (555) 200-0002",
    });
    await db
      .update(contactsTable)
      .set({ doNotContactSms: true })
      .where(eq(contactsTable.id, contact.id));
    const [updated] = await db
      .select()
      .from(contactsTable)
      .where(eq(contactsTable.id, contact.id));
    const sms = await checkSendEligibility({
      organizationId: org.id,
      contact: updated,
      channel: "sms",
      kind: "transactional",
    });
    expect(sms).toMatchObject({ ok: false, reason: "do_not_contact_sms" });
    const email = await checkSendEligibility({
      organizationId: org.id,
      contact: updated,
      channel: "email",
      kind: "transactional",
    });
    expect(email).toEqual({ ok: true });
  });
});

describe("recordContactOptOut", () => {
  it("marks outstanding touches unsubscribed and records the timeline entry", async () => {
    const { contact, lead } = await makeContactLead({
      email: "opt@example.com",
    });
    await makeTouch({
      leadId: lead.id,
      channel: "email",
      providerMessageId: "re-o1",
    });

    await recordContactOptOut({
      organizationId: org.id,
      contactId: contact.id,
      channel: "email",
      source: "unsubscribe_link",
    });

    expect((await getTouch("re-o1")).delivery).toBe("unsubscribed");
    const [updated] = await db
      .select()
      .from(contactsTable)
      .where(eq(contactsTable.id, contact.id));
    expect(updated.doNotContactEmail).toBe(true);
    expect(
      await getSuppression(org.id, "email", "opt@example.com"),
    ).not.toBeNull();
    const rows = await db
      .select()
      .from(activitiesTable)
      .where(
        and(
          eq(activitiesTable.leadId, lead.id),
          eq(activitiesTable.type, "message_unsubscribed"),
        ),
      );
    expect(rows.length).toBe(1);
  });
});

describe("webhook routes", () => {
  it("Resend bounce webhook records the bounce end to end", async () => {
    const { contact, lead } = await makeContactLead({
      email: "hook@example.com",
    });
    await makeTouch({
      leadId: lead.id,
      channel: "email",
      providerMessageId: "re-h1",
    });

    const body = JSON.stringify({
      type: "email.bounced",
      data: {
        email_id: "re-h1",
        to: ["hook@example.com"],
        bounce: { type: "Permanent", message: "550 no mailbox" },
      },
    });
    const res = await fetch(`${baseUrl}/api/v1/public/webhooks/resend`, {
      method: "POST",
      headers: signedHeaders(body),
      body,
    });
    expect(res.status).toBe(200);
    expect((await getTouch("re-h1")).delivery).toBe("bounced");
    const [updated] = await db
      .select()
      .from(contactsTable)
      .where(eq(contactsTable.id, contact.id));
    expect(updated.doNotContactEmail).toBe(true);
  });

  it("rejects unsigned legacy Twilio failure callbacks without changing delivery state", async () => {
    const { contact, lead } = await makeContactLead({
      phone: "+1 (555) 200-0003",
    });
    await makeTouch({
      leadId: lead.id,
      channel: "sms",
      providerMessageId: "SM-perm",
    });

    const res = await fetch(`${baseUrl}/api/v1/public/sms/status`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        MessageSid: "SM-perm",
        MessageStatus: "undelivered",
        ErrorCode: "30006",
        To: "+15552000003",
      }).toString(),
    });
    expect(res.status).toBe(403);
    expect((await getTouch("SM-perm")).delivery).not.toBe("bounced");
    const [updated] = await db
      .select()
      .from(contactsTable)
      .where(eq(contactsTable.id, contact.id));
    expect(updated.doNotContactSms).toBe(false);
    expect(await getSuppression(org.id, "sms", "+15552000003")).toBeNull();
  });

  it("rejects unsigned legacy Twilio delivered callbacks", async () => {
    const { lead } = await makeContactLead({ phone: "+1 (555) 200-0004" });
    await makeTouch({
      leadId: lead.id,
      channel: "sms",
      providerMessageId: "SM-ok",
    });
    const res = await fetch(`${baseUrl}/api/v1/public/sms/status`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        MessageSid: "SM-ok",
        MessageStatus: "delivered",
        To: "+15552000004",
      }).toString(),
    });
    expect(res.status).toBe(403);
    expect((await getTouch("SM-ok")).delivery).not.toBe("delivered");
  });
});

describe("isPermanentTwilioError", () => {
  it("classifies codes", () => {
    expect(isPermanentTwilioError("30006")).toBe(true);
    expect(isPermanentTwilioError("21211")).toBe(true);
    expect(isPermanentTwilioError("30003")).toBe(false);
    expect(isPermanentTwilioError(undefined)).toBe(false);
  });
});
