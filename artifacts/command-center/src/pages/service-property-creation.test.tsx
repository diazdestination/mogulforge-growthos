import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { getGetMeQueryKey } from '@workspace/api-client-react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ServiceDesk from './service-desk';
import { mockApi, sampleMe } from '@/test/mock-api';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const org = id(1), contactId = id(2), propertyId = id(3);
const property = { kind: 'property', id: propertyId, createdAt: '2026-10-03T00:00:00.000Z', addressLine1: '42 Synthetic Street', addressLine2: null, city: 'Atlanta', state: 'GA', postalCode: '30301', propertyType: null };
const page = { organizationId: org, contactId, section: 'properties', order: 'created_desc', limit: 25, items: [property], nextCursor: null, hasMore: false };
const historical = { obligation: { id: id(4), contactId, propertyId: null, kind: 'maintenance', equipmentLabel: 'Old one-time service', dueAt: '2026-11-01T12:00:00.000Z', status: 'active', source: 'manual', appointmentId: null, updatedAt: '2026-10-03T00:00:00.000Z', recurrence: null, coverageStartsOn: null, coverageEndsOn: null, coverageEvidence: null }, contact: { id: contactId, firstName: 'Synthetic', lastName: 'Customer', phone: null, email: null }, task: { status: 'open', dueAt: null, assignedUserId: null } };
function setup() {
  let profile = { ...sampleMe('office'), organization: { id: org, name: 'Synthetic HVAC', slug: 'synthetic', timezone: 'UTC' } };
  let failed = false;
  const fetch = mockApi('office', { handler: (method, path) => {
    if (path.endsWith('/me')) return failed ? Response.json({ error: 'Unavailable' }, { status: 403 }) : Response.json(profile);
    if (path.endsWith('/contacts')) return Response.json([{ id: contactId, firstName: 'Synthetic', lastName: 'Customer' }, { id: id(20), firstName: 'Different', lastName: 'Customer' }]);
    if (path.endsWith('/workspace/properties')) return Response.json(path.includes(`/${contactId}/`) ? page : { ...page, contactId: id(20), items: [] });
    if (path.endsWith('/service-watch')) return Response.json({ items: [], hasMore: false, unmonitoredCount: 0, held: false });
    if (path.endsWith('/service-obligations')) return Response.json(method === 'GET' ? [historical] : { id: id(5) });
    return undefined;
  } });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={client}><ServiceDesk /></QueryClientProvider>);
  return { fetch, client, fail: () => { failed = true; }, setProfile: (value: Partial<typeof profile>) => { profile = { ...profile, ...value }; } };
}
async function fill() {
  await screen.findByRole('option', { name: 'Synthetic Customer' });
  fireEvent.change(screen.getByTestId('service-contact'), { target: { value: contactId } });
  await screen.findByRole('option', { name: /42 Synthetic Street/ });
  fireEvent.change(screen.getByLabelText('Equipment'), { target: { value: 'New synthetic heat pump' } });
  fireEvent.change(screen.getByLabelText('Service due date'), { target: { value: '2035-11-01' } });
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
describe('new service property contract', () => {
  it.each([false, true])('posts only the explicit new-service property selection (selected=%s), never backfilling existing null history', async selected => {
    const { fetch } = setup(); await fill();
    expect(screen.getByRole('combobox', { name: 'Property for this new service' })).toHaveProperty('value', '');
    if (selected) fireEvent.change(screen.getByRole('combobox', { name: 'Property for this new service' }), { target: { value: propertyId } });
    fireEvent.click(screen.getByRole('button', { name: 'Save service date' }));
    await screen.findByText('Service date saved. A staff follow-up task is ready; no customer message was sent.');
    const [, request] = fetch.mock.calls.find(([url, init]) => String(url) === '/api/v1/service-obligations' && init?.method === 'POST')!;
    expect(JSON.parse(String(request?.body))).toEqual({ contactId, propertyId: selected ? propertyId : null, kind: 'maintenance', equipmentLabel: 'New synthetic heat pump', dueDate: '2035-11-01', noticeDays: 30 });
    expect(fetch.mock.calls.some(([, request]) => request?.method === 'PATCH')).toBe(false);
    expect(await within(screen.getByRole('region', { name: 'Service records' })).findByText('No property linked')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Customer record' }).getAttribute('href')).toBe(`/contacts/${contactId}?organizationId=${org}`);
  });
  it('clears selected property when switching customers without silently reusing an address', async () => {
    const { fetch } = setup(); await fill(); fireEvent.change(screen.getByRole('combobox', { name: 'Property for this new service' }), { target: { value: propertyId } });
    fireEvent.change(screen.getByTestId('service-contact'), { target: { value: id(20) } });
    await screen.findByText('No linked properties were found for this customer.');
    fireEvent.click(screen.getByRole('button', { name: 'Save service date' })); await screen.findByText(/Service date saved/);
    const [, request] = fetch.mock.calls.find(([, init]) => init?.method === 'POST')!;
    expect(JSON.parse(String(request?.body))).toMatchObject({ contactId: id(20), propertyId: null });
  });
  it('keeps a property draft through unchanged membership polling but clears all controls after a profile error', async () => {
    const { client, fail } = setup(); await fill(); fireEvent.change(screen.getByRole('combobox', { name: 'Property for this new service' }), { target: { value: propertyId } });
    await act(async () => { await client.refetchQueries({ queryKey: getGetMeQueryKey() }); });
    expect(screen.getByRole('combobox', { name: 'Property for this new service' })).toHaveProperty('value', propertyId); fail();
    await act(async () => { await client.refetchQueries({ queryKey: getGetMeQueryKey() }); });
    await screen.findByRole('alert'); expect(screen.queryByRole('button', { name: 'Save service date' })).toBeNull();
    expect(screen.queryByRole('option', { name: /42 Synthetic Street/ })).toBeNull();
  });
  it.each(['role', 'identity', 'organization', 'inactive'])('clears an eligible property draft on actual %s changes', async mode => {
    const { client, setProfile, fetch } = setup(); await fill(); fireEvent.change(screen.getByRole('combobox', { name: 'Property for this new service' }), { target: { value: propertyId } });
    if (mode === 'role') setProfile({ role: 'viewer' });
    if (mode === 'identity') setProfile({ id: 'new-user' });
    if (mode === 'organization') setProfile({ organization: { id: id(99), name: 'Other', slug: 'other', timezone: 'UTC' } });
    if (mode === 'inactive') setProfile({ isActive: false });
    await act(async () => { await client.refetchQueries({ queryKey: getGetMeQueryKey() }); });
    await waitFor(() => expect(screen.queryByRole('option', { name: /42 Synthetic Street/ })).toBeNull());
    if (mode === 'identity' || mode === 'organization') { expect(screen.getByTestId('service-contact')).toHaveProperty('value', ''); expect(screen.getByRole('button', { name: 'Save service date' })).toHaveProperty('disabled', true); }
    else expect(screen.queryByRole('button', { name: 'Save service date' })).toBeNull();
    expect(fetch.mock.calls.some(([, request]) => request?.method === 'POST')).toBe(false);
  });
});
