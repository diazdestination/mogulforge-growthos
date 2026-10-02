import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import Billing from './billing';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const baseline = { enabled: false, enforced: false, canCheckout: false, status: null, planTier: null, trialEndsAt: null, hasAccess: true };
function response(data: unknown) { vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => data })); }
it('shows agreed manual scope independently of online billing and does not invent a free beta', async () => {
  response({ ...baseline, entitlements: { mode: 'managed', planId: 'beta', capabilities: { 'revenue.autopilot': { allowed: false, detail: 'Contact your operator to review the included workflow.' } } } });
  render(<Billing />);
  expect(await screen.findByText('Not currently enabled for your scope')).toBeTruthy();
  expect(screen.getByText(/Your agreed price and included/)).toBeTruthy();
  expect(screen.queryByText(/free beta|no payment required/i)).toBeNull();
  expect(screen.queryByRole('button', { name: /start subscription/i })).toBeNull();
});
it('shows the actual assigned plan and available capability without presenting unimplemented upsells', async () => {
  response({ ...baseline, enabled: true, status: 'active', entitlements: { mode: 'managed', planId: 'growth', capabilities: { 'revenue.autopilot': { allowed: true, detail: 'Included in your assigned plan.' } } } });
  render(<Billing />);
  expect(await screen.findByText('Growth')).toBeTruthy();
  expect(screen.getByText('Available within your configured policy')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Manage billing' })).toBeTruthy();
  expect(screen.queryByText('Pro')).toBeNull();
});
it('keeps failure state explicit instead of claiming billing is unconfigured', async () => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Synthetic unavailable API')));
  render(<Billing />);
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Could not load billing status.');
  expect(screen.queryByText("Billing isn't set up yet")).toBeNull();
  expect(screen.queryByText(/scope awaiting review/i)).toBeNull();
});
it('directs an existing canceled subscription to management instead of a new checkout', async () => {
  response({ ...baseline, enabled: true, status: 'canceled', hasSubscription: true, canCheckout: false });
  render(<Billing />);
  expect(await screen.findByRole('button', { name: 'Manage billing' })).toBeTruthy();
  expect(screen.getByText(/Use the billing portal or contact your GrowthOS operator/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: /start subscription/i })).toBeNull();
});
