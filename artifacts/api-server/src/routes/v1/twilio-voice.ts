import { Router, type IRouter, type Request } from "express";
import { z } from "zod";
import { twiml } from "twilio";
import { and, desc, eq, gte, inArray, isNull, or, sql } from "drizzle-orm";
import { db, contactsTable, missedCallHandoffsTable, twilioCallsTable } from "@workspace/db";
import { requireMember } from "../../middlewares/requireMember";
import { rateLimit } from "../../lib/rateLimit";
import { ensureMissedCallHandoff, reviewMissedCall } from "../../services/missed-call-handoff";
import { assertOutboundDeliveryAllowed, outboundDeliveryHeld } from "../../services/outbound-hold";
import { customerWorkHeld } from "../../services/customer-lifecycle-runtime";
import {
  phoneE164,
  twilioForInbound,
  twilioForOrganization,
  twilioRequestValid,
} from "../../services/twilio-controls";

const router: IRouter = Router();
export const voiceConfiguration = twilioForOrganization;
const validCall = (req: Request, config: Awaited<ReturnType<typeof voiceConfiguration>>) =>
  twilioRequestValid(req, config, "voice") &&
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
    const config = await voiceConfiguration(req.member!.organizationId);
    const calls = await db
      .select()
      .from(twilioCallsTable)
      .where(eq(twilioCallsTable.organizationId, req.member!.organizationId))
      .orderBy(desc(twilioCallsTable.createdAt))
      .limit(50);
    const handoffs = calls.length
      ? await db
          .select()
          .from(missedCallHandoffsTable)
          .where(
            and(
              eq(missedCallHandoffsTable.organizationId, req.member!.organizationId),
              inArray(missedCallHandoffsTable.callId, calls.map((call) => call.id)),
            ),
          )
      : [];
    res.json({
      enabled:
        Boolean(config?.voiceEnabled),
      calls,
      ...(handoffs.length ? { handoffs } : {}),
    });
  },
);
router.post(
  "/communications/voice/:id/review",
  requireMember("crm.write"),
  rateLimit({ windowMs: 60_000, max: 30, key: "voice-review" }),
  async (req, res) => {
    const id = z.uuid().safeParse(req.params.id);
    const input = z.discriminatedUnion("action", [
      z.object({
        action: z.literal("link_contact"),
        requestId: z.uuid(),
        contactId: z.uuid(),
      }).strict(),
      z.object({
        action: z.literal("create_opportunity"),
        requestId: z.uuid(),
        contactId: z.uuid().optional(),
        firstName: z.string().trim().min(1).max(100).optional(),
        lastName: z.string().trim().max(100).optional(),
        serviceType: z.string().trim().max(100).optional(),
      }).strict(),
    ]).safeParse(req.body);
    if (!id.success || !input.success) {
      res.status(400).json({ error: "Invalid missed-call review" });
      return;
    }
    const result = await reviewMissedCall(
      req.member!.organizationId,
      id.data,
      req.member!.user.id,
      input.data,
    );
    if ("error" in result) {
      res.status(result.error === "not_found" ? 404 : 409).json(result);
      return;
    }
    res.json(result);
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
    if (outboundDeliveryHeld()) {
      res.status(503).json({ error: "Outbound calls are disabled in this environment." });
      return;
    }
    if (await customerWorkHeld(req.member!.organizationId)) {
      res.status(423).json({ error: "Company calling is paused. Review operating status before starting a call.", code: "customer_lifecycle_paused" });
      return;
    }
    const config = await voiceConfiguration(req.member!.organizationId),
      input = z
        .object({
          contactId: z.uuid(),
          requestId: z.uuid(),
          requestedByContact: z.literal(true),
        })
        .strict()
        .safeParse(req.body);
    if (
      !config?.voiceEnabled
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
      phone === config.staffPhone ||
      phone === config.phoneNumber
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
      if (usage.n >= config.dailyCallLimit) return null;
      const [created] = await tx
        .insert(twilioCallsTable)
        .values({
          organizationId: config.organizationId,
          contactId: contact.id,
          requestKey: input.data.requestId,
          direction: "outbound",
          phone,
          staffPhone: config.staffPhone!,
          accountSid: config.accountSid,
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
          operation.accountSid === config.accountSid &&
          operation.staffPhone === config.staffPhone &&
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
      const current = await voiceConfiguration(config.organizationId);
      if (!current?.voiceEnabled || current.id !== config.id ||
          current.accountSid !== config.accountSid ||
          current.phoneNumber !== config.phoneNumber ||
          current.staffPhone !== config.staffPhone ||
          current.origin !== config.origin) {
        await db.update(twilioCallsTable)
          .set({ status: "cancelled", updatedAt: new Date() })
          .where(eq(twilioCallsTable.id, operation.id));
        throw new Error("Client voice binding changed or was disabled");
      }
      const params = new URLSearchParams({
        From: current.phoneNumber,
        To: current.staffPhone!,
        Url: path(current.origin, operation.id, "answer"),
        Method: "POST",
        StatusCallback: path(current.origin, operation.id, "status"),
        StatusCallbackMethod: "POST",
        Timeout: "20",
        TimeLimit: "300",
        Record: "false",
      });
      params.append("StatusCallbackEvent", "initiated");
      params.append("StatusCallbackEvent", "ringing");
      params.append("StatusCallbackEvent", "answered");
      params.append("StatusCallbackEvent", "completed");
      assertOutboundDeliveryAllowed();
      if (await customerWorkHeld(config.organizationId)) {
        // We know no call POST was attempted. Keep the receipt as cancelled;
        // never release this request identity for an automatic replay.
        await db.update(twilioCallsTable).set({ status: "cancelled", updatedAt: new Date() })
          .where(and(eq(twilioCallsTable.id, operation.id), eq(twilioCallsTable.status, "dispatching")));
        res.status(423).json({ id: operation.id, error: "Company calling paused before this call was sent.", code: "customer_lifecycle_paused" });
        return;
      }
      const response = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${current.accountSid}/Calls.json`,
        {
          method: "POST",
          signal: AbortSignal.timeout(10_000),
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            authorization: `Basic ${Buffer.from(`${current.apiKeySid}:${current.apiKeySecret}`).toString("base64")}`,
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
    const config = await twilioForInbound(
      String(req.body?.AccountSid ?? ""), String(req.body?.To ?? ""),
    );
    if (!validCall(req, config)) {
      res.status(403).end();
      return;
    }
    const phone = phoneE164(req.body.From ?? "");
    const xml = new twiml.VoiceResponse();
    if (!config!.voiceEnabled || !phone || phone === config!.staffPhone) {
      xml.reject({ reason: "busy" });
      res.type("text/xml").send(xml.toString());
      return;
    }
    const operation = await db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`voice:${config!.organizationId}`}))`,
      );
      const [seen] = await tx
        .select()
        .from(twilioCallsTable)
        .where(eq(twilioCallsTable.providerSid, req.body.CallSid));
      if (seen) return seen.organizationId === config!.organizationId &&
        seen.accountSid === config!.accountSid &&
        seen.direction === "inbound" && seen.phone === phone ? seen : null;
      const day = new Date();
      day.setUTCHours(0, 0, 0, 0);
      const [usage] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(twilioCallsTable)
        .where(
          and(
          eq(twilioCallsTable.organizationId, config!.organizationId),
            gte(twilioCallsTable.createdAt, day),
          ),
        );
      if (usage.n >= config!.dailyCallLimit) return null;
      const contacts = await tx
        .select()
        .from(contactsTable)
        .where(
          and(
            eq(contactsTable.organizationId, config!.organizationId),
            sql`regexp_replace(coalesce(${contactsTable.phone}, ''), '[^0-9]', '', 'g') IN (${phone.slice(1)},${phone.slice(2)})`,
          ),
        );
      const [created] = await tx
        .insert(twilioCallsTable)
        .values({
          organizationId: config!.organizationId,
          contactId: contacts.length === 1 ? contacts[0].id : null,
          requestKey: req.body.CallSid,
          direction: "inbound",
          phone,
          staffPhone: config!.staffPhone!,
          accountSid: config!.accountSid,
          providerSid: req.body.CallSid,
          status: "ringing",
          authorizationSource: "inbound caller",
        })
        .onConflictDoNothing()
        .returning();
      if (created) return created;
      const [raced] = await tx.select().from(twilioCallsTable)
        .where(eq(twilioCallsTable.providerSid, req.body.CallSid));
      return raced?.organizationId === config!.organizationId &&
        raced.accountSid === config!.accountSid &&
        raced.direction === "inbound" && raced.phone === phone ? raced : null;
    });
    // An incoming provider call is already evidence worth retaining. Company
    // holds prevent the new staff leg while signed status callbacks still work.
    if (!operation || await customerWorkHeld(config!.organizationId)) {
      xml.reject({ reason: "busy" });
    } else {
      xml.say(
        `Thank you for calling ${config!.businessName}. We will try to connect you.`,
      );
      xml
        .dial({
          answerOnBridge: true,
          callerId: config!.phoneNumber,
          timeout: 20,
          timeLimit: 300,
          record: "do-not-record",
          action: path(config!.origin, operation.id, "complete"),
          method: "POST",
        })
        .number(config!.staffPhone!);
    }
    res.type("text/xml").send(xml.toString());
  },
);

async function boundOperation(req: Request) {
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
              eq(twilioCallsTable.providerSid, String(req.body?.CallSid ?? "")),
              eq(twilioCallsTable.direction, "inbound"),
            ),
        or(
          isNull(twilioCallsTable.providerSid),
          eq(twilioCallsTable.providerSid, String(req.body?.CallSid ?? "")),
        ),
      ),
    );
  if (!op) return null;
  const config = await voiceConfiguration(op.organizationId);
  if (
    !config || config.accountSid !== op.accountSid ||
    !validCall(req, config) ||
    phoneE164(req.body.To ?? "") !==
      (op.direction === "inbound"
        ? config.phoneNumber
        : op.staffPhone) ||
    phoneE164(req.body.From ?? "") !==
      (op.direction === "inbound" ? op.phone : config.phoneNumber)
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
  return bound ? { op: bound, config } : null;
}
router.post("/public/voice/answer", async (req, res) => {
  const bound = await boundOperation(req);
  if (!bound || bound.op.direction !== "outbound") {
    res.status(403).end();
    return;
  }
  const { op, config } = bound;
  const xml = new twiml.VoiceResponse();
  if (config.voiceEnabled && !(await customerWorkHeld(op.organizationId))) {
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
  const bound = await boundOperation(req);
  if (!bound || bound.op.direction !== "outbound") {
    res.status(403).end();
    return;
  }
  const { op, config } = bound;
  if (!config.voiceEnabled || req.body.Digits !== "1" || await customerWorkHeld(op.organizationId)) {
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
      callerId: config.phoneNumber,
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
  const bound = await boundOperation(req);
  if (!bound) {
    res.status(403).end();
    return;
  }
  const { op } = bound;
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
  if (op.direction === "inbound" && status.success && status.data !== "completed") {
    await ensureMissedCallHandoff(op.organizationId, op.id);
  }
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
  const bound = await boundOperation(req);
  if (!bound) {
    res.status(403).end();
    return;
  }
  const { op } = bound;
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
