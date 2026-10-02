export type PushStatus = {
  supported: boolean;
  enabled: boolean;
  publicKey: string | null;
  organizationId: string;
  userId: string;
  subscriptions: { id: string; expiresAt: string | null; createdAt: string }[];
  policyConfigured: boolean;
  eligible?: boolean;
};

const OWNER_KEY = 'growthos.push.owner.v1';
const base = () => import.meta.env.BASE_URL || '/';
const workerUrl = () => new URL(`${base()}growthos-sw.js`, location.origin).href;

export async function staffPushRequest<T>(path: string, body?: unknown): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(`/api/v1/staff-push/${path}`, {
      credentials: 'include', cache: 'no-store', signal: controller.signal,
      ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    });
    if (!response.ok) throw new Error('Could not update mobile alerts. Sign in again or ask your operator to check this device.');
    return response.status === 204 ? undefined as T : await response.json() as T;
  } finally { clearTimeout(timeout); }
}

export function pushSupported() {
  return window.isSecureContext && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

export function isInstalled() {
  return window.matchMedia?.('(display-mode: standalone)').matches ||
    Boolean((navigator as Navigator & { standalone?: boolean }).standalone);
}

export async function preparePushWorker() {
  if (!pushSupported()) throw new Error('This browser cannot receive web push.');
  await navigator.serviceWorker.register(workerUrl(), { scope: base(), updateViaCache: 'none' });
  return bounded(navigator.serviceWorker.ready, 8000);
}

async function ownRegistration() {
  if (!('serviceWorker' in navigator)) return undefined;
  const registration = await navigator.serviceWorker.getRegistration(base());
  return registration?.active?.scriptURL === workerUrl() ? registration : undefined;
}

function bounded<T>(promise: Promise<T>, ms = 2500): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Device cleanup timed out.')), ms);
    promise.then(resolve, reject).finally(() => clearTimeout(timeout));
  });
}

let cleanupInFlight: Promise<void> | null = null;

export function revokeCurrentDevicePush(): Promise<void> {
  if (!cleanupInFlight) cleanupInFlight = detachDevice().finally(() => { cleanupInFlight = null; });
  return cleanupInFlight;
}

async function detachDevice(): Promise<void> {
  const registration = await bounded(ownRegistration());
  const subscription = await bounded(registration?.pushManager.getSubscription() ?? Promise.resolve(null));
  // Clear displayed alerts even when the server is unavailable. Backend delivery
  // additionally checks that the exact subscribing session still exists.
  const notifications = await bounded(registration?.getNotifications() ?? Promise.resolve([])).catch(() => []);
  for (const notification of notifications) notification.close();
  if (subscription) {
    const outcomes = await Promise.allSettled([
      bounded(subscription.unsubscribe()),
      bounded(staffPushRequest('subscriptions/revoke', { endpoint: subscription.endpoint })),
    ]);
    if (outcomes[0].status === 'rejected' || outcomes[0].value === false) throw new Error('This device did not unsubscribe. Turn off GrowthOS alerts in device settings.');
  }
  try { localStorage.removeItem(OWNER_KEY); } catch { /* Private browsing may deny storage. */ }
}

export async function enforcePushOwner(userId: string, organizationId: string) {
  let saved: string | null = null;
  try { saved = localStorage.getItem(OWNER_KEY); } catch { /* Fail closed for an unowned subscription. */ }
  const owner = JSON.stringify({ userId, organizationId });
  if (saved !== owner) await revokeCurrentDevicePush();
}

export function rememberPushOwner(userId: string, organizationId: string) {
  // Refuse persistent alerts if ownership cannot be remembered safely. The user
  // can still use GrowthOS without mobile alerts in restricted/private browsing.
  localStorage.setItem(OWNER_KEY, JSON.stringify({ userId, organizationId }));
}

/** Renew an existing, same-account opt-in when its server lease is near expiry.
 * Never prompt, create a new browser subscription, or adopt another account. */
export async function renewExistingDevicePush(userId: string, organizationId: string) {
  const owner = JSON.stringify({ userId, organizationId });
  try { if (localStorage.getItem(OWNER_KEY) !== owner) return; } catch { return; }
  if (!pushSupported() || Notification.permission !== 'granted' || !navigator.onLine) return;
  const registration = await bounded(ownRegistration());
  const subscription = await bounded(registration?.pushManager.getSubscription() ?? Promise.resolve(null));
  if (!subscription) return;
  const status = await staffPushRequest<PushStatus>('status');
  if (status.userId !== userId || status.organizationId !== organizationId || status.eligible === false) {
    await revokeCurrentDevicePush();
    return;
  }
  if (!status.supported) return;
  if (status.subscriptions.some(device => device.expiresAt && Date.parse(device.expiresAt) > Date.now() + 24 * 60 * 60_000)) return;
  await staffPushRequest('subscriptions', subscription.toJSON());
}

export function decodeApplicationKey(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]{80,100}$/.test(value)) throw new Error('Mobile alert public key is unavailable.');
  const decoded = atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4));
  const bytes = new Uint8Array(decoded.length);
  for (let i = 0; i < decoded.length; i++) bytes[i] = decoded.charCodeAt(i);
  if (bytes.length !== 65 || bytes[0] !== 4) throw new Error('Mobile alert public key is invalid.');
  return bytes;
}
