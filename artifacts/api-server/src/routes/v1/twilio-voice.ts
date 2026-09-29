import { Router, type IRouter, type Request } from "express";
import { z } from "zod";
import { twiml } from "twilio";
import { and, desc, eq, gte, isNull, or, sql } from "drizzle-orm";
import { db, contactsTable, twilioCallsTable } from "@workspace/db";
import { requireMember } from "../../middlewares/requireMember";
import { rateLimit } from "../../lib/rateLimit";
import {
  phoneE164,
  twilioConfiguration,
  twilioRequestValid,
} from "../../services/twilio-controls";

const router: IRouter = Router();
export function voiceConfiguration() {
  const config = twilioConfiguration(),
    staff = process.env.TWILIO_STAFF_PHONE ?? "",
    limit = Number(process.env.TWILIO_DAILY_CALL_LIMIT ?? 0);
  const requestedName = (process.env.TWILIO_VOICE_BUSINESS_NAME ?? "").trim();
  const businessName =
    requestedName.length <= 120 && !/[\u0000-\u001f\u007f]/.test(requestedName)
      ? requestedName
      : "";
  return {
    ...config,
    staff,
    limit,
    businessName,
    voiceEnabled:
      config.voiceConfigured &&
      Boolean(businessName) &&
      process.env.TWILIO_VOICE_ENABLED === "true" &&
      process.env.TWILIO_VOICE_APPROVED === "true" &&
      process.env.TWILIO_LAUNCH_APPROVED === "true" &&
      process.env.TWILIO_GEO_PERMISSIONS_REVIEWED === "true" &&
      /^SK[a-f0-9]{32}$/i.test(process.env.TWILIO_API_KEY_SID ?? "") &&
      Boolean(process.env.TWILIO_API_KEY_SECRET) &&
      phoneE164(staff) === staff &&
      staff !== process.env.TWILIO_PHONE_NUMBER &&
      Number.isSafeInteger(limit) &&
      limit > 0 &&
      limit <= 100,
  };
}
const validCall = (req: Request) =>
  twilioRequestValid(req, "voice") &&
  /^CA[a-f0-9]{32}$/i.test(req.body.CallSid ?? "");
const path = (origin: string, id: string, suffix: string) =>
  `${origin}/api/v1/public/voice/${suffix}?operation=${id}`;
const hangup = () => {
  const xml = new twiml.VoiceResponse();
  xml.hangup();
  return xml.toString();
};

router.get(
  "/communications/voice",
  requireMember("crm.read"),
  async (req, res) => {
    const config = voiceConfiguration();
    const calls = await db
      .select()
      .from(twilioCallsTable)
      .where(eq(twilioCallsTable.organizationId, req.member!.organizationId))
      .orderBy(desc(twilioCallsTable.createdAt))
      .limit(50);
    res.json({
      enabled:
        config.voiceEnabled &&
        config.organizationId === req.member!.organizationId,
      calls,
    });
  },
);
router.post(
  "/communications/voice",
  requireMember("crm.write"),
  rateLimit({ windowMs: 60_000, max: 5, key: "voice-app" }),
  async (req, res) => {
    if (
      !req.header("x-api-key") &&
      req.header("origin") !== process.env.APP_ORIGIN
    ) {
      res.status(403).end();
      return;
    }
    const config = voiceConfiguration(),
      input = z
        .object({
          contactId: z.uuid(),
          requestId: z.uuid(),
          requestedByContact: z.literal(true),
        })
        .strict()
        .safeParse(req.body);
    if (
      !config.voiceEnabled ||
      config.organizationId !== req.member!.organizationId
    ) {
      res.status(409).json({
        error: "Calling has not been activated for this organization.",
      });
      return;
    }
    if (!input.success) {
      res
        .status(400)
        .json({ error: "Select a contact who requested this call." });
      return;
    }
    const [contact] = await db
      .select()
      .from(contactsTable)
      .where(
        and(
          eq(contactsTable.id, input.data.contactId),
          eq(contactsTable.organizationId, config.organizationId),
        ),
      );
    const phone = phoneE164(contact?.phone ?? "");
    if (
      !contact ||
      contact.doNotContact ||
      !phone ||
      phone === config.staff ||
      phone === process.env.TWILIO_PHONE_NUMBER
    ) {
      res
        .status(409)
        .json({ error: "This contact is not eligible for a requested call." });
      return;
    }
    const operation = await db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`voice:${config.organizationId}`}))`,
      );
      const [existing] = await tx
        .select()
        .from(twilioCallsTable)
        .where(
          and(
            eq(twilioCallsTable.organizationId, config.organizationId),
            eq(twilioCallsTable.requestKey, input.data.requestId),
          ),
        );
      if (existing) return { ...existing, owned: false };
      const day = new Date();
      day.setUTCHours(0, 0, 0, 0);
      const [usage] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(twilioCallsTable)
        .where(
          and(
            eq(twilioCallsTable.organizationId, config.organizationId),
            gte(twilioCallsTable.createdAt, day),
          ),
        );
      if (usage.n >= config.limit) return null;
      const [created] = await tx
        .insert(twilioCallsTable)
        .values({
          organizationId: config.organizationId,
          contactId: contact.id,
          requestKey: input.data.requestId,
          direction: "outbound",
          phone,
          staffPhone: config.staff,
          accountSid: process.env.TWILIO_ACCOUNT_SID!,
          authorizationSource: `staff:${req.member!.user.id}:contact-requested`,
        })
        .returning();
      return { ...created, owned: true };
    });
    if (!operation) {
      res
        .status(429)
        .json({ error: "Daily call operation allowance reached." });
      return;
    }
    if (!operation.owned) {
      res
        .status(
          operation.phone === phone &&
            operation.contactId === contact.id &&
            [
              "queued",
              "initiated",
              "ringing",
              "in-progress",
              "completed",
            ].includes(operation.status)
            ? 200
            : 409,
        )
        .json({
          id: operation.id,
          status: operation.status,
          error: [
            "uncertain",
            "dispatching",
            "failed",
            "rate_limited",
          ].includes(operation.status)
            ? "Review the existing call operation before another attempt."
            : undefined,
        });
      return;
    }
    try {
      const params = new URLSearchParams({
        From: process.env.TWILIO_PHONE_NUMBER!,
        To: config.staff,
        Url: path(config.origin, operation.id, "answer"),
        Method: "POST",
        StatusCallback: path(config.origin, operation.id, "status"),
        StatusCallbackMethod: "POST",
        Timeout: "20",
        TimeLimit: "300",
        Record: "false",
      });
      params.append("StatusCallbackEvent", "initiated");
      params.append("StatusCallbackEvent", "ringing");
      params.append("StatusCallbackEvent", "answered");
      params.append("StatusCallbackEvent", "completed");
      const response = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}/Calls.json`,
        {
          method: "POST",
          signal: AbortSignal.timeout(10_000),
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            authorization: `Basic ${Buffer.from(`${process.env.TWILIO_API_KEY_SID}:${process.env.TWILIO_API_KEY_SECRET}`).toString("base64")}`,
          },
          body: params.toString(),
        },
      );
      if (!response.ok) {
        await db
          .update(twilioCallsTable)
          .set({
            status:
              response.status >= 500
                ? "uncertain"
                : response.status === 429
                  ? "rate_limited"
                  : "failed",
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(twilioCallsTable.id, operation.id),
              eq(twilioCallsTable.status, "dispatching"),
            ),
          );
        throw new Error("Call not confirmed");
      }
      const data = (await response.json()) as { sid?: string };
      if (!/^CA[a-f0-9]{32}$/i.test(data.sid ?? ""))
        throw new Error("Call not confirmed");
      await db
        .update(twilioCallsTable)
        .set({ providerSid: data.sid, status: "queued", updatedAt: new Date() })
        .where(
          and(
            eq(twilioCallsTable.id, operation.id),
            eq(twilioCallsTable.status, "dispatching"),
          ),
        );
      res.status(202).json({ id: operation.id, status: "queued" });
    } catch {
      await db
        .update(twilioCallsTable)
        .set({ status: "uncertain", updatedAt: new Date() })
        .where(
          and(
            eq(twilioCallsTable.id, operation.id),
            eq(twilioCallsTable.status, "dispatching"),
          ),
        );
      res.status(409).json({
        id: operation.id,
        error:
          "Call was not confirmed. Review this operation before trying another call.",
      });
    }
  },
);

router.post(
  "/public/voice/inbound",
  rateLimit({ windowMs: 60_000, max: 120, key: "voice-inbound" }),
  async (req, res) => {
    if (!validCall(req) || req.body.To !== process.env.TWILIO_PHONE_NUMBER) {
      res.status(403).end();
      return;
    }
    const config = voiceConfiguration(),
      phone = phoneE164(req.body.From ?? "");
    const xml = new twiml.VoiceResponse();
    if (!config.voiceEnabled || !phone || phone === config.staff) {
      xml.reject({ reason: "busy" });
      res.type("text/xml").send(xml.toString());
      return;
    }
    const operation = await db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`voice:${config.organizationId}`}))`,
      );
      const [seen] = await tx
        .select()
        .from(twilioCallsTable)
        .where(eq(twilioCallsTable.providerSid, req.body.CallSid));
      if (seen) return seen;
      const day = new Date();
      day.setUTCHours(0, 0, 0, 0);
      const [usage] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(twilioCallsTable)
        .where(
          and(
            eq(twilioCallsTable.organizationId, config.organizationId),
            gte(twilioCallsTable.createdAt, day),
          ),
        );
      if (usage.n >= config.limit) return null;
      const contacts = await tx
        .select()
        .from(contactsTable)
        .where(
          and(
            eq(contactsTable.organizationId, config.organizationId),
            sql`regexp_replace(coalesce(${contactsTable.phone}, ''), '[^0-9]', '', 'g') IN (${phone.slice(1)},${phone.slice(2)})`,
          ),
        );
      const [created] = await tx
        .insert(twilioCallsTable)
        .values({
          organizationId: config.organizationId,
          contactId: contacts.length === 1 ? contacts[0].id : null,
          requestKey: req.body.CallSid,
          direction: "inbound",
          phone,
          staffPhone: config.staff,
          accountSid: process.env.TWILIO_ACCOUNT_SID!,
          providerSid: req.body.CallSid,
          status: "ringing",
          authorizationSource: "inbound caller",
        })
        .returning();
      return created;
    });
    if (!operation) {
      xml.reject({ reason: "busy" });
    } else {
      xml.say(
        `Thank you for calling ${config.businessName}. We will try to connect you.`,
      );
      xml
        .dial({
          callerId: process.env.TWILIO_PHONE_NUMBER,
          timeout: 20,
          timeLimit: 300,
          record: "do-not-record",
          action: path(config.origin, operation.id, "complete"),
          method: "POST",
        })
        .number(config.staff);
    }
    res.type("text/xml").send(xml.toString());
  },
);

async function boundOperation(req: Request) {
  if (!validCall(req)) return null;
  const config = voiceConfiguration();
  const id = z.uuid().safeParse(req.query.operation);
  if (!id.success && req.path !== "/public/voice/status") return null;
  const [op] = await db
    .select()
    .from(twilioCallsTable)
    .where(
      and(
        id.success
          ? eq(twilioCallsTable.id, id.data)
          : and(
              eq(twilioCallsTable.providerSid, req.body.CallSid),
              eq(twilioCallsTable.direction, "inbound"),
            ),
        eq(twilioCallsTable.organizationId, config.organizationId),
        eq(twilioCallsTable.accountSid, req.body.AccountSid),
        or(
          isNull(twilioCallsTable.providerSid),
          eq(twilioCallsTable.providerSid, req.body.CallSid),
        ),
      ),
    );
  if (
    !op ||
    phoneE164(req.body.To ?? "") !==
      (op.direction === "inbound"
        ? process.env.TWILIO_PHONE_NUMBER
        : op.staffPhone) ||
    phoneE164(req.body.From ?? "") !==
      (op.direction === "inbound" ? op.phone : process.env.TWILIO_PHONE_NUMBER)
  )
    return null;
  // Bind the first signed callback even when it beats the REST response.
  const [bound] = await db
    .update(twilioCallsTable)
    .set({ providerSid: req.body.CallSid })
    .where(
      and(
        eq(twilioCallsTable.id, op.id),
        or(
          isNull(twilioCallsTable.providerSid),
          eq(twilioCallsTable.providerSid, req.body.CallSid),
        ),
      ),
    )
    .returning();
  return bound ?? null;
}
router.post("/public/voice/answer", async (req, res) => {
  const op = await boundOperation(req),
    config = voiceConfiguration();
  if (!op || op.direction !== "outbound") {
    res.status(403).end();
    return;
  }
  const xml = new twiml.VoiceResponse();
  if (config.voiceEnabled) {
    xml
      .gather({
        numDigits: 1,
        timeout: 8,
        action: path(config.origin, op.id, "connect"),
        method: "POST",
      })
      .say(
        `${config.businessName}. Press 1 to connect your requested customer call.`,
      );
  }
  xml.hangup();
  res.type("text/xml").send(xml.toString());
});
router.post("/public/voice/connect", async (req, res) => {
  const op = await boundOperation(req),
    config = voiceConfiguration();
  if (!op || op.direction !== "outbound") {
    res.status(403).end();
    return;
  }
  if (!config.voiceEnabled || req.body.Digits !== "1") {
    res.type("text/xml").send(hangup());
    return;
  }
  const [contact] = await db
    .select()
    .from(contactsTable)
    .where(
      and(
        eq(contactsTable.id, op.contactId!),
        eq(contactsTable.organizationId, op.organizationId),
      ),
    );
  if (
    !contact ||
    contact.doNotContact ||
    phoneE164(contact.phone ?? "") !== op.phone
  ) {
    res.type("text/xml").send(hangup());
    return;
  }
  const [claimed] = await db
    .update(twilioCallsTable)
    .set({ bridgeStarted: true, updatedAt: new Date() })
    .where(
      and(
        eq(twilioCallsTable.id, op.id),
        eq(twilioCallsTable.bridgeStarted, false),
      ),
    )
    .returning();
  // Replayed connect callbacks cannot start a second customer leg.
  if (!claimed) {
    res.type("text/xml").send(hangup());
    return;
  }
  const xml = new twiml.VoiceResponse();
  xml
    .dial({
      callerId: process.env.TWILIO_PHONE_NUMBER,
      timeout: 20,
      timeLimit: 300,
      record: "do-not-record",
      action: path(config.origin, op.id, "complete"),
      method: "POST",
    })
    .number(op.phone);
  res.type("text/xml").send(xml.toString());
});
router.post("/public/voice/complete", async (req, res) => {
  const op = await boundOperation(req);
  if (!op) {
    res.status(403).end();
    return;
  }
  const status = z
    .enum(["completed", "busy", "no-answer", "failed", "canceled"])
    .safeParse(req.body.DialCallStatus);
  if (status.success)
    await db
      .update(twilioCallsTable)
      .set({ dialStatus: status.data, updatedAt: new Date() })
      .where(
        and(
          eq(twilioCallsTable.id, op.id),
          isNull(twilioCallsTable.dialStatus),
        ),
      );
  const xml = new twiml.VoiceResponse();
  if (
    op.direction === "inbound" &&
    !(status.success && status.data === "completed")
  )
    xml.say("We could not connect your call. Please try again later.");
  xml.hangup();
  res.type("text/xml").send(xml.toString());
});
router.post("/public/voice/status", async (req, res) => {
  const op = await boundOperation(req);
  if (!op) {
    res.status(403).end();
    return;
  }
  const ranks: Record<string, number> = {
    initiated: 1,
    queued: 1,
    ringing: 2,
    "in-progress": 3,
    completed: 4,
    busy: 4,
    "no-answer": 4,
    failed: 4,
    canceled: 4,
  };
  const status = String(req.body.CallStatus);
  if (status in ranks)
    await db
      .update(twilioCallsTable)
      .set({ status, updatedAt: new Date() })
      .where(
        and(
          eq(twilioCallsTable.id, op.id),
          sql`${twilioCallsTable.status} NOT IN ('completed','busy','no-answer','failed','canceled')`,
          sql`CASE ${twilioCallsTable.status} WHEN 'initiated' THEN 1 WHEN 'queued' THEN 1 WHEN 'ringing' THEN 2 WHEN 'in-progress' THEN 3 ELSE 0 END <= ${ranks[status]}`,
        ),
      );
  res.status(204).end();
});
export default router;
