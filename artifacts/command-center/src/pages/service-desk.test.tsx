import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, screen, waitFor } from '@testing-library/react';
import ServiceDesk from '@/pages/service-desk';
import { renderWithQuery } from '@/test/render';
import { mockApi, sampleMe } from '@/test/mock-api';

describe('customer service desk status', () => {
  afterEach(cleanup);

  it('shows unavailable, not an empty schedule, when service dates fail to load', async () => {
    mockApi('admin', {
      handler: (_method, path) => path.endsWith('/api/v1/service-obligations')
        ? Response.json({ error: 'service_unavailable' }, { status: 503 })
        : undefined,
    });
    renderWithQuery(<ServiceDesk />);
    // /me can finish between finding the first alert and reading its text,
    // triggering a fresh company-scoped load on the same paragraph element.
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveProperty('textContent', expect.stringContaining('Service dates are unavailable'));
    });
    expect(screen.queryByText('No active service dates yet.')).toBeNull();
  });

  it('keeps a failed schedule distinct from empty during a late company refresh', async () => {
    let resolveIdentity!: (response: Response) => void;
    let resolveCompanySchedule!: (response: Response) => void;
    const identityResponse = new Promise<Response>(resolve => { resolveIdentity = resolve; });
    const companyScheduleResponse = new Promise<Response>(resolve => { resolveCompanySchedule = resolve; });
    const fetchMock = mockApi('admin');
    const fallback = fetchMock.getMockImplementation()!;
    let scheduleRequests = 0;
    fetchMock.mockImplementation(async (input, init) => {
      const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const path = raw.split('?')[0];
      if (path.endsWith('/api/v1/me')) return identityResponse;
      if (path.endsWith('/api/v1/service-obligations')) {
        scheduleRequests += 1;
        return scheduleRequests === 1
          ? Response.json({ error: 'service_unavailable' }, { status: 503 })
          : companyScheduleResponse;
      }
      return fallback(input, init);
    });
    renderWithQuery(<ServiceDesk />);
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveProperty('textContent', expect.stringContaining('Service dates are unavailable'));
    });

    await act(async () => { resolveIdentity(Response.json(sampleMe('admin'))); });
    expect(await screen.findByText('Loading service dates…')).toBeTruthy();
    expect(scheduleRequests).toBe(2);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText('No active service dates yet.')).toBeNull();

    await act(async () => {
      resolveCompanySchedule(Response.json({ error: 'service_unavailable' }, { status: 503 }));
    });
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveProperty('textContent', expect.stringContaining('Service dates are unavailable'));
    });
    expect(screen.queryByText('No active service dates yet.')).toBeNull();
  });

  it('shows an empty schedule only after a successful response', async () => {
    mockApi('admin', {
      handler: (_method, path) => path.endsWith('/api/v1/service-obligations')
        ? Response.json([])
        : undefined,
    });
    renderWithQuery(<ServiceDesk />);
    expect(await screen.findByText('No active service dates yet.')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
