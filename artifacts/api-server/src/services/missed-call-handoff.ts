import { createHash } from "node:crypto";
import {
  auditEventsTable,
  contactsTable,
  crmTasksTable,
  db,
  leadsTable,
  missedCallHandoffsTable,
  twilioCallsTable,
} from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";
import { phoneE164 } from "./twilio-controls";

const MISSED_STATUSES = new Set(["busy", "no-answer", "failed", "canceled"]);

/**
 * A signed inbound voice callback creates exactly one staff task. It does not
 * create an opportunity, enroll a playbook, or send a text. The phone number
 * remains in call history even when no matching contact exists.
 */
export async function ensureMissedCallHandoff(organizationId: string, callId: string) {
  return db.transaction(async (tx) => {
    const [call] = await tx
      .select()
      .from(twilioCallsTable)
      .where(and(eq(twilioCallsTable.id, callId), eq(twilioCallsTable.organizationId, organizationId)))
      .for("update");
    if (!call || call.direction !== "inbound" || !MISSED_STATUSES.has(call.dialStatus ?? "")) {
      return null;
    }
    const [existing] = await tx
      .select()
      .from(missedCallHandoffsTable)
      .where(eq(missedCallHandoffsTable.callId, call.id));
    if (existing) return existing;

    const [task] = await tx
      .insert(crmTasksTable)
      .values({
        organizationId,
        contactId: call.contactId,
        title: "Return missed call",
        description: `Inbound call from ${call.phone} was not connected. Review and call back.`,
        sourceEvent: "voice.missed_call",
        priority: "high",
        dueAt: new Date(),
      })
      .returning();
    const [handoff] = await tx
      .insert(missedCallHandoffsTable)
      .values({ organizationId, callId: call.id, taskId: task.id, contactId: call.contactId })
      .returning();
    await tx.insert(auditEventsTable).values({
      organizationId,
      action: "voice.missed_call_task_created",
      entityType: "twilio_call",
      entityId: call.id,
      metadata: { taskId: task.id },
    });
    return handoff;
  });
}

export type MissedCallReviewInput =
  | { requestId: string; action: "link_contact"; contactId: string }
  | {
      requestId: string;
      action: "create_opportunity";
      contactId?: string;
      firstName?: string;
      lastName?: string;
      serviceType?: string;
    };

type ReviewError =
  | "not_found"
  | "not_missed"
  | "already_reviewed"
  | "invalid_contact"
  | "choose_existing_contact"
  | "first_name_required";

export async function reviewMissedCall(
  organizationId: string,
  callId: string,
  actorUserId: string,
  input: MissedCallReviewInput,
): Promise<{ handoff: typeof missedCallHandoffsTable.$inferSelect; leadCreated: boolean } | { error: ReviewError }> {
  const normalized = {
    action: input.action,
    contactId: input.contactId ?? null,
    firstName: input.action === "create_opportunity" ? input.firstName?.trim() ?? null : null,
    lastName: input.action === "create_opportunity" ? input.lastName?.trim() ?? null : null,
    serviceType: input.action === "create_opportunity" ? input.serviceType?.trim() ?? null : null,
  };
  const payloadHash = createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
  return db.transaction(async (tx) => {
    const [call] = await tx
      .select()
      .from(twilioCallsTable)
      .where(and(eq(twilioCallsTable.id, callId), eq(twilioCallsTable.organizationId, organizationId)))
      .for("update");
    if (!call) return { error: "not_found" as const };
    if (call.direction !== "inbound" || !MISSED_STATUSES.has(call.dialStatus ?? "")) {
      return { error: "not_missed" as const };
    }
    const [handoff] = await tx
      .select()
      .from(missedCallHandoffsTable)
      .where(and(eq(missedCallHandoffsTable.callId, call.id), eq(missedCallHandoffsTable.organizationId, organizationId)))
      .for("update");
    if (!handoff) return { error: "not_found" as const };
    if (handoff.reviewedAt) {
      return handoff.reviewRequestId === input.requestId && handoff.reviewPayloadHash === payloadHash
        ? { handoff, leadCreated: Boolean(handoff.leadId) }
        : { error: "already_reviewed" as const };
    }

    let contactId = input.contactId ?? call.contactId;
    if (contactId) {
      const [contact] = await tx
        .select()
        .from(contactsTable)
        .where(and(eq(contactsTable.id, contactId), eq(contactsTable.organizationId, organizationId)));
      if (!contact || phoneE164(contact.phone ?? "") !== call.phone) {
        return { error: "invalid_contact" as const };
      }
    } else if (input.action === "create_opportunity") {
      const matches = await tx
        .select({ id: contactsTable.id })
        .from(contactsTable)
        .where(
          and(
            eq(contactsTable.organizationId, organizationId),
            sql`regexp_replace(coalesce(${contactsTable.phone}, ''), '[^0-9]', '', 'g') IN (${call.phone.slice(1)}, ${call.phone.slice(2)})`,
          ),
        )
        .limit(1);
      if (matches.length) return { error: "choose_existing_contact" as const };
      if (!normalized.firstName) return { error: "first_name_required" as const };
      const [created] = await tx
        .insert(contactsTable)
        .values({
          organizationId,
          firstName: normalized.firstName.slice(0, 100),
          lastName: normalized.lastName?.slice(0, 100) ?? null,
          phone: call.phone,
        })
        .returning({ id: contactsTable.id });
      contactId = created.id;
    }
    if (!contactId) return { error: "invalid_contact" as const };

    let leadId: string | null = null;
    if (input.action === "create_opportunity") {
      const [lead] = await tx
        .insert(leadsTable)
        .values({
          organizationId,
          contactId,
          assignedUserId: actorUserId,
          status: "new",
          serviceType: normalized.serviceType?.slice(0, 100) ?? null,
          source: "missed-call",
          latestSource: "missed-call",
          creationMethod: "staff_review",
          summary: "Staff-reviewed missed inbound call; follow-up required.",
        })
        .returning({ id: leadsTable.id });
      leadId = lead.id;
    }
    await tx
      .update(twilioCallsTable)
      .set({ contactId, updatedAt: new Date() })
      .where(eq(twilioCallsTable.id, call.id));
    await tx
      .update(crmTasksTable)
      .set({ contactId, leadId, assignedUserId: actorUserId })
      .where(eq(crmTasksTable.id, handoff.taskId));
    const [reviewed] = await tx
      .update(missedCallHandoffsTable)
      .set({
        contactId,
        leadId,
        reviewRequestId: input.requestId,
        reviewPayloadHash: payloadHash,
        reviewedByUserId: actorUserId,
        reviewedAt: new Date(),
      })
      .where(eq(missedCallHandoffsTable.id, handoff.id))
      .returning();
    await tx.insert(auditEventsTable).values({
      organizationId,
      actorUserId,
      action: `voice.missed_call_${input.action}`,
      entityType: "twilio_call",
      entityId: call.id,
      metadata: { contactId, leadId, taskId: handoff.taskId },
    });
    // No lead.created event here: that could auto-enroll outreach and send to
    // a caller who has not granted a purpose-specific SMS or marketing opt-in.
    return { handoff: reviewed, leadCreated: Boolean(leadId) };
  });
}
