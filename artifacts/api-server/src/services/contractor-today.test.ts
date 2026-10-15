import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  appointmentsTable,
  contactsTable,
  crmTasksTable,
  db,
  leadsTable,
  organizationsTable,
  projectsTable,
  serviceObligationsTable,
  usersTable,
} from "@workspace/db";
import app from "../app";
import { createSession, deleteSession } from "../lib/auth";
import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";
import { contractorTodayQuery, getContractorToday } from "./contractor-today";

type Tenant = {
  org: string;
  owner: string;
  rep: string;
  contact: string;
  lead: string;
  sid: string;
};
const tenants: Tenant[] = [];
let server: Server, base: string;
async function setZone(org: string, zone: string) {
  await db
    .update(organizationsTable)
    .set({ timezone: zone })
    .where(eq(organizationsTable.id, org));
}
beforeAll(async () => {
  for (const name of ["A", "B"]) {
    const [org] = await db
      .insert(organizationsTable)
      .values({ name: `Today ${name}`, slug: `today-${randomUUID()}` })
      .returning();
    const [owner, rep] = await db
      .insert(usersTable)
      .values([
        { organizationId: org.id, role: "owner", firstName: `Owner ${name}` },
        { organizationId: org.id, role: "sales_rep", firstName: `Rep ${name}` },
      ])
      .returning();
    const [contact] = await db
      .insert(contactsTable)
      .values({ organizationId: org.id, firstName: `Customer ${name}` })
      .returning();
    const [lead] = await db
      .insert(leadsTable)
      .values({ organizationId: org.id, contactId: contact.id })
      .returning();
    const sid = await createSession({
      user: {
        id: owner.id,
        email: null,
        firstName: null,
        lastName: null,
        profileImageUrl: null,
      },
      access_token: "synthetic-today",
      expires_at: Math.floor(Date.now() / 1000) + 3600,
    });
    tenants.push({
      org: org.id,
      owner: owner.id,
      rep: rep.id,
      contact: contact.id,
      lead: lead.id,
      sid,
    });
  }
  server = await new Promise<Server>((resolve) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("No test listener");
  base = `http://127.0.0.1:${address.port}`;
}, 20000);
afterAll(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const t of tenants) await deleteSession(t.sid);
  await deleteTestOrgs(...tenants.map((t) => t.org));
});
const day = (
  t: Tenant,
  input: Parameters<typeof getContractorToday>[2] = { date: "2026-03-08" },
) => getContractorToday(t.org, t.owner, input);

describe("contractor workday snapshot", () => {
  it("reads the company zone without creating settings and defaults staff to their own work", async () => {
    const t = tenants[0];
    expect((await day(t)).timeZoneSource).toBe("configured");
    expect(
      (
        await db.execute(
          sql`SELECT id FROM org_settings WHERE organization_id=${t.org}`,
        )
      ).rows,
    ).toHaveLength(0);
    expect((await getContractorToday(t.org, t.rep)).scope).toBe("mine");
    expect((await day(t)).scope).toBe("company");
  });
  it("uses half-open local dates through both DST changes and derives today's local date", async () => {
    const t = tenants[0];
    await setZone(t.org, "America/New_York");
    expect(await day(t)).toMatchObject({
      timeZoneSource: "configured",
      startAt: "2026-03-08T05:00:00.000Z",
      endAt: "2026-03-09T04:00:00.000Z",
    });
    expect(await day(t, { date: "2026-11-01" })).toMatchObject({
      startAt: "2026-11-01T04:00:00.000Z",
      endAt: "2026-11-02T05:00:00.000Z",
    });
    expect(
      (
        await getContractorToday(
          t.org,
          t.owner,
          {},
          new Date("2026-03-08T02:30:00Z"),
        )
      ).date,
    ).toBe("2026-03-07");
    await setZone(t.org, "invalid/not-a-timezone");
    await expect(day(t)).rejects.toMatchObject({ status: 409 });
    await setZone(t.org, "America/New_York");
  });
  it("finds old overdue work outside a newest-200 page and reports accurate bounded totals", async () => {
    const t = tenants[0];
    const [old] = await db
      .insert(crmTasksTable)
      .values({
        organizationId: t.org,
        title: "Old overdue",
        dueAt: new Date("2025-01-01"),
        createdAt: new Date("2025-01-01"),
        assignedUserId: t.owner,
      })
      .returning();
    await db.insert(crmTasksTable).values(
      Array.from({ length: 220 }, (_, i) => ({
        organizationId: t.org,
        title: `New ${i}`,
        dueAt: new Date("2026-03-08T12:00:00Z"),
      })),
    );
    await db.insert(crmTasksTable).values({
      organizationId: t.org,
      title: "Future",
      dueAt: new Date("2026-03-09T04:00:00Z"),
    });
    const result = await day(t);
    expect(result.tasks.total).toBe(221);
    expect(result.tasks.truncated).toBe(true);
    expect(result.tasks.items).toHaveLength(50);
    expect(result.tasks.items[0].id).toBe(old.id);
    expect(
      (await day(t, { date: "2026-03-08", scope: "mine" })).tasks.items.map(
        (row) => row.id,
      ),
    ).toEqual([old.id]);
  });
  it("includes unplanned tasks and invoice shortcuts only for owned projects and permitted readers", async () => {
    const t = tenants[1],
      foreign = tenants[0];
    const [project] = await db
      .insert(projectsTable)
      .values({
        organizationId: t.org,
        leadId: t.lead,
        name: "Completed job",
        status: "completed",
      })
      .returning();
    await db.insert(crmTasksTable).values([
      { organizationId: t.org, title: "Unplanned", assignedUserId: t.rep },
      {
        organizationId: t.org,
        title: "Prepare invoice",
        sourceEvent: `project.invoice_preparation:${project.id}`,
        assignedUserId: t.rep,
      },
      {
        organizationId: foreign.org,
        title: "Forged shortcut",
        sourceEvent: `project.invoice_preparation:${project.id}`,
        assignedUserId: foreign.rep,
      },
    ]);
    const result = await day(t);
    expect(
      result.tasks.items.find((row) => row.title === "Unplanned")?.dueAt,
    ).toBeNull();
    expect(
      result.tasks.items.find((row) => row.title === "Prepare invoice")
        ?.actionPath,
    ).toBe(`/invoices?projectId=${project.id}&organizationId=${t.org}`);
    expect(
      (await getContractorToday(t.org, t.rep)).tasks.items.every(
        (row) => row.actionPath === `/tasks?taskId=${row.id}`,
      ),
    ).toBe(true);
    expect(
      (
        await getContractorToday(
          t.org,
          t.owner,
          { scope: "company" },
          undefined,
          "sales_rep",
        )
      ).tasks.items.every(
        (row) => row.actionPath === `/tasks?taskId=${row.id}`,
      ),
    ).toBe(true);
    expect(
      (await getContractorToday(foreign.org, foreign.rep)).tasks.items.find(
        (row) => row.title === "Forged shortcut",
      )?.actionPath,
    ).toMatch(/^\/tasks\?taskId=/);
  });
  it("includes midnight overlaps and no-shows, excludes cancelled and boundary-only appointments", async () => {
    const t = tenants[0];
    await db.insert(appointmentsTable).values([
      {
        organizationId: t.org,
        contactId: t.contact,
        assignedUserId: t.owner,
        type: "inspection",
        scheduledStart: new Date("2026-03-08T04:00:00Z"),
        scheduledEnd: new Date("2026-03-08T06:00:00Z"),
      },
      {
        organizationId: t.org,
        contactId: t.contact,
        type: "inspection",
        status: "no_show",
        scheduledStart: new Date("2026-03-08T05:00:00Z"),
      },
      {
        organizationId: t.org,
        contactId: t.contact,
        type: "inspection",
        scheduledStart: new Date("2026-03-08T04:30:00Z"),
      },
      {
        organizationId: t.org,
        type: "inspection",
        status: "cancelled",
        scheduledStart: new Date("2026-03-08T12:00:00Z"),
      },
      {
        organizationId: t.org,
        type: "inspection",
        scheduledStart: new Date("2026-03-09T04:00:00Z"),
      },
      {
        organizationId: t.org,
        type: "inspection",
        scheduledStart: new Date("2026-03-08T03:00:00Z"),
        scheduledEnd: new Date("2026-03-08T05:00:00Z"),
      },
    ]);
    const result = await day(t);
    expect(result.appointments.total).toBe(3);
    expect(
      result.appointments.items.some((row) => row.status === "no_show"),
    ).toBe(true);
    expect(
      result.appointments.items.every(
        (row) => row.customerLabel === "Customer A",
      ),
    ).toBe(true);
    expect(
      (await day(t, { date: "2026-03-08", scope: "mine" })).appointments.total,
    ).toBe(1);
  });
  it("selects crew jobs and service dates consistently, excluding completed/cancelled work", async () => {
    const t = tenants[1];
    await db.insert(projectsTable).values([
      {
        organizationId: t.org,
        leadId: t.lead,
        name: "Assigned ongoing",
        status: "in_progress",
        scheduledStart: new Date("2026-03-01"),
        crewUserIds: [t.rep],
      },
      {
        organizationId: t.org,
        leadId: t.lead,
        name: "Unplanned job",
        crewUserIds: [],
      },
      {
        organizationId: t.org,
        leadId: t.lead,
        name: "Cancelled job",
        status: "cancelled",
        crewUserIds: [t.rep],
      },
    ]);
    const [task] = await db
      .insert(crmTasksTable)
      .values({
        organizationId: t.org,
        contactId: t.contact,
        title: "Service task",
        assignedUserId: t.rep,
      })
      .returning();
    await db.insert(serviceObligationsTable).values({
      organizationId: t.org,
      contactId: t.contact,
      taskId: task.id,
      kind: "maintenance",
      equipmentLabel: "Furnace",
      dueAt: new Date("2026-03-08T12:00:00Z"),
    });
    const result = await getContractorToday(t.org, t.rep, {
      date: "2026-03-08",
    });
    expect(result.projects.items.map((row) => row.title)).toEqual([
      "Assigned ongoing",
    ]);
    expect(result.projects.items[0].crewNames).toEqual(["Rep B"]);
    expect(result.services.items[0]).toMatchObject({
      title: "Furnace",
      assigneeName: "Rep B",
      customerLabel: "Customer B",
      taskId: task.id,
    });
    expect((await day(t, { date: "2026-03-07" })).services.total).toBe(0);
    expect((await day(t)).projects.total).toBe(2);
  });
  it("rejects foreign/inactive actors and withholds corrupted cross-company links", async () => {
    const t = tenants[1],
      foreign = tenants[0];
    await expect(
      getContractorToday(t.org, foreign.owner),
    ).rejects.toMatchObject({ status: 403 });
    await db.insert(crmTasksTable).values({
      organizationId: t.org,
      title: "PRIVATE_CROSS_TENANT",
      leadId: foreign.lead,
    });
    expect(JSON.stringify(await day(t))).not.toContain("PRIVATE_CROSS_TENANT");
    expect(JSON.stringify(await day(t))).not.toContain(foreign.contact);
    await db
      .update(usersTable)
      .set({ isActive: false })
      .where(eq(usersTable.id, t.rep));
    try {
      await expect(getContractorToday(t.org, t.rep)).rejects.toMatchObject({
        status: 403,
      });
    } finally {
      await db
        .update(usersTable)
        .set({ isActive: true })
        .where(eq(usersTable.id, t.rep));
    }
  });
  it("authenticates actual HTTP reads and rejects forged/invalid query selectors", async () => {
    const t = tenants[1],
      path = `${base}/api/v1/contractor/today`;
    expect((await fetch(path)).status).toBe(401);
    for (const query of [
      "date=2026-02-30",
      "date=not-a-date",
      "scope=all",
      `organizationId=${tenants[0].org}`,
    ]) {
      expect(
        (
          await fetch(`${path}?${query}`, {
            headers: { authorization: `Bearer ${t.sid}` },
          })
        ).status,
      ).toBe(400);
    }
    const response = await fetch(`${path}?date=2026-03-08`, {
      headers: {
        authorization: `Bearer ${t.sid}`,
        "x-organization-id": tenants[0].org,
      },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({
      organizationId: t.org,
      date: "2026-03-08",
    });
    expect(contractorTodayQuery.safeParse({ date: "2026-02-30" }).success).toBe(
      false,
    );
  });
  it("opens the exact old task outside the recent list without exposing another company's task", async () => {
    const t = tenants[0],
      foreign = tenants[1];
    const old = (await day(t)).tasks.items[0];
    expect(old.title).toBe("Old overdue");
    expect(old.actionPath).toBe(`/tasks?taskId=${old.id}`);
    const headers = { authorization: `Bearer ${t.sid}` };
    const recent = await (
      await fetch(`${base}/api/v1/tasks`, { headers })
    ).text();
    expect(recent).not.toContain(old.id);
    const exact = await fetch(`${base}/api/v1/tasks/${old.id}`, { headers });
    expect(exact.status).toBe(200);
    expect(exact.headers.get("cache-control")).toBe("no-store");
    expect(await exact.json()).toMatchObject({
      id: old.id,
      title: "Old overdue",
      organizationId: t.org,
    });
    expect(
      (
        await fetch(`${base}/api/v1/tasks/${old.id}`, {
          headers: { authorization: `Bearer ${foreign.sid}` },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await fetch(
          `${base}/api/v1/tasks/${old.id}?organizationId=${foreign.org}`,
          { headers },
        )
      ).status,
    ).toBe(400);
    expect((await fetch(`${base}/api/v1/tasks/${old.id}`)).status).toBe(401);
    const [corrupt] = await db
      .insert(crmTasksTable)
      .values({
        organizationId: t.org,
        title: "Foreign link",
        leadId: foreign.lead,
      })
      .returning();
    expect(
      (await fetch(`${base}/api/v1/tasks/${corrupt.id}`, { headers })).status,
    ).toBe(404);
  });
});
