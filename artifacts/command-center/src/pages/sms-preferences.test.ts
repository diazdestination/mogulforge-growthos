import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';

const html = readFileSync(resolve(process.cwd(), 'public/sms-preferences.html'), 'utf8');
const script = readFileSync(resolve(process.cwd(), 'public/sms-preferences.js'), 'utf8');
const programA = 'synthetic_twilio_program_a_12345';
const programB = 'synthetic_twilio_program_b_12345';

function page(token: string | null, response?: Record<string, unknown>) {
  const url = `https://growth.example/sms-preferences.html${token === null ? '' : `?program=${encodeURIComponent(token)}`}`;
  const dom = new JSDOM(html, { url, runScripts: 'outside-only' });
  const fetchMock = vi.fn(async (input: string, _init?: RequestInit) => Response.json(
    input.includes('/public/sms/program') ? response ?? {} : { verificationText: 'JOIN TEST', sender: '+12025550109' },
  ));
  Object.defineProperty(dom.window, 'fetch', { value: fetchMock, configurable: true });
  dom.window.eval(script);
  return { dom, fetchMock };
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('contractor SMS preference page', () => {
  it.each([null, 'bad token'])('keeps enrollment hidden with missing or malformed selector %s', async (selector) => {
    const { dom, fetchMock } = page(selector);
    await tick();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(dom.window.document.querySelector<HTMLFormElement>('#preferences')?.hidden).toBe(true);
    expect(dom.window.document.querySelector('#availability')?.textContent).toContain('incomplete or invalid');
    dom.window.close();
  });

  it.each([
    [programA, 'Synthetic & Roofing', '+12025550109', 'roofing.example.test'],
    [programB, 'Synthetic HVAC', '+12025550119', 'hvac.example.test'],
  ])('renders only selected program %s and carries it into enrollment', async (selector, brand, sender, domain) => {
    const { dom, fetchMock } = page(selector, {
      brand, sender, available: true, enabled: true, disclosureVersion: `${selector}-v1`,
      privacyUrl: `https://${domain}/privacy`, termsUrl: `https://${domain}/terms`,
    });
    await tick();
    const document = dom.window.document;
    const form = document.querySelector<HTMLFormElement>('#preferences')!;
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`/api/v1/public/sms/program?program=${selector}`);
    expect(form.hidden).toBe(false);
    expect(document.querySelector('#business-name')?.textContent).toBe(brand);
    expect(document.querySelector<HTMLAnchorElement>('#privacy-link')?.href).toBe(`https://${domain}/privacy`);
    expect(document.querySelector<HTMLAnchorElement>('#terms-link')?.href).toBe(`https://${domain}/terms`);
    form.querySelector<HTMLInputElement>('[name="phone"]')!.value = '+12025550101';
    form.querySelector<HTMLInputElement>('[name="customerCare"]')!.checked = true;
    form.querySelector<HTMLInputElement>('[name="ownPhone"]')!.checked = true;
    form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    await tick();
    expect(fetchMock.mock.calls[1]?.[0]).toBe(`/api/v1/public/sms/enroll?program=${selector}`);
    const submission = JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit)?.body));
    expect(submission).toMatchObject({ phone: '+12025550101', customerCare: true, ownPhone: true, disclosureVersion: `${selector}-v1` });
    dom.window.close();
  });

  it('keeps unknown tokens and programs without approved policies closed, but still shows STOP/HELP', async () => {
    const unknown = page('unknown_program_selector_12345', { brand: null, available: false });
    await tick();
    expect(unknown.dom.window.document.querySelector<HTMLFormElement>('#preferences')?.hidden).toBe(true);
    expect(unknown.dom.window.document.querySelector('#availability')?.textContent).toContain('incomplete or invalid');
    unknown.dom.window.close();

    const missing = page(programA, {
      brand: 'Synthetic & Roofing', sender: '+12025550109', enabled: true, available: false,
      disclosureVersion: null, privacyUrl: null, termsUrl: null,
    });
    await tick();
    const document = missing.dom.window.document;
    expect(document.querySelector<HTMLFormElement>('#preferences')?.hidden).toBe(true);
    expect(document.querySelector<HTMLElement>('#existing-sender')?.hidden).toBe(false);
    expect(document.querySelector('#existing-sender')?.textContent).toContain('STOP');
    expect(document.querySelector('#existing-sender')?.textContent).toContain('HELP');
    expect(document.querySelector('#sender-number')?.textContent).toBe('+12025550109');
    expect(missing.fetchMock).toHaveBeenCalledTimes(1);
    missing.dom.window.close();
  });

  it('rejects non-HTTPS policy links even if an API response mistakenly says available', async () => {
    const { dom } = page(programA, {
      brand: 'Synthetic & Roofing', sender: '+12025550109', enabled: true, available: true,
      disclosureVersion: 'test-v1', privacyUrl: 'http://roofing.example.test/privacy',
      termsUrl: 'https://roofing.example.test/terms',
    });
    await tick();
    expect(dom.window.document.querySelector<HTMLFormElement>('#preferences')?.hidden).toBe(true);
    dom.window.close();
  });
});
