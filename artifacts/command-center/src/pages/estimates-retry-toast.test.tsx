/**
 * Covers the estimates page's error toast for the one-shot status-change
 * mutation ("Record external send" on a draft): a failed update must surface a toast
 * with a Retry action; retry success dismisses the toast and refreshes the
 * estimate list, and a failed retry re-surfaces the toast. (Same pattern as
 * tasks-retry-toast.test.tsx.)
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import Estimates from '@/pages/estimates';
import { Toaster } from '@/components/ui/toaster';
import { renderWithQuery } from '@/test/render';
import { mockApi } from '@/test/mock-api';

const now = new Date().toISOString();

const sampleEstimate = {
  id: 'e1-00000000',
  title: 'Roof replacement',
  status: 'draft',
  leadId: 'l1-00000000',
  leadLabel: 'Jane Homeowner',
  lineItems: [
    { description: 'Shingles', quantity: 1, unitPriceCents: 500000, totalCents: 500000 },
  ],
  subtotalCents: 500000,
  taxCents: 0,
  totalCents: 500000,
  notes: null,
  sentAt: null,
  acceptedAt: null,
  createdAt: now,
  updatedAt: now,
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function callInfo([input, init]: [RequestInfo | URL, RequestInit?]) {
  return {
    method: (init?.method ?? 'GET').toUpperCase(),
    path: String(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    ).split('?')[0],
    body: init?.body,
  };
}

function renderEstimates(handler?: (method: string, path: string) => Response | undefined) {
  const fetchMock = mockApi('admin', {
    handler: (method, path) => {
      const override = handler?.(method, path);
      if (override) return override;
      if (method === 'GET' && path.endsWith('/api/v1/estimates')) {
        return jsonResponse([sampleEstimate]);
      }
      return undefined;
    },
  });
  renderWithQuery(
    <>
      <Estimates />
      <Toaster />
    </>,
  );
  return fetchMock;
}

const patchCalls = (fetchMock: ReturnType<typeof mockApi>) =>
  fetchMock.mock.calls
    .map(callInfo)
    .filter(
      c => c.method === 'PATCH' && c.path.endsWith(`/api/v1/estimates/${sampleEstimate.id}`),
    );

const listCalls = (fetchMock: ReturnType<typeof mockApi>) =>
  fetchMock.mock.calls
    .map(callInfo)
    .filter(c => c.method === 'GET' && c.path.endsWith('/api/v1/estimates'));

async function triggerMarkSent() {
  await screen.findByText(/roof replacement/i);
  fireEvent.click(await screen.findByRole('button', { name: /record external send/i }));
}

describe('Estimates status-change retry toast', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('shows a toast with Retry when the status change fails', async () => {
    const fetchMock = renderEstimates((method, path) => {
      if (method === 'PATCH' && path.endsWith(`/api/v1/estimates/${sampleEstimate.id}`)) {
        return jsonResponse({ error: 'boom' }, 500);
      }
      return undefined;
    });

    await triggerMarkSent();

    await waitFor(() => expect(patchCalls(fetchMock).length).toBe(1));
    await waitFor(() => {
      expect(screen.getByText(/estimate not updated/i)).toBeTruthy();
    });
    expect(screen.getByRole('button', { name: /retry/i })).toBeTruthy();
  });

  it('retries from the toast, dismisses it, and refreshes the list on success', async () => {
    let fail = true;
    const fetchMock = renderEstimates((method, path) => {
      if (method === 'PATCH' && path.endsWith(`/api/v1/estimates/${sampleEstimate.id}`)) {
        if (fail) return jsonResponse({ error: 'boom' }, 500);
        return jsonResponse({ ...sampleEstimate, status: 'sent', sentAt: now });
      }
      return undefined;
    });

    await triggerMarkSent();

    await waitFor(() => expect(patchCalls(fetchMock).length).toBe(1));
    const retry = await screen.findByRole('button', { name: /retry/i });
    const listCallsBefore = listCalls(fetchMock).length;

    fail = false;
    fireEvent.click(retry);

    await waitFor(() => expect(patchCalls(fetchMock).length).toBe(2));
    expect(JSON.parse(String(patchCalls(fetchMock)[1].body))).toMatchObject({
      status: 'sent',
    });

    // Success dismisses the toast and invalidates the estimate list.
    await waitFor(() => {
      expect(screen.queryByText(/estimate not updated/i)).toBeNull();
    });
    await waitFor(() => expect(listCalls(fetchMock).length).toBeGreaterThan(listCallsBefore));
  });

  it('re-surfaces the toast when the retry fails again', async () => {
    const fetchMock = renderEstimates((method, path) => {
      if (method === 'PATCH' && path.endsWith(`/api/v1/estimates/${sampleEstimate.id}`)) {
        return jsonResponse({ error: 'boom' }, 500);
      }
      return undefined;
    });

    await triggerMarkSent();

    await waitFor(() => expect(patchCalls(fetchMock).length).toBe(1));
    const retry = await screen.findByRole('button', { name: /retry/i });
    fireEvent.click(retry);

    await waitFor(() => expect(patchCalls(fetchMock).length).toBe(2));

    // The toast (with its Retry action) is still there for another attempt.
    expect(screen.getByText(/estimate not updated/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /retry/i })).toBeTruthy();
  });
});
