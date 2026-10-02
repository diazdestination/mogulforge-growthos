import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  db,
  organizationsTable,
  usersTable,
  orgSettingsTable,
  smartSitesTable,
  smartSiteOnboardingsTable,
  auditEventsTable,
  leadsTable,
  playbooksTable,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import app from "../../app";
import { createSession } from "../../lib/auth";
import { deleteTestOrgs } from "../../test-helpers/delete-test-orgs";
import {
  clientDraftSchema,
  createClientDraft,
} from "../../services/client-onboarding";
import { SMART_SITE_PROFILES } from "../../services/smart-site-contract";

let server: Server,
  base: string,
  adminSid: string,
  ownerSid: string,
  inactiveSid: string,
  adminId: string;
const orgIds: string[] = [];
const fixture = () => ({
  requestId: randomUUID(),
  name: "Independent HVAC QA",
  slug: `qa-${randomUUID()}`,
  profile: "hvac",
  timezone: "America/New_York",
  responseTargetMinutes: 60,
  confirmed: true,
});
type Draft = { organizationId: string; siteId: string; duplicate: boolean };
type Key = { secret: string; credentialVersion: number };
const json = <T>(res: Response) => res.json() as Promise<T>;
const auth = (
  sid: string,
  path: string,
  body?: unknown,
  method = body ? "POST" : "GET",
  extra = {},
) =>
  fetch(`${base}/api/v1${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      cookie: `sid=${sid}`,
      ...extra,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
const draft = async (input = fixture()) => {
  const res = await auth(adminSid, "/platform/clients", input);
  expect([200, 201]).toContain(res.status);
  const result = await json<Draft>(res);
  orgIds.push(result.organizationId);
  return result;
};
const key = (d: Draft, expectedVersion = 1) =>
  auth(
    adminSid,
    `/platform/clients/${d.organizationId}/sites/${d.siteId}/key`,
    { confirmed: true, expectedVersion },
  );
const check = (
  d: Draft,
  secret: string,
  body: unknown = { schemaVersion: 1 },
  extra = {},
) =>
  auth("", `/public/smart-sites/${d.siteId}/check`, body, "POST", {
    authorization: `Bearer ${secret}`,
    ...extra,
  });
beforeAll(async () => {
  if (!new URL(process.env.DATABASE_URL ?? "").pathname.endsWith("_test"))
    throw new Error("Use an isolated _test database");
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const [org] = await db
    .insert(organizationsTable)
    .values({ name: "Operator local test", slug: `operator-${randomUUID()}` })
    .returning();
  orgIds.push(org.id);
  const session = async (platform: boolean, active = true) => {
    const [user] = await db
      .insert(usersTable)
      .values({
        organizationId: org.id,
        role: "owner",
        isPlatformAdmin: platform,
        isActive: active,
      })
      .returning();
    if (platform && active) adminId = user.id;
    return createSession({
      user: {
        id: user.id,
        email: null,
        firstName: null,
        lastName: null,
        profileImageUrl: null,
      },
      access_token: "qa-token",
      expires_at: Math.floor(Date.now() / 1000) + 3600,
    });
  };
  adminSid = await session(true);
  ownerSid = await session(false);
  inactiveSid = await session(true, false);
});
afterAll(async () => {
  server?.close();
  await deleteTestOrgs(...orgIds.reverse());
});

describe("Isolated client provisioning", () => {
  it("requires a fresh active platform-admin session, not owner or API-key access", async () => {
    for (const sid of ["", ownerSid, inactiveSid]) {
      const res = await auth(sid, "/platform/clients", fixture());
      expect([401, 403]).toContain(res.status);
      expect([401, 403]).toContain(
        (await auth(sid, "/platform/clients/profiles")).status,
      );
    }
    expect(
      (
        await auth(adminSid, "/platform/clients", fixture(), "POST", {
          "x-api-key": "not-authorized",
        })
      ).status,
    ).toBe(403);
  });
  it.each(SMART_SITE_PROFILES.map((p) => p.id))(
    "creates an isolated inactive %s draft with neutral configuration",
    async (profile) => {
      const original = await db
        .select()
        .from(usersTable)
        .where(eq(usersTable.id, adminId));
      const d = await draft({ ...fixture(), profile });
      const [site] = await db
        .select()
        .from(smartSitesTable)
        .where(eq(smartSitesTable.id, d.siteId));
      expect(site.organizationId).toBe(d.organizationId);
      expect(site.isActive).toBe(false);
      expect(site.credentialIssuedAt).toBeNull();
      const [settings] = await db
        .select()
        .from(orgSettingsTable)
        .where(eq(orgSettingsTable.organizationId, d.organizationId));
      expect(settings.services.map((s) => s.slug)).toEqual(
        SMART_SITE_PROFILES.find((p) => p.id === profile)!.services.map(
          ([s]) => s,
        ),
      );
      expect(JSON.stringify(settings)).not.toMatch(/painless|canton/i);
      expect(settings.widget?.leadCaptureEnabled).toBe(false);
      expect(
        await db
          .select()
          .from(usersTable)
          .where(eq(usersTable.organizationId, d.organizationId)),
      ).toHaveLength(0);
      expect(
        await db
          .select()
          .from(playbooksTable)
          .where(eq(playbooksTable.organizationId, d.organizationId)),
      ).toHaveLength(0);
      const [operator] = await db
        .select()
        .from(usersTable)
        .where(eq(usersTable.id, adminId));
      expect(operator.organizationId).toBe(original[0].organizationId);
      expect(operator.role).toBe(original[0].role);
    },
  );
  it("reconciles concurrent and lost-ack retries without duplicating clients or audit events", async () => {
    const input = fixture();
    const results = await Promise.all([draft(input), draft(input)]);
    expect(results[0].organizationId).toBe(results[1].organizationId);
    expect(results.filter((r) => r.duplicate)).toHaveLength(1);
    expect(
      await db
        .select()
        .from(smartSiteOnboardingsTable)
        .where(
          eq(
            smartSiteOnboardingsTable.organizationId,
            results[0].organizationId,
          ),
        ),
    ).toHaveLength(1);
    expect(
      await db
        .select()
        .from(auditEventsTable)
        .where(
          and(
            eq(auditEventsTable.organizationId, results[0].organizationId),
            eq(auditEventsTable.action, "smart_site.client_draft_created"),
          ),
        ),
    ).toHaveLength(1);
    expect(
      (
        await auth(adminSid, "/platform/clients", {
          ...input,
          name: "Changed data",
        })
      ).status,
    ).toBe(409);
  });
  it("rejects duplicate slugs, invalid profile/zone, unconfirmed and injected tenant fields", async () => {
    const input = fixture();
    await draft(input);
    expect(
      (
        await auth(adminSid, "/platform/clients", {
          ...input,
          requestId: randomUUID(),
        })
      ).status,
    ).toBe(409);
    for (const patch of [
      { profile: "made-up" },
      { timezone: "Mars/Test" },
      { confirmed: false },
      { organizationId: randomUUID() },
      { responseTargetMinutes: 0 },
    ]) {
      expect(
        (await auth(adminSid, "/platform/clients", { ...fixture(), ...patch }))
          .status,
      ).toBe(400);
    }
    expect(
      (
        await auth(adminSid, "/platform/clients", fixture(), "POST", {
          origin: "https://untrusted.example",
        })
      ).status,
    ).toBe(403);
  });
  it("rolls back the organization if the final provisioning receipt fails", async () => {
    const input = fixture();
    await expect(
      createClientDraft(
        `missing-${randomUUID()}`,
        clientDraftSchema.parse(input),
      ),
    ).rejects.toThrow();
    expect(
      await db
        .select()
        .from(organizationsTable)
        .where(eq(organizationsTable.slug, input.slug)),
    ).toHaveLength(0);
  });
  it("readiness exposes configuration only and reports missing staff and unassessed launch gates", async () => {
    const d = await draft();
    const response = await auth(
      adminSid,
      `/platform/clients/${d.organizationId}/readiness`,
    );
    const report = await json<{
      organization: { id: string };
      staffing: { activeManagers: number };
      releaseStatus: string;
      sites: { credentialCheckedAt: null; lastSavedAt: null }[];
    }>(response);
    expect(report.organization.id).toBe(d.organizationId);
    expect(report.staffing.activeManagers).toBe(0);
    expect(report.releaseStatus).toBe("not_assessed");
    expect(report.sites[0].lastSavedAt).toBeNull();
    expect(JSON.stringify(report)).not.toMatch(
      /"(?:keyHash|secret|contactId|email|phone)":/,
    );
    expect(
      (await auth(ownerSid, `/platform/clients/${d.organizationId}/readiness`))
        .status,
    ).toBe(403);
    expect(
      (await auth(adminSid, `/platform/clients/${randomUUID()}/readiness`))
        .status,
    ).toBe(404);
  });
});

describe("Credential-only readiness proof", () => {
  it("checks an inactive site without creating leads, activating or accepting customer data", async () => {
    const d = await draft();
    const credential = await json<Key>(await key(d));
    expect((await check(d, credential.secret)).status).toBe(200);
    const [site] = await db
      .select()
      .from(smartSitesTable)
      .where(eq(smartSitesTable.id, d.siteId));
    expect(site.credentialCheckedAt).toBeInstanceOf(Date);
    expect(site.isActive).toBe(false);
    expect(
      await db
        .select()
        .from(leadsTable)
        .where(eq(leadsTable.organizationId, d.organizationId)),
    ).toHaveLength(0);
    expect(
      (
        await check(d, credential.secret, {
          schemaVersion: 1,
          contact: { name: "Not accepted" },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await check(d, credential.secret, undefined, {
          origin: "https://site.example",
        })
      ).status,
    ).toBe(403);
  });
  it("requires confirmation, prevents cross-org rotation and rejects stale versions", async () => {
    const a = await draft(),
      b = await draft();
    expect(
      (
        await auth(
          adminSid,
          `/platform/clients/${a.organizationId}/sites/${a.siteId}/key`,
          { expectedVersion: 1 },
        )
      ).status,
    ).toBe(400);
    expect((await key({ ...a, siteId: b.siteId })).status).toBe(409);
    const first = await json<Key>(await key(a));
    expect((await check(b, first.secret)).status).toBe(401);
    expect((await key(a)).status).toBe(409);
    expect((await check(a, first.secret)).status).toBe(200);
    const second = await json<Key>(await key(a, first.credentialVersion));
    const [site] = await db
      .select()
      .from(smartSitesTable)
      .where(eq(smartSitesTable.id, a.siteId));
    expect(site.credentialCheckedAt).toBeNull();
    expect((await check(a, first.secret)).status).toBe(401);
    expect((await check(a, second.secret)).status).toBe(200);
    expect(
      (
        await auth(
          ownerSid,
          `/platform/clients/${a.organizationId}/sites/${a.siteId}/key`,
          { confirmed: true, expectedVersion: second.credentialVersion },
        )
      ).status,
    ).toBe(403);
  });
});
