import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { db, organizationsTable, orgSettingsTable, contactsTable, consentRecordsTable, twilioClientBindingsTable, twilioConsentProofsTable, twilioDispatchesTable } from "@workspace/db";
import { contactTouchReservationsTable as touches } from "../../../../lib/db/src/schema/contact-touch-reservations";
import { touchAddress } from "./contact-touch-claim";
import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";
import { syntheticTwilioNumber } from "../test-helpers/synthetic-twilio";
import { sendTwilioSms } from "./twilio-delivery";
import { SMS_DISCLOSURE_VERSION } from "./twilio-controls";

const carrier = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock("./sms-carrier-transport", async original => {
  const actual = await original<typeof import("./sms-carrier-transport")>();
  return { ...actual, postSmsOnce: carrier.post.mockImplementation(actual.postSmsOnce) };
});

let org: string, contact: string;
const phone = "+15005550006";
const provider = vi.fn<typeof fetch>();
const context = (key = randomUUID()) => ({ organizationId: org, contactId: contact, purpose: "customer_care" as const, idempotencyKey: key });
beforeEach(async () => {
  carrier.post.mockClear();
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
    vi.stubEnv("GROWTHOS_OUTBOUND_HOLD", "false");
    await expect(sendTwilioSms(phone, "Your requested callback", operation)).rejects.toThrow();
    expect(provider).not.toHaveBeenCalled();
    expect((await db.select().from(twilioDispatchesTable).where(eq(twilioDispatchesTable.organizationId, org))).map(saved => saved.id)).toEqual([row.id]);
  });

  it("checks the workflow only for the owner and does not repeat an accepted SMS", async () => {
    const operation = context(); const guard = vi.fn(async () => undefined);
    const first = await sendTwilioSms(phone, "Your requested callback", operation, guard);
    const replay = await sendTwilioSms(phone, "Your requested callback", operation, guard);
    expect(replay).toEqual(first); expect(guard).toHaveBeenCalledOnce(); expect(provider).toHaveBeenCalledOnce();
    expect(carrier.post).toHaveBeenCalledOnce();
    expect(provider.mock.calls[0][1]).toMatchObject({ method: "POST", redirect: "error" });
    const form = new URLSearchParams(String(provider.mock.calls[0][1]?.body));
    expect([...form.keys()]).toEqual(["To", "MessagingServiceSid", "Body", "StatusCallback"]);
    expect(form.get("Body")).toBe("Synthetic Contractor: Your requested callback\nReply STOP to opt out. HELP for help.");
    const [saved] = await db.select().from(twilioDispatchesTable).where(eq(twilioDispatchesTable.organizationId, org));
    expect(form.get("StatusCallback")).toBe(`https://synthetic.example.invalid/api/v1/public/sms/status?operation=${saved.id}`);
  });

  it("keeps a lost acknowledgement uncertain and prevents a retry", async () => {
    provider.mockRejectedValueOnce(new Error("Synthetic timeout after network handoff"));
    const operation = context();
    await expect(sendTwilioSms(phone, "Your requested callback", operation)).rejects.toThrow();
    await expect(sendTwilioSms(phone, "Your requested callback", operation)).rejects.toThrow(/uncertain/);
    expect(provider).toHaveBeenCalledOnce();
  });

  it.each([
    { kind: "429", status: "rate_limited", error: /Twilio send failed: 429/ },
    { kind: "503", status: "uncertain", error: /Twilio send failed: 503/ },
    { kind: "malformed201", status: "uncertain", error: /JSON|Unexpected/ },
    { kind: "missingSid", status: "uncertain", error: /no valid message SID/ },
  ])("retains the normal $kind rejection and original $status claim", async ({ kind, status, error }) => {
    const response = kind === "malformed201" ? new Response("not json", { status: 201 }) : kind === "missingSid" ? Response.json({}, { status: 201 }) : Response.json({ code: Number(kind) }, { status: Number(kind) });
    provider.mockResolvedValueOnce(response);
    const operation = context();
    await expect(sendTwilioSms(phone, "Your requested callback", operation)).rejects.toThrow(error);
    const [owned] = await db.select().from(twilioDispatchesTable).where(eq(twilioDispatchesTable.organizationId, org));
    expect(owned).toMatchObject({ status, providerSid: null, idempotencyKey: operation.idempotencyKey });
    await expect(sendTwilioSms(phone, "Your requested callback", operation)).rejects.toThrow(status);
    expect(provider).toHaveBeenCalledOnce();
    expect((await db.select().from(twilioDispatchesTable).where(eq(twilioDispatchesTable.organizationId, org))).map(row => row.id)).toEqual([owned.id]);
  });

  it("keeps a normal accepted network effect uncertain after final storage fails", async () => {
    const suffix = randomUUID().replaceAll("-", ""), functionName = `normal_fail_${suffix}`, triggerName = `normal_fail_${suffix}`;
    await db.execute(sql.raw(`CREATE FUNCTION "${functionName}"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic normal final storage outage'; END $$`));
    try {
      await db.execute(sql.raw(`CREATE TRIGGER "${triggerName}" BEFORE UPDATE ON twilio_dispatches FOR EACH ROW WHEN (NEW.status = 'accepted' AND NEW.organization_id = '${org}'::uuid) EXECUTE FUNCTION "${functionName}"()`));
      const operation = context();
      await expect(sendTwilioSms(phone, "Your requested callback", operation)).rejects.toThrow();
      const [owned] = await db.select().from(twilioDispatchesTable).where(eq(twilioDispatchesTable.organizationId, org));
      expect(owned).toMatchObject({ status: "uncertain", providerSid: null });
      await expect(sendTwilioSms(phone, "Your requested callback", operation)).rejects.toThrow(/uncertain/);
      expect(provider).toHaveBeenCalledOnce();
      expect((await db.select().from(twilioDispatchesTable).where(eq(twilioDispatchesTable.organizationId, org))).map(row => row.id)).toEqual([owned.id]);
    } finally {
      await db.execute(sql.raw(`DROP TRIGGER IF EXISTS "${triggerName}" ON twilio_dispatches`));
      await db.execute(sql.raw(`DROP FUNCTION "${functionName}"()`));
    }
  });

  it.each([false, true])("preserves contact-touch authority and dispatch evidence when claim changed=%s", async changed => {
    await db.insert(orgSettingsTable).values({ organizationId: org, sendingHours: { quietHoursEnabled: false, maxTouchesPerDay: 20 } });
    const logicalKey = `scheduled:${randomUUID()}`, payloadHash = "a".repeat(64);
    const [touch] = await db.insert(touches).values({ organizationId: org, contactId: contact, logicalKey, payloadHash, sourceKind: "service", channel: "sms", address: touchAddress("sms", phone) }).returning();
    const operation = { ...context(), contactTouch: { logicalKey, payloadHash: changed ? "b".repeat(64) : payloadHash } };
    if (changed) {
      await expect(sendTwilioSms(phone, "Your requested callback", operation)).rejects.toThrow("touch_claim_changed");
      expect(provider).not.toHaveBeenCalled();
      expect((await db.select().from(touches).where(eq(touches.id, touch.id)))[0]).toEqual(touch);
      expect((await db.select().from(twilioDispatchesTable).where(eq(twilioDispatchesTable.organizationId, org)))[0]).toMatchObject({ status: "cancelled" });
    } else {
      provider.mockImplementationOnce(async () => {
        expect((await db.select().from(touches).where(eq(touches.id, touch.id)))[0].dispatchStartedAt).toBeTruthy();
        return Response.json({ sid: `SM${"4".repeat(32)}` }, { status: 201 });
      });
      await expect(sendTwilioSms(phone, "Your requested callback", operation)).resolves.toMatchObject({ provider: "twilio" });
      expect(provider).toHaveBeenCalledOnce();
    }
  });
});
