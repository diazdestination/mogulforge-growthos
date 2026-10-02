import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
it('offers only the server-authorized replacement and preserves portal access', async () => {
  response({ ...baseline, enabled: true, status: 'canceled', hasSubscription: true, canManageBilling: true, canCheckout: true, checkout: { state: 'pending', intent: 'replacement', canContinue: true, detail: 'Your operator authorized a replacement for the canceled subscription.' } });
  render(<Billing />);
  expect(await screen.findByRole('button', { name: 'Continue replacement checkout' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Manage billing' })).toBeTruthy();
  expect(screen.queryByText(/14-day trial|free trial/i)).toBeNull();
});
it('keeps uncertain billing on review with an operator recovery path and no checkout button', async () => {
  response({ ...baseline, enabled: true, checkout: { state: 'reconcile', intent: 'initial', canContinue: false, detail: 'Contact your GrowthOS operator and ask them to reconcile the pending checkout.' } });
  render(<Billing />);
  expect(await screen.findByText('Billing review needed')).toBeTruthy();
  expect(screen.getByText(/ask them to reconcile/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: /continue.*checkout|review subscription/i })).toBeNull();
  expect(screen.getByRole('button', { name: 'Refresh billing status' })).toBeTruthy();
});
it('recovers an initial load failure through refresh without claiming a subscription exists', async () => {
  const fetcher = vi.fn().mockRejectedValueOnce(new Error('synthetic network error')).mockResolvedValueOnce({ ok: true, json: async () => ({ ...baseline, enabled: true, canCheckout: true }) });
  vi.stubGlobal('fetch', fetcher);
  render(<Billing />);
  await screen.findByRole('alert');
  fireEvent.click(screen.getByRole('button', { name: 'Refresh billing status' }));
  expect(await screen.findByRole('button', { name: 'Review subscription in Stripe' })).toBeTruthy();
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Manage billing' })).toBeNull();
});
it('refreshes the durable state after a checkout failure and suppresses double clicks', async () => {
  let finish!: (value: unknown) => void;
  const fetcher = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ ...baseline, enabled: true, canCheckout: true }) })
    .mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }))
    .mockResolvedValueOnce({ ok: true, json: async () => ({ ...baseline, enabled: true, checkout: { state: 'reconcile', intent: 'initial', canContinue: false, detail: 'Contact your GrowthOS operator to reconcile this checkout.' } }) });
  vi.stubGlobal('fetch', fetcher);
  render(<Billing />);
  const button = await screen.findByRole('button', { name: 'Review subscription in Stripe' });
  fireEvent.click(button);
  expect(button).toHaveProperty('disabled', true);
  fireEvent.click(button);
  expect(fetcher).toHaveBeenCalledTimes(2);
  finish({ ok: false, json: async () => ({ code: 'checkout_review_required', error: 'Ask your operator to review the pending checkout.' }) });
  expect(await screen.findByText('Billing review needed')).toBeTruthy();
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Ask your operator to review the pending checkout.');
  await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh billing status' })).toHaveProperty('disabled', false));
});
