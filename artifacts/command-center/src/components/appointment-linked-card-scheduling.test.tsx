import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { makeReservationSnapshot, makeSchedulingInterval, makeSchedulingResources, schedulingFixtureIds } from '@/test/scheduling-ui-fixtures';
import AppointmentLinkedCard from './appointment-linked-card';
import { work as workFixture } from '@/test/workday-fixtures';

const org = schedulingFixtureIds.organization, appointmentId = schedulingFixtureIds.target;
const other = '44444444-4444-4444-8444-444444444444';
const start = '2035-01-01T17:00:00.000Z', end = '2035-01-01T18:30:00.000Z', updatedAt = '2035-01-01T16:00:00.000Z';
const detail = () => ({ organizationId: org, appointment: { kind: 'appointment', id: appointmentId, createdAt: updatedAt, updatedAt, type: 'inspection', status: 'confirmed', scheduledStart: start, scheduledEnd: end, contactId: null, leadId: null, property: null, owner: { id: 'staff-synthetic', name: 'Exact technician' } }, permissions: { canWrite: false } });
const reservationView = () => ({ appointmentId, updatedAt, interval: makeSchedulingInterval(), resources: makeSchedulingResources() });
function props(overrides: Partial<ComponentProps<typeof AppointmentLinkedCard>> = {}) {
  return { search: `?appointmentId=${appointmentId}&organizationId=${org}`, organizationId: org, scopeKey: 'org:actor:read', refreshKey: 0, companyTimeZone: 'America/Phoenix', onShowDay: vi.fn(), reservationView: reservationView(), ...overrides };
}
function reads(response: unknown = detail()) {
  const fetch = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => Response.json(response));
  vi.stubGlobal('fetch', fetch);
  return fetch;
}
async function opened() { return screen.findByText('Exact technician'); }
function assertHeld() {
  expect(screen.getByText(/Scheduling evidence.*held/i)).toBeTruthy();
  expect(screen.queryByRole('group', { name: 'Scheduling reservation' })).toBeNull();
  expect(screen.queryByText(/Legacy travel gap: 0/)).toBeNull();
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('linked appointment scheduling evidence', () => {
  it('formats actual UTC endpoints in current company zone, preserving saved travel/preset and separate historical zones', async () => {
    const fetch = reads(); const input = props(); render(<AppointmentLinkedCard {...input} />); await opened();
    const selected = screen.getByRole('region', { name: 'Selected appointment' });
    expect(within(selected).getByText(/2035-01-01.*10:00:00.*-07:00.*America\/Phoenix/)).toBeTruthy();
    expect(within(selected).getByText(/2035-01-01.*11:30:00.*-07:00.*America\/Phoenix/)).toBeTruthy();
    expect(screen.getByText(/Saved travel gap: 60 minutes/)).toBeTruthy();
    expect(screen.getByText(/Saved preset: Synthetic visit.*90 minutes/)).toBeTruthy();
    expect(screen.getByText(/Approved company zone: America\/Los_Angeles.*historical/)).toBeTruthy();
    expect(screen.getByText(/Inspection rule zone: America\/New_York/)).toBeTruthy();
    expect(screen.getByText(/90 elapsed minutes/)).toBeTruthy();
    expect(screen.queryByText(/Proposed|reservation cap|Rechecked when saving/)).toBeNull();
    expect([...selected.querySelectorAll('time')].map(item => item.dateTime)).toEqual([start, end, start, end]);
    fireEvent.click(screen.getByRole('button', { name: 'Show this day in schedule' }));
    expect(input.onShowDay).toHaveBeenCalledWith(start);
    expect(fetch.mock.calls.map(call => call[0])).toEqual([`/api/v1/appointments/${appointmentId}`]);
  });
  it.each([undefined, null])('keeps missing saved evidence %s unavailable instead of inferring legacy zero', async reservationView => {
    reads(); render(<AppointmentLinkedCard {...props({ reservationView })} />); await opened();
    expect(screen.getByText(/Saved scheduling evidence is unavailable/)).toBeTruthy();
    expect(screen.queryByText(/Legacy travel gap|Legacy compatibility window|Saved travel gap/)).toBeNull();
  });
  it.each([null, '', 'Invalid/Zone', '+02:00'])('holds all displayed times for invalid/missing current zone %s', async companyTimeZone => {
    reads(); render(<AppointmentLinkedCard {...props({ companyTimeZone })} />); await opened();
    expect(screen.getAllByText(/current company time zone.*required/i).length).toBeGreaterThan(0);
    expect(document.querySelector('time')).toBeNull();
    expect(screen.queryByText(/2035-01-01.*10:00/)).toBeNull();
  });
  it('updates display for current-zone change without re-fetching or remounting unchanged visit work', async () => {
    const work = workFixture(); work.organizationId = org; work.appointment.id = appointmentId;
    work.entries = work.entries.map(entry => ({ ...entry, appointmentId }));
    work.linkedServices = []; work.capabilities.canPrepare = false; work.capabilities.canComplete = false;
    const fetch = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async url => Response.json(url.endsWith('/work') ? work : detail()));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    vi.stubGlobal('fetch', fetch); const input = props();
    const card = (zone: string) => <QueryClientProvider client={client}><AppointmentLinkedCard {...input} companyTimeZone={zone} /></QueryClientProvider>;
    const view = render(card('America/Phoenix')); await opened();
    fireEvent.click(screen.getByRole('button', { name: 'Open visit work' }));
    const notes = await screen.findByLabelText('Work notes for Synthetic unit visit');
    fireEvent.change(notes, { target: { value: 'Unsaved exact visit observation' } });
    const disclosure = screen.getByRole('button', { name: 'Close visit work' });
    view.rerender(card('Asia/Tokyo'));
    expect(screen.getByText(/2035-01-02.*02:00:00.*\+09:00.*Asia\/Tokyo/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Close visit work' })).toBe(disclosure);
    expect(screen.getByLabelText('Work notes for Synthetic unit visit')).toHaveProperty('value', 'Unsaved exact visit observation');
    expect(fetch.mock.calls.filter(call => call[0] === `/api/v1/appointments/${appointmentId}`)).toHaveLength(1);
    expect(fetch.mock.calls.filter(call => call[0] === `/api/v1/appointments/${appointmentId}/work`)).toHaveLength(1);
    client.clear();
  });
  it('keeps repeated company wall times distinct by actual UTC instant and explicit numeric offset', async () => {
    const response = detail(); response.appointment.scheduledStart = '2035-11-04T05:30:00.000Z'; response.appointment.scheduledEnd = '2035-11-04T06:30:00.000Z';
    const projection = reservationView();
    projection.interval = makeSchedulingInterval({ startAt: response.appointment.scheduledStart, endAt: response.appointment.scheduledEnd, reservation: makeReservationSnapshot({ startAt: response.appointment.scheduledStart, endAt: response.appointment.scheduledEnd, duration: { kind: 'explicit', preset: null } }) });
    reads(response); render(<AppointmentLinkedCard {...props({ companyTimeZone: 'America/New_York', reservationView: projection })} />); await opened();
    expect(screen.getByText(/2035-11-04.*01:30:00.*-04:00.*America\/New_York/)).toBeTruthy();
    expect(screen.getByText(/2035-11-04.*01:30:00.*-05:00.*America\/New_York/)).toBeTruthy();
    expect(screen.getByText(/60 elapsed minutes/)).toBeTruthy();
  });
  const invalid = [
    ['wrong appointment ID', (v: ReturnType<typeof reservationView>) => { v.appointmentId = other; }],
    ['stale update', (v: ReturnType<typeof reservationView>) => { v.updatedAt = '2035-01-01T15:00:00.000Z'; }],
    ['wrong start', (v: ReturnType<typeof reservationView>) => { v.interval.startAt = '2035-01-01T16:00:00.000Z'; }],
    ['wrong end', (v: ReturnType<typeof reservationView>) => { v.interval.endAt = '2035-01-01T19:00:00.000Z'; }],
    ['project target', (v: ReturnType<typeof reservationView>) => { v.interval.reservation!.target.kind = 'project'; }],
    ['wrong saved target ID', (v: ReturnType<typeof reservationView>) => { v.interval.reservation!.target.id = other; }],
    ['wrong saved start', (v: ReturnType<typeof reservationView>) => { v.interval.reservation!.startAt = '2035-01-01T16:00:00.000Z'; }],
    ['wrong saved end', (v: ReturnType<typeof reservationView>) => { v.interval.reservation!.endAt = '2035-01-01T19:00:00.000Z'; }],
    ['missing versioned snapshot', (v: ReturnType<typeof reservationView>) => { v.interval.reservation = null; }],
    ['invalid evidence', (v: ReturnType<typeof reservationView>) => { v.interval.evidence = 'invalid'; }],
    ['legacy with snapshot', (v: ReturnType<typeof reservationView>) => { v.interval.evidence = 'legacy'; }],
    ['invalid version', (v: ReturnType<typeof reservationView>) => { Object.assign(v.interval.reservation!, { formatVersion: 2 }); }],
    ['extra snapshot field', (v: ReturnType<typeof reservationView>) => { Object.assign(v.interval.reservation!, { notes: 'Projection private note' }); }],
    ['extra interval field', (v: ReturnType<typeof reservationView>) => { Object.assign(v.interval, { notes: 'Projection private note' }); }],
    ['extra projection field', (v: ReturnType<typeof reservationView>) => { Object.assign(v, { notes: 'Projection private note' }); }],
    ['invalid resources', (v: ReturnType<typeof reservationView>) => { Object.assign(v, { resources: null }); }],
    ['invalid resource shape', (v: ReturnType<typeof reservationView>) => { Object.assign(v.resources[0], { notes: 'Projection private note' }); }],
    ['unexpected compatibility end', (v: ReturnType<typeof reservationView>) => { v.interval.legacyEffectiveEnd = '2035-01-01T19:00:00.000Z'; }],
    ['invalid instant', (v: ReturnType<typeof reservationView>) => { v.interval.startAt = '2035-02-30T17:00:00.000Z'; }],
    ['null interval', (v: ReturnType<typeof reservationView>) => { Object.assign(v, { interval: null }); }],
  ] as const;
  it.each(invalid)('visibly holds %s projection without hiding authoritative detail', async (_name, mutate) => {
    const projection = reservationView(); mutate(projection); reads(); render(<AppointmentLinkedCard {...props({ reservationView: projection })} />); await opened();
    assertHeld(); expect(screen.queryByText('Projection private note')).toBeNull();
  });
  it('holds a reversed authoritative interval rather than showing plausible times', async () => {
    const response = detail(); response.appointment.scheduledEnd = '2035-01-01T16:00:00.000Z'; reads(response);
    render(<AppointmentLinkedCard {...props({ reservationView: null })} />); await opened();
    expect(screen.getByText(/Recorded appointment times.*held/)).toBeTruthy();
    expect(document.querySelector('time')).toBeNull();
  });
  it('preserves an actual legacy NULL end and shows only a positively supplied two-hour compatibility window', async () => {
    const response = { ...detail(), appointment: { ...detail().appointment, scheduledEnd: null } };
    const projection = reservationView(); projection.interval = makeSchedulingInterval({ endAt: null, legacyEffectiveEnd: '2035-01-01T19:00:00.000Z', reservation: null, evidence: 'legacy' });
    reads(response); render(<AppointmentLinkedCard {...props({ reservationView: projection })} />); await opened();
    expect(screen.getByText('No end recorded')).toBeTruthy();
    expect(screen.getByText('Legacy compatibility window')).toBeTruthy();
    expect(screen.getByText(/120 elapsed minutes/)).toBeTruthy();
    expect(screen.getByText(/Legacy travel gap: 0 minutes/)).toBeTruthy();
    expect(screen.queryByText(/Saved preset/)).toBeNull();
  });
  it('rejects invented NULL-end compatibility duration', async () => {
    reads({ ...detail(), appointment: { ...detail().appointment, scheduledEnd: null } });
    const projection = reservationView(); projection.interval = makeSchedulingInterval({ endAt: null, legacyEffectiveEnd: end, reservation: null, evidence: 'legacy' });
    render(<AppointmentLinkedCard {...props({ reservationView: projection })} />); await opened(); assertHeld();
    expect(screen.getByText('No end recorded')).toBeTruthy();
  });
  it('never derives a legacy compatibility window from the fetched NULL end alone', async () => {
    reads({ ...detail(), appointment: { ...detail().appointment, scheduledEnd: null } });
    render(<AppointmentLinkedCard {...props({ reservationView: null })} />); await opened();
    expect(screen.getByText('No end recorded')).toBeTruthy();
    expect(screen.getByText(/Saved scheduling evidence is unavailable/)).toBeTruthy();
    expect(screen.queryByText(/Legacy compatibility window|Legacy travel gap|120 elapsed minutes/)).toBeNull();
  });
  it.each([`?appointmentId=${appointmentId}&organizationId=${other}`, `?appointmentId=${appointmentId}&organizationId=${org}&appointmentId=${other}`])('keeps invalid/foreign exact links separate without fetching %s', async search => {
    const fetch = reads(); render(<AppointmentLinkedCard {...props({ search })} />);
    await screen.findByRole('alert'); expect(fetch).not.toHaveBeenCalled();
    expect(screen.queryByRole('region', { name: 'Selected appointment' })).toBeNull();
  });
  it.each(['foreign-org', 'wrong-id', 'private-field', 'bad-start', 'malformed', 'http-error'])('validates fetched detail and rejects %s without trusting the matching projection', async kind => {
    const response = detail();
    if (kind === 'foreign-org') response.organizationId = other;
    if (kind === 'wrong-id') response.appointment.id = other;
    if (kind === 'private-field') Object.assign(response.appointment, { notes: 'Private detail note' });
    if (kind === 'bad-start') response.appointment.scheduledStart = 'bad';
    if (kind === 'http-error') vi.stubGlobal('fetch', vi.fn(async () => Response.json({}, { status: 404 })));
    else reads(kind === 'malformed' ? {} : response);
    render(<AppointmentLinkedCard {...props()} />);
    await screen.findByText(/The linked appointment is unavailable/);
    expect(screen.queryByText('Exact technician')).toBeNull(); expect(screen.queryByText('Private detail note')).toBeNull();
    expect(screen.queryByRole('group', { name: 'Scheduling reservation' })).toBeNull();
  });
  it('cancels prior-scope reads and ignores late errors while the next exact detail succeeds', async () => {
    let reject!: (error: Error) => void;
    const pending = new Promise<Response>((_resolve, no) => { reject = no; });
    const fetch = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>().mockReturnValueOnce(pending).mockResolvedValue(Response.json(detail()));
    vi.stubGlobal('fetch', fetch); const input = props(); const view = render(<AppointmentLinkedCard {...input} />);
    const oldSignal = fetch.mock.calls[0][1]!.signal!;
    view.rerender(<AppointmentLinkedCard {...input} scopeKey="org:other-actor:read" />); await opened();
    expect(oldSignal.aborted).toBe(true);
    await act(async () => { reject(new Error('Late prior-scope read error')); });
    expect(screen.queryByText(/linked appointment is unavailable/)).toBeNull();
    expect(screen.getByText(/Saved travel gap: 60 minutes/)).toBeTruthy();
  });
  it('ignores late success after a different exact link and holds the new read failure separately from the schedule', async () => {
    let resolve!: (response: Response) => void;
    const pending = new Promise<Response>(done => { resolve = done; });
    const fetch = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>().mockReturnValueOnce(pending).mockResolvedValue(Response.json({}, { status: 404 }));
    vi.stubGlobal('fetch', fetch); const input = props(); const view = render(<AppointmentLinkedCard {...input} />);
    view.rerender(<AppointmentLinkedCard {...input} search={`?appointmentId=${other}&organizationId=${org}`} />);
    await screen.findByText(/The linked appointment is unavailable/);
    await act(async () => { resolve(Response.json(detail())); });
    expect(screen.queryByText('Exact technician')).toBeNull(); expect(screen.getByText(/schedule below is separate/)).toBeTruthy();
    expect(fetch.mock.calls[0][1]!.signal!.aborted).toBe(true);
  });
  it('refreshes explicitly, holds old projection on a newer detail version, and never mutates on read/remount', async () => {
    const newer = detail(); newer.appointment.updatedAt = '2035-01-01T16:30:00.000Z';
    const fetch = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>().mockImplementationOnce(async () => Response.json(detail())).mockImplementation(async () => Response.json(newer));
    vi.stubGlobal('fetch', fetch); const input = props(); const view = render(<AppointmentLinkedCard {...input} />); await opened();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh linked appointment' })); await opened(); assertHeld();
    view.unmount(); render(<AppointmentLinkedCard {...input} />); await opened(); assertHeld();
    expect(fetch.mock.calls).toHaveLength(3);
    expect(fetch.mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(true);
  });
});
