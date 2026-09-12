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
          { isActive: true },
          "PATCH",
          otherSid,
        )
      ).status,
    ).toBe(404);
    expect(
      (await auth(`/smart-sites/${site.id}`, { isActive: true }, "PATCH"))
        .status,
    ).toBe(200);
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
    await auth(
      `/smart-sites/${created.id}`,
      { isActive: true },
      "PATCH",
      otherSid,
    );
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
      await auth(
        `/smart-sites/${created.id}`,
        { isActive: true },
        "PATCH",
        otherSid,
      );
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
