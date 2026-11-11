import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";

import { contactsTable, db, estimatesTable, leadsTable, organizationsTable, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import app from "../../app";
import { createSession } from "../../lib/auth";
import { deleteTestOrgs } from "../../test-helpers/delete-test-orgs";
import { createEstimate } from "../../services/crm";
import v1Router from "./index";

/**
 * HTTP contract for ESTI customer approval: staff create/revoke links and read
 * the signed record under requireMember; the customer page uses only the
 * token-authenticated, rate-limited /public/estimate-approvals routes.
 */

const SIGNATURE =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

let server: Server;
let baseUrl: string;
const orgs: string[] = [];
type Company = { orgId: string; sid: string; estimateId: string; viewerSid: string };
let a: Company;
let b: Company;

async function session(userId: string) {
  return createSession({
    user: { id: userId, email: null, firstName: null, lastName: null, profileImageUrl: null },
    access_token: "test-token",
    expires_at: Math.floor(Date.now() / 1000) + 3600,
  });
}

async function company(name: string): Promise<Company> {
  const [org] = await db.insert(organizationsTable).values({ name, slug: `est-approval-route-${randomUUID()}` }).returning();
  orgs.push(org!.id);
  const [admin] = await db.insert(usersTable).values({ email: `admin-${randomUUID()}@example.com`, organizationId: org!.id, role: "admin" }).returning();
  const [viewer] = await db.insert(usersTable).values({ email: `viewer-${randomUUID()}@example.com`, organizationId: org!.id, role: "viewer" }).returning();
  const [contact] = await db.insert(contactsTable).values({ organizationId: org!.id, firstName: "Pat" }).returning();
  const [lead] = await db.insert(leadsTable).values({ organizationId: org!.id, contactId: contact!.id }).returning();
  const estimate = await createEstimate(org!.id, { leadId: lead!.id, title: `${name} gutters`, status: "sent", lineItems: [{ description: "Seamless gutters", quantity: 120, unitPriceCents: 1200, totalCents: 0 }] }, { userId: admin!.id });
  return { orgId: org!.id, sid: await session(admin!.id), viewerSid: await session(viewer!.id), estimateId: estimate!.id };
}

function api(sid: string | null, method: string, path: string, body?: unknown) {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: { ...(sid ? { authorization: `Bearer ${sid}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

beforeAll(async () => {
  a = await company("Alpha Exteriors");
  b = await company("Bravo Exteriors");
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await deleteTestOrgs(...orgs);
});

describe("estimate approval routes", () => {
  it("mounts the three public routes behind a rate limiter", () => {
    type Layer = { route?: { path: string; methods: Record<string, boolean>; stack: { name: string }[] }; handle?: { stack?: Layer[] } };
    const found: string[] = [];
    const walk = (stack: Layer[]) => {
      for (const layer of stack) {
        if (layer.route?.path.startsWith("/public/estimate-approvals")) {
          expect(layer.route.stack.length).toBeGreaterThanOrEqual(2);
          found.push(`${Object.keys(layer.route.methods)[0]!.toUpperCase()} ${layer.route.path}`);
        } else if (layer.handle?.stack) walk(layer.handle.stack);
      }
    };
    walk((v1Router as unknown as { stack: Layer[] }).stack);
    expect(found.sort()).toEqual([
      "GET /public/estimate-approvals/:token",
      "POST /public/estimate-approvals/:token/approve",
      "POST /public/estimate-approvals/:token/decline",
    ]);
  });

  it("lets staff create a link the customer can open and sign without logging in", async () => {
    expect((await api(null, "POST", `/v1/estimates/${a.estimateId}/approval-link`, {})).status).toBe(401);
    expect((await api(a.viewerSid, "POST", `/v1/estimates/${a.estimateId}/approval-link`, {})).status).toBe(403);
    const created = await api(a.sid, "POST", `/v1/estimates/${a.estimateId}/approval-link`, {});
    expect(created.status).toBe(200);
    const { url, approval } = (await created.json()) as { url: string; approval: { state: string } };
    expect(approval.state).toBe("waiting");
    const token = url.split("/approve/")[1]!;

    const view = await api(null, "GET", `/v1/public/estimate-approvals/${token}`);
    expect(view.status).toBe(200);
    expect(view.headers.get("cache-control")).toBe("no-store");
    const shown = (await view.json()) as { companyName: string; estimate: { totalCents: number } };
    expect(shown).toMatchObject({ companyName: "Alpha Exteriors", estimate: { totalCents: 144000 } });
    expect(JSON.stringify(shown)).not.toContain(a.orgId);

    const viewerStatus = await api(a.viewerSid, "GET", `/v1/estimates/${a.estimateId}/approval`);
    expect(viewerStatus.status).toBe(200);
    expect(JSON.stringify(await viewerStatus.json())).not.toContain(token);

    const signed = await api(null, "POST", `/v1/public/estimate-approvals/${token}/approve`, { signerName: "Pat Customer", signatureDataUrl: SIGNATURE, consent: true });
    expect(signed.status).toBe(200);
    expect(await signed.json()).toMatchObject({ state: "approved", signerName: "Pat Customer" });
    const [estimate] = await db.select().from(estimatesTable).where(eq(estimatesTable.id, a.estimateId));
    expect(estimate!.status).toBe("accepted");
    const again = await api(null, "POST", `/v1/public/estimate-approvals/${token}/approve`, { signerName: "Pat Customer", signatureDataUrl: SIGNATURE, consent: true });
    expect(again.status).toBe(409);

    const record = await api(a.viewerSid, "GET", `/v1/estimates/${a.estimateId}/approval/record`);
    expect(record.status).toBe(200);
    expect(record.headers.get("content-type")).toContain("text/html");
    expect(record.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(await record.text()).toContain("Pat Customer");
  });

  it("isolates companies and rejects unknown tokens", async () => {
    expect((await api(b.sid, "POST", `/v1/estimates/${a.estimateId}/approval-link`, {})).status).toBe(404);
    expect((await api(b.sid, "GET", `/v1/estimates/${a.estimateId}/approval`)).status).toBe(404);
    expect((await api(b.sid, "GET", `/v1/estimates/${a.estimateId}/approval/record`)).status).toBe(404);
    expect((await api(b.sid, "POST", `/v1/estimates/${a.estimateId}/approval-link/revoke`, {})).status).toBe(404);
    expect((await api(null, "GET", `/v1/public/estimate-approvals/${"A".repeat(43)}`)).status).toBe(404);
    expect((await api(null, "POST", `/v1/public/estimate-approvals/nope/decline`, {})).status).toBe(404);
  });

  it("revokes a link so the customer page refuses it", async () => {
    const created = (await (await api(b.sid, "POST", `/v1/estimates/${b.estimateId}/approval-link`, {})).json()) as { url: string };
    const token = created.url.split("/approve/")[1]!;
    expect((await api(b.sid, "POST", `/v1/estimates/${b.estimateId}/approval-link/revoke`, {})).status).toBe(200);
    expect(await (await api(null, "GET", `/v1/public/estimate-approvals/${token}`)).json()).toMatchObject({ state: "revoked", estimate: null });
    expect((await api(null, "POST", `/v1/public/estimate-approvals/${token}/decline`, { reason: "x" })).status).toBe(410);
  });
});
