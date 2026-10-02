import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import Appointments from './appointments';
import ServiceDesk from './service-desk';
import { renderWithQuery } from '@/test/render';
import { mockApi, sampleAppointment } from '@/test/mock-api';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const initial = { ...sampleAppointment, contactId: 'contact-1', leadLabel: 'Alex HVAC Customer', leadId: null, notes: null, updatedAt: '2034-01-01T00:00:00.000Z' };
const service = (status: 'active' | 'completed' | 'cancelled') => ({
  obligation: { id: 'service-1', contactId: 'contact-1', kind: 'maintenance', equipmentLabel: 'Heat pump', dueAt: '2035-01-31T12:00:00.000Z', status, source: 'manual', appointmentId: null, updatedAt: '2034-01-01T00:00:00.000Z', recurrence: null, coverageStartsOn: '2034-01-01', coverageEndsOn: '2036-01-01', coverageEvidence: 'Agreement QA-1', completionNote: 'Office confirmed visit', completedAt: status === 'completed' ? '2035-01-31T13:00:00Z' : null },
  contact: { id: 'contact-1', firstName: 'Alex', lastName: 'Customer', email: null, phone: null },
  task: { status: status === 'completed' ? 'done' : 'cancelled', dueAt: null, assignedUserId: null },
});

describe('appointment review recovery', () => {
  it('names a customer-only appointment even without notes or a lead', async () => {
    mockApi('admin', { handler: (method, path) => method === 'GET' && path.endsWith('/appointments') ? Response.json([initial]) : undefined });
    renderWithQuery(<Appointments />);
    expect(await screen.findByText('Alex HVAC Customer')).toBeTruthy();
  });
  it.each(['stale', 'lost acknowledgement'])('refreshes and reviews %s without replaying the old status command', async failure => {
    let latest = initial;
    const fetchMock = mockApi('admin', { handler: (method, path) => {
      if (method === 'GET' && path.endsWith('/appointments')) return Response.json([latest]);
      if (method === 'PATCH' && path.endsWith(`/appointments/${initial.id}`)) {
        latest = { ...initial, status: failure === 'stale' ? 'confirmed' : 'cancelled', updatedAt: '2034-01-02T00:00:00.000Z' };
        return failure === 'stale' ? Response.json({ error: 'This record changed.', code: 'stale_update' }, { status: 409 }) : Response.json({ error: 'Response unavailable' }, { status: 503 });
      }
      return undefined;
    } });
    renderWithQuery(<Appointments />);
    fireEvent.change(await screen.findByTestId('appointment-status-select'), { target: { value: 'cancelled' } });
    const review = await screen.findByRole('button', { name: 'Refresh and review appointment' });
    expect(screen.queryByRole('button', { name: /retry/i })).toBeNull();
    fireEvent.click(review);
    const dialog = await screen.findByRole('dialog', { name: 'Edit Appointment' });
    expect((within(dialog).getByRole('combobox', { name: 'Appointment status' }) as HTMLSelectElement).value).toBe(latest.status);
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'PATCH')).toHaveLength(1);
    expect(JSON.parse(String(fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH')?.[1]?.body))).toEqual({ status: 'cancelled', expectedUpdatedAt: initial.updatedAt });
  });
});

describe('service history and bounded active work', () => {
  it('requests active records separately and exposes completed evidence without edit controls', async () => {
    const fetchMock = mockApi('admin', { handler: (method, path, raw) => method === 'GET' && path.endsWith('/service-obligations') ? Response.json(new URL(raw!, 'https://local.test').searchParams.get('status') === 'completed' ? [service('completed')] : []) : undefined });
    renderWithQuery(<ServiceDesk />);
    expect(await screen.findByText('No active service dates yet.')).toBeTruthy();
    const calls = fetchMock.mock.calls.map(([url]) => String(url));
    expect(calls.some(url => url.includes('/service-obligations?status=active'))).toBe(true);
    fireEvent.change(screen.getByRole('combobox', { name: 'Service records' }), { target: { value: 'completed' } });
    expect(await screen.findByText('Office confirmed visit')).toBeTruthy();
    expect(screen.getByText('Agreement QA-1')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Manage service' })).toBeNull();
    expect(screen.queryByRole('button', { name: /reopen/i })).toBeNull();
  });
  it('requires an explicit version-checked cancelled reopening and explains approval reset', async () => {
    let saved = false;
    const item = service('cancelled');
    const fetchMock = mockApi('admin', { handler: (method, path, raw) => {
      if (method === 'GET' && path.endsWith('/service-obligations')) return Response.json(!saved && new URL(raw!, 'https://local.test').searchParams.get('status') === 'cancelled' ? [item] : []);
      if (method === 'PATCH' && path.endsWith('/service-obligations/service-1')) { saved = true; return Response.json({ ...item.obligation, status: 'active', recurrence: null }); }
      return undefined;
    } });
    renderWithQuery(<ServiceDesk />); await screen.findByText('No active service dates yet.');
    fireEvent.change(screen.getByRole('combobox', { name: 'Service records' }), { target: { value: 'cancelled' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Review reopening' }));
    expect(screen.getByText(/recurrence approval is cleared/i)).toBeTruthy();
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'PATCH')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Reopen service' }));
    await waitFor(() => expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'PATCH')).toHaveLength(1));
    expect(JSON.parse(String(fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH')?.[1]?.body))).toEqual({ status: 'active', expectedUpdatedAt: item.obligation.updatedAt });
    expect(await screen.findByText(/Service reopened as a one-time follow-up/)).toBeTruthy();
  });
  it('keeps cancelled history read-only for viewers', async () => {
    mockApi('viewer', { handler: (method, path) => method === 'GET' && path.endsWith('/service-obligations') ? Response.json([service('cancelled')]) : undefined });
    renderWithQuery(<ServiceDesk />);
    fireEvent.change(await screen.findByRole('combobox', { name: 'Service records' }), { target: { value: 'cancelled' } });
    expect(await screen.findByText(/Heat pump/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /reopen/i })).toBeNull();
  });
  it('requires a new review after a stale reopen and never silently adopts its new version', async () => {
    let item = service('cancelled');
    let attempts = 0;
    const fetchMock = mockApi('admin', { handler: (method, path, raw) => {
      if (method === 'GET' && path.endsWith('/service-obligations')) return Response.json(new URL(raw!, 'https://local.test').searchParams.get('status') === 'cancelled' ? [item] : []);
      if (method === 'PATCH' && path.endsWith('/service-obligations/service-1')) {
        attempts += 1;
        item = { ...item, obligation: { ...item.obligation, updatedAt: '2034-01-02T00:00:00.000Z' } };
        return Response.json({ error: 'This record changed.', code: 'stale_update' }, { status: 409 });
      }
      return undefined;
    } });
    renderWithQuery(<ServiceDesk />); await screen.findByText('No active service dates yet.');
    fireEvent.change(screen.getByRole('combobox', { name: 'Service records' }), { target: { value: 'cancelled' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Review reopening' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reopen service' }));
    await screen.findByText(/Review the refreshed records/);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Reopen service' })).toBeNull());
    expect(attempts).toBe(1);
    fireEvent.click(await screen.findByRole('button', { name: 'Review reopening' }));
    expect(attempts).toBe(1);
    fireEvent.click(screen.getByRole('button', { name: 'Reopen service' }));
    await waitFor(() => expect(attempts).toBe(2));
    const patches = fetchMock.mock.calls.filter(([, init]) => init?.method === 'PATCH');
    expect(JSON.parse(String(patches[1][1]?.body)).expectedUpdatedAt).toBe('2034-01-02T00:00:00.000Z');
  });
  it('announces the cap and pages within the selected status', async () => {
    const fetchMock = mockApi('admin', { handler: (method, path) => method === 'GET' && path.endsWith('/service-obligations') ? Response.json([service('active')], { headers: { 'X-Result-Limit-Reached': 'true' } }) : undefined });
    renderWithQuery(<ServiceDesk />);
    expect(await screen.findByText(/More service records are available/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Next service page' }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).includes('status=active&offset=500'))).toBe(true));
  });
});
