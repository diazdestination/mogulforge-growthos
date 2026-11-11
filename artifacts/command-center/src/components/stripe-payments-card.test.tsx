import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

import { StripePaymentsCard } from './stripe-payments-card';

vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const status = (patch: Record<string, unknown> = {}) => ({
  configured: true, mode: 'test', configIssue: null, connected: false, chargesEnabled: false, payoutsEnabled: false, detailsSubmitted: false,
  lastSyncedAt: null, onboarding: 'not_started', onboardingDetail: "Connect your company's own Stripe account so customers can pay invoices by card or bank.", requirementsDue: 0, currentDeadline: null, ...patch,
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

it('lets the owner start Stripe setup and sends them to Stripe', async () => {
  const assign = vi.fn();
  vi.stubGlobal('location', { ...window.location, search: '', assign });
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => url === '/api/v1/payments/stripe/connect' && init?.method === 'POST' ? json({ url: 'https://connect.stripe.test/onboard' }) : json(status()));
  vi.stubGlobal('fetch', fetchMock);
  render(<StripePaymentsCard canManage />);
  expect(await screen.findByText('Not started')).toBeTruthy();
  expect(screen.getByText('Test mode')).toBeTruthy();
  expect(screen.getByText(/Pay links stay off until Stripe says the account is ready/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Start Stripe setup' }));
  await waitFor(() => expect(assign).toHaveBeenCalledWith('https://connect.stripe.test/onboard'));
});

it('shows needs info, ready and restricted, with live mode called out', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => json(status({ connected: true, onboarding: 'needs_info', onboardingDetail: 'Finish Stripe setup: 2 details still needed.', requirementsDue: 2, currentDeadline: '2026-12-01T00:00:00.000Z' }))));
  render(<StripePaymentsCard canManage />);
  expect(await screen.findByText('Needs info')).toBeTruthy();
  expect(screen.getByText('Finish Stripe setup: 2 details still needed.')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Continue Stripe setup' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Check status' })).toBeTruthy();
  cleanup();

  vi.stubGlobal('fetch', vi.fn(async () => json(status({ mode: 'live', connected: true, chargesEnabled: true, payoutsEnabled: true, detailsSubmitted: true, onboarding: 'ready', onboardingDetail: 'Ready to take card and bank payments.' }))));
  render(<StripePaymentsCard canManage />);
  expect(await screen.findByText('Ready')).toBeTruthy();
  expect(screen.getByText('Live')).toBeTruthy();
  expect(screen.getByText(/Live mode: real cards are charged/)).toBeTruthy();
  expect(screen.queryByText(/Pay links stay off/)).toBeNull();
  cleanup();

  vi.stubGlobal('fetch', vi.fn(async () => json(status({ connected: true, detailsSubmitted: true, onboarding: 'restricted', onboardingDetail: 'Stripe has paused payments on this account. Open Stripe setup to see what Stripe needs.' }))));
  render(<StripePaymentsCard canManage={false} />);
  expect(await screen.findByText('Restricted')).toBeTruthy();
  expect(screen.getByText(/Stripe has paused payments/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: /Stripe setup/ })).toBeNull();
  expect(screen.getByText('An owner or admin finishes Stripe setup.')).toBeTruthy();
});

it('re-checks Stripe on return and explains an expired setup link', async () => {
  window.history.replaceState(null, '', '/settings?stripe=return');
  const fetchMock = vi.fn(async (url: string) => url === '/api/v1/payments/stripe/refresh' ? json(status({ connected: true, chargesEnabled: true, onboarding: 'ready', onboardingDetail: 'Ready to take card and bank payments.' })) : json(status()));
  vi.stubGlobal('fetch', fetchMock);
  render(<StripePaymentsCard canManage />);
  expect(await screen.findByText('Ready')).toBeTruthy();
  expect(fetchMock.mock.calls.some(([url]) => url === '/api/v1/payments/stripe/refresh')).toBe(true);
  cleanup();

  window.history.replaceState(null, '', '/settings?stripe=refresh');
  vi.stubGlobal('fetch', vi.fn(async () => json(status({ connected: true, onboarding: 'needs_info', onboardingDetail: 'Finish Stripe setup to take payments.' }))));
  render(<StripePaymentsCard canManage />);
  expect(await screen.findByText('Your Stripe setup link expired')).toBeTruthy();
});

it('tells the owner why payments are unavailable on a misconfigured deployment', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => json(status({ configured: false, mode: 'live', configIssue: 'STRIPE_CONNECT_MODE is live but the Stripe key is a test key. Use a live key.' }))));
  render(<StripePaymentsCard canManage />);
  expect(await screen.findByText('Not available on this deployment')).toBeTruthy();
  expect(screen.getByText(/Setup problem: STRIPE_CONNECT_MODE is live but the Stripe key is a test key/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: /Stripe setup/ })).toBeNull();
});
