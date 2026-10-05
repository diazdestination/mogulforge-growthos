/**
 * Covers the shared searchable lead picker (LeadSelect): typing is debounced
 * into a single server-side `search`/`limit` request, options are capped at 50
 * with a "more matches" hint when the server returns the extra probe row, and
 * a selected lead's label stays visible even after the search results no
 * longer include it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import LeadSelect from '@/components/lead-select';
import { renderWithQuery } from '@/test/render';
import { mockApi, sampleLead } from '@/test/mock-api';

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** All GET /api/v1/leads requests, parsed into their query params. */
function leadRequests(fetchMock: ReturnType<typeof mockApi>) {
  return fetchMock.mock.calls
    .map(([input, init]: [RequestInfo | URL, RequestInit?]) => {
      const raw = String(
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      );
      const method = (init?.method ?? 'GET').toUpperCase();
      return { raw, method };
    })
    .filter(c => c.method === 'GET' && c.raw.split('?')[0].endsWith('/api/v1/leads'))
    .map(c => Object.fromEntries(new URL(c.raw, 'http://test.local').searchParams.entries()));
}

function makeLeads(count: number, prefix = 'Lead') {
  return Array.from({ length: count }, (_, i) => ({
    ...sampleLead,
    id: `ld-${String(i).padStart(4, '0')}`,
    contactName: `${prefix} ${i}`,
  }));
}

function Harness(props: { initial?: string }) {
  const [value, setValue] = useState(props.initial ?? '');
  return <LeadSelect value={value} onChange={setValue} />;
}

describe('LeadSelect', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('isolates optional member-scoped options from a previous company cache', async () => {
    let company = 'first';
    mockApi('office', { handler: (_method, path) => path.endsWith('/leads') ? jsonResponse([{ ...sampleLead, id: `${company}-lead`, contactName: `${company} customer` }]) : undefined });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    const view = render(<QueryClientProvider client={client}><LeadSelect queryScope="member:first:office" value="" onChange={() => {}} /></QueryClientProvider>);
    await screen.findByRole('option', { name: 'first customer' }); company = 'second';
    view.rerender(<QueryClientProvider client={client}><LeadSelect queryScope="member:second:office" value="" onChange={() => {}} /></QueryClientProvider>);
    expect(screen.queryByRole('option', { name: 'first customer' })).toBeNull();
    await screen.findByRole('option', { name: 'second customer' }); expect(screen.queryByRole('option', { name: 'first customer' })).toBeNull();
  });

  it('debounces typing into a single server search request with search + limit params', async () => {
    const fetchMock = mockApi('admin');
    renderWithQuery(<Harness />);

    // Initial load: no search param, limit = cap + 1 probe row.
    await waitFor(() => expect(leadRequests(fetchMock).length).toBe(1));
    expect(leadRequests(fetchMock)[0]).toEqual({ limit: '51' });

    const input = screen.getByTestId('lead-select-search');
    fireEvent.change(input, { target: { value: 'ja' } });
    fireEvent.change(input, { target: { value: 'jan' } });
    fireEvent.change(input, { target: { value: 'jane' } });

    // Intermediate keystrokes never reach the server; only the settled value does.
    await waitFor(() => expect(leadRequests(fetchMock).length).toBe(2), { timeout: 2000 });
    // Give any stray debounce timers a chance to fire, then re-check.
    await new Promise(r => setTimeout(r, 400));
    const requests = leadRequests(fetchMock);
    expect(requests.length).toBe(2);
    expect(requests[1]).toEqual({ search: 'jane', limit: '51' });
  });

  it('caps the options at 50 and shows the "more matches" hint when the server returns 51 rows', async () => {
    mockApi('admin', {
      handler: (method, path) => {
        if (method === 'GET' && path.endsWith('/api/v1/leads')) {
          return jsonResponse(makeLeads(51));
        }
        return undefined;
      },
    });
    renderWithQuery(<Harness />);

    await screen.findByText(/more matches exist/i);
    const select = screen.getByTestId('lead-select');
    const options = within(select).getAllByRole('option');
    // 50 leads + the empty "-- None --" option.
    expect(options.length).toBe(51);
    expect(within(select).queryByText('Lead 50')).toBeNull();
  });

  it('shows no hint (and no more-matches message) when results fit under the cap', async () => {
    mockApi('admin', {
      handler: (method, path) => {
        if (method === 'GET' && path.endsWith('/api/v1/leads')) {
          return jsonResponse(makeLeads(3));
        }
        return undefined;
      },
    });
    renderWithQuery(<Harness />);

    const select = screen.getByTestId('lead-select');
    await waitFor(() => expect(within(select).getAllByRole('option').length).toBe(4));
    expect(screen.queryByText(/more matches exist/i)).toBeNull();
  });

  it('keeps the selected lead label visible when search results no longer include it', async () => {
    // Search-aware stub: the empty-search load returns Jane; any searched
    // request returns no rows, so the selected lead drops out of the results.
    const fetchMock = mockApi('admin');
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const raw = String(
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      );
      const url = new URL(raw, 'http://test.local');
      if (url.pathname.endsWith('/api/v1/leads')) {
        return url.searchParams.get('search')
          ? jsonResponse([])
          : jsonResponse([{ ...sampleLead, id: 'jane-lead', contactName: 'Jane Homeowner' }]);
      }
      if (url.pathname.endsWith('/api/v1/me')) {
        return jsonResponse({ id: 'u1', role: 'admin' });
      }
      return jsonResponse([]);
    });

    renderWithQuery(<Harness />);

    const select = screen.getByTestId('lead-select');
    await waitFor(() => expect(within(select).queryByText('Jane Homeowner')).toBeTruthy());
    fireEvent.change(select, { target: { value: 'jane-lead' } });
    expect((select as HTMLSelectElement).value).toBe('jane-lead');

    // Search for something that excludes the selected lead.
    fireEvent.change(screen.getByTestId('lead-select-search'), { target: { value: 'zzz' } });
    await screen.findByText(/no leads match "zzz"/i, undefined, { timeout: 2000 });

    // The selected lead's label is still rendered and still selected.
    expect((select as HTMLSelectElement).value).toBe('jane-lead');
    expect(within(select).getByText('Jane Homeowner')).toBeTruthy();
  });
});
