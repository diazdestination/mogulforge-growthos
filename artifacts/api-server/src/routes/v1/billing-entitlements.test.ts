import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { db, organizationsTable, usersTable } from '@workspace/db';
import { inArray } from 'drizzle-orm';
import express, { type Request } from 'express';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { deleteTestOrgs } from '../../test-helpers/delete-test-orgs';
import billingRouter from './billing';

let server: Server;
let origin: string;
let orgA: string;
let orgB: string;
let owner: string;
let viewer: string;
let operator: string;
beforeAll(async () => {
  const nonce = randomUUID();
  const orgs = await db.insert(organizationsTable).values([
    { name: 'Billing routes A', slug: `billing-route-a-${nonce}` },
    { name: 'Billing routes B', slug: `billing-route-b-${nonce}` },
  ]).returning();
  [orgA, orgB] = orgs.map((org) => org.id);
  [owner, viewer, operator] = [`billing-owner-${nonce}`, `billing-viewer-${nonce}`, `billing-platform-${nonce}`];
  await db.insert(usersTable).values([
    { id: owner, organizationId: orgA, role: 'owner' },
    { id: viewer, organizationId: orgA, role: 'viewer' },
    { id: operator, role: 'owner', isPlatformAdmin: true },
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const id = req.header('x-synthetic-user');
    req.isAuthenticated = (() => Boolean(id)) as Request['isAuthenticated'];
    if (id) req.user = { id, email: null, firstName: null, lastName: null, profileImageUrl: null };
    next();
  });
  app.use(billingRouter);
  server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Synthetic server did not bind');
  origin = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
  await db.update(usersTable).set({ organizationId: null }).where(inArray(usersTable.id, [owner, viewer, operator]));
  await deleteTestOrgs(orgA, orgB);
  await db.delete(usersTable).where(inArray(usersTable.id, [owner, viewer, operator]));
});
const assignment = { planId: 'beta', source: 'manual', grants: [], reason: 'Synthetic beta scope acceptance' };
async function assign(user: string, org: string, body: unknown = assignment, headers: Record<string, string> = {}) {
  return fetch(`${origin}/platform/orgs/${org}/entitlements`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-synthetic-user': user, ...headers }, body: JSON.stringify(body) });
}
it('rejects unauthenticated users, ordinary tenant owners, and API keys at the platform mutation boundary', async () => {
  expect((await assign('', orgA)).status).toBe(401);
  expect((await assign(owner, orgA)).status).toBe(403);
  expect((await assign(operator, orgA, assignment, { 'x-api-key': 'synthetic-untrusted-key' })).status).toBe(403);
});
it('only changes the explicit platform target and rejects a browser body organization override', async () => {
  expect((await assign(operator, orgB, { ...assignment, organizationId: orgA })).status).toBe(400);
  expect((await assign(operator, orgB)).status).toBe(200);
  const response = await fetch(`${origin}/billing/entitlements?organizationId=${orgB}&planId=scale`, { headers: { 'x-synthetic-user': viewer } });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ mode: 'legacy', planId: null });
});
it('returns scoped capability reasons to tenant members without exposing provider identifiers or granting mutations', async () => {
  expect((await assign(operator, orgA)).status).toBe(200);
  const response = await fetch(`${origin}/billing/entitlements`, { headers: { 'x-synthetic-user': viewer } });
  const status = await response.json();
  expect(status).toMatchObject({ mode: 'managed', planId: 'beta', capabilities: { 'revenue.autopilot': { allowed: false, reason: 'not_in_plan' } } });
  expect(JSON.stringify(status)).not.toContain('stripeCustomerId');
  expect((await fetch(`${origin}/billing`, { headers: { 'x-synthetic-user': viewer } })).status).toBe(403);
  expect((await assign(viewer, orgA, { ...assignment, planId: 'scale' })).status).toBe(403);
});
