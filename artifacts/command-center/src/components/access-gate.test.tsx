/**
 * Verifies the AccessGate blocks deactivated/removed teammates: the CRM
 * content is replaced with an "Access revoked" screen and the user is
 * signed out instead of being shown stale data.
 */
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AccessGate } from './access-gate';
import { mockApi } from '@/test/mock-api';
import { renderWithQuery } from '@/test/render';

const logout = vi.fn();

vi.mock('@workspace/replit-auth-web', () => ({
  useAuth: () => ({
    user: { id: 'u1' },
    isLoading: false,
    isAuthenticated: true,
    login: vi.fn(),
    logout,
  }),
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  logout.mockReset();
});

describe('AccessGate', () => {
  it('renders CRM content for an active member', async () => {
    mockApi('sales_rep');
    renderWithQuery(
      <AccessGate>
        <div data-testid="crm-content">CRM</div>
      </AccessGate>,
    );
    expect(await screen.findByTestId('crm-content')).toBeTruthy();
    expect(screen.queryByTestId('access-revoked')).toBeNull();
  });

  it('holds staff pages for an unverified member and requests verification for their account', async () => {
    const fetch = mockApi('owner', {
      me: { emailVerified: false },
      handler: (method, path) => method === 'POST' && path === '/api/auth/resend-verification'
        ? new Response('{}', { status: 202 }) : undefined,
    });
    renderWithQuery(<AccessGate><div data-testid="crm-content">CRM</div></AccessGate>);
    const button = await screen.findByRole('button', { name: 'Send verification email' });
    expect(screen.queryByTestId('crm-content')).toBeNull();
    expect(logout).not.toHaveBeenCalled();
    fireEvent.click(button);
    expect(await screen.findByRole('status')).toHaveProperty('textContent', expect.stringContaining('Verification requested'));
    expect(fetch).toHaveBeenCalledWith('/api/auth/resend-verification', expect.objectContaining({
      method: 'POST', credentials: 'include', body: JSON.stringify({ email: 'user@example.com' }),
    }));
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it('keeps verification failures visible and allows another request', async () => {
    mockApi('owner', {
      me: { emailVerified: false },
      handler: (_method, path) => path === '/api/auth/resend-verification'
        ? new Response('{}', { status: 503 }) : undefined,
    });
    renderWithQuery(<AccessGate><p>Private work</p></AccessGate>);
    fireEvent.click(await screen.findByRole('button', { name: 'Send verification email' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('could not request'));
    expect(screen.queryByText('Private work')).toBeNull();
    expect((screen.getByRole('button', { name: 'Send verification email' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('blocks a deactivated member (403) and offers immediate sign-out', async () => {
    mockApi('sales_rep', { meStatus: 403 });
    renderWithQuery(
      <AccessGate>
        <div data-testid="crm-content">CRM</div>
      </AccessGate>,
    );
    expect(await screen.findByTestId('access-revoked')).toBeTruthy();
    expect(screen.queryByTestId('crm-content')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /sign out now/i }));
    expect(logout).toHaveBeenCalled();
  });

  it('blocks a removed member whose session is rejected (401)', async () => {
    mockApi('sales_rep', { meStatus: 401 });
    renderWithQuery(
      <AccessGate>
        <div data-testid="crm-content">CRM</div>
      </AccessGate>,
    );
    expect(await screen.findByTestId('access-revoked')).toBeTruthy();
    expect(screen.queryByTestId('crm-content')).toBeNull();
  });

  it('blocks a member whose profile reports isActive: false', async () => {
    mockApi('sales_rep', { me: { isActive: false } });
    renderWithQuery(
      <AccessGate>
        <div data-testid="crm-content">CRM</div>
      </AccessGate>,
    );
    expect(await screen.findByTestId('access-revoked')).toBeTruthy();
    expect(screen.queryByTestId('crm-content')).toBeNull();
  });

  it('automatically signs the revoked member out shortly after blocking', async () => {
    mockApi('sales_rep', { meStatus: 403 });
    renderWithQuery(
      <AccessGate>
        <div data-testid="crm-content">CRM</div>
      </AccessGate>,
    );
    await screen.findByTestId('access-revoked');
    await vi.waitFor(() => expect(logout).toHaveBeenCalled(), {
      timeout: 5000,
    });
  });
});
