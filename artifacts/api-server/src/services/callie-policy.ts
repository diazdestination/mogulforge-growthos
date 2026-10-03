import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod/v4";
import { auditEventsTable, customerLifecycleTable, db, organizationsTable, usersTable } from "@workspace/db";
import { calliePolicyRevisionsTable as revisions, type CalliePolicySettings, type CalliePolicySnapshot } from "../../../../lib/db/src/schema/callie";
import { hasPermission } from "../lib/permissions";
import { deliveryFingerprint } from "./invoice-delivery-contract";
import { outboundDeliveryHeld } from "./outbound-hold";
import { twilioForOrganization, type TwilioClientBinding } from "./twilio-controls";
import { buildCalliePolicySnapshot, calliePolicySettingsSchema, DEFAULT_CALLIE_POLICY, callieOwnerAt } from "./callie-contract";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type CallieReader = Pick<typeof db, "select" | "execute">;
export class CallieError extends Error {
  constructor(readonly code: string, readonly statusCode = 409) { super(code); }
}
export function denyCallie(code: string, statusCode = 409): never { throw new CallieError(code, statusCode); }
export async function lockCallie(tx: Pick<Transaction, "execute">, organizationId: string) {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`callie:${organizationId}`}))`);
}
export const calliePolicyPreviewInputSchema = z.object({ expectedVersion: z.number().int().nonnegative(), policy: calliePolicySettingsSchema }).strict();
export const calliePolicyApprovalInputSchema = z.object({ expectedVersion: z.number().int().nonnegative(), expectedSnapshot: z.record(z.string(), z.unknown()), previewHash: z.string().regex(/^[a-f0-9]{64}$/), confirmed: z.literal(true) }).strict();
export interface CalliePolicyPreviewSnapshot {
  schemaVersion: "callie-policy-preview.v1";
  organizationId: string;
  actorUserId: string;
  reviewId: string;
  expectedVersion: number;
  issuedAt: string;
  expiresAt: string;
  policy: CalliePolicySnapshot;
}
function previewSignature(snapshot: unknown) {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 16) denyCallie("preview_signing_unavailable", 503);
  return createHmac("sha256", secret).update(`callie-policy-preview.v1:${deliveryFingerprint(snapshot)}`).digest("hex");
}
function signatureMatches(expected: string, actual: string) {
  return /^[a-f0-9]{64}$/.test(actual) && timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(actual, "hex"));
}
export async function callieActiveMember(reader: CallieReader, org: string, userId: string | null, permission: "crm.write" | "settings.manage") {
  if (!userId) return false;
  const [user] = await reader.select().from(usersTable).where(and(eq(usersTable.organizationId, org), eq(usersTable.id, userId), eq(usersTable.isActive, true)));
  return Boolean(user && !user.id.startsWith("invite:") && user.emailVerifiedAt && hasPermission(user.role, permission));
}
export async function callieCompanyHeld(reader: CallieReader, org: string) {
  const [company] = await reader.select({ id: organizationsTable.id }).from(organizationsTable).where(eq(organizationsTable.id, org));
  if (!company) denyCallie("company_unavailable");
  const [lifecycle] = await reader.select({ state: customerLifecycleTable.state }).from(customerLifecycleTable).where(eq(customerLifecycleTable.organizationId, org));
  return Boolean(lifecycle && lifecycle.state !== "active");
}
export async function currentCallieRevision(org: string, reader: CallieReader = db) {
  const [row] = await reader.select().from(revisions).where(eq(revisions.organizationId, org)).orderBy(desc(revisions.version)).limit(1);
  return row ?? null;
}
function reviewedBinding(binding: TwilioClientBinding | null): CalliePolicySnapshot["binding"] {
  if (!binding) return null;
  // These are non-secret identities. Unavailable credentials/activation leave an
  // approved policy visibly held; they must not prevent disabling or revising it.
  if (!/^AC[a-f0-9]{32}$/i.test(binding.accountSid) || !/^MG[a-f0-9]{32}$/i.test(binding.messagingServiceSid ?? "") ||
      !binding.origin || !binding.smsDisclosureVersion || !binding.businessName || binding.businessName.length > 120 ||
      !/^\+1[2-9]\d{9}$/.test(binding.phoneNumber)) return null;
  return { id: binding.id, accountSid: binding.accountSid, sender: binding.phoneNumber, messagingServiceSid: binding.messagingServiceSid!,
    disclosureVersion: binding.smsDisclosureVersion!, origin: binding.origin, businessName: binding.businessName };
}
async function reviewSnapshot(org: string, policy: CalliePolicySettings, reader: CallieReader) {
  const binding = reviewedBinding(await twilioForOrganization(org, reader));
  if (policy.enabled) {
    if (!binding) denyCallie("binding_identity_required");
    for (const id of [policy.businessHoursOwnerId, policy.afterHoursOwnerId]) {
      if (!(await callieActiveMember(reader, org, id, "crm.write"))) denyCallie("owner_unavailable");
    }
  }
  return buildCalliePolicySnapshot(policy, binding);
}

/** SELECT-only exact current operational authority; no retrospective admission. */
export async function assertCallieCurrentAuthority(org: string, revisionId?: string, options: { reader?: CallieReader; at?: Date; requireSms?: boolean; checkHolds?: boolean } = {}) {
  const reader = options.reader ?? db, revision = await currentCallieRevision(org, reader);
  if (!revision || (revisionId && revision.id !== revisionId) || !revision.enabled || !revision.snapshot.enabled) denyCallie("policy_disabled_or_revised");
  // The strict settings schema must not treat immutable prompt/binding fields as
  // settings. Validate the complete settings projection and canonical snapshot.
  const settings = calliePolicySettingsSchema.safeParse({ enabled: revision.snapshot.enabled, timezone: revision.snapshot.timezone, days: revision.snapshot.days,
    opensAt: revision.snapshot.opensAt, closesAt: revision.snapshot.closesAt, businessHoursOwnerId: revision.snapshot.businessHoursOwnerId,
    afterHoursOwnerId: revision.snapshot.afterHoursOwnerId, responseMinutes: revision.snapshot.responseMinutes });
  if (!settings.success || !isDeepStrictEqual(buildCalliePolicySnapshot(settings.data, revision.snapshot.binding), revision.snapshot)) denyCallie("policy_snapshot_invalid");
  if (!(await callieActiveMember(reader, org, revision.approvedByUserId, "settings.manage"))) denyCallie("policy_approver_unavailable");
  for (const id of [settings.data.businessHoursOwnerId, settings.data.afterHoursOwnerId]) {
    if (!(await callieActiveMember(reader, org, id, "crm.write"))) denyCallie("owner_unavailable");
  }
  const ownerUserId = callieOwnerAt(settings.data, options.at ?? new Date());
  if (!ownerUserId || !(await callieActiveMember(reader, org, ownerUserId, "crm.write"))) denyCallie("owner_unavailable");
  const binding = await twilioForOrganization(org, reader);
  if (!binding || !isDeepStrictEqual(reviewedBinding(binding), revision.snapshot.binding)) denyCallie("binding_changed");
  if (!binding.voiceEnabled || ((options.requireSms ?? true) && !binding.smsEnabled)) denyCallie("provider_not_approved");
  if (options.checkHolds ?? true) {
    if (outboundDeliveryHeld()) denyCallie("environment_outbound_hold");
    if (await callieCompanyHeld(reader, org)) denyCallie("customer_lifecycle_paused");
  }
  return { revision, snapshot: revision.snapshot, binding, ownerUserId };
}

export async function getCalliePolicy(org: string) {
  const revision = await currentCallieRevision(org);
  const snapshot = revision?.snapshot ?? buildCalliePolicySnapshot(DEFAULT_CALLIE_POLICY, null);
  let readiness: { ready: boolean; reason: string | null };
  try { await assertCallieCurrentAuthority(org, revision?.id); readiness = { ready: true, reason: null }; }
  catch (error) { if (!(error instanceof CallieError)) throw error; readiness = { ready: false, reason: error.code }; }
  const { enabled, timezone, days, opensAt, closesAt, businessHoursOwnerId, afterHoursOwnerId, responseMinutes } = snapshot;
  return { version: revision?.version ?? 0, revisionId: revision?.id ?? null,
    policy: { enabled, timezone, days, opensAt, closesAt, businessHoursOwnerId, afterHoursOwnerId, responseMinutes },
    snapshot, approvedAt: revision?.approvedAt.toISOString() ?? null, readiness,
    automaticUnknownCallerEnrollment: false, callerInitiatedOneCallAcknowledgmentOnly: true };
}

export async function previewCalliePolicy(org: string, actor: string, input: z.infer<typeof calliePolicyPreviewInputSchema>) {
  const parsed = calliePolicyPreviewInputSchema.parse(input);
  return db.transaction(async (tx) => {
    await lockCallie(tx, org);
    if (!(await callieActiveMember(tx, org, actor, "settings.manage"))) denyCallie("permission_denied", 403);
    const current = await currentCallieRevision(org, tx);
    if ((current?.version ?? 0) !== parsed.expectedVersion) denyCallie("stale_policy");
    const policy = await reviewSnapshot(org, parsed.policy, tx), now = new Date();
    const expectedSnapshot: CalliePolicyPreviewSnapshot = { schemaVersion: "callie-policy-preview.v1", organizationId: org, actorUserId: actor,
      reviewId: randomUUID(), expectedVersion: parsed.expectedVersion, issuedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 10 * 60_000).toISOString(), policy };
    const previewHash = previewSignature(expectedSnapshot);
    await tx.insert(auditEventsTable).values({ id: expectedSnapshot.reviewId, organizationId: org, actorUserId: actor,
      action: "callie.policy.previewed", entityType: "organization", entityId: org,
      metadata: { payloadHash: deliveryFingerprint(expectedSnapshot), expectedVersion: parsed.expectedVersion, expiresAt: expectedSnapshot.expiresAt, snapshot: policy, customerMessageSent: false } });
    return { expectedVersion: parsed.expectedVersion, expectedSnapshot, previewHash, expiresAt: expectedSnapshot.expiresAt };
  });
}

export async function approveCalliePolicy(org: string, actor: string, input: z.infer<typeof calliePolicyApprovalInputSchema>) {
  const parsed = calliePolicyApprovalInputSchema.parse(input);
  if (!signatureMatches(previewSignature(parsed.expectedSnapshot), parsed.previewHash)) denyCallie("invalid_policy_preview");
  const preview = parsed.expectedSnapshot as unknown as CalliePolicyPreviewSnapshot;
  const now = new Date();
  if (preview.schemaVersion !== "callie-policy-preview.v1" || preview.organizationId !== org || preview.actorUserId !== actor ||
      preview.expectedVersion !== parsed.expectedVersion || !Number.isFinite(Date.parse(preview.expiresAt)) || Date.parse(preview.expiresAt) <= now.getTime() ||
      Date.parse(preview.issuedAt) > now.getTime() || Date.parse(preview.expiresAt) - Date.parse(preview.issuedAt) !== 10 * 60_000) denyCallie("stale_policy_preview");
  await db.transaction(async (tx) => {
    await lockCallie(tx, org);
    if (!(await callieActiveMember(tx, org, actor, "settings.manage"))) denyCallie("permission_denied", 403);
    const current = await currentCallieRevision(org, tx);
    if ((current?.version ?? 0) !== parsed.expectedVersion) denyCallie("stale_policy");
    const [review] = await tx.select().from(auditEventsTable).where(and(eq(auditEventsTable.organizationId, org), eq(auditEventsTable.id, preview.reviewId), eq(auditEventsTable.actorUserId, actor)));
    if (!review || review.action !== "callie.policy.previewed" || review.metadata?.payloadHash !== deliveryFingerprint(preview)) denyCallie("invalid_policy_preview");
    const settings = calliePolicySettingsSchema.parse({ enabled: preview.policy.enabled, timezone: preview.policy.timezone, days: preview.policy.days,
      opensAt: preview.policy.opensAt, closesAt: preview.policy.closesAt, businessHoursOwnerId: preview.policy.businessHoursOwnerId,
      afterHoursOwnerId: preview.policy.afterHoursOwnerId, responseMinutes: preview.policy.responseMinutes });
    if (!isDeepStrictEqual(await reviewSnapshot(org, settings, tx), preview.policy)) denyCallie("stale_policy_preview");
    const [revision] = await tx.insert(revisions).values({ organizationId: org, version: parsed.expectedVersion + 1, enabled: settings.enabled,
      snapshot: preview.policy, reviewId: preview.reviewId, reviewPayloadHash: deliveryFingerprint(preview), approvedByUserId: actor, approvedAt: new Date() }).returning();
    await tx.insert(auditEventsTable).values({ organizationId: org, actorUserId: actor, action: "callie.policy.approved", entityType: "callie_policy_revision", entityId: revision.id,
      metadata: { reviewId: preview.reviewId, version: revision.version, snapshot: preview.policy, customerMessageSent: false, forwardOnly: true } });
  });
  return getCalliePolicy(org);
}
