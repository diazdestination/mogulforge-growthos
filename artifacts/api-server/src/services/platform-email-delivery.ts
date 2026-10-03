import { createHash } from "node:crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  db, identityTokensTable, staffInvitationsTable, usersTable,
  platformEmailDispatchesTable as dispatches, platformEmailEventsTable as events,
  type PlatformEmailDispatch, type PlatformEmailEvent, type PlatformEmailOutcome,
} from "@workspace/db";
import { hasPermission } from "../lib/permissions";
import { assertOutboundDeliveryAllowed } from "./outbound-hold";
import { isSafeMailbox, isTransactionalEmailConfigured, transactionalEmailProvider } from "./providers";
import { ResendSendError } from "./resend-delivery";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export const platformEmailRecipientHash = (email: string) => hash(email.trim().toLowerCase());
const normalize = (email: string) => email.trim().toLowerCase();
const STALE_CLAIM_MS = 30_000;
export const PLATFORM_EMAIL_UNMATCHED_LIMIT = 1_000;
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
const unmatchedEvent = sql`not exists (select 1 from ${dispatches} where ${dispatches.providerContext} = ${events.providerContext}
  and ${dispatches.providerMessageId} = ${events.providerMessageId} and ${dispatches.recipientHash} = ${events.recipientHash}
  and ${dispatches.senderMailbox} = ${events.senderMailbox} and ${dispatches.outcome} = 'accepted')`;
async function unmatchedCount(context: string, query: Tx | typeof db = db) {
  const [row] = await query.select({ count: sql<number>`count(*)::int` }).from(events).where(and(eq(events.providerContext, context), unmatchedEvent));
  return row?.count ?? 0;
}

export class PlatformEmailDeliveryError extends Error {
  constructor(readonly code: string, readonly status = 409) {
    super(code);
    this.name = "PlatformEmailDeliveryError";
  }
}

export type PlatformEmailSource =
  | { purpose: "email_verification" | "password_reset"; tokenRecordId: string; tokenDigest: string }
  | { purpose: "staff_invitation"; invitationId: string; tokenRevision: string; actorUserId: string };

/** Extract only one mailbox; display names never enter correlation or logs. */
function senderMailbox(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 320 || /[\r\n]/.test(value)) return null;
  const trimmed = value.trim();
  if (isSafeMailbox(trimmed)) return normalize(trimmed);
  const match = /^[^<>]*<([^<>]+)>$/.exec(trimmed);
  return match && isSafeMailbox(match[1]!) ? normalize(match[1]!) : null;
}

/** Operator-chosen account/environment identity, independent of secret rotation. */
export function platformEmailContext() {
  const configured = process.env.PLATFORM_EMAIL_DELIVERY_CONTEXT?.trim() ?? "";
  const sender = senderMailbox(process.env.RESEND_FROM_EMAIL);
  const valid = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,119}$/.test(configured) && sender !== null;
  return {
    valid,
    senderMailbox: sender ?? "",
    providerContext: hash(JSON.stringify(["resend", configured, sender])),
    from: process.env.RESEND_FROM_EMAIL?.trim() ?? "",
  };
}

export function isPlatformIdentityDeliveryConfigured(): boolean {
  return isTransactionalEmailConfigured() && platformEmailContext().valid;
}

async function sourceRecord(source: PlatformEmailSource, to: string) {
  if (source.purpose === "staff_invitation") {
    if (!UUID.test(source.invitationId) || !UUID.test(source.tokenRevision)) throw new PlatformEmailDeliveryError("invalid_identity_source", 400);
    const pendingUser = alias(usersTable, "identity_pending_user"), creatorUser = alias(usersTable, "identity_creator_user");
    const [snapshot] = await db.select({ row: staffInvitationsTable, pending: pendingUser, creator: creatorUser }).from(staffInvitationsTable)
      .innerJoin(pendingUser, eq(pendingUser.id, staffInvitationsTable.pendingUserId))
      .innerJoin(creatorUser, eq(creatorUser.id, source.actorUserId)).where(eq(staffInvitationsTable.id, source.invitationId));
    if (!snapshot || normalize(snapshot.row.email) !== normalize(to)) throw new PlatformEmailDeliveryError("invalid_identity_source", 400);
    const { row, pending, creator } = snapshot;
    const authorized = row.state === "pending" && row.tokenRevision === source.tokenRevision && row.expiresAt.getTime() > Date.now()
      && Boolean(pending?.isActive && pending.id.startsWith("invite:") && pending.organizationId === row.organizationId && pending.email === row.email && pending.role === row.role)
      && Boolean(creator?.isActive && !creator.id.startsWith("invite:") && creator.emailVerifiedAt && (creator.isPlatformAdmin || (creator.organizationId === row.organizationId && hasPermission(creator.role, "users.manage") && (row.role !== "owner" || creator.role === "owner"))));
    return { organizationId: row.organizationId, userId: null, identityTokenId: null, invitationId: row.id,
      sourceRecordId: row.id, sourceRevision: source.tokenRevision, logicalKey: `invitation:${row.id}:${source.tokenRevision}`, authorized,
      authorityHash: hash(JSON.stringify([row.id, row.tokenRevision, row.organizationId, row.role, row.email, row.expiresAt, pending.id, creator.id])) };
  }
  if (!UUID.test(source.tokenRecordId) || !/^[a-f0-9]{64}$/.test(source.tokenDigest)) throw new PlatformEmailDeliveryError("invalid_identity_source", 400);
  const [row] = await db.select({ token: identityTokensTable, user: usersTable }).from(identityTokensTable)
    .innerJoin(usersTable, eq(usersTable.id, identityTokensTable.userId)).where(eq(identityTokensTable.id, source.tokenRecordId));
  if (!row || row.token.purpose !== source.purpose || row.token.tokenDigest !== source.tokenDigest || normalize(row.user.email ?? "") !== normalize(to))
    throw new PlatformEmailDeliveryError("invalid_identity_source", 400);
  const authorized = row.user.isActive && !row.user.id.startsWith("invite:") && !row.token.consumedAt && row.token.expiresAt.getTime() > Date.now()
    && (source.purpose !== "email_verification" || !row.user.emailVerifiedAt);
  return { organizationId: row.user.organizationId, userId: row.user.id, identityTokenId: row.token.id, invitationId: null,
    sourceRecordId: row.token.id, sourceRevision: "1", logicalKey: `${source.purpose}:${row.token.id}`, authorized,
    authorityHash: hash(JSON.stringify([row.token.id, row.token.purpose, row.token.tokenDigest, row.token.expiresAt, row.user.id, row.user.organizationId, row.user.email])) };
}

export type PlatformEmailSendResult = {
  dispatchId: string;
  outcome: PlatformEmailOutcome;
  outcomeCode: string | null;
  providerMessageId: string | null;
  duplicate: boolean;
};

function sendResult(row: PlatformEmailDispatch, duplicate: boolean): PlatformEmailSendResult {
  return { dispatchId: row.id, outcome: row.outcome === "claimed" && row.claimedAt.getTime() < Date.now() - STALE_CLAIM_MS ? "unknown" : row.outcome,
    outcomeCode: row.outcomeCode, providerMessageId: row.providerMessageId, duplicate };
}

async function finish(id: string, outcome: Exclude<PlatformEmailOutcome, "claimed">, outcomeCode: string, providerMessageId: string | null = null, httpStatus?: number) {
  const [row] = await db.update(dispatches).set({ outcome, outcomeCode, providerMessageId, httpStatus: httpStatus ?? null, finishedAt: new Date() })
    .where(and(eq(dispatches.id, id), eq(dispatches.outcome, "claimed"))).returning();
  if (row) return row;
  const [current] = await db.select().from(dispatches).where(eq(dispatches.id, id));
  if (!current) throw new PlatformEmailDeliveryError("identity_receipt_unavailable", 503);
  return current;
}

async function recipientBlocked(context: string, recipient: string) {
  // Only a signed callback attached to a known accepted platform message can
  // suppress this platform address. Never use an arbitrary event's To alone.
  const [row] = await db.select({ id: events.id }).from(events).innerJoin(dispatches, and(
    eq(dispatches.providerContext, events.providerContext), eq(dispatches.providerMessageId, events.providerMessageId),
    eq(dispatches.recipientHash, events.recipientHash), eq(dispatches.senderMailbox, events.senderMailbox), eq(dispatches.outcome, "accepted"),
  )).where(and(eq(events.providerContext, context), eq(events.recipientHash, recipient), inArray(events.signal, ["bounced", "complained"]))).limit(1);
  return Boolean(row);
}

/** One permanent logical slot, no retries, no mock transport, and no provider call inside a transaction. */
export async function sendPlatformIdentityEmail(input: {
  source: PlatformEmailSource; to: string; subject: string; body: string; beforeDispatch?: () => Promise<boolean>;
}): Promise<PlatformEmailSendResult> {
  if (!isSafeMailbox(input.to)) throw new PlatformEmailDeliveryError("invalid_identity_mailbox", 400);
  const source = await sourceRecord(input.source, input.to);
  const context = platformEmailContext();
  const recipientHash = platformEmailRecipientHash(input.to);
  const fingerprint = hash(JSON.stringify([source.logicalKey, source.authorityHash, recipientHash, context.providerContext, hash(JSON.stringify([input.subject, input.body]))]));
  const { authorized: _authorized, authorityHash: _authorityHash, ...links } = source;
  const [claimed] = await db.insert(dispatches).values({ ...links, purpose: input.source.purpose, recipientHash,
    senderMailbox: context.senderMailbox, providerContext: context.providerContext, fingerprint }).onConflictDoNothing({ target: dispatches.logicalKey }).returning();
  if (!claimed) {
    const [prior] = await db.select().from(dispatches).where(eq(dispatches.logicalKey, source.logicalKey));
    if (!prior || prior.fingerprint !== fingerprint) throw new PlatformEmailDeliveryError("identity_logical_event_changed");
    return sendResult(prior, true);
  }
  const stop = async (code: string) => sendResult(await finish(claimed.id, "not_attempted", code), false);
  if (!isPlatformIdentityDeliveryConfigured()) return stop("platform_email_unconfigured");
  try {
    if (input.beforeDispatch && !await input.beforeDispatch()) return stop("identity_authority_changed");
    if (await recipientBlocked(context.providerContext, recipientHash)) return stop("platform_recipient_suppressed");
    const current = await sourceRecord(input.source, input.to);
    if (!current.authorized || current.authorityHash !== source.authorityHash) return stop("identity_authority_changed");
    if (claimed.claimedAt.getTime() < Date.now() - 15_000) return stop("identity_dispatch_deadline_expired");
    const refreshed = platformEmailContext();
    if (!isPlatformIdentityDeliveryConfigured() || refreshed.providerContext !== context.providerContext || refreshed.from !== context.from)
      return stop("platform_sender_changed");
    assertOutboundDeliveryAllowed({ channel: "email", recipient: input.to });
  } catch {
    return stop("identity_dispatch_guard_blocked");
  }
  let accepted: { id: string; provider: string };
  try {
    accepted = await transactionalEmailProvider.send(input.to, input.subject, input.body);
    if (accepted.provider !== "resend" || !UUID.test(accepted.id)) throw new ResendSendError("unknown");
  } catch (error) {
    const failure = error instanceof ResendSendError ? error : null;
    return sendResult(await finish(claimed.id, failure?.outcome === "rejected" ? "rejected" : "unknown",
      failure?.outcome === "rejected" ? "provider_rejected" : "provider_outcome_unknown", null, failure?.httpStatus), false);
  }
  try {
    return sendResult(await finish(claimed.id, "accepted", "provider_accepted", accepted.id.toLowerCase()), false);
  } catch {
    // A reused provider ID or failed receipt write is never acceptance and
    // never permission to call the provider again. A late read may show claimed.
    try { return sendResult(await finish(claimed.id, "unknown", "provider_receipt_unconfirmed"), false); }
    catch { throw new PlatformEmailDeliveryError("identity_receipt_unavailable", 503); }
  }
}

const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

/** Called ONLY after the route authenticates the original bytes with Svix. */
export async function recordVerifiedPlatformEmailEvent(input: { eventId: string; payloadHash: string; payload: unknown }) {
  const context = platformEmailContext();
  if (!context.valid) return { recorded: false };
  const payload = object(input.payload), data = object(payload?.data);
  const type = payload?.type;
  if (!["email.sent", "email.delivered", "email.bounced", "email.complained", "email.delivery_delayed", "email.failed"].includes(String(type))) return { recorded: false };
  const to = data?.to;
  const from = senderMailbox(data?.from);
  if (!from || from !== context.senderMailbox) return { recorded: false };
  const time = typeof payload?.created_at === "string" ? new Date(payload.created_at) : null;
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(input.eventId) || !/^[a-f0-9]{64}$/.test(input.payloadHash)
    || typeof data?.email_id !== "string" || !UUID.test(data.email_id)
    || !Array.isArray(to) || to.length !== 1 || typeof to[0] !== "string" || !isSafeMailbox(to[0])
    || !from || !time || !Number.isFinite(time.getTime()) || time.getTime() > Date.now() + 60_000)
    throw new PlatformEmailDeliveryError("invalid_platform_delivery_event", 400);
  const bounce = object(data.bounce)?.type;
  const signal: PlatformEmailEvent["signal"] = type === "email.sent" ? "sent" : type === "email.delivered" ? "delivered"
    : type === "email.complained" ? "complained" : type === "email.bounced" && bounce === "Permanent" ? "bounced"
    : type === "email.delivery_delayed" || bounce === "Transient" ? "delayed" : "failed";
  const providerMessageId = data.email_id.toLowerCase(), recipientHash = platformEmailRecipientHash(to[0]);
  return db.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`platform-email-callback:${context.providerContext}`}, 0))`);
    const [prior] = await tx.select({ id: events.id }).from(events).where(and(eq(events.providerContext, context.providerContext), eq(events.eventId, input.eventId), eq(events.payloadHash, input.payloadHash))).limit(1);
    if (prior) return { recorded: true, duplicate: true };
    const [parent] = await tx.select({ id: dispatches.id }).from(dispatches).where(and(eq(dispatches.providerContext, context.providerContext),
      eq(dispatches.providerMessageId, providerMessageId), eq(dispatches.recipientHash, recipientHash), eq(dispatches.senderMailbox, from), eq(dispatches.outcome, "accepted"))).limit(1);
    if (!parent && await unmatchedCount(context.providerContext, tx) >= PLATFORM_EMAIL_UNMATCHED_LIMIT)
      throw new PlatformEmailDeliveryError("platform_callback_backlog_full", 429);
    await tx.insert(events).values({ providerContext: context.providerContext, providerMessageId,
      eventId: input.eventId, payloadHash: input.payloadHash, recipientHash, senderMailbox: from, signal, occurredAt: time });
    return { recorded: true, duplicate: false };
  });
}

export type PlatformEmailDeliveryState = "unconfirmed" | "delivered" | "delayed" | "failed" | "bounced" | "complained" | "needs_review";
export async function platformEmailDeliveryView(row: PlatformEmailDispatch) {
  let deliveryState: PlatformEmailDeliveryState = "unconfirmed";
  let lastEventAt: string | null = null;
  let recipientLabel: string | null = null;
  const currentRecipient = row.userId ? (await db.select({ email: usersTable.email }).from(usersTable).where(eq(usersTable.id, row.userId)))[0]
    : row.invitationId && row.organizationId ? (await db.select({ email: staffInvitationsTable.email }).from(staffInvitationsTable)
      .where(and(eq(staffInvitationsTable.id, row.invitationId), eq(staffInvitationsTable.organizationId, row.organizationId))))[0] : null;
  if (currentRecipient?.email && platformEmailRecipientHash(currentRecipient.email) === row.recipientHash) recipientLabel = currentRecipient.email;
  if (row.providerMessageId) {
    const evidence = await db.select().from(events).where(and(eq(events.providerContext, row.providerContext), eq(events.providerMessageId, row.providerMessageId))).limit(201);
    const ids = evidence.map(event => event.eventId);
    const conflicts = ids.length ? await db.select({ eventId: events.eventId }).from(events)
      .where(and(eq(events.providerContext, row.providerContext), inArray(events.eventId, ids)))
      .groupBy(events.eventId).having(sql`count(*) > 1`).limit(1) : [];
    if (evidence.length > 200 || conflicts.length || evidence.some(event => event.recipientHash !== row.recipientHash || event.senderMailbox !== row.senderMailbox || event.occurredAt.getTime() < row.claimedAt.getTime() - 60_000)) deliveryState = "needs_review";
    else {
      const signals = new Set(evidence.map(event => event.signal));
      deliveryState = signals.has("complained") ? "complained" : signals.has("bounced") ? "bounced" : signals.has("delivered") ? "delivered"
        : signals.has("failed") ? "failed" : signals.has("delayed") ? "delayed" : "unconfirmed";
      if (evidence.length) lastEventAt = new Date(Math.max(...evidence.map(event => event.occurredAt.getTime()))).toISOString();
    }
  }
  const outcome = sendResult(row, false).outcome;
  return { id: row.id, organizationId: row.organizationId, invitationId: row.invitationId, recipientLabel, purpose: row.purpose, outcome,
    outcomeCode: row.outcomeCode, provider: "resend" as const, providerMessageId: row.providerMessageId, deliveryState,
    deliveryConfirmed: deliveryState === "delivered", retryAllowed: false as const,
    claimedAt: row.claimedAt.toISOString(), finishedAt: row.finishedAt?.toISOString() ?? null, lastEventAt };
}

/** Session middleware is also required at HTTP; no token record/digest/key/body appears in this DTO. */
export async function listPlatformEmailDeliveries(input: { actorUserId: string; scope: "platform" | "member"; organizationId?: string; invitationId?: string; page?: number }) {
  const [actor] = await db.select().from(usersTable).where(eq(usersTable.id, input.actorUserId));
  if (!actor?.isActive || !actor.emailVerifiedAt || actor.id.startsWith("invite:")
    || (input.scope === "platform" ? !actor.isPlatformAdmin : !actor.organizationId || actor.organizationId !== input.organizationId || !["owner", "admin"].includes(actor.role)))
    throw new PlatformEmailDeliveryError("platform_email_access_denied", 403);
  const page = input.page ?? 1;
  if (!Number.isSafeInteger(page) || page < 1 || page > 100_000 || (input.organizationId && !UUID.test(input.organizationId)) || (input.invitationId && !UUID.test(input.invitationId)))
    throw new PlatformEmailDeliveryError("invalid_delivery_filter", 400);
  const rows = await db.select().from(dispatches).where(and(
    input.organizationId ? eq(dispatches.organizationId, input.organizationId) : undefined,
    input.scope === "member" ? eq(dispatches.purpose, "staff_invitation") : undefined,
    input.invitationId ? eq(dispatches.invitationId, input.invitationId) : undefined,
  )).orderBy(desc(dispatches.claimedAt), desc(dispatches.id)).limit(26).offset((page - 1) * 25);
  const deliveries = [];
  for (const row of rows.slice(0, 25)) deliveries.push(await platformEmailDeliveryView(row));
  return { deliveries, page, pageSize: 25, hasMore: rows.length > 25,
    unmatchedCallbackCount: input.scope === "platform" ? await unmatchedCount(platformEmailContext().providerContext) : null,
    unmatchedCallbackLimit: PLATFORM_EMAIL_UNMATCHED_LIMIT };
}
