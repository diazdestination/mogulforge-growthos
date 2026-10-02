import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { contactsTable, crmTasksTable, db, organizationsTable, serviceObligationsTable, usersTable } from '@workspace/db';
import app from '../../app';
import { createSession, deleteSession } from '../../lib/auth';
import { deleteTestOrgs } from '../../test-helpers/delete-test-orgs';

let server: Server, base: string, org: string, foreignOrg: string, sid: string;
let activeIds: string[];
beforeAll(async () => {
  const companies = await db.insert(organizationsTable).values(['A', 'B'].map(name => ({ name: `Synthetic service history ${name}`, slug: `service-history-${randomUUID()}` }))).returning();
  org = companies[0].id; foreignOrg = companies[1].id;
  const [user] = await db.insert(usersTable).values({ organizationId: org, role: 'office' }).returning();
  sid = await createSession({ user: { id: user.id, email: null, firstName: null, lastName: null, profileImageUrl: null }, access_token: 'synthetic', expires_at: Math.floor(Date.now() / 1000) + 3600 });
  for (const company of companies) {
    const [contact] = await db.insert(contactsTable).values({ organizationId: company.id, firstName: 'Synthetic customer' }).returning();
    const count = company.id === org ? 1001 : 1;
    const tasks = await db.insert(crmTasksTable).values(Array.from({ length: count }, (_, index) => ({ organizationId: company.id, contactId: contact.id, title: `Synthetic service ${index}` }))).returning();
    const rows = await db.insert(serviceObligationsTable).values(tasks.map((task, index) => ({ organizationId: company.id, contactId: contact.id, taskId: task.id, kind: 'maintenance' as const, equipmentLabel: `Synthetic unit ${index}`, status: index < 500 && company.id === org ? 'completed' as const : 'active' as const, dueAt: new Date(index < 500 && company.id === org ? '2034-01-01T12:00:00Z' : '2035-01-01T12:00:00Z') }))).returning();
    if (company.id === org) activeIds = rows.filter(row => row.status === 'active').map(row => row.id).sort();
  }
  server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/service-obligations`;
}, 20000);
afterAll(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await deleteSession(sid); await deleteTestOrgs(org, foreignOrg); });
const headers = () => ({ authorization: `Bearer ${sid}` });

it('does not let 500 old completed records hide newer active service and pages deterministically', async () => {
  const first = await fetch(`${base}?status=active`, { headers: headers() });
  expect(first.status).toBe(200);
  const rows = await first.json() as { obligation: { id: string; status: string; organizationId: string } }[];
  expect(rows).toHaveLength(500);
  expect(rows.every(row => row.obligation.status === 'active' && row.obligation.organizationId === org)).toBe(true);
  expect(first.headers.get('x-result-limit-reached')).toBe('true');
  const second = await fetch(`${base}?status=active&offset=500`, { headers: headers() });
  expect(second.headers.get('x-result-limit-reached')).toBe('false');
  const remainder = await second.json() as typeof rows;
  expect(remainder).toHaveLength(1);
  expect([...rows, ...remainder].map(row => row.obligation.id).sort()).toEqual(activeIds);
});
it('keeps historical reads bounded with an exact no-more flag at the page boundary', async () => {
  const response = await fetch(`${base}?status=completed`, { headers: headers() });
  expect(response.headers.get('x-result-limit-reached')).toBe('false');
  expect(await response.json()).toHaveLength(500);
});
it('rejects unknown status, invalid offset and organization overrides while preserving authentication', async () => {
  for (const query of ['status=unknown', 'offset=-1', 'offset=1.5', 'offset=100001', `organizationId=${foreignOrg}`]) {
    expect((await fetch(`${base}?${query}`, { headers: headers() })).status).toBe(400);
  }
  expect((await fetch(base)).status).toBe(401);
});
