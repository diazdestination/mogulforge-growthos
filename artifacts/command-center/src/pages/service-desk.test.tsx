import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import ServiceDesk from '@/pages/service-desk';
import { renderWithQuery } from '@/test/render';
import { mockApi } from '@/test/mock-api';

describe('customer service desk status', () => {
  afterEach(cleanup);

  it('shows unavailable, not an empty schedule, when service dates fail to load', async () => {
    mockApi('admin', {
      handler: (_method, path) => path.endsWith('/api/v1/service-obligations')
        ? Response.json({ error: 'service_unavailable' }, { status: 503 })
        : undefined,
    });
    renderWithQuery(<ServiceDesk />);
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('Service dates are unavailable'));
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
