import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { getGetMeQueryKey } from '@workspace/api-client-react';
import { SmartSitesControl } from './smart-sites-control';
import Capture from '@/pages/capture';
import { mockApi, sampleMe } from '@/test/mock-api';
import { renderWithQuery } from '@/test/render';
import { render } from '@testing-library/react';

const profiles = [
  {
    id: 'roofing-exteriors',
    name: 'Roofing & exteriors',
    services: [['siding', 'Siding']],
  },
  { id: 'hvac', name: 'HVAC', services: [['repair', 'HVAC repair']] },
  {
    id: 'commercial-construction',
    name: 'Commercial construction',
    services: [['new-build', 'New build']],
  },
  {
    id: 'local-retail',
    name: 'Local retail & tea shop',
    services: [['group-order', 'Group order inquiry']],
  },
];
const site = {
  id: 'site-1',
  name: 'Test Smart Site',
  siteKey: 'test-smart-site',
  profile: 'roofing-exteriors',
  isActive: false,
};
const secret = 'ss_' + 'a'.repeat(64); // Synthetic unit-test credential, never a provider key.
const emptyOverview = { rows: [], recent: [] };
const response = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
function setup(
  role = 'owner',
  override?: (method: string, path: string) => Response | undefined,
) {
  return mockApi(role, {
    handler: (method, path) => {
      const custom = override?.(method, path);
      if (custom) return custom;
      if (path.endsWith('/smart-sites/profiles')) return response(profiles);
      if (path.endsWith('/smart-sites/overview'))
        return response(emptyOverview);
      if (path.endsWith('/smart-sites') && method === 'GET')
        return response([site]);
      if (path.endsWith('/smart-sites') && method === 'POST')
        return response({ ...site, secret }, 201);
      return undefined;
    },
  });
}
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Smart Sites operator controls', () => {
  it('shows four starter profiles, creates a draft, and dismisses its one-time key', async () => {
    const calls = setup();
    renderWithQuery(<SmartSitesControl />);
    await screen.findByLabelText('Site name');
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(4));
    fireEvent.change(screen.getByLabelText('Site name'), {
      target: { value: 'HVAC test' },
    });
    fireEvent.change(screen.getByLabelText('Unique source label'), {
      target: { value: 'hvac-local-test' },
    });
    fireEvent.change(screen.getByLabelText('Business intake profile'), {
      target: { value: 'hvac' },
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Create draft connection' }),
    );
    await screen.findByText('Save this server key securely');
    const call = calls.mock.calls.find(([, init]) => init?.method === 'POST');
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({
      name: 'HVAC test',
      siteKey: 'hvac-local-test',
      profile: 'hvac',
    });
    expect(
      (
        screen.getByLabelText(
          'Server environment settings for Test Smart Site',
        ) as HTMLTextAreaElement
      ).value,
    ).toContain(secret);
    fireEvent.click(
      screen.getByRole('button', { name: 'I saved it securely' }),
    );
    expect(screen.queryByText('Save this server key securely')).toBeNull();
    expect(screen.getByText('Capture off')).toBeTruthy();
  });
  it('lets a viewer read inquiries without provisioning, activation or key controls', async () => {
    setup('viewer');
    renderWithQuery(<SmartSitesControl />);
    await screen.findByText('Test Smart Site');
    expect(
      screen.queryByRole('button', { name: 'Create draft connection' }),
    ).toBeNull();
    expect(screen.queryByRole('button', { name: 'Enable capture' })).toBeNull();
    expect(
      screen.queryByRole('button', { name: 'Replace server key' }),
    ).toBeNull();
  });
  it('shows unknown rather than invented zero metrics when reporting is unavailable', async () => {
    setup('owner', (_m, p) =>
      p.endsWith('/overview')
        ? response({ error: 'Reporting unavailable' }, 503)
        : undefined,
    );
    renderWithQuery(<SmartSitesControl />);
    await screen.findByRole('alert');
    expect(screen.getAllByText('—')).toHaveLength(4);
    expect(screen.queryByText('$0')).toBeNull();
  });
  it('links authoritative lead records and labels won value separately from cash', async () => {
    setup('owner', (_m, p) =>
      p.endsWith('/overview')
        ? response({
            rows: [
              {
                siteId: 'site-1',
                captured: 3,
                unassigned: 2,
                won: 1,
                contractValueCents: 123400,
              },
            ],
            recent: [
              {
                leadId: 'real-receipt-lead',
                name: 'Local QA',
                service: 'Siding',
                status: 'new',
                source: 'test-smart-site',
                createdAt: '2026-09-12T12:00:00Z',
              },
            ],
          })
        : undefined,
    );
    renderWithQuery(<SmartSitesControl />);
    const link = await screen.findByRole('link', { name: /Local QA · Siding/ });
    expect(link.getAttribute('href')).toBe('/leads/real-receipt-lead');
    expect(screen.getAllByText('$1,234')).toHaveLength(2);
    expect(screen.getByText(/not collected cash, ROI or profit/)).toBeTruthy();
  });
  it('handles a malformed reporting response without crashing or fabricating counts', async () => {
    setup('owner', (_m, p) =>
      p.endsWith('/overview') ? response([]) : undefined,
    );
    renderWithQuery(<SmartSitesControl />);
    await screen.findByText(/Reporting returned an unexpected response/);
    expect(screen.getAllByText('—')).toHaveLength(4);
    expect(screen.getByText('Test Smart Site')).toBeTruthy();
  });
  it('discards a revealed key when the authenticated organization changes', async () => {
    setup();
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    client.setQueryData(getGetMeQueryKey(), sampleMe('owner'));
    render(
      <QueryClientProvider client={client}>
        <SmartSitesControl />
      </QueryClientProvider>,
    );
    await screen.findByLabelText('Site name');
    fireEvent.submit(screen.getByLabelText('Site name').closest('form')!);
    await screen.findByText('Save this server key securely');
    client.setQueryData(getGetMeQueryKey(), {
      ...sampleMe('owner'),
      organization: {
        id: 'o2',
        name: 'Another client',
        slug: 'other',
        timezone: 'UTC',
      },
    });
    await waitFor(() =>
      expect(screen.queryByText('Save this server key securely')).toBeNull(),
    );
    expect(client.getQueryData(['smart-sites', 'o1', 'list'])).toBeTruthy();
    await waitFor(() =>
      expect(client.getQueryData(['smart-sites', 'o2', 'list'])).toBeTruthy(),
    );
  });
  it('does not nest another navigation shell inside the capture page', async () => {
    setup();
    renderWithQuery(<Capture />);
    await screen.findByText('Your sites. One growth workspace.');
    expect(screen.queryByRole('complementary')).toBeNull();
    expect(
      screen
        .getByText('Advanced: existing forms & developer APIs')
        .closest('details')?.open,
    ).toBe(false);
  });
});
