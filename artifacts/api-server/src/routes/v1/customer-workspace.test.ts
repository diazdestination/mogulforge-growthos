import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { db, organizationsTable, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { createSession, deleteSession } from "../../lib/auth";
import { deleteTestOrgs } from "../../test-helpers/delete-test-orgs";
import * as apiKeys from "../../services/api-keys";
import * as kernel from "../../services/customer-workspace";
import { CustomerWorkspaceError } from "../../services/customer-workspace-contract";
import app from "../../app";

vi.mock("../../services/customer-workspace", () => ({
  getCustomerWorkspace: vi.fn(), getCustomerWorkspaceSection: vi.fn(), getCustomerWorkspaceAppointment: vi.fn(),
}));
const originalFetch = globalThis.fetch, origin = "https://growth.example", contact = randomUUID(), appointment = randomUUID();
const sessions: string[] = [];
let server: Server, base: string, org: string, other: string;
let owner: { sid: string; id: string }, viewer: typeof owner, foreign: typeof owner, pending: typeof owner, unverified: typeof owner, inactive: typeof owner;
async function staff(organizationId: string, role: "owner" | "viewer", options: { verified?: boolean; pending?: boolean } = {}) {
  const [user] = await db.insert(usersTable).values({ id: options.pending ? `invite:${randomUUID()}` : randomUUID(), organizationId, role, emailVerifiedAt: options.verified === false ? null : new Date() }).returning();
  const sid = await createSession({ user: { id: user.id, email: null, firstName: null, lastName: null, profileImageUrl: null }, access_token: "synthetic" });
  sessions.push(sid); return { sid, id: user.id };
}
function request(path: string, headers: Record<string, string> = {}) {
  return originalFetch(`${base}/api/v1${path}`, { headers: { origin, cookie: `sid=${owner.sid}`, ...headers } });
}
const paths = () => [`/contacts/${contact}/workspace`, `/contacts/${contact}/workspace/appointments`, `/appointments/${appointment}`];
beforeAll(async () => {
  vi.stubEnv("APP_ORIGIN", origin);
  const target = new URL(process.env.DATABASE_URL ?? "");
  if (process.env.NODE_ENV !== "test" || !["localhost", "127.0.0.1"].includes(target.hostname)) throw new Error("Use isolated runner");
  [org, other] = (await db.insert(organizationsTable).values([
    { name: "SYNTHETIC workspace HTTP", slug: randomUUID() }, { name: "SYNTHETIC other workspace HTTP", slug: randomUUID() },
  ]).returning()).map(row => row.id);
  owner = await staff(org, "owner"); viewer = await staff(org, "viewer"); foreign = await staff(other, "owner");
  pending = await staff(org, "owner", { pending: true }); unverified = await staff(org, "owner", { verified: false });
  inactive = await staff(org, "owner");
  await db.update(usersTable).set({ isActive: false }).where(eq(usersTable.id, inactive.id));
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  vi.stubGlobal("fetch", async () => { throw new Error("No external providers allowed"); });
});
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(kernel.getCustomerWorkspace).mockRejectedValue(new CustomerWorkspaceError(404, "customer_workspace_not_found", "Customer not found in this company."));
  vi.mocked(kernel.getCustomerWorkspaceAppointment).mockRejectedValue(new CustomerWorkspaceError(404, "customer_workspace_not_found", "Appointment not found in this company."));
  vi.mocked(kernel.getCustomerWorkspaceSection).mockImplementation(async (organizationId, _actor, contactId) => ({ organizationId, contactId, section: "appointments", order: "created_desc", limit: 25, items: [], nextCursor: null, hasMore: false }));
});
afterAll(async () => {
  if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  for (const sid of sessions) await deleteSession(sid);
  await deleteTestOrgs(org, other);
  vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks();
});
it("requires accepted verified active session staff on every new read", async () => {
  for (const path of paths()) {
    expect((await request(path, { cookie: "" })).status).toBe(401);
    for (const account of [pending, unverified, inactive]) expect((await request(path, { cookie: `sid=${account.sid}` })).status).toBe(403);
  }
  for (const read of Object.values(kernel)) expect(read).not.toHaveBeenCalled();
});
it("derives all company and effective-role arguments from fresh membership and never from selectors", async () => {
  const read = await request(paths()[1], { cookie: `sid=${viewer.sid}` });
  expect(read.status).toBe(200);
  expect(read.headers.get("cache-control")).toBe("no-store"); expect(read.headers.get("referrer-policy")).toBe("no-referrer");
  expect(await read.json()).toMatchObject({ organizationId: org, contactId: contact, section: "appointments", items: [], limit: 25 });
  expect(kernel.getCustomerWorkspaceSection).toHaveBeenLastCalledWith(org, viewer.id, contact, { section: "appointments" }, "viewer");
  expect((await request(paths()[0], { cookie: `sid=${foreign.sid}` })).status).toBe(404);
  expect(kernel.getCustomerWorkspace).toHaveBeenLastCalledWith(other, foreign.id, contact, "owner");
  expect((await request(paths()[2], { cookie: `sid=${foreign.sid}` })).status).toBe(404);
  expect(kernel.getCustomerWorkspaceAppointment).toHaveBeenLastCalledWith(other, foreign.id, appointment, "owner");
  await db.update(usersTable).set({ role: "viewer" }).where(eq(usersTable.id, owner.id));
  try {
    await request(paths()[1]);
    expect(kernel.getCustomerWorkspaceSection).toHaveBeenLastCalledWith(org, owner.id, contact, { section: "appointments" }, "viewer");
  } finally { await db.update(usersTable).set({ role: "owner" }).where(eq(usersTable.id, owner.id)); }
});
it("rejects even blank API keys before resolver or read side effects", async () => {
  const resolver = vi.spyOn(apiKeys, "resolveApiKey");
  for (const path of paths()) for (const key of ["", "synthetic-never-resolve"])
    expect((await request(path, { "x-api-key": key })).status).toBe(403);
  expect(resolver).not.toHaveBeenCalled();
  for (const read of Object.values(kernel)) expect(read).not.toHaveBeenCalled();
});
it("rejects unknown, duplicate, competing and unbounded selectors before domain reads", async () => {
  const [header, section, exact] = paths();
  for (const path of [
    `${header}?cursor=abc`, `${exact}?cursor=abc`, `${header}?organizationId=${other}`, `${section}?organizationId=${other}`,
    `${section}?section=invoices`, `${section}?cursor=a&cursor=b`, `${section}?cursor=`, `${section}?cursor=a.b`,
    `${section}?cursor=${"a".repeat(2049)}`, `${section}?limit=100`, `${section}?offset=25`, `${section}?cursor[x]=a`,
    `/contacts/${contact}/workspace/not-a-section`, `/contacts/not-a-uuid/workspace`, "/appointments/not-a-uuid",
  ]) expect((await request(path)).status, path.slice(0, 100)).toBe(400);
  for (const read of Object.values(kernel)) expect(read).not.toHaveBeenCalled();
});
it("passes one bounded cursor, keeps invoice denial opaque, and does not mask unavailable reads as empty", async () => {
  expect((await request(`${paths()[1]}?cursor=YWJj`)).status).toBe(200);
  expect(kernel.getCustomerWorkspaceSection).toHaveBeenLastCalledWith(org, owner.id, contact, { section: "appointments", cursor: "YWJj" }, "owner");
  vi.mocked(kernel.getCustomerWorkspaceSection).mockRejectedValueOnce(new CustomerWorkspaceError(403, "customer_workspace_section_forbidden", "You do not have access to this section."));
  const denied = await request(`/contacts/${contact}/workspace/invoices`, { cookie: `sid=${viewer.sid}` });
  expect(denied.status).toBe(403); expect(await denied.json()).toEqual({ code: "customer_workspace_section_forbidden", error: "You do not have access to this section." });
  vi.mocked(kernel.getCustomerWorkspaceAppointment).mockRejectedValueOnce(new Error("PRIVATE customer token payload"));
  const failed = await request(paths()[2]); expect(failed.status).toBe(503);
  expect(await failed.text()).not.toContain("PRIVATE");
});
it("denies explicitly untrusted browser origins without changing old CRUD guards", async () => {
  const variants: Record<string, string>[] = [{ origin: "https://other.example.invalid" }, { origin: "null" }, { "sec-fetch-site": "cross-site" }, { "sec-fetch-site": "same-site" }];
  for (const path of paths()) for (const headers of variants)
    expect((await request(path, headers)).status).toBe(403);
  for (const read of Object.values(kernel)) expect(read).not.toHaveBeenCalled();
});
