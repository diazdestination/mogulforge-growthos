import { and, desc, eq, gte, sql } from "drizzle-orm";
import {
  db,
  contactsTable,
  twilioConsentProofsTable,
  twilioDispatchesTable,
} from "@workspace/db";
import { addSuppression, checkSendEligibility } from "./send-gate";
import {
  digest,
  phoneE164,
  twilioConfiguration,
  SMS_DISCLOSURE_VERSION,
  type SmsSendContext,
} from "./twilio-controls";

export async function sendTwilioSms(
  to: string,
  body: string,
  context?: SmsSendContext,
) {
  const config = twilioConfiguration(),
    phone = phoneE164(to);
  if (!config.enabled)
    throw new Error(
      "Twilio sending is disabled: approved registration, credentials, routing and an explicit daily limit are required",
    );
  if (
    !context ||
    context.organizationId !== config.organizationId ||
    !context.contactId ||
    !context.idempotencyKey ||
    context.idempotencyKey.length > 300
  )
    throw new Error("Twilio tenant and operation context required");
  if (!phone || body.length > 1200)
    throw new Error("SMS phone or message is invalid");
  // Legacy marketing and portal authentication flows require their own reviewed
  // purpose/registration; they cannot borrow customer-care consent.
  if (!["customer_care", "appointments"].includes(context.purpose))
    throw new Error("This SMS purpose is not enabled for the initial program");
  const [contact] = await db
    .select()
    .from(contactsTable)
    .where(
      and(
        eq(contactsTable.organizationId, context.organizationId),
        eq(contactsTable.id, context.contactId),
      ),
    );
  if (!contact || phoneE164(contact.phone ?? "") !== phone)
    throw new Error("SMS recipient is outside this organization or changed");
  const [proof] = await db
    .select()
    .from(twilioConsentProofsTable)
    .where(
      and(
        eq(twilioConsentProofsTable.organizationId, context.organizationId),
        eq(twilioConsentProofsTable.contactId, context.contactId),
        eq(twilioConsentProofsTable.phone, phone),
        eq(twilioConsentProofsTable.purpose, context.purpose),
      ),
    )
    .orderBy(desc(twilioConsentProofsTable.recordedAt))
    .limit(1);
  if (!proof?.granted || proof.disclosureVersion !== SMS_DISCLOSURE_VERSION)
    throw new Error(
      "Current phone-verified consent for this SMS purpose is required",
    );
  const eligibility = await checkSendEligibility({
    organizationId: context.organizationId,
    contact,
    channel: "sms",
    kind: "transactional",
  });
  if (!eligibility.ok) throw new Error(`SMS blocked: ${eligibility.reason}`);
  const message = `MogulForge: ${body.replace(/^MogulForge:\s*/i, "")}\nReply STOP to opt out. HELP for help.`;
  const payloadHash = digest(
    JSON.stringify({
      phone,
      message,
      purpose: context.purpose,
      contactId: contact.id,
    }),
  );
  const operation = await db.transaction(async (tx) => {
    // Serialize the daily allowance and ownership claim across processes.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`twilio:${context.organizationId}`}))`,
    );
    const [existing] = await tx
      .select()
      .from(twilioDispatchesTable)
      .where(
        and(
          eq(twilioDispatchesTable.organizationId, context.organizationId),
          eq(twilioDispatchesTable.idempotencyKey, context.idempotencyKey),
        ),
      );
    if (existing) {
      if (existing.payloadHash !== payloadHash)
        throw new Error("SMS operation key was reused with different content");
      return { ...existing, owned: false };
    }
    const day = new Date();
    day.setUTCHours(0, 0, 0, 0);
    const [usage] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(twilioDispatchesTable)
      .where(
        and(
          eq(twilioDispatchesTable.organizationId, context.organizationId),
          gte(twilioDispatchesTable.createdAt, day),
        ),
      );
    if (usage.count >= config.dailyLimit)
      throw new Error("SMS daily operation limit reached");
    const [created] = await tx
      .insert(twilioDispatchesTable)
      .values({
        organizationId: context.organizationId,
        contactId: contact.id,
        idempotencyKey: context.idempotencyKey,
        payloadHash,
        phone,
        purpose: context.purpose,
        accountSid: process.env.TWILIO_ACCOUNT_SID!,
      })
      .returning();
    return { ...created, owned: true };
  });
  if (!operation.owned) {
    if (
      operation.providerSid &&
      ["accepted", "queued", "sending", "sent", "delivered"].includes(
        operation.status,
      )
    )
      return { id: operation.providerSid, provider: "twilio" };
    throw new Error(
      `SMS operation is ${operation.status}; inspect the receipt before any new attempt`,
    );
  }
  try {
    // Recheck STOP immediately before handing the request to the network.
    const latest = await checkSendEligibility({
      organizationId: context.organizationId,
      contact,
      channel: "sms",
      kind: "transactional",
    });
    if (!latest.ok) {
      await db
        .update(twilioDispatchesTable)
        .set({ status: "cancelled", updatedAt: new Date() })
        .where(eq(twilioDispatchesTable.id, operation.id));
      throw new Error("SMS cancelled by current consent/suppression policy");
    }
    const response = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}/Messages.json`,
      {
        method: "POST",
        signal: AbortSignal.timeout(10_000),
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          authorization: `Basic ${Buffer.from(`${process.env.TWILIO_API_KEY_SID}:${process.env.TWILIO_API_KEY_SECRET}`).toString("base64")}`,
        },
        body: new URLSearchParams({
          To: phone,
          MessagingServiceSid: process.env.TWILIO_MESSAGING_SERVICE_SID!,
          Body: message,
          StatusCallback: `${config.origin}/api/v1/public/sms/status?operation=${operation.id}`,
        }).toString(),
      },
    );
    if (!response.ok) {
      const data = (await response.json().catch(() => ({}))) as {
        code?: number;
      };
      const errorCode = Number.isSafeInteger(data.code)
        ? String(data.code)
        : String(response.status);
      if (["21610", "21211", "21614"].includes(errorCode))
        await addSuppression({
          organizationId: context.organizationId,
          channel: "sms",
          value: phone,
          reason: errorCode === "21610" ? "stop_keyword" : "invalid",
          source: "twilio_api",
        });
      await db
        .update(twilioDispatchesTable)
        .set({
          status:
            response.status >= 500
              ? "uncertain"
              : response.status === 429
                ? "rate_limited"
                : "failed",
          errorCode,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(twilioDispatchesTable.id, operation.id),
            eq(twilioDispatchesTable.status, "dispatching"),
          ),
        );
      throw new Error(
        `Twilio send failed: ${response.status}; code=${errorCode}`,
      );
    }
    const result = (await response.json()) as { sid?: string };
    if (!/^SM[a-f0-9]{32}$/i.test(result.sid ?? ""))
      throw new Error("Twilio returned no valid message SID");
    await db
      .update(twilioDispatchesTable)
      .set({
        providerSid: result.sid,
        status: "accepted",
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(twilioDispatchesTable.id, operation.id),
          eq(twilioDispatchesTable.status, "dispatching"),
        ),
      );
    return { id: result.sid!, provider: "twilio" };
  } catch (error) {
    await db
      .update(twilioDispatchesTable)
      .set({ status: "uncertain", updatedAt: new Date() })
      .where(
        and(
          eq(twilioDispatchesTable.id, operation.id),
          eq(twilioDispatchesTable.status, "dispatching"),
        ),
      );
    throw error;
  }
}
