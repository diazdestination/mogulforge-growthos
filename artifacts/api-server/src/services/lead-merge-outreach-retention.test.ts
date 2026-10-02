import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { db, organizationsTable, usersTable, contactsTable, leadsTable, activitiesTable,
  emailIntelligenceSourcesTable, emailResponseReviewsTable, revenueExecutionsTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import app from "../app";
import { createSession, deleteSession } from "../lib/auth";
import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";
import { mergeLeads } from "./crm";
import { checkSendEligibility } from "./send-gate";

const organizations: string[] = [];
const sessions: string[] = [];
let server: Server, base: string;
beforeAll(async () => {
  server = await new Promise<Server>(resolve => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No local test listener");
  base = `http://127.0.0.1:${address.port}/api/v1`;
});
async function fixture() {
  const [org] = await db.insert(organizationsTable).values({ name: "Synthetic outreach merge", slug: `merge-hold-${randomUUID()}` }).returning();
  organizations.push(org.id);
  const [user] = await db.insert(usersTable).values({ organizationId: org.id, role: "owner" }).returning();
  const [contact] = await db.insert(contactsTable).values({ organizationId: org.id, firstName: "Synthetic", email: "customer@example.invalid" }).returning();
  const [survivor, source] = await db.insert(leadsTable).values([
    { organizationId: org.id, contactId: contact.id, status: "follow_up" },
    { organizationId: org.id, contactId: contact.id, status: "follow_up" },
  ]).returning();
  const [activity] = await db.insert(activitiesTable).values({ organizationId: org.id, leadId: source.id, contactId: contact.id, type: "note", title: "Keep original evidence" }).returning();
  const [receipt] = await db.insert(revenueExecutionsTable).values({ organizationId: org.id, actionKey: `synthetic:${randomUUID()}`, kind: "send_email", fingerprint: "synthetic-digest", state: "indeterminate", expiresAt: new Date() }).returning();
  return { org: org.id, actor: user.id, contact, survivor, source, activity, receipt };
}
afterAll(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
  for (const sid of sessions) await deleteSession(sid);
  await deleteTestOrgs(...organizations);
});

async function assertPreserved(f: Awaited<ReturnType<typeof fixture>>) {
  expect((await db.select().from(leadsTable).where(eq(leadsTable.id, f.source.id)))[0]).toMatchObject({ status: "follow_up" });
  expect((await db.select().from(activitiesTable).where(eq(activitiesTable.id, f.activity.id)))[0]).toMatchObject({ leadId: f.source.id });
  expect((await db.select().from(revenueExecutionsTable).where(eq(revenueExecutionsTable.id, f.receipt.id)))[0]).toEqual(f.receipt);
}

it.each(["source", "survivor"] as const)("refuses a merge when the %s has an unresolved customer reply without moving evidence", async target => {
  const f = await fixture();
  const [inbox] = await db.insert(emailIntelligenceSourcesTable).values({ organizationId: f.org, intakeAlias: randomUUID() }).returning();
  const [review] = await db.insert(emailResponseReviewsTable).values({ organizationId: f.org, sourceId: inbox.id,
    externalMessageId: randomUUID(), payloadSha256: "synthetic-payload", reason: "staff_confirmed", state: "confirmed",
    leadId: f[target].id, contactId: f.contact.id, holdActive: true, replyAt: new Date() }).returning();
  expect(await mergeLeads(f.org, f.survivor.id, f.source.id, f.actor)).toEqual({ ok: false, error: "outreach_history_retained" });
  await assertPreserved(f);
  expect((await db.select().from(emailResponseReviewsTable).where(eq(emailResponseReviewsTable.id, review.id)))[0]).toEqual(review);
  expect(await checkSendEligibility({ organizationId: f.org, leadId: f[target].id, contact: f.contact, kind: "outreach", channel: "email" }))
    .toMatchObject({ ok: false, reason: "customer_reply_requires_review" });
});

it.each(["source", "survivor"] as const)("refuses merging imported %s provenance into a new opportunity", async target => {
  const f = await fixture();
  await db.update(leadsTable).set({ creationMethod: "import", importSourceKey: "synthetic-origin", externalOpportunityId: randomUUID() }).where(eq(leadsTable.id, f[target].id));
  expect(await mergeLeads(f.org, f.survivor.id, f.source.id, f.actor)).toEqual({ ok: false, error: "outreach_history_retained" });
  await assertPreserved(f);
  expect(await checkSendEligibility({ organizationId: f.org, leadId: f[target].id, contact: f.contact, kind: "outreach", channel: "email" }))
    .toMatchObject({ ok: false, reason: "imported_source_requires_current_review" });
});

it("retains ordinary same-company merges while denying foreign and nonexistent sources", async () => {
  const f = await fixture(), foreign = await fixture();
  expect(await mergeLeads(f.org, f.survivor.id, foreign.source.id, f.actor)).toEqual({ ok: false, error: "not_found" });
  expect(await mergeLeads(f.org, f.survivor.id, randomUUID(), f.actor)).toEqual({ ok: false, error: "not_found" });
  expect(await mergeLeads(f.org, f.survivor.id, f.source.id, f.actor)).toMatchObject({ ok: true, movedActivities: 1 });
  expect((await db.select().from(activitiesTable).where(and(eq(activitiesTable.organizationId, f.org), eq(activitiesTable.id, f.activity.id))))[0].leadId).toBe(f.survivor.id);
  expect((await db.select().from(leadsTable).where(eq(leadsTable.id, f.source.id)))[0].status).toBe("lost");
});

it("returns an actionable 409 to a normal owner session without exposing a foreign hold", async () => {
  const f = await fixture(), foreign = await fixture();
  await db.update(leadsTable).set({ creationMethod: "import" }).where(eq(leadsTable.id, f.source.id));
  await db.update(leadsTable).set({ creationMethod: "import" }).where(eq(leadsTable.id, foreign.source.id));
  const sid = await createSession({ user: { id: f.actor, email: null, firstName: null, lastName: null, profileImageUrl: null }, access_token: "synthetic-merge-session", expires_at: Math.floor(Date.now() / 1000) + 3600 });
  sessions.push(sid);
  const merge = (sourceLeadId: string) => fetch(`${base}/leads/${f.survivor.id}/merge`, { method: "POST",
    headers: { authorization: `Bearer ${sid}`, "content-type": "application/json" }, body: JSON.stringify({ sourceLeadId }) });
  const blocked = await merge(f.source.id);
  expect(blocked.status).toBe(409);
  expect(await blocked.json()).toMatchObject({ code: "outreach_history_retained", error: expect.stringContaining("Keep them separate") });
  await assertPreserved(f);
  const denied = await merge(foreign.source.id), absent = await merge(randomUUID());
  expect(denied.status).toBe(404);
  expect(absent.status).toBe(404);
  expect(await denied.json()).toEqual(await absent.json());
});
