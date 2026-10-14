import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { getGetMeQueryKey } from '@workspace/api-client-react';
import { Router } from 'wouter';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Appointments from './appointments';
import { mockApi, sampleMe } from '@/test/mock-api';
import { localDateTime } from '@/lib/contractor-schedule';
import { companyDayBounds } from '@workspace/scheduling-core';
import { makeReservationSnapshot } from '@/test/scheduling-ui-fixtures';
import { work as workdayWork, entry as workdayEntry, completion as workdayCompletion } from '@/test/workday-fixtures';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const org = id(1), appointmentId = id(2), contactId = id(3);
const time = '2035-07-01T14:00:00.000Z';
const appointment = () => ({ kind: 'appointment', id: appointmentId, createdAt: '2026-10-03T00:00:00.000Z', updatedAt: '2026-10-03T01:00:00.000Z', type: 'inspection', status: 'confirmed', scheduledStart: time, scheduledEnd: '2035-07-01T15:00:00.000Z', contactId, leadId: null, property: null, owner: { id: 'staff', name: 'Synthetic Technician' } });
const detail = () => ({ organizationId: org, appointment: appointment(), permissions: { canWrite: true } });
const path = `/appointments?appointmentId=${appointmentId}&organizationId=${org}`;
function setup({ location = path, read, write, zone = 'UTC' }: { location?: string; zone?: string; read?: (url: string) => Response | Promise<Response> | undefined; write?: (url: string, init?: RequestInit) => Response | Promise<Response> | undefined } = {}) {
  let profile = { ...sampleMe('admin'), organization: { id: org, name: 'Synthetic HVAC', slug: 'synthetic', timezone: zone } };
  let failed = false;
  const fetch = mockApi('admin'); const fallback = fetch.getMockImplementation()!;
  fetch.mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url === '/api/v1/me') return failed ? Response.json({ error: 'Unavailable' }, { status: 403 }) : Response.json(profile);
    if (init?.method && init.method !== 'GET') { const result = write?.(url, init); if (result) return result; }
    if ((!init?.method || init.method === 'GET') && url.startsWith('/api/v1/appointments')) {
      const override = read?.(url); if (override) return override;
      return Response.json(url.split('?')[0] === `/api/v1/appointments/${appointmentId}` ? detail() : []);
    }
    return fallback(input, init);
  });
  window.history.replaceState(null, '', location);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={client}><Router><Appointments /></Router></QueryClientProvider>);
  return { fetch, client, setProfile: (next: Partial<typeof profile>) => { profile = { ...profile, ...next }; }, fail: () => { failed = true; }, recover: () => { failed = false; } };
}
afterEach(() => { cleanup(); sessionStorage.clear(); window.history.replaceState(null, '', '/'); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
describe('exact selected appointments', () => {
  it('supplies the exact same-row native reservation projection to the independently validated linked detail', async () => {
    const saved = makeReservationSnapshot({ target: { kind: 'appointment', id: appointmentId }, startAt: time, endAt: appointment().scheduledEnd, resourceUserIds: ['staff'] });
    setup({ zone: 'America/Los_Angeles', read: url => url.includes('?') ? Response.json([{ ...appointment(), organizationId: org, schedulingReservation: saved, schedulingEvidence: 'versioned', assignedUserId: 'staff' }]) : undefined });
    const selected = await screen.findByRole('region', { name: 'Selected appointment' });
    expect(await within(selected).findByRole('group', { name: 'Scheduling reservation' })).toBeTruthy();
    expect(within(selected).getByText('Saved travel gap: 60 minutes. Retained independently of current policy changes.')).toBeTruthy();
    expect(within(selected).getByText('2035-07-01 07:00:00.000 -07:00 (America/Los_Angeles)')).toBeTruthy();
  });
  it('holds a stale native list projection instead of treating it as the exact selected detail', async () => {
    setup({ read: url => url.includes('?') ? Response.json([{ ...appointment(), organizationId: org, updatedAt: '2026-10-03T02:00:00.000Z', schedulingReservation: null, schedulingEvidence: 'legacy' }]) : undefined });
    const selected = await screen.findByRole('region', { name: 'Selected appointment' });
    expect(await within(selected).findByText('Scheduling evidence does not match the validated appointment or is invalid. Display is held; saved protection cannot be assumed.')).toBeTruthy();
    expect(within(selected).queryByText(/Legacy travel gap: 0/)).toBeNull();
  });
  it('shows the exact selected visit on its company calendar day across UTC midnight', async () => {
    const start = '2035-07-02T01:00:00.000Z', zone = 'America/Los_Angeles';
    const { fetch } = setup({ zone, read: url => url === `/api/v1/appointments/${appointmentId}` ? Response.json({ ...detail(), appointment: { ...appointment(), scheduledStart: start, scheduledEnd: '2035-07-02T02:00:00.000Z' } }) : undefined });
    fireEvent.click(await screen.findByRole('button', { name: 'Show this day in schedule' }));
    expect(screen.getByLabelText('Start date')).toHaveProperty('value', '2035-07-01');
    const bounds = companyDayBounds('2035-07-01', zone);
    await waitFor(() => expect(fetch.mock.calls.some(([url]) => {
      const query = new URL(String(url), 'http://localhost');
      return query.pathname === '/api/v1/appointments' && query.searchParams.get('from') === bounds.from && query.searchParams.get('to') === bounds.to;
    })).toBe(true));
    expect(screen.getByRole('region', { name: 'Selected appointment' })).toBeTruthy();
  });
  it('propagates confirmed two-entry completion to the enclosing exact summary and read-back schedule without unmounting work', async () => {
    let savedStatus: 'scheduled' | 'completed' = 'scheduled';
    let native = workdayWork(); native.organizationId = org; native.appointment = { ...native.appointment, id: appointmentId, contactId, propertyId: null, status: 'scheduled', updatedAt: appointment().updatedAt };
    native.entries = [30, 31].map(number => workdayEntry({ id: id(number), appointmentId, contactId, propertyId: null, assetId: null, assetSnapshot: null, serviceObligationId: null })); native.linkedServices = []; native.capabilities.canPrepare = false;
    const { fetch } = setup({ read: url => url === `/api/v1/appointments/${appointmentId}/work` ? Response.json(native) : url === `/api/v1/appointments/${appointmentId}` ? Response.json({ ...detail(), appointment: { ...appointment(), status: savedStatus } }) : url.includes('?') ? Response.json([{ ...appointment(), status: savedStatus, leadLabel: 'Fictional work customer', assignedUserId: 'staff', notes: 'Full native notes' }]) : undefined,
      write: (url, init) => {
        const body = JSON.parse(String(init?.body));
        if (url.endsWith('/completion-preview')) return Response.json({ organizationId: org, appointmentId, expiresAt: new Date(Date.now() + 60000).toISOString(), previewToken: 'two-entry-exact-review', entries: native.entries, intent: body, serviceVersions: [], warning: 'Staff-recorded work; not warranty coverage, customer acceptance, invoice delivery or payment.' });
        if (url.endsWith('/complete')) { savedStatus = 'completed'; const completed = workdayCompletion({ id: id(50), appointmentId, contactId, propertyId: null, requestId: body.requestId, summary: 'Saved two-entry completion', entries: native.entries.map(entry => ({ id: entry.id, version: entry.version, checklistRevisionId: entry.checklist.id, assetId: null })) }); native = { ...native, appointment: { ...native.appointment, status: 'completed', updatedAt: new Date().toISOString() }, completion: completed, entries: native.entries.map(entry => ({ ...entry, state: 'finalized', completionId: completed.id })), capabilities: { ...native.capabilities, canEdit: false, canCancel: false, canComplete: false } }; return Response.json({ organizationId: org, work: native, receipt: { requestId: body.requestId, replayed: false } }); }
        return undefined;
      },
    });
    await screen.findByText('Synthetic Technician'); const summaryStatus = screen.getByText('Recorded status').parentElement!; expect(summaryStatus.textContent).toContain('scheduled'); expect((screen.getByTestId('appointment-status-select') as HTMLSelectElement).value).toBe('scheduled');
    fireEvent.click(screen.getByRole('button', { name: 'Open visit work' })); await screen.findByLabelText('Completion summary'); const panelBefore = screen.getByRole('heading', { name: 'Visit work', exact: true }).closest('section');
    fireEvent.change(screen.getByLabelText('Completion summary'), { target: { value: 'Saved two-entry completion' } }); fireEvent.click(screen.getByRole('button', { name: 'Review exact completion' })); await screen.findByRole('region', { name: 'Exact completion review' }); fireEvent.click(screen.getByLabelText('I checked the saved work and selected service outcomes.')); fireEvent.click(screen.getByRole('button', { name: 'Record reviewed completion' }));
    await screen.findByRole('region', { name: 'Recorded work completion' }); await waitFor(() => expect((screen.getByTestId('appointment-status-select') as HTMLSelectElement).value).toBe('completed')); expect(screen.getByText('Recorded status').parentElement?.textContent).toContain('completed');
    expect(screen.getByRole('heading', { name: 'Visit work', exact: true }).closest('section')).toBe(panelBefore); expect(screen.getByRole('button', { name: 'Close visit work' })).toBeTruthy(); expect(screen.getByText('Saved two-entry completion')).toBeTruthy();
    expect(fetch.mock.calls.filter(([url]) => String(url) === `/api/v1/appointments/${appointmentId}/work`)).toHaveLength(1); expect(fetch.mock.calls.filter(([url]) => String(url) === `/api/v1/appointments/${appointmentId}`)).toHaveLength(1); expect(fetch.mock.calls.filter(([url]) => String(url).startsWith('/api/v1/appointments?')).length).toBeGreaterThan(1);
    expect(fetch.mock.calls.filter(([, init]) => init?.method === 'PATCH')).toHaveLength(0);
  });
  it('opens visit work only on explicit action, preserves its draft on unchanged profile and removes it on access failure', async () => {
    const native = workdayWork(); native.organizationId = org; native.appointment = { ...native.appointment, id: appointmentId, contactId, propertyId: null }; native.entries = [workdayEntry({ appointmentId, contactId, propertyId: null, assetId: null, assetSnapshot: null, serviceObligationId: null })]; native.linkedServices = []; native.capabilities.canPrepare = false;
    const { fetch, client, fail } = setup({ read: url => url === `/api/v1/appointments/${appointmentId}/work` ? Response.json(native) : undefined });
    await screen.findByText('Synthetic Technician'); expect(fetch.mock.calls.some(([url]) => String(url).endsWith('/work'))).toBe(false); fireEvent.click(screen.getByRole('button', { name: 'Open visit work' }));
    const notes = await screen.findByLabelText('Work notes for Synthetic unit visit'); fireEvent.change(notes, { target: { value: 'Unfinished technician observation' } });
    await act(async () => { await client.refetchQueries({ queryKey: getGetMeQueryKey() }); }); expect((screen.getByLabelText('Work notes for Synthetic unit visit') as HTMLTextAreaElement).value).toBe('Unfinished technician observation'); expect(fetch.mock.calls.filter(([url]) => String(url).endsWith('/work'))).toHaveLength(1);
    fail(); await act(async () => { await client.refetchQueries({ queryKey: getGetMeQueryKey() }); }); await screen.findByText(/Company access could not be verified/); expect(screen.queryByLabelText('Work notes for Synthetic unit visit')).toBeNull();
  });
  it('opens an older exact appointment independently of an empty current schedule and pins its customer link', async () => {
    const { fetch } = setup();
    const selected = await screen.findByRole('region', { name: 'Selected appointment' });
    await within(selected).findByText('Synthetic Technician');
    expect(within(selected).getByText('No property linked')).toBeTruthy();
    expect(within(selected).getByRole('link', { name: 'Open customer record' }).getAttribute('href')).toBe(`/contacts/${contactId}?organizationId=${org}`);
    expect(screen.getByText('No appointments scheduled.')).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull(); expect(screen.queryByTestId('edit-appointment')).toBeNull();
    expect(fetch.mock.calls.filter(([url]) => String(url) === `/api/v1/appointments/${appointmentId}`)).toHaveLength(1);
    expect(fetch.mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(true);
    fireEvent.click(within(selected).getByRole('button', { name: 'Show this day in schedule' }));
    expect(screen.getByLabelText('Start date')).toHaveProperty('value', localDateTime(time).slice(0, 10));
    expect(screen.getByLabelText('Show')).toHaveProperty('value', '1'); expect(screen.getByLabelText('Team member')).toHaveProperty('value', '');
    await waitFor(() => expect(fetch.mock.calls.some(([url]) => String(url).includes('from=2035-07-01'))).toBe(true));
  });
  it.each(['missing-company', 'missing-id', 'malformed', 'duplicate', 'foreign', 'extra'])('does not fetch or substitute a schedule row for a %s exact target', async mode => {
    const location = mode === 'missing-company' ? `/appointments?appointmentId=${appointmentId}` : mode === 'missing-id' ? `/appointments?organizationId=${org}` : mode === 'malformed' ? `/appointments?appointmentId=bad&organizationId=${org}` : mode === 'duplicate' ? `${path}&appointmentId=${appointmentId}` : mode === 'foreign' ? `/appointments?appointmentId=${appointmentId}&organizationId=${id(99)}` : `${path}&returnTo=https://example.invalid`;
    const { fetch } = setup({ location }); await screen.findByRole('alert');
    expect(fetch.mock.calls.some(([url]) => String(url).startsWith('/api/v1/appointments/'))).toBe(false);
    expect(screen.queryByText('Synthetic Technician')).toBeNull(); expect(screen.queryByRole('region', { name: 'Selected appointment' })).toBeNull();
  });
  it.each(['missing', 'foreign-response', 'wrong-id', 'extra-fields', 'bad-type'])('keeps a %s response visibly unavailable without exposing its data', async mode => {
    const response: Record<string, unknown> = detail();
    if (mode === 'foreign-response') response.organizationId = id(99);
    if (mode === 'wrong-id') response.appointment = { ...appointment(), id: id(99) };
    if (mode === 'extra-fields') response.appointment = { ...appointment(), notes: 'Hidden private notes' };
    if (mode === 'bad-type') response.appointment = { ...appointment(), type: 'unknown' };
    setup({ read: url => url.includes(`/appointments/${appointmentId}`) ? mode === 'missing' ? Response.json({ error: 'Not found' }, { status: 404 }) : Response.json(response) : undefined });
    const selected = await screen.findByRole('region', { name: 'Selected appointment' }); await within(selected).findByRole('alert');
    expect(within(selected).queryByText('Synthetic Technician')).toBeNull(); expect(screen.queryByText('Hidden private notes')).toBeNull();
    expect(within(selected).getByText(/schedule below is separate/)).toBeTruthy();
  });
  it('shows an unlinked appointment without inventing customer navigation', async () => {
    setup({ read: url => url.includes(`/appointments/${appointmentId}`) ? Response.json({ ...detail(), appointment: { ...appointment(), contactId: null, owner: null } }) : undefined });
    const selected = await screen.findByRole('region', { name: 'Selected appointment' }); await within(selected).findByText(/No customer linked/);
    expect(within(selected).queryByRole('link')).toBeNull(); expect(within(selected).getByText('Unassigned')).toBeTruthy();
  });
  it('uses only the explicitly opened full native row for edits and preserves its existing private notes', async () => {
    const full = { ...appointment(), kind: undefined, owner: undefined, property: undefined, assignedUserId: 'staff', notes: 'Private full-record notes must survive', leadLabel: 'Synthetic Customer' };
    const { fetch } = setup({ read: url => url.includes('?') ? Response.json([full]) : undefined });
    await screen.findByText('Synthetic Technician'); expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(await screen.findByTestId('edit-appointment'));
    expect(screen.getByLabelText('Appointment notes')).toHaveProperty('value', full.notes);
    fireEvent.click(screen.getByRole('button', { name: 'Save Appt' }));
    await waitFor(() => expect(fetch.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(true));
    const [, request] = fetch.mock.calls.find(([, init]) => init?.method === 'PATCH')!;
    expect(JSON.parse(String(request?.body))).toMatchObject({ notes: full.notes, expectedUpdatedAt: full.updatedAt });
  });
  it('preserves a valid editor draft through unchanged membership refresh but closes it after access failure', async () => {
    const { client, fail, recover } = setup(); await screen.findByText('Synthetic Technician');
    fireEvent.click(screen.getByRole('button', { name: 'Schedule appointment' })); fireEvent.change(screen.getByLabelText('Appointment notes'), { target: { value: 'Unfinished staff draft' } });
    await act(async () => { await client.refetchQueries({ queryKey: getGetMeQueryKey() }); });
    expect(screen.getByLabelText('Appointment notes')).toHaveProperty('value', 'Unfinished staff draft'); fail();
    await act(async () => { await client.refetchQueries({ queryKey: getGetMeQueryKey() }); });
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('Company access could not be verified'));
    expect(screen.queryByRole('dialog')).toBeNull(); expect(screen.queryByText('Synthetic Technician')).toBeNull();
    recover(); fireEvent.click(screen.getByRole('button', { name: 'Check appointment access' })); await screen.findByText('Synthetic Technician'); expect(screen.queryByRole('dialog')).toBeNull();
  });
  it('ignores a late exact response after changing to another company and clears all selected data', async () => {
    let resolve!: (response: Response) => void; const pending = new Promise<Response>(done => { resolve = done; });
    const { client, setProfile, fetch } = setup({ read: url => url.includes(`/appointments/${appointmentId}`) ? pending : undefined });
    await screen.findByText('Opening the exact appointment…');
    const oldSignal = fetch.mock.calls.find(([url]) => String(url) === `/api/v1/appointments/${appointmentId}`)![1]?.signal as AbortSignal;
    setProfile({ organization: { id: id(99), name: 'Other Company', slug: 'other', timezone: 'UTC' } });
    await act(async () => { await client.refetchQueries({ queryKey: getGetMeQueryKey() }); });
    await screen.findByText(/This appointment link belongs to another company/); expect(oldSignal.aborted).toBe(true);
    await act(async () => { resolve(Response.json(detail())); }); expect(screen.queryByText('Synthetic Technician')).toBeNull();
    expect(fetch.mock.calls.filter(([url]) => String(url) === `/api/v1/appointments/${appointmentId}`)).toHaveLength(1);
  });
});
