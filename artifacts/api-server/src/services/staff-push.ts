import { createHash, randomUUID } from "node:crypto";
import { z } from "zod/v4";
import {
  auditEventsTable, db, leadsTable, sessionsTable, staffPushDeliveriesTable as deliveries,
  staffPushPoliciesTable as policies, staffPushSubscriptionsTable as subscriptions, usersTable, serviceWatchCasesTable,
  staffLeadAlertCoverageTable as coverage,
  type StaffPushDeliveryState, type StaffLeadAlertRecipient, type StaffLeadAlertCoverageStatus,
} from "@workspace/db";
import { and, asc, desc, eq, gt, inArray, isNull, lt, lte, sql } from "drizzle-orm";
import { decryptSecret, encryptSecret, sha256Base64Url } from "../lib/token-encryption";
import { hasPermission } from "../lib/permissions";
import { pushConfiguration, pushSubscriptionSchema, staffLeadPayload, staffServicePayload, staffPushAllowed, staffPushPolicySchema, staffPushRecipients } from "./staff-push-policy";
import { sendStaffPush, StaffPushDispatchBlockedError } from "./staff-push-transport";

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

const coverageStatuses = ["evaluated", "policy_unavailable", "policy_disabled", "historical_unknown"] as const;
const coverageOutcomes = ["queued", "recipient_unavailable", "no_eligible_device", "notification_expired"] as const;
const deliveryStates = ["pending", "dispatching", "accepted", "rejected", "expired", "cancelled", "indeterminate"] as const;
const coverageSnapshotSchema = z.object({
  version: z.literal(1),
  occurredAt: z.date(),
  recordedAt: z.date(),
  status: z.enum(coverageStatuses),
  policyFingerprint: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  recipients: z.array(z.object({
    userId: z.string().min(1).max(128),
    outcome: z.enum(coverageOutcomes),
    deliveryIds: z.array(z.uuid()).max(5),
  }).strict()).max(20),
}).strict().superRefine((value, ctx) => {
  const fail = () => ctx.addIssue({ code: "custom", message: "Invalid coverage evidence" });
  if ((value.status === "evaluated") !== (value.recipients.length > 0)) fail();
  if (["evaluated", "policy_disabled"].includes(value.status) !== (value.policyFingerprint !== null)) fail();
  if (new Set(value.recipients.map(r => r.userId)).size !== value.recipients.length) fail();
  const allIds = value.recipients.flatMap(r => r.deliveryIds);
  if (new Set(allIds).size !== allIds.length) fail();
  for (const recipient of value.recipients) {
    if ((recipient.outcome === "queued") !== (recipient.deliveryIds.length > 0)) fail();
  }
});
const coverageUnavailable = () => new StaffPushError("staff_notifications_temporarily_unavailable", 503);
type Member = typeof usersTable.$inferSelect;
const acceptedMember = (member: Member | undefined) => Boolean(member?.isActive && member.emailVerifiedAt && !member.id.startsWith("invite:"));
const acceptedResponder = (member: Member | undefined) => acceptedMember(member) && hasPermission(member!.role, "crm.write");
const validDate = (value: unknown): value is Date => value instanceof Date && Number.isFinite(value.getTime());
function matchingSession(session: typeof sessionsTable.$inferSelect | undefined, userId: string, now: Date): boolean {
  if (!session || !validDate(session.expire) || session.expire <= now || !session.sess || typeof session.sess !== "object") return false;
  const data = session.sess as { user?: { id?: unknown }; expires_at?: unknown };
  return data.user?.id === userId && (data.expires_at === undefined ||
    (typeof data.expires_at === "number" && Number.isFinite(data.expires_at) && data.expires_at * 1000 > now.getTime()));
}
function parseCoverage(row: typeof coverage.$inferSelect) {
  const result = coverageSnapshotSchema.safeParse({ version: row.version, occurredAt: row.occurredAt, recordedAt: row.recordedAt,
    status: row.status, policyFingerprint: row.policyFingerprint, recipients: row.recipients });
  if (!result.success) throw coverageUnavailable();
  return result.data;
}

export type StaffLeadAlertDeliveryStateCounts = Record<StaffPushDeliveryState | "unavailable", number>;
export interface StaffLeadAlertCoverage {
  organizationId: string;
  leadId: string;
  status: StaffLeadAlertCoverageStatus | "coverage_not_recorded";
  version: 1 | null;
  occurredAt: Date;
  recordedAt: Date | null;
  serverNow: Date;
  receiptMeaning: "provider_accepted_not_received_or_read";
  recipients: Array<{ userId: string; displayName: string | null; outcome: StaffLeadAlertRecipient["outcome"];
    queuedDeviceCount: number; deliveryStateCounts: StaffLeadAlertDeliveryStateCounts }>;
}

/** Exact evidence read; it cannot admit, repair or replay an alert. */
export async function getStaffLeadAlertCoverage(organizationId: string, actorId: string, leadId: string,
  access: { sessionId: string; effectiveRole: Member["role"] }): Promise<StaffLeadAlertCoverage> {
  return db.transaction(async tx => {
    await tx.execute(sql`select set_config('lock_timeout', '3000ms', true), set_config('statement_timeout', '5000ms', true), set_config('idle_in_transaction_session_timeout', '10000ms', true)`);
    // Lead -> member -> session matches admission/claim ordering. Authority is
    // held through this short read, including waits for other transactions.
    const [lead] = await tx.select({ id: leadsTable.id, createdAt: leadsTable.createdAt }).from(leadsTable)
      .where(and(eq(leadsTable.organizationId, organizationId), eq(leadsTable.id, leadId))).for("share");
    const [actor] = await tx.select().from(usersTable).where(and(eq(usersTable.organizationId, organizationId), eq(usersTable.id, actorId))).for("share");
    const [session] = await tx.select().from(sessionsTable).where(eq(sessionsTable.sid, access.sessionId)).for("share");
    if (!acceptedMember(actor) || !hasPermission(actor!.role, "settings.manage") || !hasPermission(access.effectiveRole, "settings.manage") ||
      !matchingSession(session, actorId, new Date())) throw new StaffPushError("active_member_session_required", 403);
    if (!lead) throw new StaffPushError("lead_not_found", 404);
    if (!validDate(lead.createdAt)) throw coverageUnavailable();
    const [stored] = await tx.select().from(coverage).where(and(eq(coverage.organizationId, organizationId), eq(coverage.leadId, leadId)));
    const result: StaffLeadAlertCoverage = { organizationId, leadId, status: "coverage_not_recorded", version: null,
      occurredAt: lead.createdAt, recordedAt: null, serverNow: new Date(), receiptMeaning: "provider_accepted_not_received_or_read", recipients: [] };
    const finish = () => {
      // Even an unknown historical result may have waited past session expiry.
      if (!matchingSession(session, actorId, new Date())) throw new StaffPushError("active_member_session_required", 403);
      result.serverNow = new Date();
      return result;
    };
    if (!stored) return finish();
    const snapshot = parseCoverage(stored);
    const ids = snapshot.recipients.flatMap(r => r.deliveryIds);
    const effects = ids.length ? await tx.select({ id: deliveries.id, state: deliveries.state }).from(deliveries)
      .where(and(eq(deliveries.organizationId, organizationId), eq(deliveries.leadId, leadId), inArray(deliveries.id, ids))) : [];
    if (effects.some(effect => !deliveryStates.includes(effect.state))) throw coverageUnavailable();
    const members = snapshot.recipients.length ? await tx.select().from(usersTable).where(and(eq(usersTable.organizationId, organizationId),
      inArray(usersTable.id, snapshot.recipients.map(r => r.userId)))) : [];
    result.status = snapshot.status; result.version = snapshot.version; result.occurredAt = snapshot.occurredAt; result.recordedAt = snapshot.recordedAt;
    result.recipients = snapshot.recipients.map(recipient => {
      const member = members.find(m => m.id === recipient.userId);
      const counts: StaffLeadAlertDeliveryStateCounts = { pending: 0, dispatching: 0, accepted: 0, rejected: 0, expired: 0, cancelled: 0, indeterminate: 0, unavailable: 0 };
      for (const id of recipient.deliveryIds) counts[effects.find(effect => effect.id === id)?.state ?? "unavailable"]++;
      return { userId: recipient.userId, displayName: acceptedMember(member) ? [member!.firstName, member!.lastName].filter(Boolean).join(" ") || "Team member" : null,
        outcome: recipient.outcome, queuedDeviceCount: recipient.deliveryIds.length, deliveryStateCounts: counts };
    });
    return finish();
  }).catch((error: unknown) => {
    if (error instanceof StaffPushError) throw error;
    throw coverageUnavailable();
  });
}

async function sessionMember(store: Store, organizationId: string, userId: string, sid: string, now: Date) {
  const [user] = await store.select().from(usersTable).where(and(
    eq(usersTable.id, userId), eq(usersTable.organizationId, organizationId), eq(usersTable.isActive, true),
  ));
  if (!user || !user.emailVerifiedAt || user.id.startsWith("invite:") || !hasPermission(user.role, "crm.write")) return null;
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
    organizationId, userId, subscriptions: devices, policyConfigured: Boolean(policy?.enabled), serviceAlertsConfigured: Boolean(policy?.serviceAlertsEnabled),
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
    if (!actor || !actor.emailVerifiedAt || actor.id.startsWith("invite:") || !hasPermission(actor.role, "settings.manage")) throw new StaffPushError("active_owner_or_admin_required", 403);
    const ids = [...new Set([...parsed.data.businessHoursUserIds, ...parsed.data.afterHoursUserIds])];
    const members = await tx.select().from(usersTable).where(and(eq(usersTable.organizationId, organizationId),
      eq(usersTable.isActive, true), inArray(usersTable.id, ids))).for("share");
    if (members.length !== ids.length || members.some((u) => !u.emailVerifiedAt || u.id.startsWith("invite:") || !hasPermission(u.role, "crm.write"))) {
      throw new StaffPushError("recipients_must_be_active_organization_responders");
    }
    await tx.insert(policies).values({ organizationId, policy: parsed.data }).onConflictDoUpdate({
      target: policies.organizationId, set: { policy: parsed.data, updatedAt: new Date() },
    });
    await tx.insert(auditEventsTable).values({ organizationId, actorUserId, action: "staff_push.policy_saved", entityType: "staff_push_policy",
      metadata: { enabled: parsed.data.enabled, serviceAlertsEnabled: parsed.data.serviceAlertsEnabled, daytimeRecipientCount: parsed.data.businessHoursUserIds.length,
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
  const [canonical] = await tx.select({ id: leadsTable.id, createdAt: leadsTable.createdAt }).from(leadsTable)
    .where(and(eq(leadsTable.organizationId, organizationId), eq(leadsTable.id, lead.id))).for("update");
  if (!canonical) throw new StaffPushError("lead_not_found", 404);
  const [existing] = await tx.select().from(coverage).where(and(eq(coverage.organizationId, organizationId), eq(coverage.leadId, canonical.id)));
  if (existing) return;
  if (!validDate(canonical.createdAt)) throw coverageUnavailable();
  const [legacy] = await tx.select({ id: deliveries.id }).from(deliveries)
    .where(and(eq(deliveries.organizationId, organizationId), eq(deliveries.leadId, canonical.id))).limit(1);
  const save = async (status: StaffLeadAlertCoverageStatus, policyFingerprint: string | null, recipients: StaffLeadAlertRecipient[], recordedAt = new Date()) => {
    const snapshot = coverageSnapshotSchema.safeParse({ version: 1, occurredAt: canonical.createdAt, recordedAt, status, policyFingerprint, recipients });
    if (!snapshot.success) throw coverageUnavailable();
    await tx.insert(coverage).values({ organizationId, leadId: canonical.id, ...snapshot.data });
  };
  if (legacy) { await save("historical_unknown", null, []); return; }
  const [row] = await tx.select().from(policies).where(eq(policies.organizationId, organizationId));
  const policy = staffPushPolicySchema.safeParse(row?.policy);
  if (!policy.success) { await save("policy_unavailable", null, []); return; }
  const fingerprint = createHash("sha256").update(JSON.stringify({ ...policy.data, days: [...policy.data.days].sort(),
    businessHoursUserIds: [...policy.data.businessHoursUserIds].sort(), afterHoursUserIds: [...policy.data.afterHoursUserIds].sort() })).digest("hex");
  if (!policy.data.enabled) { await save("policy_disabled", fingerprint, []); return; }
  const recipientIds = staffPushRecipients(policy.data, canonical.createdAt);
  const members = await tx.select().from(usersTable).where(and(eq(usersTable.organizationId, organizationId), inArray(usersTable.id, recipientIds)))
    .orderBy(asc(usersTable.id)).for("share");
  // Sessions precede device locks, matching logout's session -> subscription FK
  // updates. A renewed device with a different unobserved session is not admitted.
  const candidates = await tx.select({ id: subscriptions.id, sessionId: subscriptions.sessionId }).from(subscriptions)
    .where(and(eq(subscriptions.organizationId, organizationId), inArray(subscriptions.userId, recipientIds), isNull(subscriptions.revokedAt), gt(subscriptions.expiresAt, new Date())));
  const sessionIds = [...new Set(candidates.flatMap(d => d.sessionId ? [d.sessionId] : []))].sort();
  const sessions = sessionIds.length ? await tx.select().from(sessionsTable).where(inArray(sessionsTable.sid, sessionIds)).orderBy(asc(sessionsTable.sid)).for("share") : [];
  const devices = candidates.length ? await tx.select().from(subscriptions).where(and(eq(subscriptions.organizationId, organizationId),
    inArray(subscriptions.id, candidates.map(d => d.id)), inArray(subscriptions.userId, recipientIds), isNull(subscriptions.revokedAt)))
    .orderBy(asc(subscriptions.userId), asc(subscriptions.createdAt), asc(subscriptions.id)).for("share") : [];
  const now = new Date(), expiresAt = new Date(canonical.createdAt.getTime() + QUEUE_TTL_MS);
  const recipients: StaffLeadAlertRecipient[] = [];
  for (const userId of recipientIds) {
    const recipient: StaffLeadAlertRecipient = { userId, outcome: "no_eligible_device", deliveryIds: [] };
    if (expiresAt <= now) recipient.outcome = "notification_expired";
    else if (!acceptedResponder(members.find(member => member.id === userId))) recipient.outcome = "recipient_unavailable";
    else {
      const eligible = devices.filter(device => device.userId === userId && device.expiresAt > now && device.encryptedSubscription && device.sessionId &&
        matchingSession(sessions.find(session => session.sid === device.sessionId), userId, now)).slice(0, 5);
      for (const device of eligible) {
        const [effect] = await tx.insert(deliveries).values({ organizationId, leadId: canonical.id, subscriptionId: device.id,
          createdAt: canonical.createdAt, expiresAt }).returning({ id: deliveries.id });
        recipient.deliveryIds.push(effect.id);
      }
      if (recipient.deliveryIds.length) recipient.outcome = "queued";
    }
    recipients.push(recipient);
  }
  await save("evaluated", fingerprint, recipients, now);
}

/** Called within the service-watch reconciliation transaction. No outbound work here. */
export async function enqueueStaffServiceNotice(input: {
  organizationId: string; serviceObligationId: string; caseId: string; assignedUserId: string | null;
  eventKey: string; noticeRevision: number; occurredAt: Date;
}, tx: Transaction) {
  if (!input.assignedUserId || input.noticeRevision < 1 || input.eventKey !== `service-watch:${input.caseId}:${input.noticeRevision}`) return;
  const [row] = await tx.select().from(policies).where(eq(policies.organizationId, input.organizationId));
  const policy = staffPushPolicySchema.safeParse(row?.policy);
  // This switch is independent of new-lead coverage. It explicitly opts in the
  // current service owner at any time, with no fallback to an invented owner.
  if (!policy.success || !policy.data.serviceAlertsEnabled) return;
  const now = new Date();
  if (!Number.isFinite(input.occurredAt.getTime()) || input.occurredAt.getTime() + QUEUE_TTL_MS <= now.getTime()) return;
  const devices = await tx.select().from(subscriptions).where(and(eq(subscriptions.organizationId, input.organizationId),
    eq(subscriptions.userId, input.assignedUserId), isNull(subscriptions.revokedAt), gt(subscriptions.expiresAt, now))).limit(5);
  for (const device of devices) {
    if (!device.sessionId || !device.encryptedSubscription || !await sessionMember(tx, input.organizationId, device.userId, device.sessionId, now)) continue;
    await tx.insert(deliveries).values({ organizationId: input.organizationId, leadId: null,
      serviceObligationId: input.serviceObligationId, serviceWatchCaseId: input.caseId, serviceOwnerId: input.assignedUserId,
      serviceNoticeRevision: input.noticeRevision, eventKey: input.eventKey, subscriptionId: device.id,
      createdAt: input.occurredAt, expiresAt: new Date(input.occurredAt.getTime() + QUEUE_TTL_MS),
    }).onConflictDoNothing({ target: [deliveries.organizationId, deliveries.eventKey, deliveries.subscriptionId] });
  }
}

type PushClaim = typeof deliveries.$inferSelect;
async function authorizedPushTarget(claim: PushClaim) {
  if (claim.expiresAt <= new Date()) return null;
  const [device] = await db.select().from(subscriptions).where(and(eq(subscriptions.id, claim.subscriptionId),
    eq(subscriptions.organizationId, claim.organizationId), isNull(subscriptions.revokedAt), gt(subscriptions.expiresAt, new Date())));
  if (!device?.sessionId || !device.encryptedSubscription || !staffPushAllowed(device.userId) ||
    !await sessionMember(db, claim.organizationId, device.userId, device.sessionId, new Date())) return null;
  const policy = await getStaffPushPolicy(claim.organizationId);
  if (claim.leadId) {
    const [lead] = await db.select({ id: leadsTable.id }).from(leadsTable).where(and(eq(leadsTable.id, claim.leadId), eq(leadsTable.organizationId, claim.organizationId)));
    if (!lead || !staffPushRecipients(policy, claim.createdAt).includes(device.userId)) return null;
    return { device, payload: staffLeadPayload(claim.organizationId, claim.leadId) };
  }
  if (!claim.serviceObligationId || !claim.serviceWatchCaseId || !claim.serviceNoticeRevision || claim.serviceOwnerId !== device.userId || !policy?.serviceAlertsEnabled) return null;
  const [linkedCase] = await db.select({ id: serviceWatchCasesTable.id }).from(serviceWatchCasesTable).where(and(
    eq(serviceWatchCasesTable.organizationId, claim.organizationId), eq(serviceWatchCasesTable.id, claim.serviceWatchCaseId),
    eq(serviceWatchCasesTable.serviceObligationId, claim.serviceObligationId)));
  if (!linkedCase) return null;
  const { serviceWatchNoticeCurrent } = await import("./service-watch");
  if (!await serviceWatchNoticeCurrent(claim.organizationId, claim.serviceWatchCaseId, claim.serviceNoticeRevision, device.userId)) return null;
  return { device, payload: staffServicePayload(claim.organizationId, claim.serviceObligationId) };
}

export async function listStaffPushDeliveries(organizationId: string) {
  return db.select({ id: deliveries.id, leadId: deliveries.leadId, serviceObligationId: deliveries.serviceObligationId, state: deliveries.state, reason: deliveries.reason,
    createdAt: deliveries.createdAt, claimedAt: deliveries.claimedAt, completedAt: deliveries.completedAt, providerStatus: deliveries.providerStatus })
    .from(deliveries).where(eq(deliveries.organizationId, organizationId)).orderBy(desc(deliveries.createdAt)).limit(100);
}

/** Internal-only worker. A claimed network effect is NEVER automatically retried. */
export async function processStaffLeadPush(organizationId?: string): Promise<void> {
  const { customerWorkAllowedSql, customerWorkHeld } = await import("./customer-lifecycle-runtime");
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
  const queued = await db.select({ id: deliveries.id, organizationId: deliveries.organizationId }).from(deliveries).where(and(scope, customerWorkAllowedSql(deliveries.organizationId), eq(deliveries.state, "pending"), gt(deliveries.expiresAt, now)))
    .orderBy(asc(deliveries.createdAt)).limit(BATCH_SIZE);
  for (const item of queued) {
    if (await customerWorkHeld(item.organizationId)) continue;
    const [claim] = await db.update(deliveries).set({ state: "dispatching", claimedAt: new Date() })
      .where(and(eq(deliveries.id, item.id), eq(deliveries.state, "pending"), gt(deliveries.expiresAt, new Date())))
      .returning();
    if (!claim) continue;
    const complete = async (state: StaffPushDeliveryState, reason: string, status?: number) => {
      await db.update(deliveries).set({ state, reason, completedAt: new Date(), providerStatus: status ?? null })
        .where(and(eq(deliveries.id, claim.id), eq(deliveries.organizationId, claim.organizationId), eq(deliveries.state, "dispatching")));
    };
    try {
      const target = await authorizedPushTarget(claim);
      if (!target) {
        await complete("cancelled", "recipient_or_policy_unavailable"); continue;
      }
      const { device, payload } = target;
      const subscription = pushSubscriptionSchema.safeParse(JSON.parse(decryptSecret(device.encryptedSubscription!, context(claim.organizationId, device.userId))));
      if (!subscription.success) { await complete("cancelled", "subscription_unavailable"); continue; }
      // Recheck the kill switch immediately before entering the only network path.
      if (!staffPushAllowed(device.userId)) { await complete("cancelled", "sending_held"); continue; }
      if (await customerWorkHeld(claim.organizationId)) {
        await db.update(deliveries).set({ state: "pending", claimedAt: null })
          .where(and(eq(deliveries.id, claim.id), eq(deliveries.state, "dispatching")));
        continue;
      }
      const status = await sendStaffPush(subscription.data, JSON.stringify(payload), device.userId, async () => {
        if (await customerWorkHeld(claim.organizationId)) return false;
        const current = await authorizedPushTarget(claim);
        return Boolean(current && current.device.sessionId === device.sessionId && current.device.encryptedSubscription === device.encryptedSubscription);
      });
      if (status === 404 || status === 410) {
        await db.update(subscriptions).set({ revokedAt: new Date(), encryptedSubscription: null, sessionId: null })
          .where(and(eq(subscriptions.id, device.id), eq(subscriptions.organizationId, claim.organizationId), eq(subscriptions.userId, device.userId),
            eq(subscriptions.encryptedSubscription, device.encryptedSubscription!)));
      }
      if (status >= 200 && status < 300) await complete("accepted", "provider_accepted_not_received_or_read", status);
      else if (status >= 300 && status < 500) await complete("rejected", status === 404 || status === 410 ? "subscription_expired_at_provider" : "provider_rejected", status);
      else await complete("indeterminate", "provider_outcome_unknown", Number.isInteger(status) ? status : undefined);
    } catch (error) {
      // No endpoint, keys, provider body, raw exception, lead content or session
      // can enter logs/audit. Failure after claim may already have been accepted.
      if (error instanceof StaffPushDispatchBlockedError) await complete("cancelled", "dispatch_authorization_changed");
      else await complete("indeterminate", "dispatch_outcome_unknown");
    }
  }
}
