import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Bell, Smartphone } from 'lucide-react';
import { isAppleMobile } from '@/lib/mobile-lead';
import { decodeApplicationKey, enforcePushOwner, isInstalled, preparePushWorker, pushSupported, rememberPushOwner, revokeCurrentDevicePush, staffPushRequest, type PushStatus } from '@/lib/staff-push';

export function MobileNotificationsCard() {
  const [installed, setInstalled] = useState(isInstalled);
  const [permission, setPermission] = useState<NotificationPermission | 'unsupported'>(() => 'Notification' in window ? Notification.permission : 'unsupported');
  const [subscribed, setSubscribed] = useState(false);
  const [workerReady, setWorkerReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const supported = pushSupported();
  const appleNeedsInstall = isAppleMobile() && !installed;
  const status = useQuery({ queryKey: ['staff-push', 'status'], queryFn: () => staffPushRequest<PushStatus>('status'), retry: false });

  useEffect(() => {
    let cancelled = false;
    if (!supported || appleNeedsInstall || !status.data) return;
    const identity = status.data;
    void (async () => {
      try {
        await enforcePushOwner(identity.userId, identity.organizationId);
        const registration = await preparePushWorker();
        const subscription = await registration.pushManager.getSubscription();
        // Renew only a previously opted-in device for the same account. No
        // permission prompt or new subscription is created on app load.
        if (subscription && identity.supported && identity.eligible !== false && Notification.permission === 'granted') {
          await staffPushRequest('subscriptions', subscription.toJSON());
        }
        if (!cancelled) { setWorkerReady(true); setSubscribed(Boolean(subscription)); }
      } catch {
        if (!cancelled) setNotice('Mobile alerts are not ready on this device. Reload online or check browser permissions.');
      }
    })();
    return () => { cancelled = true; };
  }, [supported, appleNeedsInstall, status.data?.userId, status.data?.organizationId]);

  useEffect(() => {
    const refresh = () => { setInstalled(isInstalled()); setPermission('Notification' in window ? Notification.permission : 'unsupported'); };
    window.addEventListener('focus', refresh);
    window.addEventListener('appinstalled', refresh);
    return () => { window.removeEventListener('focus', refresh); window.removeEventListener('appinstalled', refresh); };
  }, []);

  async function enable() {
    if (!supported || !workerReady || appleNeedsInstall || !status.data?.supported || status.data.eligible === false || !status.data.publicKey || busy) return;
    if (!navigator.onLine) { setNotice('Go online before enabling notifications.'); return; }
    // This call must be directly in the tap handler, before any await (iOS).
    const permissionRequest = Notification.requestPermission();
    setBusy(true); setNotice('');
    try {
      const result = await permissionRequest;
      setPermission(result);
      if (result !== 'granted') { setNotice('Notifications were not enabled. You can change permission in your phone settings.'); return; }
      const fresh = await staffPushRequest<PushStatus>('status');
      if (!fresh.supported || fresh.eligible === false || !fresh.publicKey || fresh.userId !== status.data.userId || fresh.organizationId !== status.data.organizationId) throw new Error('Account or notification setup changed. Reload and try again.');
      const registration = await preparePushWorker();
      const subscription = await registration.pushManager.getSubscription() ?? await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: decodeApplicationKey(fresh.publicKey) });
      try {
        rememberPushOwner(fresh.userId, fresh.organizationId);
        await staffPushRequest('subscriptions', subscription.toJSON());
      } catch (error) {
        await revokeCurrentDevicePush();
        throw error;
      }
      setSubscribed(true);
      setNotice('This device is registered. A real test notification still needs to be confirmed on your phone.');
      await status.refetch();
    } catch (error) { setNotice(error instanceof Error ? error.message : 'Could not enable mobile alerts.'); }
    finally { setBusy(false); }
  }

  async function disable() {
    setBusy(true); setNotice('');
    try { await revokeCurrentDevicePush(); setSubscribed(false); setNotice('Notifications disabled for this device.'); await status.refetch(); }
    catch (error) { setNotice(error instanceof Error ? error.message : 'Could not disable this device. Turn off GrowthOS notifications in phone settings.'); }
    finally { setBusy(false); }
  }

  return <section className="rounded-xl border border-border bg-card p-5 space-y-4" aria-labelledby="mobile-notifications-title">
    <h2 id="mobile-notifications-title" className="text-lg font-bold flex items-center gap-2"><Smartphone className="w-5 h-5" /> GrowthOS on your phone</h2>
    <p className="text-sm text-muted-foreground">Save GrowthOS to your Home Screen. Lead alerts open the lead card; enabled service alerts open the assigned service follow-up after sign-in. Customer details stay off the lock screen.</p>
    {!installed && <div className="rounded-lg bg-muted/40 p-3 text-sm space-y-2">
      <p><strong>iPhone / iPad:</strong> open this site in Safari, tap Share, choose Add to Home Screen, then open the new GrowthOS tile. Web push requires iOS / iPadOS 16.4 or later.</p>
      <p><strong>Android:</strong> use your browser menu → Install app or Add to Home screen. Desktop browsers may offer an install icon in the address bar.</p>
    </div>}
    {installed && <p className="text-sm">Opened as a Home Screen app.</p>}
    {!supported && !appleNeedsInstall && <p className="text-sm">Push notifications are unavailable in this browser or connection. Use a supported browser over HTTPS. Lead cards still work online.</p>}
    {appleNeedsInstall && <p className="text-sm">Install and open the Home Screen app before enabling iPhone notifications.</p>}
    {permission === 'denied' && <p className="text-sm">Notifications are blocked. Change GrowthOS permission in your phone or browser notification settings, then reopen the app.</p>}
    {status.isError && <p className="text-sm" role="alert">Could not check notification setup. Sign in again or retry online.</p>}
    {status.data?.eligible === false && <p className="text-sm">Your current role or session is not eligible for lead-response notifications.</p>}
    {status.data && !status.data.enabled && <p className="text-sm">Live push is held or not configured by your operator. Installation is available, but delivery is not active.</p>}
    {status.data && !status.data.policyConfigured && <p className="text-sm">Company lead-alert hours and responders still need to be configured. Registering a device alone does not turn routing on.</p>}
    {status.data?.serviceAlertsConfigured && <p className="text-sm">Service-owner alerts are also enabled by your company. Only follow-ups assigned to you can notify this device.</p>}
    <div className="flex flex-wrap gap-2">
      <button type="button" onClick={enable} disabled={busy || subscribed || !workerReady || !supported || appleNeedsInstall || permission === 'denied' || !status.data?.supported || status.data?.eligible === false || !status.data?.publicKey} className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-50"><Bell className="w-4 h-4" />{busy ? 'Working…' : subscribed ? 'Device registered' : 'Enable lead notifications'}</button>
      {subscribed && <button type="button" onClick={disable} disabled={busy} className="rounded-md border px-3 py-2 text-sm">Disable on this device</button>}
    </div>
    {notice && <p className="text-sm" role="status">{notice}</p>}
    <p className="text-xs text-muted-foreground">Allow notifications only on your own phone. Sign-out removes this device subscription. Phone Focus modes, connectivity and expired sessions may delay or stop alerts; this is not a guaranteed emergency dispatch channel. No customer records are saved for offline access.</p>
  </section>;
}
