import { randomUUID } from 'node:crypto';
import { appointmentsTable, contactsTable, db, leadsTable, organizationsTable, projectsTable, propertiesTable, usersTable, zapierCapabilityBindingsTable } from '@workspace/db';
import { eq } from 'drizzle-orm';
import { afterAll, expect, it, vi } from 'vitest';
import { deleteTestOrgs } from '../../test-helpers/delete-test-orgs';
import { setGeocoderForTests } from '../route-plan';
import { buildCrewDaySheetInput, rebuildZapierRequestInput } from './zapier-specialist-flows';

const orgs: string[] = [];
afterAll(async () => { setGeocoderForTests(undefined); await deleteTestOrgs(...orgs); });
async function fixture() {
  const [org] = await db.insert(organizationsTable).values({ name: 'Synthetic Crew Company', slug: randomUUID(), timezone: 'America/Los_Angeles' }).returning();
  orgs.push(org.id);
  const [user] = await db.insert(usersTable).values({ organizationId: org.id, role: 'owner', isActive: true, emailVerifiedAt: new Date() }).returning();
  const [contact] = await db.insert(contactsTable).values({ organizationId: org.id, firstName: 'Synthetic Crew Customer' }).returning();
  const [property] = await db.insert(propertiesTable).values({ organizationId: org.id, contactId: contact.id, addressLine1: '12 Synthetic Street', city: 'Example', state: 'CA', postalCode: '00000' }).returning();
  const [lead] = await db.insert(leadsTable).values({ organizationId: org.id, contactId: contact.id, propertyId: property.id }).returning();
  const config = { [`crew_phone_${user.id}`]: '+15555550123' };
  const [binding] = await db.insert(zapierCapabilityBindingsTable).values({ organizationId: org.id, capability: 'sched.sms.send', specialistId: 'sched', direction: 'write', zapierApp: 'Synthetic', zapierAppName: 'Synthetic', zapierAction: 'send', zapierActionName: 'Send', bindingConfig: config }).returning();
  const visit = (start: string, overrides = {}) => db.insert(appointmentsTable).values({ organizationId: org.id, assignedUserId: user.id, contactId: contact.id, propertyId: property.id, type: 'inspection', status: 'confirmed', scheduledStart: new Date(start), ...overrides }).returning();
  const job = (start: string, end: string, overrides = {}) => db.insert(projectsTable).values({ organizationId: org.id, leadId: lead.id, name: 'Synthetic booked job', crewUserIds: [user.id], status: 'scheduled', scheduledStart: new Date(start), scheduledEnd: new Date(end), ...overrides }).returning();
  return { org, user, contact, property, binding, visit, job };
}

it('uses the requested calendar month and includes actual booked jobs alongside appointments', async () => {
  const f = await fixture();
  await f.visit('2035-07-01T16:00:00Z');
  await f.job('2035-07-01T17:00:00Z', '2035-07-01T18:00:00Z');
  await f.visit('2035-08-01T16:00:00Z', { type: 'estimate_review' });
  await f.job('2035-07-02T17:00:00Z', '2035-07-02T18:00:00Z');
  const lookup = vi.fn(); setGeocoderForTests(lookup);
  const built = await buildCrewDaySheetInput(f.org.id, f.user.id, '2035-07-01');
  expect(built.jobs).toBe(2);
  expect(built.input.body).toContain('inspection');
  expect(built.input.body).toContain('job');
  expect(built.input.body).not.toContain('estimate');
  expect(lookup).not.toHaveBeenCalled();
});

it('uses the full 25-hour fall-back company day with exact exclusive next-midnight boundary', async () => {
  const f = await fixture();
  await f.visit('2026-11-01T06:59:59Z', { type: 'estimate_review' }); // Previous company date.
  await f.visit('2026-11-01T07:00:00Z');
  await f.visit('2026-11-02T07:59:59Z', { type: 'final_walkthrough' });
  await f.visit('2026-11-02T08:00:00Z', { type: 'production' }); // Next company date.
  const built = await buildCrewDaySheetInput(f.org.id, f.user.id, '2026-11-01');
  expect(built.jobs).toBe(2);
  expect(built.input.body).toContain('inspection');
  expect(built.input.body).toContain('final walkthrough');
  expect(built.input.body).not.toContain('estimate');
  expect(built.input.body).not.toContain('production');
});

it('marks a continuing multi-day job and excludes closed or other-crew jobs', async () => {
  const f = await fixture();
  await f.job('2035-06-30T17:00:00Z', '2035-07-02T18:00:00Z', { status: 'in_progress' });
  await f.job('2035-07-01T17:00:00Z', '2035-07-01T18:00:00Z', { status: 'completed' });
  await f.job('2035-07-01T18:00:00Z', '2035-07-01T19:00:00Z', { crewUserIds: [] });
  const built = await buildCrewDaySheetInput(f.org.id, f.user.id, '2035-07-01');
  expect(built.jobs).toBe(1);
  expect(built.input.body).toMatch(/continuing job/i);
});

it('rejects a foreign crew even when a legacy binding contains its phone', async () => {
  const local = await fixture(), foreign = await fixture();
  await db.update(zapierCapabilityBindingsTable).set({ bindingConfig: { [`crew_phone_${foreign.user.id}`]: '+15555550124' } }).where(eq(zapierCapabilityBindingsTable.id, local.binding.id));
  await expect(buildCrewDaySheetInput(local.org.id, foreign.user.id, '2035-07-01')).rejects.toMatchObject({ code: 'not_found' });
});

it('rejects missing crew phone and invalid calendar dates without building a message', async () => {
  const f = await fixture();
  await expect(buildCrewDaySheetInput(f.org.id, f.user.id, '2026-02-30')).rejects.toMatchObject({ code: 'invalid_input' });
  await db.update(zapierCapabilityBindingsTable).set({ bindingConfig: {} }).where(eq(zapierCapabilityBindingsTable.id, f.binding.id));
  await expect(buildCrewDaySheetInput(f.org.id, f.user.id, '2035-07-01')).rejects.toMatchObject({ code: 'invalid_input' });
});

it('masks malformed foreign customer/property parents in legacy appointments', async () => {
  const f = await fixture(), foreign = await fixture();
  await db.update(contactsTable).set({ firstName: 'PRIVATE FOREIGN CUSTOMER' }).where(eq(contactsTable.id, foreign.contact.id));
  await db.update(propertiesTable).set({ addressLine1: 'PRIVATE FOREIGN STREET' }).where(eq(propertiesTable.id, foreign.property.id));
  await f.visit('2035-07-01T16:00:00Z', { contactId: foreign.contact.id, propertyId: foreign.property.id });
  const built = await buildCrewDaySheetInput(f.org.id, f.user.id, '2035-07-01');
  expect(built.jobs).toBe(1);
  expect(built.input.body).not.toContain('PRIVATE FOREIGN');
  expect(built.input.body).toContain('Customer');
});

it('changes request identity for changed customer, address, or destination and preserves approval rebuilding', async () => {
  const f = await fixture();
  await f.visit('2035-07-01T16:00:00Z');
  const initial = await buildCrewDaySheetInput(f.org.id, f.user.id, '2035-07-01');
  expect(await buildCrewDaySheetInput(f.org.id, f.user.id, '2035-07-01')).toEqual(initial);
  const rebuilt = await rebuildZapierRequestInput({ capability: 'sched.sms.send', organizationId: f.org.id, idempotencyKey: initial.idempotencyKey } as Parameters<typeof rebuildZapierRequestInput>[0]);
  expect(rebuilt).toEqual(initial.input);
  await db.update(contactsTable).set({ firstName: 'Changed customer' }).where(eq(contactsTable.id, f.contact.id));
  const customer = await buildCrewDaySheetInput(f.org.id, f.user.id, '2035-07-01');
  expect(customer.idempotencyKey).not.toBe(initial.idempotencyKey);
  await db.update(propertiesTable).set({ addressLine1: 'Changed street' }).where(eq(propertiesTable.id, f.property.id));
  const address = await buildCrewDaySheetInput(f.org.id, f.user.id, '2035-07-01');
  expect(address.idempotencyKey).not.toBe(customer.idempotencyKey);
  await db.update(zapierCapabilityBindingsTable).set({ bindingConfig: { [`crew_phone_${f.user.id}`]: '+15555550125' } }).where(eq(zapierCapabilityBindingsTable.id, f.binding.id));
  const phone = await buildCrewDaySheetInput(f.org.id, f.user.id, '2035-07-01');
  expect(phone.idempotencyKey).not.toBe(address.idempotencyKey);
  expect(phone.idempotencyKey).toMatch(new RegExp(`^sched-daysheet:${f.user.id}:2035-07-01:`));
});

it('refuses an overlong complete sheet instead of silently omitting booked stops', async () => {
  const f = await fixture();
  for (let index = 0; index < 20; index++) await f.visit('2035-07-01T16:00:00Z');
  await expect(buildCrewDaySheetInput(f.org.id, f.user.id, '2035-07-01')).rejects.toMatchObject({ code: 'invalid_input', message: expect.stringMatching(/too long.*complete|complete.*too long/i) });
});
