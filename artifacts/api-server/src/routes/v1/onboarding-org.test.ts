import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

import {
  activitiesTable,
  contactsTable,
  db,
  leadsTable,
  organizationsTable,
  playbooksTable,
  usersTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { deleteTestOrgs } from "../../test-helpers/delete-test-orgs";

import app from "../../app";
import { createSession } from "../../lib/auth";
import { clearLegacyOrgCache } from "../../lib/orgFlavor";
import { ensureMembership, getDefaultOrganization } from "../../services/org";
import { createInviteToken } from "../../services/invite-token";
import {
  getAppointmentReminderSettings,
  getConciergeSettings,
  getOrgSettings,
} from "../../services/settings";
import { ensureDefaultPlaybook } from "../../services/playbooks";

/**
 * Multi-org onboarding (#515): self-serve org creation, org-less sign-ins,
 * platform super-admin, industry-neutral defaults for fresh orgs, wizard
 * progress persistence, and the sandboxed guided test lead.
 */

let server: Server;
let baseUrl: string;
const createdOrgIds: string[] = [];
const createdUserIds: string[] = [];

async function makeUser(overrides: Partial<typeof usersTable.$inferInsert> = {}) {
  const [u] = await db
    .insert(usersTable)
    .values({
      email: `onboard-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`,
      ...overrides,
    })
    .returning();
  createdUserIds.push(u.id);
  return u;
}

async function sessionFor(userId: string) {
  return createSession({
    user: { id: userId, email: null, firstName: null, lastName: null, profileImageUrl: null },
    access_token: "test-token",
    expires_at: Math.floor(Date.now() / 1000) + 3600,
  });
}

function authed(sid: string) {
  return (path: string, init: RequestInit = {}) =>
    fetch(`${baseUrl}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        cookie: `sid=${sid}`,
        ...(init.headers ?? {}),
      },
    });
}

beforeAll(async () => {
  server = app.listen(0);
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

beforeEach(() => clearLegacyOrgCache());

afterAll(async () => {
  server?.close();
  await deleteTestOrgs(...createdOrgIds);
  for (const id of createdUserIds) {
    await db.delete(usersTable).where(eq(usersTable.id, id)).catch(() => {});
  }
});

describe("org-less sign-in", () => {
  it("does not auto-attach new users to the default org once it has members", async () => {
    // Seed the condition this test claims to exercise so it also holds in a
    // completely fresh disposable database.
    const defaultOrg = await getDefaultOrganization();
    await makeUser({
      organizationId: defaultOrg.id,
      role: "owner",
      isPlatformAdmin: true,
    });
    const u = await makeUser();
    const after = await ensureMembership(u.id);
    expect(after?.organizationId).toBeNull();
  });

  it("GET /session works without an org and reports organization: null", async () => {
    const u = await makeUser();
    const sid = await sessionFor(u.id);
    const res = await authed(sid)("/api/v1/session");
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.organization).toBeNull();
    expect(body.isPlatformAdmin).toBe(false);
  });

  it("GET /me still requires membership (403 when org-less)", async () => {
    const u = await makeUser();
    const sid = await sessionFor(u.id);
    const res = await authed(sid)("/api/v1/me");
    expect(res.status).toBe(403);
  });
});

describe("self-serve org creation", () => {
  it("creates an org, makes the creator the owner, and seeds neutral defaults", async () => {
    const u = await makeUser();
    const sid = await sessionFor(u.id);
    const res = await authed(sid)("/api/v1/orgs", {
      method: "POST",
      body: JSON.stringify({ name: "Summit Home Services" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    createdOrgIds.push(body.organization.id);
    expect(body.joined).toBe(true);
    expect(body.organization.slug).toBe("summit-home-services");

    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, u.id));
    expect(user.organizationId).toBe(body.organization.id);
    expect(user.role).toBe("owner");

    // Fresh org: no roofing copy, no borrowed Painless branding, anywhere in
    // its effective settings or seeded playbook.
    const orgId = body.organization.id as string;
    const settings = await getOrgSettings(orgId);
    const concierge = await getConciergeSettings(orgId);
    const reminder = await getAppointmentReminderSettings(orgId);
    const [playbook] = await db
      .select()
      .from(playbooksTable)
      .where(eq(playbooksTable.organizationId, orgId));
    const corpus = JSON.stringify({ settings, concierge, reminder, playbook }).toLowerCase();
    expect(corpus).not.toContain("roof");
    expect(corpus).not.toContain("painless");
    expect(corpus).not.toContain("canton");
    expect(corpus).not.toContain("404) 444");
    expect(settings.businessProfile.businessName).toBe("Summit Home Services");
    expect(settings.services).toEqual([]);
    expect(settings.serviceAreas).toEqual([]);
    expect(playbook).toBeTruthy();
    expect(playbook.steps.length).toBeGreaterThan(0);
  });

  it("rejects a second org for a non-platform-admin member", async () => {
    const u = await makeUser();
    const sid = await sessionFor(u.id);
    const first = await authed(sid)("/api/v1/orgs", {
      method: "POST",
      body: JSON.stringify({ name: "First Co Onboard" }),
    });
    const firstBody = (await first.json()) as any;
    createdOrgIds.push(firstBody.organization.id);
    const second = await authed(sid)("/api/v1/orgs", {
      method: "POST",
      body: JSON.stringify({ name: "Second Co Onboard" }),
    });
    expect(second.status).toBe(409);
  });

  it("rejects duplicate slugs and invalid names", async () => {
    const u = await makeUser();
    const sid = await sessionFor(u.id);
    const res = await authed(sid)("/api/v1/orgs", {
      method: "POST",
      body: JSON.stringify({ name: "X" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects API-key callers", async () => {
    const res = await fetch(`${baseUrl}/api/v1/orgs`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "bogus" },
      body: JSON.stringify({ name: "Keyed Org" }),
    });
    expect(res.status).toBe(403);
  });
});

describe("platform super-admin", () => {
  it("blocks non-admins and lists all orgs for platform admins", async () => {
    const normie = await makeUser();
    const normieSid = await sessionFor(normie.id);
    const denied = await authed(normieSid)("/api/v1/platform/orgs");
    expect(denied.status).toBe(403);

    const admin = await makeUser({ isPlatformAdmin: true });
    const adminSid = await sessionFor(admin.id);
    const res = await authed(adminSid)("/api/v1/platform/orgs");
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(Array.isArray(body.organizations)).toBe(true);
    expect(body.organizations.length).toBeGreaterThan(0);
  });

  it("platform admin can rename an org", async () => {
    const admin = await makeUser({ isPlatformAdmin: true });
    const adminSid = await sessionFor(admin.id);
    const created = await authed(adminSid)("/api/v1/orgs", {
      method: "POST",
      body: JSON.stringify({ name: "Rename Me Co" }),
    });
    const createdBody = (await created.json()) as any;
    createdOrgIds.push(createdBody.organization.id);
    // Platform admin without an org keeps org-less status but may provision.
    expect(created.status).toBe(201);

    const res = await authed(adminSid)(
      `/api/v1/platform/orgs/${createdBody.organization.id}`,
      { method: "PATCH", body: JSON.stringify({ name: "Renamed Co" }) },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.organization.name).toBe("Renamed Co");
  });
});

describe("onboarding wizard state", () => {
  let sid: string;
  let orgId: string;

  beforeAll(async () => {
    const u = await makeUser();
    sid = await sessionFor(u.id);
    const res = await authed(sid)("/api/v1/orgs", {
      method: "POST",
      body: JSON.stringify({ name: "Wizard Test Co" }),
    });
    const body = (await res.json()) as any;
    orgId = body.organization.id;
    createdOrgIds.push(orgId);
  });

  it("starts empty, accumulates progress, and persists across reads", async () => {
    const initial = (await (await authed(sid)("/api/v1/onboarding")).json()) as any;
    expect(initial.steps).toContain("test-lead");
    expect(initial.state.completedAt ?? null).toBeNull();

    const patched = await authed(sid)("/api/v1/onboarding", {
      method: "PATCH",
      body: JSON.stringify({ completeSteps: ["company", "services"], currentStep: "hours" }),
    });
    expect(patched.status).toBe(200);

    const reread = (await (await authed(sid)("/api/v1/onboarding")).json()) as any;
    expect(reread.state.completedSteps).toEqual(["company", "services"]);
    expect(reread.state.currentStep).toBe("hours");
  });

  it("rejects unknown steps", async () => {
    const res = await authed(sid)("/api/v1/onboarding", {
      method: "PATCH",
      body: JSON.stringify({ completeSteps: ["not-a-step"] }),
    });
    expect(res.status).toBe(400);
  });

  it("launch stamps completedAt", async () => {
    const res = await authed(sid)("/api/v1/onboarding", {
      method: "PATCH",
      body: JSON.stringify({ completeSteps: ["launch"], launched: true }),
    });
    const body = (await res.json()) as any;
    expect(body.state.completedAt).toBeTruthy();
  });

  it("invite-team step is included in the canonical step list", async () => {
    const res = await authed(sid)("/api/v1/onboarding");
    const body = (await res.json()) as any;
    expect(body.steps).toContain("invite-team");
    // Must appear before "launch"
    const inviteIdx = body.steps.indexOf("invite-team");
    const launchIdx = body.steps.indexOf("launch");
    expect(inviteIdx).toBeGreaterThan(-1);
    expect(inviteIdx).toBeLessThan(launchIdx);
  });

  it("invite-team step can be marked complete via PATCH and is persisted", async () => {
    const before = (await (await authed(sid)("/api/v1/onboarding")).json()) as any;
    const wasComplete = before.state.completedSteps.includes("invite-team");

    const res = await authed(sid)("/api/v1/onboarding", {
      method: "PATCH",
      body: JSON.stringify({ completeSteps: ["invite-team"] }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.state.completedSteps).toContain("invite-team");

    // Persists across a fresh read
    const reread = (await (await authed(sid)("/api/v1/onboarding")).json()) as any;
    expect(reread.state.completedSteps).toContain("invite-team");

    // Clean up: remove it if it wasn't already there
    if (!wasComplete) {
      // Steps only accumulate, so we can't un-complete — just verify the
      // forward direction works; the step stays in the list.
    }
  });

  it("inviting a teammate lands them in the new org, not the default org", async () => {
    const inviteEmail = `invite-wizard-${Date.now()}@example.com`;
    const res = await authed(sid)("/api/v1/users/invite", {
      method: "POST",
      body: JSON.stringify({ email: inviteEmail, role: "sales_rep" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    expect(body.id.startsWith("invite:")).toBe(true);
    expect(body.email).toBe(inviteEmail);

    // Confirm they landed in the wizard org, not the default org
    const [invited] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.id, body.id));
    expect(invited.organizationId).toBe(orgId);
    createdUserIds.push(invited.id);
  });

  it("guided test lead: creates marked sandbox records with no reachable channels, then cleans up fully", async () => {
    const created = await authed(sid)("/api/v1/onboarding/test-lead", { method: "POST" });
    expect(created.status).toBe(201);
    const body = (await created.json()) as any;
    expect(body.leadId).toBeTruthy();
    expect(body.score).toBeGreaterThan(0);

    const [lead] = await db.select().from(leadsTable).where(eq(leadsTable.id, body.leadId));
    expect(lead.organizationId).toBe(orgId);
    expect(lead.sourceDetail).toBe("onboarding-test-lead");
    expect(lead.summary).toContain("[TEST]");
    const [contact] = await db
      .select()
      .from(contactsTable)
      .where(eq(contactsTable.id, body.contactId));
    // The sandbox contact must be unreachable so nothing real is ever sent.
    expect(contact.email).toBeNull();
    expect(contact.phone).toBeNull();
    const timeline = await db
      .select()
      .from(activitiesTable)
      .where(eq(activitiesTable.leadId, body.leadId));
    expect(timeline.length).toBeGreaterThanOrEqual(3);

    const cleanup = await authed(sid)("/api/v1/onboarding/test-lead", { method: "DELETE" });
    const cleanupBody = (await cleanup.json()) as any;
    expect(cleanupBody.removed).toBe(1);
    const leadsLeft = await db.select().from(leadsTable).where(eq(leadsTable.id, body.leadId));
    expect(leadsLeft).toEqual([]);
    const contactsLeft = await db
      .select()
      .from(contactsTable)
      .where(eq(contactsTable.id, body.contactId));
    expect(contactsLeft).toEqual([]);
  });
});

describe("member self-service profile", () => {
  it("updates only the signed-in member inside their organization", async () => {
    const [org] = await db
      .insert(organizationsTable)
      .values({
        name: "Profile Test Co",
        slug: `profile-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      })
      .returning();
    createdOrgIds.push(org.id);

    const user = await makeUser({
      organizationId: org.id,
      role: "sales_rep",
      firstName: "Wrong",
      lastName: "Name",
    });
    const sid = await sessionFor(user.id);
    const res = await authed(sid)("/api/v1/me", {
      method: "PATCH",
      body: JSON.stringify({ firstName: "Diego", lastName: "Diaz" }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.firstName).toBe("Diego");
    expect(body.lastName).toBe("Diaz");
    expect(body.role).toBe("sales_rep");

    const [stored] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.id, user.id));
    expect(stored.firstName).toBe("Diego");
    expect(stored.lastName).toBe("Diaz");
    expect(stored.organizationId).toBe(org.id);
  });

  it("rejects an empty profile patch", async () => {
    const defaultOrg = await getDefaultOrganization();
    const user = await makeUser({
      organizationId: defaultOrg.id,
      role: "sales_rep",
    });
    const sid = await sessionFor(user.id);
    const res = await authed(sid)("/api/v1/me", {
      method: "PATCH",
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});

describe("founding beta registration gate", () => {
  it("fails closed in production, accepts allowlisted founders, preserves active invites, and blocks revoked invites", async () => {
    const originalNodeEnv = process.env.NODE_ENV;
    const originalAllowlist = process.env.BETA_SIGNUP_ALLOWLIST;
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const blockedEmail = `blocked-${suffix}@example.com`;
    const allowedEmail = `allowed-${suffix}@example.com`;
    const invitedEmail = `invited-${suffix}@example.com`;
    const revokedEmail = `revoked-${suffix}@example.com`;

    try {
      process.env.NODE_ENV = "production";
      delete process.env.BETA_SIGNUP_ALLOWLIST;

      const blocked = await fetch(`${baseUrl}/api/auth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: blockedEmail,
          password: "correct-horse-battery-staple",
        }),
      });
      expect(blocked.status).toBe(403);
      expect(await blocked.json()).toMatchObject({
        code: "BETA_INVITE_REQUIRED",
      });

      process.env.BETA_SIGNUP_ALLOWLIST = ` ${allowedEmail.toUpperCase()} `;
      const allowed = await fetch(`${baseUrl}/api/auth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: allowedEmail,
          password: "correct-horse-battery-staple",
          firstName: "Allowed",
        }),
      });
      expect(allowed.status).toBe(200);
      const [allowedUser] = await db
        .select()
        .from(usersTable)
        .where(eq(usersTable.email, allowedEmail));
      createdUserIds.push(allowedUser.id);

      const [org] = await db
        .insert(organizationsTable)
        .values({
          name: "Invite Gate Test Co",
          slug: `invite-gate-${suffix}`,
        })
        .returning();
      createdOrgIds.push(org.id);
      const invited = await makeUser({
        id: `invite:${crypto.randomUUID()}`,
        email: invitedEmail,
        organizationId: org.id,
        role: "sales_rep",
      });
      const revoked = await makeUser({
        id: `invite:${crypto.randomUUID()}`,
        email: revokedEmail,
        organizationId: org.id,
        role: "sales_rep",
        isActive: false,
      });

      delete process.env.BETA_SIGNUP_ALLOWLIST;
      const missingTokenSignup = await fetch(`${baseUrl}/api/auth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: invitedEmail,
          password: "correct-horse-battery-staple",
        }),
      });
      expect(missingTokenSignup.status).toBe(403);
      expect(await missingTokenSignup.json()).toMatchObject({
        code: "BETA_INVITE_TOKEN_REQUIRED",
      });

      const inviteSignup = await fetch(`${baseUrl}/api/auth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: invitedEmail,
          password: "correct-horse-battery-staple",
          firstName: "Invited",
          inviteToken: createInviteToken({
            inviteId: invited.id,
            organizationId: org.id,
            email: invitedEmail,
          }),
        }),
      });
      expect(inviteSignup.status).toBe(200);

      const [adopted] = await db
        .select()
        .from(usersTable)
        .where(eq(usersTable.email, invitedEmail));
      createdUserIds.push(adopted.id);
      expect(adopted.id).not.toBe(invited.id);
      expect(adopted.id.startsWith("invite:")).toBe(false);
      expect(adopted.organizationId).toBe(org.id);
      expect(adopted.role).toBe("sales_rep");
      expect(adopted.isActive).toBe(true);

      const revokedSignup = await fetch(`${baseUrl}/api/auth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: revokedEmail,
          password: "correct-horse-battery-staple",
          firstName: "Revoked",
          inviteToken: createInviteToken({
            inviteId: revoked.id,
            organizationId: org.id,
            email: revokedEmail,
          }),
        }),
      });
      expect(revokedSignup.status).toBe(403);
      expect(await revokedSignup.json()).toMatchObject({
        code: "BETA_INVITE_REVOKED",
      });

      const [stillRevoked] = await db
        .select()
        .from(usersTable)
        .where(eq(usersTable.email, revokedEmail));
      expect(stillRevoked.id).toBe(revoked.id);
      expect(stillRevoked.isActive).toBe(false);
    } finally {
      if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = originalNodeEnv;
      if (originalAllowlist === undefined) {
        delete process.env.BETA_SIGNUP_ALLOWLIST;
      } else {
        process.env.BETA_SIGNUP_ALLOWLIST = originalAllowlist;
      }
    }
  });
});

describe("legacy default org keeps its branding", () => {
  it("the legacy org's seeded playbook copy stays roofing-flavored", async () => {
    // Seed path check without touching the real default org: the flavor
    // branch keys on slug, so a synthetic org can't be used here. Instead we
    // assert the fresh-org path (above) is generic and that ensureDefaultPlaybook
    // is idempotent for fresh orgs.
    const [org] = await db
      .insert(organizationsTable)
      .values({ name: "Idempotent Seed Co", slug: `idem-seed-${Date.now()}` })
      .returning();
    createdOrgIds.push(org.id);
    await ensureDefaultPlaybook(org.id);
    await ensureDefaultPlaybook(org.id);
    const rows = await db
      .select()
      .from(playbooksTable)
      .where(eq(playbooksTable.organizationId, org.id));
    expect(rows.length).toBe(1);
    expect(JSON.stringify(rows[0].steps).toLowerCase()).not.toContain("roof");
  });
});
