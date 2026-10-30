import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

import { RoutePlanCard } from './route-plan-card';

const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const stop = (id: string, name: string, hour: number, located = true) => ({
  appointmentId: id,
  scheduledStart: `2026-11-04T${hour}:00:00.000Z`,
  type: 'inspection',
  customerName: name,
  address: `${id} Main St, Dawsonville, GA 30534`,
  located,
});
const plan = {
  date: '2026-11-04',
  timeZone: 'America/New_York',
  stops: [stop('a', 'Customer A', 13), stop('d', 'Customer D', 14), stop('b', 'Customer B', 15), stop('c', 'Customer C', 16, false)],
  currentOrder: ['a', 'd', 'b'],
  suggestedOrder: ['a', 'b', 'd'],
  currentMiles: 30.2,
  suggestedMiles: 20.1,
  savedMiles: 10.1,
  currentDriveMinutes: 60,
  suggestedDriveMinutes: 40,
  unlocatedCount: 1,
  mapsUrl: 'https://www.google.com/maps/dir/?api=1&origin=a',
  suggestedMapsUrl: 'https://www.google.com/maps/dir/?api=1&origin=b',
  estimateNote: 'Estimates only.',
  geocoderEnabled: true,
};

it('shows the booked route, the shorter order, and locates missing stops on request', async () => {
  const fetchMock = vi.fn(async (url: string) =>
    url.startsWith('/api/v1/route-plan/locate')
      ? json({ located: 1, notFound: 0, plan: { ...plan, unlocatedCount: 0, stops: plan.stops.map((s) => ({ ...s, located: true })) } })
      : json(plan),
  );
  vi.stubGlobal('fetch', fetchMock);
  render(<RoutePlanCard date="2026-11-04" canWrite />);
  expect(await screen.findByText(/4 stops · about 30.2 mi, 60 min driving/)).toBeTruthy();
  expect(screen.getByText(/saves about/)).toBeTruthy();
  expect(screen.getByText(/Customer A → Customer B → Customer D/)).toBeTruthy();
  expect(screen.getByRole('link', { name: /Open route in Maps/ }).getAttribute('href')).toBe(plan.mapsUrl);
  fireEvent.click(screen.getByRole('button', { name: /Find on map/ }));
  await screen.findByText('Customer C');
  expect(fetchMock.mock.calls.some(([url]) => String(url) === '/api/v1/route-plan/locate')).toBe(true);
  expect(screen.queryByRole('button', { name: /Find on map/ })).toBeNull();
});

it('renders nothing on a day without stops', async () => {
  const fetchMock = vi.fn(async () => json({ ...plan, stops: [], currentOrder: [], suggestedOrder: [] }));
  vi.stubGlobal('fetch', fetchMock);
  const { container } = render(<RoutePlanCard date="2026-11-04" canWrite />);
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
  expect(container.textContent).toBe('');
});
