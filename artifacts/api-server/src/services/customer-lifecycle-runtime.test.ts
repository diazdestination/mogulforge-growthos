import { randomUUID } from "node:crypto";
import { db, organizationsTable, usersTable, contactsTable, leadsTable, crmTasksTable,
  scheduledActionsTable, revenueExecutionsTable, webhookEndpointsTable, webhookDeliveriesTable,
  captureEndpointsTable, playbookEnrollmentsTable, playbooksTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";
import { transitionCustomerLifecycle } from "./customer-lifecycle";
import { processDueScheduledActions, cancelScheduledFollowups, runEvent } from "./automation";
import { checkSendEligibility } from "./send-gate";
import * as sendGate from "./send-gate";
import { executePlaybookStep } from "./playbooks";
import { sendEmailForUser } from "./user-email";
import { providers } from "./providers";
import { attemptDelivery } from "./webhooks";
import { captureExternalLead } from "./capture";

const orgs: string[] = [];
async function fixture() {
  const [org] = await db.insert(organizationsTable).values({ name: "Lifecycle runtime rehearsal", slug: `life-${randomUUID()}` }).returning();
  orgs.push(org.id);
  const [owner] = await db.insert(usersTable).values({ organizationId: org.id, role: "owner", isActive: true }).returning();
  const [contact] = await db.insert(contactsTable).values({ organizationId: org.id, firstName: "Synthetic", email: "synthetic@example.invalid", phone: "2025550148" }).returning();
  const [lead] = await db.insert(leadsTable).values({ organizationId: org.id, contactId: contact.id }).returning();
  return { org: org.id, owner: owner.id, contact, lead };
}
const pause = (x: Awaited<ReturnType<typeof fixture>>) => transitionCustomerLifecycle(x.org, x.owner, { action: "pause", expectedVersion: 0, reason: "Private synthetic pause rehearsal" });
afterEach(() => vi.restoreAllMocks());
afterAll(async () => { await deleteTestOrgs(...orgs); });

it("retains pending work without attempts or receipts, then executes once after explicit resume", async () => {
  const x = await fixture();
  const [action] = await db.insert(scheduledActionsTable).values({ organizationId: x.org,
    action: { type: "create_task", params: { title: "Retained synthetic work" } },
    context: { leadId: x.lead.id, contactId: x.contact.id }, runAt: new Date(0) }).returning();
  await pause(x);
  await processDueScheduledActions(x.org);
  const [held] = await db.select().from(scheduledActionsTable).where(eq(scheduledActionsTable.id, action.id));
  expect(held).toMatchObject({ status: "pending", attempts: 0, lastError: null });
  expect(await db.select().from(revenueExecutionsTable).where(eq(revenueExecutionsTable.organizationId, x.org))).toHaveLength(0);
  expect(await db.select().from(crmTasksTable).where(eq(crmTasksTable.organizationId, x.org))).toHaveLength(0);
  await transitionCustomerLifecycle(x.org, x.owner, { action: "resume", expectedVersion: 1, reason: "Reviewed the retained synthetic queue", resumeQueuedWork: true });
  await processDueScheduledActions(x.org);
  await processDueScheduledActions(x.org);
  expect(await db.select().from(crmTasksTable).where(eq(crmTasksTable.organizationId, x.org))).toHaveLength(1);
  const [done] = await db.select().from(scheduledActionsTable).where(eq(scheduledActionsTable.id, action.id));
  expect(done).toMatchObject({ status: "done", attempts: 1 });
});

it("filters paused companies before the batch limit, preserving capacity for active companies", async () => {
  const paused = await fixture(), active = await fixture();
  await pause(paused);
  await db.insert(scheduledActionsTable).values(Array.from({ length: 25 }, () => ({ organizationId: paused.org,
    action: { type: "create_task" as const, params: {} }, runAt: new Date(0) })));
  const [available] = await db.insert(scheduledActionsTable).values({ organizationId: active.org, action: { type: "create_task", params: { title: "Active tenant still progresses" } }, context: { leadId: active.lead.id }, runAt: new Date(1) }).returning();
  await processDueScheduledActions();
  expect((await db.select().from(scheduledActionsTable).where(eq(scheduledActionsTable.id, available.id)))[0]).toMatchObject({ status: "done", attempts: 1 });
  expect(await db.select().from(crmTasksTable).where(eq(crmTasksTable.organizationId, active.org))).toHaveLength(1);
  const blocked = await db.select().from(scheduledActionsTable).where(eq(scheduledActionsTable.organizationId, paused.org));
  expect(blocked).toHaveLength(25);
  expect(blocked.every(row => row.status === "pending" && row.attempts === 0)).toBe(true);
});

it("honors explicit follow-up cancellation while paused and never resurrects it on resume", async () => {
  const x = await fixture(); await pause(x);
  const [item] = await db.insert(scheduledActionsTable).values({ organizationId: x.org, action: { type: "create_task", params: { title: "Cancelled work" } }, context: { leadId: x.lead.id, event: "assessment.abandoned" }, runAt: new Date(0) }).returning();
  expect(await cancelScheduledFollowups(x.org, x.lead.id, "assessment.abandoned")).toBe(1);
  await transitionCustomerLifecycle(x.org, x.owner, { action: "resume", expectedVersion: 1, reason: "Reviewed the retained queue carefully", resumeQueuedWork: true });
  await processDueScheduledActions(x.org);
  expect((await db.select().from(scheduledActionsTable).where(eq(scheduledActionsTable.id, item.id)))[0]).toMatchObject({ status: "cancelled", attempts: 0 });
  expect(await db.select().from(crmTasksTable).where(eq(crmTasksTable.organizationId, x.org))).toHaveLength(0);
});

async function enrollmentFixture(x: Awaited<ReturnType<typeof fixture>>) {
  const [playbook] = await db.insert(playbooksTable).values({ organizationId: x.org, name: "Synthetic follow-up", category: "estimate_follow_up", steps: [{ channel: "email", delayMinutes: 0, prompt: "Synthetic final touch" }] }).returning();
  const [enrollment] = await db.insert(playbookEnrollmentsTable).values({ organizationId: x.org, playbookId: playbook.id, leadId: x.lead.id, category: "estimate_follow_up", nextRunAt: new Date() }).returning();
  return enrollment;
}

it.each(["entry", "send gate"])("retains a final playbook step when a pause lands at %s", async boundary => {
  const x = await fixture(), enrollment = await enrollmentFixture(x);
  if (boundary === "entry") await pause(x);
  else vi.spyOn(sendGate, "checkSendEligibility").mockResolvedValueOnce({ ok: false, outcome: "blocked", reason: "customer_lifecycle_paused" });
  expect(await executePlaybookStep(x.org, { enrollmentId: enrollment.id, stepIndex: 0 })).toMatchObject({ status: "skipped", detail: "paused: customer_lifecycle_paused" });
  expect((await db.select().from(playbookEnrollmentsTable).where(eq(playbookEnrollmentsTable.id, enrollment.id)))[0]).toMatchObject({ status: "paused", currentStep: 0, nextRunAt: null });
});

it("still completes obsolete outreach when an appointment is booked during a company pause", async () => {
  const x = await fixture(), enrollment = await enrollmentFixture(x); await pause(x);
  await runEvent(x.org, "appointment.booked", { leadId: x.lead.id, contactId: x.contact.id });
  expect((await db.select().from(playbookEnrollmentsTable).where(eq(playbookEnrollmentsTable.id, enrollment.id)))[0]).toMatchObject({ status: "completed", currentStep: 0, nextRunAt: null });
  expect(await db.select().from(webhookDeliveriesTable).where(eq(webhookDeliveriesTable.organizationId, x.org))).toHaveLength(0);
});

it("blocks new outreach, transactional customer messages, and final email/SMS provider paths", async () => {
  const x = await fixture(); await pause(x);
  const external = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("external attempt forbidden"));
  for (const channel of ["email", "sms"] as const) for (const kind of ["outreach", "transactional"] as const)
    expect(await checkSendEligibility({ organizationId: x.org, contact: x.contact, leadId: x.lead.id, channel, kind }))
      .toEqual({ ok: false, outcome: "blocked", reason: "customer_lifecycle_paused" });
  await expect(sendEmailForUser({ organizationId: x.org, userId: x.owner, to: "synthetic@example.invalid", subject: "Rehearsal", body: "Never sent" })).rejects.toMatchObject({ code: "customer_lifecycle_paused" });
  await expect(providers.sms.send("2025550148", "Never sent", { organizationId: x.org, contactId: x.contact.id, purpose: "marketing", idempotencyKey: randomUUID() })).rejects.toMatchObject({ code: "customer_lifecycle_paused" });
  expect(external).not.toHaveBeenCalled();
});

it("holds webhook deliveries without consuming attempts or creating a network effect", async () => {
  const x = await fixture(); await pause(x);
  const [endpoint] = await db.insert(webhookEndpointsTable).values({ organizationId: x.org, url: "https://example.invalid/rehearsal", secret: "synthetic-not-a-real-secret" }).returning();
  const [delivery] = await db.insert(webhookDeliveriesTable).values({ organizationId: x.org, endpointId: endpoint.id,
    event: "lead.created", payload: { synthetic: true }, signature: "not-sent" }).returning();
  const external = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("external attempt forbidden"));
  await attemptDelivery(delivery.id);
  const [held] = await db.select().from(webhookDeliveriesTable).where(eq(webhookDeliveriesTable.id, delivery.id));
  expect(held).toMatchObject({ status: "pending", attempts: 0, lastError: null });
  expect(external).not.toHaveBeenCalled();
});

it("holds existing-website capture before reserving a delivery or mutating a lead", async () => {
  const x = await fixture(); await pause(x);
  const [endpoint] = await db.insert(captureEndpointsTable).values({ organizationId: x.org, name: "Synthetic external form", token: randomUUID(), mapping: { email: "email" } }).returning();
  expect(await captureExternalLead(endpoint, { email: "another@example.invalid" }, { idempotencyKey: randomUUID() }))
    .toEqual({ ok: false, error: "customer_lifecycle_paused" });
  expect(await db.select().from(leadsTable).where(eq(leadsTable.organizationId, x.org))).toHaveLength(1);
});
