/**
 * SMS delivery round-trip tests.
 *
 * Verifies the consent-gated Twilio adapter with intercepted HTTP, provider
 * selection, and the fail-closed boundary that keeps legacy marketing
 * automations from borrowing the initial customer-care SMS program.
 */
import {
  automationRunsTable,
  consentRecordsTable,
  contactsTable,
  db,
  organizationsTable,
  revenueExecutionsTable,
  DEFAULT_SENDING_HOURS,
  twilioClientBindingsTable,
  twilioConsentProofsTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";
import { syntheticTwilioNumber, syntheticTwilioSid } from "../test-helpers/synthetic-twilio";
import { updateOrgSettings } from "./settings";

import { createAutomation, runEvent } from "./automation";
import { runDurableAction } from "./durable-execution";
import * as crm from "./crm";
import { providers, twilioSmsProvider } from "./providers";
import { SMS_DISCLOSURE_VERSION } from "./twilio-controls";

const account = `AC${"a".repeat(32)}`;
const service = `MG${"b".repeat(32)}`;
const apiKey = `SK${"3".repeat(32)}`;
const apiSecret = "synthetic-api-key-secret";
const authToken = "synthetic-webhook-token";
const sender = syntheticTwilioNumber();
const recipient = "+15551234567";
let org: { id: string };
let contact: { id: string };

function twilioEnv() {
  return {
    APP_ORIGIN: "https://growth.example",
    TWILIO_CLIENT_SMS_TEST_AUTH_TOKEN: authToken,
    TWILIO_CLIENT_SMS_TEST_API_KEY_SECRET: apiSecret,
  };
}

function stubTwilioEnv() {
  for (const [k, v] of Object.entries(twilioEnv())) vi.stubEnv(k, v);
}

function context() {
  return {
    organizationId: org.id,
    contactId: contact.id,
    purpose: "customer_care" as const,
    idempotencyKey: randomUUID(),
  };
}

/** Stub global fetch to act as the Twilio Messages endpoint. */
function stubTwilioFetch(
  response: { ok: boolean; status?: number; json?: unknown; text?: string } = {
    ok: true,
    json: { sid: "SMstubbed123" },
  },
) {
  const calls: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return {
        ok: response.ok,
        status: response.status ?? (response.ok ? 201 : 400),
        json: async () => response.json ?? {},
        text: async () => response.text ?? "",
      } as Response;
    }),
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

beforeAll(async () => {
  const [createdOrg] = await db
    .insert(organizationsTable)
    .values({ name: "SMS Delivery Test Org", slug: `test-sms-${randomUUID()}` })
    .returning();
  org = createdOrg;
  await db.insert(twilioClientBindingsTable).values({
    organizationId: org.id, accountSid: account, phoneNumber: sender,
    messagingServiceSid: service, apiKeySid: apiKey,
    authTokenSecretRef: "TWILIO_CLIENT_SMS_TEST_AUTH_TOKEN",
    apiKeySecretRef: "TWILIO_CLIENT_SMS_TEST_API_KEY_SECRET",
    publicOrigin: "https://growth.example", businessName: "Synthetic SMS",
    smsDisclosureVersion: SMS_DISCLOSURE_VERSION, dailySmsLimit: 20,
    launchApproved: true, smsEnabled: true, registrationApproved: true,
    advancedOptOut: true, geoPermissionsReviewed: true,
  });
  const [createdContact] = await db
    .insert(contactsTable)
    .values({ organizationId: org.id, firstName: "Synthetic", phone: recipient })
    .returning();
  contact = createdContact;
  await db.insert(twilioConsentProofsTable).values({
    organizationId: org.id,
    contactId: contact.id,
    phone: recipient,
    purpose: "customer_care",
    granted: true,
    disclosureVersion: SMS_DISCLOSURE_VERSION,
    source: "synthetic test proof",
  });
  await db.insert(consentRecordsTable).values({
    organizationId: org.id,
    contactId: contact.id,
    channel: "sms",
    granted: true,
    disclosureVersion: SMS_DISCLOSURE_VERSION,
  });
  await updateOrgSettings(org.id, {
    sendingHours: { ...DEFAULT_SENDING_HOURS, quietHoursEnabled: false },
  });
});

afterAll(async () => {
  await deleteTestOrgs(org.id);
});

describe("twilioSmsProvider", () => {
  it("POSTs the correct to/from/body to the Twilio API and returns the SID", async () => {
    stubTwilioEnv();
    const sid = syntheticTwilioSid("SM");
    const calls = stubTwilioFetch({ ok: true, json: { sid } });

    const res = await twilioSmsProvider.send(recipient, "Hello homeowner", context());

    expect(res).toEqual({ id: sid, provider: "twilio" });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(
      `https://api.twilio.com/2010-04-01/Accounts/${account}/Messages.json`,
    );
    const init = calls[0].init;
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe(
      `Basic ${Buffer.from(`${apiKey}:${apiSecret}`).toString("base64")}`,
    );
    const params = new URLSearchParams(String(init.body));
    expect(params.get("To")).toBe(recipient);
    expect(params.get("From")).toBeNull();
    expect(params.get("MessagingServiceSid")).toBe(service);
    expect(params.get("Body")).toContain("Hello homeowner");
    expect(params.get("Body")).toContain("Reply STOP");
    expect(params.get("StatusCallback")).toMatch(
      /^https:\/\/growth\.example\/api\/v1\/public\/sms\/status\?operation=/,
    );
  });

  it("throws when Twilio env is missing (never silently pretends to send)", async () => {
    const calls = stubTwilioFetch();
    await expect(twilioSmsProvider.send(recipient, "x", context())).rejects.toThrow(
      /disabled/i,
    );
    expect(calls).toHaveLength(0);
  });

  it("throws on a non-OK Twilio response", async () => {
    stubTwilioEnv();
    stubTwilioFetch({ ok: false, status: 401, text: "auth error" });
    await expect(twilioSmsProvider.send(recipient, "x", context())).rejects.toThrow(
      /Twilio send failed: 401/,
    );
  });

  it("throws when Twilio returns no message SID", async () => {
    stubTwilioEnv();
    stubTwilioFetch({ ok: true, json: {} });
    await expect(twilioSmsProvider.send(recipient, "x", context())).rejects.toThrow(
      /no valid message SID/i,
    );
  });
});

describe("SMS provider selection (module load)", () => {
  it("routes a configured client through the Twilio guard at send time", async () => {
    stubTwilioEnv();
    const sid = syntheticTwilioSid("SM");
    const calls = stubTwilioFetch({ ok: true, json: { sid } });
    expect((await providers.sms.send(recipient, "Configured", context())).provider).toBe("twilio");
    expect(calls).toHaveLength(1);
  });

  it("never falls back to mock for a bound client with a missing secret", async () => {
    const calls = stubTwilioFetch();
    await expect(providers.sms.send(recipient, "No secret", context())).rejects.toThrow(/disabled/i);
    expect(calls).toHaveLength(0);
  });
});

describe("automation → send_sms → Twilio round-trip", () => {
  async function makeLead(phone: string, firstName: string) {
    const contact = await crm.createContact(org.id, {
      firstName,
      lastName: "Delivery",
      phone,
      email: `${firstName.toLowerCase()}@sms.example`,
    });
    await db.insert(consentRecordsTable).values({
      organizationId: org.id,
      contactId: contact.id,
      channel: "sms",
      granted: true,
      disclosureVersion: SMS_DISCLOSURE_VERSION,
    });
    const lead = await crm.createLead(org.id, { contactId: contact.id });
    return { contact, lead: lead! };
  }

  it("fails closed for legacy marketing automations without handing anything to Twilio", async () => {
    stubTwilioEnv();
    const calls = stubTwilioFetch({ ok: true, json: { sid: "SMe2e456" } });

    // The active provider was fixed at module load (mock in tests); swap in
    // the real Twilio adapter for this test to exercise the same object the
    // automation engine calls.
    const original = providers.sms;
    providers.sms = twilioSmsProvider;
    try {
      const rule = await createAutomation(org.id, {
        name: "e2e sms",
        event: "lead.created",
        actions: [
          { type: "send_sms", params: { body: "Hi {{contact.firstName}}, thanks!" } },
        ],
      });
      const { lead } = await makeLead("+15557654321", "Rhonda");
      await runEvent(org.id, "lead.created", { leadId: lead.id });

      expect(calls).toHaveLength(0);
      const runs = await db
        .select()
        .from(automationRunsTable)
        .where(eq(automationRunsTable.automationId, rule.id));
      expect(runs).toHaveLength(1);
      expect(runs[0].status).toBe("failed");
      expect(runs[0].actionResults[0].status).toBe("failed");
      expect(runs[0].actionResults[0].detail).toMatch(/purpose is not enabled/i);
    } finally {
      providers.sms = original;
    }
  });

  it("uses the labeled mock provider (no HTTP) when Twilio is not configured", async () => {
    const calls = stubTwilioFetch();
    // Without a tenant context in this local test, the router selects the labeled mock.
    const res = await providers.sms.send("+15551112222", "mock check");
    expect(res.provider).toBe("mock-sms");
    expect(calls).toHaveLength(0);
  });

  it("does not downgrade an unknown provider error that copies the local purpose-refusal message", async () => {
    const original = providers.sms;
    let attempts = 0;
    providers.sms = { ...original, send: vi.fn(async () => { attempts++; throw new Error("This SMS purpose is not enabled for the initial program"); }) };
    try {
      const action = { type: "send_sms" as const, params: { body: "Synthetic original unknown SMS" } };
      const rule = await createAutomation(org.id, { name: "Synthetic unknown SMS provenance", event: "assessment.abandoned", actions: [action] });
      const { lead } = await makeLead("+15557654329", "Uncertain");
      const context = { leadId: lead.id, event: "assessment.abandoned" };
      await runEvent(org.id, "assessment.abandoned", { leadId: lead.id });
      const [run] = await db.select().from(automationRunsTable).where(eq(automationRunsTable.automationId, rule.id));
      const [receipt] = await db.select().from(revenueExecutionsTable).where(eq(revenueExecutionsTable.actionKey, `automation-run:${run.id}:0`));
      expect(attempts).toBe(1); expect(run.status).toBe("failed"); expect(receipt.state).toBe("indeterminate");
      expect(run.actionResults[0].detail).not.toContain("purpose is not enabled");
      await runDurableAction({ organizationId: org.id, actionKey: receipt.actionKey, kind: "send_sms", payload: { action, context },
        execute: async () => { attempts++; return { state: "succeeded", detail: "Must not replay" }; } });
      expect(attempts).toBe(1);
    } finally { providers.sms = original; }
  });
});
