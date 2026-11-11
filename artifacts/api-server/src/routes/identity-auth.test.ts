import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";

import {
  db,
  organizationsTable,
  sessionsTable,
  usersTable,
} from "@workspace/db";
import { eq, sql } from "drizzle-orm";
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

import app from "../app";
import { createSession } from "../lib/auth";
import { hashPassword } from "../lib/password";
import { resendEmailProvider } from "../services/providers";
import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";

let server: Server;
let baseUrl: string;
let organizationId: string;
let userId: string;
let email: string;

beforeAll(() => {
  server = app.listen(0);
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

beforeEach(async () => {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("APP_ORIGIN", "https://app.mogulforge.test");
  vi.stubEnv("RESEND_API_KEY", "test-resend-key");
  vi.stubEnv("RESEND_FROM_EMAIL", "MogulForge <account@mogulforge.ai>");
  vi.stubEnv("PLATFORM_EMAIL_DELIVERY_CONTEXT", "synthetic-identity-http");

  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  email = `identity-auth-${suffix}@example.com`;
  const [organization] = await db
    .insert(organizationsTable)
    .values({ name: "Identity Auth Test", slug: `identity-auth-${suffix}` })
    .returning();
  organizationId = organization.id;
  const [user] = await db
    .insert(usersTable)
    .values({
      email,
      passwordHash: await hashPassword("old-password-123"),
      emailVerifiedAt: new Date(),
      organizationId,
      role: "owner",
    })
    .returning();
  userId = user.id;
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await new Promise((resolve) => setTimeout(resolve, 0));
  if (userId) {
    await db
      .delete(sessionsTable)
      .where(sql`${sessionsTable.sess} -> 'user' ->> 'id' = ${userId}`);
  }
  await deleteTestOrgs(organizationId);
});

afterAll(() => {
  server?.close();
});

describe("password recovery", () => {
  it("is enumeration-safe, rotates the password, consumes the token, and revokes sessions", async () => {
    const send = vi
      .spyOn(resendEmailProvider, "send")
      .mockResolvedValue({ id: randomUUID(), provider: "resend" });

    const unknown = await fetch(`${baseUrl}/api/auth/forgot-password`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: `unknown-${email}` }),
    });
    const unknownBody = await unknown.json();
    expect(unknown.status).toBe(202);
    expect(send).not.toHaveBeenCalled();

    const known = await fetch(`${baseUrl}/api/auth/forgot-password`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email }),
    });
    const knownBody = await known.json();
    expect(known.status).toBe(202);
    expect(knownBody).toEqual(unknownBody);
    expect(send).toHaveBeenCalledOnce();

    const resetUrl = send.mock.calls[0][2]
      .split("\n")
      .find((line) => line.startsWith("https://"));
    expect(resetUrl).toBeTruthy();
    const token = new URL(resetUrl!).searchParams.get("token");
    expect(token).toBeTruthy();

    const sid = await createSession({
      user: {
        id: userId,
        email,
        firstName: null,
        lastName: null,
        profileImageUrl: null,
      },
      access_token: "identity-auth-test",
    });
    expect(
      await db.select().from(sessionsTable).where(eq(sessionsTable.sid, sid)),
    ).toHaveLength(1);

    const reset = await fetch(`${baseUrl}/api/auth/reset-password`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, password: "new-password-456" }),
    });
    expect(reset.status).toBe(200);
    expect(
      await db.select().from(sessionsTable).where(eq(sessionsTable.sid, sid)),
    ).toHaveLength(0);

    const replay = await fetch(`${baseUrl}/api/auth/reset-password`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, password: "another-password-789" }),
    });
    expect(replay.status).toBe(400);

    const oldLogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "old-password-123" }),
    });
    expect(oldLogin.status).toBe(401);

    const newLogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "new-password-456" }),
    });
    expect(newLogin.status).toBe(200);
    expect(newLogin.headers.get("set-cookie")).toContain("sid=");
  });
});

describe('staff email verification', () => {
  it('lets an active identity-provider account verify without a local password and consumes the link once', async () => {
    await db.update(usersTable).set({ passwordHash: null, emailVerifiedAt: null }).where(eq(usersTable.id, userId));
    const send = vi.spyOn(resendEmailProvider, 'send').mockResolvedValue({ id: randomUUID(), provider: 'resend' });
    const request = await fetch(`${baseUrl}/api/auth/resend-verification`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email }),
    });
    expect(request.status).toBe(202);
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0][0]).toBe(email);
    const url = send.mock.calls[0][2].split('\n').find(line => line.startsWith('https://'));
    const token = new URL(url!).searchParams.get('token');
    expect(token).toBeTruthy();
    const verify = () => fetch(`${baseUrl}/api/auth/verify-email`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }),
    });
    const confirmed = await verify();
    expect(confirmed.status).toBe(200);
    const cookie = confirmed.headers.get('set-cookie')!.split(';')[0];
    const profile = await fetch(`${baseUrl}/api/v1/me`, { headers: { cookie } });
    expect(profile.status).toBe(200);
    expect(await profile.json()).toMatchObject({ id: userId, emailVerified: true });
    expect((await verify()).status).toBe(400);
  });
});
