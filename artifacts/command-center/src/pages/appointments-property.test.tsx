import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { getGetMeQueryKey } from '@workspace/api-client-react';
import { Router } from 'wouter';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Appointments from './appointments';
import { mockApi, sampleMe } from '@/test/mock-api';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const organizationId = id(1), contactId = id(2), otherContactId = id(3), leadId = id(4);
const property = (n: number) => ({ kind: 'property' as const, id: id(n), createdAt: '2026-10-05T00:00:00.000Z', addressLine1: `${n} Fictional Lane`, addressLine2: null, city: 'Atlanta', state: 'GA', postalCode: '30301', propertyType: 'residential' });
const page = (items = [property(10), property(11)], contact = contactId, nextCursor: string | null = null) => ({ organizationId, contactId: contact, section: 'properties', order: 'created_desc', limit: 25, items, nextCursor, hasMore: nextCursor !== null });
const nativeAppointment = () => ({ id: id(5), organizationId, contactId, leadId: null, propertyId: id(10), assignedUserId: null, type: 'inspection', status: 'confirmed', scheduledStart: '2035-07-01T14:00:00.000Z', scheduledEnd: '2035-07-01T16:00:00.000Z', notes: 'Private native visit notes', createdAt: '2026-10-05T00:00:00.000Z', updatedAt: '2026-10-05T01:00:00.000Z' });
const picker = () => screen.getByRole('combobox', { name: 'Property for this new appointment' });
const propertyPath = (contact = contactId) => `/api/v1/contacts/${contact}/workspace/properties`;
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

function setup({ properties, existing = false, create }: { properties?: (url: string, init?: RequestInit) => Response | Promise<Response>; existing?: boolean; create?: () => Response | Promise<Response> } = {}) {
  let profile = { ...sampleMe('office'), id: id(6), organization: { id: organizationId, name: 'Synthetic HVAC', slug: 'synthetic-hvac', timezone: 'UTC' } };
  let accessFailed = false;
  const fetch = mockApi('office'); const fallback = fetch.getMockImplementation()!;
  fetch.mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = url.split('?')[0], method = init?.method ?? 'GET';
    if (path === '/api/v1/me') return accessFailed ? Response.json({ error: 'Unavailable' }, { status: 403 }) : Response.json(profile);
    if (path === '/api/v1/contacts') return Response.json([{ id: contactId, firstName: 'Service-only', lastName: 'Customer', email: null }, { id: otherContactId, firstName: 'Other', lastName: 'Customer', email: null }]);
    if (path === '/api/v1/leads') return Response.json([{ id: leadId, contactId, contactName: 'Optional opportunity', summary: 'Existing opportunity', serviceType: 'HVAC', status: 'new' }]);
    if (path === '/api/v1/settings/inspection-availability') return Response.json({ timezone: 'UTC', days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'], windows: [{ startHour: 0, endHour: 24 }], blackoutDates: [], slotCapacity: 10 });
    if (path.endsWith('/workspace/properties')) return properties ? properties(url, init) : Response.json(page(undefined, path === propertyPath(otherContactId) ? otherContactId : contactId));
    if (path === '/api/v1/appointments') return method === 'POST' ? create ? create() : Response.json({ ...nativeAppointment(), ...JSON.parse(String(init?.body)) }) : Response.json(existing ? [nativeAppointment()] : []);
    if (path === `/api/v1/appointments/${id(5)}` && method === 'PATCH') return Response.json({ ...nativeAppointment(), ...JSON.parse(String(init?.body)) });
    return fallback(input, init);
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={client}><Router><Appointments /></Router></QueryClientProvider>);
  return { fetch, client, setProfile: (next: Partial<typeof profile>) => { profile = { ...profile, ...next }; }, failAccess: () => { accessFailed = true; } };
}
async function openCreate() {
  fireEvent.click(await screen.findByRole('button', { name: 'Schedule appointment' }));
  fireEvent.change(screen.getByLabelText('Start time'), { target: { value: '2035-07-01T10:00' } });
  await screen.findByRole('option', { name: 'Service-only Customer' });
}
function chooseCustomer(contact = contactId) { fireEvent.change(screen.getByTestId('appointment-contact'), { target: { value: contact } }); }
function chooseProperty(n: number) { fireEvent.change(picker(), { target: { value: id(n) } }); }
async function save(fetch: ReturnType<typeof mockApi>) {
  fireEvent.click(screen.getByRole('button', { name: 'Save Appt' }));
  await waitFor(() => expect(fetch.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(true));
  const call = fetch.mock.calls.find(([, init]) => init?.method === 'POST')!;
  expect(String(call[0])).toBe('/api/v1/appointments');
  return JSON.parse(String(call[1]?.body));
}
afterEach(() => { cleanup(); window.history.replaceState(null, '', '/'); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('explicit properties on new manual appointments', () => {
  it.each([1, 2])('keeps %i customer properties unselected and creates a service-only visit with explicit null', async count => {
    const { fetch } = setup({ properties: () => Response.json(page([property(10), property(11)].slice(0, count))) });
    await openCreate();
    expect(picker()).toHaveProperty('disabled', true);
    expect(fetch.mock.calls.some(([url]) => String(url).includes('/workspace/properties'))).toBe(false);
    chooseCustomer(); await screen.findByRole('option', { name: /10 Fictional Lane/ });
    expect(picker()).toHaveProperty('value', '');
    expect(screen.getByText('Optional. Choose a property only for this new appointment. Existing visits and their notes are not changed.')).toBeTruthy();
    const body = await save(fetch);
    expect(body).toMatchObject({ contactId, propertyId: null }); expect(body).not.toHaveProperty('leadId');
    expect(fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  });

  it('submits a deliberately selected property from a later page without inventing a lead', async () => {
    const { fetch } = setup({ properties: url => Response.json(url.includes('?cursor=page_two') ? page([property(40)]) : page(Array.from({ length: 25 }, (_, n) => property(10 + n)), contactId, 'page_two')) });
    await openCreate(); chooseCustomer(); await screen.findByText('25 linked properties loaded. More properties are available.');
    expect(picker()).toHaveProperty('value', '');
    fireEvent.click(screen.getByRole('button', { name: 'Load more customer properties' }));
    await screen.findByRole('option', { name: /40 Fictional Lane/ }); chooseProperty(40);
    const body = await save(fetch); expect(body).toMatchObject({ contactId, propertyId: id(40) }); expect(body).not.toHaveProperty('leadId');
    expect(fetch.mock.calls.some(([url]) => String(url) === `${propertyPath()}?cursor=page_two`)).toBe(true);
  });

  it('clears a selection on each customer or optional-lead change and never infers the lead property', async () => {
    const { fetch } = setup(); await openCreate(); chooseCustomer(); await screen.findByRole('option', { name: /10 Fictional Lane/ }); chooseProperty(10);
    chooseCustomer(otherContactId); expect(picker()).toHaveProperty('value', '');
    await screen.findByRole('option', { name: /11 Fictional Lane/ }); chooseProperty(11);
    fireEvent.change(screen.getByRole('combobox', { name: 'Lead' }), { target: { value: leadId } });
    expect(picker()).toHaveProperty('value', ''); await screen.findByRole('option', { name: /10 Fictional Lane/ });
    const body = await save(fetch);
    // The server must reject this contradictory optional lead, not silently relink.
    expect(body).toMatchObject({ contactId: otherContactId, leadId, propertyId: null });
    expect(fetch.mock.calls.filter(([url]) => String(url) === propertyPath(otherContactId))).toHaveLength(2);
  });

  it('allows a lead-only visit with explicit null without fetching or inferring a worksite', async () => {
    const { fetch } = setup(); await openCreate();
    fireEvent.change(await screen.findByRole('combobox', { name: 'Lead' }), { target: { value: leadId } });
    const body = await save(fetch); expect(body).toMatchObject({ leadId, propertyId: null }); expect(body).not.toHaveProperty('contactId');
    expect(fetch.mock.calls.some(([url]) => String(url).includes('/workspace/properties'))).toBe(false);
  });

  it.each(['customer', 'lead'])('aborts a pending property page on %s change and ignores its late result', async change => {
    const old = deferred<Response>(); let calls = 0;
    const { fetch } = setup({ properties: url => ++calls === 1 ? old.promise : Response.json(page([property(12)], url.startsWith(propertyPath(otherContactId)) ? otherContactId : contactId)) });
    await openCreate(); chooseCustomer(); await screen.findByText('Checking customer properties…');
    const signal = fetch.mock.calls.find(([url]) => String(url) === propertyPath())![1]?.signal as AbortSignal;
    if (change === 'customer') chooseCustomer(otherContactId);
    else fireEvent.change(screen.getByRole('combobox', { name: 'Lead' }), { target: { value: leadId } });
    await screen.findByRole('option', { name: /12 Fictional Lane/ }); expect(signal.aborted).toBe(true); chooseProperty(12);
    await act(async () => { old.resolve(Response.json(page([property(10)]))); });
    expect(screen.queryByRole('option', { name: /10 Fictional Lane/ })).toBeNull(); expect(picker()).toHaveProperty('value', id(12));
    expect(await save(fetch)).toMatchObject({ propertyId: id(12) });
  });

  it('preserves the explicit choice and notes through unchanged member polling', async () => {
    const { fetch, client, setProfile } = setup(); await openCreate(); chooseCustomer(); await screen.findByRole('option', { name: /10 Fictional Lane/ }); chooseProperty(10);
    fireEvent.change(screen.getByLabelText('Appointment notes'), { target: { value: 'Unfinished service-only draft' } });
    setProfile({ firstName: 'Updated display name only' });
    await act(async () => { await client.refetchQueries({ queryKey: getGetMeQueryKey() }); });
    expect(picker()).toHaveProperty('value', id(10)); expect(screen.getByLabelText('Appointment notes')).toHaveProperty('value', 'Unfinished service-only draft');
    expect(fetch.mock.calls.filter(([url]) => String(url) === propertyPath())).toHaveLength(1);
    expect(await save(fetch)).toMatchObject({ propertyId: id(10), notes: 'Unfinished service-only draft' });
  });

  it.each(['member', 'company', 'role', 'inactive', 'access-error'])('closes the draft and ignores late property data after a semantic %s change', async mode => {
    const old = deferred<Response>();
    const { fetch, client, setProfile, failAccess } = setup({ properties: () => old.promise });
    await openCreate(); chooseCustomer(); await screen.findByText('Checking customer properties…');
    const signal = fetch.mock.calls.find(([url]) => String(url) === propertyPath())![1]?.signal as AbortSignal;
    if (mode === 'member') setProfile({ id: id(90) });
    if (mode === 'company') setProfile({ organization: { id: id(90), name: 'Other company', slug: 'other', timezone: 'UTC' } });
    if (mode === 'role') setProfile({ role: 'viewer' });
    if (mode === 'inactive') setProfile({ isActive: false });
    if (mode === 'access-error') failAccess();
    await act(async () => { await client.refetchQueries({ queryKey: getGetMeQueryKey() }); });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull()); expect(signal.aborted).toBe(true);
    await act(async () => { old.resolve(Response.json(page())); });
    expect(screen.queryByRole('option', { name: /Fictional Lane/ })).toBeNull();
    expect(fetch.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  });

  it.each(['error', 'foreign-company', 'foreign-customer'])('does not present a %s property page as an empty success and retries with no selection', async mode => {
    let failed = true;
    const { fetch } = setup({ properties: () => !failed ? Response.json(page()) : mode === 'error' ? Response.json({ error: 'Unavailable' }, { status: 503 }) : Response.json({ ...page(), ...(mode === 'foreign-company' ? { organizationId: id(99) } : { contactId: id(99) }) }) });
    await openCreate(); chooseCustomer();
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('not an empty-property result'));
    expect(picker()).toHaveProperty('disabled', true); expect(screen.queryByRole('option', { name: /Fictional Lane/ })).toBeNull();
    expect(screen.queryByText('No linked properties were found for this customer.')).toBeNull();
    failed = false; fireEvent.click(screen.getByRole('button', { name: 'Retry customer properties' }));
    await screen.findByRole('option', { name: /10 Fictional Lane/ }); expect(picker()).toHaveProperty('value', '');
    expect(await save(fetch)).toMatchObject({ propertyId: null });
  });

  it('rejects an untrusted DOM option not in the successfully loaded customer set', async () => {
    const { fetch } = setup(); await openCreate(); chooseCustomer(); await screen.findByRole('option', { name: /10 Fictional Lane/ }); chooseProperty(10);
    const select = picker() as HTMLSelectElement; select.add(new Option('Untrusted injected property', id(99)));
    fireEvent.change(select, { target: { value: id(99) } });
    expect(picker()).toHaveProperty('value', ''); expect(await save(fetch)).toMatchObject({ propertyId: null });
  });

  it('refresh-clears a previous choice immediately and keeps a failed refresh visibly unavailable', async () => {
    let failed = false;
    const { fetch } = setup({ properties: () => failed ? Response.json({}, { status: 503 }) : Response.json(page()) });
    await openCreate(); chooseCustomer(); await screen.findByRole('option', { name: /10 Fictional Lane/ }); chooseProperty(10);
    failed = true; fireEvent.click(screen.getByRole('button', { name: 'Refresh properties and clear selection' }));
    expect(picker()).toHaveProperty('value', ''); await screen.findByRole('alert');
    expect(await save(fetch)).toMatchObject({ propertyId: null });
  });

  it('preserves exact native historical notes/version and omits property from edit payloads', async () => {
    const { fetch } = setup({ existing: true });
    fireEvent.click(await screen.findByRole('button', { name: 'Edit appointment' }));
    expect(screen.queryByRole('combobox', { name: 'Property for this new appointment' })).toBeNull();
    expect(screen.getByLabelText('Appointment notes')).toHaveProperty('value', nativeAppointment().notes);
    fireEvent.click(screen.getByRole('button', { name: 'Save Appt' }));
    await waitFor(() => expect(fetch.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(true));
    const [url, request] = fetch.mock.calls.find(([, init]) => init?.method === 'PATCH')!;
    expect(String(url)).toBe(`/api/v1/appointments/${id(5)}`);
    const body = JSON.parse(String(request?.body));
    expect(body).toMatchObject({ notes: nativeAppointment().notes, expectedUpdatedAt: nativeAppointment().updatedAt, scheduledStart: nativeAppointment().scheduledStart, scheduledEnd: nativeAppointment().scheduledEnd, contactId });
    expect(body).not.toHaveProperty('propertyId');
    expect(fetch.mock.calls.some(([url]) => String(url).includes('/workspace/properties'))).toBe(false);
  });

  it('does not let a pending old-membership save close or refresh a new appointment draft', async () => {
    const old = deferred<Response>();
    const { fetch, client, setProfile } = setup({ create: () => old.promise });
    await openCreate(); chooseCustomer(); await screen.findByRole('option', { name: /10 Fictional Lane/ }); chooseProperty(10); await save(fetch);
    setProfile({ role: 'admin' }); await act(async () => { await client.refetchQueries({ queryKey: getGetMeQueryKey() }); });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await openCreate(); fireEvent.change(screen.getByLabelText('Appointment notes'), { target: { value: 'New authority draft' } });
    const reads = () => fetch.mock.calls.filter(([url, init]) => String(url).startsWith('/api/v1/appointments?') && (!init?.method || init.method === 'GET')).length;
    const currentReads = reads();
    await act(async () => { old.resolve(Response.json(nativeAppointment())); });
    expect(screen.getByLabelText('Appointment notes')).toHaveProperty('value', 'New authority draft'); expect(reads()).toBe(currentReads);
    expect(picker()).toHaveProperty('value', '');
  });
});
