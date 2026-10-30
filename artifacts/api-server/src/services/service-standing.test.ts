import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { activitiesTable, auditEventsTable, contactsTable, crmTasksTable, customerLifecycleTable, db, gmailConnectionsTable, leadsTable, orgSettingsTable, revenueExecutionsTable, scheduledActionsTable, zapierActionExecutionsTable, serviceObligationsTable, usersTable } from "@workspace/db";
import { serviceStandingEnrollmentsTable as enrollments, serviceStandingPolicyRevisionsTable as revisions } from "../../../../lib/db/src/schema/service-standing";
import { contactTouchReservationsTable } from "../../../../lib/db/src/schema/contact-touch-reservations";
import { serviceStandingFixture } from "../test-helpers/service-standing-fixture";
import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";
import { approveServiceStanding, assertStandingAuthority, disableServiceStanding, getServiceStanding, lockServiceStanding, previewServiceStanding, readStandingService, serviceNoticeInstant } from "./service-standing-policy";
import { serviceStandingViewSchema } from "./service-standing-contract";
import { admitStandingServiceReminder, processStandingServiceReminders, publishStandingMonitorCheckpoint } from "./service-standing-runtime";
import { resolveCustomerEmailSender, sendCustomerEmail } from "./customer-email";
import { approveServiceCare, getServiceCare } from "./service-care";
import { processDueScheduledActions } from "./automation";
import { approveServiceRecurrence, updateServiceObligation } from "./service-obligations";
import { runDurableAction } from "./durable-execution";
import { ServiceClaimDeferredError } from "./service-care-claim";
import { checkOutreachTiming } from "./send-gate";
import { assertServiceCareAuthorizationCurrent } from "./service-care-authorization";
import { updateTask } from "./crm";
import { contactTouchTimes } from "./contact-touch-claim";

vi.mock("./customer-email", () => ({ resolveCustomerEmailSender: vi.fn(), sendCustomerEmail: vi.fn() }));
const orgs: string[] = [], effects: string[] = [], senders = new Map<string, string>();
let lateChange: (() => Promise<void>) | null = null, unknownEffect = false;
beforeEach(() => {
  vi.stubEnv("GROWTHOS_OUTBOUND_HOLD", "false");
  vi.stubEnv("GOOGLE_OAUTH_CLIENT_ID", "synthetic-standing-client"); vi.stubEnv("GOOGLE_OAUTH_CLIENT_SECRET", "synthetic-standing-secret"); vi.stubEnv("OAUTH_TOKEN_ENCRYPTION_KEY", "ab".repeat(32));
  vi.mocked(resolveCustomerEmailSender).mockImplementation(async ({ organizationId }) => ({ userId: senders.get(organizationId)!, source: "company_default", provider: "gmail", senderEmail: "office@example.invalid" }));
  vi.mocked(sendCustomerEmail).mockImplementation(async input => { await lateChange?.(); await input.beforeDispatch?.(); effects.push(input.organizationId); if (unknownEffect) throw new Error("Synthetic uncertain effect"); return { provider: "gmail", id: "synthetic", acceptance: "accepted", senderEmail: "office@example.invalid", senderUserId: senders.get(input.organizationId)! }; });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); effects.length = 0; lateChange = null; unknownEffect = false; });
afterAll(async () => { await deleteTestOrgs(...orgs); });
async function fixture(source = "manual") { const f = await serviceStandingFixture(source); orgs.push(f.org); senders.set(f.org, f.owner.id); return f; }
type F = Awaited<ReturnType<typeof fixture>>;
async function preview(f: F, patch: Record<string, unknown> = {}) {
  const view = await getServiceStanding(f.org, f.obligation.id);
  return previewServiceStanding(f.org, f.owner.id, f.obligation.id, { expectedVersion: view.version, expectedUpdatedAt: view.expectedUpdatedAt,
    policy: { enabled: true, channel: "email", agreementStartsOn: "2020-01-01", agreementEndsOn: "2040-12-31", agreementEvidence: "Owner reviewed exact expected-service agreement, independently of warranty coverage.",
      sourceReview: { kind: view.sourceSummary.source === "manual" ? "native" : "reconciled_import", verifiedAt: new Date().toISOString(), cutoverAt: view.sourceSummary.source === "manual" ? null : new Date(Date.now() - 1000).toISOString(), evidence: "Verified current source agreement and no duplicate reminders in previous system." }, ...patch } });
}
async function approve(f: F) { const p = await preview(f); return approveServiceStanding(f.org, f.owner.id, f.obligation.id, { expectedVersion: p.expectedVersion, expectedSnapshot: p.expectedSnapshot, previewHash: p.previewHash, confirmed: true }); }
function atNotice(f: F) { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(serviceNoticeInstant(f.obligation).getTime() + 60_000)); }
async function admitted(f: F) { const view = await approve(f); atNotice(f); const result = await admitStandingServiceReminder(f.org, view.enrollmentId!); return { view, result }; }

describe("owner-reviewed forward-only standing service authority", () => {
  it("defaults off with a SELECT-only view even with no settings, provider or active company", async () => {
    const f = await fixture(); await db.delete(orgSettingsTable).where(eq(orgSettingsTable.organizationId, f.org));
    await db.insert(customerLifecycleTable).values({ organizationId: f.org, state: "paused", version: 1, reason: "Synthetic paused company fixture" });
    const value = await getServiceStanding(f.org, f.obligation.id);
    expect(serviceStandingViewSchema.safeParse(value).success).toBe(true); expect(value.version).toBe(0); expect(value.policy).toBeNull();
    expect(await db.select().from(orgSettingsTable).where(eq(orgSettingsTable.organizationId, f.org))).toHaveLength(0);
    expect(await db.select().from(enrollments).where(eq(enrollments.organizationId, f.org))).toHaveLength(0);
  });
  it("persists exact actor-bound ten-minute reviews and rejects tampering, another actor and stale source", async () => {
    const f = await fixture(), p = await preview(f);
    const input = { expectedVersion: p.expectedVersion, expectedSnapshot: p.expectedSnapshot, previewHash: p.previewHash, confirmed: true };
    await expect(approveServiceStanding(f.org, f.owner.id, f.obligation.id, { ...input, expectedSnapshot: { ...p.expectedSnapshot, actorUserId: "changed" } })).rejects.toMatchObject({ code: "invalid_policy_preview" });
    const [other] = await db.insert(usersTable).values({ organizationId: f.org, role: "owner", emailVerifiedAt: new Date() }).returning();
    await expect(approveServiceStanding(f.org, other.id, f.obligation.id, input)).rejects.toMatchObject({ code: "stale_policy_preview" });
    await db.update(contactsTable).set({ email: "changed@example.invalid" }).where(eq(contactsTable.id, f.contactId));
    await expect(approveServiceStanding(f.org, f.owner.id, f.obligation.id, input)).rejects.toMatchObject({ code: "stale_service_policy" });
    expect(await db.select().from(revisions).where(eq(revisions.organizationId, f.org))).toHaveLength(0);
  });
  it("rejects expired reviews and demoted policy approvers without creating enrollment", async () => {
    const f = await fixture(), p = await preview(f); vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(Date.parse(p.expiresAt) + 1));
    await expect(approveServiceStanding(f.org, f.owner.id, f.obligation.id, { expectedVersion: 0, expectedSnapshot: p.expectedSnapshot, previewHash: p.previewHash, confirmed: true })).rejects.toMatchObject({ code: "stale_policy_preview" });
    vi.useRealTimers(); await db.update(usersTable).set({ role: "office" }).where(eq(usersTable.id, f.owner.id));
    await expect(preview(f)).rejects.toMatchObject({ code: "permission_denied" });
  });
  it("queues only after a future notice and sends once with an honest standing origin", async () => {
    const f = await fixture(), view = await approve(f);
    expect((await admitStandingServiceReminder(f.org, view.enrollmentId!)).code).toBe("future_notice");
    expect(await db.select().from(scheduledActionsTable).where(eq(scheduledActionsTable.organizationId, f.org))).toHaveLength(0);
    atNotice(f); await admitStandingServiceReminder(f.org, view.enrollmentId!); await admitStandingServiceReminder(f.org, view.enrollmentId!);
    await processDueScheduledActions(f.org); await processDueScheduledActions(f.org);
    expect(effects).toEqual([f.org]); expect((await getServiceCare(f.org, f.obligation.id)).reminder).toMatchObject({ origin: "standing", policyRevisionId: view.revisionId, state: "succeeded", deliveryConfirmed: false });
    expect(await db.select().from(scheduledActionsTable).where(eq(scheduledActionsTable.organizationId, f.org))).toHaveLength(1);
  });
  it("does not let an old future-notice checkpoint postpone a freshly reviewed policy", async () => {
    const f = await fixture(), original = await approve(f);
    const [observed] = await db.select().from(enrollments).where(eq(enrollments.id, original.enrollmentId!));
    const oldResult = await admitStandingServiceReminder(f.org, observed.id);
    expect(oldResult.code).toBe("future_notice");
    // Deterministic barrier: the old read has finished but not checkpointed.
    // Staff changes the date and approves a new exact policy before it resumes.
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(Date.now() + 60_000));
    const earlierDue = new Date(Date.now() + 8 * 86_400_000);
    const [changed] = await db.update(serviceObligationsTable).set({ dueAt: earlierDue,
      recurrence: { ...f.obligation.recurrence!, anchorDate: earlierDue.toISOString().slice(0, 10) } }).where(eq(serviceObligationsTable.id, f.obligation.id)).returning();
    const revised = await approve({ ...f, obligation: changed });
    expect(revised.version).toBe(2);
    const [newWake] = await db.select().from(enrollments).where(eq(enrollments.id, observed.id));
    expect(newWake.nextCheckAt.getTime()).toBe(Date.now());
    expect(oldResult.nextCheckAt.getTime()).toBeGreaterThan(serviceNoticeInstant(changed).getTime());
    vi.setSystemTime(new Date(serviceNoticeInstant(changed).getTime() + 60_000));
    expect(await publishStandingMonitorCheckpoint(observed, original.revisionId!, oldResult)).toBe(false);
    expect((await db.select().from(enrollments).where(eq(enrollments.id, observed.id)))[0]).toEqual(newWake);
    await processStandingServiceReminders(f.org);
    expect(await db.select().from(scheduledActionsTable).where(eq(scheduledActionsTable.organizationId, f.org))).toHaveLength(1);
  });
  it("does not overwrite a newer checkpoint from the same policy head", async () => {
    const f = await fixture(), view = await approve(f);
    const [observed] = await db.select().from(enrollments).where(eq(enrollments.id, view.enrollmentId!));
    const oldResult = await admitStandingServiceReminder(f.org, observed.id);
    expect(await publishStandingMonitorCheckpoint(observed, view.revisionId!, { code: "readiness_check_failed", nextCheckAt: new Date(Date.now() + 15 * 60_000) })).toBe(true);
    const [newCheckpoint] = await db.select().from(enrollments).where(eq(enrollments.id, observed.id));
    expect(await publishStandingMonitorCheckpoint(observed, view.revisionId!, oldResult)).toBe(false);
    expect((await db.select().from(enrollments).where(eq(enrollments.id, observed.id)))[0]).toEqual(newCheckpoint);
  });
  it("requires an explicit transaction for the task lock and observes committed generic task edits", async () => {
    const f = await fixture(), { result } = await admitted(f);
    const [action] = await db.select().from(scheduledActionsTable).where(eq(scheduledActionsTable.organizationId, f.org));
    await expect(readStandingService(db, f.org, f.obligation.id, { lockTask: true })).rejects.toMatchObject({ code: "service_task_lock_requires_transaction" });
    // This writer has no scheduling advisory lock. The final claim must read
    // and lock its current result, not depend on all writers sharing that lock.
    await updateTask(f.org, f.obligation.taskId, { status: "done" });
    await expect(db.transaction(async tx => {
      await lockServiceStanding(tx, f.org);
      return assertServiceCareAuthorizationCurrent(tx, f.org, result.approvalId!, action.id, { lockTask: true });
    })).rejects.toMatchObject({ code: "service_authority_changed" });
    expect(effects).toHaveLength(0);
  });
  it("does not backfill a notice already due before policy approval", async () => {
    const f = await fixture(); await db.update(serviceObligationsTable).set({ dueAt: new Date(Date.now() - 86_400_000), noticeDays: 7, recurrence: { ...f.obligation.recurrence!, anchorDate: new Date(Date.now() - 86_400_000).toISOString().slice(0, 10) } }).where(eq(serviceObligationsTable.id, f.obligation.id));
    const view = await approve(f); expect(view.occurrence.reason).toBe("historical_notice_requires_individual_review");
    await expect(admitStandingServiceReminder(f.org, view.enrollmentId!)).rejects.toMatchObject({ code: "historical_notice_requires_individual_review" });
  });
  it("requires explicitly reconciled imported service source but never adopts imported opportunity outreach", async () => {
    const f = await fixture("housecall_pro_import");
    await expect(preview(f, { sourceReview: { kind: "native", verifiedAt: new Date().toISOString(), cutoverAt: null, evidence: "Not a valid native source attestation." } })).rejects.toMatchObject({ code: "source_review_required" });
    const view = await approve(f); atNotice(f);
    await db.insert(leadsTable).values({ organizationId: f.org, contactId: f.contactId, creationMethod: "import", source: "csv_import" });
    await expect(admitStandingServiceReminder(f.org, view.enrollmentId!)).rejects.toMatchObject({ code: "imported_source_requires_current_review" });
    expect((await getServiceStanding(f.org, f.obligation.id)).readiness.reason).toBe("imported_source_requires_current_review");
  });
  it.each(["recipient", "owner", "sender", "sending_hours", "recurrence", "agreement"])("holds exact %s changes after approval", async change => {
    const f = await fixture(), view = await approve(f); atNotice(f);
    if (change === "recipient") await db.update(contactsTable).set({ email: "other@example.invalid" }).where(eq(contactsTable.id, f.contactId));
    if (change === "owner") await db.update(crmTasksTable).set({ assignedUserId: null }).where(eq(crmTasksTable.id, f.obligation.taskId));
    if (change === "sender") await db.update(gmailConnectionsTable).set({ connectedAt: new Date() }).where(eq(gmailConnectionsTable.organizationId, f.org));
    if (change === "sending_hours") await db.update(orgSettingsTable).set({ sendingHours: { quietHoursEnabled: false, maxTouchesPerDay: 1 } }).where(eq(orgSettingsTable.organizationId, f.org));
    if (change === "recurrence") await db.update(serviceObligationsTable).set({ recurrence: { ...f.obligation.recurrence!, intervalMonths: 2 } }).where(eq(serviceObligationsTable.id, f.obligation.id));
    if (change === "agreement") vi.setSystemTime(new Date(f.obligation.dueAt.getTime() + 1));
    await expect(admitStandingServiceReminder(f.org, view.enrollmentId!)).rejects.toThrow(); expect(effects).toHaveLength(0);
  });
  it("disable remains replay-safe under provider/lifecycle holds and never changes original receipt", async () => {
    const f = await fixture(), { view } = await admitted(f); unknownEffect = true; await processDueScheduledActions(f.org);
    vi.stubEnv("GROWTHOS_OUTBOUND_HOLD", "true"); await db.update(gmailConnectionsTable).set({ revokedAt: new Date() }).where(eq(gmailConnectionsTable.organizationId, f.org));
    await db.insert(customerLifecycleTable).values({ organizationId: f.org, state: "paused", version: 1, reason: "Synthetic paused company fixture" });
    const command = { requestId: randomUUID(), expectedVersion: 1, reason: "Owner disabled this exact standing service series.", confirmed: true };
    expect((await disableServiceStanding(f.org, f.owner.id, f.obligation.id, command)).version).toBe(2);
    expect((await disableServiceStanding(f.org, f.owner.id, f.obligation.id, command)).version).toBe(2);
    expect((await getServiceCare(f.org, f.obligation.id)).reminder?.state).toBe("indeterminate"); expect(effects).toHaveLength(1);
    expect((await db.select().from(revisions).where(eq(revisions.enrollmentId, view.enrollmentId!))).map(r => r.enabled)).toEqual([true, false]);
  });
  it.each(["disable", "recipient", "task_closed", "reply"])("rechecks %s between claim/preparation and provider POST", async change => {
    const f = await fixture(); await admitted(f);
    lateChange = async () => {
      if (change === "disable") await disableServiceStanding(f.org, f.owner.id, f.obligation.id, { requestId: randomUUID(), expectedVersion: 1, reason: "Disabled during synthetic preparation race.", confirmed: true });
      if (change === "recipient") await db.update(contactsTable).set({ email: "changed@example.invalid" }).where(eq(contactsTable.id, f.contactId));
      if (change === "task_closed") await db.update(crmTasksTable).set({ status: "done", completedAt: new Date() }).where(eq(crmTasksTable.id, f.obligation.taskId));
      if (change === "reply") await db.insert(auditEventsTable).values({ organizationId: f.org, actorUserId: f.owner.id, action: "service.care_response_recorded", entityType: "service_obligation", entityId: f.obligation.id, metadata: { outcome: "follow_up" } });
    };
    await processDueScheduledActions(f.org); expect(effects).toHaveLength(0); expect((await getServiceCare(f.org, f.obligation.id)).reminder?.state).toBe("blocked");
  });
  it("does not rearm an uncertain occurrence on a later revised policy or alternate channel", async () => {
    const f = await fixture(), { view } = await admitted(f); unknownEffect = true; await processDueScheduledActions(f.org);
    expect((await getServiceCare(f.org, f.obligation.id)).reminder?.state).toBe("indeterminate");
    await admitStandingServiceReminder(f.org, view.enrollmentId!); await processDueScheduledActions(f.org);
    const care = await getServiceCare(f.org, f.obligation.id);
    await expect(approveServiceCare(f.org, f.owner.id, f.obligation.id, { requestId: randomUUID(), expectedUpdatedAt: care.expectedUpdatedAt, channel: "email", previewFingerprint: care.preview!.fingerprint, agreementNote: "Attempted individual approval after uncertain standing reminder.", expectedServiceConfirmed: true })).rejects.toMatchObject({ code: "reminder_exists" });
    expect(effects).toHaveLength(1);
  });
  it("legitimate anchor completion creates one exact eligible successor without requiring unchanged ancestor timestamps", async () => {
    const f = await fixture(), view = await approve(f);
    const completed = await updateServiceObligation(f.org, f.owner.id, f.obligation.id, { expectedUpdatedAt: f.obligation.updatedAt.toISOString(), status: "completed", completionNote: "Synthetic physical maintenance visit completed by technician." });
    if ("error" in completed) throw new Error(completed.error);
    expect(completed.nextObligationId).toBeTruthy();
    const result = await assertStandingAuthority(db, f.org, view.revisionId!, completed.nextObligationId!);
    expect(result.obligation.source).toBe("approved_recurrence"); expect(result.obligation.occurrenceIndex).toBe(1);
    expect(result.task.assignedUserId).toBe(f.owner.id);
    expect(await db.select().from(serviceObligationsTable).where(eq(serviceObligationsTable.predecessorObligationId, f.obligation.id))).toHaveLength(1);
  });
  it("preserves month-end/leap-day recurrence and rejects a foreign predecessor chain", async () => {
    const f = await fixture();
    const [updated] = await db.update(serviceObligationsTable).set({ dueAt: new Date("2036-01-31T12:00:00Z"), recurrence: { ...f.obligation.recurrence!, anchorDate: "2036-01-31" } }).where(eq(serviceObligationsTable.id, f.obligation.id)).returning();
    f.obligation = updated;
    const view = await approve(f);
    const first = await updateServiceObligation(f.org, f.owner.id, f.obligation.id, { expectedUpdatedAt: updated.updatedAt.toISOString(), status: "completed", completionNote: "Synthetic January visit complete." });
    if ("error" in first) throw new Error(first.error);
    const february = await assertStandingAuthority(db, f.org, view.revisionId!, first.nextObligationId!);
    expect(february.obligation.dueAt.toISOString().slice(0, 10)).toBe("2036-02-29");
    const second = await updateServiceObligation(f.org, f.owner.id, february.obligation.id, { expectedUpdatedAt: february.obligation.updatedAt.toISOString(), status: "completed", completionNote: "Synthetic February visit complete." });
    if ("error" in second) throw new Error(second.error);
    expect((await assertStandingAuthority(db, f.org, view.revisionId!, second.nextObligationId!)).obligation.dueAt.toISOString().slice(0, 10)).toBe("2036-03-31");
    const other = await fixture();
    await db.update(serviceObligationsTable).set({ predecessorObligationId: other.obligation.id }).where(eq(serviceObligationsTable.id, f.obligation.id));
    await expect(assertStandingAuthority(db, f.org, view.revisionId!, second.nextObligationId!)).rejects.toMatchObject({ code: "series_lineage_unavailable" });
  });
  it("permits a fresh exact successor cutoff after recurrence revision without reinterpreting an older queued authority", async () => {
    const f = await fixture(), firstPolicy = await approve(f);
    const completed = await updateServiceObligation(f.org, f.owner.id, f.obligation.id, { expectedUpdatedAt: f.obligation.updatedAt.toISOString(), status: "completed", completionNote: "Original synthetic service completed." });
    if ("error" in completed) throw new Error(completed.error);
    const old = (await db.select().from(serviceObligationsTable).where(eq(serviceObligationsTable.id, completed.nextObligationId!)))[0];
    const changed = await approveServiceRecurrence(f.org, f.owner.id, old.id, { expectedUpdatedAt: old.updatedAt.toISOString(), intervalMonths: 2, endDate: "2040-12-31", agreementNote: "Customer explicitly changed agreed recurrence to every two months." });
    if ("error" in changed) throw new Error(changed.error);
    await expect(assertStandingAuthority(db, f.org, firstPolicy.revisionId!, changed.id)).rejects.toMatchObject({ code: "series_scope_changed" });
    const revised = await approve({ ...f, obligation: changed });
    expect(revised.approvedSnapshot?.scope).toMatchObject({ anchorObligationId: f.obligation.id, reviewedObligationId: changed.id, reviewedOccurrenceIndex: 0 });
    expect((await assertStandingAuthority(db, f.org, revised.revisionId!, changed.id)).snapshot.scope.recurrence.intervalMonths).toBe(2);
    await expect(assertStandingAuthority(db, f.org, firstPolicy.revisionId!, changed.id)).rejects.toMatchObject({ code: "standing_disabled_or_revised" });
  });
  it("rotates held enrollments and preserves in-progress office tasks", async () => {
    const f = await fixture(), view = await approve(f); atNotice(f);
    await db.update(crmTasksTable).set({ status: "in_progress", description: "Staff already working on this customer" }).where(eq(crmTasksTable.id, f.obligation.taskId));
    await processStandingServiceReminders(f.org); await processDueScheduledActions(f.org);
    const [entry] = await db.select().from(enrollments).where(eq(enrollments.id, view.enrollmentId!));
    expect(entry.lastCheckedAt).toBeTruthy(); expect(entry.nextCheckAt.getTime()).toBeGreaterThan(Date.now());
    expect((await db.select().from(crmTasksTable).where(eq(crmTasksTable.id, f.obligation.taskId)))[0].status).toBe("in_progress");
    expect((await db.select().from(crmTasksTable).where(eq(crmTasksTable.id, f.obligation.taskId)))[0].description).toContain("Staff already working on this customer");
  });
  it("never defers a notice beyond the service due time", async () => {
    const f = await fixture();
    await db.update(orgSettingsTable).set({ sendingHours: { quietHoursEnabled: true, timezone: "UTC", startHour: 13, endHour: 14, days: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"], maxTouchesPerDay: 2 } }).where(eq(orgSettingsTable.organizationId, f.org));
    const view = await approve(f); vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(f.obligation.dueAt.getTime() - 60_000));
    await expect(admitStandingServiceReminder(f.org, view.enrollmentId!)).rejects.toMatchObject({ code: "standing_occurrence_expires_before_window" });
    expect(await db.select().from(scheduledActionsTable).where(eq(scheduledActionsTable.organizationId, f.org))).toHaveLength(0);
  });
  it.skipIf(process.env.SCHEDULER_TEST_BACKEND === "pglite")("serializes individual versus standing approval around one immutable occurrence", async () => {
    const f = await fixture(), view = await approve(f); atNotice(f);
    const care = await getServiceCare(f.org, f.obligation.id);
    const input = { requestId: randomUUID(), expectedUpdatedAt: care.expectedUpdatedAt, channel: "email", previewFingerprint: care.preview!.fingerprint, agreementNote: "One individually reviewed synthetic expected-service notice.", expectedServiceConfirmed: true };
    const results = await Promise.allSettled([approveServiceCare(f.org, f.owner.id, f.obligation.id, input), admitStandingServiceReminder(f.org, view.enrollmentId!)]);
    expect(results.some(r => r.status === "fulfilled")).toBe(true);
    expect(await db.select().from(scheduledActionsTable).where(eq(scheduledActionsTable.organizationId, f.org))).toHaveLength(1);
    expect(await db.select().from(auditEventsTable).where(and(eq(auditEventsTable.organizationId, f.org), eq(auditEventsTable.action, "service.care_reminder_approved")))).toHaveLength(1);
  });
  it.skipIf(process.env.SCHEDULER_TEST_BACKEND === "pglite")("two independent admission workers converge on one original action", async () => {
    const f = await fixture(), view = await approve(f); atNotice(f);
    const results = await Promise.all([admitStandingServiceReminder(f.org, view.enrollmentId!), admitStandingServiceReminder(f.org, view.enrollmentId!)]);
    expect(results[0].approvalId).toBe(results[1].approvalId);
    expect(await db.select().from(scheduledActionsTable).where(eq(scheduledActionsTable.organizationId, f.org))).toHaveLength(1);
  });
});

describe("shared pending/unknown service contact allowance", () => {
  it("counts unknown reservations and deduplicates the matching accepted activity", async () => {
    const f = await fixture(); await admitted(f); unknownEffect = true; await processDueScheduledActions(f.org);
    const [audit] = await db.select().from(auditEventsTable).where(and(eq(auditEventsTable.organizationId, f.org), eq(auditEventsTable.action, "service.care_reminder_approved")));
    const cfg = { quietHoursEnabled: false, timezone: "America/New_York", startHour: 9, endHour: 18, days: ["Mon"], maxTouchesPerDay: 1 };
    // SQL timestamps use real DB time; keep the original reservation in this rolling window.
    await db.update(revenueExecutionsTable).set({ createdAt: new Date() }).where(eq(revenueExecutionsTable.organizationId, f.org));
    expect((await checkOutreachTiming({ organizationId: f.org, contact: { id: f.contactId }, sendingHours: cfg })).ok).toBe(false);
    await db.insert(activitiesTable).values({ organizationId: f.org, contactId: f.contactId, type: "automation_message_sent", title: "Synthetic acceptance", occurredAt: new Date(), metadata: { approvalId: audit.id } });
    expect((await checkOutreachTiming({ organizationId: f.org, contact: { id: f.contactId }, sendingHours: { ...cfg, maxTouchesPerDay: 2 } })).ok).toBe(true);
    expect(await contactTouchTimes(db, f.org, f.contactId, new Date(Date.now() - 86_400_000))).toHaveLength(1);
    expect((await db.select().from(revenueExecutionsTable).where(eq(revenueExecutionsTable.organizationId, f.org)))[0].state).toBe("indeterminate");
    // An unrelated approval reference cannot consume the original reservation.
    await db.insert(activitiesTable).values({ organizationId: f.org, contactId: f.contactId, type: "automation_message_sent", title: "Unrelated synthetic legacy touch", occurredAt: new Date(), metadata: { approvalId: randomUUID() } });
    expect((await checkOutreachTiming({ organizationId: f.org, contact: { id: f.contactId }, sendingHours: { ...cfg, maxTouchesPerDay: 2 } })).ok).toBe(false);
  });
  it("does not hide a different legacy unknown scheduled key merely because it repeats the same approval reference", async () => {
    const f = await fixture(); await admitted(f); unknownEffect = true; await processDueScheduledActions(f.org);
    const [audit] = await db.select().from(auditEventsTable).where(and(eq(auditEventsTable.organizationId, f.org), eq(auditEventsTable.action, "service.care_reminder_approved")));
    const [original] = await db.select().from(scheduledActionsTable).where(eq(scheduledActionsTable.organizationId, f.org));
    const [other] = await db.insert(scheduledActionsTable).values({ organizationId: f.org, action: original.action, context: original.context, runAt: new Date() }).returning();
    await db.insert(revenueExecutionsTable).values({ organizationId: f.org, actionKey: `scheduled:${other.id}`, kind: "service_care_reminder",
      fingerprint: "a".repeat(64), state: "indeterminate", createdAt: new Date(), expiresAt: new Date(Date.now() + 60_000) });
    await db.insert(activitiesTable).values({ organizationId: f.org, contactId: f.contactId, type: "automation_message_sent", title: "Original synthetic acceptance",
      occurredAt: new Date(), metadata: { approvalId: audit.id } });
    expect(await contactTouchTimes(db, f.org, f.contactId, new Date(Date.now() - 86_400_000))).toHaveLength(2);
    expect((await checkOutreachTiming({ organizationId: f.org, contact: { id: f.contactId }, sendingHours: { quietHoursEnabled: false, timezone: "America/New_York", startHour: 9, endHour: 18, days: ["Mon"], maxTouchesPerDay: 2 } })).ok).toBe(false);
    expect((await db.select().from(revenueExecutionsTable).where(eq(revenueExecutionsTable.organizationId, f.org))).every(receipt => receipt.state === "indeterminate")).toBe(true);
  });
  it("does not use a conflicting explicit activity key to hide a pre-ledger unknown service receipt", async () => {
    const f = await fixture(); await admitted(f); unknownEffect = true; await processDueScheduledActions(f.org);
    const [audit] = await db.select().from(auditEventsTable).where(and(eq(auditEventsTable.organizationId, f.org), eq(auditEventsTable.action, "service.care_reminder_approved")));
    // Synthetic downgrade models retained records from before this ledger existed.
    await db.delete(contactTouchReservationsTable).where(eq(contactTouchReservationsTable.organizationId, f.org));
    await db.update(revenueExecutionsTable).set({ createdAt: new Date() }).where(eq(revenueExecutionsTable.organizationId, f.org));
    await db.insert(activitiesTable).values({ organizationId: f.org, contactId: f.contactId, type: "automation_message_sent", title: "Different keyed synthetic acceptance",
      occurredAt: new Date(), metadata: { approvalId: audit.id, touchLogicalKey: `scheduled:${randomUUID()}` } });
    expect(await contactTouchTimes(db, f.org, f.contactId, new Date(Date.now() - 86_400_000))).toHaveLength(2);
    expect((await db.select().from(revenueExecutionsTable).where(eq(revenueExecutionsTable.organizationId, f.org)))[0].state).toBe("indeterminate");
    expect(await db.select().from(contactTouchReservationsTable).where(eq(contactTouchReservationsTable.organizationId, f.org))).toHaveLength(0);
  });
  it.skipIf(process.env.SCHEDULER_TEST_BACKEND === "pglite")("serializes two independent service workers before either can consume the last contact slot", async () => {
    const f = await fixture(), second = await serviceStandingFixture("manual", f.contactId, f.org); senders.set(f.org, f.owner.id);
    const a = await approve(f), b = await approve({ ...second, owner: f.owner });
    atNotice(f); await admitStandingServiceReminder(f.org, a.enrollmentId!); await admitStandingServiceReminder(f.org, b.enrollmentId!);
    vi.useRealTimers();
    await db.update(orgSettingsTable).set({ sendingHours: { quietHoursEnabled: false, maxTouchesPerDay: 1 } }).where(eq(orgSettingsTable.organizationId, f.org));
    const rows = await db.select().from(scheduledActionsTable).where(eq(scheduledActionsTable.organizationId, f.org));
    let release!: () => void, started!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; }), entered = new Promise<void>(resolve => { started = resolve; });
    const input = (row: typeof rows[number]) => ({ organizationId: f.org, actionKey: `scheduled:${row.id}`, kind: row.action.type, payload: { action: row.action, context: row.context }, serviceCare: { approvalId: row.action.params.approvalId as string, scheduledActionId: row.id } });
    const first = runDurableAction({ ...input(rows[0]), execute: async () => { started(); await waiting; return { state: "succeeded", detail: "Synthetic only" }; } });
    await entered;
    await expect(runDurableAction({ ...input(rows[1]), execute: async () => { throw new Error("Must never enter second effect"); } })).rejects.toBeInstanceOf(ServiceClaimDeferredError);
    release(); await first;
    expect(await db.select().from(revenueExecutionsTable).where(eq(revenueExecutionsTable.organizationId, f.org))).toHaveLength(1);
  });
});

it.each(["pending_approval", "succeeded", "indeterminate"] as const)("holds standing admission when own-number service authority is %s", async state => {
  const f = await fixture(); const view = await approve(f); atNotice(f);
  await db.insert(zapierActionExecutionsTable).values({ organizationId: f.org, capability: "maintain.sms.send", specialistId: "maintain", direction: "write", zapierApp: "Synthetic", zapierAction: "send", idempotencyKey: `maintain-reminder-text:${f.obligation.id}:1`, requestDigest: "a".repeat(64), state, linkedEntityType: "service_obligation", linkedEntityId: f.obligation.id });
  const result = await admitStandingServiceReminder(f.org, view.enrollmentId!);
  expect(result.code).toBe("reminder_already_owned"); expect(effects).toHaveLength(0);
});
