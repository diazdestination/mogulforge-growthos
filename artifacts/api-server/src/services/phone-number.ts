/**
 * The ONE recipient phone validator shared by Smart Site intake and manual SMS.
 *
 * Validate one telephone recipient before building a native URI. The send
 * gate's digit-only normalization is for suppression matching, not URI safety.
 * Do not turn an injected URI, multiple numbers or an extension into a phone.
 * Unprefixed numbers are NANP (US/Canada: area code and exchange start 2-9);
 * international numbers require an explicit +. Returns E.164 or null.
 */
export function normalizeSmsPhone(value: string | null | undefined): string | null {
  if (!value || value.length > 64 || !/^[+0-9 ().-]+$/.test(value)) return null;
  const compact = value.trim().replace(/[ ().-]/g, "");
  if (compact.startsWith("+")) {
    if (!/^\+[1-9]\d{9,14}$/.test(compact)) return null;
    if (compact.startsWith("+1") && !/^\+1[2-9]\d{2}[2-9]\d{6}$/.test(compact)) return null;
    return compact;
  }
  const national = compact.length === 11 && compact.startsWith("1") ? compact.slice(1) : compact;
  return /^[2-9]\d{2}[2-9]\d{6}$/.test(national) ? `+1${national}` : null;
}
