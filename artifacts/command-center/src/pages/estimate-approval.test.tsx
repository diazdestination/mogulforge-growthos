import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import EstimateApproval, { type PublicEstimateApproval } from './estimate-approval';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const TOKEN = 'a'.repeat(43);
const SIGNATURE = 'data:image/png;base64,iVBORw0KGgo=';
const waiting: PublicEstimateApproval = {
  state: 'waiting',
  companyName: 'Synthetic Roofing',
  consentText: 'I approve this estimate and authorize the work.',
  expiresAt: '2026-12-11T00:00:00.000Z',
  estimate: {
    customerName: 'Pat Doe',
    title: 'Roof replacement',
    lineItems: [{ description: 'Architectural shingles', quantity: 30, unitPriceCents: 40000, totalCents: 1_200_000 }],
    subtotalCents: 1_200_000,
    taxCents: 0,
    totalCents: 1_200_000,
    notes: null,
  },
  decidedAt: null,
  signerName: null,
};

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, clearRect() {} } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue(SIGNATURE);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function sign() {
  fireEvent.change(screen.getByLabelText('Full name'), { target: { value: 'Pat Doe' } });
  fireEvent.pointerDown(document.querySelector('canvas[data-signature-pad]')!, { clientX: 10, clientY: 10, pointerId: 1 });
}

it('shows the company, lines and total, and requires name, signature and consent before approving', async () => {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') return json({ ...waiting, state: 'approved', signerName: 'Pat Doe', decidedAt: '2026-11-11T12:00:00.000Z' });
    return json(waiting);
  });
  vi.stubGlobal('fetch', fetchMock);
  render(<EstimateApproval token={TOKEN} />);
  expect(await screen.findByText('Synthetic Roofing')).toBeTruthy();
  expect(screen.getByText('Architectural shingles')).toBeTruthy();
  expect(screen.getByTestId('approval-total').textContent).toBe('$12,000.00');

  fireEvent.click(screen.getByRole('button', { name: /Approve estimate/ }));
  expect(screen.getByRole('alert').textContent).toMatch(/full name/);
  sign();
  fireEvent.click(screen.getByRole('button', { name: /Approve estimate/ }));
  expect(screen.getByRole('alert').textContent).toMatch(/Tick the box/);
  expect(fetchMock).toHaveBeenCalledTimes(1);

  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(screen.getByRole('button', { name: /Approve estimate/ }));
  expect(await screen.findByText('Approved by Pat Doe')).toBeTruthy();
  const [url, init] = fetchMock.mock.calls[1]!;
  expect(url).toBe(`/api/v1/public/estimate-approvals/${TOKEN}/approve`);
  expect(JSON.parse(String(init!.body))).toEqual({ signerName: 'Pat Doe', signatureDataUrl: SIGNATURE, consent: true });
});

it('clears the signature so approval asks for it again', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => json(waiting)));
  render(<EstimateApproval token={TOKEN} />);
  await screen.findByText('Roof replacement');
  sign();
  fireEvent.click(screen.getByRole('button', { name: 'Clear signature' }));
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(screen.getByRole('button', { name: /Approve estimate/ }));
  expect(screen.getByRole('alert').textContent).toMatch(/Draw your signature/);
});

it('declines with a reason', async () => {
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => (init?.method === 'POST' ? json({ ...waiting, state: 'declined', decidedAt: '2026-11-11T12:00:00.000Z' }) : json(waiting)));
  vi.stubGlobal('fetch', fetchMock);
  render(<EstimateApproval token={TOKEN} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Decline this estimate' }));
  fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Going with another bid' } });
  fireEvent.click(screen.getByRole('button', { name: /Decline estimate/ }));
  expect(await screen.findByText('Estimate declined')).toBeTruthy();
  expect(JSON.parse(String(fetchMock.mock.calls[1]![1]!.body))).toEqual({ reason: 'Going with another bid' });
});

it('refuses an outdated link without showing prices or the signing form', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => json({ ...waiting, state: 'outdated', estimate: null })));
  render(<EstimateApproval token={TOKEN} />);
  expect(await screen.findByText('This estimate was updated')).toBeTruthy();
  expect(screen.queryByRole('button', { name: /Approve estimate/ })).toBeNull();
  expect(screen.queryByText('$12,000.00')).toBeNull();
});

it('shows an unknown link as unavailable', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => json({ error: 'This approval link is not valid.' }, 404)));
  render(<EstimateApproval token={TOKEN} />);
  expect(await screen.findByText('This approval link is not valid.')).toBeTruthy();
});
