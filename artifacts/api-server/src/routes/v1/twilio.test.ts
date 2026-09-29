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
  twilioDispatchesTable,
  twilioConsentProofsTable,
  twilioCallsTable,
} from "@workspace/db";
import app from "../../app";
import { createSession } from "../../lib/auth";
import { deleteTestOrgs } from "../../test-helpers/delete-test-orgs";
import { sendTwilioSms } from "../../services/twilio-delivery";
import {
  SMS_DISCLOSURE_VERSION,
  twilioConfiguration,
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
  voiceSends = 0,
  serial = 0,
  mode = "ok";
const realFetch = globalThis.fetch;
const account = "AC" + "1".repeat(32),
  service = "MG" + "2".repeat(32),
  sender = "+15005550006",
  phone = "+12025550101",
  token = "synthetic-webhook-token";
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
            token,
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
    TWILIO_PUBLIC_ORIGIN: "https://growth.example",
    TWILIO_ORGANIZATION_ID: orgA,
    TWILIO_ACCOUNT_SID: account,
    TWILIO_AUTH_TOKEN: token,
    TWILIO_MESSAGING_SERVICE_SID: service,
    TWILIO_PHONE_NUMBER: sender,
    TWILIO_API_KEY_SID: "SK" + "3".repeat(32),
    TWILIO_API_KEY_SECRET: "synthetic-key",
    TWILIO_SMS_ENABLED: "true",
    TWILIO_REGISTRATION_APPROVED: "true",
    TWILIO_ADVANCED_OPT_OUT: "true",
    TWILIO_DAILY_SMS_LIMIT: "20",
    TWILIO_VOICE_BUSINESS_NAME: "Synthetic & Roofing",
  };
  for (const [key, value] of Object.entries(values)) vi.stubEnv(key, value);
  vi.stubEnv("TWILIO_LAUNCH_APPROVED", "true");
  vi.stubEnv("TWILIO_GEO_PERMISSIONS_REVIEWED", "true");
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
  vi.stubEnv("TWILIO_AUTH_TOKEN", "");
  expect(
    (await webhook("/api/v1/public/sms/inbound", { Body: "STOP" })).status,
  ).toBe(403);
  vi.stubEnv("TWILIO_AUTH_TOKEN", token);
});
it("records no consent until the correct handset confirms the optional purposes", async () => {
  await expect(
    sendTwilioSms(phone, "Hello", context("before-consent")),
  ).rejects.toThrow(/consent/);
  const response = await realFetch(base + "/api/v1/public/sms/enroll", {
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
  ).rejects.toThrow(/tenant/);
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
  for (const [key, value] of Object.entries({
    TWILIO_VOICE_ENABLED: "true",
    TWILIO_VOICE_APPROVED: "true",
    TWILIO_STAFF_PHONE: "+12025550109",
    TWILIO_DAILY_CALL_LIMIT: "5",
  }))
    vi.stubEnv(key, value);
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
  expect(sends).toBe(before);
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
  const previous = Object.fromEntries(
    Object.keys(template).map((key) => [key, process.env[key]]),
  );
  const beforeVoice = voiceSends;
  const beforeSms = sends;
  try {
    for (const name of ["", "   ", "a".repeat(121), "Business\nInjected"]) {
      vi.stubEnv("TWILIO_VOICE_BUSINESS_NAME", name);
      expect(voiceConfiguration().voiceEnabled).toBe(false);
    }
    for (const [key, value] of Object.entries(template)) vi.stubEnv(key, value);
    expect(voiceConfiguration().businessName).toBe(
      "Painless Roofing & Water Restoration",
    );
    expect(voiceConfiguration().voiceEnabled).toBe(false);
    expect(twilioConfiguration().configured).toBe(false);
    expect(twilioConfiguration().enabled).toBe(false);
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
    expect(
      (
        await webhook("/api/v1/public/voice/inbound", {
          CallSid: "CA" + "d".repeat(32),
        })
      ).status,
    ).toBe(403);
  } finally {
    for (const [key, value] of Object.entries(previous)) vi.stubEnv(key, value);
  }
});

it("allows approved voice without a Messaging Service while SMS and tenant/account boundaries remain closed", async () => {
  const fields = { From: phone, To: sender, CallSid: "CA" + "b".repeat(32) };
  const before = sends;
  vi.stubEnv("TWILIO_MESSAGING_SERVICE_SID", "");
  vi.stubEnv("TWILIO_SMS_ENABLED", "false");
  vi.stubEnv("TWILIO_REGISTRATION_APPROVED", "false");
  vi.stubEnv("TWILIO_ADVANCED_OPT_OUT", "false");
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
    vi.stubEnv("TWILIO_VOICE_ENABLED", "false");
    const stopped = await webhook("/api/v1/public/voice/inbound", {
      ...fields,
      CallSid: "CA" + "c".repeat(32),
    });
    expect(await stopped.text()).toContain("<Reject");
    expect(sends).toBe(before);
  } finally {
    vi.stubEnv("TWILIO_MESSAGING_SERVICE_SID", service);
    vi.stubEnv("TWILIO_SMS_ENABLED", "true");
    vi.stubEnv("TWILIO_REGISTRATION_APPROVED", "true");
    vi.stubEnv("TWILIO_ADVANCED_OPT_OUT", "true");
    vi.stubEnv("TWILIO_VOICE_ENABLED", "true");
  }
});
