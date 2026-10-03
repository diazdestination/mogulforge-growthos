import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  auditEventsTable,
  db,
  organizationsTable,
  rateLimitCountersTable,
  staffInvitationsTable,
  usersTable,
} from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import app from "../../app";
import { createSession } from "../../lib/auth";
import { deleteTestOrgs } from "../../test-helpers/delete-test-orgs";
import { transactionalEmailProvider } from "../../services/providers";
import {
  acceptPendingStaffInvitation,
  createStaffInvitation,
  updateStaffInvitation,
} from "../../services/staff-invitations";
import * as settings from "../../services/settings";
import {
  createInviteToken,
  verifyInviteToken,
} from "../../services/invite-token";
import { crmAppUrl } from "../../services/invite-email";
import { clientReadiness } from "../../services/client-onboarding";

let server: Server,
  base: string,
  operatorOrg: string,
  clientOrg: string,
  foreignOrg: string;
let platformId: string,
  platformSid: string,
  ownerSid: string,
  adminSid: string,
  viewerSid: string,
  inactiveSid: string;
const mail: Array<{ to: string; body: string }> = [];
const email = () => `staff-${randomUUID()}@example.invalid`;
const session = async (
  organizationId: string,
  role: "owner" | "admin" | "viewer",
  platform = false,
  active = true,
) => {
  const [user] = await db
    .insert(usersTable)
    .values({
      organizationId,
      role,
      email: email(),
      isPlatformAdmin: platform,
      isActive: active,
    })
    .returning();
  const sid = await createSession({
    user: {
      id: user.id,
      email: user.email,
      firstName: null,
      lastName: null,
      profileImageUrl: null,
    },
    access_token: "synthetic-session",
  });
  return { sid, user };
};
const request = (
  sid: string,
  path: string,
  body?: unknown,
  method = body ? "POST" : "GET",
  headers: Record<string, string> = {},
) =>
  fetch(`${base}/api${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      cookie: `sid=${sid}`,
      ...headers,
    },
    ...(body === undefined
      ? {}
      : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
const path = (org = clientOrg) => `/v1/platform/clients/${org}/invitations`;
const fixture = () => ({
  requestId: randomUUID(),
  email: email(),
  role: "owner",
  confirmed: true,
});
type Invitation = {
  id: string;
  email: string;
  version: number;
  state: string;
  deliveryState: string;
  expiresAt: string;
};
const create = async (
  input = fixture(),
  org = clientOrg,
  expectedDelivery: "sent" | "unconfirmed" = "sent",
) => {
  const response = await request(platformSid, path(org), input);
  expect([200, 201], await response.clone().text()).toContain(response.status);
  const result = (await response.json()) as {
    invitation: Invitation;
    duplicate: boolean;
  };
  expect(result.invitation.deliveryState).toBe(expectedDelivery);
  return result;
};
const token = (to: string) => {
  const accepted = mail.filter((m) => m.to === to).at(-1);
  if (!accepted)
    throw new Error(
      "Synthetic sender did not accept an email for this recipient",
    );
  expect(transactionalEmailProvider.send).toHaveBeenCalledWith(
    to,
    expect.any(String),
    accepted.body,
  );
  const links = accepted.body.split(/\r?\n/).flatMap((line) => {
    try {
      const url = new URL(line.trim());
      return ["http:", "https:"].includes(url.protocol) &&
        url.searchParams.has("invite")
        ? [url]
        : [];
    } catch {
      return [];
    }
  });
  expect(
    links,
    "Email must contain exactly one absolute invitation URL",
  ).toHaveLength(1);
  const url = links[0];
  const expected = new URL("signup", `${crmAppUrl().replace(/\/$/, "")}/`);
  expect(url.origin).toBe(expected.origin);
  expect(url.pathname).toBe(expected.pathname);
  expect(url.searchParams.get("email")).toBe(to.trim().toLowerCase());
  const signed = url.searchParams.get("invite");
  expect(
    signed,
    "Delivered invitation must contain the signed token",
  ).toBeTruthy();
  return signed!;
};
const ledger = async (id: string) =>
  (
    await db
      .select()
      .from(staffInvitationsTable)
      .where(eq(staffInvitationsTable.id, id))
  )[0];
const action = (
  invitation: Invitation,
  kind: "revoke" | "reissue",
  org = clientOrg,
  sid = platformSid,
) =>
  request(sid, `${path(org)}/${invitation.id}/${kind}`, {
    expectedVersion: invitation.version,
    confirmed: true,
  });
const cool = (id: string) =>
  db
    .update(staffInvitationsTable)
    .set({ deliveryAttemptedAt: new Date(Date.now() - 61_000) })
    .where(eq(staffInvitationsTable.id, id));

beforeAll(async () => {
  const target = new URL(process.env.DATABASE_URL ?? "");
  if (
    process.env.NODE_ENV !== "test" ||
    !(
      target.pathname.endsWith("_test") ||
      (process.env.SCHEDULER_TEST_BACKEND === "pglite" &&
        target.pathname === "/postgres" &&
        ["127.0.0.1", "localhost"].includes(target.hostname))
    )
  )
    throw new Error("Use an isolated _test database");
  const orgs = await db
    .insert(organizationsTable)
    .values(
      ["Operator", "Client", "Foreign"].map((name) => ({
        name,
        slug: `staff-test-${randomUUID()}`,
      })),
    )
    .returning();
  [operatorOrg, clientOrg, foreignOrg] = orgs.map((o) => o.id);
  const platform = await session(operatorOrg, "owner", true);
  platformId = platform.user.id;
  platformSid = platform.sid;
  ownerSid = (await session(operatorOrg, "owner")).sid;
  adminSid = (await session(operatorOrg, "admin")).sid;
  viewerSid = (await session(operatorOrg, "viewer")).sid;
  inactiveSid = (await session(operatorOrg, "owner", true, false)).sid;
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
beforeEach(async () => {
  // CI supplies no APP_URL/APP_ORIGIN; vitest.config defaults to this local HTTP
  // origin. Keep that baseline explicit even in the HTTPS isolated runner.
  vi.stubEnv("APP_URL", "");
  vi.stubEnv("APP_ORIGIN", "http://localhost:3001");
  vi.stubEnv("REPLIT_DOMAINS", "");
  vi.stubEnv("RESEND_API_KEY", "synthetic-no-network");
  vi.stubEnv("RESEND_FROM_EMAIL", "account@platform.example");
  vi.stubEnv("PLATFORM_EMAIL_DELIVERY_CONTEXT", "synthetic-staff-http");
  mail.length = 0;
  vi.spyOn(transactionalEmailProvider, "send").mockImplementation(
    async (to, _subject, body) => {
      mail.push({ to, body });
      return { id: randomUUID(), provider: "resend" };
    },
  );
  // Each case owns only its synthetic loopback/process abuse counters.
  await db
    .delete(rateLimitCountersTable)
    .where(
      and(
        sql`${rateLimitCountersTable.key} like ${`%:test-${process.pid}`}`,
        sql`${rateLimitCountersTable.key} like 'client-staff-invitations:%'`,
      ),
    );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
afterAll(async () => {
  if (server)
    await new Promise<void>((resolve) => server.close(() => resolve()));
  if (operatorOrg) await deleteTestOrgs(clientOrg, foreignOrg, operatorOrg);
});

describe("staff invitations through normal authenticated HTTP", () => {
  it.each(["http://localhost:3001", "https://app.example.invalid/crm"])(
    "validates the delivered signed invitation using configured base %s",
    async (appBase) => {
      vi.stubEnv("APP_URL", appBase);
      const input = fixture();
      const created = await create(input);
      const row = await ledger(created.invitation.id);
      const deliveredToken = token(input.email);
      expect(transactionalEmailProvider.send).toHaveBeenCalledTimes(1);
      expect(mail).toHaveLength(1);
      expect(mail[0].body).toContain(`${appBase}/signup?`);
      expect(row.deliveryState).toBe("sent");
      expect(
        verifyInviteToken(deliveredToken, {
          inviteId: row.pendingUserId,
          organizationId: row.organizationId,
          email: row.email,
          tokenRevision: row.tokenRevision,
        }),
      ).toBe(true);
      expect(
        verifyInviteToken(deliveredToken, {
          inviteId: row.pendingUserId,
          organizationId: foreignOrg,
          email: row.email,
          tokenRevision: row.tokenRevision,
        }),
      ).toBe(false);
    },
  );

  it("does not start a provider send when preparation finishes after the durable delivery deadline", async () => {
    const configured = await settings.getOrgSettings(clientOrg);
    let prepared!: () => void, finish!: (value: typeof configured) => void;
    const entered = new Promise<void>((resolve) => {
      prepared = resolve;
    });
    vi.spyOn(settings, "getOrgSettings").mockImplementationOnce(() => {
      prepared();
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    try {
      const pending = createStaffInvitation(
        { userId: platformId, scope: "platform" },
        clientOrg,
        { requestId: randomUUID(), email: email(), role: "office" },
      );
      await entered;
      await vi.advanceTimersByTimeAsync(15_001);
      const result = await pending;
      expect(result.invitation.deliveryState).toBe("unconfirmed");
      finish(configured);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(transactionalEmailProvider.send).not.toHaveBeenCalled();
    } finally {
      finish?.(configured);
      vi.useRealTimers();
    }
  });

  it("rechecks revocation immediately before dispatch after asynchronous preparation", async () => {
    const configured = await settings.getOrgSettings(clientOrg);
    let prepared!: () => void, finish!: (value: typeof configured) => void;
    const entered = new Promise<void>((resolve) => {
      prepared = resolve;
    });
    vi.spyOn(settings, "getOrgSettings").mockImplementationOnce(() => {
      prepared();
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    const input = {
      requestId: randomUUID(),
      email: email(),
      role: "office" as const,
    };
    const pending = createStaffInvitation(
      { userId: platformId, scope: "platform" },
      clientOrg,
      input,
    );
    await entered;
    try {
      const [row] = await db
        .select()
        .from(staffInvitationsTable)
        .where(eq(staffInvitationsTable.requestId, input.requestId));
      await updateStaffInvitation(
        { userId: platformId, scope: "platform" },
        clientOrg,
        row.id,
        { action: "revoke", expectedVersion: row.version, confirmed: true },
      );
    } finally {
      finish(configured);
    }
    expect((await pending).invitation.state).toBe("revoked");
    expect(transactionalEmailProvider.send).not.toHaveBeenCalled();
  });
  it.skipIf(process.env.SCHEDULER_TEST_BACKEND === "pglite")(
    "serializes one request ID with competing mailbox payloads without an orphan member",
    async () => {
      const first = fixture(),
        second = { ...first, email: email() };
      const results = await Promise.all([
        request(platformSid, path(), first),
        request(platformSid, path(), second),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
      expect(await results.find((r) => r.status === 409)!.json()).toEqual({
        error: "invitation_request_changed",
      });
      const rows = await db
        .select()
        .from(staffInvitationsTable)
        .where(
          and(
            eq(staffInvitationsTable.organizationId, clientOrg),
            eq(staffInvitationsTable.requestId, first.requestId),
          ),
        );
      expect(rows).toHaveLength(1);
      expect(mail).toHaveLength(1);
      const members = await db
        .select()
        .from(usersTable)
        .where(sql`${usersTable.email} in (${first.email}, ${second.email})`);
      expect(members).toHaveLength(1);
      expect(members[0].id).toBe(rows[0].pendingUserId);
    },
  );
  it("requires active platform authority, same origin, JSON and explicit confirmation", async () => {
    for (const sid of ["", ownerSid, viewerSid, inactiveSid]) {
      expect([401, 403]).toContain(
        (await request(sid, path(), fixture())).status,
      );
      expect([401, 403]).toContain((await request(sid, path())).status);
    }
    expect(
      (
        await request(platformSid, path(), fixture(), "POST", {
          "x-api-key": "not-authorized",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(platformSid, path(), fixture(), "POST", {
          Origin: "https://attacker.invalid",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(platformSid, path(), JSON.stringify(fixture()), "POST", {
          "Content-Type": "text/plain",
        })
      ).status,
    ).toBe(415);
    expect(
      (await request(platformSid, path(), { ...fixture(), confirmed: false }))
        .status,
    ).toBe(400);
    expect(mail).toHaveLength(0);
  });

  it("creates first-owner access without impersonation; pending staff never make capture ready", async () => {
    const input = fixture(),
      created = await create(input),
      repeated = await create(input);
    expect(repeated.duplicate).toBe(true);
    expect(repeated.invitation.id).toBe(created.invitation.id);
    expect(mail).toHaveLength(1);
    expect((await create(input)).duplicate).toBe(true);
    expect(
      (await request(platformSid, path(), { ...input, role: "viewer" })).status,
    ).toBe(409);
    const [operator] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.id, platformId));
    expect(operator.organizationId).toBe(operatorOrg);
    expect((await clientReadiness(clientOrg)).staffing).toEqual({
      activeManagers: 0,
      activeResponders: 0,
    });
    const row = await ledger(created.invitation.id);
    expect(row.pendingUserId).toMatch(/^invite:/);
    expect(row.state).toBe("pending");
    const list = await request(platformSid, path());
    const wire = await list.text();
    expect(wire).not.toContain(row.tokenRevision);
    expect(wire).not.toContain(row.payloadHash);
    expect(wire).not.toContain(token(input.email));
    const audit = await db
      .select()
      .from(auditEventsTable)
      .where(eq(auditEventsTable.entityId, row.id));
    expect(audit.map((a) => a.action)).toEqual(
      expect.arrayContaining([
        "staff_invitation.created",
        "staff_invitation.email_accepted",
      ]),
    );
    expect(JSON.stringify(audit)).not.toContain(token(input.email));
  });

  it("accepts the signed invitation into its exact organization and keeps other memberships unchanged", async () => {
    const input = fixture(),
      { invitation } = await create(input, foreignOrg);
    const response = await request("", "/auth/register", {
      email: input.email,
      password: "Synthetic-testing-only-49!",
      inviteToken: token(input.email),
    });
    expect(response.status, await response.clone().text()).toBe(200);
    const [accepted] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.email, input.email));
    expect(accepted.id).not.toMatch(/^invite:/);
    expect(accepted.organizationId).toBe(foreignOrg);
    expect(accepted.role).toBe("owner");
    expect(accepted.emailVerifiedAt).toBeTruthy();
    expect(await ledger(invitation.id)).toMatchObject({
      state: "accepted",
      acceptedUserId: accepted.id,
    });
    expect((await clientReadiness(foreignOrg)).staffing).toEqual({
      activeManagers: 1,
      activeResponders: 1,
    });
    expect((await action(invitation, "revoke", foreignOrg)).status).toBe(409);
    expect(
      (
        await request("", "/auth/register", {
          email: input.email,
          password: "Synthetic-testing-only-49!",
          inviteToken: token(input.email),
        })
      ).status,
    ).toBe(409);
    expect(mail).toHaveLength(1);
  });

  it("keeps ordinary admin invitations tenant bound and prevents owner grants by admins", async () => {
    const target = email(),
      idempotency = randomUUID();
    expect(
      (
        await request(adminSid, "/v1/users/invite", {
          email: target,
          role: "owner",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(viewerSid, "/v1/users/invite", {
          email: target,
          role: "office",
        })
      ).status,
    ).toBe(403);
    const response = await request(
      adminSid,
      "/v1/users/invite",
      { email: target, role: "office", organizationId: foreignOrg },
      "POST",
      { "Idempotency-Key": idempotency },
    );
    expect(response.status, await response.clone().text()).toBe(201);
    const [pending] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.email, target));
    expect(pending.organizationId).toBe(operatorOrg);
    expect(
      (
        await request(
          adminSid,
          "/v1/users/invite",
          { email: target, role: "office" },
          "POST",
          { "Idempotency-Key": idempotency },
        )
      ).status,
    ).toBe(200);
    expect(mail).toHaveLength(1);
    expect(
      (
        await request(
          adminSid,
          `/v1/users/${encodeURIComponent(pending.id)}`,
          { isActive: false },
          "PATCH",
          { Origin: "https://attacker.invalid" },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await request(
          adminSid,
          `/v1/users/${encodeURIComponent(pending.id)}`,
          { isActive: false },
          "PATCH",
        )
      ).status,
    ).toBe(200);
    await cool(
      (
        await db
          .select()
          .from(staffInvitationsTable)
          .where(eq(staffInvitationsTable.pendingUserId, pending.id))
      )[0].id,
    );
    expect(
      (
        await request(
          adminSid,
          `/v1/users/${encodeURIComponent(pending.id)}/resend-invite`,
          {},
        )
      ).status,
    ).toBe(200);
    expect(mail).toHaveLength(2);
  });

  it("denies foreign invitation IDs without state or delivery effects", async () => {
    const { invitation } = await create();
    const before = await ledger(invitation.id);
    expect((await action(invitation, "revoke", foreignOrg)).status).toBe(404);
    expect((await action(invitation, "reissue", foreignOrg)).status).toBe(404);
    expect(
      (
        await request(
          adminSid,
          `/v1/users/${encodeURIComponent(before.pendingUserId)}/resend-invite`,
          {},
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await request(
          adminSid,
          `/v1/users/${encodeURIComponent(before.pendingUserId)}`,
          { isActive: false },
          "PATCH",
        )
      ).status,
    ).toBe(404);
    expect(await ledger(invitation.id)).toEqual(before);
    expect(mail).toHaveLength(1);
  });

  it("revoke blocks both password and trusted OIDC; explicit reissue rotates the link", async () => {
    const input = fixture(),
      { invitation } = await create(input),
      oldToken = token(input.email),
      row = await ledger(invitation.id);
    const revokedResponse = await action(invitation, "revoke");
    expect(revokedResponse.status).toBe(200);
    const revoked = (await revokedResponse.json()) as Invitation;
    expect(
      (
        await request("", "/auth/register", {
          email: input.email,
          password: "Synthetic-testing-only-49!",
          inviteToken: oldToken,
        })
      ).status,
    ).toBe(403);
    await expect(
      acceptPendingStaffInvitation({
        pendingUserId: row.pendingUserId,
        email: row.email,
        newUserId: randomUUID(),
        trustedOidc: true,
      }),
    ).rejects.toMatchObject({ code: "invitation_inactive" });
    expect((await action(invitation, "reissue")).status).toBe(409);
    expect((await action(revoked, "reissue")).status).toBe(429);
    await cool(invitation.id);
    const reissued = await action(revoked, "reissue");
    expect(reissued.status).toBe(200);
    await expect(
      acceptPendingStaffInvitation({
        pendingUserId: row.pendingUserId,
        email: row.email,
        newUserId: randomUUID(),
        token: oldToken,
      }),
    ).rejects.toMatchObject({ code: "invitation_invalid_or_expired" });
    const accepted = await acceptPendingStaffInvitation({
      pendingUserId: row.pendingUserId,
      email: row.email,
      newUserId: randomUUID(),
      token: token(input.email),
    });
    expect(accepted.organizationId).toBe(clientOrg);
    expect(mail).toHaveLength(2);
  });

  it("expired ledger blocks otherwise valid links and OIDC until deliberate reissue", async () => {
    const input = fixture(),
      { invitation } = await create(input),
      row = await ledger(invitation.id);
    await db
      .update(staffInvitationsTable)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(staffInvitationsTable.id, row.id));
    for (const credentials of [
      { token: token(input.email) },
      { trustedOidc: true },
    ]) {
      await expect(
        acceptPendingStaffInvitation({
          pendingUserId: row.pendingUserId,
          email: row.email,
          newUserId: randomUUID(),
          ...credentials,
        }),
      ).rejects.toMatchObject({ code: "invitation_inactive" });
    }
    const list = (await (await request(platformSid, path())).json()) as {
      invitations: Invitation[];
    };
    expect(list.invitations.find((i) => i.id === row.id)?.state).toBe(
      "expired",
    );
    expect((await ledger(row.id)).state).toBe("pending");
    expect(mail).toHaveLength(1);
  });

  it("preserves uncertain delivery without leaking provider data or silently retrying", async () => {
    vi.mocked(transactionalEmailProvider.send).mockRejectedValueOnce(
      new Error("provider-secret-CANARY-2847"),
    );
    const input = fixture(),
      created = await create(input, clientOrg, "unconfirmed");
    expect(created.invitation.deliveryState).toBe("unconfirmed");
    const repeated = await create(input, clientOrg, "unconfirmed");
    expect(repeated.duplicate).toBe(true);
    expect(transactionalEmailProvider.send).toHaveBeenCalledTimes(1);
    const audit = await db
      .select()
      .from(auditEventsTable)
      .where(eq(auditEventsTable.entityId, created.invitation.id));
    expect(JSON.stringify([created, repeated, audit])).not.toMatch(
      /provider-secret|CANARY-2847/,
    );
    expect(
      audit.some((a) => a.action === "staff_invitation.email_unconfirmed"),
    ).toBe(true);
  });

  it("never moves or promotes an existing account, and refuses changed invitation role", async () => {
    const active = (await session(foreignOrg, "viewer")).user;
    expect(
      (
        await request(platformSid, path(), {
          ...fixture(),
          email: active.email,
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await request(platformSid, path(foreignOrg), {
          ...fixture(),
          email: active.email,
        })
      ).status,
    ).toBe(409);
    const [unchanged] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.id, active.id));
    expect(unchanged).toEqual(active);
    const own = await request(ownerSid, "/v1/users/invite", {
      email: email(),
      role: "office",
    });
    expect(own.status).toBe(201);
    const pending = (await own.json()) as { id: string };
    expect(
      (
        await request(
          ownerSid,
          `/v1/users/${encodeURIComponent(pending.id)}`,
          { role: "owner" },
          "PATCH",
        )
      ).status,
    ).toBe(409);
    expect(mail).toHaveLength(1);
  });

  it("accepts verified OIDC and legacy signed links without reactivating revoked legacy records", async () => {
    const modern = await create(),
      modernRow = await ledger(modern.invitation.id);
    for (const oidcEmailVerified of [undefined, false]) {
      await expect(
        acceptPendingStaffInvitation({
          pendingUserId: modernRow.pendingUserId,
          email: modernRow.email,
          newUserId: randomUUID(),
          trustedOidc: true,
          oidcEmailVerified,
        }),
      ).rejects.toMatchObject({ code: "invitation_mailbox_unverified" });
    }
    const oidc = await acceptPendingStaffInvitation({
      pendingUserId: modernRow.pendingUserId,
      email: modernRow.email,
      newUserId: randomUUID(),
      trustedOidc: true,
      oidcEmailVerified: true,
    });
    expect(oidc.organizationId).toBe(clientOrg);
    expect((await ledger(modernRow.id)).state).toBe("accepted");
    const [legacy] = await db
      .insert(usersTable)
      .values({
        id: `invite:${randomUUID()}`,
        organizationId: clientOrg,
        email: email(),
        role: "office",
        emailVerifiedAt: null,
      })
      .returning();
    const accepted = await acceptPendingStaffInvitation({
      pendingUserId: legacy.id,
      email: legacy.email!,
      newUserId: randomUUID(),
      token: createInviteToken({
        inviteId: legacy.id,
        organizationId: clientOrg,
        email: legacy.email!,
      }),
    });
    expect(accepted.role).toBe("office");
    expect(accepted.emailVerifiedAt).toBeTruthy();
    const [revoked] = await db
      .insert(usersTable)
      .values({
        id: `invite:${randomUUID()}`,
        organizationId: clientOrg,
        email: email(),
        role: "office",
        isActive: false,
      })
      .returning();
    await expect(
      acceptPendingStaffInvitation({
        pendingUserId: revoked.id,
        email: revoked.email!,
        newUserId: randomUUID(),
        trustedOidc: true,
      }),
    ).rejects.toMatchObject({ code: "invitation_inactive" });
  });
});
