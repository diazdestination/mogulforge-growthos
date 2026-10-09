import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
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
import { eq } from "drizzle-orm";
import { z } from "zod/v4";
import {
  contactsTable,
  crmTasksTable,
  db,
  leadsTable,
  organizationsTable,
  smartSiteSubmissionsTable,
  smartSitesTable,
  usersTable,
} from "@workspace/db";
import app from "../../app";
import { createSession, deleteSession } from "../../lib/auth";
import { deleteTestOrgs } from "../../test-helpers/delete-test-orgs";

let server: Server, base: string;
let org: string,
  foreignOrg: string,
  actor: string,
  teammate: string,
  lead: string,
  task: string;
let sid: string, otherSid: string, viewerSid: string;
const currentOrigin = "https://growthos.example.invalid";
const followup = z
  .object({
    organizationId: z.uuid(),
    leadId: z.uuid(),
    siteName: z.string(),
    status: z.string(),
    assignedUserId: z.string().nullable(),
    ownerName: z.string().nullable(),
    ownerEligible: z.boolean(),
    receivedAt: z.iso.datetime(),
    dueAt: z.iso.datetime().nullable(),
    firstAttemptAt: z.iso.datetime().nullable(),
    canClaim: z.boolean(),
    serverNow: z.iso.datetime(),
  })
  .strict();
const request = (path: string, options: RequestInit = {}, session = sid) =>
  fetch(`${base}/api/v1${path}`, {
    ...options,
    headers: { authorization: `Bearer ${session}`, ...options.headers },
  });
const readPath = () => `/smart-sites/leads/${lead}/follow-up`;
const writes = () => [
  {
    path: `/smart-sites/leads/${lead}/owner`,
    method: "PATCH",
    body: { assignedUserId: actor, expectedOwnerId: null },
  },
  {
    path: `/smart-sites/leads/${lead}/contact-attempts`,
    method: "POST",
    body: {
      requestId: randomUUID(),
      channel: "phone",
      outcome: "no_answer",
      confirmed: true,
    },
  },
];
const jsonWrite = (
  write: ReturnType<typeof writes>[number],
  headers: Record<string, string> = {},
) =>
  request(write.path, {
    method: write.method,
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(write.body),
  });

beforeAll(async () => {
  server = await new Promise<Server>((resolve) => {
    const value = app.listen(0, "127.0.0.1", () => resolve(value));
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Test listener unavailable");
  base = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
beforeEach(async () => {
  vi.stubEnv("APP_ORIGIN", currentOrigin);
  [org, foreignOrg] = (
    await db
      .insert(organizationsTable)
      .values(
        ["A", "B"].map((label) => ({
          name: `Synthetic claim HTTP ${label}`,
          slug: `claim-http-${randomUUID()}`,
        })),
      )
      .returning()
  ).map((row) => row.id);
  const staff = await db
    .insert(usersTable)
    .values([
      {
        organizationId: org,
        role: "office" as const,
        firstName: "Synthetic A",
        emailVerifiedAt: new Date(),
      },
      {
        organizationId: org,
        role: "sales_rep" as const,
        firstName: "Synthetic B",
        emailVerifiedAt: new Date(),
      },
      {
        organizationId: org,
        role: "viewer" as const,
        emailVerifiedAt: new Date(),
      },
      {
        organizationId: foreignOrg,
        role: "office" as const,
        emailVerifiedAt: new Date(),
      },
    ])
    .returning();
  actor = staff[0].id;
  teammate = staff[1].id;
  const session = (id: string) =>
    createSession({
      user: {
        id,
        email: null,
        firstName: null,
        lastName: null,
        profileImageUrl: null,
      },
      access_token: "synthetic-test-only",
    });
  sid = await session(actor);
  viewerSid = await session(staff[2].id);
  otherSid = await session(staff[3].id);
  const [contact] = await db
    .insert(contactsTable)
    .values({
      organizationId: org,
      firstName: "PRIVATE_CUSTOMER",
      email: "private@example.invalid",
    })
    .returning();
  const [site] = await db
    .insert(smartSitesTable)
    .values({
      organizationId: org,
      siteKey: randomUUID(),
      name: "Synthetic intake",
      profile: "hvac",
      source: "synthetic",
      keyHash: "PRIVATE_KEY_HASH",
    })
    .returning();
  [lead] = (
    await db
      .insert(leadsTable)
      .values({
        organizationId: org,
        contactId: contact.id,
        creationMethod: "smart-site",
      })
      .returning()
  ).map((row) => row.id);
  await db
    .insert(smartSiteSubmissionsTable)
    .values({
      organizationId: org,
      siteId: site.id,
      leadId: lead,
      requestId: randomUUID(),
      payloadHash: "PRIVATE_PAYLOAD_HASH",
      consent: { private: "PRIVATE_CONSENT" },
    });
  [task] = (
    await db
      .insert(crmTasksTable)
      .values({
        organizationId: org,
        leadId: lead,
        sourceEvent: "smart_site.lead_saved",
        title: "First response",
      })
      .returning()
  ).map((row) => row.id);
});
afterEach(async () => {
  await Promise.all([sid, viewerSid, otherSid].map(deleteSession));
  await deleteTestOrgs(org, foreignOrg);
  vi.unstubAllEnvs();
});

describe("exact Smart Site inquiry HTTP contract", () => {
  it("requires authentication and returns only the no-store ownership DTO", async () => {
    const denied = await fetch(`${base}/api/v1${readPath()}`);
    expect(denied.status).toBe(401);
    expect(denied.headers.get("cache-control")).toBe("no-store");
    const response = await request(readPath(), {
      headers: { "x-organization-id": foreignOrg },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(followup.parse(await response.json())).toMatchObject({
      organizationId: org,
      leadId: lead,
      canClaim: true,
      assignedUserId: null,
    });
  });

  it("rejects query selectors, malformed IDs, foreign and ordinary leads", async () => {
    for (const query of [
      `?organizationId=${foreignOrg}`,
      "?leadId=anything",
      "?limit=200",
    ])
      expect((await request(readPath() + query)).status).toBe(400);
    expect(
      (await request("/smart-sites/leads/not-a-uuid/follow-up")).status,
    ).toBe(400);
    expect((await request(readPath(), {}, otherSid)).status).toBe(404);
    const [original] = await db
      .select()
      .from(leadsTable)
      .where(eq(leadsTable.id, lead));
    const [ordinary] = await db
      .insert(leadsTable)
      .values({ organizationId: org, contactId: original.contactId })
      .returning();
    expect(
      (await request(`/smart-sites/leads/${ordinary.id}/follow-up`)).status,
    ).toBe(404);
  });

  it("offers no claim to read-only or machine-context readers", async () => {
    const viewer = followup.parse(
      await (await request(readPath(), {}, viewerSid)).json(),
    );
    expect(viewer.canClaim).toBe(false);
    // An empty API-key header must not fall through to a browser claim promise.
    const machine = followup.parse(
      await (
        await request(readPath(), { headers: { "x-api-key": "" } })
      ).json(),
    );
    expect(machine.canClaim).toBe(false);
  });

  it("allows one same-origin accepted claim and returns a stale-owner conflict without changing its task", async () => {
    const write = writes()[0];
    const saved = await jsonWrite(write, {
      origin: currentOrigin,
      "sec-fetch-site": "same-origin",
    });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({ leadId: lead, assignedUserId: actor });
    const conflict = await jsonWrite({
      ...write,
      body: { assignedUserId: teammate, expectedOwnerId: null },
    });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({
      error: "owner_changed_refresh_first",
    });
    expect(
      (
        await db.select().from(crmTasksTable).where(eq(crmTasksTable.id, task))
      )[0].assignedUserId,
    ).toBe(actor);
    expect(
      followup.parse(await (await request(readPath())).json()),
    ).toMatchObject({
      assignedUserId: actor,
      ownerName: "Synthetic A",
      ownerEligible: true,
      canClaim: false,
    });
  });

  it("blocks foreign Origin, Fetch Metadata, API keys including empty headers and non-JSON for both staff mutations", async () => {
    const blockedHeaders: Record<string, string>[] = [
      { origin: "https://sibling.example.invalid" },
      { "sec-fetch-site": "same-site" },
      { "sec-fetch-site": "cross-site" },
      { "x-api-key": "" },
      { "x-api-key": "synthetic-invalid-key" },
    ];
    for (const write of writes()) {
      for (const headers of blockedHeaders) {
        const response = await jsonWrite(write, headers);
        expect(response.status).toBe(403);
        expect(response.headers.get("cache-control")).toBe("no-store");
      }
      for (const contentType of [
        "text/plain",
        "application/x-www-form-urlencoded",
      ]) {
        expect(
          (
            await request(write.path, {
              method: write.method,
              headers: { "content-type": contentType },
              body: JSON.stringify(write.body),
            })
          ).status,
        ).toBe(415);
      }
    }
    expect(
      (await db.select().from(leadsTable).where(eq(leadsTable.id, lead)))[0]
        .assignedUserId,
    ).toBeNull();
    expect(
      (
        await db.select().from(crmTasksTable).where(eq(crmTasksTable.id, task))
      )[0].status,
    ).toBe("open");
  });

  it("rejects a now-unverified actor on writes and updates read eligibility", async () => {
    await db
      .update(usersTable)
      .set({ emailVerifiedAt: null })
      .where(eq(usersTable.id, actor));
    expect(
      followup.parse(await (await request(readPath())).json()),
    ).toMatchObject({ canClaim: false });
    for (const write of writes()) {
      const response = await jsonWrite(write);
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({
        error: "active_responder_required",
      });
    }
  });

  it("preserves the exact staff-attempt receipt across a retry", async () => {
    const write = writes()[1];
    const first = await jsonWrite(write, { origin: currentOrigin }),
      repeated = await jsonWrite(write, { origin: currentOrigin });
    const receipt = z.object({
      id: z.uuid(),
      recordedAt: z.iso.datetime(),
      evidence: z.literal("staff-recorded"),
      duplicate: z.boolean(),
    });
    expect(first.status).toBe(201);
    expect(repeated.status).toBe(200);
    const saved = receipt.parse(await first.json());
    expect(receipt.parse(await repeated.json())).toMatchObject({
      id: saved.id,
      recordedAt: saved.recordedAt,
      duplicate: true,
    });
    expect(
      followup.parse(await (await request(readPath())).json()).firstAttemptAt,
    ).toBe(saved.recordedAt);
  });
});
