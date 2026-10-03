/* Push only: deliberately no fetch handler, offline cache, or customer-data cache. */
'use strict';
const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const leadPattern = new RegExp(`^/leads/(${uuid})$`, 'i');
const idPattern = new RegExp(`^${uuid}$`, 'i');

function safeNoticeUrl(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return null;
  try {
    const url = new URL(value, self.location.origin);
    if (url.origin !== self.location.origin || url.hash) return null;
    const keys = [...url.searchParams.keys()];
    if (!idPattern.test(url.searchParams.get('organizationId') || '')) return null;
    if (leadPattern.test(url.pathname)) {
      if (keys.length !== 1 || keys[0] !== 'organizationId') return null;
    } else if (url.pathname === '/service') {
      if (keys.length !== 2 || new Set(keys).size !== 2 || !keys.includes('serviceObligationId') || !idPattern.test(url.searchParams.get('serviceObligationId') || '')) return null;
    } else return null;
    return url;
  } catch { return null; }
}

self.addEventListener('push', event => {
  let payload;
  try { payload = event.data?.json(); } catch { return; }
  const url = safeNoticeUrl(payload?.url);
  if (!url || payload.organizationId !== url.searchParams.get('organizationId')) return;
  const service = url.pathname === '/service';
  if (service ? payload.serviceObligationId !== url.searchParams.get('serviceObligationId') || payload.leadId != null
    : payload.leadId !== url.pathname.split('/')[2] || payload.serviceObligationId != null) return;
  // Never render provider payload title/body, contact names, or customer notes.
  event.waitUntil(self.registration.showNotification('GrowthOS', {
    body: service ? 'A service follow-up needs your attention. Open GrowthOS to review it.' : 'A new lead is ready for your team. Open GrowthOS to review it.',
    icon: '/brand/growthos-icon-192.png',
    tag: service ? `growthos-service-${payload.organizationId}-${payload.serviceObligationId}` : `growthos-lead-${payload.organizationId}-${payload.leadId}`,
    data: { url: `${url.pathname}${url.search}` },
  }));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = safeNoticeUrl(event.notification.data?.url);
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
