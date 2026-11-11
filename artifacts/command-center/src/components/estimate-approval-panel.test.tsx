import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

import { EstimateApprovalPanel, type StaffApproval } from './estimate-approval-panel';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const ID = '11111111-1111-4111-8111-111111111111';
const approval = (patch: Partial<StaffApproval>): StaffApproval => ({
  id: 'a1', state: 'waiting', createdAt: '2026-11-11T00:00:00Z', expiresAt: '2026-12-11T00:00:00Z', revokedAt: null, decidedAt: null,
  signerName: null, signatureDataUrl: null, declineReason: null, totalCents: 100_00, ...patch,
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('creates a link for copying without contacting the customer', async () => {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/approval-link') && init?.method === 'POST') return json({ approval: approval({}), url: 'https://app.test/approve/tok', reused: false });
    return json({ estimateId: ID, eligible: true, approval: null });
  });
  vi.stubGlobal('fetch', fetchMock);
  render(<EstimateApprovalPanel estimateId={ID} canManage />);
  fireEvent.click(await screen.findByRole('button', { name: /Get approval link/ }));
  expect(await screen.findByDisplayValue('https://app.test/approve/tok')).toBeTruthy();
  expect(screen.getByText(/has not been sent to anyone/)).toBeTruthy();
  expect(screen.getByTestId('approval-state').textContent).toMatch(/Waiting for the customer/);
  expect(screen.getByRole('button', { name: /Revoke link/ })).toBeTruthy();
  expect(fetchMock.mock.calls.some(([url]) => String(url).includes('approval-text'))).toBe(false);
});

it('shows the signer, signature and signed record once approved, with no new link', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => json({ estimateId: ID, eligible: false, approval: approval({ state: 'approved', signerName: 'Pat Doe', decidedAt: '2026-11-11T12:00:00Z', signatureDataUrl: 'data:image/png;base64,AAAA' }) })));
  render(<EstimateApprovalPanel estimateId={ID} canManage />);
  expect((await screen.findByTestId('approval-state')).textContent).toMatch(/Approved by Pat Doe/);
  expect(screen.getByAltText('Signature of Pat Doe')).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Open signed record' }).getAttribute('href')).toBe(`/api/v1/estimates/${ID}/approval/record`);
  expect(screen.queryByRole('button', { name: /Get approval link/ })).toBeNull();
});

it('shows a declined reason and an outdated link that needs replacing', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => json({ estimateId: ID, eligible: false, approval: approval({ state: 'declined', decidedAt: '2026-11-11T12:00:00Z', declineReason: 'Too expensive' }) })));
  render(<EstimateApprovalPanel estimateId={ID} canManage />);
  expect((await screen.findByTestId('approval-state')).textContent).toMatch(/Declined .*Too expensive/);
  cleanup();
  vi.stubGlobal('fetch', vi.fn(async () => json({ estimateId: ID, eligible: true, approval: approval({ state: 'outdated' }) })));
  render(<EstimateApprovalPanel estimateId={ID} canManage />);
  expect((await screen.findByTestId('approval-state')).textContent).toMatch(/Estimate changed/);
  expect(screen.getByRole('button', { name: /Get approval link/ })).toBeTruthy();
  expect(screen.queryByRole('button', { name: /Text approval link/ })).toBeNull();
});

it('reports a text request as waiting for approval, and holds after an unconfirmed outcome', async () => {
  let textCalls = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.includes('approval-text')) {
      textCalls++;
      return textCalls === 1 ? json({ execution: { id: 'x1', state: 'pending_approval' } }) : json({ error: 'boom' }, 502);
    }
    return json({ estimateId: ID, eligible: true, approval: approval({}) });
  }));
  render(<EstimateApprovalPanel estimateId={ID} canManage />);
  fireEvent.click(await screen.findByRole('button', { name: /Text approval link/ }));
  expect(await screen.findByText(/waiting for approval in Connected apps\. Nothing has been sent/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: /Text approval link/ }));
  expect(await screen.findByText(/could not be confirmed/)).toBeTruthy();
  expect((screen.getByRole('button', { name: /Text approval link/ }) as HTMLButtonElement).disabled).toBe(true);
});

it('shows a refusal reason, and offers no actions to read-only members', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => (url.includes('approval-text') ? json({ error: 'This customer has not agreed to receive texts.', code: 'invalid_input' }, 400) : json({ estimateId: ID, eligible: true, approval: approval({}) }))));
  render(<EstimateApprovalPanel estimateId={ID} canManage />);
  fireEvent.click(await screen.findByRole('button', { name: /Text approval link/ }));
  expect(await screen.findByText('This customer has not agreed to receive texts.')).toBeTruthy();
  cleanup();
  render(<EstimateApprovalPanel estimateId={ID} canManage={false} />);
  expect(await screen.findByTestId('approval-state')).toBeTruthy();
  expect(screen.queryByRole('button')).toBeNull();
});
