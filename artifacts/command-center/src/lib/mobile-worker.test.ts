import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const root = new NodeURL('../../public/', import.meta.url);
const source = readFileSync(new NodeURL('growthos-sw.js', root), 'utf8');
const leadId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const organizationId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const url = `/leads/${leadId}?organizationId=${organizationId}`;

function worker() {
  const listeners = new Map<string, (event: any) => void>();
  const showNotification = vi.fn().mockResolvedValue(undefined);
  const openWindow = vi.fn().mockResolvedValue(undefined);
  const matchAll = vi.fn().mockResolvedValue([]);
  const self = { location: { origin: 'https://growthos.example.test' }, registration: { showNotification }, clients: { matchAll, openWindow }, addEventListener: (name: string, fn: any) => listeners.set(name, fn) };
  vm.runInNewContext(source, { self, URL: NodeURL });
  return { listeners, showNotification, openWindow, matchAll };
}

describe('push-only service worker', () => {
  it('never registers offline fetch/cache logic', () => {
    const { listeners } = worker();
    expect([...listeners.keys()]).toEqual(['push', 'notificationclick']);
    expect(source).not.toMatch(/caches\.|fetch\(/);
  });
  it('ignores payload PII and displays only the generic lead alert', async () => {
    const { listeners, showNotification } = worker();
    const waitUntil = vi.fn();
    listeners.get('push')!({ data: { json: () => ({ leadId, organizationId, url, title: 'Private customer name', body: 'Private address' }) }, waitUntil });
    await waitUntil.mock.calls[0][0];
    expect(showNotification).toHaveBeenCalledWith('GrowthOS', expect.objectContaining({ body: 'A new lead is ready for your team. Open GrowthOS to review it.', data: { url } }));
    expect(JSON.stringify(showNotification.mock.calls)).not.toContain('Private');
  });
  it.each([`https://evil.test${url}`, `${url}&redirect=/api/logout`, `${url}&organizationId=${organizationId}`, `/api/v1/leads/${leadId}?organizationId=${organizationId}`, `${url}#token`])('drops invalid push URLs %s', bad => {
    const { listeners, showNotification } = worker();
    listeners.get('push')!({ data: { json: () => ({ leadId, organizationId, url: bad }) }, waitUntil: vi.fn() });
    expect(showNotification).not.toHaveBeenCalled();
  });
  it('drops malformed JSON and inconsistent payload contexts', () => {
    const { listeners, showNotification } = worker();
    listeners.get('push')!({ data: { json: () => { throw new Error('bad'); } }, waitUntil: vi.fn() });
    listeners.get('push')!({ data: { json: () => ({ leadId, organizationId: leadId, url }) }, waitUntil: vi.fn() });
    expect(showNotification).not.toHaveBeenCalled();
  });
  it('opens only a verified same-origin lead URL on notification click', async () => {
    const { listeners, openWindow } = worker();
    const waitUntil = vi.fn(); const close = vi.fn();
    listeners.get('notificationclick')!({ notification: { data: { url }, close }, waitUntil });
    await waitUntil.mock.calls[0][0];
    expect(close).toHaveBeenCalledOnce();
    expect(openWindow).toHaveBeenCalledWith(`https://growthos.example.test${url}`);
  });
  it('fully navigates an existing app so prior account query caches cannot survive', async () => {
    const { listeners, openWindow, matchAll } = worker();
    const focus = vi.fn(); const navigate = vi.fn().mockResolvedValue({ focus });
    matchAll.mockResolvedValue([{ url: 'https://growthos.example.test/pipeline', navigate }]);
    const waitUntil = vi.fn();
    listeners.get('notificationclick')!({ notification: { data: { url }, close: vi.fn() }, waitUntil });
    await waitUntil.mock.calls[0][0];
    expect(navigate).toHaveBeenCalledWith(`https://growthos.example.test${url}`);
    expect(focus).toHaveBeenCalledOnce(); expect(openWindow).not.toHaveBeenCalled();
  });
  it('does not open a forged notification-click redirect', () => {
    const { listeners, openWindow } = worker();
    const waitUntil = vi.fn();
    listeners.get('notificationclick')!({ notification: { data: { url: '//evil.test/' }, close: vi.fn() }, waitUntil });
    expect(waitUntil).not.toHaveBeenCalled(); expect(openWindow).not.toHaveBeenCalled();
  });
  it('renders and opens the typed service target without customer content or an invented lead', async () => {
    const { listeners, showNotification, openWindow } = worker();
    const serviceUrl = `/service?serviceObligationId=${leadId}&organizationId=${organizationId}`;
    const waitUntil = vi.fn();
    listeners.get('push')!({ data: { json: () => ({ serviceObligationId: leadId, organizationId, url: serviceUrl, body: 'Private equipment location' }) }, waitUntil });
    await waitUntil.mock.calls[0][0];
    expect(showNotification).toHaveBeenCalledWith('GrowthOS', expect.objectContaining({ body: 'A service follow-up needs your attention. Open GrowthOS to review it.', data: { url: serviceUrl } }));
    expect(JSON.stringify(showNotification.mock.calls)).not.toContain('Private');
    const clickWait = vi.fn();
    listeners.get('notificationclick')!({ notification: { data: { url: serviceUrl }, close: vi.fn() }, waitUntil: clickWait });
    await clickWait.mock.calls[0][0];
    expect(openWindow).toHaveBeenCalledWith(`https://growthos.example.test${serviceUrl}`);
  });
  it.each([
    `/service?serviceObligationId=${leadId}`,
    `/service?serviceObligationId=${leadId}&organizationId=${organizationId}&redirect=/logout`,
    `/service?serviceObligationId=${leadId}&serviceObligationId=${leadId}&organizationId=${organizationId}`,
    `/service?serviceObligationId=not-a-uuid&organizationId=${organizationId}`,
  ])('rejects malformed service paths %s', bad => {
    const { listeners, showNotification } = worker();
    listeners.get('push')!({ data: { json: () => ({ serviceObligationId: leadId, organizationId, url: bad }) }, waitUntil: vi.fn() });
    expect(showNotification).not.toHaveBeenCalled();
  });
  it('rejects mixed or mismatching target types', () => {
    const { listeners, showNotification } = worker();
    for (const extra of [{ leadId }, { serviceObligationId: organizationId }]) {
      listeners.get('push')!({ data: { json: () => ({ serviceObligationId: leadId, organizationId, url: `/service?serviceObligationId=${leadId}&organizationId=${organizationId}`, ...extra }) }, waitUntil: vi.fn() });
    }
    expect(showNotification).not.toHaveBeenCalled();
  });
});

describe('install assets', () => {
  it('uses same-origin standalone manifest and real PNG icons from the existing mark', () => {
    const manifest = JSON.parse(readFileSync(new NodeURL('manifest.webmanifest', root), 'utf8'));
    expect(manifest.display).toBe('standalone'); expect(manifest.scope).toBe('./'); expect(manifest.start_url).toBe('./');
    for (const size of [180, 192, 512]) {
      const png = readFileSync(new NodeURL(`brand/growthos-icon-${size}.png`, root));
      expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      expect(png.readUInt32BE(16)).toBe(size); expect(png.readUInt32BE(20)).toBe(size);
    }
  });
});
