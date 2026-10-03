import { createHash, randomUUID } from "node:crypto";
import { db, usersTable, organizationsTable, identityTokensTable, staffInvitationsTable,
  platformEmailDispatchesTable as dispatches, platformEmailEventsTable as events } from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";
import { issueIdentityTokenRecord } from "./identity-token";
import { transactionalEmailProvider } from "./providers";
import { ResendSendError } from "./resend-delivery";
import { createStaffInvitation, updateStaffInvitation } from "./staff-invitations";
import { listPlatformEmailDeliveries, platformEmailContext, platformEmailDeliveryView, platformEmailRecipientHash,
  recordVerifiedPlatformEmailEvent, sendPlatformIdentityEmail, PLATFORM_EMAIL_UNMATCHED_LIMIT } from "./platform-email-delivery";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
let org: string, owner: string, user: string, email: string, context: string;
let send: MockInstance<typeof transactionalEmailProvider.send>;
const from = "MogulForge <account@platform.example>";

beforeEach(async () => {
  vi.stubEnv("RESEND_API_KEY", "synthetic-never-used");
  vi.stubEnv("RESEND_FROM_EMAIL", from);
  vi.stubEnv("PLATFORM_EMAIL_DELIVERY_CONTEXT", `synthetic-${randomUUID()}`);
  vi.stubEnv("GROWTHOS_OUTBOUND_HOLD", "false");
  vi.stubEnv("APP_ORIGIN", "https://growth.example");
  context = platformEmailContext().providerContext;
  [org] = (await db.insert(organizationsTable).values({ name: "Fictional identity delivery", slug: randomUUID() }).returning({ id: organizationsTable.id })).map(row => row.id);
  email = `identity-${randomUUID()}@example.invalid`;
  [owner, user] = (await db.insert(usersTable).values([
    { email: `owner-${randomUUID()}@example.invalid`, organizationId: org, role: "owner", emailVerifiedAt: new Date(), isPlatformAdmin: true },
    { email, organizationId: org, emailVerifiedAt: null },
  ]).returning({ id: usersTable.id })).map(row => row.id);
  send = vi.spyOn(transactionalEmailProvider, "send").mockImplementation(async () => ({ id: randomUUID(), provider: "resend" }));
});

afterEach(async () => {
  await db.delete(events).where(eq(events.providerContext, context));
  await db.delete(dispatches).where(eq(dispatches.userId, user));
  await deleteTestOrgs(org);
  await db.delete(usersTable).where(eq(usersTable.id, user));
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function message(purpose: "email_verification" | "password_reset" = "email_verification") {
  const record = await issueIdentityTokenRecord({ userId: user, purpose });
  return { source: { purpose, tokenRecordId: record.tokenRecordId, tokenDigest: digest(record.token) }, to: email,
    subject: "Fictional identity action", body: `https://growth.example/verify-email?token=${record.token}` };
}
async function row(id: string) { return (await db.select().from(dispatches).where(eq(dispatches.id, id)))[0]!; }
function callback(id: string, type = "email.delivered", options: { to?: string; from?: string; eventId?: string; bounce?: string } = {}) {
  const payload = { type, created_at: new Date().toISOString(), data: { email_id: id, from: options.from ?? from, to: [options.to ?? email], ...(options.bounce ? { bounce: { type: options.bounce } } : {}) } };
  return { eventId: options.eventId ?? `msg_${randomUUID()}`, payloadHash: digest(JSON.stringify(payload)), payload };
}

describe("platform identity email permanent logical ownership", () => {
  it.each(["email_verification", "password_reset"] as const)("owns one %s send with a stable record and no raw content", async purpose => {
    const input = await message(purpose);
    const first = await sendPlatformIdentityEmail(input);
    expect(first.outcome).toBe("accepted");
    expect(await sendPlatformIdentityEmail(input)).toMatchObject({ dispatchId: first.dispatchId, duplicate: true, outcome: "accepted" });
    expect(send).toHaveBeenCalledTimes(1);
    const saved = await row(first.dispatchId);
    expect(saved.identityTokenId).toBe(input.source.tokenRecordId);
    expect(JSON.stringify(saved)).not.toContain(input.body);
    expect(JSON.stringify(saved)).not.toContain(email);
    const view = await platformEmailDeliveryView(saved);
    expect(view).toMatchObject({ recipientLabel: email, deliveryConfirmed: false, retryAllowed: false, deliveryState: "unconfirmed" });
    expect(JSON.stringify(view)).not.toContain(input.source.tokenRecordId);
    expect(JSON.stringify(view)).not.toContain(input.source.tokenDigest);
    await db.update(usersTable).set({ email: `changed-${randomUUID()}@example.invalid` }).where(eq(usersTable.id, user));
    expect((await platformEmailDeliveryView(saved)).recipientLabel).toBeNull();
  });

  it("concurrent duplicate callers can never own two provider requests", async () => {
    const input = await message();
    const results = await Promise.all(Array.from({ length: 8 }, () => sendPlatformIdentityEmail(input)));
    expect(new Set(results.map(result => result.dispatchId)).size).toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect((await row(results[0]!.dispatchId)).outcome).toBe("accepted");
  });

  it("unknown effects cannot replay, change their body, or escape by config revision", async () => {
    const input = await message();
    send.mockRejectedValue(new Error(`private transport body ${input.body}`));
    const result = await sendPlatformIdentityEmail(input);
    expect(result).toMatchObject({ outcome: "unknown", outcomeCode: "provider_outcome_unknown" });
    expect(await sendPlatformIdentityEmail(input)).toMatchObject({ duplicate: true, outcome: "unknown" });
    await expect(sendPlatformIdentityEmail({ ...input, body: "changed" })).rejects.toMatchObject({ code: "identity_logical_event_changed" });
    vi.stubEnv("PLATFORM_EMAIL_DELIVERY_CONTEXT", "different-config-version");
    await expect(sendPlatformIdentityEmail(input)).rejects.toMatchObject({ code: "identity_logical_event_changed" });
    expect(send).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(await row(result.dispatchId))).not.toContain("private transport");
  });

  it("known provider rejection is retained and never retried", async () => {
    send.mockRejectedValue(new ResendSendError("rejected", 403));
    const input = await message();
    const result = await sendPlatformIdentityEmail(input);
    expect(await row(result.dispatchId)).toMatchObject({ outcome: "rejected", httpStatus: 403, providerMessageId: null });
    await sendPlatformIdentityEmail(input);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it.each(["unconfigured", "held", "token_consumed", "sender_changed"])("blocks %s immediately before provider dispatch", async mode => {
    const input = await message();
    if (mode === "unconfigured") vi.stubEnv("PLATFORM_EMAIL_DELIVERY_CONTEXT", "");
    if (mode === "held") vi.stubEnv("GROWTHOS_OUTBOUND_HOLD", "true");
    const result = await sendPlatformIdentityEmail({ ...input, beforeDispatch: async () => {
      if (mode === "token_consumed") await db.update(identityTokensTable).set({ consumedAt: new Date() }).where(eq(identityTokensTable.id, input.source.tokenRecordId));
      if (mode === "sender_changed") vi.stubEnv("RESEND_FROM_EMAIL", "another@platform.example");
      return true;
    } });
    expect(result.outcome).toBe("not_attempted");
    expect(send).not.toHaveBeenCalled();
  });

  it("cannot turn a non-Resend/mock receipt into acceptance", async () => {
    send.mockResolvedValue({ id: randomUUID(), provider: "mock-email" });
    expect((await sendPlatformIdentityEmail(await message())).outcome).toBe("unknown");
  });

  it("provider ID reuse stays uncertain rather than adopting another attempt", async () => {
    send.mockResolvedValue({ id: randomUUID(), provider: "resend" });
    const first = await sendPlatformIdentityEmail(await message());
    const second = await sendPlatformIdentityEmail(await message());
    expect(first.outcome).toBe("accepted");
    expect(second.outcome).toBe("unknown");
    expect(second.providerMessageId).toBeNull();
  });

  it("deleting an account/token preserves its immutable logical reservation without retaining plaintext", async () => {
    await db.update(usersTable).set({ organizationId: null }).where(eq(usersTable.id, user));
    const input = await message(), result = await sendPlatformIdentityEmail(input);
    await db.delete(usersTable).where(eq(usersTable.id, user));
    const saved = await row(result.dispatchId);
    expect(saved).toMatchObject({ userId: null, identityTokenId: null, organizationId: null, sourceRecordId: input.source.tokenRecordId });
    await expect(sendPlatformIdentityEmail(input)).rejects.toMatchObject({ code: "invalid_identity_source" });
    expect(send).toHaveBeenCalledTimes(1);
    await db.delete(dispatches).where(eq(dispatches.id, result.dispatchId));
  });
});

describe("authenticated immutable delivery evidence", () => {
  it("reconciles a callback arriving before the provider receipt without changing token/user authority", async () => {
    const input = await message(), id = randomUUID();
    send.mockImplementation(async () => {
      await recordVerifiedPlatformEmailEvent(callback(id));
      return { id, provider: "resend" };
    });
    const result = await sendPlatformIdentityEmail(input);
    expect(await platformEmailDeliveryView(await row(result.dispatchId))).toMatchObject({ deliveryState: "delivered", deliveryConfirmed: true });
    expect((await db.select().from(identityTokensTable).where(eq(identityTokensTable.id, input.source.tokenRecordId)))[0]!.consumedAt).toBeNull();
    expect((await db.select().from(usersTable).where(eq(usersTable.id, user)))[0]!.emailVerifiedAt).toBeNull();
    expect((await listPlatformEmailDeliveries({ actorUserId: owner, scope: "platform" })).unmatchedCallbackCount).toBe(0);
  });

  it("deduplicates signed event bytes and a late delivered event never erases a permanent bounce", async () => {
    const result = await sendPlatformIdentityEmail(await message());
    const delivered = callback(result.providerMessageId!);
    await recordVerifiedPlatformEmailEvent(delivered);
    expect(await recordVerifiedPlatformEmailEvent(delivered)).toMatchObject({ duplicate: true });
    await recordVerifiedPlatformEmailEvent(callback(result.providerMessageId!, "email.bounced", { bounce: "Permanent" }));
    await recordVerifiedPlatformEmailEvent(callback(result.providerMessageId!));
    expect(await platformEmailDeliveryView(await row(result.dispatchId))).toMatchObject({ deliveryState: "bounced", deliveryConfirmed: false });
    const blocked = await sendPlatformIdentityEmail(await message());
    expect(blocked).toMatchObject({ outcome: "not_attempted", outcomeCode: "platform_recipient_suppressed" });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("retains contradictory payloads under one event ID and never calls them delivered", async () => {
    const result = await sendPlatformIdentityEmail(await message());
    const good = callback(result.providerMessageId!);
    await recordVerifiedPlatformEmailEvent(good);
    await recordVerifiedPlatformEmailEvent(callback(result.providerMessageId!, "email.failed", { eventId: good.eventId }));
    expect(await platformEmailDeliveryView(await row(result.dispatchId))).toMatchObject({ deliveryState: "needs_review", deliveryConfirmed: false });
    expect(await db.select().from(events).where(eq(events.eventId, good.eventId))).toHaveLength(2);
  });

  it("ignores unrelated senders and never correlates a wrong recipient or context", async () => {
    const result = await sendPlatformIdentityEmail(await message());
    expect(await recordVerifiedPlatformEmailEvent(callback(result.providerMessageId!, "email.delivered", { from: "different@platform.example" }))).toEqual({ recorded: false });
    expect(await db.select().from(events).where(eq(events.providerContext, context))).toHaveLength(0);
    vi.stubEnv("PLATFORM_EMAIL_DELIVERY_CONTEXT", "another-provider-account");
    const otherContext = platformEmailContext().providerContext;
    await recordVerifiedPlatformEmailEvent(callback(result.providerMessageId!));
    expect((await platformEmailDeliveryView(await row(result.dispatchId))).deliveryConfirmed).toBe(false);
    await db.delete(events).where(eq(events.providerContext, otherContext));
    vi.stubEnv("PLATFORM_EMAIL_DELIVERY_CONTEXT", "invalid"); // restore original hash through saved context is intentionally impossible
    const saved = await row(result.dispatchId);
    await db.insert(events).values({ providerContext: saved.providerContext, providerMessageId: saved.providerMessageId!, eventId: `msg_${randomUUID()}`,
      payloadHash: digest("wrong-recipient-fixture"), recipientHash: platformEmailRecipientHash("foreign@example.invalid"), senderMailbox: saved.senderMailbox, signal: "delivered", occurredAt: new Date() });
    expect((await platformEmailDeliveryView(saved)).deliveryState).toBe("needs_review");
  });

  it("bounds unbound callback backlog while preserving duplicates and known receipt processing", async () => {
    const accepted = await sendPlatformIdentityEmail(await message());
    const batch = Array.from({ length: PLATFORM_EMAIL_UNMATCHED_LIMIT }, (_, i) => ({ providerContext: context, providerMessageId: randomUUID(),
      eventId: `msg_backlog_${i}`, payloadHash: digest(`backlog-${i}`), recipientHash: platformEmailRecipientHash(email), senderMailbox: "account@platform.example", signal: "sent" as const, occurredAt: new Date() }));
    await db.insert(events).values(batch);
    await expect(recordVerifiedPlatformEmailEvent(callback(randomUUID()))).rejects.toMatchObject({ code: "platform_callback_backlog_full", status: 429 });
    expect(await recordVerifiedPlatformEmailEvent({ ...callback(batch[0]!.providerMessageId, "email.sent"), eventId: batch[0]!.eventId, payloadHash: batch[0]!.payloadHash })).toMatchObject({ duplicate: true });
    await recordVerifiedPlatformEmailEvent(callback(accepted.providerMessageId!));
    expect((await platformEmailDeliveryView(await row(accepted.dispatchId))).deliveryConfirmed).toBe(true);
    const status = await listPlatformEmailDeliveries({ actorUserId: owner, scope: "platform" });
    expect(status.unmatchedCallbackCount).toBe(PLATFORM_EMAIL_UNMATCHED_LIMIT);
  });
});

describe("invitation authority and scoped status", () => {
  it.each(["actor_deactivated", "actor_downgraded", "invitation_revoked"])("revalidates %s at the final send boundary", async mode => {
    const to = `invite-${randomUUID()}@example.invalid`;
    const [pending] = await db.insert(usersTable).values({ id: `invite:${randomUUID()}`, email: to, organizationId: org, role: "viewer" }).returning();
    const [invite] = await db.insert(staffInvitationsTable).values({ organizationId: org, requestId: randomUUID(), payloadHash: digest("reviewed invitation fixture"),
      pendingUserId: pending!.id, email: to, role: "viewer", expiresAt: new Date(Date.now() + 60_000), createdByUserId: owner }).returning();
    const result = await sendPlatformIdentityEmail({ source: { purpose: "staff_invitation", invitationId: invite!.id, tokenRevision: invite!.tokenRevision, actorUserId: owner },
      to, subject: "Reviewed invitation fixture", body: "Synthetic private invitation content", beforeDispatch: async () => {
        if (mode === "actor_deactivated") await db.update(usersTable).set({ isActive: false }).where(eq(usersTable.id, owner));
        if (mode === "actor_downgraded") await db.update(usersTable).set({ role: "viewer", isPlatformAdmin: false }).where(eq(usersTable.id, owner));
        if (mode === "invitation_revoked") await db.update(staffInvitationsTable).set({ state: "revoked" }).where(eq(staffInvitationsTable.id, invite!.id));
        return true;
      } });
    expect(result).toMatchObject({ outcome: "not_attempted", outcomeCode: "identity_authority_changed" });
    expect(send).not.toHaveBeenCalled();
  });

  it("permits a currently authorized administrator to reissue after the original creator is deactivated", async () => {
    const created = await createStaffInvitation({ userId: owner, scope: "platform" }, org, { requestId: randomUUID(), email: `invite-${randomUUID()}@example.invalid`, role: "viewer" });
    const [replacement] = await db.insert(usersTable).values({ organizationId: org, role: "admin", email: `replacement-${randomUUID()}@example.invalid`, emailVerifiedAt: new Date() }).returning();
    await db.update(usersTable).set({ isActive: false }).where(eq(usersTable.id, owner));
    await db.update(staffInvitationsTable).set({ deliveryAttemptedAt: new Date(Date.now() - 61_000) }).where(eq(staffInvitationsTable.id, created.invitation.id));
    const reissued = await updateStaffInvitation({ userId: replacement!.id, scope: "member" }, org, created.invitation.id, { action: "reissue", expectedVersion: created.invitation.version, confirmed: true });
    expect(reissued).toMatchObject({ state: "pending", deliveryState: "sent", version: 2 });
    expect(send).toHaveBeenCalledTimes(2);
    const evidence = await db.select().from(dispatches).where(eq(dispatches.invitationId, created.invitation.id));
    expect(evidence).toHaveLength(2);
    expect(evidence.every(item => item.outcome === "accepted")).toBe(true);
  });

  it("retains invitation receipt while callbacks cannot accept, reactivate or undo revocation", async () => {
    const result = await createStaffInvitation({ userId: owner, scope: "platform" }, org, { requestId: randomUUID(), email: `invite-${randomUUID()}@example.invalid`, role: "viewer" });
    const [invite] = await db.select().from(staffInvitationsTable).where(eq(staffInvitationsTable.id, result.invitation.id));
    const [dispatch] = await db.select().from(dispatches).where(eq(dispatches.invitationId, invite!.id));
    await updateStaffInvitation({ userId: owner, scope: "platform" }, org, invite!.id, { action: "revoke", expectedVersion: invite!.version, confirmed: true });
    await recordVerifiedPlatformEmailEvent(callback(dispatch!.providerMessageId!, "email.delivered", { to: invite!.email }));
    expect((await db.select().from(staffInvitationsTable).where(eq(staffInvitationsTable.id, invite!.id)))[0]!.state).toBe("revoked");
    expect((await db.select().from(usersTable).where(eq(usersTable.id, invite!.pendingUserId)))[0]!.isActive).toBe(false);
    const member = await listPlatformEmailDeliveries({ actorUserId: owner, scope: "member", organizationId: org });
    expect(member.deliveries).toHaveLength(1);
    expect(member.deliveries[0]).toMatchObject({ invitationId: invite!.id, deliveryConfirmed: true });
    expect(member.unmatchedCallbackCount).toBeNull();
  });

  it("a different invitation revision or revoke cannot bypass an unknown send", async () => {
    send.mockRejectedValue(new ResendSendError("unknown"));
    const created = await createStaffInvitation({ userId: owner, scope: "platform" }, org, { requestId: randomUUID(), email: `invite-${randomUUID()}@example.invalid`, role: "viewer" });
    await db.update(staffInvitationsTable).set({ deliveryAttemptedAt: new Date(Date.now() - 61_000) }).where(eq(staffInvitationsTable.id, created.invitation.id));
    await expect(updateStaffInvitation({ userId: owner, scope: "platform" }, org, created.invitation.id, { action: "reissue", expectedVersion: 1, confirmed: true }))
      .rejects.toMatchObject({ code: "invitation_delivery_reconciliation_required" });
    const revoked = await updateStaffInvitation({ userId: owner, scope: "platform" }, org, created.invitation.id, { action: "revoke", expectedVersion: 1, confirmed: true });
    await expect(updateStaffInvitation({ userId: owner, scope: "platform" }, org, created.invitation.id, { action: "reissue", expectedVersion: revoked.version, confirmed: true }))
      .rejects.toMatchObject({ code: "invitation_delivery_reconciliation_required" });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("company staff cannot read platform identities, foreign organizations, or unverified sessions", async () => {
    await sendPlatformIdentityEmail(await message());
    expect((await listPlatformEmailDeliveries({ actorUserId: owner, scope: "member", organizationId: org })).deliveries).toEqual([]);
    await expect(listPlatformEmailDeliveries({ actorUserId: owner, scope: "member", organizationId: randomUUID() })).rejects.toMatchObject({ status: 403 });
    await expect(listPlatformEmailDeliveries({ actorUserId: user, scope: "platform" })).rejects.toMatchObject({ status: 403 });
    await db.update(usersTable).set({ emailVerifiedAt: null }).where(eq(usersTable.id, owner));
    await expect(listPlatformEmailDeliveries({ actorUserId: owner, scope: "platform" })).rejects.toMatchObject({ status: 403 });
  });
});
