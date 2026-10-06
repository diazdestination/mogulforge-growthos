/**
 * Accessibility guard: every interactive control (button / link) rendered by
 * the CRM shell and each page — including their create/edit modals — must
 * expose a non-empty accessible name. This is what keeps icon-only controls
 * (modal close buttons, drawer close, row edit/delete, lightbox arrows, ...)
 * usable with a screen reader after the next restyle.
 *
 * If this test fails, the offending element's outerHTML is printed — add an
 * `aria-label` (or visible text) to it.
 */
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { computeAccessibleName } from 'dom-accessibility-api';
import { memoryLocation } from 'wouter/memory-location';
import { Router } from 'wouter';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RoiReport } from '@workspace/api-client-react';

import { Shell } from '@/components/shell';
import Dashboard from '@/pages/dashboard';
import Pipeline from '@/pages/pipeline';
import Contacts from '@/pages/contacts';
import Properties from '@/pages/properties';
import Estimates from '@/pages/estimates';
import Projects from '@/pages/projects';
import Tasks from '@/pages/tasks';
import Appointments from '@/pages/appointments';
import AuditLog from '@/pages/audit';
import Settings from '@/pages/settings';
import FormsPage from '@/pages/forms';
import Reactivation from '@/pages/reactivation';
import Capture from '@/pages/capture';
import Reports from '@/pages/reports';
import LeadDetail from '@/pages/lead-detail';
import { sampleContact, sampleLead } from '@/test/mock-api';
import { mockApi } from '@/test/mock-api';
import { renderWithQuery } from '@/test/render';

vi.mock('@workspace/replit-auth-web', () => ({
  useAuth: () => ({
    user: { id: 'u1' },
    isLoading: false,
    isAuthenticated: true,
    login: vi.fn(),
    logout: vi.fn(),
  }),
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/**
 * Asserts every rendered button/link has a non-empty accessible name.
 * Fails with the outerHTML of each offender so the fix is obvious.
 */
function expectAllControlsNamed({ mayBeEmpty = false } = {}) {
  const controls = Array.from(
    document.body.querySelectorAll<HTMLElement>(
      'button, a[href], [role="button"], [role="link"]',
    ),
  );
  if (!mayBeEmpty) expect(controls.length).toBeGreaterThan(0);
  const unnamed = controls.filter(
    (el) => computeAccessibleName(el).trim() === '',
  );
  expect(
    unnamed.map((el) => el.outerHTML.slice(0, 200)),
    'these interactive controls have no accessible name (add aria-label or text)',
  ).toEqual([]);
}

function renderAt(path: string, ui: React.ReactElement) {
  const { hook } = memoryLocation({ path });
  return renderWithQuery(<Router hook={hook}>{ui}</Router>);
}

async function settle() {
  // Wait for loading spinners to clear so real content (rows, actions) is up.
  await waitFor(() => {
    expect(document.querySelector('.animate-spin')).toBeNull();
  });
}

describe('every icon-only control keeps an accessible name', () => {
  it('shell, including the mobile menu drawer', async () => {
    mockApi('owner');
    renderAt('/', <Shell><div>content</div></Shell>);
    await screen.findAllByText('Painless');
    expectAllControlsNamed();
    // Open the mobile full-menu drawer (icon-only close button lives there).
    fireEvent.click(screen.getByRole('button', { name: 'Menu' }));
    await screen.findByRole('button', { name: 'Close menu' });
    expectAllControlsNamed();
  });

  // Object-shaped endpoints the dashboard needs (mockApi defaults to []).
  const dashboardHandler = (_method: string, path: string) => {
    if (path.endsWith('/api/v1/dashboard/summary')) {
      return new Response(
        JSON.stringify({ totalLeads: 1, openTasks: 1, upcomingAppointments: 1, pipelineValueCents: 0, leadsByStatus: {} }),
        { headers: { 'content-type': 'application/json' } },
      );
    }
    if (path.includes('/marketing')) {
      return new Response(
        JSON.stringify({ totalPageViews: 0, uniqueVisitors: 0, aiReferralViews: 0, landingPages: [], referrers: [] }),
        { headers: { 'content-type': 'application/json' } },
      );
    }
    return undefined;
  };

  const pages: Array<{
    name: string;
    path: string;
    Page: React.ComponentType;
    /** Pages that legitimately render zero buttons/links in this fixture. */
    mayBeEmpty?: boolean;
    handler?: (method: string, path: string) => Response | undefined;
    /** Accessible name of the button that opens the page's form modal. */
    openModal?: RegExp;
    /** Something that proves the modal is open. */
    modalHeading?: string | RegExp;
  }> = [
    { name: 'dashboard', path: '/', Page: Dashboard, mayBeEmpty: true, handler: dashboardHandler },
    { name: 'pipeline', path: '/pipeline', Page: Pipeline },
    {
      name: 'contacts', path: '/contacts', Page: Contacts,
      openModal: /add contact/i, modalHeading: 'New Contact',
    },
    {
      name: 'properties', path: '/properties', Page: Properties,
      openModal: /add property/i, modalHeading: /new property/i,
    },
    {
      name: 'estimates', path: '/estimates', Page: Estimates,
      openModal: /new estimate/i, modalHeading: 'New Estimate',
    },
    {
      name: 'projects', path: '/projects', Page: Projects,
      openModal: /new project/i, modalHeading: /new project/i,
    },
    {
      name: 'tasks', path: '/tasks', Page: Tasks,
      openModal: /add task|new task/i, modalHeading: /task/i,
    },
    {
      name: 'appointments', path: '/appointments', Page: Appointments,
      openModal: /schedule/i, modalHeading: /appointment/i,
    },
    { name: 'audit', path: '/audit', Page: AuditLog, mayBeEmpty: true },
    {
      name: 'forms', path: '/forms', Page: FormsPage,
      openModal: /new form/i, modalHeading: 'New form',
    },
    { name: 'reactivation', path: '/reactivation', Page: Reactivation },
    { name: 'capture', path: '/capture', Page: Capture },
    {
      name: 'reports', path: '/reports', Page: Reports,
      handler: (_method: string, path: string) => {
        const period = {
          startAt: '2026-09-01T00:00:00.000Z',
          endAt: '2026-10-01T00:00:00.000Z',
          timeZone: 'UTC' as const,
        };
        if (path.endsWith('/reports/roi')) {
          return new Response(
            JSON.stringify({
              windowDays: 30,
              generatedAt: period.endAt,
              period,
              comparison: {
                period: { startAt: '2026-08-02T00:00:00.000Z', endAt: period.startAt, timeZone: 'UTC' },
                appointmentsRecorded: 0,
                won: 0,
                recordedWinValueCents: 0,
                unknownWinValues: 0,
              },
              dataQuality: { unknownOriginalDates: 0, unknownWinValues: 0, unknownPipelineValues: 0, importedFirstTouchExcluded: 0 },
              evidence: [],
              leads: { total: 1, qualified: 1, native: 1, imported: 0, bySource: [], byCampaign: [], byTool: [], byLandingPage: [], byServiceType: [] },
              appointments: { total: 0, distinctBookedLeads: 0, leadsWithAppointment: 0, appointmentRatePct: 0 },
              responsiveness: { leadsContacted: 0, leadsReplied: 0, responseRatePct: null, medianMinutesToFirstTouch: null, firstTouchMeasuredLeads: 0 },
              playbooks: [],
              reviewsAndReferrals: { reviewRequestsSent: 0, reviewLinkClicks: 0, referralRequestsSent: 0, referralSubmissions: 0, referralLeads: 0 },
              reactivation: { campaignsLaunched: 0, leadsEnrolled: 0, leadsReplied: 0 },
              outcomes: { won: 0, revenueWonCents: 0, revenueByAttribution: [], pipelineValueCents: 0, lost: 0, lostReasons: [] },
            } satisfies RoiReport),
            { headers: { 'content-type': 'application/json' } },
          );
        }
        if (path.endsWith('/revenue/value')) {
          return new Response(
            JSON.stringify({
              period,
              entryCount: 0,
              receiptEntryCount: 0,
              costEntryCount: 0,
              acceptedEstimateCount: 0,
              acceptedEstimateCents: 0,
              completedProjectCount: 0,
              netReceiptsCents: 0,
              netDirectCostsCents: 0,
              recordedContributionCents: null,
              undatedAcceptedEstimateCount: 0,
              undatedCompletedProjectCount: 0,
              entries: [],
              boundary: 'Staff-recorded entries; no bank/accounting synchronization or causal ROI.',
            }),
            { headers: { 'content-type': 'application/json' } },
          );
        }
        return undefined;
      },
    },
  ];

  const json = (body: unknown) =>
    new Response(JSON.stringify(body), {
      headers: { 'content-type': 'application/json' },
    });

  it.each(pages)('$name page (and its modal)', async ({ path, Page, openModal, modalHeading, mayBeEmpty, handler }) => {
    mockApi('owner', handler ? { handler } : {});
    renderAt(path, <Page />);
    await settle();
    // Work reads wait for the active-company profile first; the text-only
    // authority loader is not an empty completed page or a spinner to settle.
    if (path === '/appointments') await screen.findByRole('button', { name: 'Schedule appointment' });
    if (path === '/estimates') await screen.findByRole('button', { name: 'New Estimate' });
    if (path === '/projects') await screen.findByRole('button', { name: 'New Project' });
    if (path === '/reports') {
      await screen.findByRole('region', { name: 'Win evidence' });
      await screen.findByRole('region', { name: 'Value ledger' });
    }
    expectAllControlsNamed({ mayBeEmpty });

    if (openModal) {
      const openers = await screen.findAllByRole('button', { name: openModal });
      fireEvent.click(openers[0]);
      if (modalHeading) {
        await screen.findAllByText(modalHeading);
      }
      expectAllControlsNamed();
    }
  });

  it("pipeline Today's Actions rows, including the expanded draft panel", async () => {
    const queueAction = {
      leadId: 'lead-1',
      actionType: 'send_message',
      title: 'Send a follow-up',
      reasons: ['No touch in 5 days'],
      priority: 1,
      channel: 'email',
      leadSummary: 'Roof replacement',
      leadStatus: 'contacted',
      contactName: 'Dana Homeowner',
      score: 80,
    };
    mockApi('owner', {
      handler: (_method, path) => {
        if (path.endsWith('/api/v1/next-actions')) return json([queueAction]);
        if (path.endsWith('/next-action')) {
          return json({
            ...queueAction,
            draft: { provider: 'openai', subject: 'Checking in', body: 'Hi Dana — following up.' },
          });
        }
        return undefined;
      },
    });
    renderAt('/pipeline', <Pipeline />);
    await settle();
    // Inline quick actions on the queue row are icon-only — must be named.
    await screen.findByRole('button', { name: /snooze suggestion for dana homeowner/i });
    screen.getByRole('button', { name: /dismiss suggestion for dana homeowner/i });
    expectAllControlsNamed();
    // Expand the draft panel and check the composer controls too.
    fireEvent.click(screen.getByRole('button', { name: /show draft for dana homeowner/i }));
    await screen.findByRole('textbox', { name: 'Draft message' });
    expectAllControlsNamed();
  });

  it('settings page, across every tab', async () => {
    mockApi('owner', {
      handler: (_method, path) => {
        if (path.endsWith('/api/v1/settings')) {
          return json({
            id: 's1',
            organizationId: 'o1',
            businessProfile: {},
            services: [],
            serviceAreas: [],
            securityAlertsAcknowledgedAt: null,
          });
        }
        if (path.endsWith('/api/v1/email-provider-status')) {
          return json({ provider: 'smtp', configured: true });
        }
        return undefined;
      },
    });
    renderAt('/settings', <Settings />);
    await settle();
    expectAllControlsNamed();
    // Walk every settings tab so icon-only controls inside each are checked.
    const tabs = screen.getAllByRole('tab');
    for (const tab of tabs) {
      fireEvent.mouseDown(tab);
      fireEvent.click(tab);
      await settle();
      expectAllControlsNamed();
    }
  }, 30_000); // walking every tab is slow when suites run in parallel

  it('lead detail page', async () => {
    mockApi('owner', {
      handler: (_method, path) => {
        if (path.endsWith(`/api/v1/leads/${sampleLead.id}`)) {
          return json({ ...sampleLead, scoreReasons: ['Recent storm in area'], contactId: sampleContact.id, propertyId: null });
        }
        if (path.endsWith(`/api/v1/contacts/${sampleContact.id}`)) {
          return json(sampleContact);
        }
        return undefined;
      },
    });
    renderAt(`/leads/${sampleLead.id}`, (
      <RouteAt path="/leads/:id">
        <LeadDetail />
      </RouteAt>
    ));
    await settle();
    // The lead heading proves the detail actually loaded (not an error state).
    await screen.findAllByText(sampleLead.summary);
    expectAllControlsNamed();
  });
});

/** Mounts children under a wouter route so useRoute/useParams resolve. */
import { Route } from 'wouter';
function RouteAt({ path, children }: { path: string; children: React.ReactNode }) {
  return <Route path={path}>{children}</Route>;
}
