import { and, asc, desc, eq, gte, sql } from "drizzle-orm";
import {
  db,
  contactsTable,
  twilioConsentProofsTable,
  twilioDispatchesTable,
} from "@workspace/db";
import { addSuppression, checkSendEligibility } from "./send-gate";
import { assertOutboundDeliveryAllowed } from "./outbound-hold";
import {
  digest,
  phoneE164,
  twilioForOrganization,
  type SmsSendContext,
} from "./twilio-controls";

export async function sendTwilioSms(
  to: string,
  body: string,
  context?: SmsSendContext,
  beforeDispatch?: () => Promise<void>,
) {
  assertOutboundDeliveryAllowed();
  const phone = phoneE164(to);
  if (!context?.organizationId)
    throw new Error("Twilio tenant and operation context required");
  const config = await twilioForOrganization(context.organizationId);
  if (!config?.smsEnabled)
    throw new Error(
      "Twilio sending is disabled: approved registration, credentials, routing and an explicit daily limit are required",
    );
  if (
    !context.contactId ||
    !context.idempotencyKey ||
    context.idempotencyKey.length > 300
  )
    throw new Error("Twilio tenant and operation context required");
  if (!phone || !body.trim() || body.length > 1200)
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
    .orderBy(desc(twilioConsentProofsTable.recordedAt), asc(twilioConsentProofsTable.granted))
    .limit(1);
  if (!proof?.granted || proof.disclosureVersion !== config.smsDisclosureVersion)
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
  const message = `${config.businessName}: ${body.trim()}\nReply STOP to opt out. HELP for help.`;
  const payloadHash = digest(
    JSON.stringify({
      phone,
      message,
      purpose: context.purpose,
      contactId: contact.id,
      accountSid: config.accountSid,
      sender: config.phoneNumber,
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
    if (usage.count >= config.dailySmsLimit)
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
        accountSid: config.accountSid,
      })
      .returning();
    return { ...created, owned: true };
  });
  if (!operation.owned) {
    if (operation.accountSid !== config.accountSid || operation.phone !== phone)
      throw new Error("SMS operation belongs to a different sender or recipient");
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
  let dispatched = false;
  try {
    // The workflow's approval may have changed while ownership was acquired.
    await beforeDispatch?.();
    const current = await twilioForOrganization(context.organizationId);
    if (!current?.smsEnabled || current.id !== config.id ||
        current.accountSid !== config.accountSid ||
        current.phoneNumber !== config.phoneNumber ||
        current.messagingServiceSid !== config.messagingServiceSid ||
        current.origin !== config.origin || current.businessName !== config.businessName ||
        current.smsDisclosureVersion !== config.smsDisclosureVersion ||
        current.dailySmsLimit !== config.dailySmsLimit) {
      await db.update(twilioDispatchesTable)
        .set({ status: "cancelled", updatedAt: new Date() })
        .where(eq(twilioDispatchesTable.id, operation.id));
      throw new Error("SMS cancelled because the client binding is disabled or changed");
    }
    const [freshContact] = await db.select().from(contactsTable).where(and(
      eq(contactsTable.organizationId, context.organizationId), eq(contactsTable.id, context.contactId),
    ));
    const [freshProof] = await db.select().from(twilioConsentProofsTable).where(and(
      eq(twilioConsentProofsTable.organizationId, context.organizationId),
      eq(twilioConsentProofsTable.contactId, context.contactId),
      eq(twilioConsentProofsTable.phone, phone), eq(twilioConsentProofsTable.purpose, context.purpose),
    )).orderBy(desc(twilioConsentProofsTable.recordedAt), asc(twilioConsentProofsTable.granted)).limit(1);
    if (!freshContact || phoneE164(freshContact.phone ?? "") !== phone ||
        !freshProof?.granted || freshProof.id !== proof.id ||
        freshProof.disclosureVersion !== current.smsDisclosureVersion)
      throw new Error("SMS cancelled because its recipient or purpose consent changed");
    // Re-read contact flags as well as STOP immediately before network handoff.
    const latest = await checkSendEligibility({
      organizationId: context.organizationId,
      contact: freshContact,
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
    assertOutboundDeliveryAllowed();
    dispatched = true;
    const response = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${current.accountSid}/Messages.json`,
      {
        method: "POST",
        // A 307/308 must not replay this irreversible POST outside our guard.
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          authorization: `Basic ${Buffer.from(`${current.apiKeySid}:${current.apiKeySecret}`).toString("base64")}`,
        },
        body: new URLSearchParams({
          To: phone,
          MessagingServiceSid: current.messagingServiceSid!,
          Body: message,
          StatusCallback: `${current.origin}/api/v1/public/sms/status?operation=${operation.id}`,
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
      .set({ status: dispatched ? "uncertain" : "cancelled", updatedAt: new Date() })
      .where(
        and(
          eq(twilioDispatchesTable.id, operation.id),
          eq(twilioDispatchesTable.status, "dispatching"),
        ),
      );
    throw error;
  }
}
