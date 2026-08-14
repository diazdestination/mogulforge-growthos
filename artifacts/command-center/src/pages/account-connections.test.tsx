import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import Account from '@/pages/account';
import { mockApi } from '@/test/mock-api';
import { renderWithQuery } from '@/test/render';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function renderSalesRepAccount(gmailStatus: Record<string, unknown> = {}) {
  const fetchMock = mockApi('sales_rep', {
    handler: (method, path) => {
      if (method === 'GET' && path.endsWith('/api/v1/integrations/gmail')) {
        return json({
          configured: true,
          connected: false,
          email: null,
          connectedAt: null,
          lastUsedAt: null,
          lastErrorAt: null,
          lastErrorCode: null,
          scope: 'https://www.googleapis.com/auth/gmail.send',
          ...gmailStatus,
        });
      }
      if (method === 'GET' && path.endsWith('/api/v1/integrations/google/modules')) return json([]);
      if (method === 'POST' && path.endsWith('/api/v1/integrations/gmail/connect')) {
        return json({ error: 'OAuth intentionally stopped by this test.' }, 400);
      }
      return undefined;
    },
  });
  renderWithQuery(<Account />);
  return fetchMock;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.replaceState({}, '', '/');
});

describe('My Profile connections', () => {
  it('lets a sales rep reach their personal Gmail connector without exposing Admin Settings', async () => {
    renderSalesRepAccount();

    expect(await screen.findByRole('heading', { name: 'My Connections' })).toBeTruthy();
    expect((await screen.findByRole('button', { name: 'Connect Gmail' }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByText('Admin Settings')).toBeNull();
  });

  it('returns the sales rep to My Profile after starting Gmail OAuth', async () => {
    const fetchMock = renderSalesRepAccount();
    fireEvent.click(await screen.findByRole('button', { name: 'Connect Gmail' }));

    await waitFor(() => {
      const connectCall = fetchMock.mock.calls.find(([input, init]) =>
        String(input).endsWith('/api/v1/integrations/gmail/connect') && init?.method === 'POST',
      );
      expect(connectCall).toBeDefined();
      expect(JSON.parse(String(connectCall?.[1]?.body))).toEqual({ returnPath: '/account' });
    });
  });

  it('fails closed with a clear reconnect action after Google revokes the grant', async () => {
    renderSalesRepAccount({
      connected: false,
      email: 'rep@example.com',
      connectedAt: '2026-08-14T10:00:00.000Z',
      lastErrorAt: '2026-08-14T12:00:00.000Z',
      lastErrorCode: 'gmail_reauthorization_required',
    });

    expect(await screen.findByText('Reconnect required')).toBeTruthy();
    expect(screen.getByText('Google access expired or was revoked. Reconnect Gmail before GrowthOS can send.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reconnect Gmail' })).toBeTruthy();
    expect(screen.getByText(/GrowthOS will not retry the expired credential/)).toBeTruthy();
  });
});
