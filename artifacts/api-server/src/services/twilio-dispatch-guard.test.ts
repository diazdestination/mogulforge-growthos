import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { db, organizationsTable, contactsTable, consentRecordsTable, twilioClientBindingsTable, twilioConsentProofsTable, twilioDispatchesTable } from "@workspace/db";
import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";
import { syntheticTwilioNumber } from "../test-helpers/synthetic-twilio";
import { sendTwilioSms } from "./twilio-delivery";
import { SMS_DISCLOSURE_VERSION } from "./twilio-controls";

let org: string, contact: string;
const phone = "+15005550006";
const provider = vi.fn<typeof fetch>();
const context = (key = randomUUID()) => ({ organizationId: org, contactId: contact, purpose: "customer_care" as const, idempotencyKey: key });
beforeEach(async () => {
  vi.stubEnv("GROWTHOS_OUTBOUND_HOLD", "false");
  vi.stubEnv("TWILIO_CLIENT_DISPATCH_GUARD_AUTH_TOKEN", "synthetic-webhook");
  vi.stubEnv("TWILIO_CLIENT_DISPATCH_GUARD_API_KEY_SECRET", "synthetic-secret");
  provider.mockReset().mockResolvedValue(new Response(JSON.stringify({ sid: `SM${"4".repeat(32)}` }), { status: 201 }));
  vi.stubGlobal("fetch", provider);
  const [company] = await db.insert(organizationsTable).values({ name: "Dispatch guard synthetic", slug: `dispatch-guard-${randomUUID()}` }).returning();
  org = company.id;
  const [person] = await db.insert(contactsTable).values({ organizationId: org, firstName: "Synthetic", phone }).returning();
  contact = person.id;
  await db.insert(twilioClientBindingsTable).values({
    organizationId: org, accountSid: `AC${randomUUID().replaceAll("-", "")}`, phoneNumber: syntheticTwilioNumber(),
    messagingServiceSid: `MG${"2".repeat(32)}`, apiKeySid: `SK${"3".repeat(32)}`,
    authTokenSecretRef: "TWILIO_CLIENT_DISPATCH_GUARD_AUTH_TOKEN", apiKeySecretRef: "TWILIO_CLIENT_DISPATCH_GUARD_API_KEY_SECRET",
    publicOrigin: "https://synthetic.example.invalid", businessName: "Synthetic Contractor",
    smsDisclosureVersion: SMS_DISCLOSURE_VERSION, dailySmsLimit: 20,
    launchApproved: true, smsEnabled: true, registrationApproved: true, advancedOptOut: true, geoPermissionsReviewed: true,
  });
  await db.insert(consentRecordsTable).values({ organizationId: org, contactId: contact, channel: "sms", granted: true, disclosureVersion: SMS_DISCLOSURE_VERSION });
  await db.insert(twilioConsentProofsTable).values({ organizationId: org, contactId: contact, phone, purpose: "customer_care", granted: true, disclosureVersion: SMS_DISCLOSURE_VERSION, source: "synthetic guarded test" });
});
afterEach(async () => {
  await deleteTestOrgs(org);
  vi.unstubAllGlobals(); vi.unstubAllEnvs();
});

describe("last-moment Twilio dispatch guards", () => {
  it.each(["contact_dnc", "phone", "purpose", "program", "hold", "workflow"] as const)("does not contact Twilio when %s changes after ownership", async (change) => {
    const operation = context();
    await expect(sendTwilioSms(phone, "Your requested callback", operation, async () => {
      if (change === "contact_dnc") await db.update(contactsTable).set({ doNotContactSms: true }).where(eq(contactsTable.id, contact));
      if (change === "phone") await db.update(contactsTable).set({ phone: "+15005550007" }).where(eq(contactsTable.id, contact));
      if (change === "purpose") await db.update(twilioConsentProofsTable).set({ granted: false }).where(eq(twilioConsentProofsTable.organizationId, org));
      if (change === "program") await db.update(twilioClientBindingsTable).set({ smsDisclosureVersion: "unreviewed-version" }).where(eq(twilioClientBindingsTable.organizationId, org));
      if (change === "hold") vi.stubEnv("GROWTHOS_OUTBOUND_HOLD", "true");
      if (change === "workflow") throw new Error("Approval withdrawn");
    })).rejects.toThrow();
    expect(provider).not.toHaveBeenCalled();
    const [row] = await db.select().from(twilioDispatchesTable).where(and(eq(twilioDispatchesTable.organizationId, org), eq(twilioDispatchesTable.idempotencyKey, operation.idempotencyKey)));
    expect(row.status).toBe("cancelled"); expect(row.providerSid).toBeNull();
  });

  it("checks the workflow only for the owner and does not repeat an accepted SMS", async () => {
    const operation = context(); const guard = vi.fn(async () => undefined);
    const first = await sendTwilioSms(phone, "Your requested callback", operation, guard);
    const replay = await sendTwilioSms(phone, "Your requested callback", operation, guard);
    expect(replay).toEqual(first); expect(guard).toHaveBeenCalledOnce(); expect(provider).toHaveBeenCalledOnce();
    expect(provider.mock.calls[0][1]).toMatchObject({ method: "POST", redirect: "error" });
  });

  it("keeps a lost acknowledgement uncertain and prevents a retry", async () => {
    provider.mockRejectedValueOnce(new Error("Synthetic timeout after network handoff"));
    const operation = context();
    await expect(sendTwilioSms(phone, "Your requested callback", operation)).rejects.toThrow();
    await expect(sendTwilioSms(phone, "Your requested callback", operation)).rejects.toThrow(/uncertain/);
    expect(provider).toHaveBeenCalledOnce();
  });
});
