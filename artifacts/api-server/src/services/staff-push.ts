import { randomUUID } from "node:crypto";
import {
  auditEventsTable, db, leadsTable, sessionsTable, staffPushDeliveriesTable as deliveries,
  staffPushPoliciesTable as policies, staffPushSubscriptionsTable as subscriptions, usersTable,
  type StaffPushDeliveryState,
} from "@workspace/db";
import { and, asc, desc, eq, gt, inArray, isNull, lt, lte, sql } from "drizzle-orm";
import { decryptSecret, encryptSecret, sha256Base64Url } from "../lib/token-encryption";
import { hasPermission } from "../lib/permissions";
import { pushConfiguration, pushSubscriptionSchema, staffLeadPayload, staffPushAllowed, staffPushPolicySchema, staffPushRecipients } from "./staff-push-policy";
import { sendStaffPush } from "./staff-push-transport";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Store = Transaction | typeof db;
export class StaffPushError extends Error {
  constructor(public readonly code: string, public readonly status = 400) { super(code); }
}
const MAX_DEVICE_AGE_MS = 7 * 24 * 60 * 60_000;
const QUEUE_TTL_MS = 15 * 60_000;
const IN_FLIGHT_LIMIT_MS = 2 * 60_000;
const BATCH_SIZE = 10;
const context = (org: string, user: string) => `staff-push:${org}:${user}`;

async function sessionMember(store: Store, organizationId: string, userId: string, sid: string, now: Date) {
  const [user] = await store.select().from(usersTable).where(and(
    eq(usersTable.id, userId), eq(usersTable.organizationId, organizationId), eq(usersTable.isActive, true),
  ));
  if (!user || !hasPermission(user.role, "crm.write")) return null;
  const [session] = await store.select().from(sessionsTable).where(and(eq(sessionsTable.sid, sid), gt(sessionsTable.expire, now)));
  const data = session?.sess as { user?: { id?: unknown }; expires_at?: unknown; refresh_token?: unknown } | undefined;
  // Background work never refreshes OAuth. A stale provider session waits for
  // a real authenticated app visit, which refreshes through the normal path.
  if (!session || data?.user?.id !== userId ||
    (typeof data.expires_at === "number" && data.expires_at * 1000 < now.getTime())) return null;
  return { user, session };
}

export async function getStaffPushStatus(organizationId: string, userId: string, sid: string) {
  const configuration = pushConfiguration();
  const now = new Date();
  const eligible = Boolean(await sessionMember(db, organizationId, userId, sid, now));
  const policy = await getStaffPushPolicy(organizationId);
  const devices = await db.select({ id: subscriptions.id, expiresAt: subscriptions.expiresAt, createdAt: subscriptions.createdAt })
    .from(subscriptions).where(and(eq(subscriptions.organizationId, organizationId), eq(subscriptions.userId, userId),
      eq(subscriptions.sessionId, sid), isNull(subscriptions.revokedAt), gt(subscriptions.expiresAt, now)));
  return { supported: Boolean(configuration) && eligible, enabled: eligible && staffPushAllowed(userId), publicKey: eligible ? configuration?.publicKey ?? null : null, eligible,
    organizationId, userId, subscriptions: devices, policyConfigured: Boolean(policy?.enabled),
    permissionRequired: true, receiptMeaning: "provider_accepted_not_received_or_read" };
}

export async function getStaffPushPolicy(organizationId: string) {
  const [row] = await db.select().from(policies).where(eq(policies.organizationId, organizationId));
  const parsed = staffPushPolicySchema.safeParse(row?.policy);
  return parsed.success ? parsed.data : null;
}

export async function saveStaffPushPolicy(organizationId: string, actorUserId: string, input: unknown) {
  const parsed = staffPushPolicySchema.safeParse(input);
  if (!parsed.success) throw new StaffPushError("complete_valid_notification_policy_required");
  return db.transaction(async (tx) => {
    const [actor] = await tx.select().from(usersTable).where(and(eq(usersTable.id, actorUserId),
      eq(usersTable.organizationId, organizationId), eq(usersTable.isActive, true))).for("share");
    if (!actor || !hasPermission(actor.role, "settings.manage")) throw new StaffPushError("active_owner_or_admin_required", 403);
    const ids = [...new Set([...parsed.data.businessHoursUserIds, ...parsed.data.afterHoursUserIds])];
    const members = await tx.select().from(usersTable).where(and(eq(usersTable.organizationId, organizationId),
      eq(usersTable.isActive, true), inArray(usersTable.id, ids))).for("share");
    if (members.length !== ids.length || members.some((u) => !hasPermission(u.role, "crm.write"))) {
      throw new StaffPushError("recipients_must_be_active_organization_responders");
    }
    await tx.insert(policies).values({ organizationId, policy: parsed.data }).onConflictDoUpdate({
      target: policies.organizationId, set: { policy: parsed.data, updatedAt: new Date() },
    });
    await tx.insert(auditEventsTable).values({ organizationId, actorUserId, action: "staff_push.policy_saved", entityType: "staff_push_policy",
      metadata: { enabled: parsed.data.enabled, daytimeRecipientCount: parsed.data.businessHoursUserIds.length,
        afterHoursRecipientCount: parsed.data.afterHoursUserIds.length } });
    return parsed.data;
  });
}

export async function registerStaffPush(organizationId: string, userId: string, sid: string, input: unknown) {
  if (!pushConfiguration()) throw new StaffPushError("push_not_configured", 503);
  const parsed = pushSubscriptionSchema.safeParse(input);
  if (!parsed.success) throw new StaffPushError("invalid_or_unsupported_device_subscription");
  const now = new Date();
  const endpointHash = sha256Base64Url(parsed.data.endpoint);
  return db.transaction(async (tx) => {
    // Same endpoint across accounts plus per-user device limits are serialized.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`staff-push-endpoint:${endpointHash}`}))`);
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`staff-push-user:${userId}`}))`);
    const identity = await sessionMember(tx, organizationId, userId, sid, now);
    if (!identity) throw new StaffPushError("active_member_session_required", 403);
    const expiresAt = new Date(Math.min(now.getTime() + MAX_DEVICE_AGE_MS, identity.session.expire.getTime(),
      parsed.data.expirationTime ?? Infinity));
    if (expiresAt.getTime() <= now.getTime()) throw new StaffPushError("device_subscription_expired");
    const [existing] = await tx.select().from(subscriptions).where(eq(subscriptions.endpointHash, endpointHash));
    // An endpoint is never silently reassigned from another account. The old
    // browser must unsubscribe; a fresh opt-in mints a different endpoint.
    if (existing && (existing.organizationId !== organizationId || existing.userId !== userId)) {
      throw new StaffPushError("device_belongs_to_another_account_unsubscribe_first", 409);
    }
    const active = await tx.select({ id: subscriptions.id }).from(subscriptions).where(and(
      eq(subscriptions.organizationId, organizationId), eq(subscriptions.userId, userId),
      isNull(subscriptions.revokedAt), gt(subscriptions.expiresAt, now)));
    if ((!existing || existing.revokedAt || existing.expiresAt <= now) && active.length >= 5) {
      throw new StaffPushError("device_limit_revoke_existing_devices", 409);
    }
    const value = { organizationId, userId, sessionId: sid, endpointHash,
      encryptedSubscription: encryptSecret(JSON.stringify(parsed.data), context(organizationId, userId)), expiresAt, revokedAt: null };
    const [saved] = await tx.insert(subscriptions).values({ id: existing?.id ?? randomUUID(), ...value }).onConflictDoUpdate({
      target: subscriptions.endpointHash, set: value,
    }).returning({ id: subscriptions.id, expiresAt: subscriptions.expiresAt, createdAt: subscriptions.createdAt });
    await tx.insert(auditEventsTable).values({ organizationId, actorUserId: userId, action: "staff_push.device_registered",
      entityType: "staff_push_subscription", entityId: saved.id, metadata: { expiresAt: expiresAt.toISOString() } });
    return saved;
  });
}

export async function revokeStaffPush(organizationId: string, userId: string, sid: string, endpoint?: string) {
  const scope = and(eq(subscriptions.organizationId, organizationId), eq(subscriptions.userId, userId),
    eq(subscriptions.sessionId, sid), endpoint ? eq(subscriptions.endpointHash, sha256Base64Url(endpoint)) : undefined);
  return db.transaction(async (tx) => {
    const rows = await tx.update(subscriptions).set({ revokedAt: new Date(), encryptedSubscription: null, sessionId: null })
      .where(scope).returning({ id: subscriptions.id });
    if (rows.length) {
      await tx.update(deliveries).set({ state: "cancelled", completedAt: new Date(), reason: "device_revoked" })
        .where(and(eq(deliveries.organizationId, organizationId), inArray(deliveries.subscriptionId, rows.map((r) => r.id)), eq(deliveries.state, "pending")));
      await tx.insert(auditEventsTable).values({ organizationId, actorUserId: userId, action: "staff_push.devices_revoked",
        entityType: "staff_push_subscription", metadata: { count: rows.length } });
    }
    return rows.length;
  });
}

/** Called INSIDE the canonical new-lead transaction, never on imports/merges/retries. */
export async function enqueueStaffLeadPush(tx: Transaction, organizationId: string, lead: { id: string; createdAt: Date }) {
  const [row] = await tx.select().from(policies).where(eq(policies.organizationId, organizationId));
  const recipients = staffPushRecipients(row?.policy, lead.createdAt);
  if (!recipients.length) return;
  const now = new Date();
  const devices = await tx.select().from(subscriptions).where(and(eq(subscriptions.organizationId, organizationId),
    inArray(subscriptions.userId, recipients), isNull(subscriptions.revokedAt), gt(subscriptions.expiresAt, now)));
  for (const device of devices.slice(0, 100)) {
    if (!device.sessionId || !device.encryptedSubscription || !(await sessionMember(tx, organizationId, device.userId, device.sessionId, now))) continue;
    await tx.insert(deliveries).values({ organizationId, leadId: lead.id, subscriptionId: device.id,
      createdAt: lead.createdAt, expiresAt: new Date(lead.createdAt.getTime() + QUEUE_TTL_MS) }).onConflictDoNothing({
      target: [deliveries.organizationId, deliveries.leadId, deliveries.subscriptionId],
    });
  }
}

export async function listStaffPushDeliveries(organizationId: string) {
  return db.select({ id: deliveries.id, leadId: deliveries.leadId, state: deliveries.state, reason: deliveries.reason,
    createdAt: deliveries.createdAt, claimedAt: deliveries.claimedAt, completedAt: deliveries.completedAt, providerStatus: deliveries.providerStatus })
    .from(deliveries).where(eq(deliveries.organizationId, organizationId)).orderBy(desc(deliveries.createdAt)).limit(100);
}

/** Internal-only worker. A claimed network effect is NEVER automatically retried. */
export async function processStaffLeadPush(organizationId?: string): Promise<void> {
  const now = new Date();
  const scope = organizationId ? eq(deliveries.organizationId, organizationId) : undefined;
  // Reboot recovery: pending rows survive; interrupted claimed rows become
  // indeterminate instead of replaying a potentially accepted notification.
  await db.update(deliveries).set({ state: "indeterminate", reason: "worker_interrupted", completedAt: now })
    .where(and(scope, eq(deliveries.state, "dispatching"), lt(deliveries.claimedAt, new Date(now.getTime() - IN_FLIGHT_LIMIT_MS))));
  await db.update(deliveries).set({ state: "expired", reason: "notification_expired", completedAt: now })
    .where(and(scope, eq(deliveries.state, "pending"), lte(deliveries.expiresAt, now)));
  // Retire secrets after logout/expiry even if live sending is disabled.
  await db.update(subscriptions).set({ encryptedSubscription: null, revokedAt: now })
    .where(and(organizationId ? eq(subscriptions.organizationId, organizationId) : undefined, isNull(subscriptions.revokedAt),
      sql`(${subscriptions.sessionId} IS NULL OR ${subscriptions.expiresAt} <= ${now})`));
  if (!staffPushAllowed()) return;
  const queued = await db.select({ id: deliveries.id }).from(deliveries).where(and(scope, eq(deliveries.state, "pending"), gt(deliveries.expiresAt, now)))
    .orderBy(asc(deliveries.createdAt)).limit(BATCH_SIZE);
  for (const item of queued) {
    const [claim] = await db.update(deliveries).set({ state: "dispatching", claimedAt: new Date() })
      .where(and(eq(deliveries.id, item.id), eq(deliveries.state, "pending"), gt(deliveries.expiresAt, new Date())))
      .returning();
    if (!claim) continue;
    const complete = async (state: StaffPushDeliveryState, reason: string, status?: number) => {
      await db.update(deliveries).set({ state, reason, completedAt: new Date(), providerStatus: status ?? null })
        .where(and(eq(deliveries.id, claim.id), eq(deliveries.organizationId, claim.organizationId), eq(deliveries.state, "dispatching")));
    };
    try {
      const [device] = await db.select().from(subscriptions).where(and(eq(subscriptions.id, claim.subscriptionId),
        eq(subscriptions.organizationId, claim.organizationId), isNull(subscriptions.revokedAt), gt(subscriptions.expiresAt, new Date())));
      const policy = await getStaffPushPolicy(claim.organizationId);
      const [lead] = await db.select({ id: leadsTable.id }).from(leadsTable).where(and(eq(leadsTable.id, claim.leadId), eq(leadsTable.organizationId, claim.organizationId)));
      if (!lead || !device?.sessionId || !device.encryptedSubscription || !staffPushAllowed(device.userId) ||
        !staffPushRecipients(policy, claim.createdAt).includes(device.userId) ||
        !(await sessionMember(db, claim.organizationId, device.userId, device.sessionId, new Date()))) {
        await complete("cancelled", "recipient_or_policy_unavailable"); continue;
      }
      const subscription = pushSubscriptionSchema.safeParse(JSON.parse(decryptSecret(device.encryptedSubscription, context(claim.organizationId, device.userId))));
      if (!subscription.success) { await complete("cancelled", "subscription_unavailable"); continue; }
      // Recheck the kill switch immediately before entering the only network path.
      if (!staffPushAllowed(device.userId)) { await complete("cancelled", "sending_held"); continue; }
      const status = await sendStaffPush(subscription.data, JSON.stringify(staffLeadPayload(claim.organizationId, claim.leadId)), device.userId);
      if (status === 404 || status === 410) {
        await db.update(subscriptions).set({ revokedAt: new Date(), encryptedSubscription: null, sessionId: null })
          .where(and(eq(subscriptions.id, device.id), eq(subscriptions.organizationId, claim.organizationId), eq(subscriptions.userId, device.userId),
            eq(subscriptions.encryptedSubscription, device.encryptedSubscription)));
      }
      if (status >= 200 && status < 300) await complete("accepted", "provider_accepted_not_received_or_read", status);
      else if (status >= 300 && status < 500) await complete("rejected", status === 404 || status === 410 ? "subscription_expired_at_provider" : "provider_rejected", status);
      else await complete("indeterminate", "provider_outcome_unknown", Number.isInteger(status) ? status : undefined);
    } catch {
      // No endpoint, keys, provider body, raw exception, lead content or session
      // can enter logs/audit. Failure after claim may already have been accepted.
      await complete("indeterminate", "dispatch_outcome_unknown");
    }
  }
}
