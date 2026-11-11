import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { db, organizationsTable, usersTable } from "@workspace/db";
import app from "../../app";
import { createSession } from "../../lib/auth";
import { deleteTestOrgs } from "../../test-helpers/delete-test-orgs";
import { hcpJobsCsv, hcpJobsMapping } from "../../test-helpers/housecall-fixtures";

let server: Server, base: string;
const orgs: string[] = [];
async function session(role: "owner" | "office" | "viewer") {
  const [org] = await db.insert(organizationsTable).values({ name: "Synthetic HCP HTTP", slug: `hcp-http-${randomUUID()}` }).returning();
  orgs.push(org!.id);
  const [user] = await db.insert(usersTable).values({ organizationId: org!.id, role, email: `hcp-${randomUUID()}@example.invalid`, emailVerifiedAt: new Date(), isActive: true }).returning();
  return createSession({ user: { id: user!.id, email: user!.email, firstName: null, lastName: null, profileImageUrl: null }, access_token: "synthetic-hcp-session" });
}
const file = {
  csv: hcpJobsCsv([{ "Invoice": "1", "HCP Id": "job_1", "Email": "nobody@example.invalid", "Job Status": "complete", "Finished": "2026-03-01", "Amount": "10", "Paid Amount": "10", "Due": "0" }]),
  fileName: "jobs.csv", mapping: hcpJobsMapping(), exportedOn: "2026-10-31", timeZone: "America/New_York",
};
const post = (sid: string, path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}/api/v1/housecall-import${path}`, {
    method: "POST", body: JSON.stringify(body),
    headers: { "Content-Type": "application/json", Origin: process.env.APP_ORIGIN!, Cookie: `sid=${sid}`, ...headers },
  });

beforeAll(async () => {
  server = await new Promise<Server>((resolve) => { const l = app.listen(0, "127.0.0.1", () => resolve(l)); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(() => { vi.unstubAllEnvs(); });
afterAll(async () => {
  if (server) { server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r())); }
  await deleteTestOrgs(...orgs);
});

describe("Housecall Pro import HTTP", () => {
  it("previews a jobs report for staff with CRM write access and refuses viewers", async () => {
    vi.stubEnv("APP_ORIGIN", "http://localhost:3001");
    const owner = await session("owner");
    const res = await post(owner, "/jobs", { ...file, dryRun: true });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toMatchObject({ dryRun: true, totalRows: 1, newJobs: 0, unmatched: [expect.objectContaining({ jobNumber: "1" })] });
    expect((await post(await session("viewer"), "/jobs", { ...file, dryRun: true })).status).toBe(403);
    const bad = await post(owner, "/jobs", { ...file, dryRun: true, mapping: { email: 11 } });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ code: "hcp_mapping_invalid" });
  });

  it("holds invoice approvals to an owner/admin session in the trusted app", async () => {
    vi.stubEnv("APP_ORIGIN", "http://localhost:3001");
    const owner = await session("owner");
    expect((await post(owner, "/invoices/preview", file, { Origin: "https://evil.example" })).status).toBe(403);
    expect((await post(owner, "/invoices/preview", file, { "x-api-key": "mf_synthetic" })).status).toBe(403);
    expect((await post(await session("office"), "/invoices/preview", file)).status).toBe(403);
    const ok = await post(owner, "/invoices/preview", file);
    expect(ok.status, await ok.clone().text()).toBe(200);
    expect(await ok.json()).toMatchObject({ file: { count: 1, totalCents: 1000 }, reviews: [] });
  });
});
