import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  activitiesTable,
  auditEventsTable,
  contactsTable,
  crmTasksTable,
  db,
  leadsTable,
  organizationsTable,
  propertiesTable,
  smartSiteSubmissionsTable,
  smartSitesTable,
  smartSiteFollowupsTable,
  usersTable,
} from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import app from "../../app";
import { createSession } from "../../lib/auth";
import { deleteTestOrgs } from "../../test-helpers/delete-test-orgs";
import { getNextBestAction } from "../../services/next-best-action";

let server: Server,
  base: string,
  sid: string,
  otherSid: string,
  viewerSid: string;
let orgId: string, otherOrgId: string;
let site: { id: string; secret: string };
type Receipt = {
  leadId: string;
  receiptId: string;
  duplicate: boolean;
  error?: string;
};
type Site = { id: string; secret: string; isActive: boolean };
type Overview = {
  rows: { captured: number; won: number; contractValueCents: number }[];
};
type FollowupReport = {
  summary: { overdue: number; logged: number };
  pending: { leadId: string }[];
};
const json = <T>(response: Response) => response.json() as Promise<T>;
const receipt = (response: Response) => json<Receipt>(response);
const body = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  requestId: randomUUID(),
  contact: {
    name: "Local Test Homeowner",
    email: "smart-site@example.com",
    phone: "404-555-0198",
  },
  project: {
    serviceCode: "siding",
    postalCode: "30115",
    summary: "Ask about siding options",
    timing: "planning",
  },
  consent: {
    contact: true,
    analytics: false,
    policyVersion: "test-inquiry-v1",
  },
  ...overrides,
});

describe("Smart Site ownership and first-attempt evidence", () => {
  const newInquiry = async (receivedAt?: string) => {
    const created = await json<Site>(
      await auth(
        "/smart-sites",
        {
          name: "Follow-up Test",
          siteKey: `follow-${randomUUID()}`,
          profile: "roofing-exteriors",
        },
        "POST",
      ),
    );
    expect((await enableSite(created)).status).toBe(200);
    const res = await send(
      body({
        contact: {
          name: "Followup Test",
          email: `${randomUUID()}@example.test`,
        },
      }),
      created,
      receivedAt ? { "x-smart-site-received-at": receivedAt } : {},
    );
    expect(res.status).toBe(201);
    return { ...(await receipt(res)), siteId: created.id };
  };
  const ownerId = async () =>
    (
      await db
        .select()
        .from(usersTable)
        .where(
          and(
            eq(usersTable.organizationId, orgId),
            eq(usersTable.role, "admin"),
          ),
        )
    )[0].id;

  it("snapshots elapsed-time targets from the trusted website receipt and never rewrites old deadlines", async () => {
    const accepted = new Date(Date.now() - 2 * 3600_000).toISOString();
    const saved = await newInquiry(accepted);
    const [before] = await db
      .select()
      .from(smartSiteSubmissionsTable)
      .where(eq(smartSiteSubmissionsTable.leadId, saved.leadId));
    expect(before.siteReceivedAt?.toISOString()).toBe(accepted);
    expect(before.responseDueAt!.getTime() - Date.parse(accepted)).toBe(
      60 * 60_000,
    );
    expect(
      (
        await auth(
          `/smart-sites/${saved.siteId}/response-target`,
          { minutes: 15 },
          "PATCH",
        )
      ).status,
    ).toBe(200);
    const [after] = await db
      .select()
      .from(smartSiteSubmissionsTable)
      .where(eq(smartSiteSubmissionsTable.leadId, saved.leadId));
    expect(after.responseDueAt).toEqual(before.responseDueAt);
    const report = await json<FollowupReport>(
      await auth("/smart-sites/follow-up"),
    );
    expect(report.summary.overdue).toBeGreaterThan(0);
    expect(
      report.pending.some((p: { leadId: string }) => p.leadId === saved.leadId),
    ).toBe(true);
    expect(
      (
        await auth(
          `/smart-sites/${saved.siteId}/response-target`,
          { minutes: 0 },
          "PATCH",
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await auth(
          `/smart-sites/${saved.siteId}/response-target`,
          { minutes: 15 },
          "PATCH",
          viewerSid,
        )
      ).status,
    ).toBe(403);
  });
  it("claims lead and open task together, detects a concurrent owner change, and respects normal CRM reassignment", async () => {
    const saved = await newInquiry();
    const owner = await ownerId();
    const updates = await Promise.all(
      [1, 2].map(() =>
        auth(
          `/smart-sites/leads/${saved.leadId}/owner`,
          { assignedUserId: owner, expectedOwnerId: null },
          "PATCH",
        ),
      ),
    );
    expect(updates.map((r) => r.status).sort()).toEqual([200, 409]);
    const [task] = await db
      .select()
      .from(crmTasksTable)
      .where(eq(crmTasksTable.leadId, saved.leadId));
    expect(task.assignedUserId).toBe(owner);
    expect(
      (await auth(`/leads/${saved.leadId}`, { assignedUserId: null }, "PATCH"))
        .status,
    ).toBe(200);
    const [updated] = await db
      .select()
      .from(crmTasksTable)
      .where(eq(crmTasksTable.id, task.id));
    expect(updated.assignedUserId).toBeNull();
  });
  it("rejects cross-tenant, inactive, viewer and unauthorized ownership changes", async () => {
    const saved = await newInquiry();
    const [other] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.organizationId, otherOrgId));
    const [viewer] = await db
      .select()
      .from(usersTable)
      .where(
        and(
          eq(usersTable.organizationId, orgId),
          eq(usersTable.role, "viewer"),
        ),
      );
    const [inactive] = await db
      .insert(usersTable)
      .values({ organizationId: orgId, role: "sales_rep", isActive: false })
      .returning();
    for (const assignedUserId of [other.id, viewer.id, inactive.id])
      expect(
        (
          await auth(
            `/smart-sites/leads/${saved.leadId}/owner`,
            { assignedUserId, expectedOwnerId: null },
            "PATCH",
          )
        ).status,
      ).toBe(400);
    expect(
      (
        await auth(
          `/smart-sites/leads/${saved.leadId}/owner`,
          { assignedUserId: other.id, expectedOwnerId: null },
          "PATCH",
          otherSid,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await auth(
          `/smart-sites/leads/${saved.leadId}/owner`,
          { assignedUserId: await ownerId(), expectedOwnerId: null },
          "PATCH",
          viewerSid,
        )
      ).status,
    ).toBe(403);
    const otherReport = await json<FollowupReport>(
      await auth("/smart-sites/follow-up", undefined, "GET", otherSid),
    );
    expect(
      otherReport.pending.some(
        (p: { leadId: string }) => p.leadId === saved.leadId,
      ),
    ).toBe(false);
  });
  it("notes and status updates do not count; confirmed contact logging is idempotent and closes only the intake task", async () => {
    const saved = await newInquiry();
    await db.insert(activitiesTable).values({
      organizationId: orgId,
      leadId: saved.leadId,
      actorUserId: await ownerId(),
      type: "note",
      title: "Internal planning only",
    });
    await auth(`/leads/${saved.leadId}`, { status: "follow_up" }, "PATCH");
    const [before] = await db
      .select()
      .from(smartSiteSubmissionsTable)
      .where(eq(smartSiteSubmissionsTable.leadId, saved.leadId));
    expect(before.firstAttemptAt).toBeNull();
    const input = {
      requestId: randomUUID(),
      channel: "phone",
      outcome: "no_answer",
      confirmed: true,
    };
    expect(
      (
        await auth(
          `/smart-sites/leads/${saved.leadId}/contact-attempts`,
          { ...input, confirmed: false },
          "POST",
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await auth(
          `/smart-sites/leads/${saved.leadId}/contact-attempts`,
          input,
          "POST",
          viewerSid,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await auth(
          `/smart-sites/leads/${saved.leadId}/contact-attempts`,
          input,
          "POST",
          otherSid,
        )
      ).status,
    ).toBe(404);
    const first = await auth(
      `/smart-sites/leads/${saved.leadId}/contact-attempts`,
      input,
      "POST",
    );
    expect(first.status).toBe(201);
    const again = await auth(
      `/smart-sites/leads/${saved.leadId}/contact-attempts`,
      input,
      "POST",
    );
    expect(again.status).toBe(200);
    expect((await json<{ duplicate: boolean }>(again)).duplicate).toBe(true);
    expect(
      (
        await auth(
          `/smart-sites/leads/${saved.leadId}/contact-attempts`,
          { ...input, outcome: "connected" },
          "POST",
        )
      ).status,
    ).toBe(409);
    const events = await db
      .select()
      .from(smartSiteFollowupsTable)
      .where(eq(smartSiteFollowupsTable.leadId, saved.leadId));
    expect(events).toHaveLength(1);
    const [after] = await db
      .select()
      .from(smartSiteSubmissionsTable)
      .where(eq(smartSiteSubmissionsTable.leadId, saved.leadId));
    expect(after.firstAttemptAt).toEqual(events[0].recordedAt);
    const [task] = await db
      .select()
      .from(crmTasksTable)
      .where(eq(crmTasksTable.leadId, saved.leadId));
    expect(task.status).toBe("done");
    const audit = await db
      .select()
      .from(auditEventsTable)
      .where(
        and(
          eq(auditEventsTable.entityId, saved.leadId),
          eq(auditEventsTable.action, "smart_site.contact_attempt_recorded"),
        ),
      );
    expect(audit).toHaveLength(1);
    expect((audit[0].metadata as Record<string, unknown>).evidence).toBe(
      "staff-recorded",
    );
    expect(
      (await json<FollowupReport>(await auth("/smart-sites/follow-up"))).summary
        .logged,
    ).toBeGreaterThan(0);
  });
});
const auth = (path: string, data?: unknown, method = "GET", token = sid) =>
  fetch(`${base}/api/v1${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    ...(data ? { body: JSON.stringify(data) } : {}),
  });
const send = (
  payload: unknown,
  target = site,
  headers: Record<string, string> = {},
) =>
  fetch(`${base}/api/v1/public/smart-sites/${target.id}/intake`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${target.secret}`,
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(payload),
  });
const checkCredential = (target: { id: string; secret: string }) =>
  fetch(`${base}/api/v1/public/smart-sites/${target.id}/check`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${target.secret}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ schemaVersion: 1 }),
  });
const enableSite = async (
  target: { id: string; secret: string },
  session = sid,
) => {
  expect((await checkCredential(target)).status).toBe(200);
  return auth(
    `/smart-sites/${target.id}`,
    { isActive: true, confirmedLaunch: true },
    "PATCH",
    session,
  );
};

beforeAll(async () => {
  // Do not allow this DB-writing suite to accidentally target a remote or production database.
  const url = new URL(process.env.DATABASE_URL!);
  if (
    !["127.0.0.1", "localhost"].includes(url.hostname) ||
    !url.pathname.endsWith("_test")
  )
    throw new Error("Smart Sites tests require a local *_test database");
  const ids = [];
  for (const label of ["primary", "other"]) {
    const [org] = await db
      .insert(organizationsTable)
      .values({
        name: `Smart Sites ${label} test`,
        slug: `smart-sites-${label}-${randomUUID()}`,
      })
      .returning();
    ids.push(org.id);
  }
  [orgId, otherOrgId] = ids;
  const sessionFor = async (
    organizationId: string,
    role: "admin" | "viewer",
  ) => {
    const [u] = await db
      .insert(usersTable)
      .values({
        organizationId,
        role,
        email: `smart-${randomUUID()}@example.com`,
      })
      .returning();
    return createSession({
      user: {
        id: u.id,
        email: u.email,
        firstName: null,
        lastName: null,
        profileImageUrl: null,
      },
      access_token: "test-only",
      expires_at: Math.floor(Date.now() / 1000) + 3600,
    });
  };
  sid = await sessionFor(orgId, "admin");
  otherSid = await sessionFor(otherOrgId, "admin");
  viewerSid = await sessionFor(orgId, "viewer");
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server?.close();
  await deleteTestOrgs(orgId, otherOrgId);
});

describe("reusable Smart Sites capture", () => {
  it("lists all four starter profiles and blocks unprivileged provisioning", async () => {
    const profiles = await json<{ id: string }[]>(
      await auth("/smart-sites/profiles"),
    );
    expect(profiles.map((p: { id: string }) => p.id)).toEqual([
      "roofing-exteriors",
      "hvac",
      "commercial-construction",
      "local-retail",
    ]);
    expect(
      (
        await auth(
          "/smart-sites",
          { name: "No permission", siteKey: "blocked", profile: "hvac" },
          "POST",
          viewerSid,
        )
      ).status,
    ).toBe(403);
  });
  it("creates draft connections and never lists their secret or its hash", async () => {
    const res = await auth(
      "/smart-sites",
      {
        name: "Painless Local Test",
        siteKey: "painless-local-test",
        profile: "roofing-exteriors",
      },
      "POST",
    );
    expect(res.status).toBe(201);
    site = await json<Site>(res);
    expect(site.secret).toMatch(/^ss_[a-f0-9]{64}$/);
    const list = await json<Site[]>(await auth("/smart-sites"));
    expect(list[0].isActive).toBe(false);
    expect(JSON.stringify(list)).not.toContain(site.secret);
    expect(list[0]).not.toHaveProperty("keyHash");
    expect((await send(body())).status).toBe(503);
  });
  it("isolates tenants and enables only the owning organization", async () => {
    expect(
      await (await auth("/smart-sites", undefined, "GET", otherSid)).json(),
    ).toEqual([]);
    expect(
      (
        await auth(
          `/smart-sites/${site.id}`,
          { isActive: true, confirmedLaunch: true },
          "PATCH",
          otherSid,
        )
      ).status,
    ).toBe(404);
    const readinessBefore = await json<{
      sites: { id: string; ready: boolean; blockers: string[] }[];
    }>(await auth("/smart-sites/launch-readiness"));
    expect(
      readinessBefore.sites.find((row) => row.id === site.id),
    ).toMatchObject({
      ready: false,
      blockers: ["credential_not_verified"],
    });
    expect(
      (await auth(`/smart-sites/${site.id}`, { isActive: true }, "PATCH"))
        .status,
    ).toBe(409);
    const blocked = await auth(
      `/smart-sites/${site.id}`,
      { isActive: true, confirmedLaunch: true },
      "PATCH",
    );
    expect(blocked.status).toBe(409);
    expect(await json(blocked)).toMatchObject({
      error: "smart_site_launch_blocked",
      blockers: ["credential_not_verified"],
    });
    expect((await enableSite(site)).status).toBe(200);
    const readinessAfter = await json<{
      sites: { id: string; ready: boolean; blockers: string[] }[];
    }>(await auth("/smart-sites/launch-readiness"));
    expect(
      readinessAfter.sites.find((row) => row.id === site.id),
    ).toMatchObject({ ready: true, blockers: [] });
    const [enabledAudit] = await db
      .select()
      .from(auditEventsTable)
      .where(
        and(
          eq(auditEventsTable.entityId, site.id),
          eq(auditEventsTable.action, "smart_site.enabled"),
        ),
      )
      .orderBy(sql`${auditEventsTable.createdAt} desc`)
      .limit(1);
    expect(enabledAudit.metadata).toMatchObject({
      contract: "smart-site-launch-guard-v1",
      confirmedLaunch: true,
      operatorAttestation: "staff-owner-contact-policy-and-https-acceptance-v1",
      activeManagers: 1,
      activeResponders: 1,
      credentialVersion: 1,
    });
  });
  it("labels stale credential evidence and rechecks readiness from server time", async () => {
    await db
      .update(smartSitesTable)
      .set({ credentialCheckedAt: new Date(Date.now() - 25 * 3600_000) })
      .where(eq(smartSitesTable.id, site.id));
    const stale = await json<{
      contract: string;
      credentialCheckMaxAgeHours: number;
      sites: { id: string; ready: boolean; blockers: string[] }[];
    }>(await auth("/smart-sites/launch-readiness"));
    expect(stale.contract).toBe("smart-site-launch-guard-v1");
    expect(stale.credentialCheckMaxAgeHours).toBe(24);
    expect(stale.sites.find((row) => row.id === site.id)).toMatchObject({
      ready: false,
      blockers: ["credential_check_stale"],
    });
    expect((await checkCredential(site)).status).toBe(200);
    await db
      .update(smartSitesTable)
      .set({ credentialIssuedAt: null })
      .where(eq(smartSitesTable.id, site.id));
    const historical = await json<{
      sites: { id: string; ready: boolean; blockers: string[] }[];
    }>(await auth("/smart-sites/launch-readiness"));
    expect(historical.sites.find((row) => row.id === site.id)).toMatchObject({
      ready: true,
      blockers: [],
    });
    await db
      .update(smartSitesTable)
      .set({ credentialIssuedAt: new Date() })
      .where(eq(smartSitesTable.id, site.id));
  });
  it("fails closed before saving a new inquiry when every responder is inactive", async () => {
    const [admin] = await db
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(
        and(eq(usersTable.organizationId, orgId), eq(usersTable.role, "admin")),
      );
    await db
      .update(usersTable)
      .set({ isActive: false })
      .where(eq(usersTable.id, admin.id));
    const requestId = randomUUID();
    try {
      const response = await send(
        body({
          requestId,
          contact: {
            name: "No Responder Test",
            email: `${randomUUID()}@example.test`,
          },
        }),
      );
      expect(response.status).toBe(503);
      expect(await json(response)).toEqual({
        error: "site_staffing_unavailable",
      });
      expect(
        await db
          .select()
          .from(smartSiteSubmissionsTable)
          .where(eq(smartSiteSubmissionsTable.requestId, requestId)),
      ).toHaveLength(0);
    } finally {
      await db
        .update(usersTable)
        .set({ isActive: true })
        .where(eq(usersTable.id, admin.id));
    }
  });
  it("rejects bad keys, browser origins, missing consent, unsupported service and tenant injection", async () => {
    expect(
      (await send(body(), { ...site, secret: `ss_${"a".repeat(64)}` })).status,
    ).toBe(401);
    expect(
      (await send(body(), site, { origin: "https://example.com" })).status,
    ).toBe(403);
    expect(
      (await send(body({ consent: { contact: false, policyVersion: "test" } })))
        .status,
    ).toBe(400);
    expect(
      (await send(body({ project: { serviceCode: "made-up" } }))).status,
    ).toBe(400);
    expect((await send(body({ organizationId: otherOrgId }))).status).toBe(400);
  });
  it("atomically creates a lead, consent receipt, inbox task and audit without external sends", async () => {
    const input = body();
    const res = await send(input);
    expect(res.status).toBe(201);
    const result = await receipt(res);
    expect(result).toMatchObject({
      status: "saved",
      duplicate: false,
      notification: "staff-inbox",
    });
    const [lead] = await db
      .select()
      .from(leadsTable)
      .where(eq(leadsTable.id, result.leadId));
    expect(lead.organizationId).toBe(orgId);
    expect(lead.serviceType).toBe("Siding");
    expect(lead.propertyId).toBeNull();
    expect(lead.source).toBe("painless-local-test");
    expect(lead.anonymousId).toBeNull();
    expect(
      (
        await db
          .select()
          .from(crmTasksTable)
          .where(eq(crmTasksTable.leadId, lead.id))
      ).length,
    ).toBe(1);
    expect(
      (
        await db
          .select()
          .from(activitiesTable)
          .where(eq(activitiesTable.leadId, lead.id))
      ).length,
    ).toBe(1);
    const [activity] = await db
      .select()
      .from(activitiesTable)
      .where(eq(activitiesTable.leadId, lead.id));
    expect(activity.body).toContain("Property ZIP: 30115");
    expect(activity.metadata?.submittedContact).toMatchObject({
      name: input.contact.name,
      phone: "4045550198",
    });
    expect(
      (
        await db
          .select()
          .from(auditEventsTable)
          .where(eq(auditEventsTable.entityId, lead.id))
      ).length,
    ).toBe(1);
    const [savedReceipt] = await db
      .select()
      .from(smartSiteSubmissionsTable)
      .where(eq(smartSiteSubmissionsTable.id, result.receiptId));
    expect(savedReceipt.consent.contact).toBe(true);
    const nextAction = await getNextBestAction(orgId, lead.id);
    expect(nextAction?.title).toBe("Review and respond to this new inquiry");
    expect(nextAction?.draft).toBeUndefined();
    expect((await send(input)).status).toBe(200);
    expect((await receipt(await send(input))).leadId).toBe(lead.id);
  });
  it("handles concurrent retries and rejects a changed request with the same key", async () => {
    const input = body();
    const results = await Promise.all([send(input), send(input), send(input)]);
    const parsed = await Promise.all(results.map(receipt));
    expect(new Set(parsed.map((r) => r.leadId)).size).toBe(1);
    expect(parsed.filter((r) => !r.duplicate).length).toBe(1);
    const conflict = await send({
      ...input,
      project: { ...input.project, serviceCode: "gutters" },
    });
    expect(conflict.status).toBe(409);
    expect((await receipt(conflict)).error).toBe("idempotency_conflict");
  });
  it("preserves distinct projects for one contact and creates only complete properties", async () => {
    const first = await receipt(await send(body()));
    const next = body({
      project: {
        serviceCode: "gutters",
        address: "100 Example Lane",
        city: "Canton",
        state: "GA",
        postalCode: "30115",
      },
    });
    const second = await receipt(await send(next));
    expect(second.leadId).not.toBe(first.leadId);
    const [lead] = await db
      .select()
      .from(leadsTable)
      .where(eq(leadsTable.id, second.leadId));
    const [prior] = await db
      .select()
      .from(leadsTable)
      .where(eq(leadsTable.id, first.leadId));
    expect(lead.contactId).toBe(prior.contactId);
    expect(lead.propertyId).toBeTruthy();
    expect(
      (
        await db
          .select()
          .from(propertiesTable)
          .where(eq(propertiesTable.id, lead.propertyId!))
      )[0].postalCode,
    ).toBe("30115");
  });
  it("drops attribution without tracking consent and accepts bounded labels with consent", async () => {
    const attribution = {
      source: "partner",
      medium: "referral",
      campaign: "fall-projects",
      landingPath: "/siding",
      referrerHost: "example.com",
    };
    const a = await receipt(await send(body({ attribution })));
    expect(
      (await db.select().from(leadsTable).where(eq(leadsTable.id, a.leadId)))[0]
        .campaign,
    ).toBeNull();
    const b = await receipt(
      await send(
        body({
          attribution,
          consent: { contact: true, analytics: true, policyVersion: "test" },
        }),
      ),
    );
    expect(
      (await db.select().from(leadsTable).where(eq(leadsTable.id, b.leadId)))[0]
        .campaign,
    ).toBe("fall-projects");
    expect(
      (
        await send(
          body({ attribution: { landingPath: "/?email=person@example.com" } }),
        )
      ).status,
    ).toBe(400);
  });
  it("rolls every write back if the inbox task cannot be saved", async () => {
    const input = body({
      contact: { name: "Rollback Test", email: "rollback@example.com" },
    });
    // Test-only trigger scoped to this test org, removed even after failure.
    await db.execute(
      sql.raw(
        `CREATE FUNCTION smart_sites_test_fail_task() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.organization_id = '${orgId}' THEN RAISE EXCEPTION 'test failure'; END IF; RETURN NEW; END $$`,
      ),
    );
    await db.execute(
      sql.raw(
        "CREATE TRIGGER smart_sites_test_fail_task BEFORE INSERT ON crm_tasks FOR EACH ROW EXECUTE FUNCTION smart_sites_test_fail_task()",
      ),
    );
    try {
      expect((await send(input)).status).toBe(503);
    } finally {
      await db.execute(
        sql.raw("DROP TRIGGER smart_sites_test_fail_task ON crm_tasks"),
      );
      await db.execute(sql.raw("DROP FUNCTION smart_sites_test_fail_task()"));
    }
    expect(
      await db
        .select()
        .from(smartSiteSubmissionsTable)
        .where(eq(smartSiteSubmissionsTable.requestId, input.requestId)),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(contactsTable)
        .where(
          and(
            eq(contactsTable.organizationId, orgId),
            eq(contactsTable.email, "rollback@example.com"),
          ),
        ),
    ).toHaveLength(0);
    expect((await send(input)).status).toBe(201);
  });
  it("returns only authoritative counts in the owning tenant overview", async () => {
    const overview = await json<Overview>(await auth("/smart-sites/overview"));
    expect(
      overview.rows.reduce(
        (n: number, r: { captured: number }) => n + r.captured,
        0,
      ),
    ).toBeGreaterThan(0);
    expect(
      overview.rows.every(
        (r: { won: number; contractValueCents: number }) =>
          r.won === 0 && r.contractValueCents === 0,
      ),
    ).toBe(true);
    expect(
      (
        await json<Overview>(
          await auth("/smart-sites/overview", undefined, "GET", otherSid),
        )
      ).rows,
    ).toEqual([]);
  });
  it("captures retail inquiries without a property or roofing terminology", async () => {
    const created = await json<Site>(
      await auth(
        "/smart-sites",
        {
          name: "Tea Shop Local Test",
          siteKey: "tea-shop-local-test",
          profile: "local-retail",
        },
        "POST",
        otherSid,
      ),
    );
    expect((await enableSite(created, otherSid)).status).toBe(200);
    const res = await send(
      body({
        contact: { name: "Local Retail Test", email: "retail@example.com" },
        project: { serviceCode: "group-order" },
      }),
      created,
    );
    expect(res.status).toBe(201);
    const [lead] = await db
      .select()
      .from(leadsTable)
      .where(eq(leadsTable.id, (await receipt(res)).leadId));
    expect(lead.organizationId).toBe(otherOrgId);
    expect(lead.serviceType).toBe("Group order inquiry");
    expect(lead.propertyId).toBeNull();
  });
  it.each([
    ["hvac", "repair", "Repair"],
    ["commercial-construction", "tenant-improvement", "Tenant improvements"],
  ])(
    "captures the %s profile through the same receipt and CRM workflow",
    async (profile, serviceCode, label) => {
      const created = await json<Site>(
        await auth(
          "/smart-sites",
          {
            name: `${profile} Local Test`,
            siteKey: `${profile}-local-test`,
            profile,
          },
          "POST",
          otherSid,
        ),
      );
      expect((await enableSite(created, otherSid)).status).toBe(200);
      const res = await send(
        body({
          contact: {
            name: "Other Business Test",
            email: `${profile}@example.test`,
          },
          project: { serviceCode },
        }),
        created,
      );
      expect(res.status).toBe(201);
      const [lead] = await db
        .select()
        .from(leadsTable)
        .where(eq(leadsTable.id, (await receipt(res)).leadId));
      expect(lead.organizationId).toBe(otherOrgId);
      expect(lead.serviceType).toBe(label);
      expect(lead.propertyId).toBeNull();
    },
  );
  it("revokes the old credential on rotation and pauses capture until re-enabled", async () => {
    expect(
      (await auth(`/smart-sites/${site.id}/rotate-key`, {}, "POST", otherSid))
        .status,
    ).toBe(404);
    const rotated = await json<Site>(
      await auth(`/smart-sites/${site.id}/rotate-key`, {}, "POST"),
    );
    expect(rotated.isActive).toBe(false);
    expect(rotated.secret).not.toBe(site.secret);
    expect((await send(body())).status).toBe(401);
    expect((await send(body(), rotated)).status).toBe(503);
  });
});
