import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { activitiesTable, contactsTable, db, DEFAULT_SENDING_HOURS, leadsTable, organizationsTable, orgSettingsTable, playbookEnrollmentsTable, playbooksTable, revenueExecutionsTable, scheduledActionsTable } from "@workspace/db";
import { contactTouchReservationsTable as reservations } from "../../../../lib/db/src/schema/contact-touch-reservations";
import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";
import { contactTouchTimes } from "./contact-touch-claim";
import { checkOutreachTiming } from "./send-gate";

const now = new Date("2026-10-05T16:00:00Z"), recent = new Date(now.getTime() - 300_000), since = new Date(now.getTime() - 86_400_000), orgs: string[] = [];
beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(now); vi.stubGlobal("fetch", () => { throw new Error("Legacy allowance checks cannot access providers"); }); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
afterAll(async () => { await deleteTestOrgs(...orgs); });
async function fixture(withLead = true) {
  const [org] = await db.insert(organizationsTable).values({ name: "Synthetic retained allowance", slug: randomUUID() }).returning(); orgs.push(org.id);
  const [contact] = await db.insert(contactsTable).values({ organizationId: org.id, firstName: "Synthetic", email: `${randomUUID()}@example.invalid` }).returning();
  const [lead] = withLead ? await db.insert(leadsTable).values({ organizationId: org.id, contactId: contact.id, creationMethod: "form" }).returning() : [];
  await db.insert(orgSettingsTable).values({ organizationId: org.id, sendingHours: { ...DEFAULT_SENDING_HOURS, quietHoursEnabled: false, maxTouchesPerDay: 1 } });
  return { org: org.id, contact, lead };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function enrollment(f: Fixture, currentStep = 1) {
  const [book] = await db.insert(playbooksTable).values({ organizationId: f.org, name: "Synthetic historic playbook", steps: [{ channel: "email", delayMinutes: 0, prompt: "Synthetic fixture" }] }).returning();
  return (await db.insert(playbookEnrollmentsTable).values({ organizationId: f.org, playbookId: book.id, leadId: f.lead!.id, currentStep, updatedAt: recent }).returning())[0];
}
async function scheduledReceipt(f: Fixture, input: { enrollmentId?: string; createdAt?: Date; state?: "processing" | "indeterminate" | "succeeded" } = {}) {
  const action = input.enrollmentId ? { type: "playbook_step" as const, params: { enrollmentId: input.enrollmentId, stepIndex: 0 } }
    : { type: "send_email" as const, params: { subject: "Synthetic old claim", body: "Synthetic body" } };
  const [scheduled] = await db.insert(scheduledActionsTable).values({ organizationId: f.org, action, context: f.lead ? { leadId: f.lead.id } : { contactId: f.contact.id }, runAt: recent }).returning();
  const [receipt] = await db.insert(revenueExecutionsTable).values({ organizationId: f.org, actionKey: `scheduled:${scheduled.id}`, kind: action.type,
    fingerprint: "a".repeat(64), state: input.state ?? "indeterminate", createdAt: input.createdAt ?? recent, expiresAt: now }).returning();
  return { receipt, scheduled };
}
const times = (f: Fixture) => contactTouchTimes(db, f.org, f.contact.id, since);

it("holds an unexplained pre-ledger playbook CAS without creating new send authority", async () => {
  const f = await fixture(); const saved = await enrollment(f);
  expect(await times(f)).toEqual([recent]);
  expect(await checkOutreachTiming({ organizationId: f.org, contact: f.contact })).toMatchObject({ outcome: "deferred", reason: "frequency_cap" });
  expect(await db.select().from(reservations).where(eq(reservations.organizationId, f.org))).toHaveLength(0);
  expect(await db.select().from(revenueExecutionsTable).where(eq(revenueExecutionsTable.organizationId, f.org))).toHaveLength(0);
  expect((await db.select().from(playbookEnrollmentsTable).where(eq(playbookEnrollmentsTable.id, saved.id)))[0]).toEqual(saved);
});
it.each(["skipped", "step_skipped"] as const)("does not invent a touch for an explicit legacy %s entry", async kind => {
  const f = await fixture(), e = await enrollment(f);
  await db.update(playbookEnrollmentsTable).set({ history: [{ kind, stepIndex: 0, at: recent.toISOString() }], updatedAt: recent }).where(eq(playbookEnrollmentsTable.id, e.id));
  expect(await times(f)).toEqual([]);
});
it("deduplicates exact playbook receipt, CAS and accepted activity through the original enrollment/index key", async () => {
  const f = await fixture(), e = await enrollment(f), acceptedAt = new Date(recent.getTime() + 1000);
  await scheduledReceipt(f, { enrollmentId: e.id, state: "succeeded" });
  await db.insert(activitiesTable).values({ organizationId: f.org, leadId: f.lead!.id, contactId: f.contact.id, type: "playbook_touch_sent", title: "Synthetic prior acceptance",
    occurredAt: acceptedAt, metadata: { enrollmentId: e.id, stepIndex: 0 } });
  expect(await times(f)).toEqual([acceptedAt]);
  expect(await contactTouchTimes(db, f.org, f.contact.id, since, `playbook:${e.id}:0`)).toEqual([]);
});
it("uses an original old playbook receipt rather than a recent enrollment edit, without resetting its rolling clock", async () => {
  const f = await fixture(), e = await enrollment(f);
  await scheduledReceipt(f, { enrollmentId: e.id, createdAt: new Date(since.getTime() - 1000) });
  await db.update(playbookEnrollmentsTable).set({ pauseReason: "Synthetic later office note", updatedAt: now }).where(eq(playbookEnrollmentsTable.id, e.id));
  expect(await times(f)).toEqual([]);
});
it("does not reinterpret an expired ledger claim as a new legacy CAS after a staff edit", async () => {
  const f = await fixture(), e = await enrollment(f);
  await db.insert(reservations).values({ organizationId: f.org, logicalKey: `playbook:${e.id}:0`, contactId: f.contact.id, address: f.contact.email!, channel: "email",
    sourceKind: "playbook", payloadHash: "b".repeat(64), reservedAt: new Date(since.getTime() - 1000) });
  await db.update(playbookEnrollmentsTable).set({ updatedAt: now }).where(eq(playbookEnrollmentsTable.id, e.id));
  expect(await times(f)).toEqual([]);
});
it("counts an unknown original scheduled contact-only receipt and normalized aliases with no lead or new ledger", async () => {
  const f = await fixture(false); const original = await scheduledReceipt(f);
  const [alias] = await db.insert(contactsTable).values({ organizationId: f.org, firstName: "Synthetic alias", email: ` ${f.contact.email!.toUpperCase()} ` }).returning();
  expect(await contactTouchTimes(db, f.org, alias.id, since)).toEqual([recent]);
  expect(await contactTouchTimes(db, f.org, alias.id, since, original.receipt.actionKey)).toEqual([]);
});
it("fails closed for an unbounded ambiguous historic counter", async () => {
  const f = await fixture(); await enrollment(f, 1_000_000);
  await expect(times(f)).rejects.toMatchObject({ code: "legacy_playbook_history_requires_review" });
});
