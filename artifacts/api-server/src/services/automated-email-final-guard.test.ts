import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { appointmentsTable, automationsTable, contactsTable, customerLifecycleTable, db, DEFAULT_SENDING_HOURS, emailIntelligenceSourcesTable, emailResponseReviewsTable,
  emailSenderPreferencesTable, leadsTable, microsoftConnectionsTable, organizationsTable, playbookEnrollmentsTable, playbooksTable, revenueExecutionsTable, scheduledActionsTable, usersTable } from "@workspace/db";
import { encryptSecret } from "../lib/token-encryption";
import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";
import { processDueScheduledActions } from "./automation";
import { executePlaybookStep } from "./playbooks";
import { updateOrgSettings } from "./settings";
// Only drafting is synthetic; use the actual CustomerEmail/UserEmail/Microsoft chain.
vi.mock("./providers", async original => ({ ...await original<typeof import("./providers")>(), draftOutreachMessage: vi.fn(async () => ({ body: "Synthetic reviewed follow-up" })) }));
const orgs: string[] = [];
let afterRefresh: (() => Promise<void>) | undefined, posts = 0, ambiguous = false;
const mailbox = { id: "synthetic-automation-mailbox", mail: "automation-office@example.invalid" };
const transport = vi.fn<typeof fetch>();
const response = (value: unknown) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
beforeEach(() => {
  vi.stubEnv("MICROSOFT_OAUTH_CLIENT_ID", "synthetic-client"); vi.stubEnv("MICROSOFT_OAUTH_CLIENT_SECRET", "synthetic-secret");
  vi.stubEnv("APP_ORIGIN", "https://growth.example"); vi.stubEnv("OAUTH_TOKEN_ENCRYPTION_KEY", "ab".repeat(32)); vi.stubEnv("GROWTHOS_OUTBOUND_HOLD", "false");
  posts = 0; ambiguous = false; afterRefresh = undefined;
  transport.mockReset().mockImplementation(async input => {
    const url = String(input);
    if (url.startsWith("https://login.microsoftonline.com/") && url.endsWith("/token")) return response({ token_type: "Bearer", access_token: "synthetic-access", refresh_token: "synthetic-rotated", scope: "Mail.Send User.Read" });
    if (url.startsWith("https://graph.microsoft.com/v1.0/me?")) { await afterRefresh?.(); return response(mailbox); }
    if (url === "https://graph.microsoft.com/v1.0/me/sendMail") { posts++; if (ambiguous) throw new Error("Synthetic timeout after dispatch"); return new Response(null, { status: 202 }); }
    throw new Error("Unexpected synthetic transport operation");
  }); vi.stubGlobal("fetch", transport);
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
afterAll(async () => { await deleteTestOrgs(...orgs); });
async function fixture() {
  const [org] = await db.insert(organizationsTable).values({ name: "Synthetic final automation gate", slug: randomUUID() }).returning(); orgs.push(org.id);
  const [user] = await db.insert(usersTable).values({ organizationId: org.id, role: "owner", emailVerifiedAt: new Date() }).returning();
  const [contact] = await db.insert(contactsTable).values({ organizationId: org.id, firstName: "Synthetic", email: `${randomUUID()}@example.invalid`, preferredContactMethod: "email" }).returning();
  const [lead] = await db.insert(leadsTable).values({ organizationId: org.id, contactId: contact.id, assignedUserId: user.id, creationMethod: "form", status: "follow_up" }).returning();
  await db.insert(microsoftConnectionsTable).values({ organizationId: org.id, userId: user.id, accountId: mailbox.id, email: mailbox.mail,
    encryptedRefreshToken: encryptSecret("synthetic-refresh", `${org.id}:${user.id}:microsoft`), grantedScopes: ["mail.send", "user.read"] });
  await db.insert(emailSenderPreferencesTable).values({ organizationId: org.id, userId: user.id, provider: "microsoft" });
  await updateOrgSettings(org.id, { sendingHours: { ...DEFAULT_SENDING_HOURS, quietHoursEnabled: false, maxTouchesPerDay: 0 } });
  return { org: org.id, user: user.id, contact, lead };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function scheduled(f: Fixture) {
  return (await db.insert(scheduledActionsTable).values({ organizationId: f.org, action: { type: "send_email", params: { subject: "Exact subject", body: "Hello {{contact.firstName}}" } }, context: { leadId: f.lead.id }, runAt: new Date(Date.now() - 1000) }).returning())[0];
}
async function playbook(f: Fixture) {
  const [definition] = await db.insert(playbooksTable).values({ organizationId: f.org, name: "Synthetic final gate", category: "acquisition", steps: [{ channel: "email", delayMinutes: 0, prompt: "Synthetic content", subject: "Exact subject" }] }).returning();
  const [enrollment] = await db.insert(playbookEnrollmentsTable).values({ organizationId: f.org, playbookId: definition.id, leadId: f.lead.id, category: "acquisition", currentStep: 0, nextRunAt: new Date() }).returning();
  return { definition, enrollment };
}
async function lateChange(f: Fixture, kind: string) {
  if (kind === "recipient") await db.update(contactsTable).set({ email: "changed@example.invalid" }).where(eq(contactsTable.id, f.contact.id));
  if (kind === "optout") await db.update(contactsTable).set({ doNotContactEmail: true }).where(eq(contactsTable.id, f.contact.id));
  if (kind === "source") await db.update(leadsTable).set({ creationMethod: "import" }).where(eq(leadsTable.id, f.lead.id));
  if (kind === "company") await db.insert(customerLifecycleTable).values({ organizationId: f.org, state: "paused", reason: "Synthetic operator hold" });
  if (kind === "reply") {
    const [source] = await db.insert(emailIntelligenceSourcesTable).values({ organizationId: f.org, intakeAlias: `${randomUUID()}@example.invalid` }).returning();
    await db.insert(emailResponseReviewsTable).values({ organizationId: f.org, sourceId: source.id, externalMessageId: randomUUID(), payloadSha256: "a".repeat(64),
      state: "confirmed", reason: "synthetic_verified_reply", leadId: f.lead.id, contactId: f.contact.id, holdActive: true, replyAt: new Date() });
  }
}
describe("post-OAuth final guards preserve legacy automatic-send claims", () => {
  it("uses the real adapter and a fixed scheduled receipt for an unchanged permitted email", async () => {
    const f = await fixture(), action = await scheduled(f); await processDueScheduledActions(f.org); expect(posts).toBe(1);
    const [receipt] = await db.select().from(revenueExecutionsTable).where(eq(revenueExecutionsTable.organizationId, f.org)); expect(receipt).toMatchObject({ actionKey: `scheduled:${action.id}`, state: "succeeded" });
    await processDueScheduledActions(f.org); expect(posts).toBe(1);
  });
  it.each(["recipient", "optout", "source", "company", "reply", "cancelled action", "expired receipt", "changed template"])("stops scheduled email after %s changes during refresh and never queues a replacement", async kind => {
    const f = await fixture(), action = await scheduled(f);
    afterRefresh = async () => {
      await lateChange(f, kind);
      if (kind === "cancelled action") await db.update(scheduledActionsTable).set({ status: "cancelled" }).where(eq(scheduledActionsTable.id, action.id));
      if (kind === "expired receipt") await db.update(revenueExecutionsTable).set({ expiresAt: new Date(0) }).where(eq(revenueExecutionsTable.organizationId, f.org));
      if (kind === "changed template") await db.update(contactsTable).set({ firstName: "Changed render" }).where(eq(contactsTable.id, f.contact.id));
    };
    await processDueScheduledActions(f.org); expect(posts).toBe(0);
    const [receipt] = await db.select().from(revenueExecutionsTable).where(eq(revenueExecutionsTable.organizationId, f.org)); expect(receipt.state).toBe("blocked");
    await processDueScheduledActions(f.org); expect(posts).toBe(0);
    expect(await db.select().from(scheduledActionsTable).where(eq(scheduledActionsTable.organizationId, f.org))).toHaveLength(1);
  });
  it("the claimed final playbook step remains eligible only in its exact completed state", async () => {
    const f = await fixture(), p = await playbook(f);
    expect(await executePlaybookStep(f.org, { enrollmentId: p.enrollment.id, stepIndex: 0 })).toEqual({ status: "success", detail: "email:microsoft" });
    expect(posts).toBe(1); await executePlaybookStep(f.org, { enrollmentId: p.enrollment.id, stepIndex: 0 }); expect(posts).toBe(1);
  });
  it("a changed automation rule cannot keep sending its earlier policy after OAuth", async () => {
    const f = await fixture(), action = await scheduled(f);
    const [rule] = await db.insert(automationsTable).values({ organizationId: f.org, name: "Synthetic owned policy", event: "lead.created", isActive: true, conditions: {}, actions: [action.action] }).returning();
    await db.update(scheduledActionsTable).set({ automationId: rule.id }).where(eq(scheduledActionsTable.id, action.id));
    afterRefresh = async () => { await db.update(automationsTable).set({ conditions: { "lead.status": "nurture" } }).where(eq(automationsTable.id, rule.id)); };
    await processDueScheduledActions(f.org); expect(posts).toBe(0);
    const [receipt] = await db.select().from(revenueExecutionsTable).where(eq(revenueExecutionsTable.organizationId, f.org)); expect(receipt.state).toBe("blocked");
  });
  it.each(["recipient", "optout", "source", "company", "reply", "paused enrollment", "changed playbook", "changed stage"])("stops the claimed playbook email after %s changes during refresh", async kind => {
    const f = await fixture(), p = await playbook(f);
    afterRefresh = async () => {
      await lateChange(f, kind);
      if (kind === "paused enrollment") await db.update(playbookEnrollmentsTable).set({ status: "paused", pauseReason: "Human pause" }).where(eq(playbookEnrollmentsTable.id, p.enrollment.id));
      if (kind === "changed playbook") await db.update(playbooksTable).set({ isActive: false }).where(eq(playbooksTable.id, p.definition.id));
      if (kind === "changed stage") await db.update(leadsTable).set({ status: "won" }).where(eq(leadsTable.id, f.lead.id));
    };
    expect(await executePlaybookStep(f.org, { enrollmentId: p.enrollment.id, stepIndex: 0 })).toMatchObject({ status: "skipped", detail: expect.stringContaining("final_email_guard_changed") });
    expect(posts).toBe(0); const [saved] = await db.select().from(playbookEnrollmentsTable).where(eq(playbookEnrollmentsTable.id, p.enrollment.id));
    expect(saved).toMatchObject({ status: "paused", currentStep: 1, nextRunAt: null });
    await executePlaybookStep(f.org, { enrollmentId: p.enrollment.id, stepIndex: 0 }); expect(posts).toBe(0);
  });
  it.each(["unchanged", "rescheduled", "optout"])("appointment email rechecks the %s booking after refresh", async kind => {
    const f = await fixture(); const start = new Date(Date.now() + 3_600_000);
    const [appointment] = await db.insert(appointmentsTable).values({ organizationId: f.org, leadId: f.lead.id, contactId: f.contact.id, scheduledStart: start, scheduledEnd: null }).returning();
    await db.insert(scheduledActionsTable).values({ organizationId: f.org, action: { type: "appointment_reminder", params: { contactMethod: "email" } },
      context: { leadId: f.lead.id, appointmentId: appointment.id, fields: { "appointment.scheduledStart": start.toISOString() } }, runAt: new Date(Date.now() - 1000) });
    afterRefresh = async () => { await lateChange(f, kind); if (kind === "rescheduled") await db.update(appointmentsTable).set({ scheduledStart: new Date(start.getTime() + 600_000) }).where(eq(appointmentsTable.id, appointment.id)); };
    await processDueScheduledActions(f.org); expect(posts).toBe(kind === "unchanged" ? 1 : 0);
  });
  it("unknown automatic provider effects cannot be replayed by the scheduler", async () => {
    const f = await fixture(); await scheduled(f); ambiguous = true; await processDueScheduledActions(f.org); expect(posts).toBe(1);
    const [receipt] = await db.select().from(revenueExecutionsTable).where(eq(revenueExecutionsTable.organizationId, f.org)); expect(receipt.state).toBe("indeterminate");
    await processDueScheduledActions(f.org); expect(posts).toBe(1);
  });
});
