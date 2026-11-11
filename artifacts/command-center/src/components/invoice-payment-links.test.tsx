import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

import { InvoicePaymentLinks } from './invoice-payment-links';
import type { InvoiceDetail } from '@/lib/invoice-ui';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const invoice = { id: '11111111-1111-4111-8111-111111111111', status: 'issued', version: 2, balanceDueCents: 25_000 } as unknown as InvoiceDetail;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('does not offer another link while a bank payment is clearing', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url === '/api/v1/payments/stripe' ? json({ configured: true, connected: true, chargesEnabled: true }) : json({ links: [{ id: 'held', invoiceVersion: 2, amountCents: 25000, state: 'processing', url: null, createdAt: '2026-10-30T00:00:00Z' }] })));
  render(<InvoicePaymentLinks invoice={invoice} canManage />);
  expect(await screen.findByText('Bank payment clearing')).toBeTruthy();
  expect(screen.queryByRole('button', { name: /Create payment link/ })).toBeNull();
});

it('hides a stale-version link and keeps collection reserved for review', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url === '/api/v1/payments/stripe' ? json({ configured: true, connected: true, chargesEnabled: true }) : json({ links: [{ id: 'held', invoiceVersion: 1, amountCents: 25000, state: 'open', url: 'https://checkout.stripe.test/stale', createdAt: '2026-10-30T00:00:00Z' }] })));
  render(<InvoicePaymentLinks invoice={invoice} canManage />);
  expect(await screen.findByText('Waiting for payment')).toBeTruthy();
  expect(screen.queryByRole('textbox', { name: 'Payment link' })).toBeNull();
  expect(screen.queryByRole('button', { name: /Create payment link/ })).toBeNull();
});

it('does not describe an unknown Checkout outcome as paid', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url === '/api/v1/payments/stripe' ? json({ configured: true, connected: true, chargesEnabled: true }) : json({ links: [{ id: 'unknown', invoiceVersion: 2, amountCents: 25000, state: 'needs_reconciliation', url: null, paidAt: null, detail: 'Checkout creation was not confirmed.', createdAt: '2026-10-30T00:00:00Z' }] })));
  render(<InvoicePaymentLinks invoice={invoice} canManage />);
  expect(await screen.findByText('Payment needs review')).toBeTruthy();
  expect(screen.queryByText(/Paid —/)).toBeNull();
  expect(screen.queryByRole('button', { name: /Create payment link/ })).toBeNull();
});

it('creates a payment link for the balance and shows it for copying', async () => {
  let links: unknown[] = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/v1/payments/stripe') return json({ configured: true, connected: true, chargesEnabled: true });
    if (url.endsWith('/payment-links') && init?.method === 'POST') {
      links = [{ id: 'l1', invoiceVersion: 2, amountCents: 25_000, url: 'https://checkout.stripe.test/c/1', state: 'open', detail: '', expiresAt: null, paidAt: null, createdAt: '2026-10-30T00:00:00.000Z' }];
      return json({ link: links[0] }, 201);
    }
    return json({ links });
  });
  vi.stubGlobal('fetch', fetchMock);
  render(<InvoicePaymentLinks invoice={invoice} canManage />);
  fireEvent.click(await screen.findByRole('button', { name: /Create payment link for \$250\.00/ }));
  expect(await screen.findByDisplayValue('https://checkout.stripe.test/c/1')).toBeTruthy();
  expect(screen.getByText('Waiting for payment')).toBeTruthy();
});

it('points to Settings until Stripe can take charges, and hides when payments are not configured', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => (url === '/api/v1/payments/stripe' ? json({ configured: true, connected: true, chargesEnabled: false }) : json({ links: [] }))));
  render(<InvoicePaymentLinks invoice={invoice} canManage />);
  expect(await screen.findByText(/Stripe setup is not finished, so pay links are off/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: /Create payment link/ })).toBeNull();
  cleanup();

  const off = vi.fn(async (url: string) => (url === '/api/v1/payments/stripe' ? json({ configured: false, connected: false, chargesEnabled: false }) : json({ links: [] })));
  vi.stubGlobal('fetch', off);
  const { container } = render(<InvoicePaymentLinks invoice={invoice} canManage />);
  await waitFor(() => expect(off).toHaveBeenCalled());
  expect(container.textContent).toBe('');
});

it('shows live mode and flags a refund or dispute for office review without offering a new link', async () => {
  const paid = { id: 'p1', invoiceVersion: 2, amountCents: 25_000, state: 'paid', url: null, detail: 'Paid through Stripe and recorded on the invoice.', mode: 'live', createdAt: '2026-10-30T00:00:00Z',
    review: [
      { kind: 'refund', stripeId: 'ch_1', amountCents: 5_000, status: 'partial', reason: null },
      { kind: 'dispute', stripeId: 'dp_1', amountCents: 25_000, status: 'needs_response', reason: 'product_not_received' },
    ] };
  const paidInvoice = { ...invoice, balanceDueCents: 0 } as unknown as InvoiceDetail;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url === '/api/v1/payments/stripe' ? json({ configured: true, connected: true, chargesEnabled: true, mode: 'live', onboarding: 'ready' }) : json({ links: [paid] })));
  render(<InvoicePaymentLinks invoice={paidInvoice} canManage />);
  expect(await screen.findByText('Paid and recorded')).toBeTruthy();
  expect(screen.getByText('Live')).toBeTruthy();
  const notes = screen.getAllByRole('note').map(note => note.textContent);
  expect(notes[0]).toMatch(/Stripe refunded \$50\.00\. The invoice balance was not changed/);
  expect(notes[1]).toMatch(/disputed \$250\.00 \(product not received\)\. Respond in Stripe/);
  expect(screen.queryByRole('button', { name: /Create payment link/ })).toBeNull();
});

it('explains a paused Stripe account and a refused create plainly', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url === '/api/v1/payments/stripe'
    ? json({ configured: true, connected: true, chargesEnabled: false, mode: 'live', onboarding: 'restricted' })
    : json({ links: [{ id: 'f1', invoiceVersion: 2, amountCents: 25_000, state: 'failed', url: null, mode: 'live', detail: 'Stripe refused the request before creating a link, so nothing was created. Stripe is busy right now.', createdAt: '2026-10-30T00:00:00Z' }] })));
  render(<InvoicePaymentLinks invoice={invoice} canManage />);
  expect(await screen.findByText(/Stripe has paused payments for this company/)).toBeTruthy();
  expect(screen.getByText(/nothing was created/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: /Check original payment/ })).toBeNull();
});
