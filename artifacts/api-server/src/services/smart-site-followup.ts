import { createHash } from "node:crypto";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  db,
  leadsTable,
  contactsTable,
  usersTable,
  crmTasksTable,
  activitiesTable,
  auditEventsTable,
  smartSitesTable,
  smartSiteSubmissionsTable as receipts,
  smartSiteFollowupsTable as attempts,
} from "@workspace/db";
import { SmartSiteError } from "./smart-sites";
import { hasPermission } from "../lib/permissions";

const active = sql`${leadsTable.status} not in ('won', 'lost', 'completed')`;

export async function setResponseTarget(
  org: string,
  actor: string,
  siteId: string,
  minutes: number,
) {
  return db.transaction(async (tx) => {
    const [site] = await tx
      .update(smartSitesTable)
      .set({ responseTargetMinutes: minutes, updatedAt: new Date() })
      .where(
        and(
          eq(smartSitesTable.organizationId, org),
          eq(smartSitesTable.id, siteId),
        ),
      )
      .returning({
        id: smartSitesTable.id,
        responseTargetMinutes: smartSitesTable.responseTargetMinutes,
      });
    if (!site) throw new SmartSiteError("site_not_found", 404);
    await tx
      .insert(auditEventsTable)
      .values({
        organizationId: org,
        actorUserId: actor,
        action: "smart_site.response_target_changed",
        entityType: "smart_site",
        entityId: siteId,
        metadata: {
          minutes,
          appliesTo: "future-inquiries",
          clock: "elapsed-24x7",
        },
      });
    return site;
  });
}

export async function assignSmartSiteLead(
  org: string,
  actor: string,
  leadId: string,
  owner: string | null,
  expected: string | null,
) {
  return db.transaction(async (tx) => {
    const [lead] = await tx
      .select()
      .from(leadsTable)
      .where(and(eq(leadsTable.organizationId, org), eq(leadsTable.id, leadId)))
      .for("update");
    const [receipt] = await tx
      .select({ id: receipts.id })
      .from(receipts)
      .where(
        and(eq(receipts.organizationId, org), eq(receipts.leadId, leadId)),
      );
    if (!lead || !receipt) throw new SmartSiteError("inquiry_not_found", 404);
    if (lead.assignedUserId !== expected)
      throw new SmartSiteError("owner_changed_refresh_first", 409);
    if (owner) {
      const [user] = await tx
        .select()
        .from(usersTable)
        .where(
          and(
            eq(usersTable.id, owner),
            eq(usersTable.organizationId, org),
            eq(usersTable.isActive, true),
          ),
        )
        .for("share");
      if (!user || !hasPermission(user.role, "crm.write"))
        throw new SmartSiteError("owner_must_be_active_team_member", 400);
    }
    await tx
      .update(leadsTable)
      .set({ assignedUserId: owner })
      .where(eq(leadsTable.id, leadId));
    await tx
      .update(crmTasksTable)
      .set({ assignedUserId: owner })
      .where(
        and(
          eq(crmTasksTable.organizationId, org),
          eq(crmTasksTable.leadId, leadId),
          eq(crmTasksTable.sourceEvent, "smart_site.lead_saved"),
          inArray(crmTasksTable.status, ["open", "in_progress"]),
        ),
      );
    await tx
      .insert(auditEventsTable)
      .values({
        organizationId: org,
        actorUserId: actor,
        action: "smart_site.owner_changed",
        entityType: "lead",
        entityId: leadId,
        metadata: { previousOwnerId: expected, assignedUserId: owner },
      });
    return { leadId, assignedUserId: owner };
  });
}

export async function recordSmartSiteAttempt(
  org: string,
  actor: string,
  leadId: string,
  input: {
    requestId: string;
    channel: "phone" | "email" | "sms";
    outcome: string;
    confirmed: true;
  },
) {
  const allowed =
    input.channel === "phone"
      ? ["no_answer", "left_message", "connected"]
      : ["sent"];
  if (!allowed.includes(input.outcome))
    throw new SmartSiteError("invalid_contact_outcome");
  const payloadHash = createHash("sha256")
    .update(JSON.stringify({ leadId, actor, ...input }))
    .digest("hex");
  return db.transaction(async (tx) => {
    // Shared organization lock makes retry IDs safe even across two different leads.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`smart-site-attempt:${org}`}, 0))`,
    );
    const [lead] = await tx
      .select()
      .from(leadsTable)
      .where(and(eq(leadsTable.organizationId, org), eq(leadsTable.id, leadId)))
      .for("update");
    const [receipt] = await tx
      .select()
      .from(receipts)
      .where(and(eq(receipts.organizationId, org), eq(receipts.leadId, leadId)))
      .for("update");
    if (!lead || !receipt) throw new SmartSiteError("inquiry_not_found", 404);
    const [existing] = await tx
      .select()
      .from(attempts)
      .where(
        and(
          eq(attempts.organizationId, org),
          eq(attempts.requestId, input.requestId),
        ),
      );
    if (existing) {
      if (existing.payloadHash !== payloadHash)
        throw new SmartSiteError("idempotency_conflict", 409);
      return {
        id: existing.id,
        recordedAt: existing.recordedAt,
        evidence: "staff-recorded",
        duplicate: true,
      };
    }
    const now = new Date();
    const [event] = await tx
      .insert(attempts)
      .values({
        organizationId: org,
        actorUserId: actor,
        leadId,
        requestId: input.requestId,
        payloadHash,
        channel: input.channel,
        outcome: input.outcome,
        recordedAt: now,
      })
      .returning();
    await tx
      .update(receipts)
      .set({ firstAttemptAt: now })
      .where(and(eq(receipts.id, receipt.id), isNull(receipts.firstAttemptAt)));
    await tx
      .insert(activitiesTable)
      .values({
        organizationId: org,
        actorUserId: actor,
        leadId,
        contactId: lead.contactId,
        type: "smart_site_contact_attempt",
        title: `Staff logged ${input.channel} attempt: ${input.outcome.replaceAll("_", " ")}`,
        body: "Staff-declared action, recorded now. Not independently verified provider delivery or a customer reply.",
        metadata: {
          eventId: event.id,
          channel: input.channel,
          outcome: input.outcome,
          evidence: "staff-recorded",
        },
      });
    await tx
      .update(crmTasksTable)
      .set({ status: "done", completedAt: now })
      .where(
        and(
          eq(crmTasksTable.organizationId, org),
          eq(crmTasksTable.leadId, leadId),
          eq(crmTasksTable.sourceEvent, "smart_site.lead_saved"),
          inArray(crmTasksTable.status, ["open", "in_progress"]),
        ),
      );
    await tx
      .insert(auditEventsTable)
      .values({
        organizationId: org,
        actorUserId: actor,
        action: "smart_site.contact_attempt_recorded",
        entityType: "lead",
        entityId: leadId,
        metadata: {
          eventId: event.id,
          channel: input.channel,
          outcome: input.outcome,
          evidence: "staff-recorded",
        },
      });
    return {
      id: event.id,
      recordedAt: now,
      evidence: "staff-recorded",
      duplicate: false,
    };
  });
}

export async function smartSiteFollowup(org: string) {
  const now = new Date();
  const [summary] = await db
    .select({
      awaitingAttempt: sql<number>`count(*) filter (where ${active} and ${receipts.firstAttemptAt} is null)::int`,
      unassigned: sql<number>`count(*) filter (where ${active} and ${leadsTable.assignedUserId} is null)::int`,
      overdue: sql<number>`count(*) filter (where ${active} and ${receipts.firstAttemptAt} is null and ${receipts.responseDueAt} <= ${now})::int`,
      noTarget: sql<number>`count(*) filter (where ${active} and ${receipts.firstAttemptAt} is null and ${receipts.responseDueAt} is null)::int`,
      logged: sql<number>`count(*) filter (where ${receipts.firstAttemptAt} is not null)::int`,
      medianMinutesToLog: sql<
        number | null
      >`percentile_cont(0.5) within group (order by extract(epoch from (${receipts.firstAttemptAt} - coalesce(${receipts.siteReceivedAt}, ${receipts.createdAt}))) / 60) filter (where ${receipts.firstAttemptAt} is not null)`,
    })
    .from(receipts)
    .innerJoin(
      leadsTable,
      and(
        eq(leadsTable.id, receipts.leadId),
        eq(leadsTable.organizationId, org),
      ),
    )
    .where(eq(receipts.organizationId, org));
  const pending = await db
    .select({
      leadId: leadsTable.id,
      name: sql<string>`concat_ws(' ', ${contactsTable.firstName}, ${contactsTable.lastName})`,
      service: leadsTable.serviceType,
      assignedUserId: leadsTable.assignedUserId,
      dueAt: receipts.responseDueAt,
      receivedAt: sql<Date>`coalesce(${receipts.siteReceivedAt}, ${receipts.createdAt})`,
      siteName: smartSitesTable.name,
      firstAttemptAt: receipts.firstAttemptAt,
    })
    .from(receipts)
    .innerJoin(
      leadsTable,
      and(
        eq(leadsTable.id, receipts.leadId),
        eq(leadsTable.organizationId, org),
      ),
    )
    .innerJoin(
      contactsTable,
      and(
        eq(contactsTable.id, leadsTable.contactId),
        eq(contactsTable.organizationId, org),
      ),
    )
    .innerJoin(
      smartSitesTable,
      and(
        eq(smartSitesTable.id, receipts.siteId),
        eq(smartSitesTable.organizationId, org),
      ),
    )
    .where(
      and(
        eq(receipts.organizationId, org),
        active,
        sql`(${receipts.firstAttemptAt} is null or ${leadsTable.assignedUserId} is null)`,
      ),
    )
    .orderBy(
      sql`${receipts.responseDueAt} asc nulls last`,
      asc(receipts.createdAt),
    )
    .limit(25);
  const members = await db
    .select({
      id: usersTable.id,
      name: sql<string>`coalesce(nullif(concat_ws(' ', ${usersTable.firstName}, ${usersTable.lastName}), ''), ${usersTable.email}, 'Team member')`,
      role: usersTable.role,
    })
    .from(usersTable)
    .where(
      and(eq(usersTable.organizationId, org), eq(usersTable.isActive, true)),
    );
  return {
    serverNow: now,
    summary,
    pending,
    members: members
      .filter((u) => hasPermission(u.role, "crm.write"))
      .map(({ id, name }) => ({ id, name })),
    measurement:
      "Elapsed time to the first staff-logged attempt, not verified delivery or a customer response. Notes and stage changes do not count.",
    limit: 25,
  };
}
