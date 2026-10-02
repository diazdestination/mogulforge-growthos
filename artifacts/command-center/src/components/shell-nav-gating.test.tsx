/**
 * Verifies the Shell sidebar never shows the admin-only Settings and
 * Audit Log links to roles that can't open them (viewer, sales_rep), and
 * that admins/owners do see them. Also verifies direct navigation to
 * /settings redirects non-admins back to the dashboard.
 */
import { cleanup, screen, waitFor } from '@testing-library/react';
import { memoryLocation } from 'wouter/memory-location';
import { Router } from 'wouter';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Shell } from './shell';
import Settings from '@/pages/settings';
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

function renderShell() {
  const { hook } = memoryLocation({ path: '/' });
  return renderWithQuery(
    <Router hook={hook}>
      <Shell>
        <div>content</div>
      </Shell>
    </Router>,
  );
}

describe('Shell sidebar admin-link gating', () => {
  it.each([false, true])('gates Client Launchpad by platform access, not owner role (%s)', async (isPlatformAdmin) => {
    mockApi('owner', { handler: (_method, path) => path.endsWith('/session') ? new Response(JSON.stringify({ id: 'u1', isPlatformAdmin }), { headers: { 'Content-Type': 'application/json' } }) : undefined });
    renderShell();
    await screen.findAllByText('Painless');
    if (isPlatformAdmin) await screen.findAllByText('Client Launchpad');
    else expect(screen.queryAllByText('Client Launchpad')).toHaveLength(0);
  });
  it.each(['viewer', 'sales_rep'] as const)(
    '%s does not see Settings or Audit Log',
    async (role) => {
      mockApi(role);
      renderShell();
      await screen.findAllByText('Painless');
      expect(screen.queryAllByText('Settings')).toHaveLength(0);
      expect(screen.queryAllByText('Audit Log')).toHaveLength(0);
      // Sanity: regular nav items are still there.
      expect(screen.getAllByText('Dashboard').length).toBeGreaterThan(0);
    },
  );

  it.each(['admin', 'owner'] as const)(
    '%s sees Settings and Audit Log',
    async (role) => {
      mockApi(role);
      renderShell();
      await waitFor(() => {
        expect(screen.queryAllByText('Settings').length).toBeGreaterThan(0);
      });
      expect(screen.getAllByText('Audit Log').length).toBeGreaterThan(0);
    },
  );

  it('shows no admin links while the profile is still unknown', () => {
    mockApi('admin');
    // Before /me resolves, role is undefined -> links must be hidden.
    renderShell();
    expect(screen.queryAllByText('Settings')).toHaveLength(0);
    expect(screen.queryAllByText('Audit Log')).toHaveLength(0);
  });
});

describe('direct navigation to /settings', () => {
  it('redirects a sales_rep back to the dashboard', async () => {
    mockApi('sales_rep');
    const { hook, history } = memoryLocation({ path: '/settings', record: true });
    renderWithQuery(
      <Router hook={hook}>
        <Settings />
      </Router>,
    );
    await waitFor(() => {
      expect(history[history.length - 1]).toBe('/');
    });
    expect(screen.queryByText('Admin Settings')).toBeNull();
  });

  it('redirects a viewer back to the dashboard', async () => {
    mockApi('viewer');
    const { hook, history } = memoryLocation({ path: '/settings', record: true });
    renderWithQuery(
      <Router hook={hook}>
        <Settings />
      </Router>,
    );
    await waitFor(() => {
      expect(history[history.length - 1]).toBe('/');
    });
  });

  it('lets an admin stay on the settings page', async () => {
    mockApi('admin');
    const { hook, history } = memoryLocation({ path: '/settings', record: true });
    renderWithQuery(
      <Router hook={hook}>
        <Settings />
      </Router>,
    );
    await screen.findByText('Admin Settings');
    expect(history[history.length - 1]).toBe('/settings');
  });
});
