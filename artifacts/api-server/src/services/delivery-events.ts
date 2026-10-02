/**
 * Delivery signals for outbound outreach: provider webhooks (Resend email
 * events, Twilio SMS status callbacks) and opt-out flows feed each touch's
 * delivery column in playbook_touches, flip the contact's per-channel
 * do-not-contact flag on hard bounces / unsubscribes, suppress the address,
 * and surface the event on the lead timeline.
 */
import {
  activitiesTable,
  auditEventsTable,
  contactsTable,
  db,
  leadsTable,
  playbookTouchesTable,
  suppressionsTable,
  type PlaybookTouch,
  type SuppressionReason,
} from "@workspace/db";
import { and, eq, inArray, isNull, or } from "drizzle-orm";

import { recordAudit } from "./audit";
import {
  addSuppression,
  normalizeAddress,
  type SendChannel,
} from "./send-gate";

export type DeliverySignal =
  "delivered" | "bounced" | "unsubscribed" | "delayed" | "failed";

type ProviderDeliveryCorrelation = {
  providerMessageId: string;
  address: string;
} & (
  | { provider: "resend"; channel: "email"; organizationId?: string }
  | { provider: "twilio"; channel: "sms"; organizationId: string }
);

type DeliveryDatabase = Pick<typeof db, "select" | "update" | "insert">;

/**
 * A provider ID alone is not tenant authority. Bind it to exactly one touch,
 * the expected provider/channel, same-tenant lead/contact, and recipient.
 * Resend cannot choose an organization using an untrusted payload address.
 * Ambiguous IDs and changed/deleted contact addresses require reconciliation.
 */
async function findCorrelatedTouch(
  tx: DeliveryDatabase,
  input: ProviderDeliveryCorrelation,
) {
  if (!input.providerMessageId || !input.address) return null;
  const candidates = await tx
    .select({ touch: playbookTouchesTable, contact: contactsTable })
    .from(playbookTouchesTable)
    .innerJoin(
      leadsTable,
      and(
        eq(leadsTable.id, playbookTouchesTable.leadId),
        eq(leadsTable.organizationId, playbookTouchesTable.organizationId),
      ),
    )
    .innerJoin(
      contactsTable,
      and(
        eq(contactsTable.id, leadsTable.contactId),
        eq(contactsTable.organizationId, playbookTouchesTable.organizationId),
      ),
    )
    .where(
      and(
        eq(playbookTouchesTable.providerMessageId, input.providerMessageId),
        eq(playbookTouchesTable.provider, input.provider),
        eq(playbookTouchesTable.channel, input.channel),
        input.organizationId
          ? eq(playbookTouchesTable.organizationId, input.organizationId)
          : undefined,
      ),
    )
    .limit(2)
    .for("update");
  if (candidates.length !== 1) return null;
  const candidate = candidates[0];
  const currentAddress =
    input.channel === "email"
      ? candidate.contact.email
      : candidate.contact.phone;
  if (
    !currentAddress ||
    normalizeAddress(input.channel, currentAddress) !==
      normalizeAddress(input.channel, input.address)
  )
    return null;
  return candidate;
}

function channelNoun(channel: SendChannel): string {
  return channel === "email" ? "email" : "text";
}

/**
 * Persist a monotonic delivery transition and its timeline evidence together.
 * Temporary failures can recover to delivered; permanent bounce and complaint
 * states cannot be overwritten by a late delivery. Replays are no-ops.
 */
async function applyTouchDelivery(
  tx: DeliveryDatabase,
  existing: PlaybookTouch,
  input: { providerMessageId: string; signal: DeliverySignal; detail?: string },
): Promise<PlaybookTouch> {
  const { providerMessageId, signal, detail } = input;
  const priorStates: Record<DeliverySignal, string[]> = {
    delivered: ["delayed", "failed"],
    delayed: [],
    failed: ["delayed"],
    bounced: ["delivered", "delayed", "failed"],
    unsubscribed: ["delivered", "delayed", "failed", "bounced"],
  };
  const [touch] = await tx
    .update(playbookTouchesTable)
    .set({ delivery: signal, deliveryAt: new Date() })
    .where(
      and(
        eq(playbookTouchesTable.id, existing.id),
        eq(playbookTouchesTable.organizationId, existing.organizationId),
        or(
          isNull(playbookTouchesTable.delivery),
          inArray(playbookTouchesTable.delivery, priorStates[signal]),
        ),
      ),
    )
    .returning();
  if (!touch) return existing;

  if (signal !== "delivered") {
    const channel = touch.channel as SendChannel;
    const activity = {
      bounced: {
        type: "message_bounced",
        title: `Outreach ${channelNoun(channel)} bounced`,
      },
      unsubscribed: {
        type: "message_unsubscribed",
        title: `Recipient unsubscribed from automated ${channelNoun(channel)}s`,
      },
      delayed: {
        type: "message_delivery_delayed",
        title: `Outreach ${channelNoun(channel)} delivery delayed`,
      },
      failed: {
        type: "message_delivery_failed",
        title: `Outreach ${channelNoun(channel)} delivery needs review`,
      },
    }[signal];
    await tx.insert(activitiesTable).values({
      organizationId: touch.organizationId,
      leadId: touch.leadId,
      ...activity,
      metadata: {
        channel,
        provider: touch.provider,
        providerMessageId,
        stepIndex: touch.stepIndex,
        detail: detail ?? null,
      },
    });
  }
  return touch;
}

export async function recordTouchDelivery(
  input: ProviderDeliveryCorrelation & {
    signal: DeliverySignal;
    detail?: string;
  },
): Promise<PlaybookTouch | null> {
  return db.transaction(async (tx) => {
    const match = await findCorrelatedTouch(tx, input);
    return match ? applyTouchDelivery(tx, match.touch, input) : null;
  });
}

/**
 * Flip a contact's per-channel do-not-contact flag and suppress their
 * current address on that channel. Idempotent; never throws (a webhook must
 * always be ACKed). Used by bounce webhooks and both unsubscribe flows.
 */
export async function suppressChannelForContact(input: {
  organizationId: string;
  contactId: string;
  channel: SendChannel;
  reason: SuppressionReason;
  source: string;
  detail?: string;
}): Promise<void> {
  const { organizationId, contactId, channel, reason, source, detail } = input;
  try {
    const [contact] = await db
      .update(contactsTable)
      .set(
        channel === "email"
          ? { doNotContactEmail: true }
          : { doNotContactSms: true },
      )
      .where(
        and(
          eq(contactsTable.id, contactId),
          eq(contactsTable.organizationId, organizationId),
        ),
      )
      .returning();
    if (!contact) return;
    const address = channel === "email" ? contact.email : contact.phone;
    if (address) {
      await addSuppression({
        organizationId,
        channel,
        value: address,
        reason,
        source,
        detail,
      });
    }
    await recordAudit({
      organizationId,
      action: "send.channel_suppressed",
      entityType: "contact",
      entityId: contactId,
      metadata: { channel, reason, source },
    });
  } catch (err) {
    console.error("[delivery-events] suppressChannelForContact failed:", err);
  }
}

/**
 * Contact-initiated opt-out (unsubscribe link, SMS STOP): flip the channel
 * DNC flag, suppress the address, mark the contact's outstanding touches on
 * that channel as unsubscribed, and put the opt-out on each lead's timeline.
 * Never throws.
 */
export async function recordContactOptOut(input: {
  organizationId: string;
  contactId: string;
  channel: SendChannel;
  source: string;
}): Promise<void> {
  const { organizationId, contactId, channel, source } = input;
  try {
    await suppressChannelForContact({
      organizationId,
      contactId,
      channel,
      reason: channel === "email" ? "unsubscribed" : "stop_keyword",
      source,
    });
    const leads = await db
      .select({ id: leadsTable.id })
      .from(leadsTable)
      .where(
        and(
          eq(leadsTable.organizationId, organizationId),
          eq(leadsTable.contactId, contactId),
        ),
      );
    const leadIds = leads.map((l) => l.id);
    if (leadIds.length === 0) return;
    const now = new Date();
    await db
      .update(playbookTouchesTable)
      .set({ delivery: "unsubscribed", deliveryAt: now })
      .where(
        and(
          eq(playbookTouchesTable.organizationId, organizationId),
          inArray(playbookTouchesTable.leadId, leadIds),
          eq(playbookTouchesTable.channel, channel),
          or(
            isNull(playbookTouchesTable.delivery),
            eq(playbookTouchesTable.delivery, "delivered"),
          ),
        ),
      );
    for (const leadId of leadIds) {
      await db.insert(activitiesTable).values({
        organizationId,
        leadId,
        contactId,
        type: "message_unsubscribed",
        title:
          channel === "email"
            ? "Recipient unsubscribed from automated emails"
            : "Recipient texted STOP — automated texts stopped",
        metadata: { channel, source },
      });
    }
  } catch (err) {
    console.error("[delivery-events] recordContactOptOut failed:", err);
  }
}

/**
 * Persist a permanent failure/complaint and its tenant-scoped suppression in
 * one transaction. Errors must propagate so the provider retries; never ACK a
 * partially saved suppression. Unknown IDs do not authorize address lookups.
 */
export async function handleBounce(
  input: ProviderDeliveryCorrelation & {
    reason: "hard_bounce" | "unsubscribed";
    source: string;
    detail?: string;
  },
): Promise<void> {
  await db.transaction(async (tx) => {
    const match = await findCorrelatedTouch(tx, input);
    if (!match) return;
    const { contact } = match;
    const touch = await applyTouchDelivery(tx, match.touch, {
      ...input,
      signal: input.reason === "unsubscribed" ? "unsubscribed" : "bounced",
    });
    await tx
      .update(contactsTable)
      .set(
        input.channel === "email"
          ? { doNotContactEmail: true }
          : { doNotContactSms: true },
      )
      .where(
        and(
          eq(contactsTable.id, contact.id),
          eq(contactsTable.organizationId, touch.organizationId),
        ),
      );
    const inserted = await tx
      .insert(suppressionsTable)
      .values({
        organizationId: touch.organizationId,
        channel: input.channel,
        value: normalizeAddress(input.channel, input.address),
        reason: input.reason,
        source: input.source,
        detail: input.detail ?? null,
      })
      .onConflictDoNothing()
      .returning({ id: suppressionsTable.id });
    const alreadyBlocked =
      input.channel === "email"
        ? contact.doNotContactEmail
        : contact.doNotContactSms;
    if (inserted.length || !alreadyBlocked) {
      await tx.insert(auditEventsTable).values({
        organizationId: touch.organizationId,
        action: "send.channel_suppressed",
        entityType: "contact",
        entityId: contact.id,
        metadata: {
          channel: input.channel,
          reason: input.reason,
          source: input.source,
          provider: input.provider,
          providerMessageId: input.providerMessageId,
        },
      });
    }
  });
}

/**
 * Twilio error codes that mean the NUMBER itself is permanently
 * unreachable (invalid, landline, carrier-blocked). Transient failures
 * (device off, network congestion) must NOT poison the number.
 */
const TWILIO_PERMANENT_ERROR_CODES = new Set([
  "21211", // invalid 'To' number
  "21610", // recipient on Twilio's STOP list
  "21614", // not a mobile number
  "30004", // blocked by recipient/carrier
  "30005", // unknown destination
  "30006", // landline / unreachable carrier
]);

export function isPermanentTwilioError(errorCode: string | undefined): boolean {
  return Boolean(errorCode && TWILIO_PERMANENT_ERROR_CODES.has(errorCode));
}
