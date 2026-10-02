import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithQuery } from '@/test/render';
import { MobileNotificationsCard } from './mobile-notifications-card';

const publicBytes = new Uint8Array(65); publicBytes[0] = 4;
const publicKey = btoa(String.fromCharCode(...publicBytes)).replace(/=+$/, '');
const status = { supported: true, enabled: false, publicKey, organizationId: 'org-a', userId: 'user-a', subscriptions: [], policyConfigured: true };

function setup(options: { apple?: boolean; installed?: boolean; denied?: boolean; offline?: boolean; subscribeFail?: boolean } = {}) {
  const requestPermission = vi.fn().mockResolvedValue(options.denied ? 'denied' : 'granted');
  vi.stubGlobal('Notification', { permission: options.denied ? 'denied' : 'default', requestPermission });
  vi.stubGlobal('PushManager', function () {});
  vi.stubGlobal('isSecureContext', true);
  const subscription = { endpoint: 'https://push.example.test/token', unsubscribe: vi.fn().mockResolvedValue(true), toJSON: () => ({ endpoint: 'https://push.example.test/token', keys: { p256dh: 'public', auth: 'opaque' }, expirationTime: null }) };
  let active = false;
  const subscribe = vi.fn(async () => { active = true; return subscription; });
  const registration = { active: { scriptURL: `${location.origin}/growthos-sw.js` }, pushManager: { getSubscription: vi.fn(async () => active ? subscription : null), subscribe }, getNotifications: vi.fn().mockResolvedValue([]) };
  vi.stubGlobal('navigator', { userAgent: options.apple ? 'iPhone' : 'Android', standalone: options.installed ?? false, onLine: !options.offline, serviceWorker: { getRegistration: vi.fn().mockResolvedValue(registration), register: vi.fn().mockResolvedValue(registration), ready: Promise.resolve(registration) } });
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => new Response(JSON.stringify(url.endsWith('/status') ? status : {}), { status: options.subscribeFail && url.endsWith('/subscriptions') && init?.method === 'POST' ? 503 : 200 }));
  vi.stubGlobal('fetch', fetchMock);
  renderWithQuery(<MobileNotificationsCard />);
  return { requestPermission, subscribe, subscription, fetchMock };
}
afterEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('mobile notification opt-in', () => {
  it('shows iPhone installation guidance without prompting permission on load', async () => {
    const { requestPermission, subscribe } = setup({ apple: true });
    await screen.findByText(/Live push is held/);
    expect(screen.getByText(/Install and open the Home Screen app/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Enable lead notifications' }) as HTMLButtonElement).disabled).toBe(true);
    expect(requestPermission).not.toHaveBeenCalled(); expect(subscribe).not.toHaveBeenCalled();
  });
  it('allows deliberate registration while clearly saying delivery is held', async () => {
    const { requestPermission, subscribe, fetchMock } = setup({ apple: true, installed: true });
    const button = screen.getByRole('button', { name: 'Enable lead notifications' });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    expect(requestPermission).not.toHaveBeenCalled();
    fireEvent.click(button);
    // Synchronous tap invokes permission before the next awaited network call.
    expect(requestPermission).toHaveBeenCalledOnce();
    await screen.findByText(/This device is registered/);
    expect(subscribe).toHaveBeenCalledOnce();
    expect(screen.getByText(/Live push is held/)).toBeTruthy();
    expect(fetchMock.mock.calls.some(([url]) => /send|test-push/.test(url))).toBe(false);
  });
  it('does not prompt a denied device repeatedly', async () => {
    const { requestPermission } = setup({ denied: true });
    await screen.findByText(/Notifications are blocked/);
    expect((screen.getByRole('button', { name: 'Enable lead notifications' }) as HTMLButtonElement).disabled).toBe(true);
    expect(requestPermission).not.toHaveBeenCalled();
  });
  it('does not prompt or subscribe while offline', async () => {
    const { requestPermission, subscribe } = setup({ offline: true });
    const button = screen.getByRole('button', { name: 'Enable lead notifications' });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(button);
    await screen.findByText('Go online before enabling notifications.');
    expect(requestPermission).not.toHaveBeenCalled(); expect(subscribe).not.toHaveBeenCalled();
  });
  it('unsubscribes if server enrollment fails rather than claiming device registration', async () => {
    const { subscription } = setup({ subscribeFail: true });
    const button = screen.getByRole('button', { name: 'Enable lead notifications' });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(button);
    await screen.findByText(/Could not update mobile alerts/);
    expect(subscription.unsubscribe).toHaveBeenCalledOnce();
    expect(screen.queryByRole('button', { name: 'Device registered' })).toBeNull();
  });
});
