import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ServiceWatchPanel, ServiceWatchQueue, type WatchDetail } from '@/components/service-watch-panel';
import ServiceDesk from '@/pages/service-desk';
import { renderWithQuery } from '@/test/render';
import { mockApi } from '@/test/mock-api';

const serviceId = '11111111-1111-4111-8111-111111111111';
const detail = (): WatchDetail => ({ obligationId: serviceId, customerLabel: 'Synthetic customer', equipmentLabel: 'Heat pump', serviceStatus: 'active', dueDate: '2035-01-01', expectedVersion: 2, expectedFingerprint: 'a'.repeat(64), state: 'open', reasons: ['no_response_recorded'], monitorPending: false, assignedUserId: 'staff', ownerValid: true, held: false, nextAction: null, nextActionAt: null, lastEvaluatedAt: '2026-10-02T12:00:00Z', timezone: 'America/New_York', timezoneFallback: false, history: [], historyHasMore: false });
const emptyList = { items: [], hasMore: false, unmonitoredCount: 0, held: false };
function setup(handler: (method: string, path: string) => Response | undefined) {
  return mockApi('office', { handler: (method, path) => path.endsWith('/api/v1/users') ? Response.json([{ id: 'staff', firstName: 'Synthetic', lastName: 'Office', role: 'office', isActive: true, operationallyEligible: true }]) : path.endsWith('/api/v1/service-watch') ? handler(method, path) ?? Response.json(emptyList) : handler(method, path) });
}
function renderPanel(editable = true) { renderWithQuery(<ServiceWatchPanel obligationId={serviceId} editable={editable} onOpenCare={vi.fn()} onChanged={vi.fn(async () => {})} onClose={vi.fn()} />); }
function fillPlan() {
  fireEvent.change(screen.getByLabelText('Office next action / assignment note'), { target: { value: 'Office will review the actual customer conversation.' } });
  fireEvent.change(screen.getByLabelText(/Office follow-up deadline/), { target: { value: '2035-01-01T12:00' } });
  fireEvent.click(screen.getByLabelText(/I reviewed these current exceptions/));
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.history.replaceState({}, '', '/'); });

it('shows factual recorded-silence language and saves only an explicit versioned office plan', async () => {
  let saved = false;
  const fetch = setup((method, path) => {
    if (method === 'PATCH') { saved = true; return Response.json({ caseId: 'case', version: 3 }); }
    if (path.endsWith('/watch')) return Response.json({ ...detail(), state: saved ? 'acknowledged' : 'open', expectedVersion: saved ? 3 : 2 });
  });
  renderPanel(); await screen.findByText('No customer response recorded after three days');
  expect(screen.getByText(/An office plan is not a customer response/)).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Acknowledge and save office plan' })).toHaveProperty('disabled', true);
  fillPlan(); fireEvent.click(screen.getByRole('button', { name: 'Acknowledge and save office plan' }));
  await screen.findByText(/Office plan saved/);
  const writes = fetch.mock.calls.filter(([, request]) => request?.method === 'PATCH'); expect(writes).toHaveLength(1);
  expect(JSON.parse(String(writes[0][1]?.body))).toMatchObject({ action: 'acknowledge', expectedVersion: 2, expectedFingerprint: 'a'.repeat(64), reviewed: true, assignedUserId: 'staff' });
  expect(fetch.mock.calls.some(([url]) => /\/response|\/book|\/reminder/.test(String(url)))).toBe(false);
});

it('locks a failed/lost acknowledgement until explicit refresh and requires a new review checkbox', async () => {
  let changed = false;
  const fetch = setup((method, path) => {
    if (method === 'PATCH') { changed = true; return Response.json({ error: 'Source changed or response was lost.' }, { status: 409 }); }
    if (path.endsWith('/watch')) return Response.json({ ...detail(), expectedVersion: changed ? 3 : 2, expectedFingerprint: changed ? 'b'.repeat(64) : 'a'.repeat(64) });
  });
  renderPanel(); await screen.findByText('No customer response recorded after three days'); fillPlan();
  fireEvent.click(screen.getByRole('button', { name: 'Acknowledge and save office plan' }));
  await screen.findByRole('alert'); expect(screen.getByRole('button', { name: 'Acknowledge and save office plan' })).toHaveProperty('disabled', true);
  fireEvent.click(screen.getByRole('button', { name: 'Refresh and review watch' }));
  await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  expect(screen.getByLabelText(/I reviewed these current exceptions/)).toHaveProperty('checked', false);
  expect(fetch.mock.calls.filter(([, request]) => request?.method === 'PATCH')).toHaveLength(1);
});

it('keeps held/unknown history visible without exposing write controls to viewers', async () => {
  setup((_method, path) => path.endsWith('/watch') ? Response.json({ ...detail(), held: true, state: 'held', reasons: ['send_unknown'], history: [{ id: 'history', action: 'service.watch_held', createdAt: '2026-10-02T12:00:00Z', metadata: { state: 'held', reasons: ['send_unknown'] } }] }) : undefined);
  renderPanel(false); await screen.findByText(/Company work is paused or held/);
  expect(screen.getAllByText('Unknown send result — do not resend').length).toBeGreaterThan(0);
  expect(screen.queryByRole('button', { name: 'Acknowledge and save office plan' })).toBeNull();
  expect(screen.getByText(/Retained watch history/)).toBeTruthy();
});

it('does not call an unmonitored or failed queue an all-clear and preserves bounded paging', async () => {
  setup((_method, path) => path.endsWith('/service-watch') ? Response.json({ ...emptyList, unmonitoredCount: 70, hasMore: true }) : undefined);
  renderWithQuery(<ServiceWatchQueue organizationId="o1" revision={0} onOpen={vi.fn()} />);
  await screen.findByText(/70 active services await their first bounded monitor check/);
  expect(screen.getByRole('button', { name: 'Next watch page' })).toHaveProperty('disabled', false);
  expect(screen.getByText(/Up to 50 records per page/)).toBeTruthy();
});

it('ignores a late response from a previous selected service', async () => {
  let finish!: (response: Response) => void;
  const delayed = new Promise<Response>(resolve => { finish = resolve; });
  const fetch = setup((_method, path) => path.endsWith('/watch') ? Response.json({ ...detail(), customerLabel: 'Current service customer' }) : undefined);
  const fallback = fetch.getMockImplementation()!;
  fetch.mockImplementation(async (url, init) => String(url).includes(serviceId) ? delayed : fallback(url, init));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree = (id: string) => <QueryClientProvider client={client}><ServiceWatchPanel obligationId={id} editable={false} onOpenCare={vi.fn()} onChanged={vi.fn(async () => {})} onClose={vi.fn()} /></QueryClientProvider>;
  const view = render(tree(serviceId));
  view.rerender(tree('second'));
  await screen.findByText(/Current service customer/);
  await act(async () => { finish(Response.json({ ...detail(), customerLabel: 'Stale service customer' })); });
  expect(screen.queryByText(/Stale service customer/)).toBeNull();
});

it('opens a service notification independently of the first records page, but rejects another company', async () => {
  window.history.replaceState({}, '', `/service?serviceObligationId=${serviceId}&organizationId=o1`);
  const fetch = setup((_method, path) => path.endsWith('/watch') ? Response.json(detail()) : undefined);
  renderWithQuery(<ServiceDesk />);
  await screen.findByRole('region', { name: 'Service watch detail' });
  expect(await screen.findByText(/Synthetic customer · Heat pump/)).toBeTruthy();
  expect(fetch.mock.calls.some(([url]) => String(url).endsWith(`/service-obligations/${serviceId}/watch`))).toBe(true);
  cleanup(); window.history.replaceState({}, '', `/service?serviceObligationId=${serviceId}&organizationId=other-company`);
  const foreignFetch = setup((_method, path) => path.endsWith('/watch') ? Response.json(detail()) : undefined);
  renderWithQuery(<ServiceDesk />);
  await screen.findByText(/This service link is invalid or belongs to another company/);
  expect(foreignFetch.mock.calls.some(([url]) => String(url).endsWith('/watch'))).toBe(false);
  expect(screen.queryByRole('region', { name: 'Service watch detail' })).toBeNull();
});
