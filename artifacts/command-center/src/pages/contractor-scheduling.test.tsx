import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import Appointments from '@/pages/appointments';
import ServiceObligationEditor, { type ServiceRow } from '@/components/service-obligation-editor';
import { renderWithQuery } from '@/test/render';
import { mockApi, sampleAppointment } from '@/test/mock-api';
import { localDateTime } from '@/lib/contractor-schedule';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const row: ServiceRow = { obligation: { id: 'synthetic-service', contactId: 'synthetic-contact', kind: 'maintenance', equipmentLabel: 'Heat pump', dueAt: '2035-01-31T12:00:00.000Z', status: 'active', source: 'manual', appointmentId: null, updatedAt: '2034-01-01T00:00:00.000Z', recurrence: null, coverageStartsOn: null, coverageEndsOn: null, coverageEvidence: null }, contact: { id: 'synthetic-contact', firstName: 'Synthetic', lastName: 'Customer', email: null, phone: null }, task: { status: 'open', dueAt: null, assignedUserId: null } };
describe('contractor schedule forms', () => {
  it('uses local wall time and sends explicit unassignment with the optimistic token', async () => {
    const item = { ...sampleAppointment, scheduledStart: '2035-07-01T14:00:00.000Z', scheduledEnd: '2035-07-01T15:00:00.000Z', assignedUserId: 'u1', updatedAt: '2034-01-01T00:00:00.000Z' };
    const fetchMock = mockApi('admin', { handler: (method, path) => path.endsWith('/appointments') && method === 'GET' ? Response.json([item]) : path.endsWith(`/appointments/${item.id}`) && method === 'PATCH' ? Response.json({ ...item, assignedUserId: null }) : undefined });
    renderWithQuery(<Appointments />);
    fireEvent.click(await screen.findByTestId('edit-appointment'));
    const start = document.querySelector('input[type="datetime-local"]') as HTMLInputElement; expect(start.value).toBe(localDateTime(item.scheduledStart));
    const selects = document.querySelectorAll('select'); const assignee = [...selects].find(select => [...select.options].some(option => option.text === '-- Unassigned --'))!;
    fireEvent.change(assignee, { target: { value: '' } }); fireEvent.click(screen.getByRole('button', { name: /save appt/i }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(true));
    const [, init] = fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH')!;
    expect(JSON.parse(String(init?.body))).toMatchObject({ assignedUserId: null, scheduledStart: item.scheduledStart, scheduledEnd: item.scheduledEnd, expectedUpdatedAt: item.updatedAt });
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
