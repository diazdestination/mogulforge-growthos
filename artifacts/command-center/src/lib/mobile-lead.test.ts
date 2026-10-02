import { describe, expect, it } from 'vitest';
import { manualSmsHref, notificationContext, notificationLeadPath, notificationServicePath, singleSmsPhone } from './mobile-lead';

const lead = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const org = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const path = `/leads/${lead}?organizationId=${org}`;
const origin = 'https://growthos.example.test';

describe('mobile lead URL boundary', () => {
  it('preserves only an exact internal lead path and org through a sign-in reload', () => {
    expect(notificationLeadPath(path, origin)).toBe(path);
    expect(notificationContext(path, origin, org)).toBe('allowed');
    expect(notificationContext(path, origin, lead)).toBe('different-company');
    expect(notificationContext(`/leads/${lead}`, origin, org)).toBe('ordinary');
  });
  it.each([
    `https://evil.test${path}`, `//evil.test${path}`, `/\\evil.test${path}`, `/api/v1/leads/${lead}?organizationId=${org}`,
    `${path}&redirect=https://evil.test`, `${path}&organizationId=${org}`, `${path}#anything`,
    `/leads/not-a-uuid?organizationId=${org}`, `/leads/${lead}?organizationId=anything`,
    `/leads/${lead}?organizationId=%252F`, `/leads/${lead}/?organizationId=${org}`,
  ])('rejects an ambiguous or off-site notification link: %s', value => {
    expect(notificationLeadPath(value, origin)).toBeNull();
  });
});

describe('service notification sign-in boundary', () => {
  const servicePath = `/service?serviceObligationId=${lead}&organizationId=${org}`;
  it('preserves only the typed service route without interpreting it as a lead', () => {
    expect(notificationServicePath(servicePath, origin)).toBe(servicePath);
    expect(notificationLeadPath(servicePath, origin)).toBeNull();
    expect(notificationServicePath(path, origin)).toBeNull();
  });
  it.each([`${servicePath}&next=/logout`, `${servicePath}&organizationId=${org}`, `${servicePath}#secret`, `//evil.test${servicePath}`, `/service?organizationId=${org}`, `/service?serviceObligationId=bad&organizationId=${org}`])('rejects ambiguous service links %s', candidate => {
    expect(notificationServicePath(candidate, origin)).toBeNull();
  });
});

describe('native phone draft links', () => {
  it('normalizes only one destination and encodes message punctuation/unicode', () => {
    expect(singleSmsPhone('(404) 555-0100')).toBe('+14045550100');
    expect(singleSmsPhone('+44 20 1234 5678')).toBe('+442012345678');
    expect(manualSmsHref('+14045550100', 'Hi & welcome? # roof 🏠', true)).toBe('sms:+14045550100&body=Hi%20%26%20welcome%3F%20%23%20roof%20%F0%9F%8F%A0');
    expect(manualSmsHref('+14045550100', 'Hello', false)).toBe('sms:+14045550100?body=Hello');
  });
  it.each(['4045550100,6785550100', '+14045550100;6785550100', '+14045550100?body=injected', 'sms:+14045550100', '4045550100 ext 22', '+1%0A4045550100', '++14045550100', 'abc', '123'])('rejects unsafe destination %s', value => {
    expect(singleSmsPhone(value)).toBeNull();
    expect(manualSmsHref(value, 'Hi', false)).toBeNull();
  });
  it('rejects empty, oversized and control-character body text', () => {
    expect(manualSmsHref('+14045550100', '', false)).toBeNull();
    expect(manualSmsHref('+14045550100', 'x'.repeat(1601), false)).toBeNull();
    expect(manualSmsHref('+14045550100', 'hello\u0000', false)).toBeNull();
  });
});
