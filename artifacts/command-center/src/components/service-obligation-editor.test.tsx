import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import ServiceObligationEditor, { type ServiceRow } from './service-obligation-editor';
import { mockApi } from '@/test/mock-api';
import { renderWithQuery } from '@/test/render';
import { contactId, scopeKey, serviceId, standingView, versionTime } from '@/test/service-standing-fixtures';

const row = (): ServiceRow => ({ obligation: { id: serviceId, contactId, kind: 'maintenance', equipmentLabel: 'Fictional heat pump', dueAt: '2035-01-01T12:00:00.000Z', status: 'active', source: 'manual', appointmentId: null, updatedAt: versionTime, recurrence: standingView().sourceSummary.recurrence, coverageStartsOn: null, coverageEndsOn: null, coverageEvidence: null }, contact: { id: contactId, firstName: 'Fictional', lastName: 'Customer', email: 'customer@example.invalid', phone: '+15005550006' }, task: { status: 'open', dueAt: null, assignedUserId: 'staff' } });
function setup(handler?: (method: string, path: string) => Response | undefined) {
  return mockApi('office', { handler: (method, path) => path.endsWith('/users') ? Response.json([{ id: 'staff', firstName: 'Accepted', lastName: 'Technician', role: 'office', isActive: true, operationallyEligible: true }, { id: 'invite:pending', firstName: 'Unaccepted', role: 'office', isActive: true, operationallyEligible: false }]) : handler?.(method, path) });
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('keeps canonical accepted ownership and recurring task approval separate from standing message authority', async () => {
  setup(); renderWithQuery(<ServiceObligationEditor row={row()} scopeKey={scopeKey} onSaved={vi.fn(async () => {})} onClose={vi.fn()} />);
  expect(await screen.findByRole('option', { name: 'Accepted Technician' })).toBeTruthy();
  expect(screen.queryByRole('option', { name: 'Unaccepted' })).toBeNull();
  expect(screen.getByText(/This approves a recurring staff task, not customer messages/)).toHaveProperty('textContent', expect.stringContaining('Changing this agreement or its owner requires new standing review'));
});
it('sends only the current exact service version when saving canonical service facts', async () => {
  const saved = vi.fn(async () => {}), fetch = setup((method, path) => method === 'PATCH' && path.endsWith(serviceId) ? Response.json({ id: serviceId }) : undefined);
  renderWithQuery(<ServiceObligationEditor row={row()} scopeKey={scopeKey} onSaved={saved} onClose={vi.fn()} />);
  await screen.findByRole('option', { name: 'Accepted Technician' }); fireEvent.change(screen.getByLabelText('Service due date'), { target: { value: '2035-02-01' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save service details' })); await act(async () => {});
  const write = fetch.mock.calls.find(([, request]) => request?.method === 'PATCH')!;
  expect(JSON.parse(String(write[1]?.body))).toMatchObject({ expectedUpdatedAt: versionTime, dueDate: '2035-02-01', assignedUserId: 'staff' });
  expect(saved).toHaveBeenCalledWith('Service details saved. No customer message was sent.');
});
it('locks stale or unknown edits until closing and refreshing the actual saved service', async () => {
  const fetch = setup(method => method === 'PATCH' ? Response.json({ error: 'The result was not confirmed.' }, { status: 503 }) : undefined);
  renderWithQuery(<ServiceObligationEditor row={row()} scopeKey={scopeKey} onSaved={vi.fn(async () => {})} onClose={vi.fn()} />);
  await screen.findByRole('option', { name: 'Accepted Technician' }); fireEvent.click(screen.getByRole('button', { name: 'Save service details' }));
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('No automatic retry'));
  expect(screen.getByRole('button', { name: 'Save service details' })).toHaveProperty('disabled', true);
  expect(screen.getByRole('button', { name: 'Approve recurring task' })).toHaveProperty('disabled', true);
  expect(screen.getByRole('button', { name: 'Mark serviced' })).toHaveProperty('disabled', true);
  expect(fetch.mock.calls.filter(([, request]) => request?.method === 'PATCH')).toHaveLength(1);
});
it('does not deliver a late save callback into a different authority view after unmount', async () => {
  let finish!: (response: Response) => void; const deferred = new Promise<Response>(resolve => { finish = resolve; });
  const saved = vi.fn(async () => {}), fetch = setup(), fallback = fetch.getMockImplementation()!;
  fetch.mockImplementation((url, init) => init?.method === 'PATCH' ? deferred : fallback(url, init));
  const view = renderWithQuery(<ServiceObligationEditor row={row()} scopeKey={scopeKey} onSaved={saved} onClose={vi.fn()} />);
  await screen.findByRole('option', { name: 'Accepted Technician' }); fireEvent.click(screen.getByRole('button', { name: 'Save service details' })); view.unmount();
  await act(async () => { finish(Response.json({ id: serviceId })); }); expect(saved).not.toHaveBeenCalled();
});
