const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const LEAD_PATH = new RegExp(`^/leads/(${UUID})$`, 'i');
const ID = new RegExp(`^${UUID}$`, 'i');

/** Only canonical same-origin lead alerts may survive sign-in. Never a general returnTo. */
export function notificationLeadPath(input: string, origin: string): string | null {
  if (!input.startsWith('/') || input.startsWith('//') || input.includes('\\')) return null;
  try {
    const url = new URL(input, origin);
    if (url.origin !== origin || !LEAD_PATH.test(url.pathname) || url.hash) return null;
    const keys = [...url.searchParams.keys()];
    const organizationId = url.searchParams.get('organizationId');
    if (keys.length !== 1 || keys[0] !== 'organizationId' || !organizationId || !ID.test(organizationId)) return null;
    return `${url.pathname}?organizationId=${organizationId}`;
  } catch { return null; }
}

/** A second fixed route family, not an arbitrary redirect or tenant switch. */
export function notificationServicePath(input: string, origin: string): string | null {
  if (!input.startsWith('/') || input.startsWith('//') || input.includes('\\')) return null;
  try {
    const url = new URL(input, origin);
    if (url.origin !== origin || url.pathname !== '/service' || url.hash) return null;
    const keys = [...url.searchParams.keys()];
    const organizationId = url.searchParams.get('organizationId');
    const serviceId = url.searchParams.get('serviceObligationId');
    if (keys.length !== 2 || new Set(keys).size !== 2 || !organizationId || !serviceId || !ID.test(organizationId) || !ID.test(serviceId)) return null;
    return `/service?serviceObligationId=${serviceId}&organizationId=${organizationId}`;
  } catch { return null; }
}

export function notificationContext(input: string, origin: string, organizationId?: string | null) {
  const url = new URL(input, origin);
  if (!url.searchParams.has('organizationId')) return 'ordinary' as const;
  const safe = notificationLeadPath(input, origin);
  if (!safe) return 'invalid' as const;
  return url.searchParams.get('organizationId') === organizationId ? 'allowed' as const : 'different-company' as const;
}

/** One destination only. No comma/semicolon recipients, extensions, query or scheme injection. */
export function singleSmsPhone(value?: string | null): string | null {
  if (!value || !/^\+?[\d ()\-.]+$/.test(value)) return null;
  const compact = value.replace(/[ ()\-.]/g, '');
  if (/^\+[1-9]\d{7,14}$/.test(compact)) return compact;
  if (/^\d{10}$/.test(compact)) return `+1${compact}`;
  if (/^1\d{10}$/.test(compact)) return `+${compact}`;
  return null;
}

export function manualSmsHref(phone: string, body: string, appleDevice: boolean): string | null {
  const destination = singleSmsPhone(phone);
  if (!destination || !body.trim() || body.length > 1600 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(body)) return null;
  // Body hand-off is best effort; Apple's documented sms: contract guarantees
  // the recipient, not message text. The UI always includes copy/paste fallback.
  return `sms:${destination}${appleDevice ? '&' : '?'}body=${encodeURIComponent(body.trim())}`;
}

export function isAppleMobile(): boolean {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
}
