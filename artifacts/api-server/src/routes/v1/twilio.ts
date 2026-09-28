import { randomBytes } from "node:crypto";
import { Router, type IRouter } from "express";
import { z } from "zod";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  db,
  contactsTable,
  consentRecordsTable,
  suppressionsTable,
  twilioConsentProofsTable,
  twilioDispatchesTable,
  twilioEnrollmentsTable,
  twilioInboundEventsTable,
} from "@workspace/db";
import { requireMember } from "../../middlewares/requireMember";
import { rateLimit } from "../../lib/rateLimit";
import {
  digest,
  phoneE164,
  twilioConfiguration,
  twilioRequestValid,
  SMS_DISCLOSURE_VERSION,
} from "../../services/twilio-controls";
import { sendTwilioSms } from "../../services/twilio-delivery";
import { normalizePhone, addSuppression } from "../../services/send-gate";
import { recordTouchDelivery } from "../../services/delivery-events";
import { recordAudit } from "../../services/audit";

const router: IRouter = Router();
const xml = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';
const stops = new Set([
  "STOP",
  "STOPALL",
  "UNSUBSCRIBE",
  "CANCEL",
  "END",
  "QUIT",
  "REVOKE",
  "OPTOUT",
]);
router.get("/public/sms/program", (_req, res) => {
  const config = twilioConfiguration();
  res.json({
    brand: "MogulForge",
    available: config.configured,
    enabled: config.enabled,
    sender: config.configured ? process.env.TWILIO_PHONE_NUMBER : null,
    disclosureVersion: SMS_DISCLOSURE_VERSION,
  });
});
router.post(
  "/public/sms/enroll",
  rateLimit({ windowMs: 60_000, max: 5, key: "sms-enroll" }),
  async (req, res) => {
    const config = twilioConfiguration();
    if (!config.configured) {
      res.status(503).json({ error: "Text enrollment is not open yet." });
      return;
    }
    const input = z
      .object({
        phone: z.string(),
        customerCare: z.boolean(),
        appointments: z.boolean(),
        ownPhone: z.literal(true),
        disclosureVersion: z.literal(SMS_DISCLOSURE_VERSION),
      })
      .strict()
      .safeParse(req.body);
    if (!input.success || !phoneE164(input.data.phone)) {
      res
        .status(400)
        .json({
          error:
            "Review the optional disclosures and enter your own US number.",
        });
      return;
    }
    const phone = phoneE164(input.data.phone)!,
      code = randomBytes(6).toString("hex").toUpperCase();
    // The phone must confirm from the handset; this request alone grants nothing.
    await db
      .insert(twilioEnrollmentsTable)
      .values({
        organizationId: config.organizationId,
        phone,
        challengeHash: digest(code),
        disclosureVersion: SMS_DISCLOSURE_VERSION,
        customerCare: input.data.customerCare,
        appointments: input.data.appointments,
        expiresAt: new Date(Date.now() + 86400000),
      })
      .onConflictDoUpdate({
        target: [
          twilioEnrollmentsTable.organizationId,
          twilioEnrollmentsTable.phone,
        ],
        set: {
          challengeHash: digest(code),
          disclosureVersion: SMS_DISCLOSURE_VERSION,
          customerCare: input.data.customerCare,
          appointments: input.data.appointments,
          expiresAt: new Date(Date.now() + 86400000),
        },
      });
    res.json({
      verificationText: `JOIN ${code}`,
      sender: process.env.TWILIO_PHONE_NUMBER,
    });
  },
);
router.post(
  "/public/sms/inbound",
  rateLimit({ windowMs: 60_000, max: 240, key: "twilio-inbound" }),
  async (req, res) => {
    const config = twilioConfiguration();
    if (
      !twilioRequestValid(req) ||
      req.body.To !== process.env.TWILIO_PHONE_NUMBER ||
      !/^SM[a-f0-9]{32}$/i.test(req.body.MessageSid ?? "")
    ) {
      res.status(403).json({ error: "Invalid Twilio request" });
      return;
    }
    const phone = phoneE164(req.body.From ?? "");
    if (!phone) {
      res.status(400).end();
      return;
    }
    const text = String(req.body.Body ?? "").trim(),
      word = text.toUpperCase();
    const eventType =
      req.body.OptOutType === "STOP" || stops.has(word)
        ? "STOP"
        : req.body.OptOutType === "START" || ["START", "UNSTOP"].includes(word)
          ? "START"
          : word.startsWith("JOIN ")
            ? "JOIN"
            : req.body.OptOutType === "HELP" || word === "HELP"
              ? "HELP"
              : "message";
    await db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`twilio-inbound:${config.organizationId}:${phone}`}))`,
      );
      const [seen] = await tx
        .select()
        .from(twilioInboundEventsTable)
        .where(eq(twilioInboundEventsTable.messageSid, req.body.MessageSid));
      if (seen) return;
      const contacts = await tx
        .select()
        .from(contactsTable)
        .where(
          and(
            eq(contactsTable.organizationId, config.organizationId),
            sql`regexp_replace(coalesce(${contactsTable.phone}, ''), '[^0-9]', '', 'g') IN (${phone.slice(1)}, ${phone.slice(2)})`,
          ),
        );
      await tx
        .insert(twilioInboundEventsTable)
        .values({
          messageSid: req.body.MessageSid,
          organizationId: config.organizationId,
          phone,
          eventType,
          body: eventType === "message" ? text.slice(0, 1600) : null,
          contactId: contacts.length === 1 ? contacts[0].id : null,
        });
      if (eventType === "STOP") {
        await tx
          .insert(suppressionsTable)
          .values({
            organizationId: config.organizationId,
            channel: "sms",
            value: normalizePhone(phone),
            reason: "stop_keyword",
            source: "twilio_inbound",
          })
          .onConflictDoNothing();
        await tx
          .delete(twilioEnrollmentsTable)
          .where(
            and(
              eq(twilioEnrollmentsTable.organizationId, config.organizationId),
              eq(twilioEnrollmentsTable.phone, phone),
            ),
          );
        for (const contact of contacts) {
          await tx
            .update(contactsTable)
            .set({ doNotContactSms: true })
            .where(eq(contactsTable.id, contact.id));
          await tx
            .insert(consentRecordsTable)
            .values({
              organizationId: config.organizationId,
              contactId: contact.id,
              channel: "sms",
              granted: false,
              disclosureVersion: SMS_DISCLOSURE_VERSION,
            });
          for (const purpose of ["customer_care", "appointments"])
            await tx
              .insert(twilioConsentProofsTable)
              .values({
                organizationId: config.organizationId,
                contactId: contact.id,
                phone,
                purpose,
                granted: false,
                disclosureVersion: SMS_DISCLOSURE_VERSION,
                source: "twilio:STOP",
              });
        }
      } else if (eventType === "START") {
        await tx
          .delete(suppressionsTable)
          .where(
            and(
              eq(suppressionsTable.organizationId, config.organizationId),
              eq(suppressionsTable.channel, "sms"),
              eq(suppressionsTable.value, normalizePhone(phone)),
              eq(suppressionsTable.reason, "stop_keyword"),
            ),
          );
        // No purpose is re-granted; return to the form for fresh consent.
      } else if (eventType === "JOIN" && contacts.length === 1) {
        const [pending] = await tx
          .select()
          .from(twilioEnrollmentsTable)
          .where(
            and(
              eq(twilioEnrollmentsTable.organizationId, config.organizationId),
              eq(twilioEnrollmentsTable.phone, phone),
            ),
          );
        const [suppressed] = await tx
          .select()
          .from(suppressionsTable)
          .where(
            and(
              eq(suppressionsTable.organizationId, config.organizationId),
              eq(suppressionsTable.channel, "sms"),
              eq(suppressionsTable.value, normalizePhone(phone)),
            ),
          );
        if (
          !pending ||
          suppressed ||
          pending.disclosureVersion !== SMS_DISCLOSURE_VERSION ||
          pending.expiresAt.getTime() <= Date.now() ||
          pending.challengeHash !== digest(word.slice(5).trim())
        )
          return;
        const contact = contacts[0];
        for (const [purpose, granted] of [
          ["customer_care", pending.customerCare],
          ["appointments", pending.appointments],
        ] as const)
          await tx
            .insert(twilioConsentProofsTable)
            .values({
              organizationId: config.organizationId,
              contactId: contact.id,
              phone,
              purpose,
              granted,
              disclosureVersion: SMS_DISCLOSURE_VERSION,
              source: "/sms-preferences.html + twilio:JOIN",
            });
        await tx
          .insert(consentRecordsTable)
          .values({
            organizationId: config.organizationId,
            contactId: contact.id,
            channel: "sms",
            granted: pending.customerCare || pending.appointments,
            disclosureVersion: SMS_DISCLOSURE_VERSION,
          });
        await tx
          .update(contactsTable)
          .set({
            doNotContactSms: !pending.customerCare && !pending.appointments,
          })
          .where(eq(contactsTable.id, contact.id));
        await tx
          .delete(twilioEnrollmentsTable)
          .where(eq(twilioEnrollmentsTable.id, pending.id));
      }
    });
    res.type("text/xml").send(xml);
  },
);
router.post(
  "/public/sms/status",
  rateLimit({ windowMs: 60_000, max: 240, key: "twilio-status" }),
  async (req, res) => {
    const config = twilioConfiguration(),
      id = z.uuid().safeParse(req.query.operation);
    if (
      !id.success ||
      !twilioRequestValid(req) ||
      req.body.From !== process.env.TWILIO_PHONE_NUMBER
    ) {
      res.status(403).end();
      return;
    }
    const [operation] = await db
      .select()
      .from(twilioDispatchesTable)
      .where(
        and(
          eq(twilioDispatchesTable.id, id.data),
          eq(twilioDispatchesTable.organizationId, config.organizationId),
          eq(twilioDispatchesTable.accountSid, req.body.AccountSid),
        ),
      );
    const sid = req.body.MessageSid,
      status = req.body.MessageStatus,
      code = /^\d{4,6}$/.test(req.body.ErrorCode ?? "")
        ? req.body.ErrorCode
        : null;
    if (
      !operation ||
      operation.phone !== phoneE164(req.body.To ?? "") ||
      !/^SM[a-f0-9]{32}$/i.test(sid ?? "") ||
      (operation.providerSid && operation.providerSid !== sid)
    ) {
      res.status(404).end();
      return;
    }
    const ranks: Record<string, number> = {
      dispatching: 0,
      uncertain: 0,
      accepted: 1,
      queued: 2,
      sending: 3,
      sent: 4,
      delivered: 5,
      undelivered: 5,
      failed: 5,
    };
    if (
      status in ranks &&
      ranks[status] >= (ranks[operation.status] ?? 0) &&
      !["delivered", "undelivered", "failed", "cancelled"].includes(
        operation.status,
      )
    ) {
      const changed = await db
        .update(twilioDispatchesTable)
        .set({
          providerSid: sid,
          status,
          errorCode: code,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(twilioDispatchesTable.id, operation.id),
            sql`(${twilioDispatchesTable.providerSid} IS NULL OR ${twilioDispatchesTable.providerSid}=${sid})`,
            sql`${twilioDispatchesTable.status} NOT IN ('delivered','undelivered','failed','cancelled')`,
            sql`CASE ${twilioDispatchesTable.status} WHEN 'accepted' THEN 1 WHEN 'queued' THEN 2 WHEN 'sending' THEN 3 WHEN 'sent' THEN 4 ELSE 0 END <= ${ranks[status]}`,
          ),
        )
        .returning({ id: twilioDispatchesTable.id });
      if (changed.length && status === "delivered")
        await recordTouchDelivery({
          providerMessageId: sid,
          signal: "delivered",
        });
      if (changed.length && ["failed", "undelivered"].includes(status))
        await recordTouchDelivery({
          providerMessageId: sid,
          signal: "bounced",
          detail: code ?? status,
        });
    }
    if (["21610", "21211", "21614"].includes(code ?? ""))
      await addSuppression({
        organizationId: config.organizationId,
        channel: "sms",
        value: operation.phone,
        reason: code === "21610" ? "stop_keyword" : "invalid",
        source: "twilio_status",
      });
    res.status(204).end();
  },
);
router.get(
  "/communications/sms",
  requireMember("crm.read"),
  async (req, res) => {
    const organizationId = req.member!.organizationId,
      config = twilioConfiguration();
    const inbound = await db
      .select()
      .from(twilioInboundEventsTable)
      .where(eq(twilioInboundEventsTable.organizationId, organizationId))
      .orderBy(desc(twilioInboundEventsTable.receivedAt))
      .limit(50);
    const outbound = await db
      .select()
      .from(twilioDispatchesTable)
      .where(eq(twilioDispatchesTable.organizationId, organizationId))
      .orderBy(desc(twilioDispatchesTable.createdAt))
      .limit(50);
    const day = new Date();
    day.setUTCHours(0, 0, 0, 0);
    const [usage] = await db
      .select({
        operations: sql<number>`count(*)::int`,
        uncertain: sql<number>`count(*) FILTER (WHERE status IN ('uncertain','dispatching'))::int`,
        failed: sql<number>`count(*) FILTER (WHERE status IN ('failed','undelivered','rate_limited'))::int`,
      })
      .from(twilioDispatchesTable)
      .where(
        and(
          eq(twilioDispatchesTable.organizationId, organizationId),
          sql`${twilioDispatchesTable.createdAt}>=${day.toISOString()}`,
        ),
      );
    res.json({
      enabled: config.enabled && config.organizationId === organizationId,
      inbound,
      outbound,
      usage: {
        ...usage,
        limit: config.organizationId === organizationId ? config.dailyLimit : 0,
        warning:
          config.dailyLimit > 0 && usage.operations >= config.dailyLimit * 0.8,
      },
    });
  },
);
router.post(
  "/communications/sms",
  requireMember("crm.write"),
  rateLimit({ windowMs: 60_000, max: 10, key: "sms-app-send" }),
  async (req, res) => {
    if (
      !req.header("x-api-key") &&
      req.header("origin") !== process.env.APP_ORIGIN
    ) {
      res.status(403).json({ error: "Request origin was not accepted." });
      return;
    }
    const input = z
      .object({
        contactId: z.uuid(),
        body: z.string().trim().min(1).max(1000),
        requestId: z.uuid(),
      })
      .strict()
      .safeParse(req.body);
    if (!input.success) {
      res.status(400).json({ error: "Choose a contact and enter a message." });
      return;
    }
    const organizationId = req.member!.organizationId;
    const [contact] = await db
      .select()
      .from(contactsTable)
      .where(
        and(
          eq(contactsTable.id, input.data.contactId),
          eq(contactsTable.organizationId, organizationId),
        ),
      );
    if (!contact?.phone) {
      res.status(404).json({ error: "Contact not found." });
      return;
    }
    try {
      const receipt = await sendTwilioSms(contact.phone, input.data.body, {
        organizationId,
        contactId: contact.id,
        purpose: "customer_care",
        idempotencyKey: `reply:${input.data.requestId}`,
      });
      await recordAudit({
        organizationId,
        action: "communications.sms",
        entityType: "contact",
        entityId: contact.id,
        metadata: { provider: receipt.provider, providerMessageId: receipt.id },
      });
      res.status(202).json(receipt);
    } catch (error) {
      res
        .status(409)
        .json({
          error:
            error instanceof Error ? error.message : "SMS was not confirmed.",
        });
    }
  },
);
export default router;
