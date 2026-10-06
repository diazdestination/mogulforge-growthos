import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { and, eq, sql } from "drizzle-orm";
import { db, auditEventsTable, calliePolicyRevisionsTable, callieReceptionBindingsTable, organizationsTable, twilioClientBindingsTable, usersTable } from "@workspace/db";
import { encryptSecret } from "../lib/token-encryption";
import { callieActiveMember, callieCompanyHeld, currentCallieRevision, lockCallie, type CallieReader } from "./callie-policy";
import { callieHash, callieOwnerAt } from "./callie-contract";
import { lockContractorSchedule } from "./contractor-scheduling";
import { outboundDeliveryHeld } from "./outbound-hold";
import { twilioForOrganization, type TwilioClientBinding } from "./twilio-controls";
import { CALLIE_RECEPTION_VERSION, CALLIE_RECEPTION_TOOL_VERSION, DEFAULT_CALLIE_RECEPTION, CallieReceptionError, buildReceptionPrompt,
  callieReceptionBindingInputSchema, callieReceptionBindingSchema, callieReceptionBindingSettingsSchema,
  callieReceptionSettingsSchema, callieReceptionSnapshotSchema, callieReceptionPreviewInputSchema,
  callieReceptionApprovalInputSchema, callieReceptionViewSchema, type CallieReceptionSettings, type CallieReceptionSnapshot } from "./callie-reception-contract";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Binding = typeof callieReceptionBindingsTable.$inferSelect;
export function receptionDeny(code: string, status = 409): never { throw new CallieReceptionError(code, status); }
export async function lockCallieReception(tx: Tx, org: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`customer-lifecycle:${org}`}, 0))`);
  await lockContractorSchedule(tx, org);
  await lockCallie(tx, org);
}
export function receptionCredentials(org: string, binding: Pick<Binding, "credentialKey" | "configurationSha256" | "agentVersionId">) {
  // An arbitrary environment reference (or another tenant's prefix) is never accepted.
  const prefix = `ELEVENLABS_ORG_${org.replaceAll("-", "").toUpperCase()}_${binding.credentialKey}`;
  return { apiKey: process.env[`${prefix}_API_KEY`] ?? "", webhookSecret: process.env[`${prefix}_WEBHOOK_SECRET`] ?? "",
    configurationReviewed: process.env[`${prefix}_CONFIG_SHA256`] === binding.configurationSha256 && process.env[`${prefix}_AGENT_VERSION_ID`] === binding.agentVersionId };
}
export function assertReceptionStorage() {
  try { encryptSecret("readiness", "callie-reception:readiness"); } catch { receptionDeny("reception_storage_unavailable"); }
}
function signature(value: unknown) {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 16) receptionDeny("preview_signing_unavailable", 503);
  return createHmac("sha256", secret).update(`callie-reception-preview.v1:${callieHash(value)}`).digest("hex");
}
function settingsFromSnapshot(snapshot: CallieReceptionSnapshot) {
  const { templateVersion: _template, toolVersion: _tool, voiceBinding: _voice, receptionBinding: _binding, prompt: _prompt, ...settings } = snapshot;
  return callieReceptionSettingsSchema.parse(settings);
}
export function receptionPrompt(settings: CallieReceptionSettings, businessName: string) {
  return buildReceptionPrompt(settings, businessName);
}
export function receptionVoiceIdentity(binding: TwilioClientBinding | null): CallieReceptionSnapshot["voiceBinding"] {
  if (!binding || !/^AC[a-f0-9]{32}$/i.test(binding.accountSid) || !/^\+1[2-9]\d{9}$/.test(binding.phoneNumber) ||
      !binding.staffPhone || !/^\+1[2-9]\d{9}$/.test(binding.staffPhone) || !binding.origin || !binding.businessName) return null;
  return { id: binding.id, accountSid: binding.accountSid, sender: binding.phoneNumber, staffPhone: binding.staffPhone, origin: binding.origin, businessName: binding.businessName };
}
export function receptionBindingIdentity(binding: Binding | null) {
  return binding ? { id: binding.id, version: binding.version, ...callieReceptionBindingSettingsSchema.parse(bindingSettings(binding)) } : null;
}
// Parsing a projection keeps private/audit columns out of the strict browser contract.
function bindingSettings(binding: Binding) {
  return { enabled: binding.enabled, agentId: binding.agentId, agentVersionId: binding.agentVersionId, branchId: binding.branchId, environment: binding.environment, credentialKey: binding.credentialKey, configurationSha256: binding.configurationSha256 };
}
export async function readReceptionBinding(org: string, reader: CallieReader = db) {
  const [binding] = await reader.select().from(callieReceptionBindingsTable).where(eq(callieReceptionBindingsTable.organizationId, org));
  return binding ?? null;
}
async function buildSnapshot(org: string, settings: CallieReceptionSettings, reader: CallieReader) {
  const voiceBinding = receptionVoiceIdentity(await twilioForOrganization(org, reader)), binding = await readReceptionBinding(org, reader);
  const receptionBinding = binding ? { id: binding.id, version: binding.version, ...bindingSettings(binding) } : null;
  if (settings.enabled) {
    if (!voiceBinding || !receptionBinding) receptionDeny("reception_binding_identity_required");
    for (const owner of [settings.businessHoursOwnerId, settings.afterHoursOwnerId]) if (!await callieActiveMember(reader, org, owner, "crm.write")) receptionDeny("owner_unavailable");
  }
  for (const target of [settings.businessHoursTransferPhone, settings.afterHoursTransferPhone]) {
    if (target && target === voiceBinding?.sender) receptionDeny("transfer_loop");
  }
  return callieReceptionSnapshotSchema.parse({ ...settings, templateVersion: CALLIE_RECEPTION_VERSION, toolVersion: CALLIE_RECEPTION_TOOL_VERSION,
    voiceBinding, receptionBinding, prompt: receptionPrompt(settings, voiceBinding?.businessName ?? "the company") });
}

/** Default reads are SELECT-only. Final effect claims opt into row locks with a transaction reader. */
export async function assertReceptionAuthority(org: string, revisionId?: string, options: { reader?: CallieReader; at?: Date; lockRows?: boolean } = {}) {
  const reader = options.reader ?? db;
  if (options.lockRows) {
    if (reader === db) throw new Error("Reception authority row locks require a transaction");
    await reader.select({ id: organizationsTable.id }).from(organizationsTable).where(eq(organizationsTable.id, org)).for("share");
    await reader.select({ id: twilioClientBindingsTable.id }).from(twilioClientBindingsTable).where(eq(twilioClientBindingsTable.organizationId, org)).for("share");
    await reader.select({ id: callieReceptionBindingsTable.id }).from(callieReceptionBindingsTable).where(eq(callieReceptionBindingsTable.organizationId, org)).for("share");
  }
  const revision = await currentCallieRevision(org, reader);
  if (!revision || revisionId && revision.id !== revisionId || revision.snapshot.templateVersion !== CALLIE_RECEPTION_VERSION || !revision.enabled) receptionDeny("reception_policy_disabled_or_revised");
  const parsed = callieReceptionSnapshotSchema.safeParse(revision.snapshot);
  if (!parsed.success) receptionDeny("reception_policy_invalid");
  const snapshot = parsed.data, settings = settingsFromSnapshot(snapshot);
  if (options.lockRows) {
    const ids = [...new Set([revision.approvedByUserId, settings.businessHoursOwnerId, settings.afterHoursOwnerId].filter((id): id is string => !!id))].sort();
    for (const id of ids) await reader.select({ id: usersTable.id }).from(usersTable).where(and(eq(usersTable.organizationId, org), eq(usersTable.id, id))).for("share");
  }
  if (!await callieActiveMember(reader, org, revision.approvedByUserId, "settings.manage")) receptionDeny("policy_approver_unavailable");
  if (!isDeepStrictEqual(await buildSnapshot(org, settings, reader), snapshot)) receptionDeny("reception_binding_changed");
  const binding = (await readReceptionBinding(org, reader))!, voice = await twilioForOrganization(org, reader);
  if (!voice?.voiceEnabled || !binding.enabled) receptionDeny("reception_provider_not_approved");
  const credentials = receptionCredentials(org, binding);
  if (!credentials.apiKey || !credentials.webhookSecret) receptionDeny("reception_credentials_unavailable");
  if (!credentials.configurationReviewed) receptionDeny("reception_configuration_not_verified");
  assertReceptionStorage();
  if (outboundDeliveryHeld()) receptionDeny("environment_outbound_hold");
  if (await callieCompanyHeld(reader, org)) receptionDeny("customer_lifecycle_paused");
  const ownerUserId = callieOwnerAt(settings, options.at ?? new Date());
  if (!ownerUserId) receptionDeny("owner_unavailable");
  return { revision, snapshot, settings, binding, voice, ownerUserId };
}
export async function getCallieReception(org: string) {
  const revision = await currentCallieRevision(org), binding = await readReceptionBinding(org);
  const approvedSnapshot = revision?.snapshot.templateVersion === CALLIE_RECEPTION_VERSION ? callieReceptionSnapshotSchema.parse(revision.snapshot) : null;
  let readiness: { state: "off" | "setup_incomplete" | "approved_but_held" | "approved_for_future_eligible_calls"; ready: boolean; reason: string | null } = { state: "off", ready: false, reason: null };
  if (approvedSnapshot?.enabled) {
    try { await assertReceptionAuthority(org, revision!.id); readiness = { state: "approved_for_future_eligible_calls", ready: true, reason: null }; }
    catch (error) { if (!(error instanceof CallieReceptionError)) throw error; readiness = { state: "approved_but_held", ready: false, reason: error.code }; }
  } else if (!binding) readiness = { state: "setup_incomplete", ready: false, reason: "reception_binding_identity_required" };
  const credentials = binding ? receptionCredentials(org, binding) : null;
  return callieReceptionViewSchema.parse({ organizationId: org, version: revision?.version ?? 0, revisionId: revision?.id ?? null,
    currentMode: approvedSnapshot ? "conversation" : "keypad", currentEnabled: revision?.enabled ?? false,
    binding: binding ? callieReceptionBindingSchema.parse({ ...bindingSettings(binding), id: binding.id, version: binding.version, updatedAt: binding.updatedAt.toISOString(), credentialsConfigured: !!credentials?.apiKey, webhookConfigured: !!credentials?.webhookSecret }) : null,
    policy: approvedSnapshot ? settingsFromSnapshot(approvedSnapshot) : DEFAULT_CALLIE_RECEPTION, approvedSnapshot, approvedAt: approvedSnapshot ? revision!.approvedAt.toISOString() : null,
    readiness, boundary: "Voice-only missed-call reception. Requests are unverified; no automatic booking or messaging permission." });
}
export async function saveCallieReceptionBinding(org: string, actor: string, raw: unknown) {
  const input = callieReceptionBindingInputSchema.parse(raw);
  await db.transaction(async tx => {
    await lockCallieReception(tx, org);
    if (!await callieActiveMember(tx, org, actor, "settings.manage")) receptionDeny("permission_denied", 403);
    const [replay] = await tx.select().from(auditEventsTable).where(and(eq(auditEventsTable.organizationId, org), eq(auditEventsTable.action, "callie.reception.binding_saved"), sql`${auditEventsTable.metadata}->>'requestId' = ${input.requestId}`)).limit(1);
    if (replay) { if (replay.actorUserId !== actor || replay.metadata.payloadHash !== callieHash(input)) receptionDeny("request_changed"); return; }
    const binding = await readReceptionBinding(org, tx);
    if ((binding?.version ?? 0) !== input.expectedVersion) receptionDeny("stale_binding");
    if (binding) await tx.update(callieReceptionBindingsTable).set({ ...input.binding, version: binding.version + 1, updatedByUserId: actor, updatedAt: new Date() }).where(eq(callieReceptionBindingsTable.id, binding.id));
    else await tx.insert(callieReceptionBindingsTable).values({ organizationId: org, ...input.binding, updatedByUserId: actor });
    await tx.insert(auditEventsTable).values({ organizationId: org, actorUserId: actor, action: "callie.reception.binding_saved", entityType: "organization", entityId: org, metadata: { requestId: input.requestId, payloadHash: callieHash(input), version: input.expectedVersion + 1, providerConfigured: false } });
  });
  return getCallieReception(org);
}
export async function previewCallieReception(org: string, actor: string, raw: unknown) {
  const input = callieReceptionPreviewInputSchema.parse(raw);
  return db.transaction(async tx => {
    await lockCallieReception(tx, org);
    if (!await callieActiveMember(tx, org, actor, "settings.manage")) receptionDeny("permission_denied", 403);
    const head = await currentCallieRevision(org, tx);
    if ((head?.version ?? 0) !== input.expectedVersion) receptionDeny("stale_policy");
    const now = new Date(), policy = await buildSnapshot(org, input.policy, tx);
    const expectedSnapshot = { schemaVersion: "callie-reception-preview.v1" as const, organizationId: org, actorUserId: actor, reviewId: randomUUID(), expectedVersion: input.expectedVersion,
      issuedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 600_000).toISOString(), policy };
    const previewHash = signature(expectedSnapshot);
    await tx.insert(auditEventsTable).values({ id: expectedSnapshot.reviewId, organizationId: org, actorUserId: actor, action: "callie.reception.previewed", entityType: "organization", entityId: org,
      metadata: { payloadHash: callieHash(expectedSnapshot), snapshot: policy, expiresAt: expectedSnapshot.expiresAt, providerConfigured: false } });
    return { organizationId: org, expectedVersion: input.expectedVersion, expectedSnapshot, previewHash, expiresAt: expectedSnapshot.expiresAt };
  });
}
export async function approveCallieReception(org: string, actor: string, raw: unknown) {
  const input = callieReceptionApprovalInputSchema.parse(raw), preview = input.expectedSnapshot, now = Date.now();
  if (!timingSafeEqual(Buffer.from(signature(preview), "hex"), Buffer.from(input.previewHash, "hex")) || preview.organizationId !== org || preview.actorUserId !== actor || preview.expectedVersion !== input.expectedVersion ||
      Date.parse(preview.issuedAt) > now || Date.parse(preview.expiresAt) <= now || Date.parse(preview.expiresAt) - Date.parse(preview.issuedAt) !== 600_000) receptionDeny("invalid_or_expired_preview");
  await db.transaction(async tx => {
    await lockCallieReception(tx, org);
    if (!await callieActiveMember(tx, org, actor, "settings.manage")) receptionDeny("permission_denied", 403);
    const head = await currentCallieRevision(org, tx);
    if ((head?.version ?? 0) !== input.expectedVersion) receptionDeny("stale_policy");
    const [review] = await tx.select().from(auditEventsTable).where(and(eq(auditEventsTable.organizationId, org), eq(auditEventsTable.id, preview.reviewId), eq(auditEventsTable.actorUserId, actor)));
    if (!review || review.action !== "callie.reception.previewed" || review.metadata.payloadHash !== callieHash(preview)) receptionDeny("invalid_or_expired_preview");
    if (!isDeepStrictEqual(await buildSnapshot(org, settingsFromSnapshot(preview.policy), tx), preview.policy)) receptionDeny("stale_policy_preview");
    await tx.insert(calliePolicyRevisionsTable).values({ organizationId: org, version: input.expectedVersion + 1, enabled: preview.policy.enabled, snapshot: preview.policy,
      reviewId: preview.reviewId, reviewPayloadHash: callieHash(preview), approvedByUserId: actor, approvedAt: new Date() });
    await tx.insert(auditEventsTable).values({ organizationId: org, actorUserId: actor, action: "callie.reception.approved", entityType: "organization", entityId: org, metadata: { reviewId: preview.reviewId, version: input.expectedVersion + 1, forwardOnly: true, providerConfigured: false } });
  });
  return getCallieReception(org);
}
