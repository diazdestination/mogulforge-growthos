import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  db,
  organizationsTable,
  usersTable,
  contactsTable,
  leadsTable,
  valueEntriesTable,
} from "@workspace/db";
import app from "../../app";
import { createSession } from "../../lib/auth";
import { deleteTestOrgs } from "../../test-helpers/delete-test-orgs";
import type { RoiReport } from "../../services/roi-report";

let server: Server, base: string, sid: string;
const orgs: string[] = [];
const endAt = new Date(Date.now() - 1_000).toISOString();
const startAt = new Date(Date.parse(endAt) - 30 * 86_400_000).toISOString();
beforeAll(async () => {
  if (new URL(process.env.DATABASE_URL!).hostname !== "127.0.0.1")
    throw new Error("Local DB only");
  for (let n = 0; n < 2; n++) {
    const [org] = await db
      .insert(organizationsTable)
      .values({
        name: "Reporting route QA",
        slug: `report-route-${randomUUID()}`,
      })
      .returning();
    orgs.push(org.id);
    const [user] = await db
      .insert(usersTable)
      .values({ organizationId: org.id, role: "viewer", firstName: "QA" })
      .returning();
    const [contact] = await db
      .insert(contactsTable)
      .values({
        organizationId: org.id,
        firstName: "Synthetic",
        lastName: "Owner",
      })
      .returning();
    const [lead] = await db
      .insert(leadsTable)
      .values({
        organizationId: org.id,
        contactId: contact.id,
        createdAt: new Date(Date.parse(startAt) + 1_000),
        wonAt: new Date(Date.parse(startAt) + 2_000),
        wonRevenueCents: n ? 9_999_999 : 100,
        summary: n
          ? "Foreign confidential opportunity"
          : "Synthetic local opportunity",
      })
      .returning();
    await db
      .insert(valueEntriesTable)
      .values({
        organizationId: org.id,
        leadId: lead.id,
        sourceReference: randomUUID(),
        recordedByUserId: user.id,
        kind: "payment",
        amountCents: n ? 9_999_999 : 100,
        occurredAt: new Date(Date.parse(startAt) + 2_000),
      });
    if (n === 0)
      sid = await createSession({
        user: {
          id: user.id,
          email: null,
          firstName: null,
          lastName: null,
          profileImageUrl: null,
        },
        access_token: "synthetic-local",
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      });
  }
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
});
afterAll(async () => {
  if (server)
    await new Promise<void>((resolve, reject) =>
      server.close((e) => (e ? reject(e) : resolve())),
    );
  await deleteTestOrgs(...orgs);
});
const get = (path: string, authenticated = true) =>
  fetch(base + path, {
    headers: authenticated ? { cookie: `sid=${sid}` } : {},
  });

it("requires membership for reports, export and financial proof", async () => {
  for (const path of ["/reports/roi", "/reports/roi/export", "/revenue/value"])
    expect((await get(path, false)).status).toBe(401);
});
it("uses session tenant, exact range and no-store on report and ledger", async () => {
  const reportResponse = await get(
    `/reports/roi?days=30&endAt=${encodeURIComponent(endAt)}`,
  );
  expect(reportResponse.status).toBe(200);
  expect(reportResponse.headers.get("cache-control")).toBe("no-store");
  const report = (await reportResponse.json()) as RoiReport;
  expect(report.period).toEqual({ startAt, endAt, timeZone: "UTC" });
  expect(report.outcomes.revenueWonCents).toBe(100);
  expect(JSON.stringify(report)).not.toContain("Foreign confidential");
  const ledgerResponse = await get(
    `/revenue/value?${new URLSearchParams({ startAt, endAt })}`,
  );
  expect(ledgerResponse.headers.get("cache-control")).toBe("no-store");
  expect(await ledgerResponse.json()).toMatchObject({
    period: report.period,
    netReceiptsCents: 100,
    entryCount: 1,
  });
  const allTime = await get("/revenue/value");
  expect(await allTime.json()).toMatchObject({
    period: "all_time",
    netReceiptsCents: 100,
  });
});
it("uses the same anchored range in CSV and rejects query-based tenant overrides", async () => {
  const response = await get(
    `/reports/roi/export?days=30&endAt=${encodeURIComponent(endAt)}`,
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("content-type")).toContain("text/csv");
  const csv = await response.text();
  expect(csv).toContain(`start_at_inclusive,UTC,${startAt}`);
  expect(csv).toContain(`end_at_exclusive,UTC,${endAt}`);
  expect(csv).not.toContain("9999999");
  for (const path of ["/reports/roi", "/reports/roi/export", "/revenue/value"])
    expect((await get(`${path}?organizationId=${orgs[1]}`)).status).toBe(400);
});
it("returns 400 for malformed, duplicate, partial and future period requests", async () => {
  for (const query of [
    "days=0",
    "days=1.5",
    "days=366",
    "days=30&days=7",
    "endAt=2026-02-30T00%3A00%3A00Z",
    "endAt=2099-01-01T00%3A00%3A00Z",
  ]) {
    expect((await get(`/reports/roi?${query}`)).status, query).toBe(400);
    expect((await get(`/reports/roi/export?${query}`)).status, query).toBe(400);
  }
  for (const query of [
    `startAt=${startAt}`,
    `endAt=${endAt}`,
    `startAt=${endAt}&endAt=${startAt}`,
    `startAt=${startAt}&endAt=2099-01-01T00:00:00Z`,
  ])
    expect((await get(`/revenue/value?${query}`)).status, query).toBe(400);
});
