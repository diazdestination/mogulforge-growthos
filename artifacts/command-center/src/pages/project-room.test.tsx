import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, it, expect, vi } from 'vitest';
import { renderWithQuery } from '@/test/render';
import ProjectRoom from './project-room';
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
it('uses workspace-scoped sign-in and keeps the portal token out of URLs', async () => {
  const requests: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    requests.push({ url, init });
    const body = url.endsWith('/verify') ? { token: 'LOCAL-TEST-TOKEN' } : url.includes('/decision-room') ? { versions: [{ id: 'v1', version: 1, title: 'Approved roof package', scope: 'Client-approved scope', options: [], warranty: 'Written terms', estimateTotalCents: 100000, isCurrent: false }], appointments: [], boundary: 'Not a contract acceptance.' } : { message: 'If eligible, a code will be sent.' };
    return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
  }));
  renderWithQuery(<ProjectRoom workspace="local-test" leadId="lead-qa" />);
  fireEvent.change(screen.getByLabelText('Email address or phone on your project'), { target: { value: 'fictional@example.invalid' } });
  fireEvent.change(screen.getByLabelText('Six-digit sign-in code'), { target: { value: '123456' } });
  fireEvent.click(screen.getByRole('button', { name: 'Open my project' }));
  await screen.findByText('Approved roof package');
  expect(requests[0].url).toBe('/api/v1/portal/workspaces/local-test/login/verify');
  expect(requests[1].init?.headers).toMatchObject({ 'x-portal-token': 'LOCAL-TEST-TOKEN' });
  expect(requests.every(r => !r.url.includes('LOCAL-TEST-TOKEN'))).toBe(true);
  expect(screen.getByText(/estimate has changed/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: /accept|pay/i })).toBeNull();
});
