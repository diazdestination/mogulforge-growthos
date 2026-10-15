import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import Appointments from '@/pages/appointments';
import ServiceObligationEditor, { type ServiceRow } from '@/components/service-obligation-editor';
import { renderWithQuery } from '@/test/render';
import { mockApi, sampleAppointment, sampleMe } from '@/test/mock-api';
import { makePolicyReadResult } from '@/test/scheduling-ui-fixtures';
import { schedulingPolicySchema, schedulingReviewContextSchema } from '@workspace/scheduling-core';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const row: ServiceRow = { obligation: { id: 'synthetic-service', contactId: 'synthetic-contact', kind: 'maintenance', equipmentLabel: 'Heat pump', dueAt: '2035-01-31T12:00:00.000Z', status: 'active', source: 'manual', appointmentId: null, updatedAt: '2034-01-01T00:00:00.000Z', recurrence: null, coverageStartsOn: null, coverageEndsOn: null, coverageEvidence: null }, contact: { id: 'synthetic-contact', firstName: 'Synthetic', lastName: 'Customer', email: null, phone: null }, task: { status: 'open', dueAt: null, assignedUserId: null } };
function appointmentSetup(held = false) {
  const organizationId = '11111111-1111-4111-8111-111111111111';
  const companyTimeZone = 'America/Los_Angeles';
  const item = { ...sampleAppointment, id: '22222222-2222-4222-8222-222222222222', organizationId, contactId: null, propertyId: null, createdAt: '2034-01-01T00:00:00.000Z', scheduledStart: '2035-07-01T14:00:00.000Z', scheduledEnd: '2035-07-01T15:00:00.000Z', assignedUserId: 'u1', updatedAt: '2034-01-01T00:00:00.000Z', schedulingEvidence: 'legacy', schedulingReservation: null, schedulingTargetFingerprint: 'b'.repeat(64), schedulingCompanyTimeZone: companyTimeZone, schedulingPolicyRevision: null };
  const value = makePolicyReadResult();
  const context = schedulingReviewContextSchema.parse({ ...value.context, organizationId, companyTimeZone, source: { sourceKind: 'unlinked_manual', leadId: null, contactId: null, propertyId: null, estimateId: null }, targetVersion: item.updatedAt, targetFingerprint: item.schedulingTargetFingerprint });
  const policy = schedulingPolicySchema.parse({ ...value.policy, timeZone: companyTimeZone });
  const fetch = mockApi('admin', { handler: (method, path) => {
    if (path.endsWith('/me')) return Response.json({ ...sampleMe('admin'), organization: { id: organizationId, name: 'Synthetic company', slug: 'synthetic', timezone: companyTimeZone } });
    if (path.endsWith('/users')) return Response.json([{ id: 'u1', firstName: 'Test', lastName: 'User', role: 'office', isActive: true, operationallyEligible: true }]);
    if (path.endsWith('/scheduling/review-context')) return held ? Response.json({ error: 'Current source unavailable' }, { status: 503 }) : Response.json(context);
    if (path.endsWith('/settings/scheduling-policy')) return held ? Response.json({ error: 'Current policy unavailable' }, { status: 503 }) : Response.json({ policy, context: schedulingReviewContextSchema.parse({ ...context, source: null, inspection: null, applicableRules: { ...context.applicableRules, inspectionCeiling: null }, targetVersion: null, targetFingerprint: null }) });
    if (path.endsWith('/appointments') && method === 'GET') return Response.json([item]);
    if (path.endsWith(`/appointments/${item.id}`) && method === 'PATCH') return Response.json({ ...item, assignedUserId: null });
  } });
  renderWithQuery(<Appointments />);
  return { fetch, item, context };
}
describe('contractor schedule forms', () => {
  it('uses company wall time and sends explicit unassignment with the optimistic token', async () => {
    const { fetch: fetchMock, item } = appointmentSetup();
    fireEvent.click(await screen.findByTestId('edit-appointment'));
    await waitFor(() => expect(screen.getByLabelText('Service start')).toHaveProperty('disabled', false));
    expect(screen.getByLabelText('Service start')).toHaveProperty('value', '2035-07-01T07:00');
    expect(screen.getByLabelText('Service end')).toHaveProperty('value', '2035-07-01T08:00');
    expect(screen.getByText(/Company time zone: America\/Los_Angeles/)).toBeTruthy();
    fireEvent.click(within(screen.getByRole('group', { name: 'Assigned resources' })).getByRole('checkbox', { name: 'Test User' }));
    fireEvent.click(screen.getByRole('button', { name: /save appt/i }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(true));
    const [, init] = fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH')!;
    const body = JSON.parse(String(init?.body));
    expect(body).toEqual({ notes: item.notes, assignedUserId: null, expectedUpdatedAt: item.updatedAt, expectedTargetFingerprint: item.schedulingTargetFingerprint });
    for (const key of ['scheduledStart', 'scheduledEnd', 'contactId', 'leadId', 'propertyId', 'type', 'status', 'schedulingReview']) expect(body).not.toHaveProperty(key);
  });
  it('keeps proven pure unassignment eligible when current scheduling reads fail', async () => {
    const { fetch, item } = appointmentSetup(true);
    fireEvent.click(await screen.findByTestId('edit-appointment'));
    expect(await screen.findByText('Current scheduling review is unavailable. Refresh before changing the schedule.')).toBeTruthy();
    expect(screen.getByLabelText('Service start')).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByRole('button', { name: 'Remove assigned resource' }));
    fireEvent.click(screen.getByRole('button', { name: /save appt/i }));
    await waitFor(() => expect(fetch.mock.calls.filter(([, init]) => init?.method === 'PATCH')).toHaveLength(1));
    const [, init] = fetch.mock.calls.find(([, init]) => init?.method === 'PATCH')!;
    const body = JSON.parse(String(init?.body));
    expect(body).toEqual({ notes: item.notes, assignedUserId: null, expectedUpdatedAt: item.updatedAt, expectedTargetFingerprint: item.schedulingTargetFingerprint });
    for (const key of ['scheduledStart', 'scheduledEnd', 'contactId', 'leadId', 'propertyId', 'type', 'status', 'schedulingReview']) expect(body).not.toHaveProperty(key);
  });
  it('requires fresh company-zone review for a material start change while retaining explicit unassignment and optimistic proof', async () => {
    const { fetch, item, context } = appointmentSetup();
    fireEvent.click(await screen.findByTestId('edit-appointment'));
    await waitFor(() => expect(screen.getByLabelText('Service start')).toHaveProperty('disabled', false));
    fireEvent.change(screen.getByLabelText('Service start'), { target: { value: '2035-07-01T09:00' } });
    expect(screen.getByLabelText('Service end')).toHaveProperty('value', '2035-07-01T10:00');
    fireEvent.click(within(screen.getByRole('group', { name: 'Assigned resources' })).getByRole('checkbox', { name: 'Test User' }));
    expect(screen.getByRole('button', { name: /save appt/i })).toHaveProperty('disabled', true);
    expect(fetch.mock.calls.filter(([, init]) => init?.method === 'PATCH')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Review interval' }));
    fireEvent.click(screen.getByRole('button', { name: /save appt/i }));
    await waitFor(() => expect(fetch.mock.calls.filter(([, init]) => init?.method === 'PATCH')).toHaveLength(1));
    const [, init] = fetch.mock.calls.find(([, init]) => init?.method === 'PATCH')!;
    expect(JSON.parse(String(init?.body))).toMatchObject({ assignedUserId: null, scheduledStart: '2035-07-01T16:00:00.000Z', scheduledEnd: '2035-07-01T17:00:00.000Z', expectedUpdatedAt: item.updatedAt, expectedTargetFingerprint: item.schedulingTargetFingerprint, schedulingReview: { context, startWallTime: { timeZone: 'America/Los_Angeles', offset: '-07:00' } } });
  });
  it('keeps input visible when a concurrent office save is rejected', async () => {
    mockApi('admin', { handler: (method, path) => method === 'PATCH' && path.includes('/service-obligations/') ? Response.json({ error: 'This record changed. Refresh it before saving again.' }, { status: 409 }) : undefined });
    const onSaved = vi.fn(); renderWithQuery(<ServiceObligationEditor row={row} onSaved={onSaved} onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText('Service due date'), { target: { value: '2035-02-15' } }); fireEvent.click(screen.getByRole('button', { name: 'Save service details' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('This record changed'));
    expect((screen.getByLabelText('Service due date') as HTMLInputElement).value).toBe('2035-02-15'); expect(onSaved).not.toHaveBeenCalled();
  });
  it('sends only explicit recurrence approval and displays the next-task receipt', async () => {
    const fetchMock = mockApi('admin', { handler: (method, path) => method === 'POST' && path.endsWith('/recurrence') ? Response.json({ ...row.obligation, recurrence: {} }) : method === 'PATCH' && path.includes('/service-obligations/') ? Response.json({ ...row.obligation, nextObligationId: 'synthetic-next' }) : undefined });
    const onSaved = vi.fn().mockResolvedValue(undefined); renderWithQuery(<ServiceObligationEditor row={row} onSaved={onSaved} onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText('Customer agreement evidence'), { target: { value: 'Synthetic signed semiannual agreement' } }); fireEvent.click(screen.getByRole('button', { name: 'Approve recurring task' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(expect.stringContaining('Recurring staff task approved')));
    const call = fetchMock.mock.calls.find(([url, init]) => String(url).endsWith('/recurrence') && init?.method === 'POST')!;
    expect(JSON.parse(String(call[1]?.body))).toEqual({ expectedUpdatedAt: row.obligation.updatedAt, intervalMonths: 6, endDate: null, agreementNote: 'Synthetic signed semiannual agreement' });
    fireEvent.click(screen.getByRole('button', { name: 'Mark serviced' })); await waitFor(() => expect(onSaved).toHaveBeenCalledWith(expect.stringContaining('One next agreed service task')));
  });
  it('fetches a bounded appointment window and announces a capped result', async () => {
    const fetchMock = mockApi('admin', { handler: (method, path) => method === 'GET' && path.endsWith('/appointments') ? Response.json(Array.from({ length: 200 }, (_, index) => ({ ...sampleAppointment, id: `synthetic-${index}` }))) : undefined });
    renderWithQuery(<Appointments />); expect(await screen.findByText(/Showing the first 200/)).toBeTruthy();
    const url = String(fetchMock.mock.calls.find(([url]) => String(url).includes('/appointments?'))?.[0]); expect(url).toContain('from='); expect(url).toContain('to=');
  });
});
