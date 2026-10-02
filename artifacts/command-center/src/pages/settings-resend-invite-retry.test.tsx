/**
 * Invitation transport failures are not proof that no email was accepted.
 * Never offer an immediate Retry action or claim inbox delivery. A 429 is a
 * request cooldown, not evidence that the earlier email was delivered.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import Settings from '@/pages/settings';
import { Toaster } from '@/components/ui/toaster';
import { renderWithQuery } from '@/test/render';
import { mockApi } from '@/test/mock-api';

const inviteUser = {
  id: 'invite:pending@example.com',
  email: 'pending@example.com',
  firstName: 'Pending',
  lastName: 'Invitee',
  role: 'sales_rep',
  isActive: true,
};

function jsonResponse(body: unknown, status = 200, extraHeaders: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...extraHeaders },
  });
}

const resendPath = `/api/v1/users/${inviteUser.id}/resend-invite`;

function renderTeamSettings(handler: (method: string, path: string) => Response | undefined) {
  const fetchMock = mockApi('admin', {
    handler: (method, path) => {
      if (method === 'GET' && path.endsWith('/api/v1/settings')) return jsonResponse({});
      if (method === 'GET' && path.endsWith('/api/v1/users')) return jsonResponse([inviteUser]);
      return handler(method, path);
    },
  });
  renderWithQuery(
    <>
      <Settings />
      <Toaster />
    </>,
  );
  return fetchMock;
}

const resendCalls = (fetchMock: ReturnType<typeof mockApi>) =>
  fetchMock.mock.calls.filter(([input, init]) => {
    const url = String(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    ).split('?')[0];
    const method = (init?.method ?? 'GET').toUpperCase();
    return method === 'POST' && url.endsWith(resendPath);
  });

async function openTeamTabAndResend() {
  const teamTab = await screen.findByRole('tab', { name: /team/i });
  fireEvent.mouseDown(teamTab);
  fireEvent.click(teamTab);
  const resend = await screen.findByTestId(`button-resend-invite-${inviteUser.id}`);
  fireEvent.click(resend);
}

describe('Settings resend-invite outcome safety', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('requires reconciliation without a Retry action when the request fails', async () => {
    const fetchMock = renderTeamSettings((method, path) => {
      if (method === 'POST' && path.endsWith(resendPath)) {
        return jsonResponse({ error: 'boom' }, 500);
      }
      return undefined;
    });

    await openTeamTabAndResend();

    await waitFor(() => expect(resendCalls(fetchMock).length).toBe(1));
    await waitFor(() => {
      expect(screen.getByText(/invite email outcome unconfirmed/i)).toBeTruthy();
    });
    expect(screen.queryByRole('button', { name: /retry/i })).toBeNull();
    expect(screen.getByText(/check provider delivery records/)).toBeTruthy();
    expect(screen.queryByText(/temporarily limited/i)).toBeNull();
  });

  it('shows a cooldown without claiming the prior email was sent', async () => {
    renderTeamSettings((method, path) => {
      if (method === 'POST' && path.endsWith(resendPath)) {
        return jsonResponse({ error: 'Too Many Requests' }, 429, { 'retry-after': '42' });
      }
      return undefined;
    });

    await openTeamTabAndResend();

    await waitFor(() => {
      expect(screen.getByText(/resend is temporarily limited/i)).toBeTruthy();
    });
    expect(screen.getByText(/about 42 seconds/i)).toBeTruthy();
    // Shows a cooldown notice, not a failure — no retry action.
    expect(screen.queryByText(/invite email outcome unconfirmed/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /retry/i })).toBeNull();
  });

  it('does not turn an uncertain provider response into an immediate retry', async () => {
    const fetchMock = renderTeamSettings((method, path) => {
      if (method === 'POST' && path.endsWith(resendPath)) {
        return jsonResponse({ sent: false, error: 'CANARY_PRIVATE_PROVIDER_DETAIL' });
      }
      return undefined;
    });

    await openTeamTabAndResend();

    await waitFor(() => expect(resendCalls(fetchMock).length).toBe(1));
    await screen.findByText(/invite email outcome unconfirmed/i);
    expect(screen.queryByRole('button', { name: /retry/i })).toBeNull();
    expect(screen.queryByText(/CANARY_PRIVATE_PROVIDER_DETAIL/)).toBeNull();
    expect(screen.queryByText(/cannot activate/)).toBeNull();
    expect(resendCalls(fetchMock)).toHaveLength(1);
  });

  it('distinguishes provider acceptance from inbox delivery', async () => {
    const fetchMock = renderTeamSettings((method, path) => {
      if (method === 'POST' && path.endsWith(resendPath)) {
        return jsonResponse({ sent: true, error: null });
      }
      return undefined;
    });

    await openTeamTabAndResend();

    await waitFor(() => expect(resendCalls(fetchMock).length).toBe(1));
    await screen.findByText(/invitation email accepted for sending/i);
    expect(screen.getByText(/Inbox delivery is not yet confirmed/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /retry/i })).toBeNull();
    expect(resendCalls(fetchMock)).toHaveLength(1);
  });

  it('does not claim a newly invited teammate cannot activate after an unknown send', async () => {
    renderTeamSettings((method, path) => method === 'POST' && path.endsWith('/api/v1/users/invite')
      ? jsonResponse({ ...inviteUser, inviteEmail: { sent: false, error: 'CANARY_PRIVATE_PROVIDER_DETAIL' } })
      : undefined);
    const tab = await screen.findByRole('tab', { name: /team/i });
    fireEvent.mouseDown(tab);
    fireEvent.click(tab);
    fireEvent.change(await screen.findByPlaceholderText('email@company.com'), { target: { value: 'new@example.test' } });
    fireEvent.click(screen.getByRole('button', { name: 'Invite', exact: true }));
    await screen.findByText('Invite created; email outcome unconfirmed');
    expect(screen.getByText(/Check provider delivery records/)).toBeTruthy();
    expect(screen.queryByText(/cannot activate|CANARY_PRIVATE_PROVIDER_DETAIL/)).toBeNull();
    expect(screen.queryByRole('button', { name: /retry/i })).toBeNull();
  });
});
