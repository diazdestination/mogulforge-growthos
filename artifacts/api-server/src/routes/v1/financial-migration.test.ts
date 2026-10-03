import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  contactsTable,
  db,
  leadsTable,
  organizationsTable,
  usersTable,
} from "@workspace/db";
import app from "../../app";
import { createSession } from "../../lib/auth";
import { deleteTestOrgs } from "../../test-helpers/delete-test-orgs";
import { financialSourceFixture } from "../../test-helpers/financial-migration-fixture";
import * as apiKeys from "../../services/api-keys";

let server: Server, base: string;
const orgs: string[] = [];
async function fixture(
  role: "owner" | "admin" | "office" | "sales_manager" | "viewer" = "owner",
) {
  const [org] = await db
    .insert(organizationsTable)
    .values({
      name: "Synthetic financial HTTP",
      slug: `financial-http-${randomUUID()}`,
    })
    .returning();
  orgs.push(org!.id);
  const [actor] = await db
    .insert(usersTable)
    .values({
      organizationId: org!.id,
      role,
      email: `financial-${randomUUID()}@example.invalid`,
      emailVerifiedAt: new Date(),
      isActive: true,
    })
    .returning();
  const [contact] = await db
    .insert(contactsTable)
    .values({ organizationId: org!.id, firstName: "Synthetic" })
    .returning();
  const [lead] = await db
    .insert(leadsTable)
    .values({ organizationId: org!.id, contactId: contact!.id })
    .returning();
  const sid = await createSession({
    user: {
      id: actor!.id,
      email: actor!.email,
      firstName: null,
      lastName: null,
      profileImageUrl: null,
    },
    access_token: "synthetic-financial-session",
  });
  return { org: org!.id, sid, source: financialSourceFixture(lead!.id) };
}
function request(
  sid: string,
  path = "",
  body?: unknown,
  headers: Record<string, string> = {},
) {
  return fetch(`${base}/api/v1/financial-migrations${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: process.env.APP_ORIGIN!,
      ...(sid ? { Cookie: `sid=${sid}` } : {}),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
beforeAll(async () => {
  const target = new URL(process.env.DATABASE_URL ?? "");
  if (
    process.env.NODE_ENV !== "test" ||
    !["localhost", "127.0.0.1"].includes(target.hostname) ||
    !(
      target.pathname.endsWith("_test") ||
      (process.env.SCHEDULER_TEST_BACKEND === "pglite" &&
        target.pathname === "/postgres")
    )
  )
    throw Error("Use the isolated test runner");
  server = await new Promise<Server>((resolve) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
afterAll(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await deleteTestOrgs(...orgs);
});
describe("financial migration HTTP approvals", () => {
  it.each(["http://localhost:3001", "https://growth.example"])(
    "imports only an exact owner review at configured origin %s",
    async (origin) => {
      vi.stubEnv("APP_ORIGIN", origin);
      const f = await fixture(),
        preview = await request(f.sid, "/preview", {
          sourceJson: JSON.stringify(f.source),
        });
      expect(preview.status, await preview.clone().text()).toBe(200);
      const { valid, review } = (await preview.json()) as {
        valid: boolean;
        review: { id: string; digest: string };
      };
      expect(valid).toBe(true);
      expect(preview.headers.get("cache-control")).toBe("no-store");
      const command = {
        expectedDigest: review.digest,
        confirmed: true,
        sourceFrozen: true,
      };
      expect(
        (
          await request(f.sid, `/${review.id}/commit`, {
            ...command,
            sourceFrozen: false,
          })
        ).status,
      ).toBe(400);
      const sent = await request(f.sid, `/${review.id}/commit`, command);
      expect(sent.status, await sent.clone().text()).toBe(200);
      expect(await sent.json()).toMatchObject({
        state: "committed",
        result: {
          importedInvoices: 1,
          importedReceipts: 1,
          providerEffect: false,
        },
      });
      expect(
        (await request(f.sid, `/${review.id}/commit`, command)).status,
      ).toBe(200);
    },
  );
  it("requires financial owner/admin permissions and blocks API keys before lookup", async () => {
    expect((await request("")).status).toBe(401);
    for (const role of ["office", "sales_manager", "viewer"] as const) {
      const f = await fixture(role);
      expect((await request(f.sid)).status).toBe(403);
      expect(
        (
          await request(f.sid, "/preview", {
            sourceJson: JSON.stringify(f.source),
          })
        ).status,
      ).toBe(403);
    }
    const f = await fixture(),
      resolve = vi.spyOn(apiKeys, "resolveApiKey");
    expect(
      (await request(f.sid, "", undefined, { "x-api-key": "synthetic" }))
        .status,
    ).toBe(403);
    expect(resolve).not.toHaveBeenCalled();
  });
  it("rejects foreign/missing/null origins, Basic-cookie bypass, same-site and non-JSON", async () => {
    const f = await fixture(),
      source = { sourceJson: JSON.stringify(f.source) };
    for (const headers of [
      { Origin: "https://foreign.example" },
      { Origin: "null" },
      { "Sec-Fetch-Site": "same-site" },
      { "Sec-Fetch-Site": "cross-site" },
    ] as Record<string, string>[]) {
      expect((await request(f.sid, "/preview", source, headers)).status).toBe(
        403,
      );
      expect((await request(f.sid, "", undefined, headers)).status).toBe(403);
    }
    const bypass = await fetch(`${base}/api/v1/financial-migrations/preview`, {
      method: "POST",
      headers: {
        Cookie: `sid=${f.sid}`,
        Authorization: "Basic synthetic",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(source),
    });
    expect(bypass.status).toBe(403);
    expect(
      (
        await request(f.sid, "/preview", source, {
          "Content-Type": "text/plain",
        })
      ).status,
    ).toBe(415);
  });
  it("isolates saved reviews and rejects query/contract overrides with actionable source exceptions", async () => {
    const a = await fixture(),
      b = await fixture();
    const { review } = (await (
      await request(a.sid, "/preview", { sourceJson: JSON.stringify(a.source) })
    ).json()) as { review: { id: string; digest: string } };
    expect((await request(b.sid, `/${review.id}`)).status).toBe(404);
    expect(
      (
        await request(b.sid, `/${review.id}/commit`, {
          expectedDigest: review.digest,
          confirmed: true,
          sourceFrozen: true,
        })
      ).status,
    ).toBe(404);
    expect((await request(a.sid, `?organizationId=${b.org}`)).status).toBe(400);
    expect(
      (
        await request(a.sid, "/preview", {
          sourceJson: "{}",
          organizationId: b.org,
        })
      ).status,
    ).toBe(400);
    const invalid = await request(a.sid, "/preview", {
      sourceJson: "vendor,amount\n1,20",
    });
    expect(await invalid.json()).toMatchObject({
      valid: false,
      issues: [{ path: "file" }],
    });
  });
});
