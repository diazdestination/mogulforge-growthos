import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  analyticsEventsTable,
  appointmentsTable,
  db,
  estimatesTable,
  leadsTable,
  organizationsTable,
  smartSiteSubmissionsTable,
  smartSitesTable,
  usersTable,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import app from "../../app";
import { createSession } from "../../lib/auth";
import { deleteTestOrgs } from "../../test-helpers/delete-test-orgs";

let server: Server;
let base: string;
let orgId: string;
let otherOrgId: string;
let adminSession: string;
let viewerSession: string;
let otherSession: string;
let site: { id: string; secret: string };

const json = <T>(response: Response) => response.json() as Promise<T>;
const auth = (
  path: string,
  body?: unknown,
  method = "GET",
  token = adminSession,
) =>
  fetch(`${base}/api/v1${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
const publicRequest = (
  path: string,
  target = site,
  body?: unknown,
  method = body ? "POST" : "GET",
  headers: Record<string, string> = {},
) =>
  fetch(`${base}/api/v1/public/smart-sites/${target.id}/${path}`, {
    method,
    headers: {
      authorization: `Bearer ${target.secret}`,
      "content-type": "application/json",
      ...headers,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

const eventBatch = (
  visitorId: string,
  eventId = randomUUID(),
  overrides: Record<string, unknown> = {},
) => ({
  schemaVersion: 1,
  consent: true,
  policyVersion: "smart-sites-analytics-v1",
  visitorId,
  sessionId: randomUUID(),
  events: [
    {
      eventId,
      eventName: "page_view",
      occurredAt: new Date().toISOString(),
      path: "/services",
      source: "google",
      medium: "organic",
      referrerHost: "www.google.com",
      surface: "website",
      ...overrides,
    },
  ],
});

beforeAll(async () => {
  const url = new URL(process.env.DATABASE_URL!);
  if (
    !["127.0.0.1", "localhost"].includes(url.hostname) ||
    !url.pathname.endsWith("_test")
  )
    throw new Error("Smart Site acquisition tests require a local *_test database");
  const [org, otherOrg] = await db
    .insert(organizationsTable)
    .values([
      { name: "Acquisition test", slug: `acquisition-${randomUUID()}` },
      { name: "Other acquisition test", slug: `other-acquisition-${randomUUID()}` },
    ])
    .returning();
  orgId = org.id;
  otherOrgId = otherOrg.id;
  const sessionFor = async (
    organizationId: string,
    role: "admin" | "viewer",
  ) => {
    const [user] = await db
      .insert(usersTable)
      .values({
        organizationId,
        role,
        email: `acquisition-${randomUUID()}@example.test`,
      })
      .returning();
    return createSession({
      user: {
        id: user.id,
        email: user.email,
        firstName: null,
        lastName: null,
        profileImageUrl: null,
      },
      access_token: "test-only",
      expires_at: Math.floor(Date.now() / 1000) + 3600,
    });
  };
  adminSession = await sessionFor(orgId, "admin");
  viewerSession = await sessionFor(orgId, "viewer");
  otherSession = await sessionFor(otherOrgId, "admin");
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  site = await json(
    await auth(
      "/smart-sites",
      {
        name: "Measured roofing site",
        siteKey: `measured-${randomUUID()}`,
        profile: "roofing-exteriors",
      },
      "POST",
    ),
  );
  await auth(`/smart-sites/${site.id}`, { isActive: true }, "PATCH");
});

afterAll(async () => {
  server?.close();
  await deleteTestOrgs(orgId, otherOrgId);
});

describe("consent-first Smart Site acquisition measurement", () => {
  it("stays disabled by default and only an authorized operator can configure retention", async () => {
    const initial = await publicRequest("acquisition-status");
    expect(initial.status).toBe(200);
    expect(await json(initial)).toMatchObject({
      ready: false,
      retentionDays: 90,
      policyVersion: "smart-sites-analytics-v1",
    });
    expect(
      (
        await auth(
          `/smart-sites/${site.id}/measurement`,
          { enabled: true, retentionDays: 30 },
          "PATCH",
          viewerSession,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await auth(
          `/smart-sites/${site.id}/measurement`,
          { enabled: true, retentionDays: 7 },
          "PATCH",
        )
      ).status,
    ).toBe(400);
    const enabled = await auth(
      `/smart-sites/${site.id}/measurement`,
      { enabled: true, retentionDays: 30 },
      "PATCH",
    );
    expect(enabled.status).toBe(200);
    expect(await json(enabled)).toMatchObject({
      analyticsEnabled: true,
      analyticsRetentionDays: 30,
    });
  });

  it("accepts only bounded consented events, detects edited retries and keeps tenants separate", async () => {
    const visitorId = randomUUID();
    const eventId = randomUUID();
    const originalBatch = eventBatch(visitorId, eventId);
    expect(
      (
        await publicRequest(
          "acquisition-events",
          site,
          { ...originalBatch, consent: false },
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await publicRequest(
          "acquisition-events",
          site,
          originalBatch,
          "POST",
          { origin: "https://example.test" },
        )
      ).status,
    ).toBe(403);
    const first = await publicRequest(
      "acquisition-events",
      site,
      originalBatch,
    );
    expect(first.status).toBe(202);
    expect(await json(first)).toMatchObject({ accepted: 1, duplicates: 0 });
    const replay = await publicRequest(
      "acquisition-events",
      site,
      originalBatch,
    );
    expect(replay.status).toBe(202);
    expect(await json(replay)).toMatchObject({ accepted: 0, duplicates: 1 });
    expect(
      (
        await publicRequest(
          "acquisition-events",
          site,
          {
            ...originalBatch,
            events: [{ ...originalBatch.events[0], path: "/changed" }],
          },
        )
      ).status,
    ).toBe(409);
    const [stored] = await db
      .select()
      .from(analyticsEventsTable)
      .where(
        and(
          eq(analyticsEventsTable.smartSiteId, site.id),
          eq(analyticsEventsTable.eventId, eventId),
        ),
      );
    expect(stored.anonymousId).toBe(visitorId);
    expect(stored.referrer).toBe("www.google.com");
    expect(stored.properties).toEqual({ contract: "smart-sites-acquisition-v1" });
    expect(JSON.stringify(stored)).not.toContain("example.test homeowner");

    const otherSite = await json<{ id: string; secret: string }>(
      await auth(
        "/smart-sites",
        {
          name: "Other measured site",
          siteKey: `other-measured-${randomUUID()}`,
          profile: "hvac",
        },
        "POST",
        otherSession,
      ),
    );
    await auth(
      `/smart-sites/${otherSite.id}`,
      { isActive: true },
      "PATCH",
      otherSession,
    );
    await auth(
      `/smart-sites/${otherSite.id}/measurement`,
      { enabled: true, retentionDays: 30 },
      "PATCH",
      otherSession,
    );
    await publicRequest(
      "acquisition-events",
      otherSite,
      eventBatch(randomUUID()),
    );
    const report = await json<{ summary: { visitors: number } }>(
      await auth("/smart-sites/acquisition?days=30"),
    );
    expect(report.summary.visitors).toBe(1);
  });

  it("joins a consented visitor to a real receipt and preserves the lead when that browser opts out", async () => {
    const visitorId = randomUUID();
    const sessionId = randomUUID();
    await publicRequest(
      "acquisition-events",
      site,
      {
        ...eventBatch(visitorId),
        sessionId,
        events: [
          {
            eventId: randomUUID(),
            eventName: "project_form_started",
            occurredAt: new Date().toISOString(),
            path: "/services/siding-services",
            source: "google",
            medium: "organic",
            serviceCode: "siding",
            surface: "project-inquiry",
            step: "details",
          },
        ],
      },
    );
    const requestId = randomUUID();
    const intake = await fetch(
      `${base}/api/v1/public/smart-sites/${site.id}/intake`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${site.secret}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          schemaVersion: 1,
          requestId,
          contact: {
            name: "Measured Local Homeowner",
            phone: "404-555-0198",
          },
          project: {
            serviceCode: "siding",
            postalCode: "30115",
            timing: "planning",
          },
          consent: {
            contact: true,
            analytics: true,
            policyVersion: "painless-project-inquiry-v1",
            channels: ["phone"],
          },
          attribution: {
            source: "google",
            medium: "organic",
            landingPath: "/services/siding-services",
          },
          measurement: {
            visitorId,
            sessionId,
            policyVersion: "smart-sites-analytics-v1",
          },
        }),
      },
    );
    expect(intake.status).toBe(201);
    const saved = await json<{ leadId: string }>(intake);
    const linked = await db
      .select()
      .from(analyticsEventsTable)
      .where(eq(analyticsEventsTable.leadId, saved.leadId));
    expect(linked.map((event) => event.eventName).sort()).toEqual([
      "lead_saved",
      "project_form_started",
    ]);
    await db.insert(appointmentsTable).values({
      organizationId: orgId,
      leadId: saved.leadId,
      scheduledStart: new Date(Date.now() + 86_400_000),
    });
    await db.insert(estimatesTable).values({
      organizationId: orgId,
      leadId: saved.leadId,
      title: "Measured estimate",
      status: "sent",
      totalCents: 1_250_000,
    });
    await db
      .update(leadsTable)
      .set({
        status: "won",
        wonAt: new Date(),
        wonRevenueCents: 1_250_000,
        wonAttribution: "directly_attributed",
      })
      .where(eq(leadsTable.id, saved.leadId));
    const report = await json<{
      summary: {
        savedLeads: number;
        appointmentLeads: number;
        estimateLeads: number;
        wonLeads: number;
        wonValueCents: number;
      };
      services: {
        serviceCode: string;
        visitors: number;
        savedLeads: number;
      }[];
      content: {
        path: string;
        visitors: number;
        savedLeads: number;
        wonLeads: number;
      }[];
    }>(await auth("/smart-sites/acquisition?days=30"));
    expect(report.summary).toMatchObject({
      savedLeads: 1,
      appointmentLeads: 1,
      estimateLeads: 1,
      wonLeads: 1,
      wonValueCents: 1_250_000,
    });
    expect(report.services).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          serviceCode: "siding",
          visitors: 1,
          savedLeads: 1,
        }),
        expect.objectContaining({
          serviceCode: "Not specified",
          visitors: 1,
          savedLeads: 0,
        }),
      ]),
    );
    expect(report.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "/services/siding-services",
          visitors: 1,
          savedLeads: 1,
          wonLeads: 1,
        }),
      ]),
    );

    const optOut = await publicRequest("analytics-opt-out", site, {
      schemaVersion: 1,
      visitorId,
    });
    expect(optOut.status).toBe(200);
    expect(await json(optOut)).toMatchObject({
      removedEvents: 2,
      unlinkedLeads: 1,
      operationalLeadRecordsPreserved: true,
    });
    expect(
      await db
        .select()
        .from(analyticsEventsTable)
        .where(eq(analyticsEventsTable.anonymousId, visitorId)),
    ).toHaveLength(0);
    const [preservedLead] = await db
      .select()
      .from(leadsTable)
      .where(eq(leadsTable.id, saved.leadId));
    expect(preservedLead.status).toBe("won");
    expect(preservedLead.anonymousId).toBeNull();
    expect(
      await db
        .select()
        .from(smartSiteSubmissionsTable)
        .where(eq(smartSiteSubmissionsTable.leadId, saved.leadId)),
    ).toHaveLength(1);
  });
});
