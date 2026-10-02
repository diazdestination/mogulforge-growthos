import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import Dashboard from '@/pages/dashboard';
import { renderWithQuery } from '@/test/render';
import { mockApi } from '@/test/mock-api';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const populatedSummary = {
  totalLeads: 10,
  openTasks: 0,
  upcomingAppointments: 0,
  unansweredPortalMessages: 0,
  leadsByStatus: [{ status: 'new', count: 10 }],
  recentActivities: [],
};

function renderDashboard(role: string, deleteRequests: string[]) {
  mockApi(role, {
    handler: (method, path) => {
      if (method === 'DELETE' && path.includes('/api/v1/demo-data')) {
        deleteRequests.push(path);
        // Exercise the recoverable error branch without reloading jsdom.
        return json({ error: 'test failure' }, 500);
      }
      if (method !== 'GET') return undefined;
      if (path.includes('/api/v1/settings/email-provider')) {
        return json({ provider: 'gmail', recentSendFailures: 0 });
      }
      if (path.includes('/api/v1/dashboard/marketing')) {
        return json({
          totalPageViews: 0,
          uniqueVisitors: 0,
          aiReferralViews: 0,
          landingPages: [],
          referrers: [],
        });
      }
      if (path.includes('/api/v1/dashboard')) return json(populatedSummary);
      return undefined;
    },
  });
  renderWithQuery(<Dashboard />);
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('dashboard sample-data cleanup control', () => {
  it('requires a second click and calls the narrow DELETE route for admins', async () => {
    const requests: string[] = [];
    renderDashboard('admin', requests);

    fireEvent.click(await screen.findByTestId('button-clear-demo-data'));
    expect(requests).toHaveLength(0);
    expect(screen.getByText(/real CRM records stay untouched/i)).toBeTruthy();

    fireEvent.click(screen.getByTestId('button-confirm-clear-demo-data'));
    await waitFor(() => expect(requests).toHaveLength(1));
    expect((await screen.findByRole('alert')).textContent).toMatch(/could not be cleared/i);
  });

  it('is not available to non-admin members', async () => {
    const requests: string[] = [];
    renderDashboard('sales_rep', requests);

    await screen.findByText(/welcome back/i);
    expect(screen.queryByTestId('button-clear-demo-data')).toBeNull();
    expect(requests).toHaveLength(0);
  });
});
