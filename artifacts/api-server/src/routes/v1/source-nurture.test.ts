import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { db, organizationsTable, usersTable } from "@workspace/db";
import { createSession, deleteSession } from "../../lib/auth";
import { deleteTestOrgs } from "../../test-helpers/delete-test-orgs";
import * as apiKeys from "../../services/api-keys";
import * as kernel from "../../services/source-nurture";
import { SourceNurtureError } from "../../services/source-nurture-contract";
import { CustomerLifecycleHoldError } from "../../services/customer-lifecycle";
import app from "../../app";

vi.mock("../../services/source-nurture", () => ({
  listSourceNurture: vi.fn(), getSourceNurture: vi.fn(), previewSourceNurture: vi.fn(),
  approveSourceNurture: vi.fn(), startSourceNurture: vi.fn(), stopSourceNurture: vi.fn(),
}));
const originalFetch = globalThis.fetch, origin = "https://growth.example";
let server: Server, base: string, org: string, other: string, ownerId: string;
let ownerSid: string, viewerSid: string, unverifiedSid: string, otherSid: string;
const sessions: string[] = [], plan = randomUUID();
async function staff(organizationId: string, role: "owner" | "viewer", verified = true) {
  const [user] = await db.insert(usersTable).values({ organizationId, role, emailVerifiedAt: verified ? new Date() : null }).returning();
  const sid = await createSession({ user: { id: user.id, email: null, firstName: null, lastName: null, profileImageUrl: null }, access_token: "synthetic" });
  sessions.push(sid); return { sid, id: user.id };
}
const request = (path: string, body?: unknown, headers: Record<string, string> = {}) => originalFetch(`${base}/api/v1/source-nurture${path}`, {
  method: body === undefined ? "GET" : "POST",
  headers: { origin, cookie: `sid=${ownerSid}`, ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
beforeAll(async () => {
  vi.stubEnv("APP_ORIGIN", origin);
  const target = new URL(process.env.DATABASE_URL ?? "");
  if (process.env.NODE_ENV !== "test" || !["localhost", "127.0.0.1"].includes(target.hostname)) throw new Error("Use isolated runner");
  [org, other] = (await db.insert(organizationsTable).values([
    { name: "SYNTHETIC nurture HTTP", slug: randomUUID() }, { name: "SYNTHETIC other nurture HTTP", slug: randomUUID() },
  ]).returning()).map(row => row.id);
  ({ sid: ownerSid, id: ownerId } = await staff(org, "owner"));
  viewerSid = (await staff(org, "viewer")).sid;
  unverifiedSid = (await staff(org, "owner", false)).sid;
  otherSid = (await staff(other, "owner")).sid;
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  vi.stubGlobal("fetch", async () => { throw new Error("No external provider requests allowed"); });
});
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(kernel.listSourceNurture).mockImplementation(async (organizationId, bucket, offset) => ({ organizationId, bucket, offset, limit: 25, hasMore: false, items: [] }));
  vi.mocked(kernel.getSourceNurture).mockImplementation(async () => { throw new SourceNurtureError(404, "nurture_not_found", "Plan not found in this company."); });
  for (const fn of [kernel.previewSourceNurture, kernel.approveSourceNurture, kernel.startSourceNurture, kernel.stopSourceNurture])
    vi.mocked(fn).mockImplementation(async () => { throw new SourceNurtureError(409, "nurture_review_changed", "Refresh and review the exact saved plan."); });
});
afterAll(async () => {
  if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  for (const sid of sessions) await deleteSession(sid);
  await deleteTestOrgs(org, other);
  vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks();
});
it("requires accepted current staff, derives company from session and returns no-store bounded reads", async () => {
  expect((await request("", undefined, { cookie: "" })).status).toBe(401);
  expect((await request("", undefined, { cookie: `sid=${unverifiedSid}` })).status).toBe(403);
  const read = await request("?bucket=waiting&offset=25", undefined, { cookie: `sid=${viewerSid}` });
  expect(read.status).toBe(200); expect(read.headers.get("cache-control")).toBe("no-store");
  expect(read.headers.get("referrer-policy")).toBe("no-referrer");
  expect(await read.json()).toEqual({ organizationId: org, bucket: "waiting", offset: 25, limit: 25, hasMore: false, items: [] });
  expect(kernel.listSourceNurture).toHaveBeenLastCalledWith(org, "waiting", 25);
  expect((await request("", undefined, { cookie: `sid=${otherSid}` })).status).toBe(200);
  expect(kernel.listSourceNurture).toHaveBeenLastCalledWith(other, "attention", 0);
  expect((await request(`/${plan}`, undefined, { cookie: `sid=${otherSid}` })).status).toBe(404);
  expect(kernel.getSourceNurture).toHaveBeenLastCalledWith(other, plan);
});
it("rejects unknown, duplicate, malformed and unbounded query selectors before domain reads", async () => {
  for (const path of [`?organizationId=${other}`, "?bucket=all", "?offset=-1", "?offset=100001", "?offset=0&offset=25", "?bucket=waiting&bucket=history", `/${plan}?bucket=waiting`, "/not-a-uuid"])
    expect((await request(path)).status).toBe(400);
  expect(kernel.listSourceNurture).not.toHaveBeenCalled(); expect(kernel.getSourceNurture).not.toHaveBeenCalled();
});
it("denies API keys for both evidence and mutations before key resolution, even with a valid staff cookie", async () => {
  const resolver = vi.spyOn(apiKeys, "resolveApiKey");
  for (const key of ["", "synthetic-not-looked-up"]) {
    expect((await request("", undefined, { "x-api-key": key })).status).toBe(403);
    expect((await request(`/${plan}/start`, {}, { "x-api-key": key })).status).toBe(403);
  }
  expect(resolver).not.toHaveBeenCalled(); expect(kernel.startSourceNurture).not.toHaveBeenCalled();
});
it("requires settings authority, exact trusted origin and JSON; Basic auth cannot bypass cookie CSRF", async () => {
  expect((await request("/preview", {}, { cookie: `sid=${viewerSid}` })).status).toBe(403);
  const variants: Record<string, string>[] = [
    { origin: "https://evil.growth.example" }, { origin: "null" }, { origin: `${origin}/path` },
    { "sec-fetch-site": "same-site" }, { "sec-fetch-site": "cross-site" },
  ];
  for (const headers of variants) expect((await request("/preview", {}, headers)).status).toBe(403);
  expect((await request("/preview", {}, { "content-type": "text/plain" })).status).toBe(415);
  const noOrigin = await originalFetch(`${base}/api/v1/source-nurture/preview`, {
    method: "POST", headers: { cookie: `sid=${ownerSid}`, authorization: "Basic ignored", "content-type": "application/json" }, body: "{}",
  });
  expect(noOrigin.status).toBe(403); expect(kernel.previewSourceNurture).not.toHaveBeenCalled();
});
it("routes review, approval, start and stop separately with the current staff identity", async () => {
  const command = { expectedVersion: 2, payloadSha256: "a".repeat(64), confirmed: true, requestId: randomUUID() };
  expect((await request("/preview", {})).status).toBe(409);
  expect(kernel.previewSourceNurture).toHaveBeenCalledWith(org, ownerId, {});
  expect(kernel.startSourceNurture).not.toHaveBeenCalled();
  expect((await request(`/${plan}/approve`, command)).status).toBe(409);
  expect(kernel.approveSourceNurture).toHaveBeenCalledWith(org, ownerId, plan, command);
  expect(kernel.startSourceNurture).not.toHaveBeenCalled();
  expect((await request(`/${plan}/start`, command)).status).toBe(409);
  expect(kernel.startSourceNurture).toHaveBeenCalledWith(org, ownerId, plan, command);
  const stop = { ...command, requestId: randomUUID(), reason: "Synthetic office stop. No provider action." };
  expect((await request(`/${plan}/stop`, stop)).status).toBe(409);
  expect(kernel.stopSourceNurture).toHaveBeenCalledWith(org, ownerId, plan, stop);
});
it("keeps action failures explicit and redacts unknown provider or internal errors", async () => {
  vi.mocked(kernel.startSourceNurture).mockRejectedValueOnce(new CustomerLifecycleHoldError());
  const held = await request(`/${plan}/start`, {}); expect(held.status).toBe(423);
  expect(await held.json()).toMatchObject({ code: "customer_lifecycle_paused" });
  vi.mocked(kernel.stopSourceNurture).mockRejectedValueOnce(new Error("PRIVATE token or customer payload"));
  const unknown = await request(`/${plan}/stop`, {}); expect(unknown.status).toBe(503);
  const body = await unknown.text(); expect(body).not.toContain("PRIVATE"); expect(body).toContain("Refresh saved evidence");
});
