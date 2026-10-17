import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { writeFile, mkdir } from 'node:fs/promises';
import { beforeAll, afterAll, it, expect, vi } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { eq } from 'drizzle-orm';
import { db, organizationsTable, usersTable, appointmentsTable, projectsTable, contactsTable, leadsTable, customerWorkRootsTable } from '@workspace/db';
import app from '../app';
import { readNativeProject } from './returning-customer';
import { createSession } from '../lib/auth';
import { deleteTestOrgs } from '../test-helpers/delete-test-orgs';
import { projectSchedulingEvidence, saveSchedulingPolicy } from './scheduling-policy';
import { callieOfficeFixture } from '../test-helpers/callie-office-fixture';
import { createServiceObligation } from './service-obligations';
import { getServiceCare, recordServiceCareResponse } from './service-care';
let server: Server, origin: string;
const orgs: string[] = [];
beforeAll(async () => { vi.stubEnv('APP_ORIGIN', 'https://growth.example'); server = await new Promise<Server>(done => { const s = app.listen(0, '127.0.0.1', () => done(s)); }); origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; });
afterAll(async () => { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); await deleteTestOrgs(...orgs); vi.unstubAllEnvs(); });
it.each([
  ['appointment', 'notes', false], ['appointment', 'notes', true], ['appointment', 'confirmation', true], ['appointment', 'closure', true],
  ['project', 'notes', true], ['project', 'closure', true], ['project', 'release', true], ['returning', 'notes', true], ['returning', 'release', true], ['returning', 'explain', true],
] as const)('real %s host preserves %s legacyNull=%s', async (kind, scenario, legacyNull) => {
  const [org] = await db.insert(organizationsTable).values({ name: 'Synthetic bridge', slug: `host-bridge-${randomUUID()}`, timezone: 'UTC' }).returning(); orgs.push(org.id);
  const [owner] = await db.insert(usersTable).values({ organizationId: org.id, role: 'owner', emailVerifiedAt: new Date() }).returning();
  const [staff, otherStaff] = await db.insert(usersTable).values([0,1].map(() => ({ organizationId: org.id, role: 'production' as const, isActive: false, emailVerifiedAt: new Date() }))).returning();
  const [contact] = await db.insert(contactsTable).values({ organizationId: org.id, firstName: 'Synthetic bridge customer' }).returning();
  const [lead] = await db.insert(leadsTable).values({ organizationId: org.id, contactId: contact.id }).returning();
  const dates = { scheduledStart: new Date('2020-01-01T10:00:00.123Z'), scheduledEnd: legacyNull ? null : new Date('2020-01-01T12:00:00.123Z') };
  const [workRoot] = kind === 'returning' ? await db.insert(customerWorkRootsTable).values({ organizationId: org.id, contactId: contact.id, createdByUserId: owner.id }).returning() : [];
  const [row] = kind === 'appointment' ? await db.insert(appointmentsTable).values({ organizationId: org.id, contactId: contact.id, type: 'other', status: 'scheduled', assignedUserId: staff.id, ...dates }).returning() : await db.insert(projectsTable).values({ organizationId: org.id, leadId: kind === 'returning' ? null : lead.id, ...(workRoot ? { customerWorkId: workRoot.id, workVersion: 1 } : {}), name: 'Synthetic bridge project', status: 'scheduled', crewUserIds: [staff.id, otherStaff.id], ...dates }).returning();
  let neighborId;
  if (scenario === 'explain') {
    await saveSchedulingPolicy({ organizationId: org.id, userId: owner.id }, { expectedRevision: 0, expectedCompanyTimeZone: 'UTC', enabled: true, minimumTravelGapMinutes: 60, maxConcurrentReservations: 2, durationPresets: [] });
    const [neighbor] = await db.insert(appointmentsTable).values({ organizationId: org.id, assignedUserId: staff.id, type: 'other', scheduledStart: new Date('2035-01-01T10:30:00Z'), scheduledEnd: new Date('2035-01-01T11:30:00Z') }).returning(); neighborId = neighbor.id;
  }
  const sid = await createSession({ user: { id: owner.id, email: owner.email, firstName: null, lastName: null, profileImageUrl: null }, access_token: 'synthetic-session' });
  const fixture = { origin, sid, kind, scenario, neighborId, row: kind === 'returning' ? { ...await readNativeProject(db, org.id, row.id), ...projectSchedulingEvidence('project', row) } : { ...row, ...projectSchedulingEvidence(kind, row) }, users: [staff, otherStaff], lead, contact, profile: { id: owner.id, email: owner.email, firstName: null, lastName: null, role: 'owner', isActive: true, organization: { id: org.id, name: org.name, slug: org.slug, timezone: org.timezone } } };
  await runHost(fixture);
  const [after] = kind === 'appointment' ? await db.select().from(appointmentsTable).where(eq(appointmentsTable.id, row.id)) : await db.select().from(projectsTable).where(eq(projectsTable.id, row.id));
  expect(after.scheduledStart).toEqual(row.scheduledStart); expect(after.scheduledEnd).toEqual(row.scheduledEnd); expect(after.schedulingReservation).toEqual(row.schedulingReservation);
});


async function runHost(fixture: any) {
  const root = resolve('../..');
  let result;
  try { result = await promisify(execFile)(process.execPath, [resolve(root, 'artifacts/command-center/node_modules/vitest/vitest.mjs'), 'run', '--config', 'src/test/scheduling-host-api-bridge.config.ts', '--pool=threads', '--maxWorkers=1'], { cwd: resolve(root, 'artifacts/command-center'), env: { ...process.env, SCHEDULING_HOST_API_FIXTURE: JSON.stringify(fixture) }, windowsHide: true, timeout: 15000, maxBuffer: 3_000_000 }); }
  catch (error: any) { result = error; }
  await mkdir(resolve(root, 'work/task12-final-corrections'), { recursive: true });
  await writeFile(resolve(root, `work/task12-final-corrections/bridge-${fixture.kind}-${fixture.scenario}-${randomUUID()}.log`), String(result.stdout ?? '') + String(result.stderr ?? ''));
  expect(result.killed ?? false, String(result.stderr)).toBe(false);
  expect(result.signal ?? null).toBeNull();
  expect(result.code ?? 0, String(result.stdout) + String(result.stderr)).toBe(0);
}

it.each(['appointment', 'project', 'care', 'callie'] as const)('real %s host shifts a manual create and displays a current authorized conflict', async (kind) => {
  let org, owner, staff, contact, sourceId;
  if (kind === 'callie') {
    const f = await callieOfficeFixture(true); orgs.push(f.org);
    [org] = await db.update(organizationsTable).set({ timezone: 'UTC' }).where(eq(organizationsTable.id, f.org)).returning(); owner = f.owner; staff = f.office; contact = f.contact; sourceId = f.intake.id;
  } else {
    [org] = await db.insert(organizationsTable).values({ name: 'Synthetic create bridge', slug: `create-bridge-${randomUUID()}`, timezone: 'UTC' }).returning(); orgs.push(org.id);
    [owner, staff] = await db.insert(usersTable).values([{ organizationId: org.id, role: 'owner', emailVerifiedAt: new Date() }, { organizationId: org.id, role: 'office', emailVerifiedAt: new Date(), firstName: 'Synthetic technician' }]).returning();
    [contact] = await db.insert(contactsTable).values({ organizationId: org.id, firstName: 'Synthetic bridge customer' }).returning();
    if (kind === 'care') {
      const obligation = await createServiceObligation(org.id, owner.id, { contactId: contact.id, kind: 'maintenance', equipmentLabel: 'Synthetic unit', dueDate: '2035-01-01', noticeDays: 14, assignedUserId: staff.id });
      if ('error' in obligation) throw Error(obligation.error); sourceId = obligation.id;
      const care = await getServiceCare(org.id, sourceId);
      await recordServiceCareResponse(org.id, owner.id, sourceId, { requestId: randomUUID(), expectedUpdatedAt: care.expectedUpdatedAt, channel: 'phone', outcome: 'ready_to_book', respondedAt: new Date(Date.now()-1000).toISOString(), note: 'Synthetic customer agreed to arranging this visit.', staffAttested: true });
    }
  }
  const [lead] = await db.insert(leadsTable).values({ organizationId: org.id, contactId: contact.id }).returning();
  const actor = { organizationId: org.id, userId: owner.id };
  await saveSchedulingPolicy(actor, { expectedRevision: 0, expectedCompanyTimeZone: 'UTC', enabled: true, minimumTravelGapMinutes: 60, maxConcurrentReservations: 2, durationPresets: [] });
  const [neighbor] = await db.insert(appointmentsTable).values({ organizationId: org.id, assignedUserId: staff.id, type: 'other', scheduledStart: new Date('2035-01-01T10:30:00Z'), scheduledEnd: new Date('2035-01-01T11:30:00Z'), notes: 'Private adjacent notes must not appear' }).returning();
  const sid = await createSession({ user: { id: owner.id, email: owner.email, firstName: null, lastName: null, profileImageUrl: null }, access_token: 'synthetic-session' });
  await runHost({ kind, scenario: 'create', origin, sid, row: null, users: [staff], lead, contact, sourceId, neighborId: neighbor.id, profile: { id: owner.id, email: owner.email, firstName: null, lastName: null, role: 'owner', isActive: true, organization: { id: org.id, name: org.name, slug: org.slug, timezone: 'UTC' } } });
  const saved = kind === 'project' ? await db.select().from(projectsTable).where(eq(projectsTable.organizationId, org.id)) : (await db.select().from(appointmentsTable).where(eq(appointmentsTable.organizationId, org.id))).filter(row => row.id !== neighbor.id);
  expect(saved).toHaveLength(1);
  expect(saved[0].scheduledStart?.toISOString()).toBe('2035-01-01T13:00:00.000Z');
  expect(saved[0].scheduledEnd?.toISOString()).toBe('2035-01-01T14:00:00.000Z');
  expect(saved[0].schedulingReservation).toMatchObject({ duration: { kind: 'explicit', preset: null } });
});
