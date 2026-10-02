import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { LeadAlertRouting } from './lead-alert-routing';
import { renderWithQuery } from '@/test/render';
import { mockApi } from '@/test/mock-api';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const team = [
  { id: 'staff-a', firstName: 'Alex', role: 'owner', isActive: true },
  { id: 'staff-b', firstName: 'Blair', role: 'office', isActive: true },
  { id: 'inactive', firstName: 'Inactive', role: 'owner', isActive: false },
  { id: 'viewer', firstName: 'Reader', role: 'viewer', isActive: true },
];
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('requires explicit active recipients and saves exact daytime and after-hours choices', async () => {
  const calls = mockApi('owner', { handler: (method, path) => {
    if (path.endsWith('/users')) return json(team);
    if (path.endsWith('/staff-push/policy')) return json({ policy: null });
    return undefined;
  } });
  renderWithQuery(<LeadAlertRouting />);
  const regularA = await screen.findByLabelText('During business hours: Alex');
  expect(screen.queryByLabelText(/Inactive/)).toBeNull();
  expect(screen.queryByLabelText(/Reader/)).toBeNull();
  expect(screen.getByRole('button', { name: 'Save lead-alert routing' }).hasAttribute('disabled')).toBe(true);
  fireEvent.click(regularA);
  fireEvent.click(screen.getByLabelText('During business hours: Blair'));
  fireEvent.click(screen.getByLabelText('After hours and closed days: Alex'));
  fireEvent.click(screen.getByLabelText('Saturday'));
  fireEvent.click(screen.getByLabelText('Route new-lead notifications to the selected staff'));
  fireEvent.click(screen.getByRole('button', { name: 'Save lead-alert routing' }));
  await waitFor(() => expect(calls.mock.calls.some(([url, init]) => String(url).endsWith('/staff-push/policy') && init?.method === 'PUT')).toBe(true));
  const saved = calls.mock.calls.find(([, init]) => init?.method === 'PUT')![1];
  expect(JSON.parse(saved?.body as string)).toEqual({
    enabled: true, serviceAlertsEnabled: false, timezone: 'America/New_York', days: [1, 2, 3, 4, 5, 6], opensAt: '09:00', closesAt: '18:00',
    businessHoursUserIds: ['staff-a', 'staff-b'], afterHoursUserIds: ['staff-a'],
  });
  expect(saved?.credentials).toBe('include');
  expect(saved?.cache).toBe('no-store');
});

it('does not replace a failed policy load with a savable default', async () => {
  mockApi('owner', { handler: (_method, path) => {
    if (path.endsWith('/users')) return json(team);
    if (path.endsWith('/staff-push/policy')) return json({ error: 'unavailable' }, 503);
    return undefined;
  } });
  renderWithQuery(<LeadAlertRouting />);
  await screen.findByText(/Could not load routing/);
  expect(screen.getByRole('button', { name: 'Save lead-alert routing' }).hasAttribute('disabled')).toBe(true);
  expect(screen.queryByText(/No alert routing has been saved/)).toBeNull();
});

it('flags unavailable saved responders and requires their removal before changes are saved', async () => {
  mockApi('owner', { handler: (_method, path) => {
    if (path.endsWith('/users')) return json(team);
    if (path.endsWith('/staff-push/policy')) return json({ policy: {
      enabled: true, timezone: 'America/New_York', days: [1], opensAt: '09:00', closesAt: '18:00',
      businessHoursUserIds: ['staff-a'], afterHoursUserIds: ['inactive'],
    } });
    return undefined;
  } });
  renderWithQuery(<LeadAlertRouting />);
  await screen.findByText(/A saved responder/);
  fireEvent.click(screen.getByRole('button', { name: 'Remove unavailable responders' }));
  expect(screen.getByRole('button', { name: 'Save lead-alert routing' }).hasAttribute('disabled')).toBe(true);
  fireEvent.click(screen.getByLabelText('After hours and closed days: Alex'));
  expect(screen.getByRole('button', { name: 'Save lead-alert routing' }).hasAttribute('disabled')).toBe(false);
});
