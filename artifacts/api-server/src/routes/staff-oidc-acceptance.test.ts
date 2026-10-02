import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { db, organizationsTable, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";

const oidc = vi.hoisted(() => ({ claims: {} as Record<string, unknown> }));
vi.mock("openid-client", async (original) => ({
  ...(await original<typeof import("openid-client")>()),
  authorizationCodeGrant: vi.fn(async () => ({
    claims: () => oidc.claims,
    expiresIn: () => 3600,
    access_token: "synthetic-oidc-token",
  })),
}));
vi.mock("../lib/auth", async (original) => ({
  ...(await original<typeof import("../lib/auth")>()),
  getOidcConfig: vi.fn(async () => ({})),
}));
import app from "../app";

let server: Server, base: string, org: string;
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
  [org] = (
    await db
      .insert(organizationsTable)
      .values({
        name: "Synthetic OIDC staff",
        slug: `oidc-staff-${randomUUID()}`,
      })
      .returning()
  ).map((o) => o.id);
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  if (server)
    await new Promise<void>((resolve) => server.close(() => resolve()));
  if (org) await deleteTestOrgs(org);
});
const callback = () =>
  fetch(`${base}/api/callback?code=synthetic&state=synthetic`, {
    redirect: "manual",
    headers: {
      cookie: "code_verifier=synthetic;state=synthetic;nonce=synthetic",
    },
  });
const read = async (id: string) =>
  (await db.select().from(usersTable).where(eq(usersTable.id, id)))[0];

it("keeps an unverified OIDC mailbox unverified until a true claim is received", async () => {
  const [user] = await db
    .insert(usersTable)
    .values({
      organizationId: org,
      email: `unverified-${randomUUID()}@example.invalid`,
      emailVerifiedAt: null,
    })
    .returning();
  for (const email_verified of [undefined, false, "true"]) {
    oidc.claims = { sub: user.id, email: user.email, email_verified };
    expect((await callback()).status).toBe(302);
    expect((await read(user.id)).emailVerifiedAt).toBeNull();
  }
  oidc.claims = { sub: user.id, email: user.email, email_verified: true };
  expect((await callback()).status).toBe(302);
  expect((await read(user.id)).emailVerifiedAt).toBeTruthy();
});

it("preserves accepted legacy mailbox evidence but never transfers it to a changed mailbox", async () => {
  const [user] = await db
    .insert(usersTable)
    .values({
      organizationId: org,
      email: `legacy-${randomUUID()}@example.invalid`,
    })
    .returning();
  oidc.claims = { sub: user.id, email: user.email };
  expect((await callback()).status).toBe(302);
  expect((await read(user.id)).emailVerifiedAt).toEqual(user.emailVerifiedAt);
  oidc.claims = {
    sub: user.id,
    email: `changed-${randomUUID()}@example.invalid`,
    email_verified: false,
  };
  expect((await callback()).status).toBe(302);
  expect(await read(user.id)).toMatchObject({
    organizationId: org,
    role: user.role,
    isActive: true,
    emailVerifiedAt: null,
  });
});

it("denies invitation adoption without verified mailbox claims and accepts verified identity into its invited tenant", async () => {
  const [pending] = await db
    .insert(usersTable)
    .values({
      id: `invite:${randomUUID()}`,
      email: `invited-${randomUUID()}@example.invalid`,
      organizationId: org,
      role: "office",
      emailVerifiedAt: null,
    })
    .returning();
  const subject = randomUUID();
  for (const email_verified of [undefined, false]) {
    oidc.claims = { sub: subject, email: pending.email, email_verified };
    const response = await callback();
    expect(response.status).toBe(403);
    expect(response.headers.get("set-cookie") ?? "").not.toMatch(
      /(?:^|,\s*)sid=/,
    );
    expect((await read(pending.id)).emailVerifiedAt).toBeNull();
    expect(await read(subject)).toBeUndefined();
  }
  const [existingIdentity] = await db
    .insert(usersTable)
    .values({
      organizationId: org,
      email: `existing-${randomUUID()}@example.invalid`,
      role: "viewer",
    })
    .returning();
  oidc.claims = {
    sub: existingIdentity.id,
    email: pending.email,
    email_verified: true,
  };
  expect((await callback()).status).toBe(403);
  expect(await read(existingIdentity.id)).toEqual(existingIdentity);
  expect(await read(pending.id)).toBeTruthy();
  oidc.claims = { sub: subject, email: pending.email, email_verified: true };
  expect((await callback()).status).toBe(302);
  expect(await read(pending.id)).toBeUndefined();
  expect(await read(subject)).toMatchObject({
    organizationId: org,
    role: "office",
    isActive: true,
  });
});
