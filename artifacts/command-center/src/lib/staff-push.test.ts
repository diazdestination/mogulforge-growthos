import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodeApplicationKey, enforcePushOwner, rememberPushOwner, renewExistingDevicePush, revokeCurrentDevicePush } from './staff-push';

function browser(subscription: { endpoint: string; unsubscribe: ReturnType<typeof vi.fn> } | null = { endpoint: 'https://push.example.test/private-token', unsubscribe: vi.fn().mockResolvedValue(true) }) {
  const close = vi.fn();
  const registration = { active: { scriptURL: `${location.origin}/growthos-sw.js` }, pushManager: { getSubscription: vi.fn().mockResolvedValue(subscription) }, getNotifications: vi.fn().mockResolvedValue([{ close }]) };
  vi.stubGlobal('navigator', { serviceWorker: { getRegistration: vi.fn().mockResolvedValue(registration) } });
  const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  return { close, registration, subscription, fetchMock };
}
afterEach(() => { localStorage.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('session-bound phone push cleanup', () => {
  it('unsubscribes locally, revokes only the current endpoint, and clears displayed notifications', async () => {
    const { close, subscription, fetchMock } = browser();
    rememberPushOwner('user-a', 'org-a');
    await revokeCurrentDevicePush();
    expect(subscription?.unsubscribe).toHaveBeenCalledOnce(); expect(close).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/staff-push/subscriptions/revoke', expect.objectContaining({ method: 'POST', credentials: 'include', body: JSON.stringify({ endpoint: subscription?.endpoint }) }));
    expect(localStorage.getItem('growthos.push.owner.v1')).toBeNull();
  });
  it('removes a previous company subscription instead of adopting it silently', async () => {
    const { subscription } = browser(); rememberPushOwner('user-a', 'org-a');
    await enforcePushOwner('user-b', 'org-b');
    expect(subscription?.unsubscribe).toHaveBeenCalledOnce();
    expect(localStorage.getItem('growthos.push.owner.v1')).toBeNull();
  });
  it('keeps the same opted-in owner subscription without asking permission again', async () => {
    const { subscription } = browser(); rememberPushOwner('user-a', 'org-a');
    await enforcePushOwner('user-a', 'org-a');
    expect(subscription?.unsubscribe).not.toHaveBeenCalled();
  });
  it('still detaches locally if the server request fails', async () => {
    const { subscription, fetchMock } = browser(); fetchMock.mockRejectedValue(new Error('Offline'));
    await revokeCurrentDevicePush();
    expect(subscription?.unsubscribe).toHaveBeenCalledOnce();
  });
  it('does not erase ownership or claim cleanup if the browser refuses to detach', async () => {
    browser({ endpoint: 'https://push.example.test/token', unsubscribe: vi.fn().mockResolvedValue(false) });
    rememberPushOwner('user-a', 'org-a');
    await expect(revokeCurrentDevicePush()).rejects.toThrow('did not unsubscribe');
    expect(localStorage.getItem('growthos.push.owner.v1')).not.toBeNull();
  });
  it('does not touch another service worker owned by a different app', async () => {
    const { registration, close, subscription } = browser(); registration.active.scriptURL = `${location.origin}/another-app.js`;
    await revokeCurrentDevicePush();
    expect(close).not.toHaveBeenCalled(); expect(subscription?.unsubscribe).not.toHaveBeenCalled();
  });
  it('shares concurrent cleanup work rather than racing unsubscribe twice', async () => {
    const { subscription } = browser();
    await Promise.all([revokeCurrentDevicePush(), revokeCurrentDevicePush()]);
    expect(subscription?.unsubscribe).toHaveBeenCalledOnce();
  });
  it('still revokes a subscription if listing displayed notifications fails', async () => {
    const { registration, subscription } = browser();
    registration.getNotifications.mockRejectedValue(new Error('unavailable'));
    await revokeCurrentDevicePush();
    expect(subscription?.unsubscribe).toHaveBeenCalledOnce();
  });
});

describe('renewing already-approved phone alerts', () => {
  function optedIn(subscriptions: { expiresAt: string }[] = []) {
    const { registration, fetchMock } = browser();
    const subscription = { endpoint: 'https://push.example.test/private-token', unsubscribe: vi.fn().mockResolvedValue(true), toJSON: () => ({ endpoint: 'https://push.example.test/private-token' }) };
    registration.pushManager.getSubscription.mockResolvedValue(subscription);
    vi.stubGlobal('Notification', { permission: 'granted', requestPermission: vi.fn() });
    vi.stubGlobal('PushManager', function () {}); vi.stubGlobal('isSecureContext', true);
    Object.assign(navigator, { onLine: true });
    rememberPushOwner('user-a', 'org-a');
    fetchMock.mockImplementation(async (url: string) => new Response(JSON.stringify(url.endsWith('/status') ? { supported: true, eligible: true, userId: 'user-a', organizationId: 'org-a', subscriptions } : {}), { status: 200 }));
    return { fetchMock, subscription };
  }
  it('refreshes an expired server lease using the existing same-owner subscription, with no permission prompt', async () => {
    const { fetchMock } = optedIn();
    await renewExistingDevicePush('user-a', 'org-a');
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/staff-push/subscriptions', expect.objectContaining({ method: 'POST' }));
    expect(Notification.requestPermission).not.toHaveBeenCalled();
  });
  it('leaves a fresh server lease alone', async () => {
    const { fetchMock } = optedIn([{ expiresAt: new Date(Date.now() + 6 * 24 * 60 * 60_000).toISOString() }]);
    await renewExistingDevicePush('user-a', 'org-a');
    expect(fetchMock.mock.calls.every(([, options]) => options?.method !== 'POST')).toBe(true);
  });
  it('does not silently enroll a different user', async () => {
    const { fetchMock } = optedIn();
    await renewExistingDevicePush('user-b', 'org-b');
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('detaches if fresh server identity disagrees with the remembered account', async () => {
    const { fetchMock, subscription } = optedIn();
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ supported: true, userId: 'another-user', organizationId: 'org-a', subscriptions: [] }), { status: 200 }));
    await renewExistingDevicePush('user-a', 'org-a');
    expect(subscription.unsubscribe).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls.every(([url]) => !String(url).endsWith('/subscriptions'))).toBe(true);
  });
});

describe('VAPID public key decoding', () => {
  it('requires an uncompressed 65-byte public key, never secret material', () => {
    const bytes = new Uint8Array(65); bytes[0] = 4;
    const key = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(decodeApplicationKey(key)).toEqual(bytes);
    expect(() => decodeApplicationKey('not-a-public-key')).toThrow();
    bytes[0] = 3;
    expect(() => decodeApplicationKey(btoa(String.fromCharCode(...bytes)).replace(/=+$/, ''))).toThrow();
  });
});
