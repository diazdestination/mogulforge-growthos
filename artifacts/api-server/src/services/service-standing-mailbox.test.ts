import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { appointmentsTable, auditEventsTable, crmTasksTable, db, emailSenderPreferencesTable, microsoftConnectionsTable, pool, revenueExecutionsTable, usersTable } from "@workspace/db";
import { mailboxCommunicationParentsTable as parents } from "../../../../lib/db/src/schema/mailbox-communication";
import { serviceStandingFixture } from "../test-helpers/service-standing-fixture";
import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";
import { encryptSecret } from "../lib/token-encryption";
import { beginMailboxOAuth, completeMailboxOAuth, getMicrosoftMailboxIdentity } from "./mailbox-connector";
import { approveServiceStanding, disableServiceStanding, getServiceStanding, previewServiceStanding, serviceNoticeInstant } from "./service-standing-policy";
import { admitStandingServiceReminder } from "./service-standing-runtime";
import { processDueScheduledActions } from "./automation";
import { bindMailboxSentParent, ingestMailboxReply, listServiceMailboxReplies } from "./mailbox-communication";
import { getServiceCare } from "./service-care";
import { updateTask } from "./crm";

// The PG barrier pauses only AFTER real authority and its row lock succeed.
// It does not replace, weaken or manufacture an authority decision.
const finalClaim = vi.hoisted(() => ({ afterLocked: null as null | ((reader: import("./service-standing-policy").StandingReader, org: string) => Promise<void>) }));
vi.mock("./service-care-authorization", async importOriginal => {
  const actual = await importOriginal<typeof import("./service-care-authorization")>();
  return { ...actual, assertServiceCareAuthorizationCurrent: async (...args: Parameters<typeof actual.assertServiceCareAuthorizationCurrent>) => {
    const result = await actual.assertServiceCareAuthorizationCurrent(...args);
    if (args[4]?.lockTask) await finalClaim.afterLocked?.(args[0], args[1]);
    return result;
  } };
});

// Real policy, admission, sender, OAuth preparation and parent/reply code.
// Provider responses are synthetic; every unrecognized URL fails closed.
const orgs: string[] = [];
const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
type Message = { subject: string; body: { content: string }; internetMessageHeaders: { name: string; value: string }[] };
afterEach(() => { finalClaim.afterLocked = null; vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
afterAll(async () => { await deleteTestOrgs(...orgs); });
async function fixture() {
  vi.stubEnv("MICROSOFT_MAILBOX_READ_ENABLED", "true"); vi.stubEnv("MICROSOFT_OAUTH_CLIENT_ID", "synthetic-client"); vi.stubEnv("MICROSOFT_OAUTH_CLIENT_SECRET", "synthetic-secret");
  vi.stubEnv("APP_ORIGIN", "https://growth.example"); vi.stubEnv("OAUTH_TOKEN_ENCRYPTION_KEY", "bc".repeat(32)); vi.stubEnv("EMAIL_INTELLIGENCE_ENCRYPTION_KEY", "cd".repeat(32)); vi.stubEnv("GROWTHOS_OUTBOUND_HOLD", "false");
  const f = await serviceStandingFixture(); orgs.push(f.org);
  const actor = { organizationId: f.org, userId: f.owner.id }, profile = { id: "synthetic-standing-mailbox", mail: "office@example.invalid" };
  await db.insert(microsoftConnectionsTable).values({ ...actor, accountId: profile.id, email: profile.mail, encryptedRefreshToken: encryptSecret("synthetic-send-refresh", `${f.org}:${f.owner.id}:microsoft`), grantedScopes: ["mail.send", "user.read"] });
  await db.insert(emailSenderPreferencesTable).values({ ...actor, provider: "microsoft" });
  const tokens = (scope: string) => ({ token_type: "Bearer", access_token: "synthetic-access", refresh_token: "synthetic-refresh", scope });
  const state = new URL(await beginMailboxOAuth(actor, { expectedVersion: 0, readAcknowledged: true, retentionAcknowledged: true })).searchParams.get("state")!;
  const setup = vi.fn<typeof fetch>().mockResolvedValueOnce(json(tokens("Mail.Read User.Read"))).mockResolvedValueOnce(json(profile)).mockResolvedValueOnce(json({ id: "inbox_standing" })).mockResolvedValueOnce(json({ id: "sent_standing" }));
  await completeMailboxOAuth(actor, state, "synthetic-code", setup);
  const identity = (await getMicrosoftMailboxIdentity(f.org, f.owner.id))!;
  const view = await getServiceStanding(f.org, f.obligation.id);
  const preview = await previewServiceStanding(f.org, f.owner.id, f.obligation.id, { expectedVersion: view.version, expectedUpdatedAt: view.expectedUpdatedAt, policy: { enabled: true, channel: "email",
    agreementStartsOn: "2020-01-01", agreementEndsOn: "2040-12-31", agreementEvidence: "Owner reviewed exact synthetic recurring maintenance agreement.",
    sourceReview: { kind: "native", verifiedAt: new Date().toISOString(), cutoverAt: null, evidence: "Native customer and agreement verified for expected-service messages." } } });
  const approved = await approveServiceStanding(f.org, f.owner.id, f.obligation.id, { expectedVersion: preview.expectedVersion, expectedSnapshot: preview.expectedSnapshot, previewHash: preview.previewHash, confirmed: true });
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(serviceNoticeInstant(f.obligation).getTime() + 60_000));
  await admitStandingServiceReminder(f.org, approved.enrollmentId!);
  return { ...f, actor, identity, profile, tokens, approved };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function disable(f: Fixture) { await disableServiceStanding(f.org, f.owner.id, f.obligation.id, { requestId: randomUUID(), expectedVersion: 1, reason: "Owner explicitly paused this synthetic service series.", confirmed: true }); }
describe("standing authorization with exact Microsoft parent", () => {
  it.each([false, true])("tracks a typed original standing parent and a reply after policy disable, unknown=%s", async unknown => {
    const f = await fixture(); let posted: Message | null = null, attempts = 0, lockedClaims = 0;
    finalClaim.afterLocked = async (_reader, org) => { if (org === f.org) lockedClaims++; };
    const transport = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/token")) return json(f.tokens("Mail.Send User.Read"));
      if (url.startsWith("https://graph.microsoft.com/v1.0/me?")) return json(f.profile);
      if (url === "https://graph.microsoft.com/v1.0/me/sendMail" && init?.method === "POST") {
        attempts++; posted = JSON.parse(String(init.body)).message as Message;
        const [parent] = await db.select().from(parents).where(eq(parents.organizationId, f.org));
        expect(parent.dispatchStartedAt).toBeTruthy(); expect(parent.contextSnapshot).toMatchObject({ authorization: { origin: "standing", fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) } });
        if (unknown) throw new Error("Synthetic timeout after Microsoft POST");
        return new Response(null, { status: 202 });
      }
      throw new Error("Unexpected provider URL; no network fallback");
    });
    vi.stubGlobal("fetch", transport); await processDueScheduledActions(f.org); expect(attempts).toBe(1); expect(posted).not.toBeNull(); expect(lockedClaims).toBe(1);
    const [parent] = await db.select().from(parents).where(eq(parents.organizationId, f.org));
    await disable(f);
    const message = posted as unknown as Message, sentAt = parent.dispatchStartedAt!;
    expect(await bindMailboxSentParent(f.identity, { correlationHeader: parent.correlationHeader, providerMessageId: `synthetic-sent-${parent.id}`, internetMessageId: `<${parent.id}@example.invalid>`,
      from: f.profile.mail, to: [parent.recipient], subject: message.subject, sentAt })).toMatchObject({ matched: true, parentId: parent.id });
    expect(await ingestMailboxReply(f.identity, { providerMessageId: `synthetic-reply-${parent.id}`, internetMessageId: `<reply-${parent.id}@example.invalid>`, inReplyTo: [`<${parent.id}@example.invalid>`],
      from: parent.recipient, to: [f.profile.mail], subject: `Re: ${message.subject}`, text: "Please call me. This is data, not permission to book or resume automation.", receivedAt: new Date(), sentAt: new Date() })).toMatchObject({ state: "needs_review" });
    expect((await listServiceMailboxReplies(f.org, f.owner.id, f.obligation.id)).items[0]).toMatchObject({ holdActive: true, state: "needs_review" });
    expect((await getServiceCare(f.org, f.obligation.id)).reminder).toMatchObject({ origin: "standing", state: unknown ? "indeterminate" : "succeeded" });
    expect((await db.select().from(revenueExecutionsTable).where(eq(revenueExecutionsTable.organizationId, f.org)))[0].state).toBe(unknown ? "indeterminate" : "succeeded");
    expect(await db.select().from(appointmentsTable).where(eq(appointmentsTable.organizationId, f.org))).toHaveLength(0);
    expect((await db.select().from(auditEventsTable).where(eq(auditEventsTable.organizationId, f.org))).some(row => row.action === "service.care_response_recorded")).toBe(false);
    await processDueScheduledActions(f.org); expect(attempts).toBe(1);
  });
  it("revocation during OAuth preparation blocks the original parent before the provider POST", async () => {
    const f = await fixture(); let posts = 0, changed = false;
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async input => {
      const url = String(input);
      if (url.endsWith("/token")) { if (!changed) { changed = true; await disable(f); } return json(f.tokens("Mail.Send User.Read")); }
      if (url.startsWith("https://graph.microsoft.com/v1.0/me?")) return json(f.profile);
      if (url.endsWith("/sendMail")) { posts++; throw new Error("Must never reach provider POST"); }
      throw new Error("Unexpected provider URL; no network fallback");
    }));
    await processDueScheduledActions(f.org); expect(changed).toBe(true); expect(posts).toBe(0);
    const [parent] = await db.select().from(parents).where(eq(parents.organizationId, f.org)); expect(parent.dispatchStartedAt).toBeNull();
    expect((await getServiceCare(f.org, f.obligation.id)).reminder?.state).toBe("blocked");
  });
  it.each(["closed", "reassigned"] as const)("a real task edit committed during OAuth preparation (%s) blocks the provider POST", async change => {
    const f = await fixture(); let posts = 0, changed = false;
    const [other] = await db.insert(usersTable).values({ organizationId: f.org, role: "owner", emailVerifiedAt: new Date() }).returning();
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async input => {
      const url = String(input);
      if (url.endsWith("/token")) {
        if (!changed) {
          const task = await updateTask(f.org, f.obligation.taskId, change === "closed" ? { status: "done" } : { assignedUserId: other.id });
          expect(task).toMatchObject(change === "closed" ? { status: "done", completedAt: expect.any(Date) } : { assignedUserId: other.id });
          changed = true;
        }
        return json(f.tokens("Mail.Send User.Read"));
      }
      if (url.startsWith("https://graph.microsoft.com/v1.0/me?")) return json(f.profile);
      if (url.endsWith("/sendMail")) { posts++; throw new Error("Must never reach provider POST"); }
      throw new Error("Unexpected provider URL; no network fallback");
    }));
    await processDueScheduledActions(f.org); expect(changed).toBe(true); expect(posts).toBe(0);
    const [parent] = await db.select().from(parents).where(eq(parents.organizationId, f.org)); expect(parent.dispatchStartedAt).toBeNull();
    expect((await getServiceCare(f.org, f.obligation.id)).reminder?.state).toBe("blocked");
    await processDueScheduledActions(f.org); expect(posts).toBe(0);
  });
  it.skipIf(process.env.SCHEDULER_TEST_BACKEND === "pglite")("serializes a real generic task edit behind the actual final Microsoft parent claim", async () => {
    const f = await fixture(); let posts = 0, claimPid: number | null = null, writerSettled = false;
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    finalClaim.afterLocked = async (reader, org) => {
      if (org !== f.org) return;
      const result = await reader.execute(sql`select pg_backend_pid()::int as pid`);
      claimPid = Number(result.rows[0]?.pid);
      await barrier;
    };
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/token")) return json(f.tokens("Mail.Send User.Read"));
      if (url.startsWith("https://graph.microsoft.com/v1.0/me?")) return json(f.profile);
      if (url === "https://graph.microsoft.com/v1.0/me/sendMail" && init?.method === "POST") {
        posts++;
        const [parent] = await db.select().from(parents).where(eq(parents.organizationId, f.org));
        expect(parent.dispatchStartedAt).toBeTruthy();
        return new Response(null, { status: 202 });
      }
      throw new Error("Unexpected provider URL; no network fallback");
    }));
    const running = processDueScheduledActions(f.org);
    let writing: ReturnType<typeof updateTask> | undefined;
    try {
      for (let attempt = 0; attempt < 200 && !claimPid; attempt++) await new Promise(resolve => setTimeout(resolve, 20));
      expect(claimPid).toBeGreaterThan(0);
      const [unclaimed] = await db.select().from(parents).where(eq(parents.organizationId, f.org));
      expect(unclaimed.dispatchStartedAt).toBeNull(); expect(posts).toBe(0);
      // Keep eligibility valid after this claim: separate cases above prove
      // committed closure/reassignment blocks the later complete send guard.
      writing = updateTask(f.org, f.obligation.taskId, { status: "in_progress", description: "A real concurrent office edit must remain intact." })
        .then(task => { writerSettled = true; return task; });
      let blockedByClaim = false;
      for (let attempt = 0; attempt < 200; attempt++) {
        const result = await pool.query<{ count: number }>("SELECT count(*)::int AS count FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid)) AND query LIKE '%update \"crm_tasks\"%'", [claimPid]);
        if (result.rows[0].count > 0) { blockedByClaim = true; break; }
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      expect(blockedByClaim).toBe(true); expect(writerSettled).toBe(false); expect(posts).toBe(0);
      expect((await db.select().from(parents).where(eq(parents.id, unclaimed.id)))[0].dispatchStartedAt).toBeNull();
      release();
      await running;
      expect(await writing).toMatchObject({ status: "in_progress", assignedUserId: f.owner.id, completedAt: null });
      expect(posts).toBe(1);
      expect((await db.select().from(parents).where(eq(parents.id, unclaimed.id)))[0].dispatchStartedAt).toBeTruthy();
      expect((await db.select().from(crmTasksTable).where(eq(crmTasksTable.id, f.obligation.taskId)))[0]).toMatchObject({
        status: "in_progress", assignedUserId: f.owner.id, description: expect.stringContaining("A real concurrent office edit must remain intact."), completedAt: null,
      });
      await processDueScheduledActions(f.org); expect(posts).toBe(1);
    } finally {
      release(); finalClaim.afterLocked = null;
      await Promise.allSettled([running, ...(writing ? [writing] : [])]);
    }
  }, 15_000);
  it.each(["in_progress", "done"] as const)("retains an entire staff-owned %s task when an exact standing Microsoft reply arrives", async status => {
    const f = await fixture(); let posted: Message | null = null, attempts = 0;
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/token")) return json(f.tokens("Mail.Send User.Read"));
      if (url.startsWith("https://graph.microsoft.com/v1.0/me?")) return json(f.profile);
      if (url === "https://graph.microsoft.com/v1.0/me/sendMail" && init?.method === "POST") {
        attempts++; posted = JSON.parse(String(init.body)).message as Message;
        return new Response(null, { status: 202 });
      }
      throw new Error("Unexpected provider URL; no network fallback");
    }));
    await processDueScheduledActions(f.org); expect(attempts).toBe(1); expect(posted).not.toBeNull();
    const [parent] = await db.select().from(parents).where(eq(parents.organizationId, f.org));
    const message = posted as unknown as Message;
    expect(await bindMailboxSentParent(f.identity, { correlationHeader: parent.correlationHeader, providerMessageId: `synthetic-sent-${parent.id}`, internetMessageId: `<${parent.id}@example.invalid>`,
      from: f.profile.mail, to: [parent.recipient], subject: message.subject, sentAt: parent.dispatchStartedAt! })).toMatchObject({ matched: true });
    const [staffPlan] = await db.update(crmTasksTable).set({ status, assignedUserId: f.owner.id, completedAt: status === "done" ? new Date() : null,
      dueAt: new Date(Date.now() + 2 * 3_600_000), description: "Office plan: call after the technician returns; retain this explicit commitment." }).where(eq(crmTasksTable.id, f.obligation.taskId)).returning();
    const reply = { providerMessageId: `synthetic-reply-${parent.id}`, internetMessageId: `<reply-${parent.id}@example.invalid>`, inReplyTo: [`<${parent.id}@example.invalid>`],
      from: parent.recipient, to: [f.profile.mail], subject: `Re: ${message.subject}`, text: "Please contact me about my service.", receivedAt: new Date(), sentAt: new Date() };
    expect(await ingestMailboxReply(f.identity, reply)).toMatchObject({ state: "needs_review" });
    expect((await listServiceMailboxReplies(f.org, f.owner.id, f.obligation.id)).items[0]).toMatchObject({ holdActive: true, state: "needs_review" });
    expect((await db.select().from(crmTasksTable).where(eq(crmTasksTable.id, f.obligation.taskId)))[0]).toEqual(staffPlan);
    expect(await ingestMailboxReply(f.identity, reply)).toMatchObject({ state: "duplicate" });
    expect((await db.select().from(crmTasksTable).where(eq(crmTasksTable.id, f.obligation.taskId)))[0]).toEqual(staffPlan);
    expect(await db.select().from(appointmentsTable).where(eq(appointmentsTable.organizationId, f.org))).toHaveLength(0);
    await processDueScheduledActions(f.org); expect(attempts).toBe(1);
  });
});
