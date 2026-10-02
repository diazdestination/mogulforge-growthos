/* Push only: deliberately no fetch handler, offline cache, or customer-data cache. */
'use strict';
const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const leadPattern = new RegExp(`^/leads/(${uuid})$`, 'i');
const idPattern = new RegExp(`^${uuid}$`, 'i');

function safeLeadUrl(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return null;
  try {
    const url = new URL(value, self.location.origin);
    if (url.origin !== self.location.origin || !leadPattern.test(url.pathname) || url.hash) return null;
    const keys = [...url.searchParams.keys()];
    if (keys.length !== 1 || keys[0] !== 'organizationId' || !idPattern.test(url.searchParams.get('organizationId') || '')) return null;
    return url;
  } catch { return null; }
}

self.addEventListener('push', event => {
  let payload;
  try { payload = event.data?.json(); } catch { return; }
  const url = safeLeadUrl(payload?.url);
  if (!url || payload.organizationId !== url.searchParams.get('organizationId') || payload.leadId !== url.pathname.split('/')[2]) return;
  // Never render provider payload title/body, contact names, or customer notes.
  event.waitUntil(self.registration.showNotification('GrowthOS', {
    body: 'A new lead is ready for your team. Open GrowthOS to review it.',
    icon: '/brand/growthos-icon-192.png',
    tag: `growthos-lead-${payload.organizationId}-${payload.leadId}`,
    data: { url: `${url.pathname}${url.search}` },
  }));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = safeLeadUrl(event.notification.data?.url);
  if (!url) return;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: false });
    const existing = windows.find(client => new URL(client.url).origin === self.location.origin);
    // A full navigation discards previous in-memory account data. App and API
    // then reauthenticate and enforce the organization before loading the lead.
    if (existing) {
      const navigated = await existing.navigate(url.href);
      if (navigated) { await navigated.focus(); return; }
    }
    await self.clients.openWindow(url.href);
  })());
});
