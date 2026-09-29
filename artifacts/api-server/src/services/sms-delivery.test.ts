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
  DEFAULT_SENDING_HOURS,
  twilioConsentProofsTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";
import { updateOrgSettings } from "./settings";

import { createAutomation, runEvent } from "./automation";
import * as crm from "./crm";
import { mockSmsProvider, providers, twilioSmsProvider } from "./providers";
import { SMS_DISCLOSURE_VERSION } from "./twilio-controls";

const account = `AC${"1".repeat(32)}`;
const service = `MG${"2".repeat(32)}`;
const apiKey = `SK${"3".repeat(32)}`;
const apiSecret = "synthetic-api-key-secret";
const authToken = "synthetic-webhook-token";
const sender = "+15005550006";
const recipient = "+15551234567";
let org: { id: string };
let contact: { id: string };

function twilioEnv() {
  return {
    APP_ORIGIN: "https://growth.example",
    TWILIO_PUBLIC_ORIGIN: "https://growth.example",
    TWILIO_ORGANIZATION_ID: org.id,
    TWILIO_ACCOUNT_SID: account,
    TWILIO_AUTH_TOKEN: authToken,
    TWILIO_MESSAGING_SERVICE_SID: service,
    TWILIO_PHONE_NUMBER: sender,
    TWILIO_API_KEY_SID: apiKey,
    TWILIO_API_KEY_SECRET: apiSecret,
    TWILIO_SMS_ENABLED: "true",
    TWILIO_REGISTRATION_APPROVED: "true",
    TWILIO_ADVANCED_OPT_OUT: "true",
    TWILIO_LAUNCH_APPROVED: "true",
    TWILIO_GEO_PERMISSIONS_REVIEWED: "true",
    TWILIO_DAILY_SMS_LIMIT: "20",
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
    const sid = `SM${"a".repeat(32)}`;
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
  it("selects twilioSmsProvider only when the full launch gate is enabled", async () => {
    stubTwilioEnv();
    vi.resetModules();
    const fresh = await import("./providers");
    expect(fresh.providers.sms).toBe(fresh.twilioSmsProvider);
  });

  it("falls back to mockSmsProvider when no Twilio account is configured", async () => {
    stubTwilioEnv();
    vi.stubEnv("TWILIO_ACCOUNT_SID", "");
    vi.resetModules();
    const fresh = await import("./providers");
    expect(fresh.providers.sms).toBe(fresh.mockSmsProvider);
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
    // Default in this test env: providers.sms is the mock.
    expect(providers.sms).toBe(mockSmsProvider);
    const res = await providers.sms.send("+15551112222", "mock check");
    expect(res.provider).toBe("mock-sms");
    expect(calls).toHaveLength(0);
  });
});
