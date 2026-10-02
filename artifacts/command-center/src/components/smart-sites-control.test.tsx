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
  analyticsEnabled: false,
  analyticsRetentionDays: 90,
  analyticsPolicyVersion: 'smart-sites-analytics-v1',
};
const launchReadiness = {
  contract: 'smart-site-launch-guard-v1',
  serverNow: '2026-09-14T18:00:00.000Z',
  credentialCheckMaxAgeHours: 24,
  confirmationRequired: true,
  staffing: { activeManagers: 1, activeResponders: 1 },
  sites: [
    {
      id: site.id,
      isActive: false,
      credentialIssuedAt: '2026-09-14T17:00:00.000Z',
      credentialCheckedAt: '2026-09-14T17:05:00.000Z',
      credentialVersion: 1,
      ready: true,
      blockers: [],
    },
  ],
};
const secret = 'ss_' + 'a'.repeat(64); // Synthetic unit-test credential, never a provider key.
const emptyOverview = { rows: [], recent: [] };
const emptyAcquisition = {
  scope: 'Last 30 days, capped by each site retention policy',
  days: 30,
  summary: {
    visitors: 0,
    sessions: 0,
    startedVisitors: 0,
    phoneClicks: 0,
    voiceVisitors: 0,
    savedLeads: 0,
    qualifiedLeads: 0,
    appointmentLeads: 0,
    estimateLeads: 0,
    wonLeads: 0,
    wonValueCents: 0,
    medianMinutesToStaffLog: null,
  },
  events: [],
  sources: [],
  services: [],
  content: [],
  sites: [site],
  measurement: {
    phoneClicks: 'Telephone-link clicks; not completed or answered calls',
  },
};
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
      if (path.endsWith('/smart-sites/launch-readiness'))
        return response(launchReadiness);
      if (path.includes('/smart-sites/acquisition'))
        return response(emptyAcquisition);
      if (path.endsWith('/smart-sites/follow-up'))
        return response({
          serverNow: new Date().toISOString(),
          summary: {
            awaitingAttempt: 0,
            unassigned: 0,
            overdue: 0,
            noTarget: 0,
            logged: 0,
            medianMinutesToLog: null,
          },
          pending: [],
          members: [],
        });
      if (path.endsWith('/smart-sites') && method === 'GET')
        return response([site]);
      if (path.endsWith('/smart-sites') && method === 'POST')
        return response({ ...site, secret }, 201);
      if (path.endsWith(`/smart-sites/${site.id}`) && method === 'PATCH')
        return response({ ...site, isActive: true });
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
  it("guides both website types through the same draft flow without activating a connection", async () => {
    const calls = setup();
    renderWithQuery(<SmartSitesControl />);
    const existing = await screen.findByRole("radio", {
      name: "Keep my current website",
    });
    expect((existing as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByText("What happens before leads can arrive?"));
    expect(
      screen.getByText(/A supported backend or secure relay is required/),
    ).toBeTruthy();
    fireEvent.click(
      screen.getByRole("radio", { name: "Connect a MogulForge Smart Site" }),
    );
    expect(screen.getByText(/Have your Smart Site installer/)).toBeTruthy();
    expect(screen.getByText(/A draft does not enable capture/)).toBeTruthy();
    expect(
      calls.mock.calls.filter(
        ([, init]) => init?.method && init.method !== "GET",
      ),
    ).toHaveLength(0);
    fireEvent.change(screen.getByLabelText("Site name"), {
      target: { value: "Existing HVAC website" },
    });
    fireEvent.change(screen.getByLabelText("Unique source label"), {
      target: { value: "existing-hvac-website" },
    });
    fireEvent.change(screen.getByLabelText("Business intake profile"), {
      target: { value: "hvac" },
    });
    fireEvent.click(existing);
    fireEvent.click(
      screen.getByRole("button", { name: "Create draft connection" }),
    );
    await screen.findByText("Save this server key securely");
    const writes = calls.mock.calls.filter(
      ([, init]) => init?.method && init.method !== "GET",
    );
    expect(writes).toHaveLength(1);
    expect(JSON.parse(String(writes[0][1]?.body))).toEqual({
      name: "Existing HVAC website",
      siteKey: "existing-hvac-website",
      profile: "hvac",
    });
    expect(screen.getByText("Capture off")).toBeTruthy();
  });
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
    await screen.findAllByText('Test Smart Site');
    expect(
      screen.queryByRole('button', { name: 'Create draft connection' }),
    ).toBeNull();
    expect(screen.queryByRole('button', { name: 'Enable capture' })).toBeNull();
    expect(
      screen.queryByRole('button', { name: 'Replace server key' }),
    ).toBeNull();
  });
  it('keeps capture locked until readiness passes and an owner confirms the launch evidence', async () => {
    const calls = setup();
    renderWithQuery(<SmartSitesControl />);
    await screen.findByRole('group', {
      name: 'Test Smart Site launch guard',
    });
    const enable = screen.getByRole('button', { name: 'Enable capture' });
    const confirmation = screen.getByLabelText(
      /I confirm a real person owns this inbox/,
    );
    expect((enable as HTMLButtonElement).disabled).toBe(true);
    expect((confirmation as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(confirmation);
    expect((enable as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(enable);
    await screen.findByText(/Launch Guard passed/);
    const activation = calls.mock.calls.find(
      ([path, init]) =>
        path.endsWith(`/smart-sites/${site.id}`) && init?.method === 'PATCH',
    );
    expect(JSON.parse(String(activation?.[1]?.body))).toEqual({
      isActive: true,
      confirmedLaunch: true,
    });
  });
  it('explains missing response coverage and refuses the launch acknowledgement', async () => {
    setup('owner', (_method, path) =>
      path.endsWith('/smart-sites/launch-readiness')
        ? response({
            ...launchReadiness,
            staffing: { activeManagers: 1, activeResponders: 0 },
            sites: [
              {
                ...launchReadiness.sites[0],
                ready: false,
                blockers: ['active_responder_required'],
              },
            ],
          })
        : undefined,
    );
    renderWithQuery(<SmartSitesControl />);
    expect(
      await screen.findByText(/1 manager\(s\), 0 responder\(s\)/),
    ).toBeTruthy();
    expect(
      (
        screen.getByLabelText(
          /I confirm a real person owns this inbox/,
        ) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(
      (
        screen.getByRole('button', {
          name: 'Enable capture',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });
  it('elevates an active connection whose readiness evidence no longer passes', async () => {
    setup('owner', (method, path) => {
      if (path.endsWith('/smart-sites/launch-readiness'))
        return response({
          ...launchReadiness,
          sites: [
            {
              ...launchReadiness.sites[0],
              isActive: true,
              ready: false,
              blockers: ['credential_check_stale'],
            },
          ],
        });
      if (path.endsWith('/smart-sites') && method === 'GET')
        return response([{ ...site, isActive: true }]);
      return undefined;
    });
    renderWithQuery(<SmartSitesControl />);
    expect(
      await screen.findByText(
        /1 active connection no longer has a complete readiness record/,
      ),
    ).toBeTruthy();
    expect(screen.getByText(/Recheck the server credential/)).toBeTruthy();
  });
  it('shows unknown rather than invented zero metrics when reporting is unavailable', async () => {
    setup('owner', (_m, p) =>
      p.endsWith('/overview') || p.includes('/smart-sites/acquisition')
        ? response({ error: 'Reporting unavailable' }, 503)
        : undefined,
    );
    renderWithQuery(<SmartSitesControl />);
    await screen.findAllByRole('alert');
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(4);
    const acquisition = screen
      .getByText('From attention to actual outcomes')
      .closest('div.rounded-xl');
    expect(acquisition?.textContent).not.toContain('$0');
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
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(4);
    expect(screen.getAllByText('Test Smart Site')).toHaveLength(2);
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
  it('shows consented acquisition stages and requires an operator action to enable site measurement', async () => {
    const measuredSite = {
      ...site,
      isActive: true,
      analyticsEnabled: false,
      analyticsRetentionDays: 30,
    };
    const calls = setup('owner', (method, path) => {
      if (path.includes('/smart-sites/acquisition'))
        return response({
          ...emptyAcquisition,
          summary: {
            ...emptyAcquisition.summary,
            visitors: 12,
            startedVisitors: 8,
            phoneClicks: 3,
            voiceVisitors: 2,
            savedLeads: 4,
            appointmentLeads: 2,
            estimateLeads: 1,
            wonLeads: 1,
            wonValueCents: 850000,
          },
          sources: [
            { source: 'google', visitors: 10, savedLeads: 4, wonLeads: 1 },
          ],
          services: [
            { serviceCode: 'siding', visitors: 5, savedLeads: 2, wonLeads: 1 },
          ],
          content: [
            {
              path: '/services/siding-services',
              visitors: 5,
              savedLeads: 2,
              wonLeads: 1,
            },
          ],
          sites: [measuredSite],
        });
      if (
        path.endsWith(`/smart-sites/${site.id}/measurement`) &&
        method === 'PATCH'
      )
        return response({ ...measuredSite, analyticsEnabled: true });
      if (path.endsWith('/smart-sites') && method === 'GET')
        return response([measuredSite]);
      return undefined;
    });
    renderWithQuery(<SmartSitesControl />);
    await screen.findByText('From attention to actual outcomes');
    expect(
      await screen.findByText(
        /Current staff coverage and server credential checks pass/,
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/passed when capture was enabled/)).toBeNull();
    expect(await screen.findByText('$8,500')).toBeTruthy();
    expect(screen.getByText('3 phone-link clicks')).toBeTruthy();
    expect(screen.getByText('google')).toBeTruthy();
    expect(screen.getAllByText('Siding')).toHaveLength(2);
    expect(screen.getByText('Service Guide · Siding Services')).toBeTruthy();
    fireEvent.click(
      screen.getByRole('button', { name: 'Enable consented measurement' }),
    );
    await waitFor(() =>
      expect(
        calls.mock.calls.some(([, init]) => {
          const body = init?.body ? JSON.parse(String(init.body)) : null;
          return body?.enabled === true && body?.retentionDays === 30;
        }),
      ).toBe(true),
    );
  });
});
