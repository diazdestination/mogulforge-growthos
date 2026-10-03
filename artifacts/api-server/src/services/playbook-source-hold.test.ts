import { randomUUID } from 'node:crypto';
import {
  auditEventsTable, consentRecordsTable, contactsTable, db, DEFAULT_SENDING_HOURS,
  leadsTable, organizationsTable, playbookEnrollmentsTable, playbooksTable,
  scheduledActionsTable, usersTable, type EnrollmentHistoryEntry,
} from '@workspace/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { deleteTestOrgs } from '../test-helpers/delete-test-orgs';

const email = vi.hoisted(() => ({ status: vi.fn(), send: vi.fn() }));
const effects = vi.hoisted(() => ({ draft: vi.fn(), sms: vi.fn() }));
vi.mock('./user-email', async (original) => ({
  ...await original<typeof import('./user-email')>(),
  getUserEmailStatus: email.status, sendEmailForUser: email.send,
}));
vi.mock('./providers', async (original) => {
  const actual = await original<typeof import('./providers')>();
  return { ...actual, draftOutreachMessage: effects.draft, providers: { ...actual.providers, sms: { ...actual.providers.sms, send: effects.sms } } };
});
import { executePlaybookStep, resumeEnrollment } from './playbooks';
import { updateOrgSettings } from './settings';

let orgId: string, otherOrgId: string, senderId: string;
beforeAll(async () => {
  const nonce = randomUUID();
  [orgId, otherOrgId] = (await db.insert(organizationsTable).values([
    { name: 'Source hold', slug: `source-hold-${nonce}` },
    { name: 'Source hold other', slug: `source-hold-other-${nonce}` },
  ]).returning()).map((row) => row.id);
  const [sender] = await db.insert(usersTable).values({ organizationId: orgId, email: `source-hold-${nonce}@example.test`, role: 'owner' }).returning();
  senderId = sender.id;
  await updateOrgSettings(orgId, { sendingHours: { ...DEFAULT_SENDING_HOURS, quietHoursEnabled: false, maxTouchesPerDay: 0 } });
});
beforeEach(() => {
  vi.clearAllMocks();
  email.status.mockResolvedValue({ configured: true, connected: true, senderActive: true, provider: 'gmail', email: 'synthetic-sender@example.test' });
  email.send.mockResolvedValue({ id: 'synthetic-playbook-message', provider: 'gmail', senderEmail: 'synthetic-sender@example.test' });
  effects.draft.mockResolvedValue({ body: 'Synthetic approved test message' });
  effects.sms.mockResolvedValue({ id: 'synthetic-sms', provider: 'mock-sms' });
});
afterAll(async () => { await deleteTestOrgs(orgId, otherOrgId); });

async function fixture(channel: 'email' | 'sms', stepIndex = 0, creationMethod = 'import', contactId?: string) {
  if (!contactId) {
    const [contact] = await db.insert(contactsTable).values({ organizationId: orgId, firstName: 'Synthetic', email: `${randomUUID()}@example.test`, phone: '+15555550147' }).returning();
    contactId = contact.id;
    await db.insert(consentRecordsTable).values({ organizationId: orgId, contactId, channel: 'sms', granted: true, disclosureVersion: 'synthetic-test' });
  }
  const [lead] = await db.insert(leadsTable).values({ organizationId: orgId, contactId, assignedUserId: senderId, creationMethod, status: 'follow_up' }).returning();
  const [playbook] = await db.insert(playbooksTable).values({ organizationId: orgId, name: 'Synthetic source hold', category: 'reactivation', steps: [
    { channel, delayMinutes: 0, prompt: 'Synthetic first step' },
    { channel, delayMinutes: 30, prompt: 'Synthetic second step' },
  ] }).returning();
  const history: EnrollmentHistoryEntry[] = stepIndex ? [{ at: '2025-01-01T00:00:00.000Z', kind: 'sent', stepIndex: 0, channel, detail: 'Existing history must remain unchanged' }] : [];
  const [enrollment] = await db.insert(playbookEnrollmentsTable).values({ organizationId: orgId, playbookId: playbook.id, leadId: lead.id, category: 'reactivation', currentStep: stepIndex, history, nextRunAt: new Date() }).returning();
  await db.insert(scheduledActionsTable).values({ organizationId: orgId, action: { type: 'playbook_step', params: { enrollmentId: enrollment.id, stepIndex } }, context: { leadId: lead.id }, runAt: new Date() });
  return { enrollment, lead, history, contactId };
}
async function stored(enrollmentId: string) {
  return (await db.select().from(playbookEnrollmentsTable).where(eq(playbookEnrollmentsTable.id, enrollmentId)))[0];
}
const expectNoEffect = () => {
  expect(email.send).not.toHaveBeenCalled();
  expect(email.status).not.toHaveBeenCalled();
  expect(effects.sms).not.toHaveBeenCalled();
  expect(effects.draft).not.toHaveBeenCalled();
};

describe('existing playbook enrollment source-review hold', () => {
  it.each([{ channel: 'email' as const, stepIndex: 0 }, { channel: 'sms' as const, stepIndex: 1 }])('pauses $channel at step $stepIndex without advancing, completing or altering prior history', async ({ channel, stepIndex }) => {
    const { enrollment, lead, history } = await fixture(channel, stepIndex);
    expect(await executePlaybookStep(orgId, { enrollmentId: enrollment.id, stepIndex })).toEqual({ status: 'skipped', detail: 'paused: imported_source_requires_current_review' });
    const saved = await stored(enrollment.id);
    expect(saved).toMatchObject({ status: 'paused', currentStep: stepIndex, nextRunAt: null, pauseReason: 'Imported source needs current review before outreach' });
    expect(saved.history.slice(0, history.length)).toEqual(history);
    expect(saved.history).toHaveLength(history.length + 1);
    expect(saved.history.at(-1)).toMatchObject({ kind: 'paused', stepIndex, channel });
    const queue = await db.select().from(scheduledActionsTable).where(and(eq(scheduledActionsTable.organizationId, orgId), eq(scheduledActionsTable.context, { leadId: lead.id })));
    expect(queue).toHaveLength(1);
    expect(queue[0].action.params).toMatchObject({ stepIndex });
    const audits = await db.select().from(auditEventsTable).where(and(eq(auditEventsTable.organizationId, orgId), eq(auditEventsTable.entityId, lead.id), eq(auditEventsTable.action, 'send.blocked')));
    expect(audits.some((audit) => audit.metadata.reason === 'imported_source_requires_current_review')).toBe(true);
    expectNoEffect();
    expect(await executePlaybookStep(orgId, { enrollmentId: enrollment.id, stepIndex })).toMatchObject({ detail: 'enrollment paused' });
    expect((await stored(enrollment.id)).history).toEqual(saved.history);
  });
  it('cannot bypass source review by resuming the held sequence', async () => {
    const { enrollment } = await fixture('email');
    await executePlaybookStep(orgId, { enrollmentId: enrollment.id, stepIndex: 0 });
    expect(await resumeEnrollment(orgId, enrollment.id)).toMatchObject({ status: 'active', currentStep: 0 });
    await executePlaybookStep(orgId, { enrollmentId: enrollment.id, stepIndex: 0 });
    expect(await stored(enrollment.id)).toMatchObject({ status: 'paused', currentStep: 0 });
    expectNoEffect();
  });
  it.each(['missing email', 'missing SMS consent'])('preserves imported work even when the earlier channel gate reports %s', async (condition) => {
    const { enrollment, contactId } = await fixture(condition === 'missing email' ? 'email' : 'sms');
    if (condition === 'missing email') {
      await db.update(contactsTable).set({ email: null }).where(eq(contactsTable.id, contactId));
    } else {
      await db.delete(consentRecordsTable).where(and(eq(consentRecordsTable.organizationId, orgId), eq(consentRecordsTable.contactId, contactId)));
    }
    expect(await executePlaybookStep(orgId, { enrollmentId: enrollment.id, stepIndex: 0 })).toMatchObject({ detail: 'paused: imported_source_requires_current_review' });
    expect(await stored(enrollment.id)).toMatchObject({ status: 'paused', currentStep: 0, nextRunAt: null });
    expectNoEffect();
  });
  it('preserves permanent do-not-contact stopping without consuming the imported step', async () => {
    const { enrollment, contactId } = await fixture('email');
    await db.update(contactsTable).set({ doNotContact: true }).where(eq(contactsTable.id, contactId));
    expect(await executePlaybookStep(orgId, { enrollmentId: enrollment.id, stepIndex: 0 })).toMatchObject({ detail: 'blocked: do_not_contact' });
    expect(await stored(enrollment.id)).toMatchObject({ status: 'stopped', currentStep: 0, nextRunAt: null });
    expectNoEffect();
  });
  it('does not mutate an enrollment reached through a different tenant', async () => {
    const { enrollment } = await fixture('email');
    expect(await executePlaybookStep(otherOrgId, { enrollmentId: enrollment.id, stepIndex: 0 })).toMatchObject({ detail: 'enrollment not found' });
    expect(await stored(enrollment.id)).toMatchObject({ status: 'active', currentStep: 0, history: [] });
    expectNoEffect();
  });
  it('still executes a separately identified fresh inquiry for the same contact', async () => {
    const imported = await fixture('email');
    const fresh = await fixture('email', 0, 'form', imported.contactId);
    expect(await executePlaybookStep(orgId, { enrollmentId: fresh.enrollment.id, stepIndex: 0 })).toEqual({ status: 'success', detail: 'email:gmail' });
    expect(await stored(fresh.enrollment.id)).toMatchObject({ status: 'active', currentStep: 1 });
    expect(email.send).toHaveBeenCalledTimes(1);
    expect(effects.draft).toHaveBeenCalledTimes(1);
    expect(effects.sms).not.toHaveBeenCalled();
  });
});
