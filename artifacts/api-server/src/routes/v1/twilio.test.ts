import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { getExpectedTwilioSignature } from "twilio";
import { and, eq } from "drizzle-orm";
import {
  db,
  organizationsTable,
  usersTable,
  contactsTable,
  consentRecordsTable,
  twilioClientBindingsTable,
  twilioDispatchesTable,
  twilioConsentProofsTable,
  twilioInboundEventsTable,
  twilioCallsTable,
  missedCallHandoffsTable,
  crmTasksTable,
  leadsTable,
} from "@workspace/db";
import app from "../../app";
import { createSession } from "../../lib/auth";
import { deleteTestOrgs } from "../../test-helpers/delete-test-orgs";
import { sendTwilioSms } from "../../services/twilio-delivery";
import {
  SMS_DISCLOSURE_VERSION,
  twilioForOrganization,
} from "../../services/twilio-controls";
import { getSuppression } from "../../services/send-gate";
import { voiceConfiguration } from "./twilio-voice";

let server: Server,
  base: string,
  orgA: string,
  orgB: string,
  contactA: string,
  contactB: string,
  sessionA: string,
  sessionB: string;
let sends = 0,
  sendsB = 0,
  voiceSends = 0,
  serial = 0,
  mode = "ok";
const realFetch = globalThis.fetch;
const account = "AC" + "1".repeat(32),
  accountB = "AC" + "4".repeat(32),
  service = "MG" + "2".repeat(32),
  serviceB = "MG" + "5".repeat(32),
  sender = "+15005550006",
  senderB = "+15005550007",
  phone = "+12025550101",
  token = "synthetic-webhook-token",
  tokenB = "synthetic-webhook-token-b",
  program = "synthetic_twilio_program_a_12345",
  programB = "synthetic_twilio_program_b_12345";
async function webhook(
  path: string,
  fields: Record<string, string>,
  signed = true,
) {
  const params: Record<string, string> = {
    AccountSid: account,
    MessagingServiceSid: service,
    From: phone,
    To: sender,
    MessageSid: "SM" + (++serial).toString(16).padStart(32, "0"),
    ...fields,
  };
  if (path.includes("/public/voice/")) delete params.MessagingServiceSid;
  return realFetch(base + path, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-twilio-signature": signed
        ? getExpectedTwilioSignature(
            params.AccountSid === accountB ? tokenB : token,
            "https://growth.example" + path,
            params,
          )
        : "bad",
    },
    body: new URLSearchParams(params),
  });
}
const context = (key: string) => ({
  organizationId: orgA,
  contactId: contactA,
  purpose: "customer_care" as const,
  idempotencyKey: key,
});
beforeAll(async () => {
  for (const letter of ["a", "b"]) {
    const [org] = await db
      .insert(organizationsTable)
      .values({
        name: `Synthetic Twilio ${letter}`,
        slug: `test-twilio-${letter}-${randomUUID()}`,
      })
      .returning();
    const [user] = await db
      .insert(usersTable)
      .values({
        organizationId: org.id,
        email: `${randomUUID()}@example.test`,
        role: "admin",
      })
      .returning();
    const [contact] = await db
      .insert(contactsTable)
      .values({ organizationId: org.id, firstName: "Synthetic", phone })
      .returning();
    const session = await createSession({
      user: {
        id: user.id,
        email: null,
        firstName: null,
        lastName: null,
        profileImageUrl: null,
      },
      access_token: "test",
      expires_at: Math.floor(Date.now() / 1000) + 3600,
    });
    if (letter === "a") {
      orgA = org.id;
      contactA = contact.id;
      sessionA = session;
    } else {
      orgB = org.id;
      contactB = contact.id;
      sessionB = session;
    }
  }
  const values = {
    APP_ORIGIN: "https://growth.example",
    TWILIO_CLIENT_A_AUTH_TOKEN: token,
    TWILIO_CLIENT_A_API_KEY_SECRET: "synthetic-key",
    TWILIO_CLIENT_B_AUTH_TOKEN: tokenB,
    TWILIO_CLIENT_B_API_KEY_SECRET: "synthetic-key-b",
    TWILIO_CLIENT_A_SMS_PRIVACY_URL: "https://roofing.example.test/privacy",
    TWILIO_CLIENT_A_SMS_TERMS_URL: "https://roofing.example.test/messaging-terms",
    TWILIO_CLIENT_B_SMS_PRIVACY_URL: "https://hvac.example.test/privacy",
    TWILIO_CLIENT_B_SMS_TERMS_URL: "https://hvac.example.test/messaging-terms",
  };
  for (const [key, value] of Object.entries(values)) vi.stubEnv(key, value);
  await db.insert(twilioClientBindingsTable).values([
    {
      organizationId: orgA, accountSid: account, phoneNumber: sender,
      messagingServiceSid: service, apiKeySid: "SK" + "3".repeat(32),
      authTokenSecretRef: "TWILIO_CLIENT_A_AUTH_TOKEN",
      apiKeySecretRef: "TWILIO_CLIENT_A_API_KEY_SECRET",
      publicOrigin: "https://growth.example", businessName: "Synthetic & Roofing",
      staffPhone: "+12025550109", smsDisclosureVersion: SMS_DISCLOSURE_VERSION,
      publicEnrollmentToken: program, dailySmsLimit: 20, dailyCallLimit: 5,
      launchApproved: true, smsEnabled: true, registrationApproved: true,
      advancedOptOut: true, geoPermissionsReviewed: true,
    },
    {
      organizationId: orgB, accountSid: accountB, phoneNumber: senderB,
      messagingServiceSid: serviceB, apiKeySid: "SK" + "6".repeat(32),
      authTokenSecretRef: "TWILIO_CLIENT_B_AUTH_TOKEN",
      apiKeySecretRef: "TWILIO_CLIENT_B_API_KEY_SECRET",
      publicOrigin: "https://growth.example", businessName: "Synthetic HVAC",
      staffPhone: "+12025550119", smsDisclosureVersion: "synthetic-hvac-v1",
      publicEnrollmentToken: programB,
      dailySmsLimit: 20, dailyCallLimit: 5,
    },
  ]);
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  vi.stubGlobal(
    "fetch",
    async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (String(url).startsWith(base + "/")) return realFetch(url, init);
      if (
        String(url) ===
        `https://api.twilio.com/2010-04-01/Accounts/${account}/Calls.json`
      ) {
        voiceSends++;
        const params = new URLSearchParams(String(init?.body));
        expect(params.get("To")).toBe("+12025550109");
        expect(params.get("Record")).toBe("false");
        expect(params.get("TimeLimit")).toBe("300");
        if (mode === "timeout") throw new Error("Synthetic voice timeout");
        return Response.json(
          { sid: "CA" + (1000 + voiceSends).toString(16).padStart(32, "0") },
          { status: 201 },
        );
      }
      if (String(url) === `https://api.twilio.com/2010-04-01/Accounts/${accountB}/Messages.json`) {
        sendsB++;
        const params = new URLSearchParams(String(init?.body));
        expect(params.get("MessagingServiceSid")).toBe(serviceB);
        expect(params.get("Body")).toContain("Synthetic HVAC:");
        return Response.json(
          { sid: "SM" + (5000 + sendsB).toString(16).padStart(32, "0") },
          { status: 201 },
        );
      }
      expect(String(url)).toBe(
        `https://api.twilio.com/2010-04-01/Accounts/${account}/Messages.json`,
      );
      sends++;
      const params = new URLSearchParams(String(init?.body));
      expect(params.get("MessagingServiceSid")).toBe(service);
      expect(params.get("Body")).toContain("Reply STOP");
      expect(params.get("StatusCallback")).toMatch(
        /^https:\/\/growth.example\/api\/v1\/public\/sms\/status\?operation=/,
      );
      if (mode === "timeout") throw new Error("Synthetic network timeout");
      if (mode === "429")
        return Response.json({ code: 20429 }, { status: 429 });
      return Response.json(
        { sid: "SM" + (1000 + sends).toString(16).padStart(32, "0") },
        { status: 201 },
      );
    },
  );
});
afterAll(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  await deleteTestOrgs(orgA, orgB);
});

it("requires authentication and rejects forged, wrong-account and wrong-service callbacks", async () => {
  expect((await realFetch(base + "/api/v1/communications/sms")).status).toBe(
    401,
  );
  expect(
    (await webhook("/api/v1/public/sms/inbound", { Body: "STOP" }, false))
      .status,
  ).toBe(403);
  expect(
    (
      await webhook("/api/v1/public/sms/inbound", {
        Body: "STOP",
        AccountSid: "AC" + "9".repeat(32),
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await webhook("/api/v1/public/sms/inbound", {
        Body: "STOP",
        MessagingServiceSid: "MG" + "9".repeat(32),
      })
    ).status,
  ).toBe(403);
  vi.stubEnv("TWILIO_CLIENT_A_AUTH_TOKEN", "");
  expect(
    (await webhook("/api/v1/public/sms/inbound", { Body: "STOP" })).status,
  ).toBe(403);
  vi.stubEnv("TWILIO_CLIENT_A_AUTH_TOKEN", token);
});
it("keeps enrollment closed without client policies while STOP and HELP remain available", async () => {
  vi.stubEnv("TWILIO_CLIENT_A_SMS_PRIVACY_URL", "");
  vi.stubEnv("TWILIO_CLIENT_A_SMS_TERMS_URL", "");
  try {
    const status = await realFetch(base + `/api/v1/public/sms/program?program=${program}`);
    const body = await status.json() as { brand: string; available: boolean; sender: string; privacyUrl: null; termsUrl: null };
    expect(status.headers.get("cache-control")).toBe("no-store");
    expect(body).toMatchObject({ brand: "Synthetic & Roofing", available: false, sender, privacyUrl: null, termsUrl: null });
    const enroll = await realFetch(base + `/api/v1/public/sms/enroll?program=${program}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
        phone, customerCare: true, appointments: false, ownPhone: true,
        disclosureVersion: SMS_DISCLOSURE_VERSION,
      }),
    });
    expect(enroll.status).toBe(503);
    const priorRecipient = "+12025550103";
    expect((await webhook("/api/v1/public/sms/inbound", { Body: "STOP", From: priorRecipient })).status).toBe(200);
    expect(await getSuppression(orgA, "sms", priorRecipient)).not.toBeNull();
    expect((await webhook("/api/v1/public/sms/inbound", { Body: "HELP", From: priorRecipient })).status).toBe(200);
    const help = await db.select().from(twilioInboundEventsTable)
      .where(and(eq(twilioInboundEventsTable.organizationId, orgA), eq(twilioInboundEventsTable.phone, priorRecipient)));
    expect(help.some((event) => event.eventType === "HELP")).toBe(true);
    vi.stubEnv("TWILIO_CLIENT_A_SMS_PRIVACY_URL", "http://roofing.example.test/privacy");
    expect(await (await realFetch(base + `/api/v1/public/sms/program?program=${program}`)).json())
      .toMatchObject({ available: false });
  } finally {
    vi.stubEnv("TWILIO_CLIENT_A_SMS_PRIVACY_URL", "https://roofing.example.test/privacy");
    vi.stubEnv("TWILIO_CLIENT_A_SMS_TERMS_URL", "https://roofing.example.test/messaging-terms");
  }
});
it("resolves only the selected contractor program and rejects wrong tokens and phones", async () => {
  const [originalB] = await db.select().from(twilioClientBindingsTable)
    .where(eq(twilioClientBindingsTable.organizationId, orgB));
  await db.update(twilioClientBindingsTable).set({
    launchApproved: true, smsEnabled: true, registrationApproved: true,
    advancedOptOut: true, geoPermissionsReviewed: true,
  }).where(eq(twilioClientBindingsTable.organizationId, orgB));
  try {
    const roofing = await (await realFetch(base + `/api/v1/public/sms/program?program=${program}`)).json() as Record<string, unknown>;
    const hvac = await (await realFetch(base + `/api/v1/public/sms/program?program=${programB}`)).json() as Record<string, unknown>;
    expect(roofing).toMatchObject({
      brand: "Synthetic & Roofing", sender, available: true,
      privacyUrl: "https://roofing.example.test/privacy",
      termsUrl: "https://roofing.example.test/messaging-terms",
    });
    expect(hvac).toMatchObject({
      brand: "Synthetic HVAC", sender: senderB, available: true,
      privacyUrl: "https://hvac.example.test/privacy",
      termsUrl: "https://hvac.example.test/messaging-terms",
    });
    expect(await (await realFetch(base + "/api/v1/public/sms/program")).json()).toMatchObject({ available: false, brand: null });
    expect(await (await realFetch(base + "/api/v1/public/sms/program?program=invalid-program-token-1234567")).json()).toMatchObject({ available: false, brand: null });
    const invalidPhone = await realFetch(base + `/api/v1/public/sms/enroll?program=${programB}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
        phone: "+10000000000", customerCare: true, appointments: true, ownPhone: true,
        disclosureVersion: "synthetic-hvac-v1",
      }),
    });
    expect(invalidPhone.status).toBe(400);
    const wrongToken = await realFetch(base + "/api/v1/public/sms/enroll?program=invalid-program-token-1234567", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
        phone, customerCare: true, appointments: false, ownPhone: true,
        disclosureVersion: SMS_DISCLOSURE_VERSION,
      }),
    });
    expect(wrongToken.status).toBe(503);
  } finally {
    await db.update(twilioClientBindingsTable).set({
      launchApproved: originalB.launchApproved, smsEnabled: originalB.smsEnabled,
      registrationApproved: originalB.registrationApproved,
      advancedOptOut: originalB.advancedOptOut,
      geoPermissionsReviewed: originalB.geoPermissionsReviewed,
    }).where(eq(twilioClientBindingsTable.organizationId, orgB));
  }
});
it("records no consent until the correct handset confirms the optional purposes", async () => {
  await expect(
    sendTwilioSms(phone, "Hello", context("before-consent")),
  ).rejects.toThrow(/consent/);
  const response = await realFetch(base + `/api/v1/public/sms/enroll?program=${program}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      phone,
      customerCare: true,
      appointments: false,
      ownPhone: true,
      disclosureVersion: SMS_DISCLOSURE_VERSION,
    }),
  });
  expect(response.status).toBe(200);
  const form = (await response.json()) as { verificationText: string };
  await webhook("/api/v1/public/sms/inbound", {
    Body: form.verificationText,
    From: "+12025550102",
  });
  expect((await db.select().from(twilioConsentProofsTable)).length).toBe(0);
  const proofSid = "SM" + "a".repeat(32);
  await webhook("/api/v1/public/sms/inbound", {
    Body: form.verificationText,
    MessageSid: proofSid,
  });
  await webhook("/api/v1/public/sms/inbound", {
    Body: form.verificationText,
    MessageSid: proofSid,
  });
  const proofs = await db.select().from(twilioConsentProofsTable);
  expect(proofs).toHaveLength(2);
  expect(
    proofs.every((p) => p.organizationId === orgA && p.contactId === contactA),
  ).toBe(true);
  await expect(
    sendTwilioSms(phone, "Appointment", {
      ...context("purpose"),
      purpose: "appointments",
    }),
  ).rejects.toThrow(/consent/);
  await expect(
    sendTwilioSms(phone, "Cross tenant", {
      ...context("other"),
      organizationId: orgB,
      contactId: contactB,
    }),
  ).rejects.toThrow(/disabled/);
});
it("sends one provider request for a stable operation and binds monotonic status to the recipient", async () => {
  const first = await sendTwilioSms(phone, "Hello", context("one"));
  expect(await sendTwilioSms(phone, "Hello", context("one"))).toEqual(first);
  expect(sends).toBe(1);
  await expect(sendTwilioSms(phone, "Changed", context("one"))).rejects.toThrow(
    /different content/,
  );
  const [op] = await db
    .select()
    .from(twilioDispatchesTable)
    .where(eq(twilioDispatchesTable.idempotencyKey, "one"));
  expect(
    (
      await webhook(`/api/v1/public/sms/status?operation=${op.id}`, {
        From: sender,
        To: "+12025550102",
        MessageSid: first.id,
        MessageStatus: "delivered",
      })
    ).status,
  ).toBe(404);
  await webhook(`/api/v1/public/sms/status?operation=${op.id}`, {
    From: sender,
    To: phone,
    MessageSid: first.id,
    MessageStatus: "delivered",
  });
  await webhook(`/api/v1/public/sms/status?operation=${op.id}`, {
    From: sender,
    To: phone,
    MessageSid: first.id,
    MessageStatus: "sent",
  });
  const [updated] = await db
    .select()
    .from(twilioDispatchesTable)
    .where(eq(twilioDispatchesTable.id, op.id));
  expect(updated.status).toBe("delivered");
});
it("authorizes own-org replies, hides other-org receipts and refuses cross-origin writes", async () => {
  const list = await realFetch(base + "/api/v1/communications/sms", {
    headers: { authorization: `Bearer ${sessionB}` },
  });
  expect(list.status).toBe(200);
  const empty = (await list.json()) as {
    inbound: unknown[];
    outbound: unknown[];
  };
  expect(empty.inbound).toEqual([]);
  expect(empty.outbound).toEqual([]);
  const reply = {
    contactId: contactB,
    body: "Do not send",
    requestId: randomUUID(),
  };
  expect(
    (
      await realFetch(base + "/api/v1/communications/sms", {
        method: "POST",
        headers: {
          authorization: `Bearer ${sessionA}`,
          "content-type": "application/json",
          origin: "https://growth.example",
        },
        body: JSON.stringify(reply),
      })
    ).status,
  ).toBe(404);
  expect(
    (
      await realFetch(base + "/api/v1/communications/sms", {
        method: "POST",
        headers: {
          authorization: `Bearer ${sessionA}`,
          "content-type": "application/json",
          origin: "https://wrong.example",
        },
        body: JSON.stringify({ ...reply, contactId: contactA }),
      })
    ).status,
  ).toBe(403);
});
it("never blindly retries uncertain or rate-limited sends and blocks changed phone numbers", async () => {
  mode = "timeout";
  await expect(
    sendTwilioSms(phone, "Timeout", context("timeout")),
  ).rejects.toThrow();
  const attempted = sends;
  await expect(
    sendTwilioSms(phone, "Timeout", context("timeout")),
  ).rejects.toThrow(/uncertain/);
  expect(sends).toBe(attempted);
  mode = "429";
  await expect(
    sendTwilioSms(phone, "Limited", context("rate")),
  ).rejects.toThrow(/429/);
  const limited = sends;
  await expect(
    sendTwilioSms(phone, "Limited", context("rate")),
  ).rejects.toThrow(/rate_limited/);
  expect(sends).toBe(limited);
  mode = "ok";
  await db
    .update(contactsTable)
    .set({ phone: "+12025550103" })
    .where(eq(contactsTable.id, contactA));
  await expect(
    sendTwilioSms("+12025550103", "Changed", context("changed")),
  ).rejects.toThrow(/consent/);
  await db
    .update(contactsTable)
    .set({ phone })
    .where(eq(contactsTable.id, contactA));
});
it("applies STOP only to the routed organization and START does not restore old purposes", async () => {
  await webhook("/api/v1/public/sms/inbound", { Body: "STOP" });
  expect(await getSuppression(orgA, "sms", phone)).not.toBeNull();
  expect(await getSuppression(orgB, "sms", phone)).toBeNull();
  const [other] = await db
    .select()
    .from(contactsTable)
    .where(eq(contactsTable.id, contactB));
  expect(other.doNotContactSms).toBe(false);
  await expect(
    sendTwilioSms(phone, "Stopped", context("stop")),
  ).rejects.toThrow();
  await webhook("/api/v1/public/sms/inbound", { Body: "START" });
  expect(await getSuppression(orgA, "sms", phone)).toBeNull();
  await expect(
    sendTwilioSms(phone, "Start alone", context("start")),
  ).rejects.toThrow(/consent/);
  const [own] = await db
    .select()
    .from(contactsTable)
    .where(
      and(
        eq(contactsTable.id, contactA),
        eq(contactsTable.organizationId, orgA),
      ),
    );
  expect(own.doNotContactSms).toBe(true);
});

it("blocks staff-requested calls before provider dispatch while staging is held", async () => {
  const beforeVoice = voiceSends;
  const requestId = randomUUID();
  const previousHold = process.env.GROWTHOS_OUTBOUND_HOLD;
  vi.stubEnv("GROWTHOS_OUTBOUND_HOLD", "true");
  try {
    const response = await realFetch(base + "/api/v1/communications/voice", {
      method: "POST",
      headers: {
        authorization: `Bearer ${sessionA}`,
        origin: "https://growth.example",
        "content-type": "application/json",
        "x-forwarded-for": "192.0.2.89",
      },
      body: JSON.stringify({ contactId: contactA, requestId, requestedByContact: true }),
    });
    expect(response.status).toBe(503);
    expect(voiceSends).toBe(beforeVoice);
    const existing = await db.select({ id: twilioCallsTable.id }).from(twilioCallsTable)
      .where(eq(twilioCallsTable.requestKey, requestId));
    expect(existing).toHaveLength(0);
  } finally {
    vi.stubEnv("GROWTHOS_OUTBOUND_HOLD", previousHold);
  }
});

it("gates calls, starts only one staff leg, binds callbacks and prevents replaying the customer leg", async () => {
  let testIp = "192.0.2.90";
  const makeCall = (
    requestId: string,
    session = sessionA,
    contactId = contactA,
  ) =>
    realFetch(base + "/api/v1/communications/voice", {
      method: "POST",
      headers: {
        authorization: `Bearer ${session}`,
        origin: "https://growth.example",
        "content-type": "application/json",
        "x-forwarded-for": testIp,
      },
      body: JSON.stringify({ contactId, requestId, requestedByContact: true }),
    });
  expect((await makeCall(randomUUID())).status).toBe(409);
  expect(voiceSends).toBe(0);
  await db.update(twilioClientBindingsTable)
    .set({ voiceEnabled: true, voiceApproved: true })
    .where(eq(twilioClientBindingsTable.organizationId, orgA));
  expect((await makeCall(randomUUID(), sessionB, contactB)).status).toBe(409);
  const key = randomUUID(),
    started = await makeCall(key);
  expect(started.status).toBe(202);
  const op = (await started.json()) as { id: string };
  expect((await makeCall(key)).status).toBe(200);
  expect(voiceSends).toBe(1);
  const [record] = await db
    .select()
    .from(twilioCallsTable)
    .where(eq(twilioCallsTable.id, op.id));
  const fields = {
    From: sender,
    To: "+12025550109",
    CallSid: record.providerSid!,
  };
  expect(
    (
      await webhook(
        `/api/v1/public/voice/answer?operation=${op.id}`,
        fields,
        false,
      )
    ).status,
  ).toBe(403);
  const answer = await webhook(
    `/api/v1/public/voice/answer?operation=${op.id}`,
    fields,
  );
  const answerXml = await answer.text();
  expect(answerXml).toContain("<Gather");
  expect(answerXml).toContain("Synthetic &amp; Roofing");
  expect(answerXml).not.toContain("MogulForge");
  const dial = await webhook(
    `/api/v1/public/voice/connect?operation=${op.id}`,
    { ...fields, Digits: "1" },
  );
  const xml = await dial.text();
  expect(xml).toContain(phone);
  expect(xml).toContain('record="do-not-record"');
  expect(xml).not.toContain("<Record");
  const replay = await webhook(
    `/api/v1/public/voice/connect?operation=${op.id}`,
    { ...fields, Digits: "1" },
  );
  expect(await replay.text()).not.toContain("<Dial");
  await webhook(`/api/v1/public/voice/status?operation=${op.id}`, {
    ...fields,
    CallStatus: "completed",
  });
  await webhook(`/api/v1/public/voice/status?operation=${op.id}`, {
    ...fields,
    CallStatus: "ringing",
  });
  const [done] = await db
    .select()
    .from(twilioCallsTable)
    .where(eq(twilioCallsTable.id, op.id));
  expect(done.status).toBe("completed");
  testIp = "192.0.2.91";
  mode = "timeout";
  const timeoutKey = randomUUID();
  expect((await makeCall(timeoutKey)).status).toBe(409);
  const count = voiceSends;
  expect((await makeCall(timeoutKey)).status).toBe(409);
  expect(voiceSends).toBe(count);
  mode = "ok";
});

it("routes an inbound call only to the configured staff phone and records a missed call without SMS", async () => {
  const fields = { From: phone, To: sender, CallSid: "CA" + "a".repeat(32) },
    before = sends;
  const incoming = await webhook("/api/v1/public/voice/inbound", fields);
  expect(incoming.status).toBe(200);
  const incomingXml = await incoming.text();
  expect(incomingXml).toContain("+12025550109");
  expect(incomingXml).toContain("Synthetic &amp; Roofing");
  expect(incomingXml).not.toContain("MogulForge");
  const [op] = await db
    .select()
    .from(twilioCallsTable)
    .where(eq(twilioCallsTable.providerSid, fields.CallSid));
  expect(op.organizationId).toBe(orgA);
  expect(op.contactId).toBe(contactA);
  const complete = await webhook(
    `/api/v1/public/voice/complete?operation=${op.id}`,
    {
      ...fields,
      DialCallStatus: "no-answer",
    },
  );
  const completeXml = await complete.text();
  expect(completeXml).toContain("Please try again later");
  expect(completeXml).not.toMatch(/mogulforge/i);
  await webhook("/api/v1/public/voice/status", {
    ...fields,
    CallStatus: "completed",
  });
  const [missed] = await db
    .select()
    .from(twilioCallsTable)
    .where(eq(twilioCallsTable.id, op.id));
  expect(missed.dialStatus).toBe("no-answer");
  expect(missed.status).toBe("completed");
  const [handoff] = await db
    .select()
    .from(missedCallHandoffsTable)
    .where(eq(missedCallHandoffsTable.callId, op.id));
  expect(handoff.organizationId).toBe(orgA);
  const [task] = await db
    .select()
    .from(crmTasksTable)
    .where(eq(crmTasksTable.id, handoff.taskId));
  expect(task.sourceEvent).toBe("voice.missed_call");
  expect(task.status).toBe("open");
  expect(sends).toBe(before);
});

it("hands an unknown missed caller to staff exactly once and never texts or auto-enrolls", async () => {
  await db.update(twilioClientBindingsTable)
    .set({ dailyCallLimit: 100 })
    .where(eq(twilioClientBindingsTable.organizationId, orgA));
  const caller = "+12025550107";
  const fields = { From: caller, To: sender, CallSid: "CA" + "c".repeat(32) };
  const beforeSends = sends;
  expect((await webhook("/api/v1/public/voice/inbound", fields)).status).toBe(200);
  const [call] = await db
    .select()
    .from(twilioCallsTable)
    .where(eq(twilioCallsTable.providerSid, fields.CallSid));
  expect(call.contactId).toBeNull();
  const completePath = `/api/v1/public/voice/complete?operation=${call.id}`;
  expect((await webhook(completePath, { ...fields, DialCallStatus: "no-answer" })).status).toBe(200);
  expect((await webhook(completePath, { ...fields, DialCallStatus: "no-answer" })).status).toBe(200);
  const handoffs = await db
    .select()
    .from(missedCallHandoffsTable)
    .where(eq(missedCallHandoffsTable.callId, call.id));
  expect(handoffs).toHaveLength(1);
  expect(handoffs[0].leadId).toBeNull();

  const requestId = randomUUID();
  const body = JSON.stringify({ action: "create_opportunity", requestId, firstName: "Caller" });
  const review = (session: string, payload = body) => realFetch(
    base + `/api/v1/communications/voice/${call.id}/review`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${session}`, "content-type": "application/json" },
      body: payload,
    },
  );
  expect((await review(sessionB)).status).toBe(404);
  const accepted = await review(sessionA);
  expect(accepted.status).toBe(200);
  const receipt = await accepted.json() as { handoff: { leadId: string; contactId: string } };
  expect(receipt.handoff.leadId).toBeTruthy();
  expect((await review(sessionA)).status).toBe(200);
  expect((await review(sessionA, JSON.stringify({ action: "create_opportunity", requestId: randomUUID(), firstName: "Caller" }))).status).toBe(409);
  const [lead] = await db.select().from(leadsTable).where(eq(leadsTable.id, receipt.handoff.leadId));
  expect(lead.source).toBe("missed-call");
  expect(lead.creationMethod).toBe("staff_review");
  const [task] = await db.select().from(crmTasksTable).where(eq(crmTasksTable.id, handoffs[0].taskId));
  expect(task.leadId).toBe(lead.id);
  expect(task.assignedUserId).toBeTruthy();
  expect(sends).toBe(beforeSends);
});

it("requires an explicit valid voice business name and keeps the client template disabled", async () => {
  const template = parseEnv(
    readFileSync(
      new URL(
        "../../../../../TWILIO-CLIENT-DISABLED.env.example",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const beforeVoice = voiceSends;
  const beforeSms = sends;
  try {
    for (const name of ["", "   ", "a".repeat(121), "Business\nInjected"]) {
      await db.update(twilioClientBindingsTable).set({ businessName: name })
        .where(eq(twilioClientBindingsTable.organizationId, orgA));
      expect((await voiceConfiguration(orgA))?.voiceEnabled).toBe(false);
    }
    expect(template.TWILIO_CLIENT_PAINLESS_AUTH_TOKEN).toBe("");
    expect(template.TWILIO_CLIENT_PAINLESS_API_KEY_SECRET).toBe("");
    expect((await twilioForOrganization(orgB))?.smsEnabled).toBe(false);
    expect((await twilioForOrganization(orgB))?.voiceEnabled).toBe(false);
    const blocked = await realFetch(base + "/api/v1/communications/voice", {
      method: "POST",
      headers: {
        authorization: `Bearer ${sessionA}`,
        origin: "https://growth.example",
        "content-type": "application/json",
        "x-forwarded-for": "192.0.2.93",
      },
      body: JSON.stringify({
        contactId: contactA,
        requestId: randomUUID(),
        requestedByContact: true,
      }),
    });
    expect(blocked.status).toBe(409);
    expect(voiceSends).toBe(beforeVoice);
    expect(sends).toBe(beforeSms);
    const inactive = await webhook("/api/v1/public/voice/inbound", {
      CallSid: "CA" + "d".repeat(32),
    });
    expect(await inactive.text()).toContain("<Reject");
  } finally {
    await db.update(twilioClientBindingsTable)
      .set({ businessName: "Synthetic & Roofing" })
      .where(eq(twilioClientBindingsTable.organizationId, orgA));
  }
});

it("allows approved voice without a Messaging Service while SMS and tenant/account boundaries remain closed", async () => {
  const fields = { From: phone, To: sender, CallSid: "CA" + "b".repeat(32) };
  const before = sends;
  await db.update(twilioClientBindingsTable)
    .set({ messagingServiceSid: null, smsEnabled: false, registrationApproved: false, advancedOptOut: false })
    .where(eq(twilioClientBindingsTable.organizationId, orgA));
  try {
    expect(
      (await webhook("/api/v1/public/voice/inbound", fields, false)).status,
    ).toBe(403);
    expect(
      (
        await webhook("/api/v1/public/voice/inbound", {
          ...fields,
          AccountSid: "AC" + "9".repeat(32),
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await webhook("/api/v1/public/voice/inbound", {
          ...fields,
          To: "+12025550108",
        })
      ).status,
    ).toBe(403);
    expect(
      (await webhook("/api/v1/public/sms/inbound", { Body: "JOIN example" }))
        .status,
    ).toBe(403);
    const inbound = await webhook("/api/v1/public/voice/inbound", fields);
    expect(inbound.status).toBe(200);
    expect(await inbound.text()).toContain("+12025550109");
    const [op] = await db
      .select()
      .from(twilioCallsTable)
      .where(eq(twilioCallsTable.providerSid, fields.CallSid));
    expect(op.organizationId).toBe(orgA);
    await webhook(`/api/v1/public/voice/complete?operation=${op.id}`, {
      ...fields,
      DialCallStatus: "no-answer",
    });
    await webhook("/api/v1/public/voice/status", {
      ...fields,
      CallStatus: "completed",
    });
    const [done] = await db
      .select()
      .from(twilioCallsTable)
      .where(eq(twilioCallsTable.id, op.id));
    expect(done.dialStatus).toBe("no-answer");
    expect(done.status).toBe("completed");
    const otherTenant = await realFetch(base + "/api/v1/communications/voice", {
      headers: { authorization: `Bearer ${sessionB}` },
    });
    expect(otherTenant.status).toBe(200);
    expect(await otherTenant.json()).toEqual({ enabled: false, calls: [] });
    const outbound = await realFetch(base + "/api/v1/communications/voice", {
      method: "POST",
      headers: {
        authorization: `Bearer ${sessionA}`,
        origin: "https://growth.example",
        "content-type": "application/json",
        "x-forwarded-for": "192.0.2.92",
      },
      body: JSON.stringify({
        contactId: contactA,
        requestId: randomUUID(),
        requestedByContact: true,
      }),
    });
    expect(outbound.status).toBe(202);
    await db.update(twilioClientBindingsTable).set({ voiceEnabled: false })
      .where(eq(twilioClientBindingsTable.organizationId, orgA));
    const stopped = await webhook("/api/v1/public/voice/inbound", {
      ...fields,
      CallSid: "CA" + "c".repeat(32),
    });
    expect(await stopped.text()).toContain("<Reject");
    expect(sends).toBe(before);
  } finally {
    await db.update(twilioClientBindingsTable)
      .set({ messagingServiceSid: service, smsEnabled: true, registrationApproved: true,
        advancedOptOut: true, voiceEnabled: true })
      .where(eq(twilioClientBindingsTable.organizationId, orgA));
  }
});

it("separates two contractor accounts across inbound, outbound, callback and revocation", async () => {
  const noSelector = await realFetch(base + "/api/v1/public/sms/program");
  expect((await noSelector.json() as { enabled: boolean }).enabled).toBe(false);
  const selected = await realFetch(base + `/api/v1/public/sms/program?program=${program}`);
  expect((await selected.json() as { brand: string }).brand).toBe("Synthetic & Roofing");

  await db.update(twilioClientBindingsTable).set({
    launchApproved: true, smsEnabled: true, registrationApproved: true,
    advancedOptOut: true, voiceEnabled: true, voiceApproved: true,
    geoPermissionsReviewed: true,
  }).where(eq(twilioClientBindingsTable.organizationId, orgB));
  await db.insert(twilioConsentProofsTable).values({
    organizationId: orgB, contactId: contactB, phone,
    purpose: "customer_care", granted: true,
    disclosureVersion: "synthetic-hvac-v1", source: "synthetic B proof",
  });
  await db.insert(consentRecordsTable).values({
    organizationId: orgB, contactId: contactB, channel: "sms", granted: true,
    disclosureVersion: "synthetic-hvac-v1",
  });
  await expect(sendTwilioSms(phone, "Wrong contact", {
    organizationId: orgB, contactId: contactA,
    purpose: "customer_care", idempotencyKey: "tenant-b-cross-contact",
  })).rejects.toThrow(/outside this organization/);
  const sentB = await sendTwilioSms(phone, "Service follow-up", {
    organizationId: orgB, contactId: contactB,
    purpose: "customer_care", idempotencyKey: "tenant-b-send",
  });
  expect(sendsB).toBe(1);
  expect((await sendTwilioSms(phone, "Service follow-up", {
    organizationId: orgB, contactId: contactB,
    purpose: "customer_care", idempotencyKey: "tenant-b-send",
  })).id).toBe(sentB.id);
  const [smsB] = await db.select().from(twilioDispatchesTable)
    .where(eq(twilioDispatchesTable.idempotencyKey, "tenant-b-send"));
  expect(smsB.accountSid).toBe(accountB);
  expect((await webhook(`/api/v1/public/sms/status?operation=${smsB.id}`, {
    AccountSid: account, MessagingServiceSid: service, From: sender, To: phone,
    MessageSid: sentB.id, MessageStatus: "delivered",
  })).status).toBe(403);
  expect((await webhook(`/api/v1/public/sms/status?operation=${smsB.id}`, {
    AccountSid: accountB, MessagingServiceSid: serviceB, From: senderB, To: phone,
    MessageSid: sentB.id, MessageStatus: "delivered",
  })).status).toBe(204);
  expect((await webhook("/api/v1/public/sms/inbound", {
    AccountSid: accountB, MessagingServiceSid: serviceB,
    From: phone, To: senderB, Body: "STOP", MessageSid: "SM" + "a".repeat(32),
  })).status).toBe(403);
  expect(await getSuppression(orgB, "sms", phone)).toBeNull();

  const callSid = "CA" + "e".repeat(32);
  const inboundB = { AccountSid: accountB, From: phone, To: senderB, CallSid: callSid };
  expect((await webhook("/api/v1/public/voice/inbound", inboundB, false)).status).toBe(403);
  expect((await webhook("/api/v1/public/voice/inbound", { ...inboundB, To: sender })).status).toBe(403);
  const accepted = await webhook("/api/v1/public/voice/inbound", inboundB);
  expect(accepted.status).toBe(200);
  expect(await accepted.text()).toContain("Synthetic HVAC");
  const [callB] = await db.select().from(twilioCallsTable)
    .where(eq(twilioCallsTable.providerSid, callSid));
  expect(callB.organizationId).toBe(orgB);
  const replayOtherTenant = await webhook("/api/v1/public/voice/inbound", {
    ...inboundB, AccountSid: account, To: sender,
  });
  expect(await replayOtherTenant.text()).toContain("<Reject");
  expect((await webhook(`/api/v1/public/voice/complete?operation=${callB.id}`, {
    ...inboundB, AccountSid: account, To: sender, DialCallStatus: "no-answer",
  })).status).toBe(403);
  expect((await webhook(`/api/v1/public/voice/complete?operation=${callB.id}`, {
    ...inboundB, DialCallStatus: "no-answer",
  })).status).toBe(200);
  const [handoff] = await db.select().from(missedCallHandoffsTable)
    .where(eq(missedCallHandoffsTable.callId, callB.id));
  expect(handoff.organizationId).toBe(orgB);

  expect((await webhook("/api/v1/public/sms/inbound", {
    AccountSid: accountB, MessagingServiceSid: serviceB,
    From: phone, To: senderB, Body: "STOP",
  })).status).toBe(200);
  expect(await getSuppression(orgB, "sms", phone)).not.toBeNull();
  expect(await getSuppression(orgA, "sms", phone)).toBeNull();
  await db.update(twilioClientBindingsTable).set({ revokedAt: new Date() })
    .where(eq(twilioClientBindingsTable.organizationId, orgB));
  expect((await webhook(`/api/v1/public/voice/status?operation=${callB.id}`, {
    ...inboundB, CallStatus: "completed",
  })).status).toBe(204);
  const [recordedAfterRevoke] = await db.select().from(twilioCallsTable)
    .where(eq(twilioCallsTable.id, callB.id));
  expect(recordedAfterRevoke.status).toBe("completed");
  await expect(sendTwilioSms(phone, "Blocked after revocation", {
    organizationId: orgB, contactId: contactB,
    purpose: "customer_care", idempotencyKey: "tenant-b-revoked",
  })).rejects.toThrow(/disabled/);
  const afterRevoke = await webhook("/api/v1/public/voice/inbound", {
    ...inboundB, CallSid: "CA" + "f".repeat(32),
  });
  expect(await afterRevoke.text()).toContain("<Reject");
  expect((await voiceConfiguration(orgA))?.voiceEnabled).toBe(true);
  expect((await voiceConfiguration(orgB))?.voiceEnabled).toBe(false);
});
