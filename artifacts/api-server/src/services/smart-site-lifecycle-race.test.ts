import { randomUUID } from "node:crypto";
import { analyticsEventsTable, crmTasksTable, db, leadsTable, organizationsTable, pool, smartSitesTable, smartSiteSubmissionsTable, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { afterEach, expect, it, vi } from "vitest";
import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";
import { transitionCustomerLifecycle } from "./customer-lifecycle";
import { normalizeSmartSiteIntake, smartSiteAcquisitionBatchSchema } from "./smart-site-contract";
import { captureSmartSiteAcquisitionEvents, captureSmartSiteInquiry } from "./smart-sites";

const orgs: string[] = [];
async function fixture() {
  const [org] = await db.insert(organizationsTable).values({ name: "Synthetic lifecycle race", slug: `site-race-${randomUUID()}` }).returning();
  orgs.push(org.id);
  const [owner] = await db.insert(usersTable).values({ organizationId: org.id, role: "owner", isActive: true }).returning();
  const [site] = await db.insert(smartSitesTable).values({ organizationId: org.id, name: "Synthetic site", siteKey: randomUUID(), profile: "hvac", source: "synthetic", keyHash: "0".repeat(64), isActive: true, analyticsEnabled: true }).returning();
  return { org, owner, site };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const captures = {
  intake: (f: Fixture) => captureSmartSiteInquiry(f.site, normalizeSmartSiteIntake({ schemaVersion: 1, requestId: randomUUID(), contact: { name: "Synthetic Request", email: `${randomUUID()}@example.invalid` }, project: { serviceCode: "repair", timing: "soon", summary: "Synthetic lifecycle race test" }, consent: { contact: true, analytics: false, policyVersion: "synthetic-test-v1", channels: ["email"] } })),
  acquisition: (f: Fixture) => captureSmartSiteAcquisitionEvents(f.site, smartSiteAcquisitionBatchSchema.parse({ schemaVersion: 1, consent: true, policyVersion: "smart-sites-analytics-v1", visitorId: randomUUID(), sessionId: randomUUID(), events: [{ eventId: randomUUID(), eventName: "page_view", occurredAt: new Date().toISOString(), path: "/services" }] })),
};
async function assertNoCapture(org: string) {
  for (const table of [leadsTable, smartSiteSubmissionsTable, crmTasksTable, analyticsEventsTable]) expect(await db.select().from(table).where(eq(table.organizationId, org))).toHaveLength(0);
}
afterEach(async () => { vi.restoreAllMocks(); await deleteTestOrgs(...orgs.splice(0)); });

it.each(["intake", "acquisition"] as const)("rechecks %s after a pause commits between the entry guard and capture transaction", async (kind) => {
  const f = await fixture();
  let reached!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => { reached = resolve; });
  const wait = new Promise<void>((resolve) => { release = resolve; });
  const original = db.transaction.bind(db);
  const gate = vi.spyOn(db, "transaction").mockImplementationOnce((async (...args: Parameters<typeof db.transaction>) => {
    reached(); await wait; return original(...args);
  }) as typeof db.transaction);
  const captured = captures[kind](f).then((value) => ({ value, error: undefined }), (error: unknown) => ({ value: undefined, error }));
  try {
    await entered;
    await transitionCustomerLifecycle(f.org.id, f.owner.id, { action: "pause", expectedVersion: 0, reason: "Synthetic race while request waits" });
  } finally { release(); gate.mockRestore(); }
  expect((await captured).error).toMatchObject({ code: "customer_lifecycle_paused", status: 423 });
  await assertNoCapture(f.org.id);
  await transitionCustomerLifecycle(f.org.id, f.owner.id, { action: "resume", expectedVersion: 1, reason: "Synthetic reviewed resume", resumeQueuedWork: true });
  await expect(captures[kind](f)).resolves.toBeDefined();
});

// PGlite serializes socket clients, so independent-session exclusion is tested
// only by the real PostgreSQL CI service. The deterministic boundary test above runs locally.
it.skipIf(process.env.SCHEDULER_TEST_BACKEND === "pglite").each(["intake", "acquisition"] as const)("%s waits for a real lifecycle transition lock and observes its committed pause", async (kind) => {
  const f = await fixture();
  const writer = await pool.connect();
  let captured: Promise<{ error: unknown }> | undefined;
  try {
    await writer.query("BEGIN");
    await writer.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`customer-lifecycle:${f.org.id}`]);
    captured = captures[kind](f).then(() => ({ error: undefined }), (error: unknown) => ({ error }));
    await vi.waitFor(async () => {
      const result = await pool.query<{ waiting: number }>("SELECT count(*)::int AS waiting FROM pg_locks l JOIN pg_stat_activity a USING(pid) WHERE l.locktype='advisory' AND NOT l.granted AND a.query LIKE '%pg_advisory_xact_lock_shared%'");
      expect(result.rows[0].waiting).toBeGreaterThan(0);
    }, { timeout: 2000, interval: 25 });
    await writer.query("INSERT INTO customer_lifecycle (organization_id,state,version,reason,updated_by_user_id) VALUES ($1,'paused',1,'Synthetic concurrent pause',$2)", [f.org.id, f.owner.id]);
    await writer.query("COMMIT");
  } finally { await writer.query("ROLLBACK"); writer.release(); }
  expect((await captured!).error).toMatchObject({ code: "customer_lifecycle_paused", status: 423 });
  await assertNoCapture(f.org.id);
});
