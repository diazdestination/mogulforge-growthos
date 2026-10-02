import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { db, organizationsTable, usersTable, leadsTable, appointmentsTable, crmTasksTable, smartSiteSubmissionsTable, engagementLinksTable, analyticsEventsTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { beforeAll, afterAll, expect, it, vi } from "vitest";
import app from "../../app";
import { createSession, deleteSession } from "../../lib/auth";
import { restoreModeRequested } from "../../lib/restore-mode";
import { getActiveInstallationKey } from "../../services/installation";
import { getOrCreateEngagementLink } from "../../services/engagement-links";
import { deleteTestOrgs } from "../../test-helpers/delete-test-orgs";
import { createWebsiteAdapter, type WebsiteAdapter, type WebsiteIntake } from "../../../../../examples/website-connection/adapter.mjs";

const companyProfiles = [
  { name: "Painless Roofing and Water Restoration", profile: "roofing-exteriors", service: "roof-repair" },
  { name: "Climate Simulation Solutions", profile: "hvac", service: "repair" },
] as const;
type Company = { org: string; site: string; owner: string; sid: string; key: string; adapter: WebsiteAdapter; service: string; name: string };
let server: Server, base: string, directory: string, operatorSid: string;
const orgs: string[] = [], sessions: string[] = [], companies: Company[] = [];
const nativeFetch = globalThis.fetch;
let externalAttempts = 0;
const request = (sid: string, route: string, body?: unknown, method = body ? "POST" : "GET") =>
  fetch(`${base}/api/v1${route}`, { method, headers: { cookie: `sid=${sid}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
async function login(id: string) {
  const sid = await createSession({ user: { id, email: null, firstName: null, lastName: null, profileImageUrl: null }, access_token: "synthetic-session", expires_at: Math.floor(Date.now() / 1000) + 3600 });
  sessions.push(sid); return sid;
}
const intake = (company: Company): WebsiteIntake => ({
  schemaVersion: 1, requestId: randomUUID(), contact: { name: "Private Rehearsal", email: `${randomUUID()}@example.invalid` },
  project: { serviceCode: company.service, summary: "Synthetic workflow acceptance; no real customer", timing: "planning" },
  consent: { contact: true, policyVersion: "synthetic-acceptance-v1", channels: ["email"], analytics: false },
});

beforeAll(async () => {
  if (process.env.NODE_ENV !== "test" || restoreModeRequested()) throw new Error("Use normal isolated test mode.");
  const database = new URL(process.env.DATABASE_URL!);
  if (!["127.0.0.1", "localhost"].includes(database.hostname) ||
      !(database.pathname.endsWith("_test") || (process.env.SCHEDULER_TEST_BACKEND === "pglite" && database.pathname === "/postgres")))
    throw new Error("Company rehearsals require a local test database.");
  directory = await mkdtemp(path.join(tmpdir(), "growthos-company-rehearsal-"));
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  vi.stubGlobal("fetch", (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const target = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (new URL(target).origin !== base) { externalAttempts++; throw new Error("External requests forbidden in private company rehearsal"); }
    return nativeFetch(input, init);
  }) satisfies typeof fetch);
  const [operatorOrg] = await db.insert(organizationsTable).values({ name: "Synthetic operator", slug: `operator-${randomUUID()}` }).returning();
  orgs.push(operatorOrg.id);
  const [operator] = await db.insert(usersTable).values({ organizationId: operatorOrg.id, role: "owner", isPlatformAdmin: true, isActive: true }).returning();
  operatorSid = await login(operator.id);
  for (const profile of companyProfiles) {
    const draftRequest = { requestId: randomUUID(), name: `${profile.name} — private rehearsal`, slug: `rehearsal-${randomUUID()}`, profile: profile.profile, timezone: "UTC", responseTargetMinutes: 60, confirmed: true };
    const created = await request(operatorSid, "/platform/clients", draftRequest);
    expect(created.status).toBe(201);
    const draft = await created.json() as { organizationId: string; siteId: string };
    orgs.push(draft.organizationId);
    const duplicate = await request(operatorSid, "/platform/clients", draftRequest);
    expect(await duplicate.json()).toMatchObject({ ...draft, duplicate: true });
    const keyResponse = await request(operatorSid, `/platform/clients/${draft.organizationId}/sites/${draft.siteId}/key`, { confirmed: true, expectedVersion: 1 });
    expect(keyResponse.status).toBe(200);
    const { secret } = await keyResponse.json() as { secret: string };
    const adapter = createWebsiteAdapter({ apiOrigin: base, siteId: draft.siteId, siteSecret: secret,
      encryptionKey: randomBytes(32).toString("hex"), journalPath: path.join(directory, `${draft.organizationId}.sqlite`), allowLocal: true });
    expect(await adapter.checkConnection()).toMatchObject({ status: "credential_verified", captureEnabled: false, createsLead: false });
    // Provisioning has not moved the operator or silently granted customer staff access.
    const [stillOperator] = await db.select().from(usersTable).where(eq(usersTable.id, operator.id));
    expect(stillOperator.organizationId).toBe(operatorOrg.id);
    expect(await db.select().from(usersTable).where(eq(usersTable.organizationId, draft.organizationId))).toHaveLength(0);
    const [owner] = await db.insert(usersTable).values({ organizationId: draft.organizationId, role: "owner", isActive: true }).returning();
    const sid = await login(owner.id);
    const activated = await request(sid, `/smart-sites/${draft.siteId}`, { isActive: true, confirmedLaunch: true }, "PATCH");
    expect(activated.status).toBe(200);
    companies.push({ org: draft.organizationId, site: draft.siteId, owner: owner.id, sid, key: secret, adapter, service: profile.service, name: profile.name });
  }
});
afterAll(async () => {
  for (const company of companies) company.adapter.close();
  for (const sid of sessions) await deleteSession(sid);
  if (server) { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  await deleteTestOrgs(...orgs.reverse());
  vi.unstubAllGlobals();
  if (directory && path.resolve(directory).startsWith(path.resolve(tmpdir()) + path.sep) && path.basename(directory).startsWith("growthos-company-rehearsal-")) await rm(directory, { recursive: true, force: true });
});

it.each(companyProfiles)("rehearses $name intake, ownership, office booking, estimate and accurately labeled value", async profile => {
  const company = companies.find(c => c.name === profile.name)!;
  const input = intake(company);
  const saved = await company.adapter.submit(input);
  expect(saved.status).toBe("saved");
  if (saved.status !== "saved") throw new Error("Synthetic intake was not saved");
  expect(saved.appointmentStatus).toBe("pending_office_approval");
  expect(await company.adapter.submit(input)).toEqual(saved);
  expect(await db.select().from(smartSiteSubmissionsTable).where(and(eq(smartSiteSubmissionsTable.siteId, company.site), eq(smartSiteSubmissionsTable.requestId, input.requestId)))).toHaveLength(1);
  expect(await db.select().from(appointmentsTable).where(eq(appointmentsTable.organizationId, company.org))).toHaveLength(0);
  const [lead] = await db.select().from(leadsTable).where(eq(leadsTable.id, saved.leadId));
  expect(lead.organizationId).toBe(company.org);
  const claimed = await request(company.sid, `/smart-sites/leads/${lead.id}/owner`, { assignedUserId: company.owner, expectedOwnerId: lead.assignedUserId }, "PATCH");
  expect(claimed.status).toBe(200);
  const tasks = await db.select().from(crmTasksTable).where(and(eq(crmTasksTable.organizationId, company.org), eq(crmTasksTable.leadId, lead.id)));
  expect(tasks.length).toBeGreaterThan(0);
  expect(tasks.every(task => task.assignedUserId === company.owner)).toBe(true);
  const attempt = { requestId: randomUUID(), channel: "phone", outcome: "connected", confirmed: true };
  expect((await request(company.sid, `/smart-sites/leads/${lead.id}/contact-attempts`, attempt)).status).toBe(201);
  expect((await request(company.sid, `/smart-sites/leads/${lead.id}/contact-attempts`, attempt)).status).toBe(200);
  const appointment = await request(company.sid, "/appointments", { leadId: lead.id, contactId: lead.contactId, assignedUserId: company.owner,
    type: "inspection", scheduledStart: new Date(Date.now() + 7 * 86400_000).toISOString(), notes: "Office-created synthetic appointment" });
  expect(appointment.status).toBe(201);
  const estimate = await request(company.sid, "/estimates", { leadId: lead.id, title: "Synthetic service estimate", lineItems: [{ description: "Synthetic service", quantity: 1, unitPriceCents: 100000, totalCents: 100000 }] });
  expect(estimate.status).toBe(201);
  const estimateRow = await estimate.json() as { id: string };
  expect((await request(company.sid, `/estimates/${estimateRow.id}`, { status: "accepted" }, "PATCH")).status).toBe(200);
  const before = await (await request(company.sid, "/revenue/value")).json() as { acceptedEstimateCents: number; netReceiptsCents: number };
  expect(before).toMatchObject({ acceptedEstimateCents: 100000, netReceiptsCents: 0 });
  const value = { leadId: lead.id, sourceReference: `synthetic-office-ledger-${randomUUID()}`, kind: "payment", amountCents: 25000, occurredAt: new Date().toISOString(), confirmed: true };
  expect((await request(company.sid, "/revenue/value", value)).status).toBe(201);
  const ledger = await (await request(company.sid, "/revenue/value")).json() as { netReceiptsCents: number; acceptedEstimateCents: number; entryCount: number };
  expect(ledger).toMatchObject({ acceptedEstimateCents: 100000, netReceiptsCents: 25000, entryCount: 1 });
  expect(externalAttempts).toBe(0);
});

it("reconciles a lost intake acknowledgement through the real API without duplicate lead or receipt", async () => {
  const company = companies[0];
  let drop = true;
  let clock = Date.now();
  const adapter = createWebsiteAdapter({ apiOrigin: base, siteId: company.site, siteSecret: company.key,
    encryptionKey: randomBytes(32).toString("hex"), journalPath: path.join(directory, "lost-ack.sqlite"), allowLocal: true }, {
    now: () => clock,
    fetch: async (input, options) => {
      const response = await fetch(input, options);
      if (drop && String(input).endsWith("/intake") && response.ok) { drop = false; await response.text(); throw new Error("Synthetic lost acknowledgement"); }
      return response;
    },
  });
  try {
    const input = intake(company);
    expect((await adapter.submit(input)).status).toBe("queued");
    clock += 60_000;
    const health = await adapter.drain();
    expect(health.counts.saved).toBe(1);
    expect(await db.select().from(smartSiteSubmissionsTable).where(and(eq(smartSiteSubmissionsTable.siteId, company.site), eq(smartSiteSubmissionsTable.requestId, input.requestId)))).toHaveLength(1);
  } finally { adapter.close(); }
});

it("never reports saved intake when a company's responder disappears", async () => {
  const company = companies[1];
  await db.update(usersTable).set({ isActive: false }).where(eq(usersTable.id, company.owner));
  const input = intake(company);
  try {
    expect((await company.adapter.submit(input)).status).not.toBe("saved");
    expect(await db.select().from(smartSiteSubmissionsTable).where(eq(smartSiteSubmissionsTable.requestId, input.requestId))).toHaveLength(0);
  } finally { await db.update(usersTable).set({ isActive: true }).where(eq(usersTable.id, company.owner)); }
  expect((await company.adapter.drain({ retryRequestId: input.requestId })).counts.saved).toBeGreaterThanOrEqual(1);
});

it("retains a paused company's website request and blocks cross-company identities", async () => {
  const [a, b] = companies;
  expect(a.org).not.toBe(b.org);
  expect((await request(a.sid, `/smart-sites/${b.site}`, { isActive: false }, "PATCH")).status).toBe(404);
  const wrongKey = await fetch(`${base}/api/v1/public/smart-sites/${b.site}/check`, { method: "POST", headers: { authorization: `Bearer ${a.key}`, "content-type": "application/json" }, body: JSON.stringify({ schemaVersion: 1 }) });
  expect(wrongKey.status).toBe(401);
  const paused = await request(a.sid, "/customer-lifecycle/transition", { action: "pause", expectedVersion: 0, reason: "Synthetic onboarding hold rehearsal" });
  expect(paused.status).toBe(200);
  const installation = await getActiveInstallationKey(a.org);
  for (const route of ["/public/assessments", "/public/forms/synthetic/submissions", "/public/analytics-events"]) {
    const response = await fetch(`${base}/api/v1${route}`, { method: "POST", headers: {
      "content-type": "application/json", "x-installation-key": installation.publicKey, origin: process.env.APP_ORIGIN!,
    }, body: "{}" });
    expect(response.status).toBe(423);
    expect(await response.json()).toMatchObject({ code: "customer_lifecycle_paused" });
  }
  const input = intake(a);
  const visitorId = randomUUID();
  const measured = await fetch(`${base}/api/v1/public/smart-sites/${a.site}/acquisition-events`, { method: "POST", headers: { authorization: `Bearer ${a.key}`, "content-type": "application/json" }, body: JSON.stringify({
    schemaVersion: 1, consent: true, policyVersion: "smart-sites-analytics-v1", visitorId, sessionId: randomUUID(), events: [{ eventId: randomUUID(), eventName: "page_view", occurredAt: new Date().toISOString(), path: "/", surface: "website" }],
  }) });
  expect(measured.status).toBe(423);
  expect(await db.select().from(analyticsEventsTable).where(eq(analyticsEventsTable.smartSiteId, a.site))).toHaveLength(0);
  const optedOut = await fetch(`${base}/api/v1/public/smart-sites/${a.site}/analytics-opt-out`, { method: "POST", headers: { authorization: `Bearer ${a.key}`, "content-type": "application/json" }, body: JSON.stringify({ schemaVersion: 1, visitorId }) });
  expect(optedOut.status).toBe(200);
  const [existingLead] = await db.select().from(leadsTable).where(eq(leadsTable.organizationId, a.org));
  const referral = await getOrCreateEngagementLink(a.org, existingLead.contactId, "referral", existingLead.id);
  const referred = await fetch(`${base}/api/v1/public/referrals/${referral.token}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Synthetic Held Referral", email: "referral@example.invalid" }) });
  expect(referred.status).toBe(423);
  expect((await db.select().from(engagementLinksTable).where(eq(engagementLinksTable.id, referral.id)))[0].submissionCount).toBe(0);
  expect((await a.adapter.submit(input)).status).not.toBe("saved");
  expect(await db.select().from(smartSiteSubmissionsTable).where(eq(smartSiteSubmissionsTable.requestId, input.requestId))).toHaveLength(0);
  expect((await request(a.sid, "/customer-lifecycle/transition", { action: "resume", expectedVersion: 1, resumeQueuedWork: true, reason: "Reviewed synthetic requests before resuming" })).status).toBe(200);
  expect((await a.adapter.drain({ retryRequestId: input.requestId })).counts.saved).toBeGreaterThan(0);
  const receipt = await db.select().from(smartSiteSubmissionsTable).where(eq(smartSiteSubmissionsTable.requestId, input.requestId));
  expect(receipt).toHaveLength(1); expect(receipt[0].organizationId).toBe(a.org);
  expect(externalAttempts).toBe(0);
});
